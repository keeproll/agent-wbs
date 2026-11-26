import type { FastifyLoggerOptions, FastifyRequest } from 'fastify';
import type { PinoLoggerOptions } from 'fastify/types/logger.js';
import { redact } from './platform/redact.ts';

/**
 * 원문 URL은 query와 경로(`/bot<token>/`)에 비밀값이 있을 수 있어 기록하지 않고, 등록된 route 형식만 남긴다.
 * 오류는 정해진 필드만 남긴다. pg의 client, HTTP 해석 오류의 rawPacket 등 부가 객체를 막는다.
 */
export function loggerOptions(level: string): FastifyLoggerOptions & PinoLoggerOptions {
  return {
    level,
    hooks: {
      logMethod(args, method) {
        const [first, ...rest] = args;
        // req/res는 아래의 허용 목록 serializer에 원래 객체를 넘겨야 한다.
        let clean: unknown;
        if (first && typeof first === 'object' && !(first instanceof Error)) {
          const { req, res, ...fields } = first as Record<string, unknown>;
          clean = { ...redact(fields) as Record<string, unknown>, ...(req ? { req } : {}), ...(res ? { res } : {}) };
        } else clean = redact(first);
        method.apply(this, [clean, ...rest.map((item) => redact(item))] as typeof args);
      },
    },
    serializers: {
      req: (request: FastifyRequest) => ({
        method: request.method,
        // 없는 경로 처리기는 route가 없다.
        route: request.is404 ? undefined : request.routeOptions?.url,
        remoteAddress: request.ip,
      }),
      err: (error: Error & { code?: string }) => ({
        type: error.name,
        code: error.code,
        message: '내부 오류(원문 생략)',
        stack: '',
      }),
    },
  };
}
