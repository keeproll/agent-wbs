import { createPool } from '@awbs/db';
import { loadConfig } from '../config.ts';
import { watchRunner } from './watch.ts';
import { deleteFiles } from '../reset/files.ts';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl, { onError: () => console.error('Runner 감시 DB 연결 오류') });
let pending: Promise<void> | undefined;
/** 한 작업이 실패해도 다른 작업은 같은 주기에 돈다. 로그는 실패한 작업 이름을 적는다(M2-04 리뷰 P3-6). */
async function step(name: string, work: () => Promise<unknown>) {
  try { await work(); } catch (error) {
    if ((error as { code?: string }).code !== 'AW001') console.error(`${name} 실패`);
  }
}
async function tick() {
  let epoch: number | undefined;
  await step('세대 조회', async () => { epoch = (await pool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch; });
  if (epoch === undefined) return;
  const current = epoch;
  await step('Runner 생존 감시', () => watchRunner(pool, current));
  await step('초기화 파일 삭제', () => deleteFiles(pool, current));
}
const run = () => { pending ??= tick().finally(() => { pending = undefined; }); };
const timer = setInterval(run, 20_000);
run();
async function stop() { clearInterval(timer); await pending; await pool.end(); }
let stopping = false;
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
  if (!stopping) { stopping = true; void stop(); }
});
