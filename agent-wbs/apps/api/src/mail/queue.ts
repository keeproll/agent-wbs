/**
 * 메일 발송 큐(G§9.6-6 6 L1050, contracts §2.3·§4.4, data-model §3.7 `mail_outbox`·`mail_log`).
 *
 * 한 줄 = 한 발송. 멱등 키는 「보고서 ID + 받는 사람 ID + 발송 번호(try_no)」다(DB 고유 제약).
 * - 같은 보고서를 같은 사람에게 다시 보내면 발송 번호가 하나 늘어난 새 줄이 생긴다.
 *   왜 새 줄인가: 이전 발송의 결과(실패·수락 여부 불명)를 지우지 않고 남겨야 「몇 번 나갔을 수 있는지」를 안다.
 * - 15분 뒤 자동 재시도는 **같은 줄**에서 한 번만 한다(`retry_wait → sending`, `retried=true`).
 * - 큐에 넣는 일은 SMTP를 부르지 않는다. 그래서 메일 서버 오류가 보고서 생성을 실패시키지 않는다(G L1050).
 *
 * 상태(data-model §3.7): `queued → sending → accepted | retry_wait | failed | unknown`, `retry_wait → sending`.
 * 화면은 G의 4상태로 줄여 보인다. unknown은 「실패 — 수락 여부 불명」이다(G L558).
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from '@awbs/db';
import type { ReportKind } from '@awbs/shared';
import { ApiError, isUuid } from '../changes/http.ts';
import { decodeCursor, encodeCursor, InputProblem } from '../changes/history.ts';
import { deferChange, iso } from '../changes/events.ts';
import { mailSubject, mailView, type MailReport } from './render.ts';

/** 발송 사유(P mailReport why L3384·L4947, G L401) */
export const MAIL_REASON = {
  scheduled: '정기 발송',
  backfill: '서버 시작 · 누락분 보충 후 발송',
  test: '테스트 발송',
  manual: '수동 발송',
  resend: '다시 보내기',
} as const;
export const AUTO_RETRY_NOTE = '자동 재시도 (15분 후)';
export const ALERT_KEY = 'mail:failed';

interface Target { id: string; email: string; view: 'int' | 'ext'; pdf: boolean }

export async function loadReport(client: PoolClient, reportId: string): Promise<MailReport & { projectId: string }> {
  const row = (await client.query<MailReport & { projectId: string }>(
    `select id,report_key "reportKey",kind,to_char("from",'YYYY-MM-DD') "from",to_char("to",'YYYY-MM-DD') "to",${iso('generated_at')} "generatedAt",snapshot,project_id "projectId"
     from reports where id=$1`, [reportId])).rows[0];
  if (!row) throw new ApiError('NOT_FOUND', { resource: 'report', id: reportId }, [], '보고서를 찾을 수 없습니다.');
  return row;
}

