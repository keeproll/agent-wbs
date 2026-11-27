/**
 * 메일 worker 한 번 실행(시험용 자식 프로세스, M6-03).
 * 「SMTP 서버가 메일을 받은 직후 worker가 죽는」 상황을 만들려고 별도 프로세스로 띄운다. 시험이 이 프로세스를 SIGKILL로 끝낸다.
 * 인수: DB 주소, epoch, 시각(ISO), SMTP 응답 대기 ms
 */
import { createPool } from '../../packages/db/src/index.ts';
import { deliverMail } from '../../apps/api/src/mail/deliver.ts';

const [url, epoch, now, timeout] = process.argv.slice(2);
if (!url || !epoch || !now || !timeout) throw new Error('인수: <db url> <epoch> <now> <timeoutMs>');
const pool = createPool(url, { onError: () => undefined });
try {
  await deliverMail(pool, Number(epoch), { now, timeoutMs: Number(timeout) });
} finally { await pool.end(); }
