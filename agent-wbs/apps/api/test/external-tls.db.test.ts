import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { scenario, type Scenario } from '../../../e2e/fakes/test/scenario.ts';
import { FakeSmtp } from '../../../e2e/fakes/smtp.ts';
import { deliverMail } from '../src/mail/deliver.ts';
import { generateDueReports } from '../src/reports/service.ts';

let s: Scenario;
const smtp = new FakeSmtp();
beforeAll(async () => {
  s = await scenario();
  await smtp.start();
}, 60_000);
afterAll(async () => { await s?.close(); await smtp.stop(); });

test('T-15 운영 SMTP: API 저장 거부·옛 설정 확인 실패·worker 발송 거부, DB/계약 변경 없음', async () => {
  const input = { updatedAt: null, host: '127.0.0.1', port: smtp.port, sec: '없음', from: 'w5@example.com', user: '' };
  // 이행 전 평문 설정을 시험 모드에서 저장한 뒤 운영 모드로 바꾼다.
  expect((await s.lead('PUT', '/api/settings/mail/smtp', input)).status).toBe(200);
  await s.rows("update projects set start_date='2026-10-27', target_date='2026-11-12'");
  await generateDueReports(s.pool, 1, { now: '2026-11-04T07:00:00+09:00', startup: true });
  const recipient = await s.lead('POST', '/api/settings/mail/recipients', { email: 'w5@example.com', name: 'W5', daily: true, weekly: false, view: 'int', pdf: false });
  expect(recipient.status).toBe(201);
  const queued = await s.lead('POST', `/api/settings/mail/recipients/${String(recipient.body.id)}/test`);
  expect(queued.status).toBe(202);
  const before = smtp.connections;
  const current = (await s.lead('GET', '/api/settings/mail/smtp')).body;
  vi.stubEnv('NODE_ENV', 'production');
  try {
    const refused = await s.lead('PUT', '/api/settings/mail/smtp', { ...input, updatedAt: current.updatedAt });
    expect(refused.status).toBe(400);
    expect(refused.body.error.errors).toContainEqual(expect.objectContaining({ path: 'sec', message: expect.stringContaining('SSL/TLS 또는 STARTTLS') }));
    const checked = await s.lead('POST', '/api/settings/mail/smtp/check');
    expect(checked.body).toMatchObject({ ok: false, error: expect.stringContaining('SSL/TLS 또는 STARTTLS') });
    expect((await s.lead('GET', '/api/settings/mail/smtp')).body).toMatchObject({ sec: '없음', check: { ok: false } });
    await deliverMail(s.pool, 1, { now: '2026-11-05T07:00:00+09:00' });
    const row = (await s.pool.query('select state,error from mail_outbox where id=$1', [queued.body.ids[0]])).rows[0];
    expect(row).toMatchObject({ state: 'retry_wait', error: expect.stringContaining('SSL/TLS 또는 STARTTLS') });
    expect(smtp.connections).toBe(before);
    expect(smtp.messages).toHaveLength(0);
    for (const sec of ['SSL/TLS', 'STARTTLS']) {
      const version = (await s.lead('GET', '/api/settings/mail/smtp')).body.updatedAt;
      expect((await s.lead('PUT', '/api/settings/mail/smtp', { ...input, updatedAt: version, sec })).status).toBe(200);
    }
  } finally { vi.unstubAllEnvs(); }
});
