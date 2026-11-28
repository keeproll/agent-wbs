import { expect, test, vi } from 'vitest';
import type { ReportSnapshotData } from '@awbs/shared';
import { redactText } from '../src/platform/redact.ts';
import { renderMail } from '../src/mail/render.ts';
import { reportHtml } from '../src/pdf/html.ts';
import { chromiumRenderer } from '../src/pdf/render.ts';
import { readPdf } from '../../../e2e/fakes/pdf-inspect.ts';
import { message } from '../src/notify/message.ts';
import { callBot } from '../src/notify/bot.ts';

const token = `ghp_${'m803canary'.repeat(4)}`;
const password = 'm803 password with spaces';
const dirty = `보안 검사 ${token} SMTP_PASSWORD="${password}"`;

test('Telegram의 실제 서비스 주소는 네트워크 요청 전에 거부한다', async () => {
  vi.stubEnv('AWBS_TELEGRAM_BOT_API_URL', 'https://api.telegram.org');
  const fetch = vi.fn(async () => { throw new Error('외부 네트워크를 부르면 안 됩니다.'); });
  vi.stubGlobal('fetch', fetch);
  try {
    expect(await callBot(token, 'sendMessage', { text: '시험' })).toMatchObject({ ok: false, error: 'network' });
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});

const secretSnapshot = (): ReportSnapshotData => ({
  projectName: dirty, projectNameStatus: 'snapshot',
  summary: {
    taskCount: 0, doneCount: 0, doneBefore: 0, workPct: 0, workPctBefore: 0, baselineVersion: 0, forecast: null, lo: null, hi: null, forecastBefore: null,
    target: null, uptimePct: 0, ratePct: 0, blocked: 0, statuses: [], started: [],
    attempts: { total: 0, dev: 0, qa: 0, pass: 0, fail: 0, escalated: 0, interrupted: 0, tokens: 0 },
  },
  issues: [], series: [], done: [], active: [], failures: [], attempts: [], replans: [], gaps: [], messages: [], next: [], all: [],
});

test.each([
  `SMTP_PASSWORD="${password}"`, `SMTP_PASSWORD='${password}'`, `password="${password}"`,
  `Authorization: opaque-${password}`, `Set-Cookie: session=${password}`,
  'AWBS_SECRET_KEY=m803-key-canary',
])('따옴표·공백·헤더에 든 비밀을 가린다: %s', (input) => {
  expect(redactText(input)).not.toContain(password);
  expect(redactText(input)).not.toContain('m803-key-canary');
  expect(redactText(input)).toContain('[REDACTED]');
});

test.each(['int', 'ext'] as const)('%s 메일·PDF·Telegram의 자유 입력에서 비밀을 가린다', (view) => {
  const snapshot = secretSnapshot();
  const report = { id: '00000000-0000-4000-8000-000000000001', reportKey: 'RPT-W-261123', kind: 'weekly' as const,
    from: '2026-11-23', to: '2026-11-29', generatedAt: '2026-11-28T00:00:00.000Z', snapshot };
  const mail = renderMail({ projectName: dirty, report, view, to: null, appUrl: null });
  const html = reportHtml({ ...report, view, dueAt: null, reason: null });
  const telegram = message({ event: 'fail', project: dirty, target: dirty, state: dirty, reason: dirty, path: '/wbs', at: report.generatedAt }, null);
  for (const output of [mail.subject, mail.html, mail.text, html, telegram]) {
    expect(output).not.toContain(token);
    expect(output).not.toContain(password);
  }
  expect(mail.text).toContain('보안 검사');
  expect(snapshot.projectName).toBe(dirty);
});

test('실제 PDF를 다시 열어도 비밀 글자가 없다', async () => {
  const renderer = chromiumRenderer();
  try {
    const bytes = await renderer.render(reportHtml({ reportKey: 'RPT-W-261123', kind: 'weekly', from: '2026-11-23', to: '2026-11-29',
      generatedAt: '2026-11-28T00:00:00.000Z', snapshot: secretSnapshot(), view: 'int', dueAt: null, reason: null }));
    const pdf = await readPdf(bytes);
    const text = pdf.pages.map(p => p.text).join('');
    expect(text).toContain('보안검사');
    expect(text).not.toContain(token);
    expect(text).not.toContain(password.replaceAll(' ', ''));
  } finally { await renderer.close(); }
}, 30_000);
