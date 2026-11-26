/**
 * 메일 발송 worker(architecture §2 worker, contracts §4.4 「외부 전송의 불확정 구간」).
 *
 * 한 통을 보내는 순서:
 * 1. **찜하기(claim)**: 보낼 차례인 줄을 `sending`으로 바꾸고 **커밋한다.** SMTP를 부르기 전이다.
 *    - `for update skip locked`: worker가 둘이어도 한 줄은 한 worker만 가져간다(중복 발송 0).
 * 2. **보내기**: 트랜잭션 밖에서 SMTP를 부른다. DB 잠금을 쥔 채 네트워크를 기다리지 않는다.
 * 3. **기록**: 결과를 그 줄과 발송 기록(`mail_log`, 추가 전용)에 적는다.
 *
 * 결과별 처리(contracts §2.3·§4.4):
 * - 수락(250) → `accepted`.
 * - 수락되지 않은 것이 확실함(연결 전 실패·로그인 거부·명시적 거부·SMTP 미설정)
 *   → 첫 실패면 `retry_wait`(15분 뒤 같은 줄을 한 번 더), 자동 재시도 뒤에도 실패면 `failed`.
 * - 본문을 보낸 뒤 응답 유실·timeout → `unknown`. 자동으로 다시 보내지 않는다.
 * - 보내는 중에 worker가 죽으면 줄이 `sending`으로 남는다. 다음 시작 때 `recoverMail`이 `unknown`으로 바꾼다.
 *   왜: 서버가 이미 받았을 수 있다. 가이드는 메일이 두 번 나가면 안 된다고 했으므로(G§9.6-6), 모를 때는 사람이 판단한다.
 * - failed·unknown이 남으면 대시보드 알림을 연다(queue.ts syncMailAlert).
 *
 * 초기화 경합(data-model §5):
 * - 찜하기와 기록은 모두 `inEpoch`(세대 번호 잠금) 안에서 한다. 초기화가 먼저 끝났으면 옛 세대 번호로는 잠글 수 없다(AW001).
 * - 찜하기가 AW001이면 아무것도 보내지 않는다(예외를 올려 worker 단계가 건너뛴다).
 * - 이미 SMTP로 보낸 뒤 기록이 AW001이면 결과를 버린다. 초기화가 발송 기록을 지웠으므로 옛 기록을 새 세대에 되살리지 않는다.
 *   이미 나간 메일은 회수할 수 없다. 그래서 초기화 확인 화면이 「보내는 중」 건수를 미리 보인다(reset-preview `sending.mail`).
 */
import type { Pool, PoolClient } from '@awbs/db';
import { inEpoch } from '../platform/transaction.ts';
import { deferChange, iso } from '../changes/events.ts';
import { loadReport, syncMailAlert } from './queue.ts';
import { pdfName, renderMail } from './render.ts';
import { smtpTarget } from './settings.ts';
import { DEFAULT_TIMEOUT_MS, sendSmtp, type OutgoingMail, type SendOutcome, type SmtpTarget } from './smtp.ts';

/** 자동 재시도 간격(G L407 「15분 후 1회」) */
export const RETRY_MINUTES = 15;
/** 한 번에 찜하는 최대 줄 수. 응답이 느린 서버에서 한 주기가 너무 길어지지 않게 한다. */
const BATCH = 20;

export interface DeliverOptions {
  /** 판정 시각(자동 재시도 시각 계산). 없으면 DB 시계. 시험은 시각을 정해 부른다. */
  now?: string;
  /** SMTP 응답을 기다리는 최대 시간(ms) */
  timeoutMs?: number;
  /**
   * PDF 첨부 만들기(M6-02가 제공). 없거나 null을 돌려주면 HTML만 보낸다.
   * 왜 주입인가: PDF 렌더러는 M6-02의 일이고, 메일 큐는 그것 없이도 동작해야 한다.
   */
  pdf?: (reportId: string, view: 'int' | 'ext') => Promise<Buffer | null>;
}
export interface DeliverResult { accepted: number; retry: number; failed: number; unknown: number; discarded: number }

interface Claimed { id: string; report: string; reportKey: string; email: string; view: 'int' | 'ext'; pdf: boolean; retried: boolean; projectId: string; sentAt: string }

const SMTP_MISSING = 'SMTP 서버 미설정 — 설정 → 보고서 · 메일에서 메일 서버를 등록하세요.';

async function clock(client: PoolClient, now: string | undefined): Promise<string> {
  return now ?? (await client.query<{ now: string }>(`select ${iso('clock_timestamp()')} now`)).rows[0]?.now ?? new Date().toISOString();
}

async function appendLog(client: PoolClient, outbox: string, state: string, error: string | null, at: string) {
  await client.query(`insert into mail_log(project_id,delivery_id,report,email,state,error,at,outbox,try_no)
    select project_id,delivery_id,report,email,$2,$3,$4,id,try_no from mail_outbox where id=$1`, [outbox, state, error, at]);
}

/**
 * 결과를 적는다. 찜한 그 발송(sent_at이 같은 줄)만 고친다.
 * unknown으로 정리된 뒤에 수락 응답이 늦게 기록되면 accepted로 고친다(사실에 더 가깝다).
 */
