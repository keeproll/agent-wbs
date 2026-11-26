import type { PoolClient } from '@awbs/db';
import { JUDGED_RULES } from '@awbs/shared';
import type { WireProposalOp } from '@awbs/shared/api';
import { TaskError } from '../tasks/errors.ts';
import { judgementJobKey, stripJudgements } from './content.ts';
import type { Evaluation } from './evaluate.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 아직 끝나지 않은 job 상태. 이 상태의 판단 job이 있으면 같은 조합으로 다시 만들지 않는다. */
const OPEN = ['queued', 'leased', 'started', 'reconcile'];

/**
 * 판단이 필요한 CP의 Planning 판단 job을 만든다(contracts §2.1 판단 처리, §3.2 판단 payload).
 * - CP와 대상 hash 조합당 열린 job은 하나다 [결정]. 조합이 바뀌면(내용 변경) 새 job을 만든다 = 재요청.
 * - 같은 조합의 job이 끝났는데도 판단이 없으면 다시 만든다(번호를 붙여 dedup_key 중복을 피한다).
 * - payload의 내용과 hash는 같은 트랜잭션의 같은 시점 값이다. Runner는 이 payload만으로 판단한다.
 * 만들었으면 job id, 이미 열린 job이 있거나 판단이 필요 없으면 null.
 */
export async function requestJudgement(client: PoolClient, cp: { id: string; project_id: string; ops: readonly WireProposalOp[] }, ev: Evaluation, epoch: number): Promise<string | null> {
  if (!ev.needsJudgement) return null;
  const key = judgementJobKey(cp.id, ev.targets, ev.splitHash);
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  const existing = (await client.query<{ open: boolean; n: number }>(
    'select coalesce(bool_or(state::text=any($2)),false) as open,count(*)::int as n from runner_jobs where dedup_key like $1',
    [`${key}:%`, OPEN])).rows[0];
  if (existing?.open) return null;
  const payload = {
    tasks: [],
    policy: { judgedRules: JUDGED_RULES.filter((rule) => ev.loaded.settings.enabled[rule]) },
    proposal: { id: cp.id, ops: stripJudgements(cp.ops), targets: ev.targets, splitSubjectHash: ev.splitHash, splitTasks: ev.splitTasks },
  };
  return (await client.query<{ id: string }>(
    "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'planning',$2::jsonb,'queued',$3,$4) returning id",
    [cp.project_id, JSON.stringify(payload), epoch, `${key}:${String((existing?.n ?? 0) + 1)}`])).rows[0]?.id ?? null;
}

/** 작업 job을 잠그고 fence를 대조한다. 낡은 fence·끝난 job의 보고는 409 LEASE_LOST(contracts §3.2 규칙 4). */
export async function assertJob(client: PoolClient, jobId: string, fence: number, kinds: readonly string[] = ['planning', 'estimate', 'split', 'bootstrap', 'input_diff']): Promise<{ id: string; kind: string; payload: unknown }> {
  if (!UUID.test(jobId)) throw new TaskError('NOT_FOUND', { resource: 'job', id: jobId });
  const job = (await client.query<{ id: string; kind: string; payload: unknown; fence: number; state: string }>(
    'select id,kind::text as kind,payload,fence,state::text as state from runner_jobs where id=$1 for update', [jobId])).rows[0];
  if (!job || !kinds.includes(job.kind)) throw new TaskError('NOT_FOUND', { resource: 'job', id: jobId });
  if (job.fence !== fence || !['leased', 'started'].includes(job.state)) {
    throw new TaskError('LEASE_LOST', { jobId, fence: job.fence, state: job.state }, [], '작업 임대가 끝났거나 다른 Runner로 넘어가 이 보고를 받을 수 없습니다.');
  }
  return job;
}


/** 등급을 다시 바꾼 뒤 도착한 옛 추정은 받지 않는다. 내용 hash에는 등급이 포함되지 않기 때문이다(D-33). */
export async function assertGradeChange(client: PoolClient, payload: unknown, taskId: string): Promise<void> {
  const marker = (payload as { policy?: { gradeChange?: string } } | null)?.policy?.gradeChange;
  if (!marker) return;
  const latest = (await client.query<{ marker: string }>(
    "select ref->>'gradeChange' marker from task_history where task=$1 and ref ? 'gradeChange' order by at desc,created_at desc limit 1", [taskId])).rows[0]?.marker;
  if (latest !== marker) throw new TaskError('LEASE_LOST', {}, [], '등급이 다시 바뀌어 이전 등급의 판단·추정을 받을 수 없습니다.');
}
