import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, expect, inject, test } from 'vitest';
import { checkMigrationsApplied, createPool, MigrationGapError, recreateTestDatabase, runMigrations, seedDemo, type Pool } from '../src/index.ts';

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

/*
 * M6 통합 재번호(새 main 위 0028~0035). 옛 번호 DB: M6 마이그레이션을 옛 이름·옛 시각(when)으로 적용한 DB.
 * - m6int·m6int_29: M6 통합 브랜치(8ff0cee, main 반영 전)의 번호 0036~0043. 0026·0027(M5·M7)은 아직 없다.
 * - m6_03~m6_05: 각 M6 작업 브랜치의 번호(0049·0051·0052·0053·0054).
 * - 옛 이름 파일은 같은 내용으로 만든다(hash가 같다). 그래서 runMigrations가 기록 시각을 맞추고, 빠진 앞 번호(0026·0027 등)를 보충한다.
 * - m6_02: 옛 0047은 내용이 바뀌었다(이력 판단 추가, 옛 내용 fixtures). 모르는 hash의 기록이 있으면 보충하지 않고
 *   누락 검사(MigrationGapError)로 멈춘다(M5·M7 통합 원칙: 내용이 다른 옛 판을 적용한 DB는 새로 만든다).
 */
const M6_TAGS = ['0028_20261127_report_state_log', '0029_20261127_report_state_log_settings', '0030_20261127_report_project_name',
  '0031_20261127_mail_queue', '0032_20261127_telegram_transitions', '0033_20261127_telegram_review',
  '0034_20261127_design_ledger', '0035_20261127_design_display_keys'];
const m6int = (count: number) => M6_TAGS.slice(0, count).map((from) => ({ tag: String(Number(from.slice(0, 4)) + 8).padStart(4, '0') + from.slice(4), from }));
const OLD: Record<string, { tag: string; from?: string; fixture?: string }[]> = {
  m6int_29: m6int(2),
  m6int: m6int(8),
  m6_02: [{ tag: '0047_20261127_report_project_name', fixture: 'fixtures/0047_20261127_report_project_name.sql' }],
  m6_03: [{ tag: '0049_20261127_mail_queue', from: '0031_20261127_mail_queue' }],
  m6_04: [{ tag: '0051_20261127_telegram_transitions', from: '0032_20261127_telegram_transitions' }, { tag: '0052_20261127_telegram_review', from: '0033_20261127_telegram_review' }],
  m6_05: [{ tag: '0053_20261127_design_ledger', from: '0034_20261127_design_ledger' }, { tag: '0054_20261127_design_display_keys', from: '0035_20261127_design_display_keys' }],
};

