import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import type { Pool, PoolClient } from './pool.ts';

/** 적용 누락 검사에 걸렸을 때 던지는 오류. 빠진 마이그레이션 이름(tag)을 담는다. */
export class MigrationGapError extends Error {
  constructor(readonly missing: string[]) {
    super(`마이그레이션 적용 누락: ${missing.join(', ')}. DB 기록(drizzle.__drizzle_migrations)과 migrations 폴더가 맞지 않습니다.`);
    this.name = 'MigrationGapError';
  }
}

interface Journal { entries: { idx: number; tag: string; when: number }[] }

/** migrationsFolder: 시험이 일부만 담은 임시 폴더로 단계 DB를 올릴 때만 쓴다. 운영은 늘 기본 폴더다. */
export async function runMigrations(pool: Pool, options: { migrationsFolder?: string } = {}): Promise<void> {
  const config = { migrationsFolder: options.migrationsFolder ?? fileURLToPath(new URL('../migrations', import.meta.url)) };
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended('awbs:migrations',0))");
    const exists = (await client.query("select to_regclass('drizzle.__drizzle_migrations') as name")).rows[0] as { name: string | null };
    const files = readMigrationFiles(config);
    if (exists.name) {
      const contract = files[16], usage = files[17];
      const legacy = await client.query('select 1 from drizzle.__drizzle_migrations where hash=$1 and created_at=$2', [usage?.hash, 1795689908823]);
      const applied = await client.query('select 1 from drizzle.__drizzle_migrations where hash=$1', [contract?.hash]);
      // 옛 0016 사용량 보정의 시각 때문에 앞선 계약 0016이 건너뛰어진다. 그 한 건만 원본 그대로 보충한다.
      if (legacy.rowCount && !applied.rowCount && contract) await applyOne(client, contract);
      await fillSkipped(client, files);
    }
    await migrate(drizzle(client), config);
    await assertAllApplied(client, files, config.migrationsFolder);
  } finally {
    try { await client.query("select pg_advisory_unlock(hashtextextended('awbs:migrations',0))"); }
    finally { client.release(); }
  }
}

/** 마이그레이션 하나를 한 트랜잭션으로 적용하고, Drizzle과 같은 모양으로 기록한다. */
async function applyOne(client: PoolClient, file: MigrationMeta): Promise<void> {
  await client.query('begin');
  try {
    for (const sql of file.sql) await client.query(sql);
    await client.query('insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)', [file.hash, file.folderMillis]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
}

/**
 * 건너뛸 마이그레이션 보충(M6 통합).
 *
 * 무엇이 문제인가
 * - Drizzle은 「DB에 마지막으로 기록된 시각(created_at)보다 journal 시각(when)이 큰 것」만 적용한다.
 *   그래서 when이 더 낮은 마이그레이션이 나중에 합쳐지면 **오류 없이 건너뛴다**(M6-03 리뷰 지적 2).
 * - 예: 옛 번호 0049(when …049)를 적용한 DB에 재번호한 0038(when …038)이 오면, 0038은 영영 적용되지 않는다.
 *
 * 어떻게 하나
 * - journal 순서대로 보면서, 내용(hash)이 DB에 없고 시각이 마지막 기록 이하인 것(= Drizzle이 건너뛸 것)을 하나씩 먼저 적용한다.
 * - 내용이 같으면 hash가 같으므로, 번호(파일 이름)만 바뀐 마이그레이션은 다시 실행하지 않는다.
 * - 왜 오류로 멈추지 않고 적용하나: 재번호는 파일 이름만 바꾼 것이라, 옛 번호 DB도 같은 최종 구조로 올라가야 한다(upgrade-stages 시험).
 *   보충 중 SQL이 실패하면(예: 개발 중에 내용이 바뀐 마이그레이션) 그대로 오류를 낸다. 그때는 시험 DB를 다시 만든다.
 */
async function fillSkipped(client: PoolClient, files: MigrationMeta[]): Promise<void> {
  const rows = (await client.query<{ hash: string; created_at: string }>('select hash,created_at::text from drizzle.__drizzle_migrations')).rows;
  if (!rows.length) return;
  const last = Math.max(...rows.map((r) => Number(r.created_at)));
  const applied = new Set(rows.map((r) => r.hash));
  for (const file of files) {
    if (applied.has(file.hash) || file.folderMillis > last) continue;
    await applyOne(client, file);
    applied.add(file.hash);
  }
}

/**
 * 적용 누락 검사(M6 통합). 끝난 뒤 journal의 모든 마이그레이션 내용(hash)이 DB 기록에 있어야 한다.
 * 왜: 보충이나 Drizzle이 무엇을 빠뜨려도, 그 상태로 서버가 뜨면 표가 없는 오류가 한참 뒤에 난다. 여기서 바로 멈춘다.
 */
async function assertAllApplied(client: Pick<PoolClient, 'query'>, files: MigrationMeta[], folder: string): Promise<void> {
  const applied = new Set((await client.query<{ hash: string }>('select hash from drizzle.__drizzle_migrations')).rows.map((r) => r.hash));
  const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as Journal;
  const missing = files.flatMap((file, i) => (applied.has(file.hash) ? [] : [journal.entries[i]?.tag ?? String(i)]));
  if (missing.length) throw new MigrationGapError(missing);
}

/** 적용 누락 검사만 따로 부른다(시험·점검용). 마이그레이션은 실행하지 않는다. */
export async function checkMigrationsApplied(pool: Pool, options: { migrationsFolder?: string } = {}): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? fileURLToPath(new URL('../migrations', import.meta.url));
  await assertAllApplied(pool, readMigrationFiles({ migrationsFolder }), migrationsFolder);
}
