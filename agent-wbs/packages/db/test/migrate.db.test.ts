import { afterAll, expect, inject, test } from 'vitest';
import {
  assertConnectedToTestDatabase,
  createPool,
  pingDatabase,
  recreateTestDatabase,
  runMigrations,
} from '../src/index.ts';

const url = inject('testDatabaseUrl');
const pool = createPool(url, { onError: () => undefined });
afterAll(() => pool.end());

test('PostgreSQL 16 테스트 DB에 연결된다', async () => {
  await assertConnectedToTestDatabase(pool);
  expect(await pingDatabase(pool)).toBeGreaterThanOrEqual(0);
  const { rows } = await pool.query<{ server_version: string }>('show server_version');
  expect(rows[0]?.server_version).toMatch(/^16\./);
});

test('빈 DB에 migrate할 수 있고 반복해도 같다', async () => {
  await runMigrations(pool);
  await runMigrations(pool);
});

test('guard: 개발 DB 연결은 연결 뒤 확인에서도 거부한다', async () => {
  const other = new URL(url);
  other.pathname = '/awbs_dev';
  const dev = createPool(other.href, { onError: () => undefined });
  try {
    await expect(assertConnectedToTestDatabase(dev)).rejects.toThrow('awbs_dev');
  } finally {
    await dev.end();
  }
});

test('guard: 개발 DB는 초기화를 거부하고 그대로 남는다', async () => {
  const other = new URL(url);
  other.pathname = '/awbs_dev';
  const oid = () =>
    pool.query<{ oid: number }>("select oid from pg_database where datname = 'awbs_dev'");
  const before = (await oid()).rows;
  expect(before).toHaveLength(1);
  await expect(recreateTestDatabase(other.href)).rejects.toThrow('awbs_test_');
  expect((await oid()).rows).toEqual(before);
});
