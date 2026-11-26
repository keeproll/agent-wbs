// M2-08 변경 이벤트(contracts §7)·이력(G§4.9) — 실제 PostgreSQL.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { emitChange, pruneChanges } from '../src/changes/events.ts';
import { inEpoch } from '../src/platform/transaction.ts';
import { harness, projectWith, type Harness, type ProjectFixture } from './m208-fixture.ts';

let h: Harness;
let f: ProjectFixture;
beforeAll(async () => {
  h = await harness('m208_changes');
  f = await projectWith(h.owner, ['planning', 'ready']);
});
afterAll(async () => { await h.close(); });

const emit = (topic: Parameters<typeof emitChange>[2], ref: Parameters<typeof emitChange>[3]) =>
  inEpoch(h.pool, 1, (client) => emitChange(client, f.project, topic, ref));

describe('GET /api/changes', () => {
  test('커서 뒤 이벤트를 seq 순서로 limit만큼, ref는 문자열로', async () => {
    await h.owner.query('delete from change_events where false');
    const start = (await h.lead('GET', '/api/changes?after=0&limit=500')).body.next as number;
    await emit('task', { taskKey: 'TASK-0001' });
    await emit('message', { id: 'abc' });
    await emit('settings', 'exec-policy');
    const first = await h.lead('GET', `/api/changes?after=${String(start)}&limit=2`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.reset).toBe(false);
    expect(first.body.events.map((e: { topic: string; ref: string }) => [e.topic, e.ref])).toEqual([['task', 'TASK-0001'], ['message', 'abc']]);
    const second = await h.lead('GET', `/api/changes?after=${String(first.body.next)}`);
    expect(second.body.events.map((e: { ref: string }) => e.ref)).toEqual(['exec-policy']);
    const idle = await h.lead('GET', `/api/changes?after=${String(second.body.next)}`);
    expect(idle.body).toEqual({ events: [], next: second.body.next, reset: false });
  });

  test('보존 기간(7일)이 지나 커서 행이 정리되면 reset:true', async () => {
    const old = (await h.owner.query<{ seq: string }>(
      "insert into change_events(project_id,topic,ref,at) values($1,'task','\"TASK-0002\"',now()-interval '8 days') returning seq", [f.project])).rows[0]?.seq;
    await emit('task', { taskKey: 'TASK-0002' });
    expect(await pruneChanges(h.pool)).toBeGreaterThanOrEqual(1);
    const res = await h.lead('GET', `/api/changes?after=${String(old)}`);
    expect(res.body.reset).toBe(true);
    expect(res.body.events).toEqual([]);
    const again = await h.lead('GET', `/api/changes?after=${String(res.body.next)}`);
    expect(again.body.reset).toBe(false);
  });

  test('번호가 비는 것(취소된 트랜잭션)은 reset이 아니다', async () => {
    const base = (await h.lead('GET', '/api/changes?after=0&limit=500')).body;
    const last = base.events.at(-1).seq as number;
    await inEpoch(h.pool, 1, async (client) => { await emitChange(client, f.project, 'task', 'x'); throw Object.assign(new Error('rollback'), { code: 'X' }); }).catch(() => undefined);
    await emit('task', { taskKey: 'TASK-0001' });
    const res = await h.lead('GET', `/api/changes?after=${String(last)}`);
    expect(res.body.reset).toBe(false);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].seq).toBeGreaterThan(last + 1);
  });

  test('먼저 번호를 받은 쓰기가 커밋할 때까지 다음 쓰기는 기다린다(seq 순서 = 커밋 순서)', async () => {
    const a = await h.pool.connect();
    const b = await h.pool.connect();
    try {
      await a.query('begin');
      await emitChange(a, f.project, 'task', 'first');
      await b.query('begin');
      let bDone = false;
      const pending = emitChange(b, f.project, 'task', 'second').then(() => { bDone = true; });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(bDone).toBe(false);
      await a.query('commit');
      await pending;
      await b.query('commit');
      const rows = (await h.owner.query<{ ref: string }>("select ref from change_events where ref in ('\"first\"','\"second\"') order by seq")).rows;
      expect(rows.map((r) => r.ref)).toEqual(['first', 'second']);
    } finally { a.release(); b.release(); }
  });

  test('입력 검증: after 누락·음수·limit 초과는 400, 로그인 없으면 401', async () => {
    expect((await h.lead('GET', '/api/changes')).status).toBe(400);
    expect((await h.lead('GET', '/api/changes?after=-1')).status).toBe(400);
    expect((await h.lead('GET', '/api/changes?after=0&limit=501')).status).toBe(400);
    expect((await h.app.inject({ url: '/api/changes?after=0' })).statusCode).toBe(401);
  });

  test('초기화로 표가 비면 reset:true, next=0', async () => {
    const before = (await h.lead('GET', '/api/changes?after=0&limit=500')).body;
    const last = before.events.at(-1).seq as number;
    await h.owner.query("select public.reset_project(1,'m208',true,'lead')");
    const res = await h.lead('GET', `/api/changes?after=${String(last)}`);
    expect(res.body).toEqual({ events: [], next: 0, reset: true });
  });
});

