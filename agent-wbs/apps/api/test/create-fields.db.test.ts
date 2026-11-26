/**
 * srv-perf: Task 생성 계약(M3-02 보고 §4-4, 조정자 결정 2026-11-27).
 * 원본 Wizard(P createTask L6795~6811)와 같게 저장한다.
 * - 예상 시간은 updateTask와 같은 `estimate` 묶음의 `estHours` 하나로 받는다(원본 Wizard 입력은 숫자 하나).
 *   서버가 범위를 ×0.7~×1.6(소수 첫째 자리 반올림), 토큰을 ×140K로 정하고 신뢰도 「하」, 근거는 팀장 임시값으로 남긴다.
 * - 고정 시작일은 tasks.fix_start에 저장해 일정 계산이 쓴다.
 * - 설계 구역은 원본 newTask처럼 기술 영역에 맞는 빈 구역을 만든다(P recKinds, data-model §2.4-1과 같은 규칙).
 * - 가이드 §6.4의 재조정 계기 「Task 추가」: 생성도 재조정을 기록한다(임계값·자동 재조정 정책 규칙 그대로, CP 반영과 같은 drift 규칙).
 */
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { OPERATIONS } from '@awbs/shared/api';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink } from '../src/platform/credentials.ts';
import { recordReplan } from '../src/planning/schedule.ts';

const origin = 'http://127.0.0.1:3100';
const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_create';
const ownerPool = createPool(dbUrl.href, { max: 4, onError: () => undefined });
const appUrl = new URL(dbUrl);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { max: 6, onError: () => undefined });
const app = buildApp(pool, false, { origin, lan: false });

let cookie = '';
let csrf = '';
let projectId = '';
let wp = '';

const create = (body: Record<string, unknown>) => app.inject({
  method: 'POST', url: `/api/projects/${projectId}/tasks`,
  headers: { cookie, origin, 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() },
  payload: { title: '작업', wbsNodeId: wp, workType: 'Implementation', primaryDomain: 'BE', ...body },
});
const stored = async (taskKey: string) => (await ownerPool.query<{ fix_start: string | null; est: string | null; lo: string | null; hi: string | null; tokens_k: string | null; confidence: string | null; basis: string | null; agreed_by: string | null }>(
  `select to_char(t.fix_start,'YYYY-MM-DD') fix_start,e.est::text est,e.lo::text lo,e.hi::text hi,e.tokens_k::text tokens_k,e.confidence,e.basis,e.agreed_by
     from tasks t left join task_estimates e on e.task=t.id where t.task_key=$1`, [taskKey])).rows;

beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  await runMigrations(ownerPool);
  await seedSystem(ownerPool);
  projectId = (await ownerPool.query<{ id: string }>(
    "insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('생성','https://github.com/o/r','o','r','','active') returning id")).rows[0]?.id ?? '';
  const phase = (await ownerPool.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'p1','phase',null,'p1',0) returning id", [projectId])).rows[0]?.id;
  wp = (await ownerPool.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'wp1','work_package',$2,'wp1',0) returning id", [projectId, phase])).rows[0]?.id ?? '';
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
  expect(login.statusCode, login.body).toBe(204);
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
});
afterAll(async () => { await app.close(); await pool.end(); await ownerPool.end(); });

