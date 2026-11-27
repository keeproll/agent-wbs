import type { Pool } from '@awbs/db';
import { required } from '../runner/repository.ts';
import type { FastifyRequest } from 'fastify';
import { clientOf, params, read, routes } from '../changes/http.ts';
import { drifts, items, latestSnapshot, overview, projectExists, decisions } from './read.ts';
import { createDecision, decide, resolve, saveSnapshot } from './service.ts';
import type { FastifyInstance } from 'fastify';

const projectParams = { projectId: { type: 'string', minLength: 1 } };
const refOf = (request: FastifyRequest) => (request.query as { ref?: string }).ref ?? 'main';
const param = (request: FastifyRequest, key: string) => required((request.params as Record<string, string>)[key]);

export function registerDesignRoutes(app: FastifyInstance, pool: Pool) {
  routes(app, '설계 원장', route => {
    const view = <T>(request: FastifyRequest, fn: (db: Parameters<typeof projectExists>[0], projectId: string) => Promise<T>) => read(pool, request, async db => {
      const projectId = param(request, 'projectId');
      await projectExists(db, projectId);
      return fn(db, projectId);
    });
    route('getDesign', request => view(request, (db, id) => overview(db, id, refOf(request))), params(projectParams));
    route('listDecisions', request => view(request, async (db, id) => ({ items: await decisions(db, id) })), params(projectParams));
    route('createDecision', async (request, reply) => reply.code(201).send(await createDecision(clientOf(request), param(request, 'projectId'), request.body as Parameters<typeof createDecision>[2], required(request.platform).principal)), params(projectParams));
    for (const action of ['approve', 'reject', 'change'] as const) route(`${action}Decision`, request => decide(clientOf(request), param(request, 'id'), action, request.body as Parameters<typeof decide>[3]), params({ id: { type: 'string', minLength: 1 } }));
    for (const [category, listId, detailId, filter] of [['interface', 'listInterfaces', 'getInterface', 'kind'], ['data', 'listDataItems', 'getDataItem', 'store']] as const) {
      route(listId, request => view(request, (db, id) => items(db, id, refOf(request), category, (request.query as Record<string, string>)[filter])), params(projectParams));
      route(detailId, request => view(request, (db, id) => items(db, id, refOf(request), category, undefined, param(request, 'key'))), params({ ...projectParams, key: { type: 'string', minLength: 1 } }));
    }
    route('getOwnership', request => view(request, async (db, id) => ({ items: (await latestSnapshot(db, id, refOf(request)))?.content.ownership ?? [] })), params(projectParams));
    route('listDrifts', request => view(request, async (db, id) => ({ items: await drifts(db, id, refOf(request)) })), params(projectParams));
    route('resolveDrift', async (request, reply) => {
      const result = await resolve(clientOf(request), param(request, 'projectId'), param(request, 'id'), request.body as Parameters<typeof resolve>[3], required(request.platform).currentEpoch);
      return reply.code('jobId' in result ? 202 : 200).send(result);
    }, params({ ...projectParams, id: { type: 'string', minLength: 1 } }));
    route('reportDesignSnapshot', async (request, reply) => {
      await saveSnapshot(clientOf(request), request.body as Parameters<typeof saveSnapshot>[1], required(request.platform).principal);
      return reply.code(204).send();
    });
  });
}
