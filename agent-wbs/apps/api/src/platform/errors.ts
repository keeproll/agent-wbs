import { errorBody, type ErrorBody } from '@awbs/shared';
import { ERROR_STATUS, type ErrorCode, type InputError } from '@awbs/shared/api';
import type { FastifyInstance, FastifySchemaValidationError } from 'fastify';
import type { Pool } from '@awbs/db';
import { redact } from './redact.ts';

const messages: Partial<Record<ErrorCode, string>> = {
  LEAD_UNAUTHORIZED: '팀장 로그인이 필요합니다.', RUNNER_UNAUTHORIZED: 'Runner 인증이 필요합니다.',
  LOGIN_FAILED: '로그인할 수 없습니다.', FORBIDDEN_PRINCIPAL: '이 요청을 실행할 권한이 없습니다.',
  EPOCH_MISMATCH: '프로젝트가 초기화되어 요청의 세대 번호가 달라졌습니다.',
  IDEMPOTENCY_KEY_REQUIRED: '중복 처리를 막는 Idempotency-Key가 필요합니다.',
  IDEMPOTENCY_CONFLICT: '같은 멱등 키가 다른 요청에 사용되었습니다.',
  RATE_LIMITED: '로그인 시도 횟수를 초과했습니다.', VALIDATION_FAILED: '요청 형식이 올바르지 않습니다.',
  NOT_FOUND: '요청한 자원을 찾을 수 없습니다.', UNAVAILABLE: '잠시 요청을 처리할 수 없습니다.',
};

export class PlatformError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly errors: InputError[];
  constructor(code: ErrorCode, details: Record<string, unknown> = {}, errors: InputError[] = []) {
    super(messages[code] ?? '요청을 처리할 수 없습니다.');
    this.code = code;
    this.details = details;
    this.errors = errors;
  }
}

export function validationErrors(errors: readonly FastifySchemaValidationError[]): InputError[] {
  return errors.map((error) => {
    const path = error.instancePath.split('/').slice(1).map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const field = error.keyword === 'required' ? error.params.missingProperty : error.keyword === 'additionalProperties' ? error.params.additionalProperty : undefined;
    if (typeof field === 'string') path.push(field);
    const message = error.keyword === 'required' ? '필수 항목을 입력하세요.'
      : error.keyword === 'additionalProperties' ? '선언하지 않은 항목입니다.' : '입력 형식과 조건을 확인하세요.';
    return { path: path.join('.'), rule: error.keyword, message };
  });
}

export function platformErrorBody(code: ErrorCode, requestId: string, details: Record<string, unknown> = {}, errors: InputError[] = []): ErrorBody {
  return errorBody({ code, message: messages[code] ?? '요청을 처리할 수 없습니다.', action: '요청 처리',
    fix: code === 'EPOCH_MISMATCH' ? '최신 프로젝트 상태를 조회하세요.' : '입력과 로그인 상태를 확인한 뒤 다시 시도하세요.', details: redact(details) as Record<string, unknown>, errors: redact(errors) as InputError[], requestId });
}

export function installErrors(app: FastifyInstance, pool: Pool): void {
  app.setNotFoundHandler((request, reply) => reply.code(404).send(platformErrorBody('NOT_FOUND', request.id)));
  app.setErrorHandler(async (error, request, reply) => {
    const failure = error as { code?: string; validation?: FastifySchemaValidationError[]; statusCode?: number };
    let code: ErrorCode = 'INTERNAL';
    let details: Record<string, unknown> = {};
    let errors: InputError[] = [];
    if (error instanceof PlatformError) { code = error.code; details = error.details; errors = error.errors; }
    else if (failure.validation) { code = 'VALIDATION_FAILED'; errors = validationErrors(failure.validation); }
    else if (failure.code === 'AW001') {
      code = 'EPOCH_MISMATCH';
      details = { currentEpoch: (await pool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch };
    } else if (failure.code === '40P01' || failure.code?.startsWith('08') || ['ECONNREFUSED', '57P01', '57P03'].includes(failure.code ?? '')) code = 'UNAVAILABLE';
    else if (failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500) code = 'VALIDATION_FAILED';
    if (ERROR_STATUS[code] >= 500) request.log.error({ err: error }, '요청 처리 실패');
    return reply.code(ERROR_STATUS[code]).send(platformErrorBody(code, request.id, details, errors));
  });
}
