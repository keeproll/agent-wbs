import { createPool } from '@awbs/db';
import { loadConfig } from '../config.ts';
import { watchRunner } from './watch.ts';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl, { onError: () => console.error('Runner 감시 DB 연결 오류') });
let pending: Promise<void> | undefined;
async function tick() {
  try {
    const state = (await pool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0];
    if (state) await watchRunner(pool, state.epoch);
  } catch (error) {
    if ((error as { code?: string }).code !== 'AW001') console.error('Runner 생존 감시 실패');
  }
}
const run = () => { pending ??= tick().finally(() => { pending = undefined; }); };
const timer = setInterval(run, 20_000);
run();
async function stop() { clearInterval(timer); await pending; await pool.end(); }
let stopping = false;
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
  if (!stopping) { stopping = true; void stop(); }
});