describe('createTask 예상 시간·고정 시작일', () => {
  test('계약(shared api): createTask는 updateTask와 같은 estimate 묶음 이름을 쓰고, 생성 때는 estHours 하나만 받는다', () => {
    interface Schema { properties: Record<string, Schema & { anyOf?: Schema[] }>; required?: string[] }
    const body = (id: string) => OPERATIONS.find((op) => op.id === id)?.body as Schema | undefined;
    const create = body('createTask'), update = body('updateTask');
    expect(Object.keys(create?.properties ?? {})).toEqual(expect.arrayContaining(['estimate', 'fixStart']));
    expect(Object.keys(create?.properties ?? {})).not.toContain('estHours');
    expect(create?.required ?? []).not.toContain('estimate');
    const createEstimate = create?.properties.estimate;
    expect(Object.keys(createEstimate?.properties ?? {})).toEqual(['estHours']);
    expect(createEstimate?.required).toEqual(['estHours']);
    // 같은 이름의 필드는 같은 뜻·같은 범위다.
    expect(createEstimate?.properties.estHours).toEqual(update?.properties.estimate?.properties.estHours);
    expect(create?.properties.fixStart).toEqual(update?.properties.fixStart);
  });

  test('예상 시간과 고정 시작일을 원본 Wizard와 같은 규칙으로 저장하고 목록·일정에 반영한다', async () => {
    const response = await create({ estimate: { estHours: 6 }, fixStart: '2026-12-01' });
    expect(response.statusCode, response.body).toBe(201);
    const { taskKey } = response.json<{ taskKey: string }>();
    expect(await stored(taskKey)).toEqual([{
      fix_start: '2026-12-01', est: '6', lo: '4.2', hi: '9.6', tokens_k: '840', confidence: '하',
      basis: '팀장 등록 — Planning Agent 재추정 전 임시값 (범위 ×0.7~×1.6)', agreed_by: '팀장',
    }]);
    const list = (await app.inject({ url: `/api/projects/${projectId}/tasks`, headers: { cookie, origin } })).json<{ tasks: { taskKey: string; schedule: { estHours: number; loHours: number; hiHours: number } | null }[] }>();
    expect(list.tasks.find((t) => t.taskKey === taskKey)?.schedule).toMatchObject({ estHours: 6, loHours: 4.2, hiHours: 9.6 });
    // 상세의 추정은 updateTask가 돌려주는 것과 같은 TaskEstimate 모양이다.
    const detail = (await app.inject({ url: `/api/tasks/${taskKey}`, headers: { cookie, origin } })).json<{ estimate: unknown; fixStart: string | null }>();
    expect(detail).toMatchObject({ fixStart: '2026-12-01', estimate: { estHours: 6, loHours: 4.2, hiHours: 9.6, tokensK: 840, confidence: '하', agreedBy: '팀장' } });
    const schedule = (await app.inject({ url: '/api/schedule', headers: { cookie, origin } })).json<{ tasks: { taskKey: string; start: string; estHours: number }[] }>();
    const item = schedule.tasks.find((t) => t.taskKey === taskKey);
    expect(item?.estHours).toBe(6);
    // 고정 시작일 전에는 시작하지 않는다.
    expect(item && item.start >= '2026-12-01').toBe(true);
  });

  test('소수 예상 시간은 원본처럼 범위를 소수 첫째 자리로 반올림한다', async () => {
    const response = await create({ estimate: { estHours: 2.5 } });
    expect(response.statusCode, response.body).toBe(201);
    expect(await stored(response.json<{ taskKey: string }>().taskKey)).toMatchObject([{ fix_start: null, est: '2.5', lo: '1.8', hi: '4', tokens_k: '350' }]);
  });

  test('두 값이 없으면 이전과 같이 추정 없이 만든다(고정 시작일 null도 허용)', async () => {
    for (const body of [{}, { fixStart: null }]) {
      const response = await create(body);
      expect(response.statusCode, response.body).toBe(201);
      expect(await stored(response.json<{ taskKey: string }>().taskKey)).toEqual([{ fix_start: null, est: null, lo: null, hi: null, tokens_k: null, confidence: null, basis: null, agreed_by: null }]);
    }
  });

  test('범위 밖 예상 시간(0·400 초과)과 달력에 없는 날짜는 400 VALIDATION_FAILED이고 Task를 만들지 않는다', async () => {
    const before = (await ownerPool.query('select count(*)::int n from tasks')).rows[0] as { n: number };
    for (const [body, path] of [[{ estimate: { estHours: 0 } }, 'estimate.estHours'], [{ estimate: { estHours: 400.5 } }, 'estimate.estHours'], [{ estimate: { estHours: '4' } }, 'estimate.estHours'], [{ estimate: { estHours: 4, loHours: 2 } }, 'estimate.loHours'], [{ estimate: {} }, 'estimate.estHours'], [{ fixStart: '2026-02-30' }, 'fixStart'], [{ fixStart: '2026/12/01' }, 'fixStart']] as const) {
      const response = await create(body);
      expect(response.statusCode, `${JSON.stringify(body)} ${response.body}`).toBe(400);
      const error = response.json<{ error: { code: string; errors: { path: string }[] } }>().error;
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.errors.map((e) => e.path)).toContain(path);
    }
    expect((await ownerPool.query('select count(*)::int n from tasks')).rows[0]).toEqual(before);
  });
});

