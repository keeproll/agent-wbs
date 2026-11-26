// 0016 업그레이드: 0014(0015 이전)와 0015까지 적용된 DB 둘 다 0015 → 0016 순서로 올라가야 한다(리뷰 지적 1).
// 모델 설정은 초기값으로 채워지고, 옛 GitHub 권한 목록은 「확인 안 함」(null)이 되며, M2의 0015 잠금 함수가 있어야 한다.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { DEFAULT_MODEL_SETTINGS } from '@awbs/shared';
import { createPool, recreateTestDatabase, runMigrations, type Pool } from '../src/index.ts';

const journalOrder = async () => {
  const journal = JSON.parse(
    await readFile(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
  ) as { entries: { idx: number; when: number; tag: string }[] };
  return journal.entries;
};

test('journal: 0015가 0016보다 앞서고 시각도 앞선다(늦게 합친 0015가 건너뛰어지지 않게)', async () => {
  const entries = await journalOrder();
  const e15 = entries.find((e) => e.idx === 15);
  const e16 = entries.find((e) => e.idx === 16);
  expect(e15?.tag).toBe('0015_20261126_platform_epoch_lock');
  expect(e16?.tag).toBe('0016_20261126_contract_sync');
  expect(entries.indexOf(e15 as never)).toBeLessThan(entries.indexOf(e16 as never));
  expect(e15?.when).toBeLessThan(e16?.when ?? 0);
  const whens = entries.map((e) => e.when);
  expect(whens).toEqual([...whens].sort((a, b) => a - b));
});

describe.each([14, 15])('idx %i까지 적용된 DB를 최신으로', (upTo) => {
  const dbUrl = new URL(inject('testDatabaseUrl'));
  dbUrl.pathname += `_upgrade16_from${String(upTo)}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(dbUrl.href, { max: 2, onError: () => undefined });
    await recreateTestDatabase(dbUrl.href);
    const temp = await mkdtemp(join(tmpdir(), 'awbs-upgrade16-'));
    try {
      await cp(fileURLToPath(new URL('../migrations/', import.meta.url)), temp, { recursive: true });
      const path = join(temp, 'meta/_journal.json');
      const journal = JSON.parse(await readFile(path, 'utf8')) as { entries: { idx: number }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx <= upTo);
      await writeFile(path, JSON.stringify(journal));
      await migrate(drizzle(pool), { migrationsFolder: temp });
    } finally {
      await rm(temp, { recursive: true });
    }
    await pool.query('select public.seed_system()');
    await pool.query("update app_settings set heartbeat_seconds=91");
    await pool.query("insert into github_settings(mode,status,scopes) values('token','ok','{repo}')");
    await runMigrations(pool);
  });
  afterAll(() => pool.end());

  test('0015의 잠금 함수가 있다', async () => {
    const { rows } = await pool.query<{ n: string }>(
      "select proname n from pg_proc where pronamespace='public'::regnamespace and proname in ('lock_epoch_exclusive','lock_current_epoch') order by 1",
    );
    expect(rows.map((r) => r.n)).toEqual(['lock_current_epoch', 'lock_epoch_exclusive']);
  });

  test('이전 app_settings 행은 보존되고 모델 설정 초기값이 채워진다', async () => {
    const { rows } = await pool.query<{ model_settings: unknown; heartbeat_seconds: number }>(
      'select model_settings,heartbeat_seconds from app_settings',
    );
    expect(rows[0]?.heartbeat_seconds).toBe(91);
    expect(rows[0]?.model_settings).toEqual(JSON.parse(JSON.stringify(DEFAULT_MODEL_SETTINGS)));
  });

  test('이전 GitHub 권한 목록은 추정하지 않고 null(확인 안 함)로 바꾼다', async () => {
    const { rows } = await pool.query('select scopes,warning,status from github_settings');
    expect(rows).toEqual([{ scopes: null, warning: null, status: 'ok' }]);
  });

  test('최신까지 적용된 마이그레이션 수가 journal과 같다', async () => {
    const { rows } = await pool.query<{ n: number }>('select count(*)::int n from drizzle.__drizzle_migrations');
    expect(rows[0]?.n).toBe((await journalOrder()).length);
  });
});

describe('빈 DB에서 처음부터', () => {
  const dbUrl = new URL(inject('testDatabaseUrl'));
  dbUrl.pathname += '_upgrade16_empty';
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(dbUrl.href, { max: 2, onError: () => undefined });
    await recreateTestDatabase(dbUrl.href);
    await runMigrations(pool);
    await pool.query('select public.seed_system()');
  });
  afterAll(() => pool.end());

  test('0015 잠금 함수와 0016 모델 설정이 모두 있다', async () => {
    const fns = await pool.query<{ n: string }>(
      "select proname n from pg_proc where pronamespace='public'::regnamespace and proname in ('lock_epoch_exclusive','lock_current_epoch') order by 1",
    );
    expect(fns.rows.map((r) => r.n)).toEqual(['lock_current_epoch', 'lock_epoch_exclusive']);
    const { rows } = await pool.query<{ model_settings: unknown }>('select model_settings from app_settings');
    expect(rows[0]?.model_settings).toEqual(JSON.parse(JSON.stringify(DEFAULT_MODEL_SETTINGS)));
    const applied = await pool.query<{ n: number }>('select count(*)::int n from drizzle.__drizzle_migrations');
    expect(applied.rows[0]?.n).toBe((await journalOrder()).length);
  });
});
