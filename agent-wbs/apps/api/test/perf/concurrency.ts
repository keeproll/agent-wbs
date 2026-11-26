/**
 * 동시 Task 생성 측정 도구(srv-perf). 시험이 아니라 손으로 돌린다. M3-02 보고 §4-2의 「동시 생성 500」을 다시 만들 때 쓴다.
 *
 *   TEST_DATABASE_URL=postgres://...@127.0.0.1:<port>/awbs_test_perf \
 *     node --conditions=awbs-source apps/api/test/perf/concurrency.ts <생성 동시 수> <만들 Task 수> <동시 조회 수>
 *
 * - demo seed 위에 실제 HTTP 서버(app.listen)를 띄우고, 생성 요청과 함께 목록·일정 조회를 계속 보낸다.
 * - 끝나면 응답 코드별 개수를 찍는다. 예: {"201":296,"list 200":442,"500 INTERNAL":4}
 * - 원인(2026-11-27 확인): 느린 조회가 연결 풀(기본 10개)을 오래 잡으면, 다른 요청이 3초 안에 연결을 못 얻어 코드 없는 오류가 나고 500이 되었다.
 */
import { createPool, recreateTestDatabase, runMigrations, seedDemo } from '@awbs/db';
import { buildApp } from '../../src/app.ts';
import { issueLoginLink } from '../../src/platform/credentials.ts';
const url = process.env.TEST_DATABASE_URL ?? '';
if (!url) throw new Error('TEST_DATABASE_URL이 필요합니다.');
const workers = Number(process.argv[2] ?? 8), total = Number(process.argv[3] ?? 200);
await recreateTestDatabase(url);
const owner = createPool(url, { max: 2, onError: () => undefined });
await runMigrations(owner); await seedDemo(owner, url); await owner.end();
const appUrl = new URL(url); appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { max: 10, onError: () => undefined });
const origin = 'http://127.0.0.1:3100';
const app = buildApp(pool, { level: 'error' }, { origin, lan: false });
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const token = await issueLoginLink(pool);
const login = await fetch(`${address}/api/auth/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'link', token }) });
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
const csrf = ((await (await fetch(`${address}/api/session`, { headers: { cookie } })).json()) as { csrfToken: string }).csrfToken;
const projectId = (await pool.query('select id from projects')).rows[0].id as string;
const wps = (await pool.query("select id from wbs_nodes where kind='work_package' order by node_key")).rows.map((r: { id: string }) => r.id);
const codes = new Map<string, number>();
let next = 0;
const worker = async () => {
  while (next < total) {
    const i = next++;
    const r = await fetch(`${address}/api/projects/${projectId}/tasks`, { method: 'POST', headers: { origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ title: `대량 Task ${String(i + 1)}`, wbsNodeId: wps[i % wps.length], workType: 'Implementation', primaryDomain: i % 2 ? 'FE' : 'BE', overview: { purpose: 'p', background: '', scope: [], out: [], precond: '', doneCond: 'd' } }) });
    const key = r.status === 201 ? '201' : `${String(r.status)} ${((await r.json()) as { error: { code: string } }).error.code}`;
    codes.set(key, (codes.get(key) ?? 0) + 1);
  }
};
let done = false;
const reader = async () => { while (!done) { const r = await fetch(`${address}/api/projects/${projectId}/tasks`, { headers: { origin, cookie } }); const k = `list ${String(r.status)}`; codes.set(k, (codes.get(k) ?? 0) + 1); await fetch(`${address}/api/schedule`, { headers: { origin, cookie } }); } };
const readers = Array.from({ length: Number(process.argv[4] ?? 0) }, reader);
const t0 = performance.now();
await Promise.all(Array.from({ length: workers }, worker));
done = true; await Promise.all(readers);
console.log(JSON.stringify(Object.fromEntries(codes)), Math.round(performance.now() - t0), 'ms');
await app.close(); await pool.end();