describe('createTask 설계 구역 자동 구성', () => {
  const kinds = async (taskKey: string) => (await ownerPool.query<{ kind: string; content: unknown }>(
    'select d.kind::text kind,d.content from task_designs d join tasks t on t.id=d.task where t.task_key=$1 order by d.created_at,d.kind', [taskKey])).rows;

  test('주 영역·관련 영역에 맞는 빈 구역을 원본 recKinds 순서로 만든다(BE·API는 API 하나, QA·Common은 구역 없음)', async () => {
    const response = await create({ primaryDomain: 'BE', relatedDomains: ['DB', 'API', 'QA', 'FE'] });
    expect(response.statusCode, response.body).toBe(201);
    const rows = await kinds(response.json<{ taskKey: string }>().taskKey);
    expect(rows.map((r) => r.kind).sort()).toEqual(['API', 'DB', 'FE']);
    for (const row of rows) expect(row.content).toEqual({ ents: [], b: {} });
  });

  test('설계 구역이 없는 영역만 고르면 구역을 만들지 않는다', async () => {
    const response = await create({ primaryDomain: 'QA', relatedDomains: ['Common', 'Architecture'] });
    expect(response.statusCode, response.body).toBe(201);
    expect(await kinds(response.json<{ taskKey: string }>().taskKey)).toEqual([]);
  });

  test('상세 응답의 designs에도 빈 구역이 보인다', async () => {
    const response = await create({ primaryDomain: 'DevOps' });
    const { taskKey } = response.json<{ taskKey: string }>();
    const detail = (await app.inject({ url: `/api/tasks/${taskKey}`, headers: { cookie, origin } })).json<{ designs: { kind: string; content: unknown }[] }>();
    expect(detail.designs).toEqual([{ kind: 'DevOps', content: { ents: [], b: {} } }]);
  });
});

