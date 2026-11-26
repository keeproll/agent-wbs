import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Pool } from './pool.ts';

export async function runMigrations(pool: Pool): Promise<void> {
  const config = { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) };
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended('awbs:migrations',0))");
    const exists = (await client.query("select to_regclass('drizzle.__drizzle_migrations') as name")).rows[0] as { name: string | null };
    if (exists.name) {
      const files = readMigrationFiles(config);
      const contract = files[16], usage = files[17];
      const legacy = await client.query('select 1 from drizzle.__drizzle_migrations where hash=$1 and created_at=$2', [usage?.hash, 1795689908823]);
      const applied = await client.query('select 1 from drizzle.__drizzle_migrations where hash=$1', [contract?.hash]);
      // 옛 0016 사용량 보정의 시각 때문에 앞선 계약 0016이 건너뛰어진다. 그 한 건만 원본 그대로 보충한다.
      if (legacy.rowCount && !applied.rowCount && contract) {
        await client.query('begin');
        try {
          for (const sql of contract.sql) await client.query(sql);
          await client.query('insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)', [contract.hash, contract.folderMillis]);
          await client.query('commit');
        } catch (error) { await client.query('rollback'); throw error; }
      }
    }
    await migrate(drizzle(client), config);
  } finally {
    try { await client.query("select pg_advisory_unlock(hashtextextended('awbs:migrations',0))"); }
    finally { client.release(); }
  }
}
