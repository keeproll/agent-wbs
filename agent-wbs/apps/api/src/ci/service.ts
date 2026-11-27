import { randomUUID } from 'node:crypto';
import { CI_STAGE, type PoolClient, type schema } from '@awbs/db';
import { completionGate, lifecycleTransition, DomainError } from '@awbs/shared';
import { deferChange } from '../changes/events.ts';
import { PlatformError } from '../platform/errors.ts';
import { RunnerRepository, required } from '../runner/repository.ts';
import { checkedJob, handover } from '../runner/service.ts';
import { completeMergedTask, gateInput, invalidateTaskGate } from '../execution/gate.ts';
import { resolveBaselineFailure } from './decisions.ts';
import { observedBases } from './pipeline.ts';
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
  failScope?: 'baseline' | 'task';
  causeCandidates?: { commit:string }[];
  note?: string; finishedAt?: string; e2e?: { passed:number;total:number };
  githubStatus?: { headSha:string;context:string;state:'pending'|'success'|'failure'|'error';reportedAt:string;url?:string };
  flakyTests?: { testKey:string;rate:number;lastFailedAt:string }[];
  deployRestore?: { commit: string | null; status: 'pass' | 'fail' | 'none' };
}
export interface QueueReport {
  jobId: string; fence: number; pr: number; taskKey: string; status: string;
  qaHeadSha?: string; syncedHeadSha?: string; baseSha?: string; ciRunId?: string; testedTreeSha?: string;
  actualMergeSha?: string; actualTreeSha?: string; mergedAt?: string; headSync?: HeadProof; mergeParents?: string[];
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
  if (body.failScope && (run.stage !== 1 || status !== 'fail' || run.status === 'fail' && body.failScope !== run.fail_scope)) throw new PlatformError('INVALID_TRANSITION');
  if (body.failScope === 'baseline' && !(body.baseSha ?? run.base_sha)) throw new PlatformError('VALIDATION_FAILED');
  assertCiTransition(run.status,status);
  if (body.deployRestore) {
    // none(복구할 배포 없음)만 커밋이 없다. 복구한 결과(pass·fail)에는 다시 기동한 커밋이 있어야 한다.
    if ((body.deployRestore.status === 'none') !== (body.deployRestore.commit === null)) throw new PlatformError('VALIDATION_FAILED');
    if (run.stage !== 4 || status !== 'fail') throw new PlatformError('INVALID_TRANSITION');
  }
  if (body.e2e && body.e2e.passed > body.e2e.total || body.finishedAt && !['pass','fail','skip'].includes(status)) throw new PlatformError('VALIDATION_FAILED');
  if (body.githubStatus && body.githubStatus.headSha !== (body.headSha ?? run.head_sha)) throw new PlatformError('INVALID_TRANSITION');
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
  const failStep = (await client.query<{ step_key: string }>("select step_key from ci_steps where run=$1 and status='fail' order by record_no limit 1",[id])).rows[0]?.step_key ?? null;
  if (status === 'pass' && (await client.query("select 1 from ci_steps where run=$1 and status not in ('pass','skip') limit 1",[id])).rowCount) throw new PlatformError('INVALID_TRANSITION');
  await client.query(`update ci_runs set status=$2,log_excerpt=coalesce($3,log_excerpt),artifacts=coalesce($4::jsonb,artifacts),url=coalesce($5,url),
    base_sha=coalesce(base_sha,$6),head_sha=coalesce(head_sha,$7),merge_sha=coalesce(merge_sha,$8),tree_sha=coalesce(tree_sha,$9),fail_step=$10,fail_scope=coalesce($11,fail_scope),note=coalesce($12,note),e2e=coalesce($13::jsonb,e2e),finished_at=coalesce(finished_at,$14::timestamptz),github_status=coalesce($15::jsonb,github_status),cause_candidates=coalesce($16::jsonb,cause_candidates) where id=$1`,
  [id,status,body.logExcerpt,body.artifacts === undefined ? null : JSON.stringify(body.artifacts),body.url,body.baseSha,body.headSha,body.mergeSha,body.treeSha,failStep,body.failScope,body.note,body.e2e ? JSON.stringify(body.e2e) : null,body.finishedAt,body.githubStatus ? JSON.stringify(body.githubStatus) : null,body.causeCandidates===undefined ? null : JSON.stringify(body.causeCandidates)]);
  for (const flaky of body.flakyTests ?? []) await client.query(`insert into flaky_tests(project_id,test_key,rate,quarantined,task,last_failed_at) values($1,$2,$3,false,$4,$5)
    on conflict(test_key) do update set rate=excluded.rate,task=coalesce(excluded.task,flaky_tests.task),last_failed_at=excluded.last_failed_at
    where flaky_tests.project_id=excluded.project_id and (flaky_tests.last_failed_at is null or flaky_tests.last_failed_at<=excluded.last_failed_at)`,[run.project_id,flaky.testKey,flaky.rate,run.task,flaky.lastFailedAt]);
  if (run.stage === 4) await serviceAvailability(client,{ ...run,status:status as Run['status'] },body.deployRestore);
  if (status !== run.status) await notifyResult(client,{ ...run,base_sha:run.base_sha ?? body.baseSha ?? null,status:status as Run['status'],fail_step:failStep,fail_scope:body.failScope ?? run.fail_scope });
  deferChange(client,run.project_id,'ci',{ id });
}

