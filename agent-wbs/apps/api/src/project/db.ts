import type { PoolClient } from '@awbs/db';
import { ProjectError } from './errors.ts';

export type Db = Pick<PoolClient, 'query'>;

/** timestamptz를 계약의 UTC ISO 8601(µs까지) 문자열로 읽는다. */
export const iso = (column: string) => `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const LEAD = '팀장';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 경로·본문의 ID는 불투명 문자열이다. uuid 모양이 아니면 DB에 묻지 않고 「없음」으로 본다. */
export const isUuid = (value: string) => UUID.test(value);

export async function systemState(db: Db): Promise<{ epoch: number; cleanup: 'none' | 'pending' | 'running' | 'failed' }> {
  const row = (await db.query<{ epoch: number; cleanup: 'none' | 'pending' | 'running' | 'failed' }>('select epoch,cleanup_status as cleanup from system_state where id=1')).rows[0];
  if (!row) throw new Error('system_state 초기값이 없습니다.');
  return row;
}
/** 초기화 뒤 Runner 정리가 끝나기 전에는 새 등록·분석을 시작하지 않는다(G§4.2 ③, data-model §3.4). */
export async function assertCleanupDone(db: Db): Promise<void> {
  if ((await systemState(db)).cleanup !== 'none') throw new ProjectError('CLEANUP_PENDING');
}

export interface ProjectRow {
  id: string; name: string; phase: 'boot' | 'active'; base_commit: string | null; updated_at: string; lead_instruction: string;
}
/** 프로젝트 행을 잠근다. 같은 프로젝트를 바꾸는 요청은 이 잠금으로 한 줄로 선다. */
export async function lockProject(db: Db): Promise<ProjectRow | undefined> {
  return (await db.query<ProjectRow>(`select id,name,phase,base_commit,${iso('updated_at')} as updated_at,lead_instruction from projects for update`)).rows[0];
}
export async function requireProject(db: Db): Promise<ProjectRow> {
  const project = await lockProject(db);
  if (!project) throw new ProjectError('INVALID_TRANSITION', { message: '등록된 프로젝트가 없습니다.' });
  return project;
}
/** 팀장 수정의 버전 비교(contracts §1.3). µs까지 같아야 한다. */
export async function sameTime(db: Db, a: string, b: string): Promise<boolean> {
  return (await db.query<{ same: boolean }>('select $1::timestamptz=$2::timestamptz as same', [a, b])).rows[0]?.same ?? false;
}
export async function touchProject(db: Db, projectId: string): Promise<void> {
  await db.query('update projects set updated_at=clock_timestamp() where id=$1', [projectId]);
  await changeEvent(db, projectId, { kind: 'project' });
}
export async function changeEvent(db: Db, projectId: string | null, ref: Record<string, unknown>, topic = 'project'): Promise<void> {
  await db.query('insert into change_events(project_id,topic,ref) values($1,$2,$3::jsonb)', [projectId, topic, JSON.stringify(ref)]);
}

/** 재사용하지 않는 표시 번호(data-model §1). 기존 행의 최대 번호보다 항상 크게 시작한다. */
export async function nextNumber(db: Db, projectId: string, kind: string, existingMax: string): Promise<number> {
  const value = (await db.query<{ value: number }>(
    `insert into counters(project_id,kind,value) values($1,$2,(${existingMax})+1)
     on conflict (project_id,kind) do update set value=counters.value+1 returning value::int as value`, [projectId, kind])).rows[0]?.value;
  if (!value) throw new Error('번호 발급 실패');
  return value;
}

export interface JobRow { id: string; kind: string; payload: Record<string, unknown>; project_id: string | null; fence: number }
/**
 * Runner 보고의 fence 대조(contracts §3.2-4). 지금 이 Runner가 임대 중인 job의 현재 fence만 받는다.
 * claim·renew·finish는 M2-05 범위이고, 여기서는 같은 규칙으로 「보고를 받아도 되는가」만 판정한다.
 */
export async function leasedJob(db: Db, where: { id?: string; repoCheckId?: string }, kinds: readonly string[], fence: number, principal: string): Promise<JobRow> {
  const job = where.id !== undefined
    ? isUuid(where.id) ? (await db.query<JobRow & { state: string; lease_owner: string | null; live: boolean }>(
      'select id,kind,payload,project_id,fence,state,lease_owner,coalesce(lease_until>clock_timestamp(),false) live from runner_jobs where id=$1 for update', [where.id])).rows[0] : undefined
    : (await db.query<JobRow & { state: string; lease_owner: string | null; live: boolean }>(
      `select id,kind,payload,project_id,fence,state,lease_owner,coalesce(lease_until>clock_timestamp(),false) live from runner_jobs
       where kind='repo_check' and payload->>'repoCheckId'=$1 order by created_at desc limit 1 for update`, [where.repoCheckId])).rows[0];
  if (!job || !kinds.includes(job.kind)) throw new ProjectError('NOT_FOUND', { details: { resource: 'runner_job', id: where.id ?? where.repoCheckId } });
  if (job.fence !== fence || job.lease_owner !== principal || !['leased', 'started'].includes(job.state) || !job.live) throw new ProjectError('LEASE_LOST');
  return { id: job.id, kind: job.kind, payload: job.payload, project_id: job.project_id, fence: job.fence };
}

/** Runner가 가져갈 job을 대기열에 넣는다. 같은 Planning 작업의 n번째 job이라는 이름으로 중복을 막는다. */
export async function enqueueJob(db: Db, input: { projectId: string | null; kind: string; payload: Record<string, unknown>; epoch: number; dedupKey: string }): Promise<string> {
  const id = (await db.query<{ id: string }>(
    "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,$2,$3::jsonb,'queued',$4,$5) returning id",
    [input.projectId, input.kind, JSON.stringify(input.payload), input.epoch, input.dedupKey])).rows[0]?.id;
  if (!id) throw new Error('job 생성 실패');
  return id;
}