describe('이력 GET /api/history · /api/tasks/:taskKey/history', () => {
  let p: ProjectFixture;
  beforeAll(async () => {
    p = await projectWith(h.owner, ['planning', 'ready']);
    const rows: [string, string, string, string][] = [
      // [task, actor, kind, at(UTC)]
      ['TASK-0001', '팀장', '실행 등급', '2026-11-24T14:59:59Z'], // 서울 11-24 23:59:59
      ['TASK-0001', 'Planning Agent', '실행 등급', '2026-11-24T15:00:00Z'], // 서울 11-25 00:00
      ['TASK-0002', '팀장', '상태', '2026-11-25T10:00:00Z'],
      ['TASK-0001', '팀장', '상태', '2026-11-25T14:59:59Z'], // 서울 11-25 23:59:59
      ['TASK-0002', '팀장', '실행 등급', '2026-11-25T15:00:00Z'], // 서울 11-26
    ];
    for (const [task, actor, kind, at] of rows) {
      await h.owner.query("insert into task_history(project_id,at,actor,task,kind,text,before,after,ref) values($1,$2,$3,$4,$5,'t','\"a\"',$6::jsonb,$7::jsonb)",
        [p.project, at, actor, p.tasks[task], kind, JSON.stringify({ modelId: 'm', effort: 'high' }), JSON.stringify({ taskKey: task })]);
    }
    // 같은 시각의 이력 여러 건: 커서가 시각만 보면 페이지 경계에서 빠진다(id로 순서 고정이 필요).
    for (let i = 0; i < 6; i++) {
      await h.owner.query("insert into task_history(project_id,at,actor,task,kind,text) values($1,'2026-11-20T00:00:00Z','시스템',$2,'동시각','t')", [p.project, p.tasks['TASK-0001']]);
    }
  });

  test('기간(서울 날짜)·주체·유형 필터와 변경 전/후 문자열', async () => {
    const res = await h.lead('GET', '/api/history?from=2026-11-25&to=2026-11-25');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.map((i: { at: string }) => i.at)).toEqual(['2026-11-25T14:59:59.000000Z', '2026-11-25T10:00:00.000000Z', '2026-11-24T15:00:00.000000Z']);
    expect(res.body.items[0]).toMatchObject({ taskKey: 'TASK-0001', before: 'a', after: '{"effort":"high","modelId":"m"}', ref: 'TASK-0001' });
    const filtered = await h.lead('GET', `/api/history?actor=${encodeURIComponent('팀장')}&kind=${encodeURIComponent('실행 등급')}`);
    expect(filtered.body.items.map((i: { taskKey: string }) => i.taskKey)).toEqual(['TASK-0002', 'TASK-0001']);
  });

  test('커서로 빠짐없이 넘기고, Task 탭은 그 Task만', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { items: { id: string }[]; nextCursor: string | null } } = await h.lead('GET', `/api/history?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...res.body.items.map((i) => i.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    const total = (await h.owner.query<{ n: number }>('select count(*)::int as n from task_history')).rows[0]?.n;
    expect(seen).toHaveLength(total ?? -1);
    const tab = await h.lead('GET', '/api/tasks/TASK-0002/history');
    expect(tab.body.items.map((i: { taskKey: string }) => i.taskKey)).toEqual(['TASK-0002', 'TASK-0002']);
  });

  test('없는 Task 404, 잘못된 커서·달력에 없는 날짜·거꾸로 된 기간 400', async () => {
    expect((await h.lead('GET', '/api/tasks/TASK-9999/history')).body.error.code).toBe('TASK_NOT_FOUND');
    expect((await h.lead('GET', '/api/history?cursor=abc')).body.error).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'cursor' }] });
    expect((await h.lead('GET', '/api/history?from=2026-02-30')).status).toBe(400);
    expect((await h.lead('GET', '/api/history?from=2026-11-27&to=2026-11-26')).status).toBe(400);
  });
});