async function notifyResult(client: PoolClient, run: Run) {
  const baselineClosed = run.stage===1 && run.base_sha ? await resolveBaselineFailure(client,run.project_id,run.base_sha) : false;
  if (run.stage === 1 && run.fail_scope !== 'baseline' || !['pass','fail'].includes(run.status)) return;
  const stage = Object.keys(CI_STAGE).find(k => CI_STAGE[k as keyof typeof CI_STAGE] === run.stage);
  const key = run.fail_scope === 'baseline' ? `baseline|${run.base_sha}` : `buildFail|${stage}|${run.pr ? `#${run.pr}` : 'main'}`;
  if (run.status === 'pass') {
    const newer = await client.query('select 1 from ci_runs where project_id=$1 and stage=$2 and pr is not distinct from $3 and run_no>$4 limit 1',[run.project_id,run.stage,run.pr,run.run_no]);
    if (!newer.rowCount) {
      await client.query('update notify_events set resolved_at=clock_timestamp() where project_id=$1 and dedup_key=$2 and resolved_at is null',[run.project_id,key]);
      await client.query('update alerts set resolved_at=clock_timestamp() where project_id=$1 and key=$2 and resolved_at is null',[run.project_id,`ci:${key}`]);
    }
  } else if (!baselineClosed) {
    await client.query(`insert into alerts(project_id,key,severity,target) values($1,$2,'error',$3) on conflict do nothing`,
    [run.project_id,`ci:${key}`,{ id:run.id,path:`/ci/${run.id}`,message:`${run.fail_scope === 'baseline' ? '기준선 검사' : stage} 실패 — 실패 단계: ${run.fail_step ?? '미보고'}` }]);
  }
  const kind = run.status === 'fail' ? 'buildFail' : run.stage !== 3 ? 'buildOk' : null;
  if (kind) await client.query(`insert into notify_events(project_id,dedup_key,kind,ref)
    select $1,$2,$3,$4 where exists(select 1 from notify_rules where key=$3 and enabled)
      and exists(select 1 from notify_settings where singleton and enabled)
    on conflict((coalesce(project_id::text,'global')),dedup_key) where resolved_at is null do update set dup_count=notify_events.dup_count+1`,
  [run.project_id,kind === 'buildFail' ? run.fail_scope === 'baseline' ? `${key}|${run.id}` : key : `buildOk|${stage}|${run.id}`,kind,
    { id:run.id,stage,pr:run.pr,failStep:run.fail_step,failScope:run.fail_scope,baseSha:run.base_sha,path:`/ci/${run.id}` }]);
  if (run.fail_scope==='baseline' && baselineClosed && run.base_sha) await resolveBaselineFailure(client,run.project_id,run.base_sha);
  deferChange(client,run.project_id,'alert',{ id:run.id });
  deferChange(client,run.project_id,'notify',{ id:run.id });
}

