import { randomUUID } from 'node:crypto';
import { CI_STAGE, type PoolClient, type schema } from '@awbs/db';
import { completionGate } from '@awbs/shared';
import { deferChange } from '../changes/events.ts';
import { PlatformError } from '../platform/errors.ts';
import { RunnerRepository, required } from '../runner/repository.ts';
import { checkedJob, handover } from '../runner/service.ts';
import { completeMergedTask, gateInput } from '../execution/gate.ts';
import { assertCiTransition, preservedHead, type HeadProof } from './proof.ts';

type Run = typeof schema.ciRuns.$inferSelect;
type Queue = typeof schema.mergeQueue.$inferSelect;
interface Shas { baseSha?: string; headSha?: string; mergeSha?: string; treeSha?: string; pipelineSha?: string }
export interface Start extends Shas {
  stage: keyof typeof CI_STAGE; jobId?: string; fence?: number; taskKey?: string; attemptId?: string;
  ref: string; pr?: number; trigger: string; pipelineSha: string;
}
export interface Update extends Shas {
  fence: number | null; status?: string; steps?: { name: string; status: string; durationMs: number }[];
  artifacts?: string[]; url?: string; logExcerpt?: string;
}
export interface QueueReport {
  jobId: string; fence: number; pr: number; taskKey: string; status: string;
  qaHeadSha?: string; syncedHeadSha?: string; baseSha?: string; ciRunId?: string; testedTreeSha?: string;
  actualMergeSha?: string; actualTreeSha?: string; headSync?: HeadProof; mergeParents?: string[];
}
const bad = () => { throw new PlatformError('GATE_NOT_PASSED'); };

export async function startRun(client: PoolClient, principal: string, body: Start) {
  const repo = new RunnerRepository(client); await repo.lock();
  const job = body.jobId ? await checkedJob(repo,body.jobId,required(body.fence),principal) : null;
  const project = job?.project_id ?? (await client.query<{ id: string }>('select id from projects')).rows[0]?.id;
  if (!project) throw new PlatformError('PROJECT_NOT_FOUND');
  const task = body.taskKey ? await repo.task(body.taskKey) : null;
  if (body.taskKey && !task) throw new PlatformError('TASK_NOT_FOUND');
  if (task && (task.project_id !== project || job?.payload.taskKey && job.payload.taskKey !== task.task_key)) throw new PlatformError('INVALID_TRANSITION');
  if (job?.kind === 'attempt' && (body.stage !== 'task' || !task || job.payload.taskKey !== task.task_key || !body.attemptId)) throw new PlatformError('INVALID_TRANSITION');
  if (job?.kind === 'integrate' && (!['task','int'].includes(body.stage) || !task || job.payload.taskKey !== task.task_key || job.payload.pr !== body.pr)) throw new PlatformError('INVALID_TRANSITION');
  if (job?.kind === 'deploy_check' && body.stage !== 'deploy') throw new PlatformError('INVALID_TRANSITION');
  if (job && !['attempt','integrate','deploy_check','ci_retry'].includes(job.kind)) throw new PlatformError('INVALID_TRANSITION');
  if (!job && (body.stage !== 'night' || body.taskKey || body.attemptId)) throw new PlatformError('INVALID_TRANSITION');
  if (job?.kind === 'ci_retry') {
    const original = (await client.query<Run>('select * from ci_runs where id::text=$1 and project_id=$2',[job.payload.runId,project])).rows[0];
    if (!original || original.stage !== CI_STAGE[body.stage] || original.task !== (task?.id ?? null)) throw new PlatformError('INVALID_TRANSITION');
  }
  if (body.attemptId) {
    const attempt = await repo.attempt(body.attemptId);
    if (!attempt || attempt.task !== task?.id || attempt.job !== job?.id || attempt.status !== 'running') throw new PlatformError('INVALID_TRANSITION');
  }
  const runKey = `CI-${randomUUID()}`;
  const row = required((await client.query<{ id: string }>(`insert into ci_runs(project_id,run_key,stage,base_sha,head_sha,merge_sha,tree_sha,pipeline_sha,ref,pr,task,attempt,trigger,status,job,fence,reporter)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'queued',$14,$15,$16) returning id`,
  [project,runKey,CI_STAGE[body.stage],body.baseSha,body.headSha,body.mergeSha,body.treeSha,body.pipelineSha,body.ref,body.pr,task?.id,body.attemptId,body.trigger,job?.id,job?.fence,principal])).rows[0]);
  deferChange(client,project,'ci',{ id:row.id });
  return { id:row.id,runKey };
}

