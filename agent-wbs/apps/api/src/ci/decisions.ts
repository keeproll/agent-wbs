import type { PoolClient, schema } from '@awbs/db';
import { inputHead } from '../project/service.ts';
import { integrationDecision } from '../execution/gate.ts';
import { RunnerRepository } from '../runner/repository.ts';
import { externalWriteAllowed } from '../runner/service.ts';
import { deferChange } from '../changes/events.ts';

type Run = typeof schema.ciRuns.$inferSelect;

/** main 이동과 올바른 정의의 나중 PASS만 기준 실패를 해소한다. 시각은 비교하지 않는다. */
export async function baselineResolved(client: PoolClient, project: string, base: string): Promise<boolean> {
  if (await inputHead(client,project) !== base) {
    const known = await client.query('select 1 from input_versions where project_id=$1 and commit_sha=$2 union all select 1 from input_change_commits where project_id=$1 and sha=$2 limit 1',[project,base]);
    if (known.rowCount) return true;
  }
  return (await client.query<{ resolved:boolean }>(`select exists(select 1 from ci_runs c join projects p on p.id=c.project_id
    where c.project_id=$1 and c.base_sha=$2 and c.stage=1 and c.status='pass' and c.job is not null
      and p.pipeline_observations->$2->'definition'->>'status'='ok' and c.pipeline_sha=p.pipeline_observations->$2->>'pipelineSha'
      and not exists(select 1 from ci_runs newer where newer.project_id=c.project_id and newer.base_sha=c.base_sha
        and newer.stage=1 and newer.fail_scope='baseline' and newer.run_no>c.run_no)) resolved`,[project,base])).rows[0]?.resolved ?? false;
}

export async function resolveBaselineFailure(client: PoolClient, project: string, base: string) {
  const resolved = await baselineResolved(client,project,base);
  if (!resolved) return false;
  const key=`baseline|${base}`;
  const alerts=await client.query('update alerts set resolved_at=clock_timestamp() where project_id=$1 and key=$2 and resolved_at is null',[project,`ci:${key}`]);
  const events=await client.query(`update notify_events set resolved_at=clock_timestamp() where project_id=$1 and resolved_at is null
    and ((ref->>'failScope'='baseline' and ref->>'baseSha'=$2) or dedup_key=$3 or starts_with(dedup_key,$3||'|'))`,[project,base,key]);
  if (alerts.rowCount) deferChange(client,project,'alert',{});
  if (events.rowCount) deferChange(client,project,'notify',{});
  return true;
}

export async function resolveMovedBaselines(client: PoolClient, project: string) {
  const bases=(await client.query<{ base:string }>("select distinct split_part(key,'|',2) base from alerts where project_id=$1 and key like 'ci:baseline|%' and resolved_at is null",[project])).rows;
  for (const {base} of bases) await resolveBaselineFailure(client,project,base);
}

type RetryDecision = { allowed:false;reason:string;code:'INVALID_TRANSITION'|'EXTERNAL_WRITE_BLOCKED';details?:Record<string,unknown> } | { allowed:true;reason:null;kind:'integrate'|'ci_retry' };

/** Gate 밖은 일반 ci_retry다. 병합 보류 검사는 Gate의 기준 실패 재통합에만 적용한다. */
export async function retryDecision(client: PoolClient, run: Run): Promise<RetryDecision> {
  if (run.status!=='fail') return { allowed:false,reason:'실패한 실행만 다시 시도할 수 있습니다.',code:'INVALID_TRANSITION' };
  const repo=new RunnerRepository(client);
  const authority=(await client.query<{state:string;host_id:string;generation:number}>('select state,host_id,generation from external_write_authority where singleton')).rows[0];
  let kind:'integrate'|'ci_retry'='ci_retry', generation=authority?.generation;
  const task=run.task ? (await client.query<{status:string}>('select status from tasks where id=$1 and deleted_at is null',[run.task])).rows[0] : null;
  if (run.fail_scope==='baseline' && run.task && task?.status==='gate') {
    kind='integrate';
    const plan=await integrationDecision(client,run.task,{retry:true});
    if (!plan.allowed) return { allowed:false,reason:plan.reason,code:'INVALID_TRANSITION' };
    generation='existingJobId' in plan ? (await client.query<{generation:number}>('select generation from runner_jobs where id=$1',[plan.existingJobId])).rows[0]?.generation : plan.generation ?? undefined;
  } else if (!run.head_sha) return { allowed:false,reason:'다시 검사할 커밋이 기록되지 않았습니다.',code:'INVALID_TRANSITION' };
  if (!externalWriteAllowed(authority,(await repo.host())?.host_id,generation)) return { allowed:false,reason:'외부 작업 권한을 먼저 복구해야 합니다.',code:'EXTERNAL_WRITE_BLOCKED',details:{generation:authority?.generation} };
  return { allowed:true,reason:null,kind };
}

/** 화면은 기록된 실행 SHA로 완료나 복구를 추측하지 않고 이 결과를 표시한다. */
export async function ciRunDecisions(client: PoolClient, id: string) {
  const run=(await client.query<Run>('select * from ci_runs where id=$1',[id])).rows[0];
  if (!run) throw new Error('CI 실행을 찾을 수 없습니다.');
  const baseline=run.stage===1 && run.status==='fail' && run.fail_scope==='baseline';
  const auto=baseline && run.task ? await integrationDecision(client,run.task,{baselineOnly:true,sourceRunId:id}) : null;
  const retry=await retryDecision(client,run);
  const task=run.task ? (await client.query<{status:string}>('select status from tasks where id=$1',[run.task])).rows[0] : null;
  const merge=(await client.query<{status:string;actual_merge_sha:string|null}>('select status,actual_merge_sha from merge_queue where ci_run=$1 order by queue_no desc limit 1',[id])).rows[0];
  return {
    baselineResolved:baseline && run.base_sha ? await baselineResolved(client,run.project_id,run.base_sha) : null,
    autoReintegrate:auto?.state ?? 'none',autoReintegrateReason:auto?.reason ?? null,
    retryAllowed:retry.allowed,retryBlockedReason:retry.reason,
    taskStatus:task?.status ?? null,mergeStatus:merge?.status ?? null,actualMergeSha:merge?.actual_merge_sha ?? null,
    mergeCompleted:merge?.status==='merged' && task?.status==='done',
  };
}