/**
 * M7-03 결정 11: 배포 확인이 실패하고 마지막 정상 커밋 복구도 실패했거나 복구할 배포가 없으면 「서비스 없음」이다.
 * 일반 빌드 실패와 따로 높은 우선순위 경보(critical)와 serviceDown 알림을 만든다. 알림 규칙과 무관하게 전체 알림이 켜져 있으면 보낸다.
 * 다음 배포 확인 통과(더 새로운 배포 실행이 없을 때)에서 해소한다.
 */
async function serviceAvailability(client: PoolClient, run: Run, restore: Update['deployRestore']) {
  if (run.status === 'fail' && restore && restore.status !== 'pass') {
    const ref = { id:run.id,path:`/ci/${run.id}`,restore:restore.status,restoreCommit:restore.commit,
      message:`서비스 없음 — 배포 확인 실패 뒤 ${restore.status === 'none' ? '복구할 직전 통과 배포가 없음' : `마지막 정상 커밋 ${String(restore.commit).slice(0,7)} 복구 실패`}` };
    await client.query("insert into alerts(project_id,key,severity,target) values($1,'ci:serviceDown','critical',$2) on conflict do nothing",[run.project_id,ref]);
    await client.query(`insert into notify_events(project_id,dedup_key,kind,ref) select $1,'serviceDown','serviceDown',$2
      where exists(select 1 from notify_settings where singleton and enabled)
      on conflict((coalesce(project_id::text,'global')),dedup_key) where resolved_at is null do update set dup_count=notify_events.dup_count+1`,[run.project_id,ref]);
  } else if (run.status === 'pass') {
    const newer = await client.query('select 1 from ci_runs where project_id=$1 and stage=4 and run_no>$2 limit 1',[run.project_id,run.run_no]);
    if (newer.rowCount) return;
    await client.query("update alerts set resolved_at=clock_timestamp() where project_id=$1 and key='ci:serviceDown' and resolved_at is null",[run.project_id]);
    await client.query("update notify_events set resolved_at=clock_timestamp() where project_id=$1 and dedup_key='serviceDown' and resolved_at is null",[run.project_id]);
  } else return;
  deferChange(client,run.project_id,'alert',{ id:run.id });
  deferChange(client,run.project_id,'notify',{ id:run.id });
}

/** 서버는 git을 읽지 않는다. Runner가 A 기준으로 시작하며 고정한 실행 기록을 찾는다. */
export async function resolveBasePipelineSha(client: PoolClient, baseSha: string, projectId: string): Promise<string | null> {
  return (await client.query<{ pipeline_sha: string }>(`select p.pipeline_observations->$1->>'pipelineSha' pipeline_sha from projects p where p.id=$2
    and p.pipeline_observations->$1->'definition'->>'status'='ok' and exists(select 1 from ci_runs c
      where c.project_id=p.id and c.base_sha=$1 and c.job is not null and c.status in ('run','pass')
      and c.pipeline_sha=p.pipeline_observations->$1->>'pipelineSha')`,[baseSha,projectId])).rows[0]?.pipeline_sha ?? null;
}

