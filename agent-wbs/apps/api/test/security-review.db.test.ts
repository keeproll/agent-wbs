import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { afterAll, beforeAll, expect, inject, test, vi } from 'vitest';
import { datePin } from '../src/platform/date-pin.ts';
import { buildApp } from '../src/app.ts';
import { loggerOptions } from '../src/log.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';

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
app.post('/api/runner/usage', (request) => ({ count: ++effects, principal: request.platform?.principal }));
beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  await runMigrations(owner);
  await seedSystem(owner);
});
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

const pinLogin = (remoteAddress: string, pin = datePin(Date.now())) => app.inject({
  method: 'POST', url: '/api/auth/session', remoteAddress, headers: { origin: lanOrigin, 'x-forwarded-for': crypto.randomUUID() },
  payload: { method: 'pin', pin },
});
async function linkLogin(origin = localOrigin) {
  return app.inject({ method: 'POST', url: '/api/auth/session', remoteAddress: '127.0.0.1',
    headers: { origin }, payload: { method: 'link', token: await issueLoginLink(pool) } });
}
const cookieOf = (response: { headers: { 'set-cookie'?: string | string[] | undefined } }) => String(response.headers['set-cookie']).split(';')[0] ?? '';

test.each(['Asia/Seoul', 'America/Los_Angeles'])('PIN API는 주입 시계와 %s 시간대의 날짜만 허용한다', async pinTimeZone => {
  const at = Date.parse('2026-11-28T03:00:00Z');
  const local = buildApp(pool, false, { origin: localOrigin, lan: true, pinTimeZone, now: () => at });
  const today = pinTimeZone === 'Asia/Seoul' ? '261128' : '261127';
  const adjacent = pinTimeZone === 'Asia/Seoul' ? ['261127', '261129'] : ['261126', '261128'];
  try {
    for (const pin of [today, ...adjacent, '123456']) {
      const result = await local.inject({ method: 'POST', url: '/api/auth/session', headers: { origin: localOrigin }, payload: { method: 'pin', pin } });
      expect(result.statusCode).toBe(pin === today ? 204 : 401);
    }
    for (const pin of ['abcdef', '12345', '1234567']) {
      expect((await local.inject({ method: 'POST', url: '/api/auth/session', headers: { origin: localOrigin }, payload: { method: 'pin', pin } })).statusCode).toBe(400);
    }
    expect((await local.inject({ method: 'POST', url: '/api/auth/session', headers: { origin: 'http://evil.test' }, payload: { method: 'pin', pin: today } })).statusCode).toBe(403);
  } finally { await local.close(); }
});

test('자정 전후와 시계 역행 때 API도 두 날짜를 허용한다', async () => {
  const midnight = Date.parse('2026-11-28T15:00:00Z');
  let now = midnight;
  const local = buildApp(pool, false, { origin: localOrigin, lan: true, now: () => now });
  try {
    let address = 1;
    for (const offset of [-5_001, -5_000, 1, -2_299, 4_999, 5_000]) {
      now = midnight + offset;
      for (const pin of ['261128', '261129']) {
        const result = await local.inject({ method: 'POST', url: '/api/auth/session', remoteAddress: `192.168.1.${String(address++)}`, headers: { origin: localOrigin }, payload: { method: 'pin', pin } });
        expect(result.statusCode).toBe(offset < -5_000 && pin === '261129' || offset >= 5_000 && pin === '261128' ? 401 : 204);
      }
    }
  } finally { await local.close(); }
});

test('PIN 성공·실패·형식 오류에서 PIN 값은 로그에 남지 않고 옛 API 이름은 거부한다', async () => {
  let logs = '';
  const local = buildApp(pool, loggerOptions('info', { write: line => { logs += line; } }), {
    origin: localOrigin, lan: true, now: () => Date.parse('2026-11-28T03:00:00Z'),
  });
  try {
    for (const [pin, status] of [['261128', 204], ['123456', 401], ['12345x', 400]] as const) {
      expect((await local.inject({ method: 'POST', url: '/api/auth/session', headers: { origin: localOrigin }, payload: { method: 'pin', pin } })).statusCode).toBe(status);
      expect(logs).not.toContain(pin);
    }
    expect((await local.inject({ method: 'POST', url: '/api/auth/session', headers: { origin: localOrigin }, payload: { method: 'password', password: 'obsolete' } })).statusCode).toBe(400);
    expect(logs).not.toContain('obsolete');
    expect(logs).toContain('/api/auth/session');
  } finally { await local.close(); }
});

test.each([3100, 80])('M1: LAN 모드에서도 API 포트 %s의 loopback Origin으로 링크 로그인한다', async (port) => {
  const local = buildApp(pool, false, { origin: lanOrigin, lan: true, port });
  try {
    const response = await local.inject({ method: 'POST', url: '/api/auth/session', remoteAddress: '127.0.0.1',
      headers: { origin: new URL(`http://127.0.0.1:${String(port)}`).origin }, payload: { method: 'link', token: await issueLoginLink(pool) } });
    expect(response.statusCode, response.body).toBe(204);
  } finally { await local.close(); }
});

