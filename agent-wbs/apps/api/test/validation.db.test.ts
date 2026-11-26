import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { OPERATIONS } from '@awbs/shared/api';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';

const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_validation';
const owner = createPool(dbUrl.href, { onError: () => undefined });
const appUrl = new URL(dbUrl);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { onError: () => undefined });
const app = buildApp(pool);
const origin = 'http://127.0.0.1:3100';
let bearer = '';
let cookie = '';
let csrf = '';
let reached = 0;
app.addSchema({ $id: 'ValidationRow', type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false });
const query = { type: 'object', properties: {
  includeDeleted: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, tags: { type: 'array', items: { type: 'string' } }, q: { type: 'string' }, values: { type: 'array', items: { type: 'number' } },
}, additionalProperties: false };
app.post('/api/runner/usage', { schema: { body: {
  type: 'object', properties: { priority: { type: 'integer' }, enabled: { type: 'boolean' }, rows: { type: 'array', items: { $ref: 'ValidationRow#' } } },
  required: ['priority', 'enabled', 'rows'], additionalProperties: false,
} } }, (request) => { reached++; return request.body; });
app.get('/api/runner/messages', { schema: { querystring: query } }, (request) => request.query);
app.get('/api/changes', { schema: { querystring: OPERATIONS.find((op) => op.id === 'getChanges')?.query } }, (request) => request.query);
app.post('/api/project/reset', { schema: { body: OPERATIONS.find((op) => op.id === 'resetProject')?.body } }, () => { reached++; return { epoch: 1 }; });
beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  await runMigrations(owner);
  await seedSystem(owner);
  bearer = await issueRunnerToken(pool, 'validation-runner', 'fake');
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
  expect(login.statusCode).toBe(204);
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
});
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

const headers = () => ({ authorization: `Bearer ${bearer}`, 'x-project-epoch': '1', 'idempotency-key': crypto.randomUUID() });
const valid = () => ({ priority: 1, enabled: true, rows: [{ title: '유효한 항목' }] });
interface InputResponse { error: { code: string; errors: { path: string; rule: string; message: string }[] } }

describe('엄격한 본문 검증', () => {
  test.each(['extraField', 'toString'])('미선언 %s 필드는 지우지 않고 거부한다', async (key) => {
    const before = reached;
    const response = await app.inject({ method: 'POST', url: '/api/runner/usage', headers: headers(), payload: { ...valid(), [key]: 'secret-value-do-not-echo' } });
    expect(response.statusCode).toBe(400);
    expect(response.json<InputResponse>().error.errors).toContainEqual({ path: key, rule: 'additionalProperties', message: expect.any(String) });
    expect(reached).toBe(before);
    expect(response.body).not.toContain('secret-value-do-not-echo');
  });

  test.each([
    ['숫자 문자열', { priority: '1' }, 'priority'],
    ['불리언 문자열', { enabled: 'true' }, 'enabled'],
    ['null', { priority: null }, 'priority'],
    ['배열 대신 단일 객체', { rows: { title: '항목' } }, 'rows'],
  ])('%s를 정상 타입으로 고치지 않는다', async (_label, change, path) => {
    const response = await app.inject({ method: 'POST', url: '/api/runner/usage', headers: headers(), payload: { ...valid(), ...change } });
    expect(response.statusCode).toBe(400);
    expect(response.json<InputResponse>().error.errors).toContainEqual({ path, rule: 'type', message: expect.any(String) });
  });

  test('중첩 배열의 누락 필드 경로와 required 규칙을 반환한다', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/runner/usage', headers: headers(), payload: { ...valid(), rows: [{}] } });
    expect(response.statusCode).toBe(400);
    expect(response.json<InputResponse>().error.errors).toContainEqual({ path: 'rows.0.title', rule: 'required', message: expect.any(String) });
  });

  test('타입이 맞는 본문과 외부 참조 스키마는 그대로 처리한다', async () => {
    const payload = valid();
    const response = await app.inject({ method: 'POST', url: '/api/runner/usage', headers: headers(), payload });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(payload);
  });

  test('실제 로그인도 extraField를 제거해 성공시키지 않고 링크를 소비하지 않는다', async () => {
    const token = await issueLoginLink(pool);
    const request = { method: 'POST' as const, url: '/api/auth/session', headers: { origin } };
    const rejected = await app.inject({ ...request, payload: { method: 'link', token, extraField: 'secret-value-do-not-echo' } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<InputResponse>().error.errors).toContainEqual({ path: 'extraField', rule: 'additionalProperties', message: expect.any(String) });
    expect(rejected.body).not.toContain(token);
    expect((await app.inject({ ...request, payload: { method: 'link', token } })).statusCode).toBe(204);
  });

  test('실제 로그인의 누락 token을 errors[]로 안내한다', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link' } });
    expect(response.statusCode).toBe(400);
    expect(response.json<InputResponse>().error.errors).toContainEqual({ path: 'token', rule: 'required', message: expect.any(String) });
  });
});

