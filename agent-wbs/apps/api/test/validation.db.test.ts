import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
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
let reached = 0;
app.addSchema({ $id: 'ValidationRow', type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false });
const query = { type: 'object', properties: {
  includeDeleted: { type: 'boolean' }, limit: { type: 'integer', minimum: 1 }, tags: { type: 'array', items: { type: 'string' } },
}, additionalProperties: false };
app.post('/api/runner/usage', { schema: { body: {
  type: 'object', properties: { priority: { type: 'integer' }, enabled: { type: 'boolean' }, rows: { type: 'array', items: { $ref: 'ValidationRow#' } } },
  required: ['priority', 'enabled', 'rows'], additionalProperties: false,
} } }, (request) => { reached++; return request.body; });
app.get('/api/runner/messages', { schema: { querystring: query } }, (request) => request.query);
beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  await runMigrations(owner);
  await seedSystem(owner);
  bearer = await issueRunnerToken(pool, 'validation-runner', 'fake');
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
