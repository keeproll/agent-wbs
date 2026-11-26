import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations } from '../src/index.ts';

const url = new URL(inject('testDatabaseUrl'));
url.pathname += '_legacy17';
const pool = createPool(url.href, { onError: () => undefined });

beforeAll(async () => {
  await recreateTestDatabase(url.href);
  const folder = await mkdtemp(join(tmpdir(), 'awbs-upgrade-'));
  try {
    await cp(fileURLToPath(new URL('../migrations/', import.meta.url)), folder, { recursive: true });
    const path = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter(e => e.idx <= 15);
    await writeFile(path, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally { await rm(folder, { recursive: true }); }
  await pool.query('select seed_system()');
  await pool.query('update app_settings set heartbeat_seconds=91');
  const sql = await readFile(new URL('../migrations/0017_20261126_usage_reset_unknown.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  await pool.query('insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)',
    [createHash('sha256').update(sql).digest('hex'), 1795689908823]);
});
afterAll(() => pool.end());

test('옛 0016 사용량 보정이 적용된 DB에도 계약 0016을 빠짐없이 적용하고 기존 설정을 보존한다', async () => {
  await runMigrations(pool);
  await runMigrations(pool);
  expect((await pool.query("select column_name from information_schema.columns where table_name='app_settings' and column_name='model_settings'")).rows).toEqual([{ column_name: 'model_settings' }]);
  const row = (await pool.query('select heartbeat_seconds,model_settings from app_settings')).rows[0];
  expect(row).toMatchObject({ heartbeat_seconds: 91, model_settings: { claudeModels: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'] } });
  expect((await pool.query("select is_nullable from information_schema.columns where table_name='agent_usage' and column_name='reset_at'")).rows).toEqual([{ is_nullable: 'YES' }]);
  const journal = JSON.parse(await readFile(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8')) as { entries: unknown[] };
  expect((await pool.query('select count(*)::int n from drizzle.__drizzle_migrations')).rows).toEqual([{ n: journal.entries.length }]);
});
