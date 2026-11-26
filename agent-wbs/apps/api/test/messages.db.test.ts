// M2-08 메시지(G§4.10·§9.4, data-model §3.3, contracts §2.1·§3.1) — 실제 PostgreSQL.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { failUndelivered, pollMessages } from '../src/messages/service.ts';
import { inEpoch } from '../src/platform/transaction.ts';
import { attemptFor, harness, projectWith, type Harness, type ProjectFixture } from './m208-fixture.ts';

let h: Harness;
let f: ProjectFixture;
beforeAll(async () => {
  h = await harness('m208_messages');
  f = await projectWith(h.owner, ['ready', 'running', 'ready']);
});
afterAll(async () => { await h.close(); });

const draft = (body = '추가로 오류 메시지를 한글로 바꿔 주세요.', extra: Record<string, unknown> = {}) =>
  h.lead('POST', '/api/messages', { taskKey: 'TASK-0001', type: '추가 지시', toAgent: 'Claude', body, ...extra });
const send = (id: string, updatedAt: string) => h.lead('POST', `/api/messages/${id}/send`, { updatedAt });
const taskVersion = async (key: string) => (await h.owner.query<{ v: string }>("select updated_at::text as v from tasks where task_key=$1", [key])).rows[0]?.v;
const history = async (text: string) => (await h.owner.query<{ actor: string; before: unknown; after: unknown }>('select actor,before,after from task_history where text like $1 order by at', [`%${text}%`])).rows;

describe('팀장 메시지 초안·전송·취소', () => {
  test('초안 생성은 서버에 보존되고 공식 명세(Task 버전)를 바꾸지 않는다', async () => {
    const before = await taskVersion('TASK-0001');
    const res = await draft();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ msgKey: 'MSG-001', taskKey: 'TASK-0001', dir: 'out', delivery: 'Draft', pendingNext: false, workState: null, attemptId: null });
    expect(await taskVersion('TASK-0001')).toBe(before);
    const events = (await h.owner.query("select ref from change_events where topic='message'")).rows;
    expect(events).toContainEqual({ ref: { id: res.body.id } });
    expect((await draft('두 번째')).body.msgKey).toBe('MSG-002');
  });

  test('없는 Task 404, 다른 Task의 시도 지정은 404 ATTEMPT_NOT_FOUND', async () => {
    expect((await h.lead('POST', '/api/messages', { taskKey: 'TASK-9999', type: '질문', toAgent: 'Codex', body: 'x' })).body.error.code).toBe('TASK_NOT_FOUND');
    const other = await attemptFor(h.owner, f.project, f.tasks['TASK-0002'] ?? '', { status: 'running' });
    expect((await draft('x', { attemptId: other })).body.error.code).toBe('ATTEMPT_NOT_FOUND');
    expect((await draft('x', { attemptId: 'not-a-uuid' })).body.error.code).toBe('ATTEMPT_NOT_FOUND');
  });

  test('초안 수정은 버전 비교, 전송 뒤에는 409 INVALID_TRANSITION', async () => {
    const created = (await draft('처음')).body;
    const stale = created.updatedAt;
    const edited = await h.lead('PATCH', `/api/messages/${created.id}`, { updatedAt: created.updatedAt, body: '고친 본문', type: '질문' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ body: '고친 본문', type: '질문', delivery: 'Draft' });
    expect((await h.lead('PATCH', `/api/messages/${created.id}`, { updatedAt: stale, body: '낡은 화면' })).body.error.code).toBe('VERSION_CONFLICT');
    expect((await h.lead('PATCH', `/api/messages/${created.id}`, { updatedAt: edited.body.updatedAt, attemptId: 'nope' })).status).toBe(400);
    const sent = await send(created.id, edited.body.updatedAt);
    expect(sent.body.delivery).toBe('Queued');
    expect((await h.lead('PATCH', `/api/messages/${created.id}`, { updatedAt: sent.body.updatedAt, body: '전송 뒤 수정' })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await send(created.id, sent.body.updatedAt)).body.error.code).toBe('INVALID_TRANSITION');
    expect(await history(`${String(created.msgKey)} 질문 전송 요청`)).toEqual([{ actor: '팀장', before: 'Draft', after: 'Queued' }]);
  });

  test('빈 본문은 전송 거부(400), 모르는 필드도 거부', async () => {
    const created = (await draft('   ')).body;
    expect((await send(created.id, created.updatedAt)).body.error).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'body' }] });
    expect((await h.lead('PATCH', `/api/messages/${created.id}`, { updatedAt: created.updatedAt, status: 'Sent' })).status).toBe(400);
  });

  test('실행 중 Task + 실행 중 전달 꺼짐 → 다음 실행 대기, 켜짐 → 바로 대기열', async () => {
    const mk = async () => (await h.lead('POST', '/api/messages', { taskKey: 'TASK-0002', type: '수정 요청', toAgent: 'Claude', body: 'b' })).body;
    await h.owner.query('update exec_policy set live_inject=false');
    const a = await mk();
    expect((await send(a.id, a.updatedAt)).body).toMatchObject({ delivery: 'Queued', pendingNext: true });
    await h.owner.query('update exec_policy set live_inject=true');
    const b = await mk();
    expect((await send(b.id, b.updatedAt)).body).toMatchObject({ delivery: 'Queued', pendingNext: false });
  });

  test('취소는 Draft/Queued만, Runner가 가져간 뒤(Sent)는 409', async () => {
    const d = (await draft('취소할 초안')).body;
    expect((await h.lead('POST', `/api/messages/${d.id}/cancel`, { updatedAt: d.updatedAt })).body.delivery).toBe('Cancelled');
    const q = (await draft('보낸 뒤 취소')).body;
    const queued = (await send(q.id, q.updatedAt)).body;
    await h.runner('GET', '/api/runner/messages');
    const current = (await h.lead('GET', '/api/messages?taskKey=TASK-0001&limit=200')).body.items.find((m: { id: string }) => m.id === q.id);
    expect(current.delivery).toBe('Sent');
    expect((await h.lead('POST', `/api/messages/${q.id}/cancel`, { updatedAt: current.updatedAt })).body.error.code).toBe('INVALID_TRANSITION');
    expect(queued.updatedAt).not.toBe(current.updatedAt);
  });
});

