import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { OPERATIONS } from '@awbs/shared/api';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken, setPassword, tokenHash } from '../src/platform/credentials.ts';
import { assertLanPassword } from '../src/platform/security.ts';
import { inEpoch } from '../src/platform/transaction.ts';

const origin = 'http://127.0.0.1:3100';
const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_security';
const ownerPool = createPool(dbUrl.href, { max: 4, onError: () => undefined });
const appUrl = new URL(dbUrl);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { max: 8, onError: () => undefined });
const app = buildApp(pool, false, { origin, lan: false });
// 대역은 아직 실제 업무 경로가 없는 Runner 계약 경로에만 둔다. 실제 경로(M2-07 Planning 등)와 겹치면 Fastify가 중복 선언으로 기동을 거부한다.
// 플러그인(app.register)으로 등록한 경로는 ready 뒤에야 hasRoute에 보이므로 별도 앱을 띄워 확인한다(M2-07 방식).
const probe = buildApp(pool, false, { origin, lan: false });
await probe.ready();
const implemented = OPERATIONS.filter((op) => op.principal === 'runner' && probe.hasRoute({ method: op.method, url: op.path }));
await probe.close();
const runnerOps = OPERATIONS.filter((op) => op.principal === 'runner' && !implemented.includes(op));
let bearer = '';
let cookie = '';
let csrf = '';
let effects = 0;
let pauseAfterAuth: { entered: () => void; resume: Promise<void> } | undefined;
app.addHook('preValidation', async (request) => {
  if (((request.body as { value?: string } | undefined)?.value === 'delayed' || request.url.includes('?delay=1')) && pauseAfterAuth) {
    pauseAfterAuth.entered();
    await pauseAfterAuth.resume;
  }
});

// 실제 업무 구현은 후속 작업이다. 모든 Runner 계약 경로에 같은 보안 관문을 검증한다.
for (const op of runnerOps) {
  app.route({ method: op.method, url: op.path, handler: async (request, reply) => {
    effects++;
    const value = (request.body as { value?: string } | undefined)?.value;
    if (op.id === 'reportUsage' && value) {
      assert(request.platform?.client);
      await request.platform.client.query('insert into security_effects(value) values($1)', [value]);
      if (value.startsWith('committed-')) request.platform.commitOnError = true;
      if (value.endsWith('failure')) throw new Error('Bearer hunter2');
      if (value.endsWith('rejection')) return reply.code(409).send({ error: '업무 처리 거부' });
    }
    if (op.id === 'heartbeat' || op.id === 'reportCommandResult') return reply.code(204).send();
    if (op.id === 'getCommands') return { currentEpoch: request.platform?.currentEpoch, commands: [] };
    return { count: effects };
  } });
}
// 초기화(/api/project/reset)는 M2-04, 착수 승인(/api/tasks/:taskKey/approve)은 M2-02, 프로젝트 등록(/api/project)은 M2-03의 실제 경로가 같은 관문을 거치므로 대역을 두지 않는다.
app.addHook('preHandler', async request => {
  if (request.routeOptions.url === '/api/settings/app-url') throw new Error('Bearer hunter2 /bot123:hunter2/send');
});

beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  await runMigrations(ownerPool);
  await seedSystem(ownerPool);
  await ownerPool.query('create table security_effects(value text not null)');
  await ownerPool.query('grant select,insert on security_effects to awbs_app');
  await ownerPool.query("insert into runner_commands(id,kind,epoch,payload,status) values('11111111-1111-4111-8111-111111111111','reset-cleanup',1,'{}','pending')");
  bearer = await issueRunnerToken(pool, 'test-runner', 'fake-public-key');
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
  expect(login.statusCode, login.body).toBe(204);
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
});
afterAll(async () => { await app.close(); await pool.end(); await ownerPool.end(); });

const urlOf = (path: string) => path.replace(/:\w+/g, '11111111-1111-4111-8111-111111111111');
function runnerHeaders(key = crypto.randomUUID(), epoch = '1') {
  return { authorization: `Bearer ${bearer}`, 'x-project-epoch': epoch, 'idempotency-key': key };
}

