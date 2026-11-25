import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from './pool.ts';

/** schema와 첫 migration은 M1-01에서 추가한다. */
export async function runMigrations(pool: Pool): Promise<void> {
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
}
