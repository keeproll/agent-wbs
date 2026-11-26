import type { Pool } from '@awbs/db';
import type { FastifyInstance } from 'fastify';
import { installProjectErrors } from '../project/errors.ts';
import { routeOf } from '../project/routes.ts';
import { getCommands, listResets, previewReset, reportCommandResult, resetProject, type CommandResult } from './service.ts';
import { DATA_ROOT } from './files.ts';
import { exportProject } from './export.ts';

export function registerResetRoutes(app: FastifyInstance, pool: Pool, root = DATA_ROOT) {
  void app.register(async (scope) => {
    installProjectErrors(scope, () => '프로젝트 초기화');
    routeOf(scope, pool, 'previewReset', ({ client }) => previewReset(client));
    routeOf(scope, pool, 'resetProject', ({ client, principal, request }) => resetProject(client, request.body as { epoch: number; confirmName: string; keepSettings: boolean }, principal));
    routeOf(scope, pool, 'listResets', ({ client }) => listResets(client));
    scope.get('/api/project/export', async (request, reply) => {
      const bytes = await exportProject(pool, request.platform?.currentEpoch ?? 0, root);
      return reply.type('application/zip').header('Content-Disposition', `attachment; filename="agent-wbs-${String(request.platform?.currentEpoch)}.zip"`)
        .header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store').send(bytes);
    });
  });
}

export function installResetRunner(app: FastifyInstance, pool: Pool) {
  void app.register(async (scope) => {
    installProjectErrors(scope, () => '초기화 정리 보고');
    routeOf(scope, pool, 'getCommands', ({ client, epoch }) => getCommands(client, epoch));
    routeOf(scope, pool, 'reportCommandResult', ({ client, request }) => reportCommandResult(client,
      (request.params as { id: string }).id, request.platform?.epoch ?? 0, request.body as CommandResult), 204);
  });
}