test.each(implemented)('$id: 실제 결과·Evidence 경로도 공통 인증·세대 관문을 거친다', async op => {
  const request = { method:op.method,url:urlOf(op.path) };
  expect((await app.inject(request)).statusCode).toBe(401);
  expect((await app.inject({ ...request,headers:{ cookie,origin,'x-csrf-token':csrf } })).statusCode).toBe(401);
  expect((await app.inject({ ...request,headers:runnerHeaders(undefined,'0') })).statusCode).toBe(409);
});

describe('security contracts §8 Runner 전체 5종 표', () => {
  for (const op of runnerOps) {
    test(`${op.id}: 무토큰·팀장·낡은 세대·재전송·충돌`, async () => {
      const url = urlOf(op.path);
      const base = { method: op.method, url };
      expect((await app.inject(base)).statusCode).toBe(401);
      expect((await app.inject({ ...base, headers: { cookie, origin, 'x-csrf-token': csrf } })).statusCode).toBe(401);
      expect((await app.inject({ ...base, headers: runnerHeaders(undefined, '2') })).statusCode).toBe(409);
      const stale = await app.inject({ ...base, headers: runnerHeaders(undefined, '0') });
      if (!op.staleEpoch) expect(stale.json()).toMatchObject({ error: { code: 'EPOCH_MISMATCH', details: { currentEpoch: 1 } } });
      else if (op.id === 'reportCommandResult') expect(stale.statusCode).toBe(409);
      else expect(stale.statusCode).toBeLessThan(300);
      if (op.id === 'heartbeat') expect(stale.headers['x-current-epoch']).toBe('1');
      if (op.id === 'getCommands') expect(stale.json()).toMatchObject({ currentEpoch: 1 });
      const key = crypto.randomUUID();
      const headers = runnerHeaders(key);
      const payload = op.method === 'GET' ? undefined : { value: 'same' };
      const request = { ...base, headers, ...(payload ? { payload } : {}) };
      const first = await app.inject(request);
      expect(first.statusCode, first.body).toBeLessThan(300);
      const repeated = await app.inject(request);
      if (op.idempotency === 'none') return;
      expect(repeated.headers['idempotency-replayed']).toBe('true');
      expect(repeated.body).toBe(first.body);
      const conflict = await app.inject({ ...request, payload: { value: 'different' } });
      expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    });
  }
});

test('링크는 hash 저장·1회 소비·만료·소켓 loopback 판정', async () => {
  const token = await issueLoginLink(pool);
  const query = await pool.query('select token_hash from lead_login_tokens where token_hash=$1', [tokenHash(token)]);
  expect(query.rows).toHaveLength(1);
  const request = { method: 'POST' as const, url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } };
  const lan = await app.inject({ ...request, remoteAddress: '192.168.1.5', headers: { origin, 'x-forwarded-for': '127.0.0.1' } });
  expect(lan.statusCode).toBe(401);
  const results = await Promise.all([app.inject(request), app.inject(request)]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([204, 401]);
  const expired = await issueLoginLink(pool);
  await pool.query("update lead_login_tokens set expires_at=now()-interval '1 hour' where used_at is null");
  expect((await app.inject({ ...request, payload: { method: 'link', token: expired } })).statusCode).toBe(401);
  expect(results.find((r) => r.statusCode === 204)?.headers['set-cookie']).toMatch(/HttpOnly; SameSite=Strict/);
});

test('팀장 변경은 Origin·CSRF 일치, Runner의 팀장 호출은 403', async () => {
  for (const headers of [{ cookie }, { cookie, origin }, { cookie, origin, 'x-csrf-token': 'wrong' }, { cookie, origin: 'http://evil.test', 'x-csrf-token': csrf }]) {
    expect((await app.inject({ method: 'POST', url: '/api/project/reset', headers, payload: { epoch: 1 } })).statusCode).toBe(403);
  }
  for (const url of ['/api/project', '/api/project/reset', '/api/tasks/TASK-0001/approve']) {
    expect((await app.inject({ method: 'POST', url, headers: runnerHeaders(), payload: { epoch: 1 } })).statusCode).toBe(403);
  }
  expect((await app.inject({ method: 'POST', url: '/api/auth/session', payload: { method: 'link', token: 'x' } })).statusCode).toBe(403);
  const token = await issueLoginLink(pool);
  expect((await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin: 'http://evil.test' }, payload: { method: 'link', token } })).statusCode).toBe(403);
});

