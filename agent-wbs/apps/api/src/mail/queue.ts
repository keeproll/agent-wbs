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
 *
 * Q-13 결정 A(외부 수신자):
 * - 한 줄은 한 사람에게 가는 한 통이다. 그래서 한 번 발송에 내부 · 외부가 섞여도 받는 사람마다 따로 나가고, 외부 수신자는 내부용 메일을 함께 받지 않는다.
 * - 외부 수신자 줄은 `external=true` · 보고용 · PDF 첨부로 큐에 넣는다. 본문에는 앱 링크 · 내부 경로가 없다(render.ts).
 * - 일간 보고서는 외부 수신자에게 보내지 않는다(팀장용만 있음, G L402). 수동 발송 · 테스트 · 다시 보내기 모두 같은 규칙이다.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from '@awbs/db';
import type { ReportKind } from '@awbs/shared';
import { ApiError, invalid, isUuid } from '../changes/http.ts';
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

interface Target { id: string; email: string; view: 'int' | 'ext'; pdf: boolean; external: boolean }

/** 큐에 넣은 뒤 받는 사람이 외부 수신자로 바뀌었는데 일간 보고서일 때(Q-13 결정 A) */
export const EXTERNAL_DAILY_SKIP = '받는 사람이 외부 수신자로 바뀌어 보내지 않음 — 일간 보고서는 팀장용만 있어 외부로 보내지 않습니다.';

/** 발송 기록(mail_log, 추가 전용)에 한 줄을 남긴다. 큐 줄의 보고서 · 주소 · 발송 번호를 함께 적는다. */
export async function appendLog(client: PoolClient, outbox: string, state: string, error: string | null, at: string) {
  await client.query(`insert into mail_log(project_id,delivery_id,report,email,state,error,at,outbox,try_no)
    select project_id,delivery_id,report,email,$2,$3,$4,id,try_no from mail_outbox where id=$1`, [outbox, state, error, at]);
}

/** 외부 수신자에게 일간 보고서를 보내려 할 때의 안내(Q-13 결정 A) */
export const EXTERNAL_DAILY = '외부 수신자에게는 일간 보고서를 보내지 않습니다 — 일간 보고서는 팀장용(내부 용어 포함)만 있습니다.';

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
    // 외부 수신자는 보고용 + PDF로 고정한다(Q-13 결정 A). 일간은 호출하는 쪽이 먼저 막는다. 그래도 오면 DB 검사가 거부한다.
    if (t.external && report.kind === 'daily') throw new ApiError('INVALID_TRANSITION', { recipient: t.id }, [], EXTERNAL_DAILY);
    const view = t.external ? 'ext' : mailView(report.kind, t.view);
    const pdf = t.external || (t.pdf && report.kind !== 'daily');
    // 발송 표시 번호 ML-0001(P mailReport L4011). 보고서 기간 지정 번호(report_custom)와 같은 카운터 방식이다.
    const seq = (await client.query<{ value: number }>(
      `insert into counters(project_id,kind,value) values($1,'mail_log',1)
       on conflict (project_id,kind) do update set value=counters.value+1 returning value::int value`, [report.projectId])).rows[0]?.value ?? 1;
    const row = (await client.query<{ id: string }>(
      `insert into mail_outbox(project_id,delivery_id,epoch,report,recipient,email,try_no,state,view,reason,subject,pdf,log_key,external)
       values($1,$2,$3,$4,$5,$6,(select coalesce(max(try_no),0)+1 from mail_outbox where report=$4 and recipient=$5),'queued',$7,$8,$9,$10,$11,$12) returning id`,
      [report.projectId, randomUUID(), epoch, report.id, t.id, t.email, view, reason, mailSubject(report, view), pdf, `ML-${String(seq).padStart(4, '0')}`, t.external])).rows[0];
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
    `select id,email,view,pdf,external from mail_recipients where active and ${report.kind === 'daily' ? 'daily and not external' : 'weekly'} order by created_at,id`)).rows;
  if (!targets.length) return 0;
  const reason = report.reason?.includes('보충') ? MAIL_REASON.backfill : MAIL_REASON.scheduled;
  return (await enqueue(client, await loadReport(client, report.id), targets, reason)).length;
}

async function recipientsById(client: PoolClient, ids: string[]): Promise<Target[]> {
  const rows = (await client.query<Target>('select id,email,view,pdf,external from mail_recipients where id=any($1::uuid[])', [ids])).rows;
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw new ApiError('NOT_FOUND', { resource: 'recipient', id: missing[0] }, [], '받는 사람을 찾을 수 없습니다.');
  return ids.map((id) => rows.find((r) => r.id === id) as Target);
}