async function epochOf(client: PoolClient): Promise<number> {
  return (await client.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch ?? 1;
}

/** 한 보고서를 여러 사람에게 큐에 넣는다. 사람마다 다음 발송 번호를 쓴다. 만든 큐 행 ID를 돌려준다. */
async function enqueue(client: PoolClient, report: MailReport & { projectId: string }, targets: Target[], reason: string): Promise<string[]> {
  if (!targets.length) return [];
  const epoch = await epochOf(client);
  // 같은 보고서·같은 사람의 발송 번호를 차례로 매긴다. 동시에 두 요청이 와도 번호가 겹치지 않게 보고서 단위로 잠근다.
  await client.query("select pg_advisory_xact_lock(hashtextextended('mail:report:' || $1,0))", [report.id]);
  const ids: string[] = [];
  for (const t of targets) {
    const view = mailView(report.kind, t.view);
    // 발송 표시 번호 ML-0001(P mailReport L4011). 보고서 기간 지정 번호(report_custom)와 같은 카운터 방식이다.
    const seq = (await client.query<{ value: number }>(
      `insert into counters(project_id,kind,value) values($1,'mail_log',1)
       on conflict (project_id,kind) do update set value=counters.value+1 returning value::int value`, [report.projectId])).rows[0]?.value ?? 1;
    const row = (await client.query<{ id: string }>(
      `insert into mail_outbox(project_id,delivery_id,epoch,report,recipient,email,try_no,state,view,reason,subject,pdf,log_key)
       values($1,$2,$3,$4,$5,$6,(select coalesce(max(try_no),0)+1 from mail_outbox where report=$4 and recipient=$5),'queued',$7,$8,$9,$10,$11) returning id`,
      [report.projectId, randomUUID(), epoch, report.id, t.id, t.email, view, reason, mailSubject(report, view), t.pdf && report.kind !== 'daily', `ML-${String(seq).padStart(4, '0')}`])).rows[0];
    if (row) ids.push(row.id);
  }
  deferChange(client, report.projectId, 'mail', { key: 'log' });
  return ids;
}

/**
 * 정기 보고서가 생긴 직후(같은 트랜잭션) 구독자를 큐에 넣는다(G L401). 기간 지정 보고서는 넣지 않는다.
 * - 일간 보고서 → 일간 구독자, 팀장용 / 주간 보고서 → 주간 구독자, 각자의 보기.
 * - 보고서 생성 사유가 「누락분 보충」이면 발송 사유도 「서버 시작 · 누락분 보충 후 발송」이다.
 */
export async function enqueueReportMail(client: PoolClient, report: { id: string; kind: ReportKind; reason: string | null }): Promise<number> {
  if (report.kind === 'custom') return 0;
  const targets = (await client.query<Target>(
    `select id,email,view,pdf from mail_recipients where active and ${report.kind === 'daily' ? 'daily' : 'weekly'} order by created_at,id`)).rows;
  if (!targets.length) return 0;
  const reason = report.reason?.includes('보충') ? MAIL_REASON.backfill : MAIL_REASON.scheduled;
  return (await enqueue(client, await loadReport(client, report.id), targets, reason)).length;
}

async function recipientsById(client: PoolClient, ids: string[]): Promise<Target[]> {
  const rows = (await client.query<Target>('select id,email,view,pdf from mail_recipients where id=any($1::uuid[])', [ids])).rows;
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw new ApiError('NOT_FOUND', { resource: 'recipient', id: missing[0] }, [], '받는 사람을 찾을 수 없습니다.');
  return ids.map((id) => rows.find((r) => r.id === id) as Target);
}

/** 수동 발송(POST /api/reports/:reportId/mail). view를 주면 모두 그 보기, 없으면 받는 사람 기본값(G L402). */
export async function sendReportMail(client: PoolClient, reportId: string, body: { recipientIds: string[]; view?: 'int' | 'ext' }) {
  if (!isUuid(reportId)) throw new ApiError('NOT_FOUND', { resource: 'report', id: reportId });
  const report = await loadReport(client, reportId);
  const targets = (await recipientsById(client, body.recipientIds)).map((t) => (body.view ? { ...t, view: body.view } : t));
  return { ids: await enqueue(client, report, targets, MAIL_REASON.manual) };
}

/** 테스트 발송: 최신 보고서를 그 사람에게(G§8.5). 보고서가 없으면 보낼 것이 없다. */
export async function testRecipient(client: PoolClient, recipientId: string) {
  const [target] = await recipientsById(client, [recipientId]);
  const latest = (await client.query<{ id: string }>('select id from reports order by generated_at desc,"to" desc,id desc limit 1')).rows[0];
  if (!latest || !target) throw new ApiError('INVALID_TRANSITION', {}, [], '테스트로 보낼 보고서가 아직 없습니다.', '보고서가 생성된 뒤 다시 시도하세요.');
  return { ids: await enqueue(client, await loadReport(client, latest.id), [target], MAIL_REASON.test) };
}

/**
 * 「아직 해소되지 않은 실패」: 같은 보고서·같은 사람의 **마지막** 발송이 failed·unknown인 줄(P Sel.mailPending L4038).
 * 뒤에 다시 보내 수락됐거나 보내는 중이면 해소(또는 진행 중)로 본다.
 */
/**
 * 삭제한 받는 사람의 실패는 다시 보낼 수 없으므로 「해소되지 않은 실패」에서 뺀다(리뷰 지적 3, UAT-MAIL-05).
 * 기록 자체는 주소와 함께 남는다(G L407).
 */
const PENDING = `o.state in ('failed','unknown') and not exists(select from mail_outbox n where n.report=o.report and n.recipient=o.recipient and n.try_no>o.try_no)
  and exists(select from mail_recipients m where m.id=o.recipient)`;

/** 다시 보내기(행별). 해소되지 않은 실패 줄만 받는다. 이미 해소됐으면 409 — 같은 메일이 두 번 나가지 않게 한다. */
export async function resendMail(client: PoolClient, outboxId: string) {
  if (!isUuid(outboxId)) throw new ApiError('NOT_FOUND', { resource: 'mail_log', id: outboxId });
  const row = (await client.query<{ report: string; recipient: string; email: string; view: 'int' | 'ext'; pdf: boolean; logKey: string; pending: boolean }>(
    `select o.report,o.recipient,o.email,o.view,o.pdf,o.log_key "logKey",(${PENDING}) pending from mail_outbox o where o.id=$1`, [outboxId])).rows[0];
  if (!row) throw new ApiError('NOT_FOUND', { resource: 'mail_log', id: outboxId }, [], '발송 기록을 찾을 수 없습니다.');
  // 같은 보고서를 잠그고 다시 판정한다(두 탭에서 동시에 눌러도 한 번만).
  await client.query("select pg_advisory_xact_lock(hashtextextended('mail:report:' || $1,0))", [row.report]);
  // 지금의 받는 사람 목록으로 확인한다. 삭제와 겹치면 삭제가 끝날 때까지 기다린다(for share). 원본도 삭제된 수신자는 다시 보내지 않는다(P resend L4969).
  const alive = (await client.query('select 1 from mail_recipients where id=$1 for share', [row.recipient])).rowCount;
  if (!alive) throw new ApiError('INVALID_TRANSITION', { id: outboxId }, [], '받는 사람이 삭제되어 다시 보낼 수 없습니다.', '받는 사람을 다시 등록한 뒤 「테스트」나 「메일로 보내기」로 보내세요.');
  const still = (await client.query<{ pending: boolean }>(`select (${PENDING}) pending from mail_outbox o where o.id=$1`, [outboxId])).rows[0]?.pending;
  if (!still) throw new ApiError('INVALID_TRANSITION', { id: outboxId }, [], '이미 다시 보냈거나 실패가 아닌 발송입니다.', '발송 기록을 새로 고친 뒤 확인하세요.');
  const report = await loadReport(client, row.report);
  // 사유는 원본처럼 「다시 보내기 (ML-0001)」 — 어떤 실패 기록을 다시 보냈는지 남긴다(P resend L4970).
  return { ids: await enqueue(client, report, [{ id: row.recipient, email: row.email, view: row.view, pdf: row.pdf }], `${MAIL_REASON.resend} (${row.logKey})`) };
}

/** 실패 건 모두 다시 보내기 */
export async function resendFailed(client: PoolClient) {
  const rows = (await client.query<{ id: string }>(`select o.id from mail_outbox o where ${PENDING} order by o.created_at,o.id`)).rows;
  const ids: string[] = [];
  for (const r of rows) ids.push(...(await resendMail(client, r.id)).ids);
  return { ids };
}

export interface MailLogRow {
  id: string; logKey: string; reportId: string; reportKey: string; recipientId: string | null; to: string; subject: string; view: 'int' | 'ext'; pdf: boolean;
  tryNo: number; state: string; error: string | null; reason: string; at: string; pending: boolean;
}

/**
 * 발송 기록(GET /api/mail/log). 최신 먼저.
 * - `status=failed`: 아직 해소되지 않은 실패만(실패 배지·「실패 건 모두 다시 보내기」와 같은 기준).
 * - recipientId: 받는 사람을 지웠으면 null(주소는 남는다).
 * - reason: 자동 재시도를 했으면 「· 자동 재시도 (15분 후)」를 붙인다.
 */
export async function listMailLog(client: PoolClient, query: { status?: 'failed'; limit?: number; cursor?: string }) {
  const limit = Math.min(query.limit ?? 50, 200);
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor, 2);
  if (query.cursor !== undefined && !after) throw new InputProblem('cursor', 'format', '발송 기록 커서가 올바르지 않습니다.');
  const where = ['true'];
  const values: unknown[] = [];
  if (query.status === 'failed') where.push(PENDING);
  if (after) { values.push(...after); where.push(`(o.updated_at,o.id)<($${String(values.length - 1)}::timestamptz,$${String(values.length)}::uuid)`); }
  values.push(limit + 1);
  const rows = (await client.query<MailLogRow & { cursorAt: string }>(
    `select o.id,o.log_key "logKey",o.report "reportId",r.report_key "reportKey",m.id "recipientId",o.email "to",o.subject,o.view,o.pdf,o.try_no "tryNo",o.state::text state,o.error,
       o.reason || case when o.retried then ' · ${AUTO_RETRY_NOTE}' else '' end reason,${iso('o.updated_at')} at,(${PENDING}) pending,${iso('o.updated_at')} "cursorAt"
     from mail_outbox o join reports r on r.id=o.report left join mail_recipients m on m.id=o.recipient
     where ${where.join(' and ')} order by o.updated_at desc,o.id desc limit $${String(values.length)}`, values)).rows;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((x) => { const { cursorAt, ...item } = x; void cursorAt; return item; }),
    nextCursor: rows.length > limit && last ? encodeCursor([last.cursorAt, last.id]) : null,
  };
}

