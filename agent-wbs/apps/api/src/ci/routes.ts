import type { Pool, PoolClient } from '@awbs/db';
import { CI_STAGE, type schema } from '@awbs/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError, completionGate } from '@awbs/shared';
import { isTimestamp } from '@awbs/shared/api';
import { encodeCursor, decodeCursor } from '../changes/history.ts';
import { clientOf, read, routes, assertSameVersion } from '../changes/http.ts';
import { iso, deferChange } from '../changes/events.ts';
import { PlatformError } from '../platform/errors.ts';
import { RunnerRepository, required } from '../runner/repository.ts';
import { assertExternal, checkedJob } from '../runner/service.ts';
import { inputHead } from '../project/service.ts';
import { enqueueIntegration, gateInput, integrationDecision } from '../execution/gate.ts';
import { ciRunDecisions, ciRunDecisionsMany, retryDecision } from './decisions.ts';
import { pipelineDefinition } from './pipeline.ts';
import { reportQueue, startRun, updateRun, type Start, type Update, type QueueReport } from './service.ts';

const params = (r: FastifyRequest) => r.params as { projectId: string; id: string };
async function project(client: PoolClient, id: string) {
  if (!(await client.query('select 1 from projects where id::text=$1',[id])).rowCount) throw new PlatformError('PROJECT_NOT_FOUND');
}
const runSelect = `select c.id,c.run_no::text "runNo",c.run_key "runKey",case c.stage when 1 then 'task' when 2 then 'int' when 3 then 'night' when 4 then 'deploy' end stage,
  c.status,t.task_key "taskKey",c.attempt "attemptId",c.ref,c.pr,c.trigger,c.base_sha "baseSha",c.head_sha "headSha",c.merge_sha "mergeSha",c.tree_sha "treeSha",c.pipeline_sha "pipelineSha",
  c.note,c.e2e,c.github_status "githubStatus",${iso('c.finished_at')} "finishedAt",c.fail_step "failStep",c.fail_scope "failScope",c.log_excerpt "logExcerpt",c.artifacts,c.url,${iso('c.created_at')} "startedAt",
  coalesce((select jsonb_agg(jsonb_build_object('commit',candidate.value->>'commit','taskKey',
    (select case when count(distinct q.task)=1 then min(t.task_key) end from merge_queue q
      join ci_merge_facts f on f.project_id=q.project_id and f.merge_sha=q.actual_merge_sha join tasks t on t.id=q.task
      where q.project_id=c.project_id and q.status='merged' and (q.actual_merge_sha=candidate.value->>'commit' or f.parents->>1=candidate.value->>'commit')))
    order by candidate.n) from jsonb_array_elements(c.cause_candidates) with ordinality candidate(value,n)),'[]') "causeCandidates",
  coalesce((select jsonb_agg(jsonb_build_object('name',s.step_key,'status',s.status,'durationMs',s.duration_ms) order by s.record_no) from ci_steps s where s.run=c.id),'[]') steps
  from ci_runs c left join tasks t on t.id=c.task`;

/** 보안 시험이 Runner 경로에 가짜 처리기를 붙일 수 있게 실행 보고 경로는 main에서 따로 설치한다. */
export function installCiRunner(app: FastifyInstance) {
  routes(app,'빌드·통합 보고',route => {
    route('getCiJob',async r => {
      const client = clientOf(r), repo = new RunnerRepository(client); await repo.lock();
      const job = await checkedJob(repo,params(r).id,(r.query as { fence:number }).fence,r.platform?.principal ?? '',true);
      if (!['integrate','ci_retry'].includes(job.kind)) throw new PlatformError('INVALID_TRANSITION');
      await assertExternal(repo,job);
      const source = job.kind === 'ci_retry' ? (await client.query<{ id:string;task_key:string|null;stage:number;ref:string;pr:number|null;base_sha:string|null;head_sha:string;pipeline_sha:string }>(
        'select c.*,t.task_key from ci_runs c left join tasks t on t.id=c.task where c.id::text=$1 and c.project_id=$2',[job.payload.runId,job.project_id])).rows[0] : null;
      if (job.kind === 'ci_retry' && !source) throw new PlatformError('INVALID_TRANSITION');
      const taskKey = job.kind === 'integrate' ? job.payload.taskKey as string : source?.task_key ?? null;
      const task = taskKey ? await repo.task(taskKey) : null;
      const verification = task ? (await client.query<{ head_sha:string;spec_revision:number;result:string }>(`select v.* from verifications v join task_attempts a on a.id=v.attempt
        where a.task=$1 order by a.attempt_no desc limit 1`,[task.id])).rows[0] : null;
      const branch = task ? (await repo.history(task.id)).at(-1)?.branch ?? null : null;
      const hold = await repo.hold(job.id);
      const allowed = source ? (await ciRunDecisions(client,source.id)).retryAllowed : task ? (await integrationDecision(client,task.id,{ retry:true })).allowed : false;
      return { runnable:allowed && ['leased','started'].includes(job.state) && Boolean(job.lease_until && job.lease_until > await repo.now()),taskKey,branch,
        hold:hold && !hold.closed_at ? { hostId:hold.host_id,bootId:hold.boot_id,processGroup:hold.pgid,slotState:hold.slot_state } : null,
        verification:verification ? { headSha:verification.head_sha,specRevision:verification.spec_revision,
          passed:task?.status === 'gate' && verification.result === 'PASS' && completionGate(await gateInput(client,required(task).id)).every(c => c.result === 'PASS') } : null,
        source:source ? { stage:Object.keys(CI_STAGE).find(k => CI_STAGE[k as keyof typeof CI_STAGE] === source.stage),ref:source.ref,pr:source.pr,
          baseSha:source.base_sha,headSha:source.head_sha,pipelineSha:source.pipeline_sha } : null };
    });
    route('startCiRun',async (r,reply) => reply.code(201).send(await startRun(clientOf(r),r.platform?.principal ?? '',r.body as Start)));
    route('updateCiRun',async (r,reply) => { await updateRun(clientOf(r),params(r).id,r.platform?.principal ?? '',r.body as Update); return reply.code(204).send(); });
    route('reportMergeQueue',async (r,reply) => {
      try { await reportQueue(clientOf(r),r.platform?.principal ?? '',r.body as QueueReport); }
      catch (e) {
        if (e instanceof PlatformError && (e.code === 'MERGE_MISMATCH' || e.details.reverify === true || e.details.event === 'GATE_UNMET_AFTER_MERGE') && r.platform) r.platform.commitOnError = true;
        if (e instanceof DomainError) throw new PlatformError(e.code,e.details); throw e;
      }
      return reply.code(204).send();
    });
  });
}

