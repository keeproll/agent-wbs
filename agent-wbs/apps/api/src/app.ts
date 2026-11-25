import { pingDatabase, type Pool } from '@awbs/db';
import { errorBody, type DbHealthResponse, type ErrorBody, type HealthResponse } from '@awbs/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from 'fastify';

export function buildApp(pool: Pool, logger: FastifyServerOptions['logger'] = false): FastifyInstance {
  const app = Fastify({
    logger,
    // 기본 처리기는 원문 URL을 로그와 응답에 넣는다. 오류 형식 전체는 M2-01에서 정한다.
    frameworkErrors: (_error, _request, reply: FastifyReply) => {
      void reply.code(400).send({ statusCode: 400, error: 'Bad Request' });
    },
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ statusCode: 404, error: 'Not Found' });
  });

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