describe('createTask 재조정 기록(G§6.4 「Task 추가」)', () => {
  const replans = async () => (await ownerPool.query<{ rp_key: string; trigger: string; actor: string; status: string; baseline_v: number | null }>(
    'select rp_key,trigger,actor,status,baseline_v from replans where project_id=$1 order by created_at', [projectId])).rows;
  const policy = (autoReplan: boolean | null, thresholdDays: number) =>
    ownerPool.query('update schedule_policy set auto_replan=$1,threshold_days=$2 where singleton', [autoReplan, thresholdDays]);
  const replanHistoryCount = async () => Number((await ownerPool.query<{ n: string }>("select count(*) n from task_history where project_id=$1 and kind='재조정'", [projectId])).rows[0]?.n);
  const movesOf = async (rpKey: string) => Number((await ownerPool.query<{ n: string }>('select count(*) n from replan_moves m join replans r on r.id=m.replan where r.rp_key=$1', [rpKey])).rows[0]?.n);
  /** 생성 하나가 새로 남긴 재조정 기록. 기록은 지울 수 없으므로(물리 삭제 금지) 생성 전후 개수로 가른다. */
  const added = async (fn: () => Promise<void>) => {
    const before = (await replans()).length;
    await fn();
    return (await replans()).slice(before);
  };

  test('자동 재조정이 꺼져 있으면 검토 대기(pending)로 기록하고 기준은 만들지 않는다', async () => {
    await policy(null, 1);
    const historyBefore = await replanHistoryCount();
    // 아직 기준이 없다(앞 시험의 기록도 모두 검토 대기). 기준이 없으면 임계값과 관계없이 기록한다.
    expect(await ownerPool.query('select 1 from schedule_baselines where project_id=$1', [projectId])).toMatchObject({ rowCount: 0 });
    let taskKey = '';
    const rows = await added(async () => {
      const response = await create({ estimate: { estHours: 4 } });
      expect(response.statusCode, response.body).toBe(201);
      taskKey = response.json<{ taskKey: string }>().taskKey;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: `${taskKey} 신규 Task 등록`, actor: '팀장', status: 'pending', baseline_v: null });
    // 가이드 §9.2-1(이력 폭증 방지)·D-10: 검토 대기는 재조정 기록 한 줄만 남기고 Task별 이력·이동 행은 쓰지 않는다.
    expect(await replanHistoryCount()).toBe(historyBefore);
    expect(await movesOf(rows[0]?.rp_key ?? '')).toBe(0);
    // 생성 응답 뒤 Task 버전은 자기 이력보다 늦다(충돌 창에 자기 이력이 섞이지 않는다).
    const order = (await ownerPool.query<{ ok: boolean }>("select t.updated_at>max(h.at) ok from tasks t join task_history h on h.task=t.id where t.task_key=$1 group by t.updated_at", [taskKey])).rows[0];
    expect(order?.ok).toBe(true);
  });

  test('자동 재조정이 켜져 있으면 확정(applied)하고 기준 버전을 올린다. 첫 기준(v1)은 모든 Task가 신규라 Task별 이력을 쓰지 않는다', async () => {
    await policy(true, 1);
    const historyBefore = await replanHistoryCount();
    const rows = await added(async () => {
      const response = await create({ estimate: { estHours: 4 } });
      expect(response.statusCode, response.body).toBe(201);
    });
    expect(rows).toMatchObject([{ status: 'applied', baseline_v: 1 }]);
    expect(await replanHistoryCount()).toBe(historyBefore);
    expect(await movesOf(rows[0]?.rp_key ?? '')).toBe(0);
  });

  test('기준이 있을 때 새 기준 버전을 만들면 날짜가 바뀐 Task(신규 편입 포함)에만 이력을 남긴다', async () => {
    // 임계값 0: 어긋남이 없어도 새 기준을 만든다. 새 Task는 WP 끝에 붙어 다른 Task의 날짜는 바뀌지 않는다.
    await policy(true, 0);
    const live = Number((await ownerPool.query<{ n: string }>('select count(*) n from tasks where project_id=$1 and deleted_at is null', [projectId])).rows[0]?.n);
    const historyBefore = await replanHistoryCount();
    let taskKey = '';
    const rows = await added(async () => {
      const response = await create({ estimate: { estHours: 1 } });
      expect(response.statusCode, response.body).toBe(201);
      taskKey = response.json<{ taskKey: string }>().taskKey;
    });
    expect(rows).toMatchObject([{ status: 'applied', baseline_v: 2 }]);
    const moves = (await ownerPool.query<{ task_key: string; kind: string }>(
      'select t.task_key,m.kind from replan_moves m join replans r on r.id=m.replan join tasks t on t.id=m.task where r.rp_key=$1', [rows[0]?.rp_key])).rows;
    expect(moves).toContainEqual({ task_key: taskKey, kind: 'new' });
    expect(moves.length).toBeLessThan(live + 1);
    // Task별 이력은 이동 행과 같은 수다(바뀌지 않은 Task에는 쓰지 않는다).
    expect(await replanHistoryCount()).toBe(historyBefore + moves.length);
    await policy(null, 1);
  });

  test('기준이 있고 임계값보다 덜 어긋나면 기록하지 않는다', async () => {
    await policy(true, 10_000);
    const rows = await added(async () => {
      const response = await create({ estimate: { estHours: 1 } });
      expect(response.statusCode, response.body).toBe(201);
    });
    expect(rows).toEqual([]);
    await policy(null, 1);
  });
});

describe('재조정 목록 순서', () => {
  test('같은 시각(같은 트랜잭션)에 생긴 재조정도 RP 순번이 큰 것부터 보인다(20회 반복)', async () => {
    for (let round = 0; round < 20; round++) {
      const client = await pool.connect();
      try {
        // 한 트랜잭션 안에서는 now()가 같아 created_at이 모두 같다. 정렬이 created_at이면 순서가 무작위가 된다.
        await client.query('begin');
        for (let i = 0; i < 3; i++) await recordReplan(client, projectId, { trigger: `순서 ${String(round)}-${String(i)}`, actor: '팀장', mode: 'policy' });
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally { client.release(); }
      const list = (await app.inject({ url: '/api/replans?limit=5', headers: { cookie, origin } })).json<{ items: { replanId: string }[] }>();
      const numbers = list.items.map((item) => Number(item.replanId.slice(3)));
      expect(numbers, `round ${String(round)}`).toEqual([...numbers].sort((a, b) => b - a));
      expect(list.items.slice(0, 3).map((item) => item.replanId)).toEqual(list.items.slice(0, 3).map((item) => item.replanId).sort().reverse());
    }
  });
});