test('빈 DB와 0014·0016(master)·0017~0027·M6 중간(0029~0034) 단계 DB, M6 옛 번호 DB가 최신으로 올린 뒤 같은 구조가 된다', async () => {
  const journalPath = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));
  interface Entry { idx: number; tag: string; when: number; version: string; breakpoints: boolean }
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: Entry[] };
  expect(journal.entries.slice(15).map((e) => e.tag)).toEqual([
    '0015_20261126_platform_epoch_lock', '0016_20261126_contract_sync', '0017_20261126_usage_reset_unknown',
    '0018_20261126_message_read_touch', '0019_20261126_schedule_defaults', '0020_20261126_execution_basis',
    '0021_20261127_project_followup', '0022_20261127_evidence_reference', '0023_20261127_project_observation_version', '0024_20261127_settings_followup', '0025_20261127_setting_versions',
    // M5·M7 통합(main): CI 0026, Planning 수신 순번 0027
    '0026_20261127_ci_reports', '0027_20261127_planning_event_order',
    // M6 통합 재번호(새 main 위): M6-01 상태 이력 0028·0029, M6-02 이름 채움 0030, M6-03 메일 큐 0031,
    // M6-04 Telegram 0032·0033, M6-05 설계 원장 0034·0035
    ...M6_TAGS,
    // M6·M7 통합: CI 알림도 Telegram 대기열로(0036 awbs_notify_emit)
    '0036_20261127_notify_ci',
    // M6 통합 fix2: 이력 순번 채우기·M6 표 저장 순번(0037)
    '0037_20261127_record_order',
    '0038_20261127_claim_return_merge_commits',
    '0039_20261127_resource_return_recovery',
    // M8 전 연결(조정자 결정 3): 해제 증거 cgroup_empty(0040)
    '0040_20261127_cgroup_empty',
    // Q-13 결정 A: 외부 수신자(0041)
    '0041_20261127_mail_external']);
  // journal 시각 = 1795740000000 + 번호(0021 이후 규칙)
  for (const e of journal.entries.slice(26)) expect(e.when, e.tag).toBe(1795740000000 + Number(e.tag.slice(0, 4)));
  const fresh = await database('fresh');
  await runMigrations(fresh);
  const expected = await schemaOf(fresh);
  const stages: (number | string)[] = [14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 29, 30, 31, 33, 34, 35, 36, 37, 38, ...Object.keys(OLD)];
  for (const stage of stages) {
    const pool = await database(String(stage));
    const folder = await mkdtemp(join(tmpdir(), `awbs-stage-${String(stage)}-`));
    try {
      await cp(fileURLToPath(new URL('../migrations/', import.meta.url)), folder, { recursive: true });
      let entries: Entry[];
      if (typeof stage === 'number') entries = journal.entries.filter((e) => e.idx <= stage);
      else {
        entries = journal.entries.filter((e) => e.idx <= 25);
        for (const old of OLD[stage] ?? []) {
          const source = old.fixture ? new URL(old.fixture, import.meta.url) : join(folder, `${old.from ?? ''}.sql`);
          await writeFile(join(folder, `${old.tag}.sql`), await readFile(source, 'utf8'));
          entries.push({ idx: entries.length, version: '7', when: 1795740000000 + Number(old.tag.slice(0, 4)), tag: old.tag, breakpoints: true });
        }
      }
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
      await migrate(drizzle(pool), { migrationsFolder: folder });
    } finally { await rm(folder, { recursive: true, force: true }); }
    if (stage === 'm6_02') {
      await expect(runMigrations(pool), '단계 m6_02').rejects.toBeInstanceOf(MigrationGapError);
      continue;
    }
    await pool.query('select seed_system()');
    if (stage === 20) await pool.query(`insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase,created_at)
      values('기존 프로젝트','','','','','active','2000-01-01T20:00:00Z')`);
    let attempts: unknown[] = [];
    if (stage === 23) {
      // 최신 seed에 필요한 관측 칸만 잠시 빌린 뒤 0023 구조로 되돌려 실제 업그레이드를 검사한다.
      await pool.query("alter table projects add column pipeline_observations jsonb not null default '{}'");
      const sequenceTables = ['planning_jobs','task_estimates','change_proposals','runner_jobs','task_attempts','attempt_observations','runner_hosts','runner_concurrency_log','agent_usage','task_history','ci_steps','runner_sessions','change_proposal_events','planning_job_logs','planning_reviews'];
      for (const table of sequenceTables) await pool.query(`alter table ${table} add column record_no bigint default 1`);
      await pool.query("alter table ci_runs add column note text,add column e2e jsonb,add column github_status jsonb,add column finished_at timestamptz,add column cause_candidates jsonb not null default '[]'");
      await pool.query('alter table merge_queue add column merged_at timestamptz');
      await pool.query('alter table flaky_tests add column last_failed_at timestamptz');
      await pool.query('alter table runner_jobs add column resource_returns integer not null default 0,add column resource_retry_at timestamptz');
      try { await seedDemo(pool, base.href); }
      finally {
        await pool.query('alter table projects drop column pipeline_observations');
        await pool.query('alter table ci_runs drop column note,drop column e2e,drop column github_status,drop column finished_at,drop column cause_candidates');
        await pool.query('alter table merge_queue drop column merged_at');
        await pool.query('alter table flaky_tests drop column last_failed_at');
        await pool.query('alter table runner_jobs drop column resource_returns,drop column resource_retry_at');
        for (const table of sequenceTables) await pool.query(`alter table ${table} drop column record_no`);
      }
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
    // 0027: 기존 Planning 이벤트의 수신 순번은 업그레이드 전 정렬(시각·id)을 그대로 보존한다.
    for (const [table, ordering] of [['change_proposal_events', 'created_at,id'], ['planning_job_logs', 'at,created_at,id'], ['planning_reviews', 'created_at,id']] as const) {
      const same = (await pool.query<{ same: boolean }>(`select coalesce(array_agg(id order by record_no) = array_agg(id order by ${ordering}),true) same from ${table}`)).rows[0]?.same;
      expect(same, `단계 ${String(stage)} ${table}`).toBe(true);
    }
    expect(await schemaOf(pool), `단계 ${String(stage)}`).toBe(expected);
    // 모든 단계는 기록 개수가 journal과 같고(같은 내용을 두 번 적용하지 않음), 누락이 없어야 한다.
    expect((await pool.query<{ n: number }>('select count(*)::int n from drizzle.__drizzle_migrations')).rows[0]?.n, `단계 ${String(stage)}`).toBe(journal.entries.length);
    await checkMigrationsApplied(pool);
  }
}, 600_000);

