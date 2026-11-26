import type { Pool } from '@awbs/db';
import type { FastifyInstance } from 'fastify';
import { readChanges } from './events.ts';
import { listHistory, type HistoryFilter } from './history.ts';
import { checkIntegrity } from './integrity.ts';
import { ApiError, read, routes, TASK_PARAMS } from './http.ts';

/** 변경 이벤트(contracts §7)·이력(G§4.9) 조회와 무결성 점검(G§0.4). */
export function registerChangeRoutes(app: FastifyInstance, pool: Pool): void {
  routes(app, '변경 기록 조회', (route) => {
    route('getChanges', async (request) => {
      const query = request.query as { after: number; limit?: number };
      return read(pool, request, (client) => readChanges(client, query.after, query.limit ?? 500));
    });

    route('listHistory', async (request) => {
      const query = request.query as HistoryFilter;
      return read(pool, request, (client) => listHistory(client, query));
    });

    route('getTaskHistory', async (request) => {
      const { taskKey } = request.params as { taskKey: string };
      const query = request.query as Pick<HistoryFilter, 'limit' | 'cursor'>;
      return read(pool, request, async (client) => {
        const task = (await client.query<{ id: string }>('select id from tasks where task_key=$1 and deleted_at is null', [taskKey])).rows[0];
        if (!task) throw new ApiError('TASK_NOT_FOUND', { taskKey }, [], 'Task를 찾을 수 없습니다.');
        return listHistory(client, { ...query, taskId: task.id });
      });
    }, TASK_PARAMS);

    route('getIntegrity', async (request) => read(pool, request, checkIntegrity));
  });
}
