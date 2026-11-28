import { changeEvent, enqueueJob, iso, type Db } from './db.ts';
import { ProjectError } from './errors.ts';
import { BOOT_STEPS, INPUT_STEPS, LEAD_STEPS, waitingForLead, type StepStatus } from './steps.ts';
import { techSnapshot, wbsSnapshot } from '../planning/job-snapshot.ts';

/*
 * Planning 작업(planning_jobs)과 Runner job(runner_jobs)의 관계.
 * - planning_jobs 한 행 = 화면이 보는 「초기 분석 PL-000」 또는 「차이 분석」 한 건. 단계·로그·실패 사유를 가진다.
 * - runner_jobs = Runner가 실제로 가져가 실행하는 한 번의 일. 기술 결정 확정·다시 시도·재분석 때마다 새로 만든다.
 *   payload.planningJobId로 Planning 작업을 가리키고, resumeStep(재개 단계)으로 어디서부터 할지 알려 준다(contracts §3.2 job 종류).
 * 팀장 API가 돌려주는 jobId는 Planning 작업 ID이고, Runner 보고 경로의 :jobId는 Runner job ID다.
 */

export type PlanningKind = 'bootstrap' | 'input_diff';
export interface PlanningJob { id: string; project_id: string; kind: PlanningKind; run_no: number; status: string; instruction: string }

export async function lockPlanningJob(db: Db, id: string): Promise<PlanningJob> {
  const job = (await db.query<PlanningJob>('select id,project_id,kind,run_no,status,instruction from planning_jobs where id=$1 for update', [id])).rows[0];
  if (!job) throw new ProjectError('NOT_FOUND', { details: { resource: 'planning_job', id } });
  return job;
}
/** 현재 초기 분석 작업. 프로젝트당 하나다(초기화하면 프로젝트와 함께 지워진다). */
export async function bootstrapJob(db: Db, projectId: string): Promise<PlanningJob | undefined> {
  return (await db.query<PlanningJob>(
    "select id,project_id,kind,run_no,status,instruction from planning_jobs where project_id=$1 and kind='bootstrap' order by record_no desc limit 1 for update", [projectId])).rows[0];
}

export async function steps(db: Db, jobId: string): Promise<Map<string, StepStatus>> {
  const rows = (await db.query<{ step_key: string; status: StepStatus }>('select step_key,status from planning_job_steps where job=$1', [jobId])).rows;
  return new Map(rows.map((row) => [row.step_key, row.status]));
}

export async function createPlanningJob(db: Db, input: { projectId: string; kind: PlanningKind; instruction: string; stepKeys: readonly string[] }): Promise<string> {
  const id = (await db.query<{ id: string }>(
    "insert into planning_jobs(project_id,kind,run_no,status,instruction) values($1,$2,1,'queued',$3) returning id", [input.projectId, input.kind, input.instruction])).rows[0]?.id;
  if (!id) throw new Error('Planning 작업 생성 실패');
  for (const key of input.stepKeys) {
    await db.query("insert into planning_job_steps(project_id,job,step_key,status,note) values($1,$2,$3,'wait','')", [input.projectId, id, key]);
  }
  return id;
}

/** 단계 하나의 상태를 바꾼다. 시작 시각은 처음 시작할 때, 끝 시각은 완료·실패 때 기록한다. */
export async function setStep(db: Db, jobId: string, key: string, status: StepStatus, note?: string): Promise<void> {
  await db.query(
    `update planning_job_steps set status=$3::step_status,note=coalesce($4,note),
       started_at=case when $3 in ('run','done','fail') then coalesce(started_at,clock_timestamp()) else null end,
       finished_at=case when $3 in ('done','fail') then clock_timestamp() else null end
     where job=$1 and step_key=$2`, [jobId, key, status, note ?? null]);
}
/** 단계를 처음 상태(대기)로 되돌린다. 다시 시도·재분석에서 쓴다. */
export async function resetSteps(db: Db, jobId: string, keys: readonly string[]): Promise<void> {
  await db.query("update planning_job_steps set status='wait',note='',started_at=null,finished_at=null where job=$1 and step_key=any($2::text[])", [jobId, keys]);
}
export async function log(db: Db, job: Pick<PlanningJob, 'id' | 'project_id'>, text: string): Promise<void> {
  await db.query('insert into planning_job_logs(project_id,job,at,text) values($1,$2,clock_timestamp(),$3)', [job.project_id, job.id, text]);
}