test('세션 정보는 캐시하지 않고 만료된 세션은 사용할 수 없다', async () => {
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  const session = await app.inject({ url: '/api/session', headers: { cookie } });
  expect(session.json()).toMatchObject({ principal: 'lead', method: 'link', expiresAt: expect.any(String), csrfToken: expect.any(String) });
  expect(session.headers['cache-control']).toBe('no-store');
  await pool.query("update lead_sessions set expires_at=now()-interval '1 hour' where token_hash=$1", [tokenHash(cookie.slice('awbs_session='.length))]);
  expect((await app.inject({ url: '/api/session', headers: { cookie } })).statusCode).toBe(401);
});

test('LAN 비밀번호 미설정 기동 거부·시도 제한·세션 교체·로그아웃', async () => {
  await expect(assertLanPassword(pool)).rejects.toThrow();
  const main = new URL('../src/main.ts', import.meta.url).pathname;
  const startup = spawnSync(process.execPath, ['--conditions=awbs-source', main], {
    env: { DATABASE_URL: appUrl.href, AWBS_HOST: '0.0.0.0', AWBS_ALLOW_LAN: 'true', AWBS_ORIGIN: origin },
    encoding: 'utf8', timeout: 5000,
  });
  expect(startup.status, startup.stderr).toBe(1);
  expect(startup.stdout).toContain('기동 실패');
  expect(startup.stdout).not.toContain('Server listening');
  await setPassword(pool, 'correct horse battery');
  await expect(assertLanPassword(pool)).resolves.toBeUndefined();
  expect((await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'password', password: 'correct horse battery' } })).statusCode).toBe(401);
  const lan = buildApp(pool, false, { origin, lan: true });
  try {
    const login = () => lan.inject({ method: 'POST', url: '/api/auth/session', headers: { origin, cookie }, payload: { method: 'password', password: 'correct horse battery' } });
    const response = await login();
    expect(response.statusCode, response.body).toBe(204);
    expect((await app.inject({ url: '/api/session', headers: { cookie } })).statusCode).toBe(401);
    const newCookie = String(response.headers['set-cookie']).split(';')[0] ?? '';
    const session = (await lan.inject({ url: '/api/session', headers: { cookie: newCookie } })).json<{ method: string; csrfToken: string }>();
    expect(session.method).toBe('password');
    const logout = await lan.inject({ method: 'DELETE', url: '/api/auth/session', headers: { cookie: newCookie, origin, 'x-csrf-token': session.csrfToken } });
    expect(logout.statusCode).toBe(204);
    expect((await lan.inject({ url: '/api/session', headers: { cookie: newCookie } })).statusCode).toBe(401);
    for (let i = 0; i < 4; i++) await lan.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'password', password: 'wrong' } });
    const limited = await login();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  } finally { await lan.close(); }
});

test('동일 키 동시 전송은 한 번 처리하고 다른 경로의 키 재사용은 충돌한다', async () => {
  const before = effects;
  const headers = runnerHeaders();
  const request = { method: 'POST' as const, url: '/api/runner/usage', headers, payload: { value: 'concurrent' } };
  const responses = await Promise.all([app.inject(request), app.inject(request)]);
  expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(effects - before).toBe(1);
  expect((await pool.query("select count(*)::int as n from security_effects where value='concurrent'")).rows).toEqual([{ n: 1 }]);
  expect((await app.inject({ ...request, url: '/api/runner/readiness' })).statusCode).toBe(409);
});

test('실패한 업무·직접 보낸 거부 응답은 업무 변경과 멱등 기록을 함께 되돌린다', async () => {
  for (const value of ['failure', 'rejection']) {
    const headers = runnerHeaders();
    const response = await app.inject({ method: 'POST', url: '/api/runner/usage', headers, payload: { value } });
    expect(response.statusCode).toBe(value === 'failure' ? 500 : 409);
    expect((await pool.query('select count(*)::int as n from security_effects where value=$1', [value])).rows).toEqual([{ n: 0 }]);
    expect((await pool.query('select count(*)::int as n from idempotency_keys where key=$1', [headers['idempotency-key']])).rows).toEqual([{ n: 0 }]);
  }
});

