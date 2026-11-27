import { createServer } from 'node:http';
import { expect } from 'vitest';
import type { Scenario } from './test/scenario.ts';

/**
 * 시험용 Telegram Bot API(fake BotAPI, 실제 Telegram 대신 요청을 받아 적는 작은 HTTP 서버).
 * telegram 시나리오(M6-04)와 M7-06 완료 흐름(UAT-TG-05)이 함께 쓴다(M6·M7 통합에서 공용으로 옮김).
 * 서버 주소와 비밀 암호 키를 환경 변수로 바꾸므로, 끝나면 close()로 되돌린다.
 */
export const BOT_TOKEN = `123456789:${'fake_only_'.repeat(4)}abcd`;

export async function fakeBotApi() {
  const previous = { url: process.env.AWBS_TELEGRAM_BOT_API_URL, key: process.env.AWBS_SECRET_KEY };
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  let error = 0;
  let migrated = false;
  let invalidResponse = false;
  let empty = false;
  let responseDelay = 0;
  let responseAt = 0;
  let onAccept: (() => void) | undefined;
  const bot = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += String(chunk);
    const method = req.url?.split('/').at(-1) ?? '';
    requests.push({ method, body: JSON.parse(text || '{}') as Record<string, unknown> });
    if (method === 'sendMessage' && invalidResponse) { res.statusCode = 503; res.end('응답 유실'); return; }
    if (responseDelay) await new Promise(resolve => setTimeout(resolve, responseDelay));
    responseAt = Date.now();
    res.setHeader('content-type', 'application/json');
    if (method === 'sendMessage' && !error) res.once('finish', () => { onAccept?.(); });
    res.end(JSON.stringify(error ? { ok: false, error_code: error, description: '원문에 비밀이 있어도 전달하지 않는다',
      parameters: { ...(error === 429 ? { retry_after: 15 } : {}), ...(migrated ? { migrate_to_chat_id: -1004123456789 } : {}) } }
      : { ok: true, result: method === 'getMe' ? { id: 123456789, is_bot: true, username: 'fake_bot', first_name: '시험 봇' }
        : method === 'getUpdates' ? empty ? [] : [
          { update_id: 1, message: { date: 1795740000, chat: { id: 512345678, type: 'private', first_name: '팀장' } } },
          { update_id: 2, message: { date: 1795740001, chat: { id: -4123456789, type: 'group', title: '개발 그룹' } } },
          { update_id: 3, channel_post: { date: 1795740002, chat: { id: -100123456789, type: 'channel', title: '제외할 채널' } } },
        ] : { message_id: 1, chat: { id: -4123456789, type: 'group', title: '개발 그룹' } } }));
  });
  await new Promise<void>(resolve => bot.listen(0, '127.0.0.1', resolve));
  const address = bot.address();
  if (!address || typeof address === 'string') throw new Error('fake 주소 없음');
  process.env.AWBS_TELEGRAM_BOT_API_URL = `http://127.0.0.1:${String(address.port)}`;
  process.env.AWBS_SECRET_KEY = 'a'.repeat(64);
  const close = async () => {
    await new Promise<void>(resolve => bot.close(() => resolve()));
    if (previous.url === undefined) delete process.env.AWBS_TELEGRAM_BOT_API_URL; else process.env.AWBS_TELEGRAM_BOT_API_URL = previous.url;
    if (previous.key === undefined) delete process.env.AWBS_SECRET_KEY; else process.env.AWBS_SECRET_KEY = previous.key;
  };
  return { server: bot, close, requests, invalidResponse: () => { invalidResponse = true; }, fail: (code: number, migrate = false) => { error = code; migrated = migrate; }, empty: () => { empty = true; }, onAccept: (fn?: () => void) => { onAccept = fn; }, delay: (ms: number) => { responseDelay = ms; }, responseAt: () => responseAt };
}


/** 화면과 같은 API로 Telegram 연결을 확인·테스트·저장한다(봇 확인 → 테스트 전송 → 켜기). */
export async function connectTelegram(s: Pick<Scenario, 'lead'>) {
  const current = (await s.lead('GET', '/api/notify/telegram')).body;
  const body = { botToken: BOT_TOKEN, chatId: '-4123456789', targetName: '팀장' };
  expect((await s.lead('POST', '/api/notify/telegram/check-bot', { botToken: BOT_TOKEN })).body).toMatchObject({ ok: true, bot: { username: 'fake_bot' } });
  const tested = await s.lead('POST', '/api/notify/telegram/test', body);
  expect(tested.body).toMatchObject({ ok: true, error: null });
  const tracked = await s.lead('GET', `/api/notify/telegram?testId=${String(tested.body.testId)}`);
  expect(tracked.body).toMatchObject({ tokenSet: false, test: { ok: true } });
  const saved = await s.lead('PUT', '/api/notify/telegram', { ...body, enabled: true, updatedAt: current.updatedAt });
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({ enabled: true, tokenSet: true, tokenLast4: 'abcd', test: { ok: true } });
  return saved.body;
}