/** 진행 보고와 Runner 종료·만료가 같은 완료 판정을 쓴다. 이전 실행은 새 분석 상태를 바꾸지 못한다. */
export async function syncPlanningJob(db: Db, runnerId: string, state: string, error?: { code: string; message: string }): Promise<void> {
  if (!['done', 'failed', 'cancelled', 'reconcile', 'queued'].includes(state)) return;
  const runner = (await db.query<{ kind: string; payload: { planningJobId?: string } }>('select kind,payload from runner_jobs where id=$1', [runnerId])).rows[0];
  const id = runner?.payload.planningJobId;
  if (!id || !['bootstrap', 'input_diff'].includes(runner.kind)) return;
  const job = await lockPlanningJob(db, id);
  if (await currentRunnerJob(db, id) !== runnerId || job.status === 'done') return;
  const progress = await steps(db, id);
  // 사람의 결정을 기다릴 때는 Runner의 종료 이유와 관계없이 분석을 실패로 바꾸지 않는다.
  if (waitingForLead(job.kind, progress)) return;
  if (state === 'queued') {
    if (job.status === 'failed') {
      await db.query("update planning_jobs set status='queued',fail=null where id=$1", [id]);
      await changeEvent(db, job.project_id, { kind: 'planning_job', id }, 'planning');
    }
    return;
  }
  if (job.status === 'failed') return;
  if (state === 'done' && job.kind === 'input_diff' && INPUT_STEPS.every((key) => progress.get(key) === 'done')) {
    await db.query("update planning_jobs set status='done' where id=$1", [id]);
  } else {
    const reason = error?.message ?? (state === 'done' ? 'Runner가 필요한 분석 단계를 마치지 않고 종료했습니다.' : `Runner 작업이 ${state} 상태로 중단되었습니다.`);
    const fail = { reason, code: error?.code ?? (state === 'done' ? 'INCOMPLETE_ANALYSIS' : state.toUpperCase()), fix: 'Runner의 종료·외부 상태를 확인한 뒤 「다시 시도」를 누르세요.' };
    const keys: readonly string[] = job.kind === 'input_diff' ? INPUT_STEPS : BOOT_STEPS.filter((key) => !LEAD_STEPS.has(key));
    const failed = keys.find((key) => progress.get(key) === 'fail') ?? keys.find((key) => progress.get(key) === 'run') ?? keys.find((key) => progress.get(key) !== 'done');
    if (failed) await setStep(db, id, failed, 'fail', reason);
    await db.query("update planning_jobs set status='failed',fail=$2::jsonb where id=$1", [id, JSON.stringify(fail)]);
    await log(db, job, `분석 중단 — ${fail.code}: ${reason}`);
  }
  await changeEvent(db, job.project_id, { kind: 'planning_job', id }, 'planning');
}

/**
 * 같은 Planning 작업의 다음 Runner job을 현재 DB 입력으로 만든다.
 */
