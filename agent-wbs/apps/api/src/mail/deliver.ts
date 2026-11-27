import { reportProjectName } from '@awbs/shared';
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
import { appendLog, EXTERNAL_DAILY_SKIP, loadReport, syncMailAlert } from './queue.ts';
import { externalMailLeaks, mailSubject, pdfName, renderMail } from './render.ts';
import { smtpTarget } from './settings.ts';
import { mailTransition, type Incoming, type MailState } from './transition.ts';
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

/** 찜한 한 통. attempt는 이번 찜하기에서 새로 매긴 시도 ID다(결과가 이 시도의 것인지 판정). */
interface Claimed { id: string; report: string; reportKey: string; email: string; view: 'int' | 'ext'; pdf: boolean; external: boolean; retried: boolean; projectId: string; sentAt: string; attempt: string; appUrl?: string | null }

const SMTP_MISSING = 'SMTP 서버 미설정 — 설정 → 보고서 · 메일에서 메일 서버를 등록하세요.';

async function clock(client: PoolClient, now: string | undefined): Promise<string> {
  return now ?? (await client.query<{ now: string }>(`select ${iso('clock_timestamp()')} now`)).rows[0]?.now ?? new Date().toISOString();
}


/** 이 시각보다 오래 `sending`에 머문 줄은 결과를 기록하지 못한 것으로 본다(SMTP 응답 대기의 10배 + 2분). */
const staleSeconds = (timeoutMs: number) => Math.ceil((timeoutMs * 10) / 1000) + 120;
const RESULT_LOST = '발송 결과를 저장하지 못함 — 수락 여부 불명(받는 쪽에 도착했을 수 있음). 확인 후 다시 보내세요.';
const RECIPIENT_GONE = '받는 사람이 삭제되어 보내지 않음';

/**
 * 도착한 결과를 적는다. 상태를 어떻게 바꿀지는 전이표(transition.ts) 하나로 정한다.
 * - 줄을 잠그고 지금 상태 · 지금 시도(attempt)를 읽는다. 내가 찜한 시도가 아직 현재인지 비교한다(원칙 1).
 * - unknown에서는 늦은 accepted만 고친다. 늦은 실패는 이력에만 남기고 자동 재시도를 다시 켜지 않는다(원칙 2).
 * - 시각은 DB 시계다(시험은 options.now). 15분 재시도는 **결과를 기록하는 지금**부터 센다(리뷰 지적 6).
 *   왜 DB 시계인가: 이 PC의 시계는 가끔 뒤로 간다(약 32초마다 2.3초). 판정(next_at ≤ 지금)과 기록을 같은 시계로 해야 일찍 다시 보내지 않는다.
 */
async function applyResult(client: PoolClient, c: Claimed, incoming: Incoming, error: string | null, now: string | null): Promise<keyof DeliverResult> {
  const row = (await client.query<{ state: MailState; attempt: string | null; retried: boolean }>(
    'select state::text state,attempt::text attempt,retried from mail_outbox where id=$1 for update', [c.id])).rows[0];
  if (!row) return 'discarded';
  const t = mailTransition(row.state, incoming, { current: row.attempt === c.attempt, retried: row.retried });
  const at = (await client.query<{ at: string }>(`select ${iso('coalesce($1::timestamptz,clock_timestamp())')} at`, [now])).rows[0]?.at ?? new Date().toISOString();
  if (t.to) {
    await client.query(
      `update mail_outbox set state=$2,error=$3,next_at=case when $5 then $4::timestamptz + interval '${String(RETRY_MINUTES)} minutes' end,
         retried=retried or $5 where id=$1`,
      [c.id, t.to, t.to === 'accepted' ? null : error, at, t.to === 'retry_wait']);
    if (t.log) await appendLog(client, c.id, t.to, t.to === 'accepted' ? null : error, at);
    await syncMailAlert(client, c.projectId);
    deferChange(client, c.projectId, 'mail', { key: 'log' });
    return t.to === 'retry_wait' ? 'retry' : t.to === 'accepted' || t.to === 'failed' || t.to === 'unknown' ? t.to : 'discarded';
  }
  // 상태는 그대로. 실제로 받은 응답은 무엇이었는지 이력에만 남긴다.
  if (t.log) {
    const logState = incoming === 'accepted' ? 'accepted' : incoming === 'rejected' ? 'failed' : 'unknown';
    await appendLog(client, c.id, logState, `늦은 응답(상태 변경 없음 · 지금 ${row.state}): ${error ?? '수락(250)'}`, at);
    deferChange(client, c.projectId, 'mail', { key: 'log' });
  }
  return 'discarded';
}