/*
 * M5·M7 통합: CI 마이그레이션은 M7-04 브랜치에서 배정 번호 0041(when 1795740000041)로 만들었고,
 * 통합하면서 최종 순번 0026(when 1795740000026)으로 다시 매겼다. 내용(hash)은 그대로다.
 * 왜: 브랜치 시험 DB처럼 옛 번호로 이미 적용한 DB가 새 journal로 올릴 때 같은 내용을 다시 실행하거나,
 * 반대로 무언가를 빠뜨린 채 조용히 넘어가면 안 된다. migrate.ts의 적용 누락 검사(hash 대조)가 통과해야 한다.
 */
test('옛 번호 0041로 CI 마이그레이션을 적용한 DB가 0026 재번호 journal로 누락 없이 올라간다', async () => {
  const source = fileURLToPath(new URL('../migrations/', import.meta.url));
  const journal = JSON.parse(await readFile(join(source, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
  const ci = journal.entries.find((e) => e.tag === '0026_20261127_ci_reports');
  expect(ci?.when).toBe(1795740000026);
  if (!ci) return;
  const fresh = await database('renumber_fresh');
  await runMigrations(fresh);
  const expected = await schemaOf(fresh);
  const pool = await database('renumber_old');
  const folder = await mkdtemp(join(tmpdir(), 'awbs-stage-renumber-'));
  try {
    // 브랜치 DB 상태: 0025까지 + CI를 옛 번호 0041(when …041)로 적용. 통합에서 더한 0027 이후는 아직 없다.
    await cp(source, folder, { recursive: true });
    await cp(join(source, '0026_20261127_ci_reports.sql'), join(folder, '0041_20261127_ci_reports.sql'));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal,
      entries: journal.entries.filter((e) => e.idx <= ci.idx).map((e) => e === ci ? { ...e, tag: '0041_20261127_ci_reports', when: 1795740000041 } : e) }));
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally { await rm(folder, { recursive: true, force: true }); }
  const recorded = async () => (await pool.query<{ created_at: string }>('select created_at::text from drizzle.__drizzle_migrations order by id')).rows.map((row) => row.created_at);
  expect((await recorded()).at(-1)).toBe('1795740000041');
  // 옛 기록 시각(…041)이 그대로면 Drizzle은 그보다 작은 when(0027 = …027)을 건너뛰고, 누락 검사가 시작을 막는다.
  // runMigrations는 이미 적용한 hash의 기록 시각을 지금 journal 값으로 맞춘 뒤 나머지를 적용한다.
  await runMigrations(pool);
  expect(await schemaOf(pool)).toBe(expected);
  const after = await recorded();
  expect(after).toHaveLength(journal.entries.length);
  expect(after).toContain(String(ci.when));
  expect(after).not.toContain('1795740000041');
}, 60_000);
