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

/** 이 시각보다 오래 `sending`에 머문 줄은 결과를 기록하지 못한 것으로 본다(SMTP 응답 대기의 10배 + 2분). */
const staleSeconds = (timeoutMs: number) => Math.ceil((timeoutMs * 10) / 1000) + 120;
const RESULT_LOST = '발송 결과를 저장하지 못함 — 수락 여부 불명(받는 쪽에 도착했을 수 있음). 확인 후 다시 보내세요.';
const RECIPIENT_GONE = '받는 사람이 삭제되어 보내지 않음';

/**
 * 결과를 적는다. 찜한 그 발송(sent_at이 같은 줄)만 고친다.
 * - 시각은 DB 시계다(시험은 options.now). 15분 재시도는 **결과를 기록하는 지금**부터 센다(리뷰 지적 6).
 *   왜 DB 시계인가: 이 PC의 시계는 가끔 뒤로 간다(약 32초마다 2.3초). 판정(next_at ≤ 지금)과 기록을 같은 시계로 해야 일찍 다시 보내지 않는다.
 * - unknown으로 정리된 뒤에 수락 응답이 늦게 기록되면 accepted로 고친다(사실에 더 가깝다).
 */
async function record(client: PoolClient, c: Claimed, outcome: SendOutcome, now: string | null): Promise<keyof DeliverResult> {
  let state: 'accepted' | 'retry_wait' | 'failed' | 'unknown';
  let error: string | null = null;
  if (outcome.state === 'accepted') state = 'accepted';
  else if (outcome.state === 'unknown') { state = 'unknown'; error = outcome.error; }
  else { state = c.retried ? 'failed' : 'retry_wait'; error = outcome.error; }
  const at = (await client.query<{ at: string }>(`select ${iso('coalesce($1::timestamptz,clock_timestamp())')} at`, [now])).rows[0]?.at ?? new Date().toISOString();
  const updated = await client.query(
    `update mail_outbox set state=$2,error=$3,next_at=case when $6 then $4::timestamptz + interval '${String(RETRY_MINUTES)} minutes' end,
       retried=retried or $6 where id=$1 and state in ('sending','unknown') and sent_at=$5::timestamptz`,
    [c.id, state, error, at, c.sentAt, state === 'retry_wait']);
  if (!updated.rowCount) return 'discarded';
  await appendLog(client, c.id, state, error, at);
  await syncMailAlert(client, c.projectId);
  deferChange(client, c.projectId, 'mail', { key: 'log' });
  return state === 'retry_wait' ? 'retry' : state;
}

const isEpochMismatch = (error: unknown) => (error as { code?: string }).code === 'AW001';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 결과 기록(리뷰 지적 1). 메일을 다시 보내지 않고 **기록만** 몇 번 다시 시도한다.
 * 끝내 적지 못하면 그 줄만 unknown으로 적어 드러낸다(알림 포함). 그것도 실패하면 다음 주기의 정리(sweepStale)가 맡는다.
 * 어느 경우에도 예외를 올리지 않는다. 그래서 한 통의 기록 실패가 다른 메일 발송을 멈추지 않는다.
 */
async function recordSafely(pool: Pool, epoch: number, c: Claimed, outcome: SendOutcome, now: string | null): Promise<keyof DeliverResult> {
  for (const wait of [0, 100, 300]) {
    if (wait) await pause(wait);
    try { return await inEpoch(pool, epoch, (client) => record(client, c, outcome, now)); } catch (error) {
      if (isEpochMismatch(error)) return 'discarded';
    }
  }
  try {
    return await inEpoch(pool, epoch, async (client) => {
      const at = (await client.query<{ at: string }>(`select ${iso('coalesce($1::timestamptz,clock_timestamp())')} at`, [now])).rows[0]?.at ?? new Date().toISOString();
      const updated = await client.query(`update mail_outbox set state='unknown',error=$2,next_at=null where id=$1 and state='sending' and sent_at=$3::timestamptz`, [c.id, RESULT_LOST, c.sentAt]);
      if (!updated.rowCount) return 'discarded' as const;
      await appendLog(client, c.id, 'unknown', RESULT_LOST, at);
      await syncMailAlert(client, c.projectId);
      deferChange(client, c.projectId, 'mail', { key: 'log' });
      return 'unknown' as const;
    });
  } catch { return 'unknown'; }
}

/**
 * 오래 `sending`에 머문 줄을 unknown으로 정리한다(리뷰 지적 1: 프로세스 재시작을 기다리지 않는다).
 * 살아 있는 발송은 SMTP 응답 대기 시간 안에 끝나므로, 그 10배 + 2분이 지난 줄은 결과를 잃은 것이다.
 */
