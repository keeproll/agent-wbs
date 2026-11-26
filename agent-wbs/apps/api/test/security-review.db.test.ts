import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createPool, recreateTestDatabase, runMigrations, seedSystem, type PoolClient } from '@awbs/db';
import { afterAll, beforeAll, expect, inject, test, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken, setPassword } from '../src/platform/credentials.ts';

const localOrigin = 'http://127.0.0.1:3100';
const lanOrigin = 'http://192.168.1.20:9100';
const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_review';
const owner = createPool(dbUrl.href, { onError: () => undefined });
const appUrl = new URL(dbUrl);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { max: 8, onError: () => undefined });
const app = buildApp(pool, false, { origin: lanOrigin, lan: true, port: 3100 });
let effects = 0;
let pausePasswordRead: { entered: () => void; resume: Promise<undefined> } | undefined;
app.addHook('preHandler', async (request) => {
  const pause = pausePasswordRead;
  if (!pause || request.routeOptions.url !== '/api/auth/session') return;
  pausePasswordRead = undefined;
  const client = request.platform?.client;
  assert(client);
  const query = client.query;
  client.query = function (this: PoolClient, ...args: unknown[]) {
    this.query = query;
    return (Reflect.apply(query, this, args) as Promise<unknown>).then(async (result) => {
      pause.entered();
      await pause.resume;
      return result;
    });
  } as PoolClient['query'];
});
app.post('/api/runner/usage', (request) => ({ count: ++effects, principal: request.platform?.principal }));
app.get('/api/settings/app-url', () => ({ leadData: true }));
beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  await runMigrations(owner);
  await seedSystem(owner);
  await setPassword(pool, 'correct horse battery');
});
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

const passwordLogin = (remoteAddress: string, password = 'correct horse battery') => app.inject({
  method: 'POST', url: '/api/auth/session', remoteAddress, headers: { origin: lanOrigin, 'x-forwarded-for': crypto.randomUUID() },
  payload: { method: 'password', password },
});
async function linkLogin(origin = localOrigin) {
  return app.inject({ method: 'POST', url: '/api/auth/session', remoteAddress: '127.0.0.1',
    headers: { origin }, payload: { method: 'link', token: await issueLoginLink(pool) } });
}
const cookieOf = (response: { headers: { 'set-cookie'?: string | string[] | undefined } }) => String(response.headers['set-cookie']).split(';')[0] ?? '';

test.each([3100, 80])('M1: LAN 모드에서도 API 포트 %s의 loopback Origin으로 링크 로그인한다', async (port) => {
  const local = buildApp(pool, false, { origin: lanOrigin, lan: true, port });
  try {
    const response = await local.inject({ method: 'POST', url: '/api/auth/session', remoteAddress: '127.0.0.1',
      headers: { origin: new URL(`http://127.0.0.1:${String(port)}`).origin }, payload: { method: 'link', token: await issueLoginLink(pool) } });
    expect(response.statusCode, response.body).toBe(204);
  } finally { await local.close(); }
});

test('M1·M2: LAN 공격자 제한은 다른 출처와 이 PC 링크 로그인에 영향을 주지 않는다', async () => {
  const responses = await Promise.all(Array.from({ length: 20 }, () => passwordLogin('192.168.1.50', 'wrong')));
  expect(responses.filter((response) => response.statusCode === 401)).toHaveLength(5);
  expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(15);
  expect((await passwordLogin('192.168.1.50')).statusCode).toBe(429);
  expect((await passwordLogin('192.168.1.51')).statusCode).toBe(204);
  for (let attempt = 0; attempt < 5; attempt++) expect((await passwordLogin('127.0.0.1', 'wrong')).statusCode).toBe(401);
  expect((await passwordLogin('127.0.0.1', 'wrong')).statusCode).toBe(429);
  const local = await linkLogin();
  expect(local.statusCode, local.body).toBe(204);
  const cookie = cookieOf(local);
  const session = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>();
  expect((await app.inject({ method: 'DELETE', url: '/api/auth/session', remoteAddress: '127.0.0.1', headers: { origin: localOrigin, cookie, 'x-csrf-token': session.csrfToken } })).statusCode).toBe(204);
  const token = await issueLoginLink(pool);
  expect((await app.inject({ method: 'POST', url: '/api/auth/session', remoteAddress: '192.168.1.52', headers: { origin: localOrigin }, payload: { method: 'link', token } })).statusCode).toBe(403);
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  try { expect((await passwordLogin('192.168.1.50')).statusCode).toBe(204); }
  finally { now.mockRestore(); }
});