export async function updateRun(client: PoolClient, id: string, principal: string, body: Update) {
  const repo = new RunnerRepository(client); await repo.lock();
  const run = (await client.query<Run>('select * from ci_runs where id::text=$1 for update',[id])).rows[0];
  if (!run) throw new PlatformError('NOT_FOUND');
  if (run.job) {
    await checkedJob(repo,run.job,body.fence ?? -1,principal);
    if (run.fence !== body.fence) throw new PlatformError('LEASE_LOST');
  } else if (run.stage !== 3 || body.fence !== null || run.reporter !== principal) throw new PlatformError('LEASE_LOST');
  const status = body.status ?? run.status;
  assertCiTransition(run.status,status);
  if (status === 'pass' && (!(body.headSha ?? run.head_sha) || run.stage === 2 && (!(body.baseSha ?? run.base_sha) || !(body.treeSha ?? run.tree_sha)))) throw new PlatformError('INVALID_TRANSITION');
  for (const [key,column] of [['baseSha','base_sha'],['headSha','head_sha'],['mergeSha','merge_sha'],['treeSha','tree_sha'],['pipelineSha','pipeline_sha']] as const) {
    if (body[key] && run[column] && body[key] !== run[column]) throw new PlatformError('INVALID_TRANSITION');
  }
  if (body.steps && (new Set(body.steps.map(s => s.name)).size !== body.steps.length || body.steps.some(s => !Number.isSafeInteger(s.durationMs)))) throw new PlatformError('VALIDATION_FAILED');
  if (['pass','fail','skip'].includes(run.status) && body.steps) throw new PlatformError('INVALID_TRANSITION');
  for (const step of body.steps ?? []) {
    await client.query(`insert into ci_steps(project_id,run,step_key,status,command,duration_ms) values($1,$2,$3,$4,'',$5)
      on conflict(run,step_key) do update set status=excluded.status,duration_ms=excluded.duration_ms`,[run.project_id,id,step.name,step.status,step.durationMs]);
  }
  const failStep = (await client.query<{ step_key: string }>("select step_key from ci_steps where run=$1 and status='fail' order by created_at,id limit 1",[id])).rows[0]?.step_key ?? null;
  if (status === 'pass' && (await client.query("select 1 from ci_steps where run=$1 and status not in ('pass','skip') limit 1",[id])).rowCount) throw new PlatformError('INVALID_TRANSITION');
  await client.query(`update ci_runs set status=$2,log_excerpt=coalesce($3,log_excerpt),artifacts=coalesce($4::jsonb,artifacts),url=coalesce($5,url),
    base_sha=coalesce(base_sha,$6),head_sha=coalesce(head_sha,$7),merge_sha=coalesce(merge_sha,$8),tree_sha=coalesce(tree_sha,$9),fail_step=$10 where id=$1`,
  [id,status,body.logExcerpt,body.artifacts === undefined ? null : JSON.stringify(body.artifacts),body.url,body.baseSha,body.headSha,body.mergeSha,body.treeSha,failStep]);
  if (status !== run.status) await notifyResult(client,{ ...run,status:status as Run['status'],fail_step:failStep });
  deferChange(client,run.project_id,'ci',{ id });
}

async function notifyResult(client: PoolClient, run: Run) {
  if (run.stage === 1 || !['pass','fail'].includes(run.status)) return;
  const stage = Object.keys(CI_STAGE).find(k => CI_STAGE[k as keyof typeof CI_STAGE] === run.stage);
  const key = `buildFail|${stage}|${run.pr ? `#${run.pr}` : 'main'}`;
  if (run.status === 'pass') {
    await client.query('update notify_events set resolved_at=clock_timestamp() where project_id=$1 and dedup_key=$2 and resolved_at is null',[run.project_id,key]);
    await client.query('update alerts set resolved_at=clock_timestamp() where project_id=$1 and key=$2 and resolved_at is null',[run.project_id,`ci:${key}`]);
  } else {
    await client.query(`insert into alerts(project_id,key,severity,target) values($1,$2,'error',$3) on conflict do nothing`,
    [run.project_id,`ci:${key}`,{ id:run.id,path:`/ci/${run.id}`,message:`${stage} 실패 — 실패 단계: ${run.fail_step ?? '미보고'}` }]);
  }
  const kind = run.status === 'fail' ? 'buildFail' : run.stage !== 3 ? 'buildOk' : null;
  if (kind) await client.query(`insert into notify_events(project_id,dedup_key,kind,ref)
    select $1,$2,$3,$4 where exists(select 1 from notify_rules where key=$3 and enabled)
    on conflict((coalesce(project_id::text,'global')),dedup_key) where resolved_at is null do update set dup_count=notify_events.dup_count+1`,
  [run.project_id,kind === 'buildFail' ? key : `buildOk|${stage}|${run.id}`,kind,
    { id:run.id,stage,pr:run.pr,failStep:run.fail_step,path:`/ci/${run.id}` }]);
  deferChange(client,run.project_id,'alert',{ id:run.id });
  deferChange(client,run.project_id,'notify',{ id:run.id });
}

/** 서버는 git을 읽지 않는다. Runner가 A 기준으로 시작하며 고정한 실행 기록을 찾는다. */
export async function resolveBasePipelineSha(client: PoolClient, baseSha: string): Promise<string | null> {
  return (await client.query<{ pipeline_sha: string }>(`select min(pipeline_sha) pipeline_sha from ci_runs where base_sha=$1 and stage in (1,2)
    having count(distinct pipeline_sha)=1`,[baseSha])).rows[0]?.pipeline_sha ?? null;
}