export function registerCiRoutes(app: FastifyInstance, pool: Pool) {
  routes(app,'빌드·통합',route => {
    route('listCiRuns',r => read(pool,r,async client => {
      await project(client,params(r).projectId);
      const query = r.query as { stage?: keyof typeof CI_STAGE; taskKey?: string; limit?: number; cursor?: string };
      const limit = Math.min(query.limit ?? 50,200);
      const cursor = query.cursor ? decodeRunCursor(query.cursor) : null;
      const rows = (await client.query(`${runSelect} where c.project_id::text=$1 and ($2::int is null or c.stage=$2)
        and ($3::text is null or t.task_key=$3) and ($4::timestamptz is null or (c.created_at,c.run_no)<($4,$5::bigint)) order by c.created_at desc,c.run_no desc limit $6`,
      [params(r).projectId,query.stage ? CI_STAGE[query.stage] : null,query.taskKey,cursor?.[0],cursor?.[1],limit+1])).rows;
      const items = rows.slice(0,limit), last = items.at(-1);
      const nextCursor = rows.length > limit && last ? encodeCursor([last.startedAt as string,last.runNo as string]) : null;
      const decisions = await ciRunDecisionsMany(client,items.map(item => item.id as string));
      for (const item of items) { Object.assign(item,decisions.get(item.id as string)); delete item.runNo; }
      return { items,nextCursor };
    }));
    route('getCiRun',r => read(pool,r,async client => {
      await project(client,params(r).projectId);
      const row = (await client.query(`${runSelect} where c.project_id::text=$1 and c.id::text=$2`,[params(r).projectId,params(r).id])).rows[0];
      if (!row) throw new PlatformError('NOT_FOUND');
      Object.assign(row,await ciRunDecisions(client,row.id as string)); delete row.runNo; return row;
    }));
    route('getMergeQueue',r => read(pool,r,async client => {
      await project(client,params(r).projectId);
      return { items:(await client.query(`select q.id,q.pr,t.task_key "taskKey",q.position,q.status,q.qa_head_sha "qaHeadSha",q.synced_head_sha "syncedHeadSha",
        q.base_sha "baseSha",q.ci_run "ciRunId",q.actual_merge_sha "actualMergeSha",${iso('q.created_at')} "queuedAt",${iso('q.merged_at')} "mergedAt" from merge_queue q join tasks t on t.id=q.task where q.project_id::text=$1 order by q.position,q.queue_no`,[params(r).projectId])).rows };
    }));
    for (const [id,kind] of [['retryCiRun','ci_retry'],['requestDeployCheck','deploy_check']] as const) route(id,async (r,reply) => {
      const client = clientOf(r); const repo = new RunnerRepository(client); await repo.lock();
      await project(client,params(r).projectId);
      const source = id === 'retryCiRun' ? (await client.query<typeof schema.ciRuns.$inferSelect>('select * from ci_runs where id::text=$1 and project_id::text=$2',[params(r).id,params(r).projectId])).rows[0] : null;
      if (id === 'retryCiRun' && !source) throw new PlatformError('NOT_FOUND');
      if (source) {
        if (source.task) await repo.taskById(source.task);
        const decision=await retryDecision(client,source);
        if (!decision.allowed) throw new PlatformError(decision.code,{...decision.details,reason:decision.reason});
        if (decision.kind==='integrate') {
          const jobId=await enqueueIntegration(client,required(source.task),r.platform?.epoch ?? 0,{retry:true});
          if (!jobId) throw new PlatformError('INVALID_TRANSITION');
          await assertExternal(repo,required(await repo.job(jobId)));
          return reply.code(202).send({jobId});
        }
      }
      const commit = id === 'retryCiRun' ? source?.head_sha : await inputHead(client,params(r).projectId);
      if (!commit) throw new PlatformError('INVALID_TRANSITION');
      const authority = await repo.authority();
      const jobId = required(await repo.enqueue(params(r).projectId,r.platform?.epoch ?? 0,kind,
        id === 'retryCiRun' ? { runId:source?.id,pr:source?.pr,commit } : { commit },`ci:${r.id}:${crypto.randomUUID()}`,authority?.generation ?? null));
      await assertExternal(repo,required(await repo.job(jobId)));
      return reply.code(202).send({ jobId });
    });
    const flaky = (client: PoolClient, projectId: string, id?: string) => client.query(`select f.id,f.test_key "testKey",f.rate,f.quarantined,${iso('f.last_failed_at')} "lastFailedAt",t.task_key "taskKey",${iso('f.updated_at')} "updatedAt"
      from flaky_tests f left join tasks t on t.id=f.task where f.project_id::text=$1 and ($2::text is null or f.id::text=$2) order by f.test_key`,[projectId,id]);
    route('listFlakyTests',r => read(pool,r,async client => { await project(client,params(r).projectId); return { items:(await flaky(client,params(r).projectId)).rows }; }));
    route('updateFlakyTest',async r => {
      const client = clientOf(r), p = params(r), body = r.body as { updatedAt: string; quarantined: boolean };
      await project(client,p.projectId);
      await client.query('select 1 from flaky_tests where id::text=$1 and project_id::text=$2 for update',[p.id,p.projectId]);
      const current = (await flaky(client,p.projectId,p.id)).rows[0]; if (!current) throw new PlatformError('NOT_FOUND');
      await assertSameVersion(client,current.updatedAt as string,body.updatedAt);
      await client.query('update flaky_tests set quarantined=$2 where id::text=$1',[p.id,body.quarantined]);
      deferChange(client,p.projectId,'ci',{ id:p.id });
      return (await flaky(client,p.projectId,p.id)).rows[0];
    });
    route('getPipeline',r => read(pool,r,async client => {
      const id = params(r).projectId; await project(client,id);
      return pipelineDefinition(client,id,await inputHead(client,id));
    }));
    const settings = async (client: PoolClient) => {
      const current = required((await client.query<{ nightAt: string; retry: number; deployUrl: string | null; updatedAt: string | null }>(
        `select night_at "nightAt",retry,deploy_url "deployUrl",${iso('settings_version')} "updatedAt" from ci_settings where singleton`)).rows[0]);
      const project = (await client.query<{ id: string }>('select id from projects')).rows[0];
      const definition = project ? await pipelineDefinition(client,project.id,await inputHead(client,project.id)) : null;
      return { ...current,serviceConfig:definition?.serviceConfig ?? null };
    };
    for (const id of ['getCiSettings','getCiDefaults']) route(id,r => read(pool,r,async client => {
      if (id === 'getCiSettings') await project(client,params(r).projectId);
      return settings(client);
    }));
    for (const id of ['updateCiSettings','putCiDefaults']) route(id,async r => {
      const client = clientOf(r);
      if (id === 'updateCiSettings') await project(client,params(r).projectId);
      await client.query('select 1 from ci_settings where singleton for update');
      const current = await settings(client), body = r.body as Partial<typeof current> & { updatedAt: string | null };
      await assertSameVersion(client,current.updatedAt,body.updatedAt);
      await client.query(`update ci_settings set night_at=$1,retry=$2,deploy_url=$3,settings_version=greatest(clock_timestamp(),settings_version+interval '1 microsecond') where singleton`,
        [body.nightAt ?? current.nightAt,body.retry ?? current.retry,body.deployUrl === undefined ? current.deployUrl : body.deployUrl]);
      deferChange(client,null,'settings',{ key:'ci' });
      return settings(client);
    });
  });
}

function decodeRunCursor(cursor: string): [string,string] {
  const value = decodeCursor(cursor,2);
  if (value?.[0] && value[1] && isTimestamp(value[0]) && /^[1-9]\d{0,18}$/.test(value[1]) && BigInt(value[1]) <= 9_223_372_036_854_775_807n) return [value[0],value[1]];
  throw new PlatformError('VALIDATION_FAILED');
}
