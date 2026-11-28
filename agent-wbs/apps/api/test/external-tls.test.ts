import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { FakeSmtp } from '../../../e2e/fakes/smtp.ts';
import { testCertificates } from '../../../e2e/fakes/tls.ts';
import { callBot } from '../src/notify/bot.ts';

let certs: ReturnType<typeof testCertificates>;
beforeAll(() => { certs = testCertificates(); });
afterAll(() => { certs?.close(); });

async function client(kind: 'smtp' | 'telegram', input: string, trusted = true) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: kind === 'smtp' ? 'production' : 'test' };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete env.NODE_EXTRA_CA_CERTS;
  if (trusted) env.NODE_EXTRA_CA_CERTS = certs.ca;
  const { stdout } = await promisify(execFile)(process.execPath, ['--conditions=awbs-source', 'e2e/fakes/tls-client.ts', kind, input], {
    cwd: new URL('../../../', import.meta.url), env, timeout: 30_000,
  });
  return JSON.parse(stdout) as unknown;
}

test.each(['SSL/TLS', 'STARTTLS'] as const)('T-15 SMTP %s: 확인·발송 성공, 인증서·이름 오류 거부', async sec => {
  for (const [certificate, trusted, ok] of [[certs.server, true, true], [certs.server, false, false], [certs.wrong, true, false]] as const) {
    const smtp = new FakeSmtp({ ...certificate, starttls: sec === 'STARTTLS' });
    try {
      const port = await smtp.start();
      const result = await client('smtp', JSON.stringify({ host: '127.0.0.1', port, sec, user: smtp.user, password: smtp.password }), trusted);
      expect(result).toMatchObject({ check: { ok }, send: { state: ok ? 'accepted' : 'rejected' } });
      expect(smtp.messages).toHaveLength(ok ? 1 : 0);
      if (ok) expect(smtp.messages[0]?.user).toBe(smtp.user);
    } finally { await smtp.stop(); }
  }
}, 60_000);

test('T-15 STARTTLS 협상을 거부하면 로그인·본문 전에 실패한다', async () => {
  const smtp = new FakeSmtp();
  try {
    const port = await smtp.start();
    expect(await client('smtp', JSON.stringify({ host: '127.0.0.1', port, sec: 'STARTTLS', user: smtp.user, password: smtp.password })))
      .toMatchObject({ check: { ok: false }, send: { state: 'rejected' } });
    expect(smtp.messages).toHaveLength(0);
  } finally { await smtp.stop(); }
});

test('T-15 Telegram HTTPS: 봇 확인·대화 조회·발송, 인증서·이름 오류 거부', async () => {
  for (const [certificate, trusted, ok] of [[certs.server, true, true], [certs.server, false, false], [certs.wrong, true, false]] as const) {
    const methods: string[] = [];
    const bot = createServer(certificate, (req, res) => {
      methods.push(req.url?.split('/').at(-1) ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
    try {
      await new Promise<void>(resolve => bot.listen(0, '127.0.0.1', resolve));
      const address = bot.address();
      if (!address || typeof address === 'string') throw new Error('가짜 HTTPS 주소 없음');
      const result = await client('telegram', `https://127.0.0.1:${String(address.port)}`, trusted);
      expect(result).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ ok })));
      expect(methods).toEqual(ok ? ['getMe', 'getUpdates', 'sendMessage'] : []);
    } finally {
      bot.closeAllConnections();
      await new Promise<void>(resolve => bot.close(() => resolve()));
    }
  }
}, 60_000);

test.each(['production', 'development', 'test'])('T-15 Telegram %s: 기본 주소는 공식 HTTPS다', async mode => {
  vi.stubEnv('NODE_ENV', mode);
  delete process.env.AWBS_TELEGRAM_BOT_API_URL;
  const fetch = vi.fn(async () => Response.json({ ok: true, result: {} }));
  vi.stubGlobal('fetch', fetch);
  try {
    expect(await callBot('awbs-W5-token', 'getMe')).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledWith('https://api.telegram.org/botawbs-W5-token/getMe', expect.objectContaining({ redirect: 'error' }));
  } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
});

test.each(['http://127.0.0.1:9', 'https://127.0.0.1:9', 'https://example.invalid', 'http://api.telegram.org',
  'https://api.telegram.org:444', 'https://user:pass@api.telegram.org', 'https://api.telegram.org/path',
  'https://api.telegram.org/?key=value', 'https://api.telegram.org/#part'])('T-15 운영 Telegram 주소 거부: %s', async endpoint => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('AWBS_TELEGRAM_BOT_API_URL', endpoint);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    expect(await callBot('awbs-W5-token', 'sendMessage')).toEqual({ ok: false, error: 'network', retryAfter: null });
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
});