export async function reportQueue(client: PoolClient, principal: string, body: QueueReport) {
  const repo = new RunnerRepository(client); await repo.lock();
  const job = await checkedJob(repo,body.jobId,body.fence,principal);
  const task = await repo.task(body.taskKey);
  if (!task) throw new PlatformError('TASK_NOT_FOUND');
  if (job.kind !== 'integrate' || job.project_id !== task.project_id || job.payload.taskKey !== task.task_key || job.payload.pr !== body.pr || task.status !== 'gate') throw new PlatformError('INVALID_TRANSITION');
  const v = (await client.query<{ id: string; head_sha: string }>(`select v.id,v.head_sha from verifications v join task_attempts a on a.id=v.attempt
    where a.task=$1 and a.kind in ('qa','reverify') order by a.attempt_no desc limit 1`,[task.id])).rows[0];
  if (!v || v.head_sha !== job.payload.qaHeadSha || body.qaHeadSha && body.qaHeadSha !== v.head_sha) bad();
  const latest = (await client.query<Queue>(`select * from merge_queue where task=$1 order by created_at desc,id desc limit 1 for update`,[task.id])).rows[0];
  const previous = latest && ['waiting_verify','queued','checking'].includes(latest.status) ? latest : undefined;
  if (!previous && !['waiting_verify','queued'].includes(body.status)) throw new PlatformError('INVALID_TRANSITION');
  if (previous) {
    const transitions: Record<string,string[]> = { waiting_verify:['queued','removed'],queued:['checking','failed','removed'],checking:['merged','failed','removed'] };
    if (previous.pr !== body.pr || previous.verification !== v?.id || previous.status !== body.status && !transitions[previous.status]?.includes(body.status)) throw new PlatformError('INVALID_TRANSITION');
  }
  const head = body.syncedHeadSha ?? previous?.synced_head_sha ?? v?.head_sha;
  const base = body.baseSha ?? previous?.base_sha;
  const ciId = body.ciRunId ?? previous?.ci_run;
  const tree = body.testedTreeSha ?? previous?.tested_tree_sha;
  const proof = body.headSync ?? previous?.head_sync as HeadProof | null;
  if (previous && (previous.base_sha && base !== previous.base_sha || previous.status === 'checking' && previous.synced_head_sha && head !== previous.synced_head_sha || previous.qa_head_sha !== v?.head_sha)) bad();
  let sync = null;
  if (body.status === 'checking' || body.status === 'merged') {
    if (!base || !head || !tree || !ciId) bad();
    sync = preservedHead(required(v).head_sha,required(head),required(base),required(tree),proof);
    const ci = (await client.query<Run>('select * from ci_runs where id::text=$1',[ciId])).rows[0];
    if (!ci || ci.project_id !== task.project_id || ci.task !== task.id || ci.job !== job.id || ci.fence !== job.fence || ci.stage !== 2 ||
      ci.head_sha !== head || ci.base_sha !== base || ci.tree_sha !== tree || body.status === 'merged' && ci.status !== 'pass') bad();
    const pipeline = await resolveBasePipelineSha(client,required(base));
    if (!pipeline || pipeline !== ci?.pipeline_sha || !completionGate(await gateInput(client,task.id,sync)).every(c => c.result === 'PASS')) bad();
  }
  const parents = body.mergeParents ?? previous?.merge_parents as string[] | null;
  if (body.status === 'merged' && (!body.actualMergeSha || body.actualTreeSha !== tree || !parents || parents.length !== 2 || parents[0] !== base || parents[1] !== head)) bad();
  const values = [task.project_id,task.id,body.pr,body.status,required(v).head_sha,head,base,v?.id,ciId,tree,body.actualMergeSha,body.actualTreeSha,proof ? JSON.stringify(proof) : null,parents ? JSON.stringify(parents) : null];
  if (previous) await client.query(`update merge_queue set status=$4,synced_head_sha=$6,base_sha=$7,ci_run=$9,tested_tree_sha=$10,
    actual_merge_sha=coalesce($11,actual_merge_sha),actual_tree_sha=coalesce($12,actual_tree_sha),head_sync=$13::jsonb,merge_parents=$14::jsonb
    where project_id=$1 and task=$2 and pr=$3 and qa_head_sha=$5 and verification=$8`,values);
  else await client.query(`insert into merge_queue(project_id,task,pr,position,status,qa_head_sha,synced_head_sha,base_sha,verification,ci_run,tested_tree_sha,actual_merge_sha,actual_tree_sha,head_sync,merge_parents)
    values($1,$2,$3,(select coalesce(max(position),0)+1 from merge_queue),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)`,values);
  if (body.status === 'merged') await completeMergedTask(client,task.task_key,await resolveBasePipelineSha(client,required(base)),sync);
  if (body.status === 'failed' && previous?.status !== 'failed') {
    await client.query("update tasks set status='failed' where id=$1",[task.id]);
    await handover(client,job.id,'rework',ciId ?? job.id);
  }
  deferChange(client,task.project_id,'ci',{ taskKey:task.task_key });
}