describe('Runner 조회·수신 확인·응답', () => {
  beforeEach(async () => {
    // 앞 테스트의 대기 메시지를 정리해 이 묶음이 자기 메시지만 보게 한다.
    await h.owner.query("update messages set delivery='Acknowledged' where delivery in ('Queued','Sent')");
  });

  test('대기열의 메시지를 가져가며 Sent로 바꾸고, 초안·취소는 보내지 않는다', async () => {
    const a = (await draft('A')).body;
    await send(a.id, a.updatedAt);
    const b = (await draft('B')).body;
    await send(b.id, b.updatedAt);
    await draft('초안은 안 감');
    const res = await h.runner('GET', '/api/runner/messages');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.messages.map((m: { body: string }) => m.body)).toEqual(['A', 'B']);
    expect(res.body.messages[0]).toEqual({ id: a.id, taskKey: 'TASK-0001', attemptId: null, toAgent: 'Claude', type: '추가 지시', body: 'A', pendingNext: false, createdAt: a.createdAt });
    expect(res.body.nextCursor).toEqual(expect.any(String));
    // 응답을 잃은 Runner가 같은 커서로 다시 물어도 빠지지 않는다(이미 Sent여도 다시 준다).
    const again = await h.runner('GET', `/api/runner/messages?cursor=${String(res.body.nextCursor)}`);
    expect(again.body.messages.map((m: { body: string }) => m.body)).toEqual(['A', 'B']);
    const idle = await h.runner('GET', `/api/runner/messages?cursor=${String(again.body.nextCursor)}`);
    expect(idle.body).toEqual({ messages: [], nextCursor: null });
  });

  test('한 번에 다 못 가져가도(페이지) 빠지는 메시지가 없다', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = (await draft(`P${String(i)}`)).body;
      await send(m.id, m.updatedAt);
      ids.push(m.id);
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let round = 0; round < 10; round++) {
      const page = await inEpoch(h.pool, 1, (client) => pollMessages(client, cursor, 2));
      page.messages.forEach((m) => seen.add(m.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(ids.every((id) => seen.has(id))).toBe(true);
  });

  test('수신 확인은 Acknowledged·다음 실행 대기 해제, 재확인은 그대로 204, 받을 수 없는 메시지는 404', async () => {
    const m = (await h.lead('POST', '/api/messages', { taskKey: 'TASK-0002', type: '수정 요청', toAgent: 'Claude', body: 'pending' })).body;
    await h.owner.query('update exec_policy set live_inject=false');
    await send(m.id, m.updatedAt);
    expect((await h.runner('POST', `/api/runner/messages/${String(m.id)}/ack`)).status).toBe(204);
    const row = (await h.owner.query<{ delivery: string; pending_next: boolean }>('select delivery,pending_next from messages where id=$1', [m.id])).rows[0];
    expect(row).toEqual({ delivery: 'Acknowledged', pending_next: false });
    expect((await h.runner('POST', `/api/runner/messages/${String(m.id)}/ack`)).status).toBe(204);
    expect(await history(`${String(m.msgKey)} 수신 확인`)).toEqual([{ actor: 'Runner', before: 'Queued', after: 'Acknowledged' }]);
    const d = (await draft('초안')).body;
    expect((await h.runner('POST', `/api/runner/messages/${String(d.id)}/ack`)).body.error.code).toBe('MESSAGE_NOT_FOUND');
    expect((await h.runner('POST', `/api/runner/messages/${crypto.randomUUID()}/ack`)).body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  test('Agent 응답은 들어온 메시지로 따로 쌓이고 원래 메시지의 전달 상태를 바꾸지 않는다. 읽음은 updatedAt을 올리지 않는다', async () => {
    const m = (await draft('질문입니다')).body;
    await send(m.id, m.updatedAt);
    expect((await h.runner('POST', `/api/runner/messages/${String(m.id)}/response`, { text: '가져가기 전', workState: 'x' })).body.error.code).toBe('MESSAGE_NOT_FOUND');
    await h.runner('GET', '/api/runner/messages');
    const res = await h.runner('POST', `/api/runner/messages/${String(m.id)}/response`, { text: '확인했습니다.', workState: '다음 결과 보고에 포함' });
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    const list = (await h.lead('GET', '/api/tasks/TASK-0001/messages?limit=200')).body.items as { id: string; dir: string; delivery: string | null; workState: string | null; body: string; type: string; readAt: string | null; updatedAt: string }[];
    const reply = list.find((x) => x.dir === 'in' && x.body === '확인했습니다.');
    expect(reply).toMatchObject({ type: '응답', delivery: null, workState: '다음 결과 보고에 포함', readAt: null });
    expect(list.find((x) => x.id === m.id)?.delivery).toBe('Sent');
    expect((await h.lead('POST', `/api/messages/${String(reply?.id)}/read`)).status).toBe(204);
    const after = (await h.lead('GET', '/api/tasks/TASK-0001/messages?limit=200')).body.items.find((x: { id: string }) => x.id === reply?.id);
    expect(after.readAt).toEqual(expect.any(String));
    expect(after.updatedAt).toBe(reply?.updatedAt);
    const eventsBefore = (await h.owner.query("select count(*)::int as n from change_events where topic='message'")).rows[0]?.n;
    expect((await h.lead('POST', `/api/messages/${String(reply?.id)}/read`)).status).toBe(204);
    expect((await h.owner.query("select count(*)::int as n from change_events where topic='message'")).rows[0]?.n).toBe(eventsBefore);
    const twice = (await h.lead('GET', '/api/tasks/TASK-0001/messages?limit=200')).body.items.find((x: { id: string }) => x.id === reply?.id);
    expect(twice.readAt).toBe(after.readAt);
    const d = (await draft('초안')).body;
    expect((await h.runner('POST', `/api/runner/messages/${String(d.id)}/response`, { text: 'x', workState: 'y' })).body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  test('전달 실패 → 재전송: 실패 사유를 남기고, 재전송하면 사유를 지우고 다시 대기열', async () => {
    const m = (await draft('실패할 메시지')).body;
    await send(m.id, m.updatedAt);
    // 다음 실행 대기 메시지는 연결이 끊겨도 실패가 아니다(다음 실행 때 전달).
    await h.owner.query('update exec_policy set live_inject=false');
    const waiting = (await h.lead('POST', '/api/messages', { taskKey: 'TASK-0002', type: '수정 요청', toAgent: 'Claude', body: '대기' })).body;
    expect((await send(waiting.id, waiting.updatedAt)).body.pendingNext).toBe(true);
    const count = await inEpoch(h.pool, 1, (client) => failUndelivered(client, 'Runner 연결 불가 — heartbeat 응답 없음'));
    expect(count).toBeGreaterThanOrEqual(1);
    const failed = (await h.lead('GET', '/api/messages?taskKey=TASK-0001&limit=200')).body.items.find((x: { id: string }) => x.id === m.id);
    expect(failed).toMatchObject({ delivery: 'Failed', failReason: 'Runner 연결 불가 — heartbeat 응답 없음' });
    expect((await h.owner.query<{ delivery: string }>('select delivery from messages where id=$1', [waiting.id])).rows[0]?.delivery).toBe('Queued');
    const resent = await h.lead('POST', `/api/messages/${String(m.id)}/resend`, { updatedAt: failed.updatedAt });
    expect(resent.body).toMatchObject({ delivery: 'Queued', failReason: null });
    expect(await history(`${String(m.msgKey)} 재전송`)).toEqual([{ actor: '팀장', before: 'Failed', after: 'Queued' }]);
    expect(await history(`${String(m.msgKey)} 전달 실패`)).toEqual([{ actor: '시스템', before: 'Queued', after: 'Failed' }]);
  });
});

describe('목록', () => {
  test('taskKey 필터와 커서, Task 탭은 없는 Task 404', async () => {
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { items: { id: string; taskKey: string }[]; nextCursor: string | null } } = await h.lead('GET', `/api/messages?taskKey=TASK-0001&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.body.items.every((m) => m.taskKey === 'TASK-0001')).toBe(true);
      all.push(...res.body.items.map((m) => m.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    const total = (await h.owner.query<{ n: number }>("select count(*)::int as n from messages m join tasks t on t.id=m.task where t.task_key='TASK-0001'")).rows[0]?.n;
    expect(new Set(all).size).toBe(total);
    expect((await h.lead('GET', '/api/tasks/TASK-9999/messages')).body.error.code).toBe('TASK_NOT_FOUND');
    expect((await h.lead('GET', '/api/messages?cursor=bad!')).status).toBe(400);
  });
});
