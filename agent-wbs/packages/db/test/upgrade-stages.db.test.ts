import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, seedDemo, type Pool } from '../src/index.ts';

/*
 * M2 통합: 마이그레이션 배정 번호(0015 platform, 0016 contract_sync, 0017 usage_reset_unknown, 0018~0019 M2-08, 0020 M2-06)를
 * 정리한 뒤, 빈 DB와 중간 단계 DB가 모두 같은 최종 구조가 되는지 확인한다.
 * - 0014: M2 이전, 0016: master(9cf1c42), 0017~0019: M2 작업 사이 단계.
 * 각 단계까지 적용한 DB에 시스템 기본 행을 넣고 최신으로 올린 뒤, 빈 DB에서 한 번에 올린 구조와 비교한다.
 * 왜: journal 순서나 snapshot 연결이 어긋나면 중간 단계 DB에서 일부 마이그레이션이 건너뛰어져도 빈 DB 시험은 통과한다.
 */
const base = new URL(inject('testDatabaseUrl'));
const pools: Pool[] = [];
afterAll(async () => { await Promise.all(pools.map((pool) => pool.end())); });

async function database(suffix: string): Promise<Pool> {
  const url = new URL(base);
  url.pathname += `_stage${suffix}`;
  await recreateTestDatabase(url.href);
  const pool = createPool(url.href, { onError: () => undefined });
  pools.push(pool);
  return pool;
}

/** 표·열·제약·색인·함수 본문·트리거를 정렬해 한 문자열로 만든다. */
async function schemaOf(pool: Pool): Promise<string> {
  const q = async (sql: string) => (await pool.query(sql)).rows.map((row) => JSON.stringify(row)).join('\n');
  return [
    await q(`select table_name,column_name,data_type,udt_name,is_nullable,column_default from information_schema.columns
      where table_schema='public' order by table_name,column_name`),
    await q(`select conrelid::regclass::text t,conname,pg_get_constraintdef(oid) d from pg_constraint where connamespace='public'::regnamespace order by 1,2`),
    await q(`select tablename,indexname,indexdef from pg_indexes where schemaname='public' order by 1,2`),
    await q(`select p.proname,pg_get_function_identity_arguments(p.oid) a,md5(pg_get_functiondef(p.oid)) d from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind in ('f','p') order by 1,2`),
    await q(`select tgrelid::regclass::text t,tgname,pg_get_triggerdef(oid) d from pg_trigger where not tgisinternal order by 1,2`),
    await q(`select typname,array_agg(enumlabel order by enumsortorder)::text l from pg_enum e join pg_type t on t.oid=e.enumtypid group by typname order by 1`),
  ].join('\n--\n');
}

test('빈 DB와 0014·0016(master)·0017·0018·0019·0020·0021 단계 DB가 최신으로 올린 뒤 같은 구조가 된다', async () => {
  const journalPath = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
  expect(journal.entries.slice(15).map((e) => e.tag)).toEqual([
    '0015_20261126_platform_epoch_lock', '0016_20261126_contract_sync', '0017_20261126_usage_reset_unknown',
    '0018_20261126_message_read_touch', '0019_20261126_schedule_defaults', '0020_20261126_execution_basis',
    '0021_20261127_project_followup', '0022_20261127_evidence_reference', '0023_20261127_project_observation_version', '0024_20261127_settings_followup', '0025_20261127_setting_versions', '0040_20261127_ci_reports']);
  const fresh = await database('fresh');
  await runMigrations(fresh);
  const expected = await schemaOf(fresh);
  for (const stage of [14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]) {
    const pool = await database(String(stage));
    const folder = await mkdtemp(join(tmpdir(), `awbs-stage-${String(stage)}-`));
    try {
      await cp(fileURLToPath(new URL('../migrations/', import.meta.url)), folder, { recursive: true });
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= stage) }));
      await migrate(drizzle(pool), { migrationsFolder: folder });
    } finally { await rm(folder, { recursive: true, force: true }); }
    await pool.query('select seed_system()');
    if (stage === 20) await pool.query(`insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase,created_at)
      values('기존 프로젝트','','','','','active','2000-01-01T20:00:00Z')`);
    let attempts: unknown[] = [];
    if (stage === 23) {
      await seedDemo(pool, base.href);
      await pool.query('alter table counters disable trigger counter_monotone');
      await pool.query("update counters set value=1 where kind='message'");
      await pool.query('alter table counters enable trigger counter_monotone');
      await pool.query('alter table task_attempts disable trigger attempt_terminal');
      await pool.query("update task_attempts a set attempt_key=t.task_key||'-A'||a.attempt_no from tasks t where t.id=a.task");
      await pool.query('alter table task_attempts enable trigger attempt_terminal');
      attempts = (await pool.query('select id,status,summary from task_attempts order by id')).rows;
      await pool.query('update schedule_policy set assume_rate=0.8,threshold_days=3');
    }
    const appVersion = stage === 24 ? (await pool.query('select updated_at from app_settings')).rows[0]?.updated_at : null;
    await runMigrations(pool);
    if (stage === 24) {
      const row = (await pool.query('select split_version,blackouts_version,workflow_version,models_version,subagents_version from app_settings')).rows[0];
      expect(Object.values(row ?? {})).toEqual(Array.from({ length: 5 }, () => appVersion));
    }
    if (stage === 20) expect((await pool.query("select description,to_char(start_date,'YYYY-MM-DD') start,input_checked_at from projects")).rows[0])
      .toEqual({ description: '', start: '2000-01-02', input_checked_at: null });
    if (stage === 23) {
      expect((await pool.query('select id,status,summary from task_attempts order by id')).rows).toEqual(attempts);
      expect((await pool.query("select count(*)::int n from task_attempts where attempt_key !~ '^ATT-[0-9]{4,}-[0-9]+$'")).rows[0]?.n).toBe(0);
      expect(Number((await pool.query("select value from counters where kind='message'")).rows[0]?.value)).toBe(3);
      expect((await pool.query('select assume_rate,threshold_days from schedule_policy')).rows[0]).toEqual({ assume_rate: '0.8', threshold_days: '3' });
    }
    expect(await schemaOf(pool), `단계 ${String(stage)}`).toBe(expected);
    expect((await pool.query<{ n: number }>('select count(*)::int n from drizzle.__drizzle_migrations')).rows[0]?.n, `단계 ${String(stage)}`).toBe(journal.entries.length);
  }
}, 120_000);
