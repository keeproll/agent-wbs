import { pingDatabase, type Pool } from '@awbs/db';
import { errorBody, type DbHealthResponse, type ErrorBody, type HealthResponse } from '@awbs/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { platformErrorBody } from './platform/errors.ts';
import { installSecurity, type SecurityOptions } from './platform/security.ts';
import { buildValidator, validateTransport } from './platform/validation.ts';
import { registerPlanningRoutes } from './planning/routes.ts';
import { registerTaskRoutes } from './tasks/routes.ts';
import { installExecution, type ExecutionOptions } from './execution/routes.ts';
import { registerChangeRoutes } from './changes/routes.ts';
import { registerMessageRoutes } from './messages/routes.ts';
import { registerPolicyRoutes } from './policy/routes.ts';
import { registerSettingsRoutes } from './settings/routes.ts';
import { registerProjectRoutes } from './project/routes.ts';
import { DATA_ROOT } from './reset/files.ts';
import { registerResetRoutes } from './reset/routes.ts';
import { registerReportRoutes } from './reports/routes.ts';

export function buildApp(pool: Pool, logger: FastifyServerOptions['logger'] = false,
  security: SecurityOptions = { origin: 'http://127.0.0.1:3100', lan: false }, execution: ExecutionOptions = {}): FastifyInstance {
  const app = Fastify({
    logger,
    schemaController: { compilersFactory: { buildValidator } },
    clientErrorHandler: (error, socket) => {
      app.log.warn({ err: error }, 'client error');
      if (!socket.writable) return;
      const body = JSON.stringify(platformErrorBody('VALIDATION_FAILED', randomUUID()));
      socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`);
    },
    frameworkErrors: (_error, request, reply: FastifyReply) => {
      void reply.code(400).send(platformErrorBody('VALIDATION_FAILED', request.id));
    },
  });
  app.addHook('preHandler', validateTransport);
  installSecurity(app, pool, security);
  registerTaskRoutes(app, pool);
  installExecution(app, pool, execution);
  registerChangeRoutes(app, pool);
  registerMessageRoutes(app, pool);
  registerPolicyRoutes(app, pool);
  registerSettingsRoutes(app, pool);
  registerPlanningRoutes(app, pool);
  registerProjectRoutes(app, pool);
  registerReportRoutes(app, pool); // M6-01
  // Evidence 저장·내보내기·파일 삭제가 같은 루트를 쓴다(M2 통합: M2-06 evidenceRoot와 M2-04 dataRoot 통일).
  registerResetRoutes(app, pool, execution.dataRoot ?? DATA_ROOT);

  app.get('/health', (): HealthResponse => ({ status: 'ok' }));

  app.get('/health/db', async (request, reply): Promise<DbHealthResponse | ErrorBody> => {
    try {
      return { db: 'ok', latencyMs: await pingDatabase(pool) };
    } catch (error) {
      request.log.error({ err: error }, 'DB 확인 실패');
      return reply.code(503).send(
        errorBody({
          code: 'UNAVAILABLE',
          message: 'DB에 연결할 수 없습니다.',
          action: 'DB 상태 확인',
          fix: 'PostgreSQL 컨테이너 상태를 확인하고 다시 시도하세요.',
          requestId: request.id,
        }),
      );
    }
  });

  return app;
}
