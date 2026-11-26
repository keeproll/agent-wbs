import type { Pool, PoolClient } from '@awbs/db';
import { CI_STAGE } from '@awbs/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError } from '@awbs/shared';
import { isTimestamp } from '@awbs/shared/api';
import { encodeCursor, decodeCursor } from '../changes/history.ts';
import { clientOf, read, routes, assertSameVersion } from '../changes/http.ts';
import { iso, deferChange } from '../changes/events.ts';
import { PlatformError } from '../platform/errors.ts';
import { RunnerRepository, required } from '../runner/repository.ts';
import { assertExternal } from '../runner/service.ts';
import { inputHead } from '../project/service.ts';
import { pipelineDefinition } from './pipeline.ts';
import { reportQueue, startRun, updateRun, type Start, type Update, type QueueReport } from './service.ts';

const params = (r: FastifyRequest) => r.params as { projectId: string; id: string };
async function project(client: PoolClient, id: string) {
  if (!(await client.query('select 1 from projects where id::text=$1',[id])).rowCount) throw new PlatformError('PROJECT_NOT_FOUND');
}
const runSelect = `select c.id,c.run_no::text "runNo",c.run_key "runKey",case c.stage when 1 then 'task' when 2 then 'int' when 3 then 'night' when 4 then 'deploy' end stage,
  c.status,t.task_key "taskKey",c.attempt "attemptId",c.ref,c.pr,c.trigger,c.base_sha "baseSha",c.head_sha "headSha",c.merge_sha "mergeSha",c.tree_sha "treeSha",c.pipeline_sha "pipelineSha",
  c.fail_step "failStep",c.fail_scope "failScope",c.log_excerpt "logExcerpt",c.artifacts,c.url,${iso('c.created_at')} "startedAt",
  coalesce((select jsonb_agg(jsonb_build_object('name',s.step_key,'status',s.status,'durationMs',s.duration_ms) order by s.created_at,s.id) from ci_steps s where s.run=c.id),'[]') steps
  from ci_runs c left join tasks t on t.id=c.task`;

/** 보안 시험이 Runner 경로에 가짜 처리기를 붙일 수 있게 실행 보고 경로는 main에서 따로 설치한다. */
export function installCiRunner(app: FastifyInstance) {
  routes(app,'빌드·통합 보고',route => {
    route('startCiRun',async (r,reply) => reply.code(201).send(await startRun(clientOf(r),r.platform?.principal ?? '',r.body as Start)));
    route('updateCiRun',async (r,reply) => { await updateRun(clientOf(r),params(r).id,r.platform?.principal ?? '',r.body as Update); return reply.code(204).send(); });
    route('reportMergeQueue',async (r,reply) => {
      try { await reportQueue(clientOf(r),r.platform?.principal ?? '',r.body as QueueReport); }
      catch (e) {
        if (e instanceof PlatformError && e.code === 'MERGE_MISMATCH' && r.platform) r.platform.commitOnError = true;
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
      for (const item of items) delete item.runNo;
      return { items,nextCursor };
    }));
    route('getCiRun',r => read(pool,r,async client => {
      await project(client,params(r).projectId);
      const row = (await client.query(`${runSelect} where c.project_id::text=$1 and c.id::text=$2`,[params(r).projectId,params(r).id])).rows[0];
      if (!row) throw new PlatformError('NOT_FOUND');
      delete row.runNo; return row;
    }));
    route('getMergeQueue',r => read(pool,r,async client => {
      await project(client,params(r).projectId);
      return { items:(await client.query(`select q.id,q.pr,t.task_key "taskKey",q.position,q.status,q.qa_head_sha "qaHeadSha",q.synced_head_sha "syncedHeadSha",
        q.base_sha "baseSha",q.ci_run "ciRunId",q.actual_merge_sha "actualMergeSha" from merge_queue q join tasks t on t.id=q.task where q.project_id::text=$1 order by q.position,q.created_at,q.id`,[params(r).projectId])).rows };
    }));
    for (const [id,kind] of [['retryCiRun','ci_retry'],['requestDeployCheck','deploy_check']] as const) route(id,async (r,reply) => {
      const client = clientOf(r); const repo = new RunnerRepository(client); await repo.lock();
      await project(client,params(r).projectId);
      const source = id === 'retryCiRun' ? (await client.query<{ id: string; pr: number | null; head_sha: string; status: string }>('select id,pr,head_sha,status from ci_runs where id::text=$1 and project_id::text=$2',[params(r).id,params(r).projectId])).rows[0] : null;
      if (id === 'retryCiRun' && !source) throw new PlatformError('NOT_FOUND');
      if (source && source.status !== 'fail') throw new PlatformError('INVALID_TRANSITION');
      const commit = id === 'retryCiRun' ? source?.head_sha : await inputHead(client,params(r).projectId);
      if (!commit) throw new PlatformError('INVALID_TRANSITION');
      const authority = await repo.authority();
      const jobId = required(await repo.enqueue(params(r).projectId,r.platform?.epoch ?? 0,kind,
        id === 'retryCiRun' ? { runId:source?.id,pr:source?.pr,commit } : { commit },`ci:${r.id}:${crypto.randomUUID()}`,authority?.generation ?? null));
      await assertExternal(repo,required(await repo.job(jobId)));
      return reply.code(202).send({ jobId });
    });
    const flaky = (client: PoolClient, projectId: string, id?: string) => client.query(`select f.id,f.test_key "testKey",f.rate,f.quarantined,t.task_key "taskKey",${iso('f.updated_at')} "updatedAt"
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
    const settings = async (client: PoolClient) => required((await client.query<{ nightAt: string; retry: number; deployUrl: string | null; updatedAt: string | null }>(
      `select night_at "nightAt",retry,deploy_url "deployUrl",${iso('settings_version')} "updatedAt" from ci_settings where singleton`)).rows[0]);
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
