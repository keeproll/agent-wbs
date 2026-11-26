import type { PoolClient } from '@awbs/db';
import { ChangeBatch, emitChange, iso } from '../changes/events.ts';
import { decodeTimeIdCursor, encodeCursor, InputProblem } from '../changes/history.ts';
import { ApiError, assertSameVersion, invalid, isUuid } from '../changes/http.ts';
import { messageView, nextDelivery, pendingNextAtSend, type Delivery, type MessageAction, type MessageRow } from './state.ts';

/**
 * 메시지(G§4.10·§9.4): Task·시도에 연결된 작업 지시와 응답. 일반 채팅이 아니다.
 * 메시지는 공식 명세를 바꾸지 않는다 — 이 모듈은 Task 명세·관계·Task 버전을 건드리지 않는다(바꿀 일은 CP로, G§9.4-3).
 */

/**
 * Runner가 가져갈 수 있게 되는 전이(전송·재전송)와 Runner 조회가 함께 잡는 잠금.
 * 조회 커서는 (updated_at, id) 순서다. 이 잠금을 커밋까지 잡으면 「먼저 커밋된 것이 먼저 보인다」가 되어,
 * 시각이 같거나 늦게 커밋된 메시지를 커서가 건너뛰는 일(G의 since 방식 문제)을 막는다.
 */
const DELIVERY_LOCK = 'awbs:message-delivery';
const lockDelivery = (client: PoolClient) => client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [DELIVERY_LOCK]);

const COLUMNS = `m.id,m.msg_key,t.task_key,m.attempt,m.dir,m.type,m.to_agent,m.from_agent,m.body,m.delivery,m.pending_next,m.work_state,m.fail_reason,
  ${iso('m.read_at')} as read_at,${iso('m.created_at')} as created_at,${iso('m.updated_at')} as updated_at`;

interface Locked extends MessageRow { project_id: string; task: string }

const notFound = (id: string) => new ApiError('MESSAGE_NOT_FOUND', { messageId: id }, [], '메시지를 찾을 수 없습니다.');
const badState = (row: MessageRow, action: string) => new ApiError('INVALID_TRANSITION', { messageId: row.id, delivery: row.delivery },
  [], `지금 상태(${String(row.delivery)})에서는 ${action}할 수 없습니다.`, '메시지 목록을 다시 불러와 현재 상태를 확인하세요.');

export async function messageById(client: PoolClient, id: string): Promise<MessageRow | undefined> {
  if (!isUuid(id)) return undefined;
  return (await client.query<MessageRow>(`select ${COLUMNS} from messages m join tasks t on t.id=m.task where m.id=$1`, [id])).rows[0];
}

async function lockMessage(client: PoolClient, id: string): Promise<Locked> {
  if (!isUuid(id)) throw notFound(id);
  const row = (await client.query<Locked>(`select ${COLUMNS},m.project_id,m.task from messages m join tasks t on t.id=m.task where m.id=$1 for update of m`, [id])).rows[0];
  if (!row) throw notFound(id);
  return row;
}