async function record(client: PoolClient, c: Claimed, outcome: SendOutcome, now: string | null): Promise<keyof DeliverResult> {
  if (outcome.state === 'accepted') return applyResult(client, c, 'accepted', null, now);
  return applyResult(client, c, outcome.state === 'unknown' ? 'unknown' : 'rejected', outcome.error, now);
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
      return applyResult(client, c, 'record_lost', RESULT_LOST, now);
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
  const row = (await client.query<Omit<Claimed, 'sentAt' | 'reportKey' | 'attempt'> & { recipient: string }>(
    `select id,report,recipient,email,view,pdf,external,retried,project_id "projectId" from mail_outbox
     where state='queued' or (state='retry_wait' and next_at<=coalesce($1::timestamptz,clock_timestamp()))
     order by coalesce(next_at,created_at),created_at,id limit 1 for update skip locked`, [now])).rows[0];
  if (!row) return null;
  // 발송 직전에 지금의 받는 사람 목록으로 다시 확인한다. 삭제와 겹치면 삭제가 끝날 때까지 기다린다(for share).
  const alive = (await client.query<{ external: boolean }>('select external from mail_recipients where id=$1 for share', [row.recipient])).rows[0];
  const at = (await client.query<{ at: string }>(`select ${iso('coalesce($1::timestamptz,clock_timestamp())')} at`, [now])).rows[0]?.at ?? new Date().toISOString();
  const report = await loadReport(client, row.report);
  // Q-13 결정 A: 큐에 넣은 뒤 받는 사람이 외부 수신자로 바뀌었으면, 보내기 직전에 이 줄을 외부 규칙(보고용 · PDF · 링크 없음)으로 바꾼다.
  // 일간 보고서는 외부용이 없으므로 보내지 않는다. 왜: 큐에 넣은 순간의 설정만 믿으면 링크와 내부 용어가 든 메일이 밖으로 나간다.
  const skip = !alive ? RECIPIENT_GONE : alive.external && !row.external && report.kind === 'daily' ? EXTERNAL_DAILY_SKIP : null;
  if (skip) {
    await client.query("update mail_outbox set state='failed',error=$2,next_at=null where id=$1", [row.id, skip]);
    await appendLog(client, row.id, 'failed', skip, at);
    await syncMailAlert(client, row.projectId);
    deferChange(client, row.projectId, 'mail', { key: 'log' });
    return 'skipped';
  }
  if (alive?.external && !row.external) {
    await client.query("update mail_outbox set external=true,view='ext',pdf=true,subject=$2 where id=$1", [row.id, mailSubject(report, 'ext')]);
    Object.assign(row, { external: true, view: 'ext', pdf: true });
  }
  // 찜할 때마다 새 시도 ID를 매긴다. 결과는 이 ID가 아직 현재일 때만 상태를 바꾼다(transition.ts 원칙 1).
  const attempt = (await client.query<{ attempt: string }>("update mail_outbox set state='sending',next_at=null,sent_at=$2,attempt=gen_random_uuid() where id=$1 returning attempt::text attempt", [row.id, at])).rows[0]?.attempt ?? '';
  await appendLog(client, row.id, 'sending', null, at);
  const c: Claimed = { id: row.id, report: row.report, email: row.email, view: row.view, pdf: row.pdf, external: row.external, retried: row.retried, projectId: row.projectId, reportKey: report.reportKey, sentAt: at, attempt };
  const target = await smtpTarget(client);
  if (!target) return { c, mail: null, target: null };
  // M6 통합: 제목의 프로젝트 이름은 스냅샷 값이다(M6-02 조정자 7, 화면·PDF와 같은 reportProjectName). 지금 이름을 읽지 않는다.
  const project = reportProjectName(report.snapshot);
  const appUrl = (await client.query<{ app_url: string | null }>('select app_url from app_settings where singleton')).rows[0]?.app_url ?? null;
  // 미리보기와 같은 함수로 만든다. 스냅샷이라 다시 보내도 같은 내용이다(G L407).
  // 외부 수신자면 링크 · 내부 경로 없이 만든다(Q-13 결정 A).
  const rendered = renderMail({ projectName: project, report, view: row.view, to: row.email, appUrl, external: row.external });
  c.appUrl = appUrl;
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

/** 외부 수신자 메일에 PDF가 없을 때(Q-13 결정 A) */
const EXTERNAL_LEAK = '외부 수신자 메일 검사 실패 — 링크 · 앱 경로 · 내부 용어가 남아 보내지 않음';
const EXTERNAL_NO_PDF = 'PDF 첨부를 만들지 못해 외부 수신자에게 보내지 않음 — 외부 수신자는 링크 없이 PDF로만 전체 내용을 봅니다.';

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
  // 외부 수신자는 링크가 없으므로 PDF가 유일한 전체 보고서다. PDF 없이 요약만 보내지 않는다(보내기 전 실패 → 15분 재시도 규칙).
  if (c.external && !mail.attachments?.length) return { state: 'rejected', error: EXTERNAL_NO_PDF };
  // 발송 직전 검사(Q-13 fix1): 외부로 나가는 제목 · 본문 · 첨부 이름 전체에 링크 · 앱 경로 · 내부 용어가 하나라도 남았으면 보내지 않는다.
  // 변환 함수(externalText)가 이미 걸렀어야 한다. 그래도 남았다면 코드 결함이므로, 보내기 전 실패로 남겨 팀장이 보게 한다.
  if (c.external) {
    const leaks = externalMailLeaks(mail, c.appUrl ?? null);
    if (leaks.length) return { state: 'rejected', error: `${EXTERNAL_LEAK} (${String(leaks.length)}건)` };
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
