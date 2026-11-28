import type { FastifyLoggerOptions, FastifyRequest } from 'fastify';
import type { PinoLoggerOptions } from 'fastify/types/logger.js';
import { redact } from './platform/redact.ts';

/**
 * 원문 URL은 query와 경로(`/bot<token>/`)에 비밀값이 있을 수 있어 기록하지 않고, 등록된 route 형식만 남긴다.
 * 오류는 정해진 필드만 남긴다. pg의 client, HTTP 해석 오류의 rawPacket 등 부가 객체를 막는다.
 */
export function loggerOptions(level: string, destination: { write(line: string): unknown } = process.stdout): FastifyLoggerOptions & PinoLoggerOptions {
  return {
    level,
    // 자식 로거의 고정 필드도 포함하려고 Runner와 같이 직렬화가 끝난 뒤 가린다.
    stream: {
      write(line: string) { destination.write(`${JSON.stringify(redact(JSON.parse(line) as unknown))}\n`); },
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