/** 이력(추가 전용). 시각은 그 Task의 현재 버전보다 늦게 둔다(M2-02 `record`와 같은 규칙 — 충돌 창의 순서를 믿게 하려고). */
async function record(client: PoolClient, row: Locked, actor: string, text: string, before: string | null, after: string | null): Promise<void> {
  await client.query(
    `insert into task_history(project_id,at,actor,task,kind,text,before,after,ref)
     values($1,greatest(clock_timestamp(),(select updated_at+interval '1 microsecond' from tasks where id=$2)),$3,$2,'메시지',$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
    [row.project_id, row.task, actor, text, JSON.stringify(before), JSON.stringify(after), JSON.stringify({ id: row.id, msgKey: row.msg_key })],
  );
}

async function view(client: PoolClient, id: string) {
  const row = await messageById(client, id);
  if (!row) throw notFound(id);
  return messageView(row);
}

async function assertMessageVersion(client: PoolClient, row: MessageRow, expected: string): Promise<void> {
  await assertSameVersion(client, row.updated_at, expected, { current: messageView(row) });
}

/** 지정한 시도가 이 Task의 것인지. 아니면 null. */
async function attemptOf(client: PoolClient, task: string, attemptId: string): Promise<string | null> {
  if (!isUuid(attemptId)) return null;
  return (await client.query<{ id: string }>('select id from task_attempts where id=$1 and task=$2', [attemptId, task])).rows[0]?.id ?? null;
}

async function nextKey(client: PoolClient, projectId: string): Promise<string> {
  const value = (await client.query<{ value: number }>(
    `insert into counters(project_id,kind,value) values($1,'message',1)
     on conflict (project_id,kind) do update set value=counters.value+1 returning value::int as value`, [projectId],
  )).rows[0]?.value ?? 1;
  return `MSG-${String(value).padStart(3, '0')}`;
}

export interface DraftInput { taskKey: string; attemptId?: string; type: string; toAgent: string; body: string }

/** 초안 생성(서버 보존). 기존 행을 고치지 않으므로 버전 비교가 없다(contracts §1.3). */
export async function createDraft(client: PoolClient, input: DraftInput) {
  const task = (await client.query<{ id: string; project_id: string }>('select id,project_id from tasks where task_key=$1 and deleted_at is null', [input.taskKey])).rows[0];
  if (!task) throw new ApiError('TASK_NOT_FOUND', { taskKey: input.taskKey }, [], 'Task를 찾을 수 없습니다.');
  let attempt: string | null = null;
  if (input.attemptId !== undefined) {
    attempt = await attemptOf(client, task.id, input.attemptId);
    if (!attempt) throw new ApiError('ATTEMPT_NOT_FOUND', { attemptId: input.attemptId }, [], '이 Task의 실행 시도를 찾을 수 없습니다.');
  }
  const key = await nextKey(client, task.project_id);
  const id = (await client.query<{ id: string }>(
    `insert into messages(project_id,task,msg_key,attempt,dir,type,to_agent,body,delivery,pending_next,work_state,draft)
     values($1,$2,$3,$4,'out',$5,$6,$7,'Draft',false,'',true) returning id`,
    [task.project_id, task.id, key, attempt, input.type, input.toAgent, input.body],
  )).rows[0]?.id ?? '';
  await emitChange(client, task.project_id, 'message', { id });
  return view(client, id);
}

export interface DraftPatch { updatedAt: string; type?: string; toAgent?: string; body?: string; attemptId?: string | null }

export async function updateDraft(client: PoolClient, id: string, patch: DraftPatch) {
  const row = await lockMessage(client, id);
  await assertMessageVersion(client, row, patch.updatedAt);
  if (row.dir !== 'out' || !nextDelivery(row.delivery as Delivery, 'edit')) throw badState(row, '초안을 수정');
  let attempt = row.attempt;
  if (patch.attemptId !== undefined) {
    attempt = patch.attemptId === null ? null : await attemptOf(client, row.task, patch.attemptId);
    if (patch.attemptId !== null && !attempt) throw invalid([{ path: 'attemptId', rule: 'exists', message: '이 Task의 실행 시도가 아닙니다.' }]);
  }
  await client.query('update messages set type=$2,to_agent=$3,body=$4,attempt=$5 where id=$1',
    [id, patch.type ?? row.type, patch.toAgent ?? row.to_agent, patch.body ?? row.body, attempt]);
  await emitChange(client, row.project_id, 'message', { id });
  return view(client, id);
}

const LEAD = '팀장';
const ACTION_LABEL: Record<'send' | 'cancel' | 'resend', string> = { send: '전송', cancel: '취소', resend: '재전송' };

/** 전송·취소·재전송(팀장). 모두 `messages.updatedAt` 비교(contracts §1.3). */
export async function leadAction(client: PoolClient, id: string, action: 'send' | 'cancel' | 'resend', expected: string) {
  if (action !== 'cancel') await lockDelivery(client);
  const row = await lockMessage(client, id);
  await assertMessageVersion(client, row, expected);
  const next = row.dir === 'out' ? nextDelivery(row.delivery as Delivery, action) : null;
  if (!next) throw badState(row, ACTION_LABEL[action]);
  /** 지금 조건(Task 실행 중·실행 중 전달)으로 다음 실행 대기를 정한다. 전송과 재전송이 같은 판정을 쓴다(리뷰 지적 5). */
  const pendingNow = async () => {
    const running = (await client.query<{ running: boolean }>("select status in ('running','qa','verifying') as running from tasks where id=$1", [row.task])).rows[0]?.running ?? false;
    const live = (await client.query<{ live: boolean }>('select live_inject as live from exec_policy where singleton')).rows[0]?.live ?? false;
    return pendingNextAtSend({ taskRunning: running, liveInject: live });
  };
  if (action === 'send') {
    if (!row.body.trim()) throw invalid([{ path: 'body', rule: 'minLength', message: '보낼 내용을 입력하세요.' }]);
    const pending = await pendingNow();
    await client.query("update messages set delivery='Queued',draft=false,pending_next=$2 where id=$1", [id, pending]);
    await record(client, row, LEAD, `${row.msg_key} ${row.type} 전송 요청 → ${String(row.to_agent)}${pending ? ' (다음 실행 대기)' : ''}`, row.delivery, next);
  } else if (action === 'cancel') {
    await client.query("update messages set delivery='Cancelled',pending_next=false where id=$1", [id]);
    await record(client, row, LEAD, `${row.msg_key} 전송 취소`, row.delivery, next);
  } else {
    const pending = await pendingNow();
    await client.query("update messages set delivery='Queued',fail_reason=null,pending_next=$2 where id=$1", [id, pending]);
    await record(client, row, LEAD, `${row.msg_key} 재전송${pending ? ' (다음 실행 대기)' : ''}`, row.delivery, next);
  }
  await emitChange(client, row.project_id, 'message', { id });
  return view(client, id);
}

/** 읽음 표시. 내용·전달 상태를 바꾸지 않는 멱등 표시라 버전 비교가 없고 updatedAt도 오르지 않는다(contracts §1.3, 마이그레이션 0018). */
export async function markRead(client: PoolClient, id: string): Promise<void> {
  if (!isUuid(id)) throw notFound(id);
  const row = (await client.query<{ project_id: string; read_at: string | null }>('select project_id,read_at from messages where id=$1', [id])).rows[0];
  if (!row) throw notFound(id);
  if (row.read_at !== null) return;
  await client.query('update messages set read_at=now() where id=$1 and read_at is null', [id]);
  await emitChange(client, row.project_id, 'message', { id });
}

export const POLL_LIMIT = 100;

/**
 * Runner 조회(contracts §3.1). Runner가 가져갈 메시지(Queued·Sent)를 (updated_at, id) 순서로 커서 뒤부터 준다.
 * - 가져간 Queued는 Sent로 바꾼다. 이미 Sent인 것도 다시 준다(응답을 잃은 Runner가 같은 커서로 다시 물어도 빠지지 않게).
 * - 다음 커서는 이번에 훑은 위치(바꾸기 전 순서)다. 바꾼 뒤의 시각으로 커서를 옮기면, 한 번에 다 못 가져간 나머지를 건너뛴다.
 *   그래서 Sent로 바뀐 메시지가 다음 조회에 한 번 더 올 수 있다 — Runner는 id로 중복을 걸러 낸다(M4-01 수신함).
 * - 가져갈 것이 없으면 nextCursor는 null이다(Runner는 마지막 커서를 그대로 쓴다).
 */
export async function pollMessages(client: PoolClient, cursor: string | null, limit = POLL_LIMIT, since?: string) {
  await lockDelivery(client);
  const after = cursor === null ? null : decodeTimeIdCursor(cursor);
  if (cursor !== null && !after) throw new InputProblem('cursor', 'format', '메시지 커서가 올바르지 않습니다.');
  const values: unknown[] = [limit];
  let where = '';
  if (after) { values.push(after[0], after[1]); where = 'and (m.updated_at,m.id)>($2::timestamptz,$3::uuid)'; }
  else if (since !== undefined) { values.push(since); where = 'and m.updated_at>$2::timestamptz'; }
  const rows = (await client.query<Locked>(
    `select ${COLUMNS},m.project_id,m.task from messages m join tasks t on t.id=m.task
     where m.dir='out' and m.delivery in ('Queued','Sent') ${where} order by m.updated_at,m.id limit $1 for update of m`, values,
  )).rows;
  // 변경 이벤트 잠금은 모든 행을 바꾼 뒤 마지막에 잡는다(리뷰 지적 2와 같은 잠금 순서).
  const changes = new ChangeBatch();
  for (const row of rows.filter((item) => item.delivery === 'Queued')) {
    await client.query("update messages set delivery='Sent' where id=$1", [row.id]);
    changes.add(row.project_id, 'message', { id: row.id });
  }
  await changes.emit(client);
  const last = rows.at(-1);
  return {
    messages: rows.map((row) => ({
      id: row.id, taskKey: row.task_key, attemptId: row.attempt, toAgent: row.to_agent ?? '', type: row.type, body: row.body,
      pendingNext: row.pending_next, createdAt: row.created_at,
    })),
    nextCursor: last ? encodeCursor([last.updated_at, last.id]) : null,
  };
}

/** Runner가 받을 수 있는 메시지만 수신 확인·응답 대상이다. 초안·취소·들어온 메시지는 Runner에게 「없는」 메시지다. */
async function runnerMessage(client: PoolClient, id: string, action: MessageAction): Promise<Locked> {
  const row = await lockMessage(client, id);
  if (row.dir !== 'out' || !nextDelivery(row.delivery as Delivery, action)) throw notFound(id);
  return row;
}

/** 수신 확인(작업 완료 보고와 별개). 다음 실행 대기도 함께 푼다. 이미 확인한 것은 그대로다(204). */
export async function ackMessage(client: PoolClient, id: string): Promise<void> {
  const row = await runnerMessage(client, id, 'ack');
  if (row.delivery === 'Acknowledged') return;
  await client.query("update messages set delivery='Acknowledged',pending_next=false,fail_reason=null where id=$1", [id]);
  await record(client, row, 'Runner', `${row.msg_key} 수신 확인`, row.delivery, 'Acknowledged');
  await emitChange(client, row.project_id, 'message', { id });
}

/**
 * Agent 응답(전달 상태와 별개, G§9.4-1). 들어온 메시지(응답)로 쌓는다.
 * 응답은 Runner가 가져간 메시지(Sent·Acknowledged, 가져간 뒤 연결이 끊겨 실패로 표시된 Failed)에만 온다.
 */
export async function respondMessage(client: PoolClient, id: string, input: { text: string; workState: string }): Promise<void> {
  const row = await lockMessage(client, id);
  if (row.dir !== 'out' || !['Sent', 'Acknowledged', 'Failed'].includes(String(row.delivery))) throw notFound(id);
  const key = await nextKey(client, row.project_id);
  const reply = (await client.query<{ id: string }>(
    `insert into messages(project_id,task,msg_key,attempt,dir,type,from_agent,body,pending_next,work_state,draft)
     values($1,$2,$3,$4,'in','응답',$5,$6,false,$7,false) returning id`,
    [row.project_id, row.task, key, row.attempt, row.to_agent, input.text, input.workState],
  )).rows[0]?.id ?? '';
  await record(client, row, String(row.to_agent), `${row.msg_key} 응답 ${key}`, null, input.workState);
  await emitChange(client, row.project_id, 'message', { id: reply });
}

/**
 * 전달 실패 표시(서버 판정). Runner 연결이 끊긴 동안(heartbeat 누락) 대기열에 있던 메시지를 실패로 바꾼다.
 * 다음 실행 대기 메시지는 다음 실행 때 전달하므로 실패로 보지 않는다. 생존 감시(M2-05)가 부른다. 바꾼 건수를 돌려준다.
 */
export async function failUndelivered(client: PoolClient, reason: string): Promise<number> {
  await lockDelivery(client);
  const rows = (await client.query<Locked>(
    `select ${COLUMNS},m.project_id,m.task from messages m join tasks t on t.id=m.task
     where m.dir='out' and m.delivery in ('Queued','Sent') and not m.pending_next order by m.id for update of m`,
  )).rows;
  const changes = new ChangeBatch();
  for (const row of rows) {
    await client.query("update messages set delivery='Failed',fail_reason=$2 where id=$1", [row.id, reason]);
    await record(client, row, '시스템', `${row.msg_key} 전달 실패 — ${reason}`, row.delivery, 'Failed');
    changes.add(row.project_id, 'message', { id: row.id });
  }
  await changes.emit(client);
  return rows.length;
}

export const MESSAGE_PAGE = 50;

/** 목록(최신 먼저). taskId가 있으면 그 Task만. */
export async function listMessages(client: PoolClient, input: { taskId?: string | undefined; limit?: number | undefined; cursor?: string | undefined }) {
  const limit = Math.min(input.limit ?? MESSAGE_PAGE, 200);
  const after = input.cursor === undefined ? null : decodeTimeIdCursor(input.cursor);
  if (input.cursor !== undefined && !after) throw new InputProblem('cursor', 'format', '메시지 커서가 올바르지 않습니다.');
  const where: string[] = [];
  const values: unknown[] = [];
  if (input.taskId !== undefined) { values.push(input.taskId); where.push(`m.task=$${String(values.length)}::uuid`); }
  if (after) { values.push(after[0], after[1]); where.push(`(m.created_at,m.id)<($${String(values.length - 1)}::timestamptz,$${String(values.length)}::uuid)`); }
  values.push(limit + 1);
  const rows = (await client.query<MessageRow>(
    `select ${COLUMNS} from messages m join tasks t on t.id=m.task ${where.length ? `where ${where.join(' and ')}` : ''}
     order by m.created_at desc,m.id desc limit $${String(values.length)}`, values,
  )).rows;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: page.map(messageView), nextCursor: rows.length > limit && last ? encodeCursor([last.created_at, last.id]) : null };
}

/** 대시보드는 최근 목록의 일부가 아니라 확인이 필요한 메시지 전체를 보여 준다(P dashVM). */
export async function attentionMessages(client: PoolClient) {
  const rows = (await client.query<MessageRow>(`select ${COLUMNS} from messages m join tasks t on t.id=m.task
    where t.deleted_at is null and ((m.dir='out' and m.delivery in ('Failed','Queued')) or (m.dir='in' and m.read_at is null))
    order by m.created_at desc,m.id desc`)).rows;
  return rows.map(messageView);
}