test.each([
  { value: 'committed-rejection', status: 409, count: 1 },
  { value: 'committed-failure', status: 500, count: 0 },
])('commitOnError $status: 저장한 4xx만 재생하고 5xx는 업무·멱등 기록을 되돌린다', async ({ value, status, count }) => {
  const headers = runnerHeaders();
  const request = { method: 'POST' as const, url: '/api/runner/usage', headers, payload: { value } };
  const first = await app.inject(request);
  const repeated = await app.inject(request);
  expect([first.statusCode, repeated.statusCode]).toEqual([status, status]);
  expect(repeated.headers['idempotency-replayed']).toBe(count ? 'true' : undefined);
  if (count) expect(repeated.body).toBe(first.body);
  expect((await pool.query('select count(*)::int n from security_effects where value=$1', [value])).rows).toEqual([{ n: count }]);
  expect((await pool.query('select count(*)::int n from idempotency_keys where key=$1', [headers['idempotency-key']])).rows).toEqual([{ n: count }]);
});

test('앱을 다시 만들어도 저장한 응답을 재생하고 JSON 필드 순서는 키 충돌로 보지 않는다', async () => {
  const headers = runnerHeaders();
  const first = await app.inject({ method: 'POST', url: '/api/runner/usage', headers, payload: { a: 1, b: 2 } });
  const restarted = buildApp(pool, false, { origin, lan: false });
  restarted.post('/api/runner/usage', () => { throw new Error('재처리하면 안 됩니다.'); });
  try {
    const replay = await restarted.inject({ method: 'POST', url: '/api/runner/usage', headers, payload: { b: 2, a: 1 } });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.body).toBe(first.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
  } finally { await restarted.close(); }
});

test('인증 CLI는 링크의 URL fragment·비밀번호 표준 입력·오류 비밀값 생략을 지원한다', () => {
  const cli = new URL('../src/platform/auth-cli.ts', import.meta.url).pathname;
  const run = (command: string, input = '') => spawnSync(process.execPath, ['--conditions=awbs-source', cli, command], {
    env: { DATABASE_URL: appUrl.href }, encoding: 'utf8', input,
  });
  const link = run('login-link');
  expect(link.status, link.stderr).toBe(0);
  expect(link.stdout).toMatch(/^http:\/\/127\.0\.0\.1:3100\/#login-token=[A-Za-z0-9_-]{43}\n$/);
  expect(link.stderr).toBe('');
  const password = run('set-password', 'CLI password only\n');
  expect(password.status, password.stderr).toBe(0);
  expect(password.stdout + password.stderr).not.toContain('CLI password only');
  const bad = run('unknown-secret-hunter2');
  expect(bad.status).toBe(1);
  expect(bad.stdout + bad.stderr).not.toContain('hunter2');
});

test('폐기 토큰·누락 세대·누락 멱등 키를 거부한다', async () => {
  const url = '/api/runner/usage';
  expect((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${bearer}` } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${bearer}`, 'x-project-epoch': '1' } })).json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
  const revoked = await issueRunnerToken(pool, 'revoked', 'fake');
  await pool.query('update runner_tokens set revoked_at=now() where runner_id=$1', ['revoked']);
  expect((await app.inject({ method: 'POST', url, headers: { ...runnerHeaders(), authorization: `Bearer ${revoked}` } })).statusCode).toBe(401);
});

test('공통 오류는 입력 원문·스택·비밀값을 노출하지 않는다', async () => {
  // 앞의 테스트가 세션을 교체했으므로 별도 링크로 다시 로그인한다.
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] ?? '' };
  for (const url of ['/api/settings/app-url', '/missing?token=hunter2', '/%zz?token=hunter2']) {
    const response = await app.inject({ url, headers });
    expect(response.json()).toMatchObject({ error: { code: expect.any(String), message: expect.any(String), action: expect.any(String), fix: expect.any(String), errors: [], details: {}, requestId: expect.any(String) } });
    expect(response.body).not.toMatch(/hunter2|stack|Error:/);
  }
});

