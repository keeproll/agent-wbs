import { createPool } from '@awbs/db';
import { loadConfig } from '../config.ts';
import { watchRunner } from './watch.ts';
import { deleteFiles } from '../reset/files.ts';
import { generateDueReports } from '../reports/service.ts';
import { deliverMail, recoverMail } from '../mail/deliver.ts';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl, { onError: () => console.error('Runner 감시 DB 연결 오류') });
let pending: Promise<void> | undefined;
/** 한 작업이 실패해도 다른 작업은 같은 주기에 돈다. 로그는 실패한 작업 이름을 적는다(M2-04 리뷰 P3-6). */
async function step(name: string, work: () => Promise<unknown>) {
  try { await work(); } catch (error) {
    if ((error as { code?: string }).code !== 'AW001') console.error(`${name} 실패`);
  }
}
/** 첫 점검은 서버 시작 직후다. 그때 만든 보고서는 「서버 시작 시 누락분 보충」으로 표시한다(G L377, M6-01). */
let started = false;
async function tick() {
  let epoch: number | undefined;
  await step('세대 조회', async () => { epoch = (await pool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch; });
  if (epoch === undefined) return;
  const current = epoch;
  await step('Runner 생존 감시', () => watchRunner(pool, current));
  await step('초기화 파일 삭제', () => deleteFiles(pool, current));
  const startup = !started;
  started = true;
  // 커밋된 변경의 실제 커밋 시각을 옮겨 적는다(보고서 상태 이력, M6-01). 오래 두면 DB가 실제 커밋 시각을 지운다.
  await step('보고서 이력 정리', () => pool.query('select public.awbs_settle_commits()'));
  await step('보고서 정기 생성', () => generateDueReports(pool, current, { startup }));
}
const run = () => { pending ??= tick().finally(() => { pending = undefined; }); };
const timer = setInterval(run, 20_000);
run();

/**
 * 메일 발송(M6-03)은 따로 돈다. SMTP 응답을 오래 기다려도 Runner 생존 감시가 밀리지 않게 하기 위해서다.
 * 시작 때 한 번, 앞 프로세스가 보내다 죽은 메일을 「수락 여부 불명」으로 정리한다(자동 재발송 없음, contracts §4.4).
 */
let mailPending: Promise<void> | undefined;
let mailRecovered = false;
async function mailTick() {
  let epoch: number | undefined;
  await step('세대 조회', async () => { epoch = (await pool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch; });
  if (epoch === undefined) return;
  const current = epoch;
  if (!mailRecovered) await step('메일 재시작 정리', async () => { await recoverMail(pool, current); mailRecovered = true; });
  await step('보고서 메일 발송', () => deliverMail(pool, current));
}
const runMail = () => { mailPending ??= mailTick().finally(() => { mailPending = undefined; }); };
const mailTimer = setInterval(runMail, 10_000);
runMail();
async function stop() { clearInterval(timer); clearInterval(mailTimer); await pending; await mailPending; await pool.end(); }
let stopping = false;
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
  if (!stopping) { stopping = true; void stop(); }
});
