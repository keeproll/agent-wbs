import type { PoolClient } from '@awbs/db';
import type { TaskStatus } from '@awbs/shared';
import { isTimestamp } from '@awbs/shared/api';
import { TaskError } from './errors.ts';
import { publicDetail, taskDetail } from './read.ts';
// iso는 import 순환(read → gate → project/service → write)에서도 모듈 로드 때 바로 쓰이므로 의존이 없는 events.ts에서 가져온다.
import { deferChange, iso } from '../changes/events.ts';

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

export const TIMESTAMP_MESSAGE = '달력에 없거나 허용 범위(1970~9999년) 밖의 시각입니다.';

/** 화면이 본 버전과 다르면 409. 그 뒤에 쌓인 이력을 충돌 창에 보여 준다(contracts §1, G§0.3). */
export async function assertVersion(client: PoolClient, task: LockedTask, expected: string): Promise<void> {
  // 공통 Timestamp 규칙(1970~9999년의 실재하는 UTC 시각, shared api `isTimestamp`)을 그대로 쓴다.
  if (!isTimestamp(expected)) {
    throw new TaskError('VALIDATION_FAILED', {}, [{ path: 'updatedAt', rule: 'format', message: TIMESTAMP_MESSAGE }]);
  }
  const same = (await client.query<{ same: boolean }>('select $1::timestamptz=$2::timestamptz as same', [task.updated_at, expected])).rows[0]?.same;
  if (same) return;
  const history = await client.query<{ at: string; actor: string; kind: string; before: unknown; after: unknown; ref: { field?: string } | null }>(
    `select ${iso('at')} as at,actor,kind,before,after,ref from task_history where task=$1 and at>$2::timestamptz order by record_no`, [task.id, expected]);
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

/** 변경 이벤트는 공통 규칙(changes/events.ts)으로 커밋 직전에 쓴다. 그 자리에서 잠그면 뒤의 Task 잠금과 교착할 수 있다. */
export function changeEvent(client: PoolClient, projectId: string, topic: 'task' | 'dependency', ref: Record<string, unknown>): Promise<void> {
  deferChange(client, projectId, topic, ref);
  return Promise.resolve();
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