test('middleware 통과 뒤 초기화가 끝난 요청은 잠금 안에서 다시 확인해 쓰기를 거부한다', async () => {
  await pool.query("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('경합 시험','https://github.com/test/security','test','security','','boot')");
  const entered = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();
  let waiting = 0;
  pauseAfterAuth = { entered: () => { if (++waiting === 4) entered.resolve(undefined); }, resume: resume.promise };
  const pending = app.inject({ method: 'POST', url: '/api/runner/usage', headers: runnerHeaders(), payload: { value: 'delayed' } });
  const pendingRead = app.inject({ url: '/api/runner/messages?delay=1', headers: runnerHeaders() });
  const pendingHeartbeat = app.inject({ method: 'POST', url: '/api/runner/heartbeat', headers: runnerHeaders(undefined, '0'), payload: { value: 'delayed', runnerId: 'test-runner', epoch: 0, version: 'fake' } });
  const pendingCommands = app.inject({ url: '/api/runner/commands?delay=1', headers: runnerHeaders(undefined, '0') });
  try {
    await entered.promise;
    await ownerPool.query("select public.reset_project(1,'경합 시험',true,'lead')");
  } finally { resume.resolve(undefined); pauseAfterAuth = undefined; }
  const response = await pending;
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json()).toMatchObject({ error: { code: 'EPOCH_MISMATCH', details: { currentEpoch: 2 } } });
  expect((await pendingRead).statusCode).toBe(409);
  const heartbeat = await pendingHeartbeat;
  expect(heartbeat.statusCode).toBe(204);
  expect(heartbeat.headers['x-current-epoch']).toBe('2');
  const commands = await pendingCommands;
  expect(commands.statusCode).toBe(200);
  expect(commands.json()).toMatchObject({ currentEpoch: 2 });
  const resultUrl = '/api/runner/commands/11111111-1111-4111-8111-111111111111/result';
  expect((await app.inject({ method: 'POST', url: resultUrl, headers: runnerHeaders(undefined, '1'), payload: { status: 'done' } })).statusCode).toBe(204);
  expect((await app.inject({ method: 'POST', url: resultUrl, headers: runnerHeaders(undefined, '2'), payload: { status: 'done' } })).statusCode).toBe(409);
  expect((await pool.query("select count(*)::int as n from security_effects where value='delayed'")).rows).toEqual([{ n: 0 }]);
});

test('초기화 응답은 프로젝트 삭제 뒤에도 저장되어 같은 키 재전송 때 다시 초기화하지 않는다', async () => {
  await pool.query("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('재전송 시험','https://github.com/test/security','test','security','','boot')");
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  const session = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>();
  const request = { method: 'POST' as const, url: '/api/project/reset', headers: { cookie, origin, 'x-csrf-token': session.csrfToken, 'idempotency-key': 'reset-once' }, payload: { epoch: 2, confirmName: '재전송 시험', keepSettings: true } };
  const first = await app.inject(request);
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json()).toEqual({ epoch: 3 });
  const replay = await app.inject(request);
  expect(replay.body).toBe(first.body);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect((await pool.query('select epoch from system_state')).rows).toEqual([{ epoch: 3 }]);
});

test('worker의 세대 잠금은 초기화와 겹치지 않으며 교착 재시도는 2회로 제한한다', async () => {
  expect((await pool.query('select epoch from system_state')).rows).toEqual([{ epoch: 3 }]);
  const entered = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();
  const work = inEpoch(pool, 3, async (client) => { entered.resolve(undefined); await resume.promise; await client.query("insert into security_effects(value) values('locked-worker')"); });
  await entered.promise;
  const other = await ownerPool.connect();
  try {
    await other.query('begin');
    await other.query("set local lock_timeout='50ms'");
    await expect(other.query('select epoch from system_state where id=1 for update')).rejects.toMatchObject({ code: '55P03' });
  } finally { await other.query('rollback'); other.release(); resume.resolve(undefined); }
  await work;
  let retries = 0;
  await expect(inEpoch(pool, 3, () => { retries++; throw Object.assign(new Error('교착 시험'), { code: '40P01' }); })).rejects.toMatchObject({ code: '40P01' });
  expect(retries).toBe(3);
  await expect(inEpoch(pool, 2, async () => { throw new Error('낡은 작업이 실행되면 안 됩니다.'); })).rejects.toMatchObject({ code: 'AW001' });
});