/**
 * 수동 발송(POST /api/reports/:reportId/mail). view를 주면 모두 그 보기, 없으면 받는 사람 기본값(G L402).
 * - 외부 수신자는 「모두 팀장용」을 골라도 보고용 + PDF로 보낸다(Q-13 결정 A, enqueue).
 * - 일간 보고서에 외부 수신자를 고르면 400이다. 한 통도 큐에 넣지 않는다(일부만 나가면 팀장이 무엇이 갔는지 헷갈린다).
 */
export async function sendReportMail(client: PoolClient, reportId: string, body: { recipientIds: string[]; view?: 'int' | 'ext' }) {
  if (!isUuid(reportId)) throw new ApiError('NOT_FOUND', { resource: 'report', id: reportId });
  const report = await loadReport(client, reportId);
  const targets = (await recipientsById(client, body.recipientIds)).map((t) => (body.view ? { ...t, view: body.view } : t));
  if (report.kind === 'daily') {
    const outside = targets.filter((t) => t.external);
    if (outside.length) throw invalid([{ path: 'recipientIds', rule: 'external', message: `${EXTERNAL_DAILY} (외부 수신자: ${outside.map((t) => t.email).join(', ')})` }], EXTERNAL_DAILY);
  }
  return { ids: await enqueue(client, report, targets, MAIL_REASON.manual) };
}

