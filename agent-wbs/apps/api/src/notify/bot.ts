export type TelegramError = 'token_invalid' | 'chat_not_found' | 'forbidden' | 'rate_limited' | 'network' | 'webhook_in_use' | 'chat_migrated';
export interface Bot { id: number; username: string; name: string }
export interface Chat { chatId: string; title: string; type: string; lastAt?: string }
export interface BotResult { ok: boolean; error: TelegramError | null; retryAfter: number | null; uncertain?: boolean; result?: Record<string, unknown> | unknown[] }

/** 운영은 Telegram 공식 HTTPS 주소만, 로컬 fake 주소는 시험에서만 쓴다. */
export async function callBot(token: string, method: 'getMe' | 'getUpdates' | 'sendMessage', body: object = {}): Promise<BotResult> {
  const endpoint = process.env.AWBS_TELEGRAM_BOT_API_URL ?? 'https://api.telegram.org';
  let attempted = false;
  try {
    const url = new URL(endpoint);
    const official = url.origin === 'https://api.telegram.org';
    const fake = process.env.NODE_ENV === 'test' && ['http:', 'https:'].includes(url.protocol) && url.hostname === '127.0.0.1';
    if ((!official && !fake) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
      return { ok: false, error: 'network', retryAfter: null };
    }
    attempted = true;
    const response = await fetch(`${url.origin}/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000), redirect: 'error',
    });
    const data = await response.json() as { ok?: boolean; result?: Record<string, unknown> | unknown[]; error_code?: number; parameters?: { retry_after?: number; migrate_to_chat_id?: number } };
    if (data.ok === true && response.ok) return { ok: true, error: null, retryAfter: null, ...(data.result === undefined ? {} : { result: data.result }) };
    const error: TelegramError = data.parameters?.migrate_to_chat_id ? 'chat_migrated'
      : data.error_code === 401 ? 'token_invalid' : data.error_code === 403 ? 'forbidden'
        : data.error_code === 400 ? 'chat_not_found' : data.error_code === 429 ? 'rate_limited'
          : data.error_code === 409 && method === 'getUpdates' ? 'webhook_in_use' : 'network';
    const retry = data.parameters?.retry_after;
    return { ok: false, error, uncertain: response.status >= 500 || error === 'network', retryAfter: error === 'rate_limited' && Number.isSafeInteger(retry) && Number(retry) > 0 ? Number(retry) : error === 'rate_limited' ? 1 : null };
  } catch (error) {
    // URL·토큰·외부 오류 본문은 기록하지 않는다.
    const cause = error instanceof Error ? error.cause as { code?: string; message?: string } | undefined : undefined;
    const beforeSend = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause?.code ?? '') || cause?.message === 'bad port';
    return { ok: false, error: 'network', retryAfter: null, uncertain: attempted && !beforeSend };
  }
}

export function botOf(result: BotResult): Bot | null {
  const data = result.result as Record<string, unknown> | undefined;
  return result.ok && data && typeof data.id === 'number' && typeof data.username === 'string' && typeof data.first_name === 'string'
    ? { id: data.id, username: data.username, name: data.first_name } : null;
}

export function chatsOf(result: BotResult): Chat[] {
  if (!result.ok || !Array.isArray(result.result)) return [];
  const chats = new Map<string, Chat>();
  for (const entry of result.result as { message?: { chat?: { id?: number; title?: string; first_name?: string; type?: string }; date?: number; message_thread_id?: number } }[]) {
    const message = entry.message, chat = message?.chat;
    if (!chat || message?.message_thread_id !== undefined || !['private', 'group', 'supergroup'].includes(chat.type ?? '') || !Number.isSafeInteger(chat.id)) continue;
    const chatId = String(chat.id);
    chats.set(chatId, { chatId, title: chat.title ?? chat.first_name ?? chatId, type: chat.type ?? '', lastAt: new Date((message?.date ?? 0) * 1000).toISOString() });
  }
  return [...chats.values()];
}
