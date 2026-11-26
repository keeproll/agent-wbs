/**
 * 메일 API(G§8.5 표, contracts §2.3). 모두 팀장 세션이다.
 * 인증·CSRF·epoch·멱등 키·트랜잭션은 공통 관문(platform/security.ts)이 이미 처리한다.
 * 발송·재발송·테스트는 큐에 넣고 202 `{ids}`(발송 기록 ID)를 돌려준다. 실제 SMTP 호출은 worker가 한다.
 */
import type { Pool, PoolClient } from '@awbs/db';
import type { FastifyInstance } from 'fastify';
import { ApiError, clientOf, isUuid, params, read, routes } from '../changes/http.ts';
import { listMailLog, loadReport, resendFailed, resendMail, sendReportMail, testRecipient } from './queue.ts';
import { mailView, pdfName, renderMail } from './render.ts';
import { addRecipient, checkSmtpSettings, deleteRecipient, getSmtp, listRecipients, putSmtp, updateRecipient, type SmtpInput } from './settings.ts';

const UUID = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const ID = params({ id: UUID });
/** 보고서 ID는 형식이 틀려도 404로 답한다(없는 보고서와 같게). */
const REPORT = params({ reportId: { type: 'string', minLength: 1 } });
/** 연결 확인은 팀장이 기다리는 요청이다. worker 발송보다 짧게 기다린다. */
const CHECK_TIMEOUT_MS = 15_000;

/** 미리보기(실제 발송과 같은 생성 함수, G§8.5). to는 받는 사람 ID다. */
async function preview(client: PoolClient, reportId: string, query: { view?: 'int' | 'ext'; to?: string }) {
  if (!isUuid(reportId)) throw new ApiError('NOT_FOUND', { resource: 'report', id: reportId }, [], '보고서를 찾을 수 없습니다.');
  const report = await loadReport(client, reportId);
  let to: { email: string; view: 'int' | 'ext'; pdf: boolean } | null = null;
  if (query.to !== undefined) {
    if (!isUuid(query.to)) throw new ApiError('NOT_FOUND', { resource: 'recipient', id: query.to }, [], '받는 사람을 찾을 수 없습니다.');
    to = (await client.query<{ email: string; view: 'int' | 'ext'; pdf: boolean }>('select email,view,pdf from mail_recipients where id=$1', [query.to])).rows[0] ?? null;
    if (!to) throw new ApiError('NOT_FOUND', { resource: 'recipient', id: query.to }, [], '받는 사람을 찾을 수 없습니다.');
  }
  // 보기를 고르지 않았으면 받는 사람 기본값, 그것도 없으면 팀장용. 일간은 항상 팀장용(G L402).
  const view = mailView(report.kind, query.view ?? to?.view ?? 'int');
  const project = (await client.query<{ name: string }>('select name from projects where id=$1', [report.projectId])).rows[0]?.name ?? '';
  const appUrl = (await client.query<{ app_url: string | null }>('select app_url from app_settings where singleton')).rows[0]?.app_url ?? null;
  const rendered = renderMail({ projectName: project, report, view, to: to?.email ?? null, appUrl });
  const smtp = await getSmtp(client);
  return {
    subject: rendered.subject,
    from: smtp.from || '(SMTP 미설정)',
    to: to?.email ?? '(받는 사람)',
    html: rendered.html,
    attachment: to?.pdf && report.kind !== 'daily' ? pdfName(report.reportKey, view) : null,
  };
}

export function registerMailRoutes(app: FastifyInstance, pool: Pool): void {
  routes(app, '보고서 메일', (route) => {
    route('getSmtp', (r) => read(pool, r, getSmtp));
    route('putSmtp', async (r) => putSmtp(clientOf(r), r.body as SmtpInput));
    route('checkSmtp', async (r) => checkSmtpSettings(clientOf(r), CHECK_TIMEOUT_MS));
    route('listRecipients', (r) => read(pool, r, listRecipients));
    route('addRecipient', async (r, reply) => reply.code(201).send(await addRecipient(clientOf(r), r.body as Parameters<typeof addRecipient>[1])));
    route('updateRecipient', async (r) => updateRecipient(clientOf(r), (r.params as { id: string }).id, r.body as Parameters<typeof updateRecipient>[2]), ID);
    route('deleteRecipient', async (r, reply) => {
      await deleteRecipient(clientOf(r), (r.params as { id: string }).id, (r.query as { updatedAt: string }).updatedAt);
      return reply.code(204).send();
    }, ID);
    route('testRecipient', async (r, reply) => reply.code(202).send(await testRecipient(clientOf(r), (r.params as { id: string }).id)), ID);
    route('sendReportMail', async (r, reply) =>
      reply.code(202).send(await sendReportMail(clientOf(r), (r.params as { reportId: string }).reportId, r.body as { recipientIds: string[]; view?: 'int' | 'ext' })), REPORT);
    route('previewReportMail', (r) => read(pool, r, (client) =>
      preview(client, (r.params as { reportId: string }).reportId, r.query as { view?: 'int' | 'ext'; to?: string })), REPORT);
    route('listMailLog', (r) => read(pool, r, (client) => listMailLog(client, r.query as { status?: 'failed'; limit?: number; cursor?: string })));
    route('resendMail', async (r, reply) => reply.code(202).send(await resendMail(clientOf(r), (r.params as { id: string }).id)), ID);
    route('resendFailedMail', async (_r, reply) => reply.code(202).send(await resendFailed(clientOf(_r))));
  });
}