export async function followUpJob(db: Db, job: PlanningJob, epoch: number, change: { resumeStep: string | null; instruction?: string; base?: Record<string, unknown> }): Promise<string> {
  // 실행 순번은 M2-03이 만든 job의 n 중 최댓값 + 1이다. reconcile이 만든 job(숫자=fence)은 세지 않는다.
  const previous = (await db.query<{ n: string }>(
    `select coalesce(max((split_part(dedup_key,':',3))::int),0) n from runner_jobs
       where split_part(dedup_key,':',2)=$1 and split_part(dedup_key,':',1) in ('bootstrap','input_diff')`, [job.id])).rows[0];
  const count = Number(previous?.n ?? 0);
  // 재개는 최초 분석의 입력 버전을 유지한다. 첫 생성만 방금 고정한 입력 버전을 고른다.
  const original = (await db.query<{ payload: { version?: unknown } }>(
    "select payload from runner_jobs where payload->>'planningJobId'=$1 order by record_no limit 1", [job.id])).rows[0];
  const version = original?.payload.version;
  if (original && (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)) {
    throw new ProjectError('INVALID_TRANSITION', { message: '원래 분석의 입력 버전을 확인할 수 없습니다.' });
  }
  const input = (await db.query<{ v: number; commit_sha: string; previous: string | null }>(
    `select v,commit_sha,(select commit_sha from input_versions p where p.project_id=i.project_id and p.v=i.v-1) previous
     from input_versions i where project_id=$1 and ($2<>'bootstrap' or v=1) and ($3::int is null or v=$3) order by v desc limit 1`, [job.project_id, job.kind, version ?? null])).rows[0];
  if (!input || job.kind === 'input_diff' && !input.previous) throw new ProjectError('INVALID_TRANSITION', { message: '분석할 입력 버전과 이전 입력을 확인할 수 없습니다.' });
  const context = job.kind === 'input_diff' ? { wbs: await wbsSnapshot(db, job.project_id) } : {
    techConstraints: (await db.query('select id,name,level,condition from tech_constraints where project_id=$1 order by name,id', [job.project_id])).rows,
    subagentDefs: (await db.query('select distinct on (def_key) id,def_key as "defKey",version,agent,role from subagent_defs where allowed order by def_key,version desc')).rows,
    ...await techSnapshot(db, job.project_id),
  };
  const payload = { ...context, ...change.base, planningJobId: job.id, runNo: job.run_no, version: input.v, commit: input.commit_sha,
    previousCommit: input.previous, resumeStep: change.resumeStep, instruction: change.instruction ?? job.instruction };
  const id = await enqueueJob(db, { projectId: job.project_id, kind: job.kind, payload, epoch, dedupKey: `${job.kind}:${job.id}:${String(count + 1)}` });
  await syncPlanningJob(db, id, 'queued');
  return id;
}

/**
 * Planning 작업이 지금 받아야 할 Runner job(현재 실행).
 * 1. M2-03이 만든 job은 dedup_key `<종류>:<Planning ID>:<n>`의 n(실행 순번)을 1부터 차례로 받는다. n이 가장 큰 job이 출발점이다.
 * 2. M2-05 reconcile은 끊긴 job을 대신할 새 job을 `reconcile:<옛 job ID>:<fence>`로 만든다. 이 숫자는 fence라서
 *    실행 순번과 비교하지 않는다. 대신 「옛 job을 대체한 job」 관계를 따라가 마지막 대체 job을 현재 실행으로 본다(재리뷰 R2).
 * 시각 비교를 쓰지 않으므로 같은 트랜잭션·겹친 트랜잭션에서도 결과가 바뀌지 않는다.
 */
export async function currentRunnerJob(db: Db, planningJobId: string): Promise<string | undefined> {
  let current = (await db.query<{ id: string }>(
    `select id from runner_jobs where split_part(dedup_key,':',2)=$1 and split_part(dedup_key,':',1) in ('bootstrap','input_diff')
     order by (split_part(dedup_key,':',3))::int desc limit 1`, [planningJobId])).rows[0]?.id;
  for (let depth = 0; current && depth < 1000; depth++) {
    const replaced = (await db.query<{ id: string }>(
      "select id from runner_jobs where split_part(dedup_key,':',1)='reconcile' and split_part(dedup_key,':',2)=$1 order by (split_part(dedup_key,':',3))::int desc limit 1",
      [current])).rows[0]?.id;
    if (!replaced) break;
    current = replaced;
  }
  return current;
}

export async function jobView(db: Db, job: PlanningJob) {
  const stepRows = (await db.query<{ key: string; status: StepStatus; at: string | null; note: string | null }>(
    `select step_key as key,status,${iso('coalesce(finished_at,started_at)')} as at,note from planning_job_steps where job=$1`, [job.id])).rows;
  const fail = (await db.query<{ fail: { reason: string; fix: string } | null }>('select fail from planning_jobs where id=$1', [job.id])).rows[0]?.fail ?? null;
  const logs = (await db.query<{ at: string; text: string }>(`select ${iso('at')} as at,text from planning_job_logs where job=$1 order by record_no`, [job.id])).rows;
  return { jobId: job.id, runNo: job.run_no, status: job.status, stepRows, logs, fail };
}
