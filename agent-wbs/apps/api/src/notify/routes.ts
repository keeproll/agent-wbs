import type { Pool } from '@awbs/db';
import type { FastifyInstance } from 'fastify';
import { clientOf, isUuid, params, read, routes, ApiError } from '../changes/http.ts';
import { botOf, callBot, chatsOf } from './bot.ts';
import { readToken, tokenKey } from './secrets.ts';
import { getTelegram, putTelegram, getRules, putRules, getAppUrl, putAppUrl, notifyLog, preview, currentProject } from './service.ts';
import type { NotifyEvent } from './message.ts';
import { sendTest, statusAlert } from './worker.ts';

export function registerNotifyRoutes(app: FastifyInstance, pool: Pool) {
  routes(app, 'Telegram 알림', route => {
    route('getTelegram', r => read(pool, r, db => getTelegram(db, (r.query as { testId?: string }).testId)));
    route('putTelegram', r => putTelegram(clientOf(r), r.body as Parameters<typeof putTelegram>[1]));
    route('checkTelegramBot', async r => {
      const db = clientOf(r), key = await tokenKey(db, (r.body as { botToken?: string }).botToken);
      const result = await callBot(await readToken(db, key), 'getMe');
      if (!result.ok) await statusAlert(db, (await currentProject(db))?.id ?? null, result, { secretKey: key });
      return { ok: result.ok, error: result.error, retryAfter: result.retryAfter, bot: botOf(result) };
    });
    route('findTelegramChats', async r => {
      const db = clientOf(r), key = await tokenKey(db, (r.body as { botToken?: string }).botToken);
      const result = await callBot(await readToken(db, key), 'getUpdates', { allowed_updates: ['message'], timeout: 0 });
      return { ok: result.ok, error: result.error, retryAfter: result.retryAfter, candidates: chatsOf(result) };
    });
    route('testTelegram', r => sendTest(pool, r.platform?.currentEpoch ?? r.platform?.epoch ?? 0, r.body as Parameters<typeof sendTest>[2]));
    route('getAppUrl', r => read(pool, r, getAppUrl));
    route('putAppUrl', r => putAppUrl(clientOf(r), r.body as Parameters<typeof putAppUrl>[1]));
    const projectParams = params({ projectId: { type: 'string', format: 'uuid' } });
    const project = (r: { params: unknown }) => {
      const id = (r.params as { projectId: string }).projectId;
      if (!isUuid(id)) throw new ApiError('PROJECT_NOT_FOUND');
      return id;
    };
    route('getNotifyRules', r => read(pool, r, db => getRules(db, project(r))), projectParams);
    route('putNotifyRules', r => putRules(clientOf(r), project(r), r.body as Parameters<typeof putRules>[2]), projectParams);
    route('listNotifyLog', r => read(pool, r, db => notifyLog(db, project(r), r.query as Parameters<typeof notifyLog>[2])), projectParams);
    route('getNotifyLog', r => read(pool, r, async db => {
      const id = (r.params as { id: string }).id;
      if (!isUuid(id)) throw new ApiError('NOT_FOUND');
      return notifyLog(db, project(r), {}, id);
    }));
    route('previewNotify', r => read(pool, r, db => preview(db, project(r), (r.query as { event: NotifyEvent }).event)), projectParams);
  });
}
