import { runMigrations } from './migrate.ts';
import { createPool, parseDatabaseUrl, waitForDatabase } from './pool.ts';

const pool = createPool(parseDatabaseUrl(process.env.DATABASE_URL), {
  max: 1,
  onError: (error) => {
    console.error(error.message);
  },
});
try {
  await waitForDatabase(pool);
  await runMigrations(pool);
  console.log('migration 완료');
} finally {
  await pool.end();
}
