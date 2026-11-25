import { createPool } from '@awbs/db';
import { afterAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

// 1번 포트에는 DB가 없다.
const pool = createPool('postgres://u:secret@127.0.0.1:1/awbs_test_x', { onError: () => undefined });
const app = buildApp(pool);
afterAll(async () => {
  await app.close();
  await pool.end();
});

test('GET /health는 DB와 관계없이 200이다', async () => {
  const response = await app.inject('/health');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok' });
});

test('GET /health/db는 DB가 없으면 503이고 접속 정보를 노출하지 않는다', async () => {
  const response = await app.inject('/health/db');
  expect(response.statusCode).toBe(503);
  expect(response.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
  expect(response.body).not.toMatch(/secret|127\.0\.0\.1|ECONNREFUSED/);
});

describe('loadConfig', () => {
  const DATABASE_URL = 'postgres://u:secret@127.0.0.1:25442/awbs_dev';

  test('기본값은 127.0.0.1:3100, 풀 10이다', () => {
    expect(loadConfig({ DATABASE_URL })).toMatchObject({ host: '127.0.0.1', port: 3100, poolMax: 10 });
  });

  test.each([
    ['DATABASE_URL 없음', {}],
    ['외부 바인딩', { DATABASE_URL, AWBS_HOST: '0.0.0.0' }],
    ['잘못된 포트', { DATABASE_URL, AWBS_PORT: '99999' }],
    ['숫자가 아닌 풀', { DATABASE_URL, DB_POOL_MAX: '1e1' }],
    ['로그 수준', { DATABASE_URL, LOG_LEVEL: 'loud' }],
  ])('%s은 거부한다', (_label, env) => {
    expect(() => loadConfig(env)).toThrow();
  });
});