/** 테스트 발송: 최신 보고서를 그 사람에게(G§8.5). 보고서가 없으면 보낼 것이 없다. */
export async function testRecipient(client: PoolClient, recipientId: string) {
  const [target] = await recipientsById(client, [recipientId]);
  // 외부 수신자는 일간을 받지 않으므로 최신 주간 · 기간 보고서로 시험한다(Q-13 결정 A).
  const latest = (await client.query<{ id: string }>(`select id from reports ${target?.external ? "where kind<>'daily'" : ''} order by record_no desc limit 1`)).rows[0];
  if (!latest || !target) {
    throw new ApiError('INVALID_TRANSITION', {}, [], target?.external ? '외부 수신자에게 테스트로 보낼 주간 · 기간 보고서가 아직 없습니다.' : '테스트로 보낼 보고서가 아직 없습니다.', '보고서가 생성된 뒤 다시 시도하세요.');
  }
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
/**
 * 받는 사람이 그 뒤 외부 수신자로 바뀌어 다시 보낼 수 없는 일간 보고서 실패도 뺀다(Q-13 결정 A). 다시 보내기가 늘 409가 되어 알림이 닫히지 않기 때문이다.
 */
const PENDING = `o.state in ('failed','unknown') and not exists(select from mail_outbox n where n.report=o.report and n.recipient=o.recipient and n.try_no>o.try_no)
  and exists(select from mail_recipients m where m.id=o.recipient
    and not (m.external and exists(select from reports d where d.id=o.report and d.kind='daily')))`;

/** 다시 보내기(행별). 해소되지 않은 실패 줄만 받는다. 이미 해소됐으면 409 — 같은 메일이 두 번 나가지 않게 한다. */
export async function resendMail(client: PoolClient, outboxId: string) {
  if (!isUuid(outboxId)) throw new ApiError('NOT_FOUND', { resource: 'mail_log', id: outboxId });
  const row = (await client.query<{ report: string; recipient: string; email: string; view: 'int' | 'ext'; pdf: boolean; external: boolean; logKey: string; pending: boolean }>(
    `select o.report,o.recipient,o.email,o.view,o.pdf,o.external,o.log_key "logKey",(${PENDING}) pending from mail_outbox o where o.id=$1`, [outboxId])).rows[0];
  if (!row) throw new ApiError('NOT_FOUND', { resource: 'mail_log', id: outboxId }, [], '발송 기록을 찾을 수 없습니다.');
  // 같은 보고서를 잠그고 다시 판정한다(두 탭에서 동시에 눌러도 한 번만).
  await client.query("select pg_advisory_xact_lock(hashtextextended('mail:report:' || $1,0))", [row.report]);
  // 지금의 받는 사람 목록으로 확인한다. 삭제와 겹치면 삭제가 끝날 때까지 기다린다(for share). 원본도 삭제된 수신자는 다시 보내지 않는다(P resend L4969).
  const alive = (await client.query<{ external: boolean }>('select external from mail_recipients where id=$1 for share', [row.recipient])).rows[0];
  if (!alive) throw new ApiError('INVALID_TRANSITION', { id: outboxId }, [], '받는 사람이 삭제되어 다시 보낼 수 없습니다.', '받는 사람을 다시 등록한 뒤 「테스트」나 「메일로 보내기」로 보내세요.');
  // 처음 보낼 때 외부였거나 지금 외부면 외부 규칙으로 다시 보낸다(Q-13 결정 A). 왜 둘 다 보나: 내부 → 외부로 바뀐 사람에게 링크가 든 메일이 다시 나가면 안 된다.
  const external = row.external || alive.external;
  const report = await loadReport(client, row.report);
  if (external && report.kind === 'daily') throw new ApiError('INVALID_TRANSITION', { id: outboxId }, [], `받는 사람이 외부 수신자로 바뀌어 다시 보낼 수 없습니다. ${EXTERNAL_DAILY}`);
  const still = (await client.query<{ pending: boolean }>(`select (${PENDING}) pending from mail_outbox o where o.id=$1`, [outboxId])).rows[0]?.pending;
  if (!still) throw new ApiError('INVALID_TRANSITION', { id: outboxId }, [], '이미 다시 보냈거나 실패가 아닌 발송입니다.', '발송 기록을 새로 고친 뒤 확인하세요.');
  // 사유는 원본처럼 「다시 보내기 (ML-0001)」 — 어떤 실패 기록을 다시 보냈는지 남긴다(P resend L4970).
  return { ids: await enqueue(client, report, [{ id: row.recipient, email: row.email, view: row.view, pdf: row.pdf, external }], `${MAIL_REASON.resend} (${row.logKey})`) };
}

/** 실패 건 모두 다시 보내기 */
export async function resendFailed(client: PoolClient) {
  const rows = (await client.query<{ id: string }>(`select o.id from mail_outbox o where ${PENDING} order by o.created_at,o.id`)).rows;
  const ids: string[] = [];
  for (const r of rows) ids.push(...(await resendMail(client, r.id)).ids);
  return { ids };
}

export interface MailLogRow {
  id: string; logKey: string; reportId: string; reportKey: string; recipientId: string | null; to: string; subject: string; view: 'int' | 'ext'; pdf: boolean; external: boolean;
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
    `select o.id,o.log_key "logKey",o.report "reportId",r.report_key "reportKey",m.id "recipientId",o.email "to",o.subject,o.view,o.pdf,o.external,o.try_no "tryNo",o.state::text state,o.error,
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

/**
 * 받는 사람을 외부로 바꿀 때(Q-13 fix1 3), 그 사람의 **아직 보내지 않은** 줄(queued · retry_wait)을 새 규칙으로 다시 정한다.
 * - 주간 · 기간: 외부 줄로 바꾼다(보고용 · PDF · 링크 없음). 발송 번호 · 자동 재시도 여부는 그대로다(같은 줄).
 * - 일간: 외부용이 없으므로 보내지 않고 `failed`로 적는다. 이 실패는 「해소되지 않은 실패」에서 빠진다(PENDING).
 * - 지금 다른 worker가 찜하는 중인 줄은 `skip locked`로 건너뛴다. 그 줄은 찜하기가 같은 규칙으로 다시 본다(deliver.ts claimOne).
 *   왜 건너뛰나: 찜하기는 줄 → 받는 사람 순서로 잠그고 여기는 반대 순서라, 기다리면 서로 막힌다(교착).
 * 이미 `sending`인 내부 줄이 있으면 바꾸지 않고 409다. 왜: 그 메일은 이미 팀장용으로 만들어져 SMTP로 가는 중이라 되돌릴 수 없다.
 */
export async function externalizePending(client: PoolClient, recipientId: string): Promise<void> {
  const busy = (await client.query("select 1 from mail_outbox where recipient=$1 and state='sending' and not external limit 1", [recipientId])).rowCount;
  if (busy) {
    throw new ApiError('INVALID_TRANSITION', { id: recipientId }, [], '이 받는 사람에게 팀장용 메일을 보내는 중이라 지금은 외부로 바꿀 수 없습니다.', '발송 기록에서 「보내는 중」이 끝난 뒤 다시 바꾸세요.');
  }
  const rows = (await client.query<{ id: string; report: string; projectId: string }>(
    `select id,report,project_id "projectId" from mail_outbox where recipient=$1 and not external and state in ('queued','retry_wait')
     order by created_at,id for update skip locked`, [recipientId])).rows;
  const at = (await client.query<{ at: string }>(`select ${iso('clock_timestamp()')} at`)).rows[0]?.at ?? new Date().toISOString();
  for (const r of rows) {
    const report = await loadReport(client, r.report);
    if (report.kind === 'daily') {
      await client.query("update mail_outbox set state='failed',error=$2,next_at=null where id=$1", [r.id, EXTERNAL_DAILY_SKIP]);
      await appendLog(client, r.id, 'failed', EXTERNAL_DAILY_SKIP, at);
    } else {
      await client.query("update mail_outbox set external=true,view='ext',pdf=true,subject=$2 where id=$1", [r.id, mailSubject(report, 'ext')]);
    }
  }
  if (rows[0]) deferChange(client, rows[0].projectId, 'mail', { key: 'log' });
}