/**
 * 대시보드 알림(G L407: 「그래도 실패하면 대시보드 알림 + 설정 탭 배지」). 해소되지 않은 실패 수에 맞춰 열거나 고치거나 닫는다.
 * 알림 문구는 P mailReport L4012와 같은 모양이다.
 */
export async function syncMailAlert(client: PoolClient, projectId: string | null): Promise<void> {
  const rows = (await client.query<{ state: string; error: string | null; reportKey: string }>(
    `select o.state::text state,o.error,r.report_key "reportKey" from mail_outbox o join reports r on r.id=o.report where ${PENDING} order by o.updated_at desc`)).rows;
  const open = (await client.query<{ id: string; target: { message?: string } }>(
    'select id,target from alerts where key=$1 and resolved_at is null for update', [ALERT_KEY])).rows[0];
  if (!rows.length) {
    if (open) { await client.query('update alerts set resolved_at=clock_timestamp() where id=$1', [open.id]); deferChange(client, projectId, 'alert', { id: open.id }); }
    return;
  }
  const unknown = rows.filter((r) => r.state === 'unknown').length;
  const reports = [...new Set(rows.map((r) => r.reportKey))];
  const cause = rows[0]?.state === 'unknown' ? '수락 여부 불명 — 중복 가능, 확인 후 다시 보내기' : (rows[0]?.error ?? 'SMTP 연결 실패');
  const message = `보고서 메일 발송 실패 ${String(rows.length)}건 (${reports.slice(0, 3).join(', ')}${reports.length > 3 ? ' 외' : ''})`
    + `${unknown ? ` · 수락 여부 불명 ${String(unknown)}건` : ''} — ${cause} · 설정 → 보고서 · 메일에서 확인`;
  const target = { message, path: '/settings/report' };
  if (open) {
    if (open.target.message !== message) await client.query('update alerts set target=$2,acknowledged_at=null where id=$1', [open.id, JSON.stringify(target)]);
    deferChange(client, projectId, 'alert', { id: open.id });
    return;
  }
  const id = (await client.query<{ id: string }>("insert into alerts(project_id,key,severity,target) values($1,$2,'error',$3) on conflict do nothing returning id",
    [projectId, ALERT_KEY, JSON.stringify(target)])).rows[0]?.id;
  if (id) deferChange(client, projectId, 'alert', { id });
}
