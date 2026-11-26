// 0016: 0014까지 적용된 DB를 올리면 모델 설정이 초기값으로 채워지고, 옛 GitHub 권한 목록은 「확인 안 함」(null)이 된다.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { DEFAULT_MODEL_SETTINGS } from '@awbs/shared';
import { createPool, recreateTestDatabase, runMigrations } from '../src/index.ts';

const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_upgrade16';
const pool = createPool(dbUrl.href, { max: 2, onError: () => undefined });

beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  const temp = await mkdtemp(join(tmpdir(), 'awbs-upgrade16-'));
  try {
    await cp(fileURLToPath(new URL('../migrations/', import.meta.url)), temp, { recursive: true });
    const path = join(temp, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 14);
    await writeFile(path, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: temp });
  } finally {
    await rm(temp, { recursive: true });
  }
  await pool.query('select public.seed_system()');
  await pool.query("insert into github_settings(mode,status,scopes) values('token','ok','{repo}')");
  await runMigrations(pool);
});
afterAll(() => pool.end());

test('이전 app_settings 행에 모델 설정 초기값이 채워진다', async () => {
  const { rows } = await pool.query<{ model_settings: unknown }>('select model_settings from app_settings');
  expect(rows[0]?.model_settings).toEqual(JSON.parse(JSON.stringify(DEFAULT_MODEL_SETTINGS)));
});

test('이전 GitHub 권한 목록은 추정하지 않고 null(확인 안 함)로 바꾼다', async () => {
  const { rows } = await pool.query('select scopes,warning,status from github_settings');
  expect(rows).toEqual([{ scopes: null, warning: null, status: 'ok' }]);
});