test('M1·M2: LAN 공격자 제한은 다른 출처와 이 PC 링크 로그인에 영향을 주지 않는다', async () => {
  const at = Date.now();
  const now = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    const responses = await Promise.all(Array.from({ length: 20 }, () => pinLogin('192.168.1.50', '000000')));
    expect(responses.filter((response) => response.statusCode === 401)).toHaveLength(5);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(15);
    expect((await pinLogin('192.168.1.50')).statusCode).toBe(429);
    expect((await pinLogin('192.168.1.51')).statusCode).toBe(204);
    for (let attempt = 0; attempt < 5; attempt++) expect((await pinLogin('127.0.0.1', '000000')).statusCode).toBe(401);
    expect((await pinLogin('127.0.0.1', '000000')).statusCode).toBe(429);
    const local = await linkLogin();
    expect(local.statusCode, local.body).toBe(204);
    const cookie = cookieOf(local);
    const session = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>();
    expect((await app.inject({ method: 'DELETE', url: '/api/auth/session', remoteAddress: '127.0.0.1', headers: { origin: localOrigin, cookie, 'x-csrf-token': session.csrfToken } })).statusCode).toBe(204);
    const token = await issueLoginLink(pool);
    expect((await app.inject({ method: 'POST', url: '/api/auth/session', remoteAddress: '192.168.1.52', headers: { origin: localOrigin }, payload: { method: 'link', token } })).statusCode).toBe(403);
    now.mockReturnValue(at + 61_000);
    expect((await pinLogin('192.168.1.50')).statusCode).toBe(204);
  } finally { now.mockRestore(); }
});

test('M1: LAN 설정에서도 CLI 링크는 실제 API 포트의 loopback 주소로 발급한다', () => {
  const cli = new URL('../src/platform/auth-cli.ts', import.meta.url).pathname;
  const response = spawnSync(process.execPath, ['--conditions=awbs-source', cli, 'login-link'], {
    env: { DATABASE_URL: appUrl.href, AWBS_HOST: '0.0.0.0', AWBS_ALLOW_LAN: 'true', AWBS_PORT: '3100', AWBS_ORIGIN: lanOrigin }, encoding: 'utf8',
  });
  expect(response.status, response.stderr).toBe(0);
  expect(response.stdout).toMatch(/^http:\/\/127\.0\.0\.1:3100\/#login-token=/);
});

test('옛 비밀번호 해시는 무시하고 날짜가 바뀌어도 발급된 PIN 세션은 유지한다', async () => {
  await pool.query("insert into lead_credentials(password_hash) values('obsolete-hash') on conflict(singleton) do update set password_hash=excluded.password_hash");
  const at = Date.parse('2026-11-28T14:59:59Z');
  let now = at;
  const local = buildApp(pool, false, { origin: localOrigin, lan: true, now: () => now });
  try {
    const login = await local.inject({ method: 'POST', url: '/api/auth/session', headers: { origin: localOrigin }, payload: { method: 'pin', pin: '261128' } });
    expect(login.statusCode).toBe(204);
    now = at + 60_000;
    expect((await local.inject({ url: '/api/session', headers: { cookie: cookieOf(login) } })).statusCode).toBe(200);
    expect((await local.inject({ method: 'POST', url: '/api/auth/session', headers: { origin: localOrigin }, payload: { method: 'pin', pin: '261128' } })).statusCode).toBe(401);
    expect((await local.inject({ method: 'POST', url: '/api/auth/session', headers: { origin: localOrigin }, payload: { method: 'pin', pin: '261129' } })).statusCode).toBe(204);
    expect((await pool.query('select password_hash from lead_credentials')).rows[0]).toEqual({ password_hash: 'obsolete-hash' });
  } finally { await local.close(); }
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
    env: { DATABASE_URL: appUrl.href, AWBS_HOST: '0.0.0.0', AWBS_ALLOW_LAN: 'true', AWBS_ORIGIN: origin, AWBS_PORT: String(port), AWBS_PIN_TIME_ZONE: 'America/Los_Angeles' },
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
    expect(output).toContain('같은 네트워크 누구나 날짜로 접속 가능');
    expect(output).toContain('America/Los_Angeles');
    if (origin.startsWith('http:')) {
      expect(output).toContain('PIN과 세션');
      expect(output).toContain('같은 네트워크');
      expect(output).toContain('"level":40');
    } else expect(output).not.toContain('PIN과 세션');
    const localOrigin = `http://127.0.0.1:${String(port)}`;
    const pin = datePin(Date.now(), 'America/Los_Angeles');
    const pinLogin = await fetch(`${localOrigin}/api/auth/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'pin', pin }) });
    expect(pinLogin.status).toBe(204);
    expect(output).not.toContain(pin);
    const login = await fetch(`${localOrigin}/api/auth/session`, { method: 'POST', headers: { origin: localOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'link', token: await issueLoginLink(pool) }) });
    expect(login.status).toBe(204);
    expect(login.headers.get('set-cookie')).not.toContain('Secure');
  } finally { child.kill('SIGTERM'); await closed; }
});
