import type { Pool, PoolClient } from '@awbs/db';
import { inEpoch } from './transaction.ts';
import { RunnerRepository, type Job } from '../runner/repository.ts';
import { followUpJob, lockPlanningJob, currentRunnerJob, steps, log } from '../project/jobs.ts';
import { BOOT_STEPS, INPUT_STEPS, waitingForLead } from '../project/steps.ts';
import { requestSplit } from '../planning/split.ts';
import { requestPlanning } from '../planning/sessions.ts';
import { requestJudgement } from '../planning/jobs.ts';
import { requestEstimate, type RejudgeInput } from '../planning/estimate.ts';
import { evaluate } from '../planning/evaluate.ts';
import { inputOf, loadCp } from '../planning/proposals.ts';
import { lockGraph, lockTask, record } from '../tasks/write.ts';

export const REISSUE_KINDS = ['bootstrap', 'input_diff', 'split', 'estimate', 'planning'];
export class JobsError extends Error {}
export interface OpenJob {
  record: string; id: string; kind: string; state: string; contract: number; created: string;
  owner: string | null; until: string | null; fence: number; holds: string;
}

/** payload·토큰·공개키·실패 본문은 관리 출력에 포함하지 않는다. */
export async function openJobs(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const jobs = (await client.query<OpenJob>(`select j.record_no::text record,j.id,j.kind,j.state,j.schema_version contract,
      j.created_at::text created,j.lease_owner owner,j.lease_until::text until,j.fence,
      (select count(*)::text from execution_holds h where h.job=j.id and h.closed_at is null) holds
      from runner_jobs j where j.state in ('queued','leased','started','reconcile') order by j.record_no`)).rows;
    const through = (await client.query<{ n: string }>('select coalesce(max(record_no),0)::text n from runner_jobs')).rows[0]?.n ?? '0';
    const holds = (await client.query<{ n: number }>('select count(*)::int n from execution_holds where closed_at is null')).rows[0]?.n ?? 0;
    await client.query('commit');
    return { jobs, through, holds };
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

export function jobsTable(jobs: OpenJob[]): string {
  const columns: (keyof OpenJob)[] = ['record', 'id', 'kind', 'state', 'contract', 'created', 'owner', 'until', 'fence', 'holds'];
  return [columns.join('\t'), ...jobs.map(job => columns.map(key => String(job[key] ?? '-').replace(/[\t\r\n]/g, ' ').replaceAll(String.fromCharCode(27), ' ')).join('\t'))].join('\n') + '\n';
}

async function rebuild(client: PoolClient, job: Job, epoch: number): Promise<string> {
  const project = job.project_id;
  if (!project) throw new JobsError('재발급할 프로젝트가 없습니다. 변경을 모두 취소했습니다.');
  await lockGraph(client, project);
  if (job.kind === 'bootstrap' || job.kind === 'input_diff') {
    const analysis = await lockPlanningJob(client, String(job.payload.planningJobId));
    const progress = await steps(client, analysis.id);
    const resumeStep = (analysis.kind === 'bootstrap' ? BOOT_STEPS : INPUT_STEPS).find(key => progress.get(key) !== 'done');
    if (analysis.project_id !== project || analysis.kind !== job.kind || !['queued', 'running'].includes(analysis.status) ||
      await currentRunnerJob(client, analysis.id) !== job.id || waitingForLead(analysis.kind, progress) || !resumeStep || resumeStep === 'approve') {
      throw new JobsError('현재 분석과 일치하지 않는 job입니다. 변경을 모두 취소했습니다.');
    }
    const next = await followUpJob(client, analysis, epoch, { resumeStep });
    await log(client, analysis, `계약 변경 재발급 — ${job.id} → ${next}`);
    return next;
  }
  if (job.kind === 'split') {
    const key = (job.payload.tasks as { taskKey?: string }[] | undefined)?.[0]?.taskKey;
    if (!key) throw new JobsError('분할 대상이 없습니다. 변경을 모두 취소했습니다.');
    const task = await lockTask(client, key);
    if (task.project_id !== project) throw new JobsError('분할 프로젝트가 다릅니다.');
    return requestSplit(client, task, epoch);
  }
  if (job.kind === 'estimate') {
    const keys = (job.payload.tasks as { taskKey: string }[] | undefined)?.map(task => task.taskKey) ?? [];
    const tasks = (await client.query<{ id: string }>('select id from tasks where project_id=$1 and task_key=any($2::text[]) and deleted_at is null order by id for update', [project, keys])).rows;
    const rejudge = (job.payload.policy as { rejudge?: RejudgeInput } | undefined)?.rejudge;
    if (!rejudge || tasks.length !== keys.length) throw new JobsError('추정 대상을 확인할 수 없습니다. 변경을 모두 취소했습니다.');
    return requestEstimate(client, project, tasks.map(task => task.id), rejudge, epoch, `contract:${job.id}`);
  }
  const payload = job.payload as { planning?: { id?: string }; proposal?: { id?: string } };
  if (payload.planning?.id) {
    if (!(await client.query('select 1 from plannings where id=$1 and project_id=$2', [payload.planning.id, project])).rowCount) throw new JobsError('Planning 프로젝트가 다릅니다.');
    return requestPlanning(client, payload.planning.id, epoch);
  }
  if (payload.proposal?.id) {
    const cp = await loadCp(client, payload.proposal.id, true);
    if (cp.project_id !== project || !['review', 'approved', 'held'].includes(cp.status)) throw new JobsError('판단할 변경 제안 상태가 아닙니다.');
    const next = await requestJudgement(client, cp, await evaluate(client, inputOf(cp)), epoch);
    if (next) return next;
    throw new JobsError('현재 변경 제안에는 새 판단 job이 필요하지 않습니다. 변경을 모두 취소했습니다.');
  }
  throw new JobsError('원래 생성 대상을 확인할 수 없습니다. 변경을 모두 취소했습니다.');
}

/** 순번 상한은 재실행해도 바꾸지 않는다. 새 job은 상한 밖이므로 다시 만들지 않는다. */
export async function reissueJobs(pool: Pool, through: string, confirm = false, kinds = REISSUE_KINDS) {
  if (!/^\d+$/.test(through) || BigInt(through) > 9223372036854775807n || !kinds.length || kinds.some(kind => !REISSUE_KINDS.includes(kind))) {
    throw new JobsError('--through에는 jobs open의 순번을, --kinds에는 지원하는 종류를 지정하세요.');
  }
  const epoch = (await pool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch;
  if (epoch === undefined) throw new JobsError('서버 초기 상태를 확인하세요.');
  return inEpoch(pool, epoch, async client => {
    const repo = new RunnerRepository(client);
    await repo.lock();
    // heartbeat·세션 시작은 조정 잠금을 쓰지만, 표 잠금으로 별도 세션 쓰기도 검사와 직렬화한다.
    await client.query('lock table runner_sessions in share mode');
    if ((await client.query(`select 1 from runner_sessions s cross join app_settings cfg where cfg.singleton
      and s.last_heartbeat_at>clock_timestamp()-make_interval(secs=>cfg.heartbeat_seconds*cfg.heartbeat_misses) limit 1`)).rowCount) {
      throw new JobsError('Runner의 최근 heartbeat가 있습니다. Runner를 정지하고 연결 끊김을 확인하세요.');
    }
    if ((await client.query("select 1 from runner_jobs where state in ('leased','started','reconcile') or state='queued' and lease_until>clock_timestamp() limit 1")).rowCount ||
      (await client.query('select 1 from execution_holds where closed_at is null limit 1')).rowCount) {
      throw new JobsError('임대·실행·대조 대기 또는 열린 실행 보유가 남았습니다. jobs open으로 확인하고 기존 종료·대조 절차를 마치세요.');
    }
    if (await repo.cleanup()) throw new JobsError('Runner 정리가 남았습니다. 정리를 마치세요.');
    const jobs = (await client.query<Job>("select * from runner_jobs where record_no<=$1::bigint and state='queued' and kind::text=any($2::text[]) order by record_no for update", [through, kinds])).rows;
    const results: { old: string; next: string | null }[] = [];
    for (const job of jobs) {
      if (!confirm) { results.push({ old: job.id, next: null }); continue; }
      await client.query("update runner_jobs set state='cancelled',fence=fence+1,lease_owner=null,lease_until=null where id=$1", [job.id]);
      const next = await rebuild(client, job, epoch);
      await repo.event(job, 'finished', 'CONTRACT_CHANGED', { replacementJobId: next, through });
      const replacement = await repo.job(next);
      if (!replacement || replacement.id === job.id || BigInt(replacement.record_no) <= BigInt(through)) throw new JobsError('새 job 순번을 확인할 수 없습니다. 변경을 모두 취소했습니다.');
      await repo.event(replacement, 'prepared', 'CONTRACT_CHANGED', { replacesJobId: job.id });
      const keys = (job.payload.tasks as { taskKey?: string }[] | undefined)?.flatMap(task => task.taskKey ?? []) ?? [];
      for (const task of (await client.query<{ id: string }>('select id from tasks where project_id=$1 and task_key=any($2::text[]) order by id', [job.project_id, keys])).rows) {
        await record(client, { projectId: job.project_id as string, taskId: task.id, kind: '계약 변경 재발급', actor: '관리자', text: '현재 입력으로 Runner job 재발급', ref: { code: 'CONTRACT_CHANGED', oldJobId: job.id, jobId: next } });
      }
      results.push({ old: job.id, next });
    }
    return results;
  });
}