test('M1: LAN 설정에서도 CLI 링크는 실제 API 포트의 loopback 주소로 발급한다', () => {
  const cli = new URL('../src/platform/auth-cli.ts', import.meta.url).pathname;
  const response = spawnSync(process.execPath, ['--conditions=awbs-source', cli, 'login-link'], {
    env: { DATABASE_URL: appUrl.href, AWBS_HOST: '0.0.0.0', AWBS_ALLOW_LAN: 'true', AWBS_PORT: '3100', AWBS_ORIGIN: lanOrigin }, encoding: 'utf8',
  });
  expect(response.status, response.stderr).toBe(0);
  expect(response.stdout).toMatch(/^http:\/\/127\.0\.0\.1:3100\/#login-token=/);
});

test('L1: 비밀번호 확인 중에는 재설정이 자격 증명 행을 동시에 바꾸지 못한다', async () => {
  const entered = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();
  pausePasswordRead = { entered: () => entered.resolve(undefined), resume: resume.promise };
  const login = passwordLogin('192.168.1.54');
  await entered.promise;
  const other = await owner.connect();
  try {
    await other.query('begin');
    await expect(other.query('select 1 from lead_credentials for update nowait')).rejects.toMatchObject({ code: '55P03' });
  } finally { await other.query('rollback'); other.release(); resume.resolve(undefined); await login; }
});

test('L1: 비밀번호 재설정은 비밀번호 세션만 무효화하고 링크 세션은 유지한다', async () => {
  const password = await passwordLogin('192.168.1.53');
  expect(password.statusCode).toBe(204);
  const link = await linkLogin(lanOrigin);
  expect(link.statusCode).toBe(204);
  await setPassword(pool, 'a different password');
  expect((await app.inject({ url: '/api/session', headers: { cookie: cookieOf(password) } })).statusCode).toBe(401);
  expect((await app.inject({ url: '/api/session', headers: { cookie: cookieOf(link) } })).statusCode).toBe(200);
  expect((await passwordLogin('192.168.1.53', 'correct horse battery')).statusCode).toBe(401);
  expect((await passwordLogin('192.168.1.53', 'a different password')).statusCode).toBe(204);
});

test('L3: Runner 토큰으로 팀장 GET을 호출하면 403이다', async () => {
  const token = await issueRunnerToken(pool, 'runner-read', 'fake');
  expect((await app.inject({ url: '/api/settings/app-url', headers: { authorization: `Bearer ${token}`, 'x-project-epoch': '1' } })).statusCode).toBe(403);
});

test('L3: 본문 Runner ID 위조는 업무 처리 전에 거부한다', async () => {
  const token = await issueRunnerToken(pool, 'runner-identity', 'fake');
  const before = effects;
  const response = await app.inject({ method: 'POST', url: '/api/runner/usage',
    headers: { authorization: `Bearer ${token}`, 'x-project-epoch': '1', 'idempotency-key': crypto.randomUUID() }, payload: { runnerId: 'other-runner' } });
  expect(response.statusCode).toBe(403);
  expect(effects).toBe(before);
});

test('L3: 서로 다른 Runner의 같은 멱등 키는 각각 처리하고 각자의 응답만 재생한다', async () => {
  const tokens = await Promise.all(['scope-a', 'scope-b'].map((id) => issueRunnerToken(pool, id, 'fake')));
  const key = crypto.randomUUID();
  const request = (token: string) => app.inject({ method: 'POST', url: '/api/runner/usage',
    headers: { authorization: `Bearer ${token}`, 'x-project-epoch': '1', 'idempotency-key': key }, payload: { value: 'same' } });
  const first = await Promise.all(tokens.map(request));
  expect(first.map((response) => response.statusCode)).toEqual([200, 200]);
  expect(first.map((response) => response.headers['idempotency-replayed'])).toEqual([undefined, undefined]);
  expect(first.map((response) => response.json<{ principal: string }>().principal)).toEqual(['runner:scope-a', 'runner:scope-b']);
  const replay = await Promise.all(tokens.map(request));
  expect(replay.map((response) => response.body)).toEqual(first.map((response) => response.body));
  expect(replay.map((response) => response.headers['idempotency-replayed'])).toEqual(['true', 'true']);
});

/**
 * 실행마다 비어 있는 포트를 OS에게 받는다. 고정 포트는 다른 worktree·동시 실행과 부딪쳐
 * 자식 서버가 EADDRINUSE로 바로 끝나고, 테스트는 시작 로그만 기다리다 timeout으로 실패했다(재리뷰).
 */
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  server.close();
  await once(server, 'close');
  return address.port;
}

test.each([lanOrigin, lanOrigin.replace('http:', 'https:')])('M1·L4: LAN %s 기동의 경고와 실제 loopback 링크 로그인을 확인한다', async (origin) => {
  const main = new URL('../src/main.ts', import.meta.url).pathname;
  const port = await freePort();
  const child = spawn(process.execPath, ['--conditions=awbs-source', main], {
    env: { DATABASE_URL: appUrl.href, AWBS_HOST: '0.0.0.0', AWBS_ALLOW_LAN: 'true', AWBS_ORIGIN: origin, AWBS_PORT: String(port) },
  });
  let output = '';
  let exited = false;
  const closed = once(child, 'close').then((result) => { exited = true; return result; });
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  try {
    // 자식이 시작 로그 전에 끝나면(포트 충돌 등) 기다리지 않고 그 출력과 함께 바로 실패한다.
    while (!output.includes('Server listening')) {
      await Promise.race([once(child.stdout, 'data'), closed]);
      if (exited && !output.includes('Server listening')) throw new Error(`API 서버가 시작 전에 종료되었습니다(exit ${String(child.exitCode)}):\n${output}`);
    }
    assert(child.pid);
    if (origin.startsWith('http:')) {
      expect(output).toContain('비밀번호와 세션');
      expect(output).toContain('같은 네트워크');
      expect(output).toContain('"level":40');
    } else expect(output).not.toContain('비밀번호와 세션');
    const localOrigin = `http://127.0.0.1:${String(port)}`;
    const login = await fetch(`${localOrigin}/api/auth/session`, { method: 'POST', headers: { origin: localOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'link', token: await issueLoginLink(pool) }) });
    expect(login.status).toBe(204);
    expect(login.headers.get('set-cookie')).not.toContain('Secure');
  } finally { child.kill('SIGTERM'); await closed; }
});
