/**
 * 적용 누락 검사(M6 통합). M6-03 Codex 리뷰 지적 2(review-codex.md) 재현을 「고친 뒤 동작」 시험으로 바꿨다.
 *
 * - 문제: 0049(옛 번호)를 먼저 적용한 DB에, 그보다 적용 기준 시각(when)이 낮은 변경을 나중에 합치면
 *   Drizzle 마이그레이션 도구가 그 변경을 **조용히 건너뛴다**(오류 없이 끝나고 표가 생기지 않는다).
 * - 통합 결정(coordinator fix2 지시): 「마지막 순번으로 재번호 + 적용 누락 검사」.
 *   runMigrations는 건너뛸 변경을 journal 순서대로 먼저 적용하고(fillSkipped), 끝난 뒤 모든 변경이 기록됐는지 확인한다(assertAllApplied).
 * - 그래서 M6-03 때 `test.fails`였던 단정이 이제 그대로 통과한다(같은 모양의 가짜 변경 late_probe).
 * - 새 main 병합 뒤: 진짜 0030(이름 채움)이 when …030을 쓰므로, 가짜 변경은 비어 있는 시각 …010(0025와 0026 사이)을 쓴다.
 * - 보충은 DB 기록이 모두 지금 폴더의 내용(hash)일 때만 한다. 모르는 기록이 있으면 멈춘다(ci-migration 「리뷰 R skip」 시험).
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, inject, test } from 'vitest';
import { checkMigrationsApplied, createPool, MigrationGapError, recreateTestDatabase, runMigrations } from '../src/index.ts';

const PROBE_WHEN = 1795740000010;

interface Journal { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] }

async function withDb(name: string, fn: (pool: ReturnType<typeof createPool>, folder: string) => Promise<void>) {
  const url = new URL(inject('testDatabaseUrl'));
  url.pathname += `_migration_order_${name}`;
  await recreateTestDatabase(url.href);
  const pool = createPool(url.href, { max: 2, onError: () => undefined });
  const folder = await mkdtemp(join(tmpdir(), 'awbs-order-'));
  try {
    await cp(fileURLToPath(new URL('../migrations/', import.meta.url)), folder, { recursive: true });
    await fn(pool, folder);
  } finally {
    await pool.end();
    await rm(folder, { recursive: true, force: true });
  }
}

/** 낮은 시각의 가짜 변경(when …010)을 journal에 끼워 넣는다. 리뷰어처럼 시각순 정렬 + idx 다시 매김 */
async function addLateProbe(folder: string, sql: string): Promise<Journal> {
  const journalPath = join(folder, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
  await writeFile(join(folder, '0025_20261127_late_probe.sql'), sql);
  journal.entries.push({ idx: 99, version: '7', when: PROBE_WHEN, tag: '0025_20261127_late_probe', breakpoints: true });
  journal.entries.sort((a, b) => a.when - b.when);
  journal.entries.forEach((e, i) => { e.idx = i; });
  await writeFile(journalPath, JSON.stringify(journal));
  return journal;
}

test('[리뷰 지적 2] 최신까지 적용한 DB에 낮은 시각의 변경을 합쳐도 그 변경을 적용한다(건너뛰지 않음)', async () => {
  await withDb('fill', async (pool, folder) => {
    await runMigrations(pool);
    const journal = await addLateProbe(folder, 'CREATE TABLE "fix2_late_probe" ("id" integer PRIMARY KEY);');
    await runMigrations(pool, folder);
    await runMigrations(pool, folder);
    const state = (await pool.query<{ probe: string | null; applied: number }>(
      "select to_regclass('public.fix2_late_probe')::text probe,(select count(*)::int from drizzle.__drizzle_migrations) applied")).rows[0];
    expect(state).toEqual({ probe: 'fix2_late_probe', applied: journal.entries.length });
  });
}, 120_000);

test('보충할 변경이 실패하면 그 변경은 기록하지 않고 오류를 낸다(조용히 넘어가지 않음)', async () => {
  await withDb('fail', async (pool, folder) => {
    await runMigrations(pool);
    await addLateProbe(folder, 'SELECT 1/0;');
    await expect(runMigrations(pool, folder)).rejects.toThrow(/division by zero/);
    const n = (await pool.query<{ n: number }>("select count(*)::int n from drizzle.__drizzle_migrations where created_at=$1", [PROBE_WHEN])).rows[0]?.n;
    expect(n).toBe(0);
  });
}, 120_000);

test('적용 누락 검사: 기록에서 빠진 변경이 있으면 그 이름을 담아 멈춘다', async () => {
  await withDb('gap', async (pool) => {
    await runMigrations(pool);
    await checkMigrationsApplied(pool);
    const journal = JSON.parse(await readFile(fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url)), 'utf8')) as Journal;
    const middle = journal.entries[20];
    if (!middle) throw new Error('journal이 짧습니다.');
    // 중간 변경의 기록만 지운다(표는 그대로). Drizzle은 마지막 기록 시각만 보므로 이 빠짐을 알아채지 못한다.
    await pool.query('delete from drizzle.__drizzle_migrations where created_at=$1', [middle.when]);
    const error = await checkMigrationsApplied(pool).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationGapError);
    expect((error as MigrationGapError).missing).toEqual([middle.tag]);
  });
}, 120_000);
