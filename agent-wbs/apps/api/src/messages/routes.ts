import type { Pool } from '@awbs/db';
import type { FastifyInstance } from 'fastify';
import { ApiError, clientOf, MESSAGE_PARAMS, read, routes, TASK_PARAMS } from '../changes/http.ts';
import {
  ackMessage, createDraft, leadAction, listMessages, markRead, pollMessages, respondMessage, updateDraft,
  type DraftInput, type DraftPatch,
} from './service.ts';

interface Paging { limit?: number; cursor?: string }
const idOf = (request: { params: unknown }) => (request.params as { messageId: string }).messageId;

/** 팀장 메시지(contracts §2.1, G§4.10). */
export function registerMessageRoutes(app: FastifyInstance, pool: Pool): void {
  routes(app, '메시지 처리', (route) => {
    route('listMessages', async (request) => {
      const query = request.query as Paging & { taskKey?: string };
      return read(pool, request, async (client) => {
        let taskId: string | undefined;
        if (query.taskKey !== undefined) {
          // 없는 Task로 거르면 빈 목록이다(경로 값이 아니라 필터라 404를 쓰지 않는다).
          taskId = (await client.query<{ id: string }>('select id from tasks where task_key=$1', [query.taskKey])).rows[0]?.id ?? '00000000-0000-4000-8000-000000000000';
        }
        return listMessages(client, { taskId, limit: query.limit, cursor: query.cursor });
      });
    });

    route('getTaskMessages', async (request) => {
      const { taskKey } = request.params as { taskKey: string };
      const query = request.query as Paging;
      return read(pool, request, async (client) => {
        const task = (await client.query<{ id: string }>('select id from tasks where task_key=$1 and deleted_at is null', [taskKey])).rows[0];
        if (!task) throw new ApiError('TASK_NOT_FOUND', { taskKey }, [], 'Task를 찾을 수 없습니다.');
        return listMessages(client, { taskId: task.id, limit: query.limit, cursor: query.cursor });
      });
    }, TASK_PARAMS);

    route('createMessage', async (request, reply) => reply.code(201).send(await createDraft(clientOf(request), request.body as DraftInput)));
    route('updateMessageDraft', async (request) => updateDraft(clientOf(request), idOf(request), request.body as DraftPatch), MESSAGE_PARAMS);
    for (const action of ['send', 'cancel', 'resend'] as const) {
      route(`${action}Message`, async (request) => leadAction(clientOf(request), idOf(request), action, (request.body as { updatedAt: string }).updatedAt), MESSAGE_PARAMS);
    }
    route('readMessage', async (request, reply) => { await markRead(clientOf(request), idOf(request)); return reply.code(204).send(); }, MESSAGE_PARAMS);
  });
}

/**
 * Runner 메시지 조회·수신 확인·응답(contracts §3.1). Runner 경로는 M2-05와 같이 main.ts에서 붙인다.
 * 왜: 보안 관문 테스트(security.db.test.ts)가 buildApp 위에 모든 Runner 경로의 대역을 등록하므로, buildApp에 넣으면 경로가 겹친다.
 */
export function registerRunnerMessageRoutes(app: FastifyInstance): void {
  routes(app, 'Runner 메시지 처리', (route) => {
    route('pollMessages', async (request) => {
      const query = request.query as { cursor?: string; since?: string };
      return pollMessages(clientOf(request), query.cursor ?? null, undefined, query.since);
    });
    route('ackMessage', async (request, reply) => { await ackMessage(clientOf(request), idOf(request)); return reply.code(204).send(); });
    route('respondMessage', async (request, reply) => {
      await respondMessage(clientOf(request), idOf(request), request.body as { text: string; workState: string });
      return reply.code(204).send();
    });
  });
}
