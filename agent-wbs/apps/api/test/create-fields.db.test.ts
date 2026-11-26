/**
 * srv-perf: Task 생성 계약의 예상 소요 시간(estHours)·고정 시작일(fixStart) (M3-02 보고 §4-4).
 * 원본 Wizard(P createTask L6795~6811)와 같게 저장한다.
 * - 예상 시간 하나를 받아 범위를 ×0.7~×1.6(소수 첫째 자리 반올림), 토큰을 ×140K로 정하고 신뢰도 「하」, 근거는 팀장 임시값으로 남긴다.
 * - 고정 시작일은 tasks.fix_start에 저장해 일정 계산이 쓴다.
 */
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { OPERATIONS } from '@awbs/shared/api';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink } from '../src/platform/credentials.ts';

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
  test('계약(shared api)에 estHours·fixStart가 있다', () => {
    const body = OPERATIONS.find((op) => op.id === 'createTask')?.body as { properties: Record<string, unknown>; required?: string[] } | undefined;
    expect(Object.keys(body?.properties ?? {})).toEqual(expect.arrayContaining(['estHours', 'fixStart']));
    expect(body?.required ?? []).not.toContain('estHours');
  });

  test('예상 시간과 고정 시작일을 원본 Wizard와 같은 규칙으로 저장하고 목록·일정에 반영한다', async () => {
    const response = await create({ estHours: 6, fixStart: '2026-12-01' });
    expect(response.statusCode, response.body).toBe(201);
    const { taskKey } = response.json<{ taskKey: string }>();
    expect(await stored(taskKey)).toEqual([{
      fix_start: '2026-12-01', est: '6', lo: '4.2', hi: '9.6', tokens_k: '840', confidence: '하',
      basis: '팀장 등록 — Planning Agent 재추정 전 임시값 (범위 ×0.7~×1.6)', agreed_by: '팀장',
    }]);
    const list = (await app.inject({ url: `/api/projects/${projectId}/tasks`, headers: { cookie, origin } })).json<{ tasks: { taskKey: string; schedule: { estHours: number; loHours: number; hiHours: number } | null }[] }>();
    expect(list.tasks.find((t) => t.taskKey === taskKey)?.schedule).toMatchObject({ estHours: 6, loHours: 4.2, hiHours: 9.6 });
    const schedule = (await app.inject({ url: '/api/schedule', headers: { cookie, origin } })).json<{ tasks: { taskKey: string; start: string; estHours: number }[] }>();
    const item = schedule.tasks.find((t) => t.taskKey === taskKey);
    expect(item?.estHours).toBe(6);
    // 고정 시작일 전에는 시작하지 않는다.
    expect(item && item.start >= '2026-12-01').toBe(true);
  });

  test('소수 예상 시간은 원본처럼 범위를 소수 첫째 자리로 반올림한다', async () => {
    const response = await create({ estHours: 2.5 });
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
    for (const [body, path] of [[{ estHours: 0 }, 'estHours'], [{ estHours: 400.5 }, 'estHours'], [{ estHours: '4' }, 'estHours'], [{ fixStart: '2026-02-30' }, 'fixStart'], [{ fixStart: '2026/12/01' }, 'fixStart']] as const) {
      const response = await create(body);
      expect(response.statusCode, `${JSON.stringify(body)} ${response.body}`).toBe(400);
      const error = response.json<{ error: { code: string; errors: { path: string }[] } }>().error;
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.errors.map((e) => e.path)).toContain(path);
    }
    expect((await ownerPool.query('select count(*)::int n from tasks')).rows[0]).toEqual(before);
  });
});