describe('명시한 쿼리 변환 정책', () => {
  test.each(['Infinity', '1e400'])('상한 없는 실제 계약의 after=%s도 거부한다', async (after) => {
    const response = await app.inject({ url: `/api/changes?after=${after}&limit=2`, headers: { cookie } });
    expect(response.statusCode).toBe(400);
    expect(response.json<InputResponse>().error.errors).toContainEqual({ path: 'after', rule: 'finite', message: expect.any(String) });
  });

  test('숫자 필드가 아닌 검색 문자열 Infinity는 유지한다', async () => {
    const response = await app.inject({ url: '/api/runner/messages?q=Infinity', headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ q: 'Infinity' });
  });

  test('숫자 배열 안의 무한대도 항목 경로를 알려 주며 거부한다', async () => {
    const response = await app.inject({ url: '/api/runner/messages?values=2&values=Infinity', headers: headers() });
    expect(response.statusCode).toBe(400);
    expect(response.json<InputResponse>().error.errors).toContainEqual({ path: 'values.1', rule: 'finite', message: expect.any(String) });
  });

  test.each(['Infinity', '-Infinity', '1e400', '-1e400'])('쿼리 limit=%s는 유한한 정수가 아니므로 거부한다', async (limit) => {
    const response = await app.inject({ url: `/api/runner/messages?limit=${limit}`, headers: headers() });
    expect(response.statusCode).toBe(400);
    expect(response.json<InputResponse>().error).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'limit', rule: expect.any(String), message: expect.any(String) }] });
  });

  test.each(['2', '2.0', '2e0', ' 2 '])('유효한 10진 쿼리 limit=%s는 숫자 2로 해석한다', async (limit) => {
    const response = await app.inject({ url: `/api/runner/messages?limit=${encodeURIComponent(limit)}`, headers: headers() });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ limit: 2 });
  });
  test.each([true, false])('숫자와 불리언 스칼라(%s) 및 반복한 배열 쿼리는 허용한다', async (includeDeleted) => {
    const response = await app.inject({ url: `/api/runner/messages?includeDeleted=${String(includeDeleted)}&limit=2&tags=a&tags=b`, headers: headers() });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ includeDeleted, limit: 2, tags: ['a', 'b'] });
  });

  test.each([
    ['단일 값을 배열로 감싸지 않음', 'tags=a', 'tags', 'type'],
    ['잘못된 불리언', 'includeDeleted=yes', 'includeDeleted', 'type'],
    ['미선언 항목', 'unknown=secret-value-do-not-echo', 'unknown', 'additionalProperties'],
  ])('%s', async (_label, query, path, rule) => {
    const response = await app.inject({ url: `/api/runner/messages?${query}`, headers: headers() });
    expect(response.statusCode).toBe(400);
    expect(response.json<InputResponse>().error.errors).toContainEqual({ path, rule, message: expect.any(String) });
    expect(response.body).not.toContain('secret-value-do-not-echo');
  });
});

describe('수동 세대 번호 검사의 입력 오류', () => {
  test.each([2 ** 31, 2 ** 53])('본문 epoch=%s의 최댓값 오류도 errors[]에 남긴다', async (epoch) => {
    const before = reached;
    const response = await app.inject({ method: 'POST', url: '/api/project/reset', headers: { cookie, origin, 'x-csrf-token': csrf }, payload: { epoch, confirmName: '프로젝트', keepSettings: true } });
    expect(response.statusCode).toBe(400);
    expect(response.json<InputResponse>().error.errors).toContainEqual({ path: 'epoch', rule: 'maximum', message: expect.any(String) });
    expect(reached).toBe(before);
  });

  test('Runner 세대 헤더의 최댓값 오류도 항목별로 안내한다', async () => {
    const response = await app.inject({ url: '/api/runner/messages', headers: { ...headers(), 'x-project-epoch': String(2 ** 31) } });
    expect(response.statusCode).toBe(400);
    expect(response.json<InputResponse>().error.errors).toContainEqual({ path: 'x-project-epoch', rule: 'maximum', message: expect.any(String) });
  });

  test.each(['01', '-1', '1e3'])('Runner 세대 헤더 %s의 형식 오류도 항목별로 안내한다', async (epoch) => {
    const response = await app.inject({ url: '/api/runner/messages', headers: { ...headers(), 'x-project-epoch': epoch } });
    expect(response.statusCode).toBe(400);
    expect(response.json<InputResponse>().error.errors).toContainEqual({ path: 'x-project-epoch', rule: 'pattern', message: expect.any(String) });
  });
});
