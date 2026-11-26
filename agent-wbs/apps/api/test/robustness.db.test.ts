/**
 * srv-perf 견고성 시험.
 * - 같은 Work Package에 Task를 동시에 많이 만들어도 500(INTERNAL)이 나지 않는다(M3-02 보고 §4-2).
 * - 요청 처리 중 DB 연결이 끊겨도 API 프로세스는 죽지 않고, 그 요청만 오류로 끝난 뒤 다음 요청은 새 연결로 처리한다(M3-02 보고 §4-3).
 */
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { isUnavailable } from '../src/platform/errors.ts';
import { issueLoginLink } from '../src/platform/credentials.ts';

const origin = 'http://127.0.0.1:3100';
const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_robust';
const ownerPool = createPool(dbUrl.href, { max: 4, onError: () => undefined });
const appUrl = new URL(dbUrl);
appUrl.searchParams.set('options', '-c role=awbs_app');
// 시험이 이 앱의 연결만 골라 끊을 수 있게 이름을 붙인다.
appUrl.searchParams.set('application_name', 'robust-app');
const poolErrors: Error[] = [];
const pool = createPool(appUrl.href, { max: 20, onError: (error) => { poolErrors.push(error); } });
const app = buildApp(pool, process.env.ROBUST_DEBUG ? { level: 'error' } : false, { origin, lan: false });

let cookie = '';
let csrf = '';
let projectId = '';
const wps: string[] = [];

const create = (wbsNodeId: string, title: string) => app.inject({
  method: 'POST', url: `/api/projects/${projectId}/tasks`,
  headers: { cookie, origin, 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() },
  payload: { title, wbsNodeId, workType: 'Implementation', primaryDomain: 'BE' },
});

beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  await runMigrations(ownerPool);
  await seedSystem(ownerPool);
  projectId = (await ownerPool.query<{ id: string }>(
    "insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('견고성','https://github.com/o/r','o','r','','active') returning id")).rows[0]?.id ?? '';
  const phase = (await ownerPool.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'p1','phase',null,'p1',0) returning id", [projectId])).rows[0]?.id;
  for (let i = 0; i < 3; i++) {
    wps.push((await ownerPool.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,$2,'work_package',$3,$2,$4) returning id",
      [projectId, `wp${String(i)}`, phase, i])).rows[0]?.id ?? '');
  }
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
  expect(login.statusCode, login.body).toBe(204);
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
});
afterAll(async () => { await app.close(); await pool.end(); await ownerPool.end(); });

describe('동시 Task 생성', () => {
  test('같은 Work Package에 16개를 동시에 3번 만들어도 모두 201이고 번호·순서가 겹치지 않는다', async () => {
    const statuses: string[] = [];
    for (let round = 0; round < 3; round++) {
      const responses = await Promise.all(Array.from({ length: 16 }, (_, i) => create(wps[i % 2 === 0 ? 0 : 1] ?? '', `동시 ${String(round)}-${String(i)}`)));
      statuses.push(...responses.map((r) => (r.statusCode === 201 ? '201' : `${String(r.statusCode)} ${r.body}`)));
    }
    expect(statuses.filter((s) => s !== '201')).toEqual([]);
    const rows = (await ownerPool.query<{ wbs_node_id: string; sort_order: number; task_key: string }>('select wbs_node_id,sort_order,task_key from tasks where project_id=$1', [projectId])).rows;
    expect(rows).toHaveLength(48);
    expect(new Set(rows.map((r) => r.task_key)).size).toBe(48);
    expect(new Set(rows.map((r) => `${r.wbs_node_id}:${String(r.sort_order)}`)).size).toBe(48);
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const list = () => app.inject({ url: `/api/projects/${projectId}/tasks`, headers: { cookie, origin } });
const killApp = () => ownerPool.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name='robust-app'");

describe('DB 연결 문제', () => {
  test('연결 풀이 모두 사용 중이면 500이 아니라 503 UNAVAILABLE로 답한다', async () => {
    const small = createPool(appUrl.href, { max: 1, onError: () => undefined });
    const smallApp = buildApp(small, false, { origin, lan: false });
    const held = await small.connect();
    try {
      const response = await smallApp.inject({ url: `/api/projects/${projectId}/tasks`, headers: { cookie, origin } });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAVAILABLE');
    } finally { held.release(); await smallApp.close(); await small.end(); }
  });

  test('요청에 쓰던 연결이 끊기면 그 질의는 UNAVAILABLE로 분류되고, 프로세스는 죽지 않으며 다음 요청은 새 연결로 처리한다', async () => {
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
    await ownerPool.query('select pg_terminate_backend($1)', [pid]);
    // 끊긴 연결은 사용 중(checked out)인 클라이언트에 error 이벤트를 낸다. 듣는 곳이 없으면 프로세스가 죽는다.
    await sleep(300);
    const failure = await client.query('select 1').then(() => null, (error: unknown) => error);
    expect(failure).not.toBeNull();
    expect(isUnavailable(failure)).toBe(true);
    client.release();
    expect(poolErrors.some((error) => /terminat/i.test(error.message))).toBe(true);
    // 쉬고 있던 연결도 모두 끊는다(DB 재시작과 같은 상황). 다음 요청은 새 연결을 만들어 성공해야 한다.
    await killApp();
    await sleep(300);
    const response = await list();
    expect(response.statusCode, response.body).toBe(200);
  });

  test('DB가 끊긴 순간의 요청은 503이고, 끊긴 뒤의 요청은 다시 200이다', async () => {
    expect((await list()).statusCode).toBe(200);
    await killApp();
    const responses = await Promise.all(Array.from({ length: 6 }, () => list()));
    for (const response of responses) expect([200, 503], response.body).toContain(response.statusCode);
    await sleep(100);
    expect((await list()).statusCode).toBe(200);
  });
});
