import type { PoolClient } from '@awbs/db';
import type { TaskStatus } from '@awbs/shared';
import { TaskError } from './errors.ts';
import { iso, publicDetail, taskDetail } from './read.ts';

/** 잠근 Task 행. updatedAt은 마이크로초까지 비교한다. */
export interface LockedTask { id: string; project_id: string; task_key: string; status: TaskStatus; updated_at: string; deleted_at: string | null }
export interface Change { field: string; before: unknown; after: unknown }

export { LEAD, SYSTEM, record, type HistoryInput } from './history.ts';

const LOCK_COLUMNS = `id,project_id,task_key,status,${iso('updated_at')} as updated_at,${iso('deleted_at')} as deleted_at`;

/** Task 행을 FOR UPDATE로 잠근다. 없거나 삭제된 Task는 404다. */
export async function lockTask(client: PoolClient, taskKey: string): Promise<LockedTask> {
  const task = (await client.query<LockedTask>(`select ${LOCK_COLUMNS} from tasks where task_key=$1 for update`, [taskKey])).rows[0];
  if (!task || task.deleted_at) throw new TaskError('TASK_NOT_FOUND', { taskKey });
  return task;
}

/** 여러 Task를 id 순서로 잠근다(data-model §5.1 잠금 순서). */
export async function lockTasks(client: PoolClient, taskKeys: readonly string[]): Promise<Map<string, LockedTask>> {
  const rows = (await client.query<LockedTask>(`select ${LOCK_COLUMNS} from tasks where task_key=any($1::text[]) order by id for update`, [taskKeys])).rows;
  return new Map(rows.filter((row) => !row.deleted_at).map((row) => [row.task_key, row]));
}

/** 관계 그래프(순환·차단·후속 판정)를 바꾸는 요청을 프로젝트 단위로 한 줄로 세운다(data-model §4). */
export async function lockGraph(client: PoolClient, projectId: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`awbs:task-graph:${projectId}`]);
}

/**
 * Timestamp 스키마는 모양(정규식)만 본다. `2026-02-30`처럼 달력에 없는 값이 DB 변환에서 500이 되지 않게
 * 날짜·시각이 실제로 있는지 왕복 변환으로 확인하고, DB가 받는 0001년 이상만 허용한다. 소수점 아래(µs)는 모양 검사로 충분하다.
 */
export function realTimestamp(value: string): boolean {
  const local = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d{1,6})?Z$/.exec(value)?.[1];
  // JS Date는 0000년을 받지만 PostgreSQL timestamptz는 이 ISO 표현의 0000년을 거부한다(기원전 1년).
  if (!local || local.startsWith('0000')) return false;
  const date = new Date(`${local}Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(local);
}

/** 화면이 본 버전과 다르면 409. 그 뒤에 쌓인 이력을 충돌 창에 보여 준다(contracts §1, G§0.3). */
export async function assertVersion(client: PoolClient, task: LockedTask, expected: string): Promise<void> {
  if (!realTimestamp(expected)) {
    throw new TaskError('VALIDATION_FAILED', {}, [{ path: 'updatedAt', rule: 'format', message: '달력에 없는 날짜·시각입니다.' }]);
  }
  const same = (await client.query<{ same: boolean }>('select $1::timestamptz=$2::timestamptz as same', [task.updated_at, expected])).rows[0]?.same;
  if (same) return;
  const history = await client.query<{ at: string; actor: string; kind: string; before: unknown; after: unknown; ref: { field?: string } | null }>(
    `select ${iso('at')} as at,actor,kind,before,after,ref from task_history where task=$1 and at>$2::timestamptz order by at,created_at`, [task.id, expected]);
  const current = await taskDetail(client, task.task_key);
  throw new TaskError('VERSION_CONFLICT', {
    current: current ? publicDetail(current) : null,
    changes: history.rows.map((row) => ({ at: row.at, actor: row.actor, field: row.ref?.field ?? row.kind, before: row.before, after: row.after })),
  });
}

/**
 * 완료·취소는 종료 상태다(Q-05, data-model §3.1). 완료 결과와 검증 당시 내용을 보존한다(data-model §4, G§5.2-1, D-20).
 * 취소 Task도 완료와 같이 내용·의존성·체크리스트 변경을 모두 거부한다(조정자 결정 2026-11-26). 조회·이력은 영향 없다.
 */
export const TERMINAL: readonly TaskStatus[] = ['done', 'cancelled'];
export function assertEditable(task: LockedTask): void {
  if (TERMINAL.includes(task.status)) {
    throw new TaskError('INVALID_TRANSITION', { taskKey: task.task_key, status: task.status },
      [], '완료·취소된 Task는 내용을 바꾸거나 지울 수 없습니다. 바꿀 내용은 새 Task나 변경 제안으로 처리하세요.');
  }
}

export async function changeEvent(client: PoolClient, projectId: string, topic: 'task' | 'dependency', ref: Record<string, unknown>): Promise<void> {
  await client.query('insert into change_events(project_id,topic,ref) values($1,$2,$3::jsonb)', [projectId, topic, JSON.stringify(ref)]);
}

/** 명세·설계·체크리스트·산출물·관계 변경도 Task 버전을 올린다(contracts §1.3). 갱신 트리거가 단조 증가를 보장한다. */
export async function touch(client: PoolClient, task: LockedTask): Promise<void> {
  await client.query('update tasks set updated_at=clock_timestamp() where id=$1', [task.id]);
  await changeEvent(client, task.project_id, 'task', { taskKey: task.task_key });
}

/** 같은 Task 안에서 재사용하지 않는 체크리스트 번호(P `CL-0005-1`). 기존 항목 번호보다 항상 크다. */
export async function nextChecklistKey(client: PoolClient, task: Pick<LockedTask, 'id' | 'project_id' | 'task_key'>): Promise<string> {
  const value = (await client.query<{ value: number }>(
    `insert into counters(project_id,kind,value)
     values($1,$2,(select coalesce(max((substring(item_key from '-([0-9]+)$'))::bigint),0)+1 from checklist_items where task=$3))
     on conflict (project_id,kind) do update set value=counters.value+1 returning value::int as value`,
    [task.project_id, `checklist:${task.task_key}`, task.id],
  )).rows[0]?.value;
  return `CL-${task.task_key.slice(5)}-${String(value)}`;
}

export async function changed(client: PoolClient, task: LockedTask, changes: Change[]) {
  const detail = await taskDetail(client, task.task_key);
  if (!detail) throw new TaskError('TASK_NOT_FOUND', { taskKey: task.task_key });
  return { task: publicDetail(detail), changes };
}
