// 0019: 일정 정책 기본값(owner 결정 2026-11-26 아이템 7) — 가정 가동률 60%, 재조정 임계값 1일.
// - 새 DB의 system seed가 넣는다. 둘 다 설정에서 바꿀 수 있다.
// - 기존 DB는 값이 비어 있는(null) 칸만 채우고, 팀장이 이미 넣은 값은 덮어쓰지 않는다.
// - 설정까지 지우는 초기화(keepSettings=false)는 이 기본값으로 되돌린다.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, type Pool } from '../src/index.ts';

const policy = async (pool: Pool) =>
  (await pool.query<{ assume_rate: string | null; threshold_days: string | null }>('select assume_rate::text,threshold_days::text from schedule_policy')).rows;

test('journal: 0019가 0018 뒤에 있고 시각도 뒤다', async () => {
  const journal = JSON.parse(await readFile(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
  const e18 = journal.entries.find((e) => e.idx === 18);
  const e19 = journal.entries.find((e) => e.idx === 19);
  expect(e18?.tag).toBe('0018_20261126_message_read_touch');
  expect(e19?.tag).toBe('0019_20261126_schedule_defaults');
  expect((e18?.when ?? Infinity) < (e19?.when ?? 0)).toBe(true);
  // M2-05의 0017(usage_reset_unknown, when 1795689908823)보다 늦어야 그 뒤에 실행된다.
  expect(e18?.when).toBeGreaterThan(1795689908823);
});

describe('새 DB', () => {
  const url = new URL(inject('testDatabaseUrl'));
  url.pathname += '_schedule_new';
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(url.href, { max: 2, onError: () => undefined });
    await recreateTestDatabase(url.href);
    await runMigrations(pool);
    await pool.query('select public.seed_system()');
  });
  afterAll(() => pool.end());

  test('system seed가 60%·1일을 넣는다', async () => {
    expect(await policy(pool)).toEqual([{ assume_rate: '0.6', threshold_days: '1' }]);
  });

  test('팀장이 바꾼 값은 seed를 다시 실행해도 그대로', async () => {
    await pool.query('update schedule_policy set assume_rate=0.45, threshold_days=2');
    await pool.query('select public.seed_system()');
    expect(await policy(pool)).toEqual([{ assume_rate: '0.45', threshold_days: '2' }]);
  });

  test('설정까지 지우는 초기화는 기본값으로 되돌린다', async () => {
    await pool.query("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('r','','','','','active')");
    await pool.query("select public.reset_project(1,'r',false,'lead')");
    expect(await policy(pool)).toEqual([{ assume_rate: '0.6', threshold_days: '1' }]);
  });
});

describe.each([
  ['둘 다 비어 있음', null, null, '0.6', '1'],
  ['팀장이 둘 다 넣음', '0.4', '3', '0.4', '3'],
  ['가동률만 넣음', '0.7', null, '0.7', '1'],
  ['임계값만 넣음', null, '0.5', '0.6', '0.5'],
])('0018까지 적용된 기존 DB(%s)', (name, rate, threshold, expectedRate, expectedThreshold) => {
  const url = new URL(inject('testDatabaseUrl'));
  url.pathname += `_schedule_up_${String(rate)}_${String(threshold)}`.replace(/\./g, '');
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(url.href, { max: 2, onError: () => undefined });
    await recreateTestDatabase(url.href);
    const temp = await mkdtemp(join(tmpdir(), 'awbs-schedule18-'));
    try {
      await cp(fileURLToPath(new URL('../migrations/', import.meta.url)), temp, { recursive: true });
      const path = join(temp, 'meta/_journal.json');
      const journal = JSON.parse(await readFile(path, 'utf8')) as { entries: { idx: number }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 18);
      await writeFile(path, JSON.stringify(journal));
      await migrate(drizzle(pool), { migrationsFolder: temp });
    } finally {
      await rm(temp, { recursive: true });
    }
    await pool.query('select public.seed_system()');
    await pool.query('update schedule_policy set assume_rate=$1, threshold_days=$2', [rate, threshold]);
    await runMigrations(pool);
  });
  afterAll(() => pool.end());

  test(`비어 있던 칸만 채운다 (${name})`, async () => {
    expect(await policy(pool)).toEqual([{ assume_rate: expectedRate, threshold_days: expectedThreshold }]);
  });
});
