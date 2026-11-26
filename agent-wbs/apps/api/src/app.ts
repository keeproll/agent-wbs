import { pingDatabase, type Pool } from '@awbs/db';
import { errorBody, type DbHealthResponse, type ErrorBody, type HealthResponse } from '@awbs/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { platformErrorBody } from './platform/errors.ts';
import { installSecurity, type SecurityOptions } from './platform/security.ts';
import { buildValidator, validateTransport } from './platform/validation.ts';
import { registerTaskRoutes } from './tasks/routes.ts';

export function buildApp(pool: Pool, logger: FastifyServerOptions['logger'] = false,
  security: SecurityOptions = { origin: 'http://127.0.0.1:3100', lan: false }): FastifyInstance {
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
