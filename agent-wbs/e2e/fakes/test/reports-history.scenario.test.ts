/**
 * M6-01 보고서 상태 이력 — 재리뷰 2(review2-codex.md) 재현을 시험으로 남긴다.
 *
 * - 「T 전」은 커밋 기준(커밋 시계, 마이그레이션 0028)이다. 늦은 커밋·PC 시계 역행에도 「그때 만든 보고서 = 나중에 다시 만든 보고서」.
 * - 보고서가 읽는 모든 표가 기록 대상이고, 계산 코드는 기록에서만 읽는다(tracked.ts 한 곳의 목록과 대조).
 * - 연결 수 1에서도 정기·기간 지정 보고서가 만들어진다.
 * - 앱 역할은 이력을 직접 쓸 수 없다.
 * 이 파일은 자기 전용 DB를 쓴다. 마지막 시험은 커밋 시계를 앞으로 옮기므로(자정 경계) 맨 뒤에 둔다.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { addDays, seoulDay, type ReportSnapshotData } from '../../../packages/shared/src/index.ts';
import { createPool, recreateTestDatabase, runMigrations, seedDemo, type Pool } from '../../../packages/db/src/index.ts';
import { buildApp } from '../../../apps/api/src/app.ts';
import { issueLoginLink } from '../../../apps/api/src/platform/credentials.ts';
import { generateDueReports, reportAnchor } from '../../../apps/api/src/reports/service.ts';
import { buildSnapshot } from '../../../apps/api/src/reports/snapshot.ts';
import { FALLBACK_CURRENT, LOG_TABLES, TRACKED } from '../../../apps/api/src/reports/tracked.ts';

let owner: Pool;
let pool: Pool;
let dbUrl: URL;
let projectId = '';
const closers: (() => Promise<void>)[] = [];

const micro = (iso: string, deltaMicros: number) => {
  const m = /^(.*\.)(\d{6})Z$/.exec(iso);
  assert(m?.[1] && m[2]);
  const base = Date.parse(`${m[1].slice(0, -1)}Z`);
  const total = Number(m[2]) + deltaMicros;
  const carry = Math.floor(total / 1_000_000);
  const rest = ((total % 1_000_000) + 1_000_000) % 1_000_000;
  return `${new Date(base + carry * 1000).toISOString().slice(0, 19)}.${String(rest).padStart(6, '0')}Z`;
};

/** 운영과 같은 순서로 T의 스냅샷: 기준점 → 반복 읽기. live는 지금 표(그때 바로 찍은 값), log는 이력(되살린 값). */
async function capture(at?: string, from = '2026-10-26') {
  const c = await pool.connect();
  try {
    const anchor = await reportAnchor(c);
    await c.query('begin isolation level repeatable read read only');
    const now = at ?? anchor;
    const period = { kind: 'custom' as const, from, to: seoulDay(now), at: now };
    const live = at ? null : await buildSnapshot(c, projectId, period, 'live');
    const log = await buildSnapshot(c, projectId, period, 'log');
    await c.query('commit');
    return { now, live, log };
  } finally { c.release(); }
}
const titleOf = (s: ReportSnapshotData | null, key: string) => s?.all.find((t) => t.taskKey === key)?.title;

beforeAll(async () => {
  dbUrl = new URL(inject('testDatabaseUrl'));
  dbUrl.pathname += '_reports_history';
  await recreateTestDatabase(dbUrl.href);
  owner = createPool(dbUrl.href, { onError: () => undefined });
  const appUrl = new URL(dbUrl);
  appUrl.searchParams.set('options', '-c role=awbs_app');
  pool = createPool(appUrl.href, { onError: () => undefined });
  closers.push(async () => { await pool.end(); await owner.end(); });
  await runMigrations(owner);
  await seedDemo(owner, dbUrl.href);
  await owner.query("update projects set start_date='2026-10-27'");
  projectId = (await owner.query<{ id: string }>('select id from projects')).rows[0]?.id ?? '';
}, 60_000);
afterAll(async () => { for (const close of closers.reverse()) await close(); });