export async function reportQueue(client: PoolClient, principal: string, body: QueueReport) {
  if ((body.status === 'merged' || body.actualMergeSha) && (body.status !== 'merged' || !body.actualMergeSha || !body.actualTreeSha || body.mergeParents?.length !== 2)) throw new PlatformError('VALIDATION_FAILED');
  const repo = new RunnerRepository(client); await repo.lock();
  const task = await repo.task(body.taskKey);
  if (!task) throw new PlatformError('TASK_NOT_FOUND');
  const job = await checkedJob(repo,body.jobId,body.fence,principal,task.status === 'done');
  if (job.kind !== 'integrate' || job.project_id !== task.project_id || job.payload.taskKey !== task.task_key || job.payload.pr !== body.pr) throw new PlatformError('INVALID_TRANSITION');
  if (task.status === 'done' && body.status === 'merged') {
    const q = (await client.query<Queue>('select q.* from merge_queue q join ci_runs c on c.id=q.ci_run where q.task=$1 and c.job=$2 and c.fence=$3 order by q.queue_no desc limit 1',[task.id,job.id,job.fence])).rows[0];
    if (q?.status === 'merged' && q.pr === body.pr && q.actual_merge_sha === body.actualMergeSha && q.actual_tree_sha === body.actualTreeSha &&
      q.qa_head_sha === body.qaHeadSha && q.synced_head_sha === body.syncedHeadSha && q.base_sha === body.baseSha && q.ci_run === body.ciRunId &&
      JSON.stringify(q.merge_parents) === JSON.stringify(body.mergeParents)) return;
    throw new PlatformError('INVALID_TRANSITION');
  }
  const latest = (await client.query<Queue>(`select * from merge_queue where task=$1 order by queue_no desc limit 1 for update`,[task.id])).rows[0];
  try {
    if (body.actualMergeSha) {
      await client.query('insert into ci_merge_facts(project_id,merge_sha,tree_sha,parents) values($1,$2,$3,$4::jsonb) on conflict do nothing',[task.project_id,body.actualMergeSha,body.actualTreeSha,JSON.stringify(body.mergeParents ?? null)]);
      const first = required((await client.query<{ tree_sha: string | null; parents: string[] | null }>('select tree_sha,parents from ci_merge_facts where project_id=$1 and merge_sha=$2',[task.project_id,body.actualMergeSha])).rows[0]);
      if (first.tree_sha !== (body.actualTreeSha ?? null) || JSON.stringify(first.parents) !== JSON.stringify(body.mergeParents ?? null)) bad();
    }
    if (body.mergedAt && body.status !== 'merged') throw new PlatformError('VALIDATION_FAILED');
    if (task.status !== 'gate') throw new PlatformError('INVALID_TRANSITION');
    const v = (await client.query<{ id: string; head_sha: string }>(`select v.id,v.head_sha from verifications v join task_attempts a on a.id=v.attempt
      where a.task=$1 and a.kind in ('qa','reverify') order by a.attempt_no desc limit 1`,[task.id])).rows[0];
    if (!v || v.head_sha !== job.payload.qaHeadSha || body.qaHeadSha && body.qaHeadSha !== v.head_sha) bad();
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
    if (proof?.chain && head && base) {
      try { preservedHead(required(v).head_sha,head,base,tree ?? proof.headTreeSha,proof,await observedBases(client,task.project_id)); }
      catch (error) {
        if (!(error instanceof PlatformError)) throw error;
        await invalidateTaskGate(client,task.task_key,head);
        throw new PlatformError('GATE_NOT_PASSED',{ reverify:true });
      }
    }
    if (body.status === 'checking' || body.status === 'merged') {
      if (!base || !head || !tree || !ciId) bad();
      sync = preservedHead(required(v).head_sha,required(head),required(base),required(tree),proof,await observedBases(client,task.project_id));
      const ci = (await client.query<Run>('select * from ci_runs where id::text=$1',[ciId])).rows[0];
      if (!ci || ci.project_id !== task.project_id || ci.task !== task.id || ci.job !== job.id || ci.fence !== job.fence || ci.stage !== 2 ||
        ci.head_sha !== head || ci.base_sha !== base || ci.tree_sha !== tree || body.status === 'merged' && ci.status !== 'pass') bad();
      const pipeline = await resolveBasePipelineSha(client,required(base),task.project_id);
      const check = (await client.query<{ pipeline_sha: string }>('select pipeline_sha from ci_runs where task=$1 and stage=1 and head_sha=$2 order by run_no desc limit 1',[task.id,head])).rows[0];
      if (!pipeline || check?.pipeline_sha !== pipeline || pipeline !== ci?.pipeline_sha || !completionGate(await gateInput(client,task.id,sync)).every(c => c.result === 'PASS')) bad();
    }
    const parents = body.mergeParents ?? previous?.merge_parents as string[] | null;
    if (body.status === 'merged' && !body.actualMergeSha) bad();
    if (body.status === 'merged' && (body.actualTreeSha !== tree || !parents || parents.length !== 2 || parents[0] !== base || parents[1] !== head)) bad();
    const values = [task.project_id,task.id,body.pr,body.status,required(v).head_sha,head,base,v?.id,ciId,tree,body.actualMergeSha,body.actualTreeSha,proof ? JSON.stringify(proof) : null,parents ? JSON.stringify(parents) : null,body.mergedAt];
    if (previous) await client.query(`update merge_queue set status=$4,synced_head_sha=$6,base_sha=$7,ci_run=$9,tested_tree_sha=$10,
      actual_merge_sha=coalesce($11,actual_merge_sha),actual_tree_sha=coalesce($12,actual_tree_sha),head_sync=$13::jsonb,merge_parents=$14::jsonb,merged_at=coalesce(merged_at,$15::timestamptz)
      where project_id=$1 and task=$2 and pr=$3 and qa_head_sha=$5 and verification=$8 and id=$16`,[...values,previous.id]);
    else await client.query(`insert into merge_queue(project_id,task,pr,position,status,qa_head_sha,synced_head_sha,base_sha,verification,ci_run,tested_tree_sha,actual_merge_sha,actual_tree_sha,head_sync,merge_parents,merged_at)
      values($1,$2,$3,(select coalesce(max(position),0)+1 from merge_queue),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)`,values);
    if (body.status === 'merged') {
      await completeMergedTask(client,task.task_key,await resolveBasePipelineSha(client,required(base),task.project_id),sync);
      await client.query("update alerts set resolved_at=clock_timestamp() where project_id=$1 and key=$2 and target->>'actualMergeSha'=$3 and resolved_at is null",[task.project_id,`ci:mergeMismatch|#${body.pr}`,body.actualMergeSha]);
      await client.query("update notify_events set resolved_at=clock_timestamp() where project_id=$1 and dedup_key=$2 and ref->>'actualMergeSha'=$3 and resolved_at is null",[task.project_id,`ci:mergeMismatch|#${body.pr}`,body.actualMergeSha]);
    }
    if (body.status === 'failed' && previous?.status !== 'failed') {
      const baseline = ciId && (await client.query("select 1 from ci_runs where id::text=$1 and project_id=$2 and job=$3 and stage=1 and fail_scope='baseline' and status='fail'",[ciId,task.project_id,job.id])).rowCount;
      if (baseline) {
        const hold = await repo.hold(job.id);
        if (!hold || hold.slot_state !== 'none' || !hold.release_proof) throw new PlatformError('INVALID_TRANSITION');
        await repo.release(hold,hold.release_proof,true); await repo.state(job.id,'failed');
      } else {
        const status = lifecycleTransition(task.status,{ type:'integration-failed' });
        await client.query('update tasks set status=$2 where id=$1',[task.id,status]);
        await repo.historyEvent(task,'통합 실패',{ ciRunId:ciId });
        await handover(client,job.id,'rework',ciId ?? job.id,{ integrationFailed:true });
      }
    }
    deferChange(client,task.project_id,'ci',{ taskKey:task.task_key });
  } catch (error) {
    if (body.status !== 'merged' || !body.actualMergeSha || !latest ||
      !(error instanceof PlatformError || error instanceof DomainError) || !['GATE_NOT_PASSED','INVALID_TRANSITION'].includes(error.code)) throw error;
    await client.query(`update merge_queue q set status=$4,actual_merge_sha=f.merge_sha,actual_tree_sha=f.tree_sha,merge_parents=f.parents,merged_at=coalesce(q.merged_at,$5::timestamptz)
      from ci_merge_facts f where q.id=$1 and f.project_id=$2 and f.merge_sha=$3`,[latest.id,task.project_id,body.actualMergeSha,latest.status,body.mergedAt]);
    const key = `ci:mergeMismatch|#${body.pr}`;
    const ref = { taskKey:task.task_key,id:latest.id,actualMergeSha:body.actualMergeSha,message:'실제 병합이 검증 근거와 다릅니다. 완료를 보류합니다.' };
    await client.query("insert into alerts(project_id,key,severity,target) values($1,$2,'error',$3) on conflict do nothing",[task.project_id,key,ref]);
    await client.query(`insert into notify_events(project_id,dedup_key,kind,ref) select $1,$2,'buildFail',$3
      where exists(select 1 from notify_settings where singleton and enabled) and exists(select 1 from notify_rules where key='buildFail' and enabled) on conflict do nothing`,[task.project_id,key,ref]);
    for (const topic of ['alert','notify','ci'] as const) deferChange(client,task.project_id,topic,{ taskKey:task.task_key });
    throw new PlatformError('MERGE_MISMATCH');
  }
}