async function sweepStale(client: PoolClient, now: string | null, timeoutMs: number): Promise<number> {
  const rows = (await client.query<{ id: string; projectId: string; at: string }>(
    `update mail_outbox set state='unknown',error=$2 where state='sending'
       and sent_at < coalesce($1::timestamptz,clock_timestamp()) - make_interval(secs => $3)
     returning id,project_id "projectId",${iso('coalesce($1::timestamptz,clock_timestamp())')} at`, [now, RESULT_LOST, staleSeconds(timeoutMs)])).rows;
  for (const r of rows) await appendLog(client, r.id, 'unknown', RESULT_LOST, r.at);
  if (rows[0]) { await syncMailAlert(client, rows[0].projectId); deferChange(client, rows[0].projectId, 'mail', { key: 'log' }); }
  return rows.length;
}

/**
 * 한 통을 찜한다(리뷰 지적 1: 묶음으로 찜하지 않는다). 받는 사람을 지웠으면 보내지 않고 실패로 적는다(리뷰 지적 3).
 * 돌려주는 것: 보낼 것 / 건너뛴 것 / 없음(null)
 */
async function claimOne(client: PoolClient, now: string | null): Promise<{ c: Claimed; mail: OutgoingMail | null; target: (SmtpTarget & { from: string }) | null } | 'skipped' | null> {
  const row = (await client.query<Omit<Claimed, 'sentAt' | 'reportKey'> & { recipient: string }>(
    `select id,report,recipient,email,view,pdf,retried,project_id "projectId" from mail_outbox
     where state='queued' or (state='retry_wait' and next_at<=coalesce($1::timestamptz,clock_timestamp()))
     order by coalesce(next_at,created_at),created_at,id limit 1 for update skip locked`, [now])).rows[0];
  if (!row) return null;
  // 발송 직전에 지금의 받는 사람 목록으로 다시 확인한다. 삭제와 겹치면 삭제가 끝날 때까지 기다린다(for share).
  const alive = (await client.query('select 1 from mail_recipients where id=$1 for share', [row.recipient])).rowCount;
  const at = (await client.query<{ at: string }>(`select ${iso('coalesce($1::timestamptz,clock_timestamp())')} at`, [now])).rows[0]?.at ?? new Date().toISOString();
  if (!alive) {
    await client.query("update mail_outbox set state='failed',error=$2,next_at=null where id=$1", [row.id, RECIPIENT_GONE]);
    await appendLog(client, row.id, 'failed', RECIPIENT_GONE, at);
    await syncMailAlert(client, row.projectId);
    deferChange(client, row.projectId, 'mail', { key: 'log' });
    return 'skipped';
  }
  await client.query("update mail_outbox set state='sending',next_at=null,sent_at=$2 where id=$1", [row.id, at]);
  await appendLog(client, row.id, 'sending', null, at);
  const report = await loadReport(client, row.report);
  const c: Claimed = { id: row.id, report: row.report, email: row.email, view: row.view, pdf: row.pdf, retried: row.retried, projectId: row.projectId, reportKey: report.reportKey, sentAt: at };
  const target = await smtpTarget(client);
  if (!target) return { c, mail: null, target: null };
  const project = (await client.query<{ name: string }>('select name from projects limit 1')).rows[0]?.name ?? '';
  const appUrl = (await client.query<{ app_url: string | null }>('select app_url from app_settings where singleton')).rows[0]?.app_url ?? null;
  // 미리보기와 같은 함수로 만든다. 스냅샷이라 다시 보내도 같은 내용이다(G L407).
  const rendered = renderMail({ projectName: project, report, view: row.view, to: row.email, appUrl });
  return { c, mail: { from: target.from, to: row.email, ...rendered }, target };
}

/**
 * 보낼 차례인 메일을 최대 BATCH통 보낸다. 한 통씩 「찜하기 커밋 → SMTP → 기록」을 되풀이한다.
 * - 시각은 DB 시계다. 시험은 options.now로 정한다.
 * - 옛 세대 번호면 첫 정리 단계에서 AW001을 올린다(아무것도 보내지 않음).
 */
export async function deliverMail(pool: Pool, epoch: number, options: DeliverOptions = {}): Promise<DeliverResult> {
  const result: DeliverResult = { accepted: 0, retry: 0, failed: 0, unknown: 0, discarded: 0 };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? null;
  result.unknown += await inEpoch(pool, epoch, (client) => sweepStale(client, now, timeoutMs));
  for (let i = 0; i < BATCH; i++) {
    let claimed: Awaited<ReturnType<typeof claimOne>>;
    try { claimed = await inEpoch(pool, epoch, (client) => claimOne(client, now)); } catch (error) {
      // 초기화로 세대가 바뀌었으면 이번 주기를 끝낸다. 그 밖의 찜하기 실패는 아무것도 보내기 전이므로 그대로 올린다.
      if (isEpochMismatch(error)) break;
      throw error;
    }
    if (!claimed) break;
    if (claimed === 'skipped') { result.failed++; continue; }
    const { c, mail, target } = claimed;
    const outcome: SendOutcome = !mail || !target ? { state: 'rejected', error: SMTP_MISSING } : await send(target, mail, c, options, timeoutMs);
    result[await recordSafely(pool, epoch, c, outcome, now)]++;
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