/** 벽시계(clock_timestamp)가 커밋 시계(log_clock)를 넘을 때까지 기다린다. 이 PC의 시계 역행(최대 2.3초) 뒤에는 커밋 시계가 앞서 있을 수 있다. */
async function waitWallPastCommitClock() {
  for (let i = 0; i < 100; i++) {
    const ok = (await owner.query<{ ok: boolean }>('select coalesce((select t from log_clock where singleton) < clock_timestamp(), true) ok')).rows[0]?.ok;
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('커밋 시계가 5초 넘게 벽시계보다 앞서 있다');
}

describe('재리뷰 2 문제 1: 늦은 커밋', () => {
  test('T 전에 시작해 이력을 남겼지만 T 뒤에 커밋한 변경은 나중에 같은 T로 다시 만들어도 끼어들지 않는다(실제 생성 경로)', async () => {
    const app = buildApp(pool, false, { origin: 'http://127.0.0.1:3100', lan: false });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    closers.push(() => app.close());
    const lead = await login(base, pool);
    const late = await owner.connect();
    let created: { id: string; generatedAt: string };
    try {
      await late.query('begin');
      await late.query("update tasks set title='late-commit-title' where task_key='TASK-0007'");
      const today = seoulDay(new Date());
      const r = await lead('POST', `/api/projects/${projectId}/reports`, { from: addDays(today, -1), to: today, view: 'int' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      created = r.body as { id: string; generatedAt: string };
      await late.query('commit');
    } finally { late.release(); }
    const stored = (await owner.query<{ snapshot: ReportSnapshotData; from: string }>(`select snapshot,to_char("from",'YYYY-MM-DD') "from" from reports where id=$1`, [created.id])).rows[0];
    assert(stored);
    expect(titleOf(stored.snapshot, 'TASK-0007')).toBe('WBS Tree UI');
    const again = await capture(created.generatedAt, stored.from);
    expect(again.log).toEqual(stored.snapshot);
  });
});

describe('재리뷰 2 문제 2: PC 시계 역행', () => {
  test('같은 행을 고친 뒤 시계가 2.3초 뒤로 가고 다시 고쳐도, 되살린 값은 나중에 커밋한 쪽이다', async () => {
    await owner.query("update tasks set title='microsecond-title' where task_key='TASK-0006'");
    const back = await owner.connect();
    try {
      await back.query("select set_config('awbs.test_clock_offset','-2.3 seconds',false)");
      await back.query("update tasks set title='after-clock-backward' where task_key='TASK-0006'");
    } finally { await back.query("select set_config('awbs.test_clock_offset','',false)"); back.release(); }
    const { live, log } = await capture();
    expect(titleOf(log, 'TASK-0006')).toBe('after-clock-backward');
    expect(log).toEqual(live);
  });
});

describe('재리뷰 2 문제 3: 알림·실행 PC 세션도 그 시점 값', () => {
  test('알림 본문을 나중에 바꾸거나 해소해도, 실행 PC 생존 신호가 나중에 와도 T 보고서는 그대로다', async () => {
    const alert = (await owner.query<{ id: string }>("insert into alerts(project_id,key,severity,target) values($1,'input:rewrite','warn','{\"message\":\"old-alert\"}') returning id", [projectId])).rows[0]?.id;
    const global = (await owner.query<{ id: string }>("insert into alerts(project_id,key,severity,target) values(null,'runner:global','warn','{\"message\":\"global-alert\"}') returning id")).rows[0]?.id;
    const session = (await owner.query<{ id: string }>("insert into runner_sessions(runner_id,started_at,last_heartbeat_at) values('pc',now()-interval '3 days',now()-interval '3 days') returning id")).rows[0]?.id;
    const first = await capture();
    const issues = (s: ReportSnapshotData | null) => (s?.issues ?? []).map((i) => i.text);
    expect(issues(first.live)).toEqual(expect.arrayContaining(['old-alert', 'global-alert']));
    await owner.query("update alerts set target='{\"message\":\"new-alert\"}' where id=$1", [alert]);
    await owner.query('update alerts set resolved_at=now() where id=$1', [global]);
    await owner.query('update runner_sessions set last_heartbeat_at=now() where id=$1', [session]);
    const later = await capture(first.now);
    expect(later.log).toEqual(first.live);
    expect(issues((await capture()).log)).toContain('new-alert');
    expect(issues((await capture()).log)).not.toContain('global-alert');
  });
});

describe('재리뷰 2 문제 4: 마이크로초', () => {
  test('경계가 변경의 커밋 값(커밋 시계·실제 커밋 시각 중 늦은 쪽) 1µs 뒤면 들어가고, 그 값과 같으면 빠진다', async () => {
    // M6 통합 fix1(간헐 실패 수정): 이 PC는 약 32초마다 시계가 2.3초 뒤로 간다. 두 변경 사이에 시계가 뒤로 가면
    // 앞 변경의 실제 커밋 시각이 뒤 변경의 경계 바로 앞(-1µs)보다 늦어져 셋째 단정의 전제가 깨진다. 전제가 성립할 때까지 다시 만든다(최대 4번).
    const effective = (title: string) => owner.query<{ at: string }>(`select to_char(greatest(c.stamp,c.committed_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at from state_log l join commit_real c on c.xid=l.xid
      where l.tbl='tasks' and l.data->>'title'=$1 order by l.seq desc limit 1`, [title]).then((r) => r.rows[0]?.at ?? '');
    let stamp = '';
    for (let tries = 0; tries < 4; tries++) {
      await waitWallPastCommitClock();
      await owner.query("update tasks set title='before-cutoff' where task_key='TASK-0008'");
      await owner.query("update tasks set title='microsecond-cutoff' where task_key='TASK-0008'");
      // 그 변경이 「T 전」이 되는 가장 이른 값 = 커밋 시계 값과 실제 커밋 시각 중 늦은 쪽(정리 뒤 commit_real)
      await owner.query('select awbs_settle_commits()');
      stamp = await effective('microsecond-cutoff');
      if ((await effective('before-cutoff')) < micro(stamp, -1)) break;
    }
    expect(titleOf((await capture(micro(stamp, 1))).log, 'TASK-0008')).toBe('microsecond-cutoff');
    expect(titleOf((await capture(stamp)).log, 'TASK-0008')).toBe('before-cutoff');
    expect(titleOf((await capture(micro(stamp, -1))).log, 'TASK-0008')).toBe('before-cutoff');
    expect((await capture(micro(stamp, 1))).log.basis?.asOf).toBe(micro(stamp, 1));
  });
});

describe('재리뷰 2 문제 5: 연결 수 1', () => {
  test('연결이 하나뿐인 풀에서도 기간 지정(HTTP)·정기 보고서가 만들어진다', async () => {
    const one = new URL(dbUrl);
    one.searchParams.set('options', '-c role=awbs_app');
    const single = createPool(one.href, { max: 1, onError: () => undefined });
    const app = buildApp(single, false, { origin: 'http://127.0.0.1:3100', lan: false });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const lead = await login(base, single);
      const today = seoulDay(new Date());
      const r = await lead('POST', `/api/projects/${projectId}/reports`, { from: today, to: today, view: 'int' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await generateDueReports(single, 1, { now: new Date(Date.parse(`${addDays(today, 1)}T07:00:00+09:00`)).toISOString() })).toBeGreaterThan(0);
    } finally { await app.close(); await single.end(); }
  });
});

describe('재리뷰 2 문제 6: 앱 역할은 이력을 위조할 수 없다', () => {
  test('앱 역할의 이력 직접 쓰기는 거부되고 보고서에 거짓 과거가 나오지 않는다', async () => {
    await expect(pool.query("insert into state_log(project_id,tbl,row_id,op,data) select $1,'tasks',id,'update',jsonb_set(to_jsonb(t),'{title}','\"forged-history\"') from tasks t where task_key='TASK-0001'", [projectId]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(pool.query("insert into global_log(tbl,row_id,op,data) values('schedule_policy',gen_random_uuid(),'update','{}')")).rejects.toMatchObject({ code: '42501' });
    expect(JSON.stringify((await capture()).log)).not.toContain('forged-history');
  });
});

describe('재리뷰 2 원칙 3: 기록 대상 목록 한 곳 대조', () => {
  test('DB에서 기록 트리거가 달린 표 = tracked.ts TRACKED', async () => {
    const tables = (await owner.query<{ t: string }>("select tgrelid::regclass::text t from pg_trigger where tgname='state_log' and not tgisinternal order by 1")).rows.map((r) => r.t.replace(/^public\./, ''));
    expect(tables).toEqual([...TRACKED].sort());
  });
  /** 스냅샷 하나를 만들 때 읽은 표 이름(질의의 from·join 뒤) */
  /**
   * M6 통합: 스냅샷의 projectName(M6-02)은 기간 끝 재구성 대상이 아니라 「생성 시점」 지금 이름이다(조정자 결정 7).
   * 그래서 이름 한 칸만 지금 projects 행을 읽는다(snapshot.ts 주석). 다른 값이 projects를 직접 읽으면 여전히 실패한다.
   */
  const NAME_SOURCE: readonly string[] = ['projects'];
  async function tablesRead(period: { kind: 'weekly' | 'custom'; from: string; to: string; at: string }) {
    const seen = new Set<string>();
    const c = await pool.connect();
    type Fn = (...args: unknown[]) => unknown;
    const raw = c as unknown as { query: Fn };
    const query = raw.query.bind(c);
    raw.query = (...args: unknown[]) => {
      if (typeof args[0] === 'string') for (const t of tablesIn(args[0])) seen.add(t);
      return query(...args);
    };
    try {
      await reportAnchor(c);
      await c.query('begin isolation level repeatable read read only');
      await buildSnapshot(c, projectId, period);
      await c.query('commit');
    } finally { raw.query = query; c.release(); }
    const keywords = new Set(['lateral', 'jsonb_populate_record', 'jsonb_array_elements', 'unnest', 'generate_series']);
    return [...seen].filter((t) => !keywords.has(t));
  }
  test('보고서 계산은 이력 표만 읽는다(기록 대상 표를 직접 읽는 질의가 생기면 실패)', async () => {
    const now = (await capture()).now;
    const read = await tablesRead({ kind: 'custom', from: addDays(seoulDay(now), -6), to: seoulDay(now), at: now });
    expect(read.filter((t) => !(LOG_TABLES as readonly string[]).includes(t) && !NAME_SOURCE.includes(t))).toEqual([]);
    expect(read).toEqual(expect.arrayContaining(['state_log', 'global_log', 'commit_real']));
  });
  test('기록이 시작되기 전 시점에서만 설정 확인용으로 지금 설정 표를 더 읽는다(FALLBACK_CURRENT)', async () => {
    const read = await tablesRead({ kind: 'weekly', from: '2026-10-26', to: '2026-11-01', at: '2026-11-02T07:00:00.000000Z' });
    const allowed = new Set<string>([...LOG_TABLES, ...FALLBACK_CURRENT, ...NAME_SOURCE]);
    expect(read.filter((t) => !allowed.has(t))).toEqual([]);
  });
});

describe('재리뷰 3 문제 4: 대조 시험의 표 이름 인식', () => {
  test('따옴표로 감싼 표 이름·스키마도 읽은 표로 센다', () => {
    expect(tablesIn('select count(*) from "review_new_report_source"')).toEqual(['review_new_report_source']);
    expect(tablesIn('select 1 from review_new_report_source x join "public"."Tasks" t on true')).toEqual(['review_new_report_source', 'tasks']);
    expect(tablesIn('select 1 from public."state_log" l cross join lateral jsonb_populate_record(null::public.tasks,l.data) r')).toEqual(['state_log', 'lateral']);
    // WITH로 만든 이름은 빼고, 그 안에서 읽은 표는 센다
    expect(tablesIn('with t as materialized (select * from "review_new_report_source" x), e as (select 1 from tasks) select 1 from t join e on true')).toEqual(['review_new_report_source', 'tasks']);
  });
});

describe('재리뷰 3 문제 1: 제약 트리거를 먼저 실행해도 실제 커밋 전 변경은 T에 들어가지 않는다', () => {
  test('앱 역할이 SET CONSTRAINTS ALL IMMEDIATE로 시계 값을 먼저 받고 T 뒤에 커밋해도 T 보고서에 없다', async () => {
    // M6 통합 fix1(간헐 실패 수정): 시계가 뒤로 간 직후에는 커밋 시계가 벽시계보다 최대 2.3초 앞선다. 그때 매긴 시계 값은 벽시계로 잡은 T보다 커서
    // 「시계 값은 T 전·실제 커밋은 T 뒤」 상황을 만들 수 없다. 벽시계가 커밋 시계를 넘을 때까지 기다린 뒤 시작한다(조건 대기).
    await waitWallPastCommitClock();
    const early = await pool.connect();
    let t: string;
    try {
      await early.query('begin');
      await early.query('set constraints all immediate');
      await early.query("update tasks set title='early-stamp-late-commit' where task_key='TASK-0011'");
      // 시계 값이 이미 매겨졌다(커밋 전).
      expect((await owner.query("select count(*)::int n from state_log l join commit_log c on c.xid=l.xid where l.data->>'title'='early-stamp-late-commit'")).rows[0]?.n).toBe(0);
      await new Promise((r) => setTimeout(r, 20));
      t = (await owner.query<{ at: string }>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`)).rows[0]?.at ?? '';
      await new Promise((r) => setTimeout(r, 20));
      await early.query('commit');
    } finally { early.release(); }
    const stamped = (await owner.query<{ at: string }>(`select to_char(c.committed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at from state_log l join commit_log c on c.xid=l.xid
      where l.data->>'title'='early-stamp-late-commit'`)).rows[0]?.at ?? '';
    expect(stamped < t).toBe(true);
    expect(titleOf((await capture(t)).log, 'TASK-0011')).not.toBe('early-stamp-late-commit');
    expect(titleOf((await capture()).log, 'TASK-0011')).toBe('early-stamp-late-commit');
  });
});

describe('재리뷰 3 문제 2: 동시 기간 지정 생성', () => {
  /** 세대 행을 잠가 두면 보고서 요청이 세대 잠금에서 기다린다(그 전에 읽기 시점이 정해진다). 겹친 요청을 재현한다. */
  async function overlapped<T>(run: () => Promise<T>, meanwhile?: () => Promise<void>) {
    const hold = await owner.connect();
    try {
      await hold.query('begin');
      await hold.query('select epoch from system_state where id=1 for update');
      const pending = run();
      await new Promise((r) => setTimeout(r, 300));
      if (meanwhile) await meanwhile();
      await hold.query('commit');
      return await pending;
    } finally { hold.release(); }
  }
  let lead: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    const app = buildApp(pool, false, { origin: 'http://127.0.0.1:3100', lan: false });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    closers.push(() => app.close());
    lead = await login(base, pool);
  });
  test('같은 멱등 키의 요청 두 개가 겹쳐도 보고서는 하나이고, 둘째는 첫 응답을 재생한다', async () => {
    const before = (await owner.query<{ n: number }>("select count(*)::int n from reports where kind='custom'")).rows[0]?.n ?? 0;
    const today = seoulDay(new Date());
    const key = randomUUID();
    const [a, b] = await overlapped(() => Promise.all([
      lead('POST', `/api/projects/${projectId}/reports`, { from: today, to: today, view: 'int' }, key),
      lead('POST', `/api/projects/${projectId}/reports`, { from: today, to: today, view: 'int' }, key),
    ]));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((a.body as { id: string }).id).toBe((b.body as { id: string }).id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect((await owner.query<{ n: number }>("select count(*)::int n from reports where kind='custom'")).rows[0]?.n).toBe(before + 1);
  });
  test('겹친 서로 다른 요청 다섯 개는 모두 만들어지고 번호가 이어진다', async () => {
    const today = seoulDay(new Date());
    const results = await overlapped(() => Promise.all([1, 2, 3, 4, 5].map(() => lead('POST', `/api/projects/${projectId}/reports`, { from: today, to: today, view: 'ext' }))));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const keys = results.map((r) => Number((r.body as { reportKey: string }).reportKey.slice(6))).sort((x, y) => x - y);
    expect(keys).toEqual(keys.map((_, i) => (keys[0] ?? 0) + i));
  });
  test('번호가 다른 경로로 먼저 쓰이면 다시 시도하지 않고 409로 알린다(보고서는 만들지 않는다)', async () => {
    const before = (await owner.query<{ n: number }>("select count(*)::int n from reports where kind='custom'")).rows[0]?.n ?? 0;
    const top = (await owner.query<{ n: number }>("select coalesce(max(substring(report_key from 7)::int),0)::int n from reports where kind='custom'")).rows[0]?.n ?? 0;
    const today = seoulDay(new Date());
    const r = await overlapped(() => lead('POST', `/api/projects/${projectId}/reports`, { from: today, to: today, view: 'int' }), async () => {
      await owner.query(`insert into reports(project_id,report_key,kind,"from","to",view,snapshot,generated_at,reason)
        select project_id,$1,kind,"from","to",view,snapshot,generated_at,reason from reports where kind='custom' limit 1`, [`RPT-C-${String(top + 1).padStart(3, '0')}`]);
    });
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT');
    expect((await owner.query<{ n: number }>("select count(*)::int n from reports where kind='custom'")).rows[0]?.n).toBe(before + 1);
  });
});

describe('재리뷰 4: 실제 커밋 시각을 모르면 지어내지 않는다', () => {
  test('A. 앱 역할이 커밋 전 자기 트랜잭션 안에서 정리를 불러도 그 변경은 확정 시각을 받지 않는다', async () => {
    const own = await pool.connect();
    let t: string;
    try {
      await own.query('begin');
      await own.query('set constraints all immediate');
      await own.query("update tasks set title='self-settled-before-commit' where task_key='TASK-0012'");
      await own.query('select awbs_settle_commits()');
      expect((await own.query("select count(*)::int n from state_log l join commit_real c on c.xid=l.xid where l.data->>'title'='self-settled-before-commit'")).rows[0]?.n).toBe(0);
      await new Promise((r) => setTimeout(r, 20));
      t = (await owner.query<{ at: string }>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`)).rows[0]?.at ?? '';
      await new Promise((r) => setTimeout(r, 20));
      await own.query('commit');
    } finally { await own.query('rollback').catch(() => undefined); own.release(); }
    expect(titleOf((await capture(t)).log, 'TASK-0012')).not.toBe('self-settled-before-commit');
    expect(titleOf((await capture()).log, 'TASK-0012')).toBe('self-settled-before-commit');
  });

  test('B. 실제 커밋 시각이 없는 커밋(기록이 꺼져 있던 때)은 관측 전 경계에서 「불확실」로 빼고 건수를 보고서에 적는다', async () => {
    // xid 2(동결 표시 트랜잭션)은 「커밋됨」이지만 실제 커밋 시각이 없다. 기록을 끈 동안의 커밋과 같은 상태를 만든다(관리자 전용 시험 준비).
    const w = await owner.connect();
    let stamp: string;
    try {
      await w.query('begin');
      // 커밋 시계 값은 실제로 시계를 한 칸 올려 받는다(이력의 다른 값과 순서가 맞게).
      stamp = (await w.query<{ at: string }>(`select to_char(awbs_report_anchor() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`)).rows[0]?.at ?? '';
      await w.query("insert into commit_log(xid,committed_at) values('2'::xid8,$1)", [stamp]);
      await w.query(`insert into state_log(xid,project_id,tbl,row_id,op,data)
        select '2'::xid8,t.project_id,'tasks',t.id,'update',to_jsonb(t)||'{"title":"committed-while-tracking-off"}' from tasks t where task_key='TASK-0012'`);
      await w.query('commit');
    } finally { w.release(); }
    await new Promise((r) => setTimeout(r, 30));
    await owner.query('select awbs_settle_commits()');
    const row = (await owner.query<{ committed_at: string | null; observed: string }>(
      `select committed_at,to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed from commit_real where xid='2'::xid8`)).rows[0];
    expect(row?.committed_at).toBeNull();
    const observed = row?.observed ?? '';
    // 커밋 시계 값 뒤·관측 전 경계: 그 사이 언제 커밋됐는지 모른다 → 넣지 않고 「불확실 1건」
    const between = await capture(micro(stamp, 1));
    expect(titleOf(between.log, 'TASK-0012')).not.toBe('committed-while-tracking-off');
    expect(between.log.basis?.uncertain).toBe(1);
    // 관측 뒤 경계: 그 전에 커밋된 것이 확실하다 → 넣는다
    const after = await capture(micro(observed, 1));
    expect(titleOf(after.log, 'TASK-0012')).toBe('committed-while-tracking-off');
    expect(after.log.basis?.uncertain ?? 0).toBe(0);
  });
});

describe('자정 경계(마지막: 커밋 시계를 앞으로 옮긴다)', () => {
  test('자정 직전에 커밋한 변경은 그날, 자정 전에 시작해 자정 뒤에 커밋한 변경은 다음 날. 다시 만들어도 같다', async () => {
    // 2027-05-01 23:59:58(서울)로 커밋 시계를 옮겨 커밋한다(관리자 전용 시험 시계). 커밋 시계는 줄지 않는다.
    // 늦은 커밋의 연결은 23:59:58.5의 시계를 가진다. 기준점이 커밋 시계를 자정 뒤로 올려 두지 않으면 그 커밋은 자정 전 값을 받아 끼어든다.
    const day = '2027-05-01';
    const midnight = new Date(Date.parse(`${addDays(day, 1)}T00:00:00+09:00`)).toISOString().replace('.000Z', '.000000Z');
    const shift = (target: string) => `${String((Date.parse(target) - Date.now()) / 1000)} seconds`;
    const w = await owner.connect();
    const late = await owner.connect();
    try {
      await w.query("select set_config('awbs.test_clock_offset',$1,false)", [shift(`${day}T23:59:58.000+09:00`)]);
      await w.query("update tasks set title='before-midnight' where task_key='TASK-0009'");
      await late.query("select set_config('awbs.test_clock_offset',$1,false)", [shift(`${day}T23:59:58.500+09:00`)]);
      await late.query('begin');
      await late.query("update tasks set title='midnight-late-commit' where task_key='TASK-0010'");
      await w.query("select set_config('awbs.test_clock_offset',$1,false)", [shift(`${addDays(day, 1)}T00:00:01+09:00`)]);
      const anchorAfter = (await w.query<{ at: string }>(`select to_char(awbs_report_anchor() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`)).rows[0]?.at ?? '';
      expect(anchorAfter > midnight).toBe(true);
      const first = await buildAt(midnight, day);
      await late.query('commit');
      const second = await buildAt(midnight, day);
      expect(second).toEqual(first);
      expect(titleOf(first, 'TASK-0009')).toBe('before-midnight');
      expect(titleOf(first, 'TASK-0010')).not.toBe('midnight-late-commit');
      expect(first.basis?.asOf).toBe(midnight);
    } finally {
      await w.query("select set_config('awbs.test_clock_offset','',false)"); w.release();
      await late.query("select set_config('awbs.test_clock_offset','',false)").catch(() => undefined); late.release();
    }
  });
});

/** 기간 끝(자정)이 T인 보고서를 운영 순서(기준점 → 반복 읽기)로 만든다. 생성 시각은 그 뒤다. */
async function buildAt(t: string, day: string) {
  const c = await pool.connect();
  try {
    const anchor = await reportAnchor(c);
    await c.query('begin isolation level repeatable read read only');
    const s = await buildSnapshot(c, projectId, { kind: 'daily', from: day, to: day, at: anchor > t ? anchor : t });
    await c.query('commit');
    return s;
  } finally { c.release(); }
}

async function login(base: string, p: Pool) {
  const origin = 'http://127.0.0.1:3100';
  const link = await issueLoginLink(p);
  const res = await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'link', token: link }) });
  assert.equal(res.status, 204);
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  const { csrfToken } = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json() as { csrfToken: string };
  return async (method: string, path: string, body?: object, key = randomUUID()) => {
    const response = await fetch(base + path, { method, headers: { cookie, origin, 'x-csrf-token': csrfToken, 'x-project-epoch': '1', 'idempotency-key': key, ...(body && { 'content-type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as unknown, replayed: response.headers.get('idempotency-replayed') === 'true' };
  };
}

/**
 * SQL 문자열에서 from·join 뒤에 오는 표 이름(소문자). 스키마·큰따옴표 표기를 모두 인식한다(재리뷰 3 문제 4).
 * 예: `from public."state_log"` → state_log, `join "Tasks"` → tasks.
 */
function tablesIn(sql: string): string[] {
  // 같은 질의 안에서 WITH로 만든 이름(CTE)은 표가 아니다.
  const ctes = new Set([...sql.matchAll(/(?:\bwith|,)\s+(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/gi)].map((m) => (m[1] ?? m[2] ?? '').toLowerCase()));
  const out: string[] = [];
  for (const m of sql.matchAll(/\b(?:from|join)\s+(?:(?:"[^"]+"|[a-z_][a-z0-9_]*)\s*\.\s*)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))/gi)) {
    const name = (m[1] ?? m[2] ?? '').toLowerCase();
    if (!ctes.has(name)) out.push(name);
  }
  return out;
}