async function record(client: PoolClient, c: Claimed, outcome: SendOutcome, now: string): Promise<keyof DeliverResult> {
  let state: 'accepted' | 'retry_wait' | 'failed' | 'unknown';
  let error: string | null = null;
  if (outcome.state === 'accepted') state = 'accepted';
  else if (outcome.state === 'unknown') { state = 'unknown'; error = outcome.error; }
  else { state = c.retried ? 'failed' : 'retry_wait'; error = outcome.error; }
  const nextAt = state === 'retry_wait' ? new Date(Date.parse(now) + RETRY_MINUTES * 60_000).toISOString() : null;
  const updated = await client.query(
    `update mail_outbox set state=$2,error=$3,next_at=$4,retried=retried or $5 where id=$1 and state in ('sending','unknown') and sent_at=$6::timestamptz`,
    [c.id, state, error, nextAt, state === 'retry_wait', c.sentAt]);
  if (!updated.rowCount) return 'discarded';
  await appendLog(client, c.id, state, error, now);
  await syncMailAlert(client, c.projectId);
  deferChange(client, c.projectId, 'mail', { key: 'log' });
  return state === 'retry_wait' ? 'retry' : state;
}

const isEpochMismatch = (error: unknown) => (error as { code?: string }).code === 'AW001';

/** 보낼 차례인 메일을 한 묶음 보낸다. */
export async function deliverMail(pool: Pool, epoch: number, options: DeliverOptions = {}): Promise<DeliverResult> {
  const result: DeliverResult = { accepted: 0, retry: 0, failed: 0, unknown: 0, discarded: 0 };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const claim = await inEpoch(pool, epoch, async (client) => {
    const now = await clock(client, options.now);
    const rows = (await client.query<Omit<Claimed, 'sentAt' | 'reportKey'>>(
      `select id,report,email,view,pdf,retried,project_id "projectId" from mail_outbox
       where state='queued' or (state='retry_wait' and next_at<=$1::timestamptz)
       order by coalesce(next_at,created_at),created_at,id limit ${String(BATCH)} for update skip locked`, [now])).rows;
    if (!rows.length) return { now, items: [] as { c: Claimed; mail: OutgoingMail | null }[], target: null };
    const target = await smtpTarget(client);
    const project = (await client.query<{ name: string }>('select name from projects limit 1')).rows[0]?.name ?? '';
    const appUrl = (await client.query<{ app_url: string | null }>('select app_url from app_settings where singleton')).rows[0]?.app_url ?? null;
    const items: { c: Claimed; mail: OutgoingMail | null }[] = [];
    for (const row of rows) {
      await client.query("update mail_outbox set state='sending',next_at=null,sent_at=$2 where id=$1", [row.id, now]);
      await appendLog(client, row.id, 'sending', null, now);
      const report = await loadReport(client, row.report);
      const c: Claimed = { ...row, reportKey: report.reportKey, sentAt: now };
      if (!target) { items.push({ c, mail: null }); continue; }
      // 미리보기와 같은 함수로 만든다. 스냅샷이라 다시 보내도 같은 내용이다(G L407).
      const rendered = renderMail({ projectName: project, report, view: row.view, to: row.email, appUrl });
      items.push({ c, mail: { from: target.from, to: row.email, ...rendered } });
    }
    return { now, items, target };
  });
  for (const { c, mail } of claim.items) {
    let outcome: SendOutcome;
    if (!mail || !claim.target) outcome = { state: 'rejected', error: SMTP_MISSING };
    else outcome = await send(claim.target, mail, c, options, timeoutMs);
    try {
      const kind = await inEpoch(pool, epoch, (client) => record(client, c, outcome, claim.now));
      result[kind]++;
    } catch (error) {
      if (!isEpochMismatch(error)) throw error;
      result.discarded++;
    }
  }
  return result;
}

async function send(target: SmtpTarget & { from: string }, mail: OutgoingMail, c: Claimed, options: DeliverOptions, timeoutMs: number): Promise<SendOutcome> {
  if (c.pdf && options.pdf) {
    try {
      const report = await options.pdf(c.report, c.view);
      if (report) mail.attachments = [{ filename: pdfName(c.reportKey, c.view), content: report }];
    } catch {
      // PDF를 만들지 못했으면 보내기 전이므로 수락되지 않은 것이 확실하다.
      return { state: 'rejected', error: 'PDF 첨부를 만들지 못함 — 보고서 PDF 상태를 확인하세요.' };
    }
  }
  return sendSmtp(target, mail, timeoutMs);
}

/**
 * worker 시작 때 한 번: 앞선 프로세스가 보내다 죽은 줄(`sending`)을 `unknown`으로 정리한다. 바꾼 줄 수를 돌려준다.
 * 자동 재발송은 하지 않는다. 실패 알림에 포함해 팀장이 「다시 보내기」로 판단한다(contracts §4.4).
 */
export async function recoverMail(pool: Pool, epoch: number, options: { now?: string } = {}): Promise<number> {
  return inEpoch(pool, epoch, async (client) => {
    const now = await clock(client, options.now);
    const rows = (await client.query<{ id: string; projectId: string }>(
      `update mail_outbox set state='unknown',error=$1 where state='sending' returning id,project_id "projectId"`,
      ['보내는 중에 서버가 멈춤 — 수락 여부 불명(받는 쪽에 도착했을 수 있음). 확인 후 다시 보내세요.'])).rows;
    for (const r of rows) await appendLog(client, r.id, 'unknown', '보내는 중에 서버가 멈춤 — 수락 여부 불명', now);
    if (rows[0]) { await syncMailAlert(client, rows[0].projectId); deferChange(client, rows[0].projectId, 'mail', { key: 'log' }); }
    return rows.length;
  });
}
