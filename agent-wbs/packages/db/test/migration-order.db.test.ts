/**
 * M6-03 Codex 리뷰 지적 2 재현(review-codex.md): 0049를 먼저 적용한 DB에, 그보다 적용 기준 시각(when)이 낮은 변경을 나중에 합치면
 * Drizzle 마이그레이션 도구가 그 변경을 **조용히 건너뛴다**(오류 없이 끝나고 표가 생기지 않는다).
 *
 * - 왜 `test.fails`인가: coordinator가 M6 통합 때 「마지막 순번으로 재번호 + 적용 누락 검사」로 확정한다(fix2 지시).
 *   지금은 리뷰어의 재현만 시험으로 남긴다. 아래 단정은 **올바른 동작**(합친 변경도 적용)을 적었고, 지금은 실패하는 것이 정상이다.
 *   통합에서 고치면 이 시험이 「예상한 실패가 일어나지 않음」으로 깨진다. 그때 `test.fails`를 `test`로 바꾼다.
 * - 리뷰어는 실제 M6-01(0036·0037)·M6-02(0047) 파일로 재현했다. 여기서는 다른 작업 폴더에 기대지 않도록 같은 모양의 가짜 변경(0030)을 쓴다.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations } from '../src/index.ts';

interface Journal { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] }

test.fails('[리뷰 지적 2 재현] 0049를 먼저 적용한 DB에 낮은 시각의 변경을 합쳐도 그 변경이 적용되어야 한다(통합에서 재번호 · 누락 검사로 확정)', async () => {
  const url = new URL(inject('testDatabaseUrl'));
  url.pathname += '_migration_order';
  await recreateTestDatabase(url.href);
  const pool = createPool(url.href, { max: 2, onError: () => undefined });
  const folder = await mkdtemp(join(tmpdir(), 'awbs-m603-order-'));
  try {
    // 1. 지금 브랜치 그대로(0025 → 0049) 적용한 DB
    await runMigrations(pool);
    // 2. 다른 작업이 만든 낮은 시각의 변경(0030)을 합친 목록. 리뷰어처럼 시각순 정렬 + idx 다시 매김
    await cp(fileURLToPath(new URL('../migrations/', import.meta.url)), folder, { recursive: true });
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
    await writeFile(join(folder, '0030_20261127_late_probe.sql'), 'CREATE TABLE "fix2_late_probe" ("id" integer PRIMARY KEY);');
    journal.entries.push({ idx: 30, version: '7', when: 1795740000030, tag: '0030_20261127_late_probe', breakpoints: true });
    journal.entries.sort((a, b) => a.when - b.when);
    journal.entries.forEach((e, i) => { e.idx = i; });
    await writeFile(journalPath, JSON.stringify(journal));
    // 3. 업그레이드: 오류 없이 끝난다. 하지만 0030은 0049보다 시각이 낮아 건너뛴다(리뷰어 관측: applied 27/30, 표 없음).
    await migrate(drizzle(pool), { migrationsFolder: folder });
    const state = (await pool.query<{ probe: string | null; applied: number }>(
      "select to_regclass('public.fix2_late_probe')::text probe,(select count(*)::int from drizzle.__drizzle_migrations) applied")).rows[0];
    expect(state).toEqual({ probe: 'fix2_late_probe', applied: journal.entries.length });
  } finally {
    await pool.end();
    await rm(folder, { recursive: true, force: true });
  }
}, 120_000);
