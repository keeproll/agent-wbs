import { createPool, parseDatabaseUrl } from './pool.ts';
import { seedDemo, seedSystem } from './seed.ts';
import { assertTestDatabaseUrl } from './test-database.ts';

const kind = process.argv[2];
if (kind !== 'system' && kind !== 'demo') throw new Error('seed requires system or demo');
const url = parseDatabaseUrl(
  kind === 'demo' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL,
);
if (kind === 'demo') assertTestDatabaseUrl(url);
const pool = createPool(url, { max: 1, onError: (error) => console.error(error.message) });
try {
  if (kind === 'system') await seedSystem(pool);
  else await seedDemo(pool, url);
} finally {
  await pool.end();
}
