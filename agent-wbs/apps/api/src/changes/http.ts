import assert from 'node:assert/strict';
import type { Pool, PoolClient } from '@awbs/db';
import { errorBody } from '@awbs/shared';
import { ERROR_STATUS, OPERATIONS, inputErrors, isTimestamp, type ErrorCode, type Operation } from '@awbs/shared/api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { redact } from '../platform/redact.ts';
import { InputProblem } from './history.ts';

/**
 * M2-08 라우트(정책·메시지·이력·변경 이벤트·무결성 점검)의 공통 도우미.
 * 인증·CSRF·epoch·멱등·트랜잭션은 공통 관문(platform/security.ts)이 이미 처리한다. 여기서는 업무 오류의 모양만 맞춘다.
 */
export interface FieldError { path: string; rule: string; message: string }

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly errors: FieldError[];
  readonly fix: string | undefined;
  constructor(code: ErrorCode, details: Record<string, unknown> = {}, errors: FieldError[] = [], message?: string, fix?: string) {
    super(message ?? '요청을 처리할 수 없습니다.');
    this.code = code;
    this.details = details;
    this.errors = errors;
    this.fix = fix;
  }
}

export const invalid = (errors: FieldError[], message = '입력이 올바르지 않습니다.') => new ApiError('VALIDATION_FAILED', {}, errors, message, '표시된 항목을 고친 뒤 다시 보내세요.');

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const validationErrors = (error: { validation?: { instancePath?: string; message?: string; keyword?: string; params?: { missingProperty?: string } }[]; validationContext?: string }): FieldError[] =>
  (error.validation ?? []).map((item) => ({
    path: [error.validationContext === 'body' ? '' : error.validationContext ?? '', ...(item.instancePath ?? '').split('/'), item.params?.missingProperty ?? '']
      .filter(Boolean).join('.'),
    rule: item.keyword ?? 'schema',
    message: item.message ?? '형식이 올바르지 않습니다.',
  }));

/** 본문 스키마에 없는 필드(공통 검증이 조용히 지우는 값)를 찾는다. 공통 입력 검증이 고쳐지면 지운다(M2-01 담당). */
function unknownFields(schema: unknown, value: unknown, path = ''): string[] {
  const s = schema as { type?: string; properties?: Record<string, unknown>; additionalProperties?: unknown; items?: unknown; anyOf?: unknown[] };
  if (s.anyOf) return s.anyOf.some((branch) => unknownFields(branch, value, path).length === 0) ? [] : unknownFields(s.anyOf[0], value, path);
  if (Array.isArray(value) && s.items) return value.flatMap((item, index) => unknownFields(s.items, item, `${path}${path ? '.' : ''}${String(index)}`));
  if (!value || typeof value !== 'object' || Array.isArray(value) || !s.properties) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const child = `${path}${path ? '.' : ''}${key}`;
    if (!(key in (s.properties ?? {}))) return s.additionalProperties === false ? [child] : [];
    return unknownFields(s.properties?.[key], item, child);
  });
}

/** 한 묶음(scope)의 라우트를 계약(OPERATIONS) 정의대로 등록한다. 등록한 operation id를 돌려준다. */
export function routes(app: FastifyInstance, name: string, register: (route: (id: string, handler: Handler, params?: object) => void) => void): void {
  void app.register((scope, _options, done) => {
    const actions = new Map<string, Operation>();
    scope.addHook('preValidation', async (request) => {
      const op = actions.get(`${request.method} ${request.routeOptions.url ?? ''}`);
      if (!op?.body || request.body === undefined) return;
      const unknown = unknownFields(op.body, request.body);
      if (unknown.length) throw invalid(unknown.map((path) => ({ path, rule: 'additionalProperties', message: '정의하지 않은 필드입니다.' })));
    });
    scope.addHook('preHandler', async (request) => {
      const op = actions.get(`${request.method} ${request.routeOptions.url ?? ''}`);
      if (!op?.inputRules?.length) return;
      const errors = inputErrors(op, request.body);
      if (errors.length) throw invalid(errors);
    });
    scope.setErrorHandler((error, request, reply) => {
      const failure = error as { validation?: unknown };
      const api = error instanceof ApiError ? error
        : error instanceof InputProblem ? invalid([{ path: error.path, rule: error.rule, message: error.message }])
          : failure.validation ? invalid(validationErrors(error as Parameters<typeof validationErrors>[0])) : null;
      if (!api) throw error;
      const op = actions.get(`${request.method} ${request.routeOptions.url ?? ''}`);
      return reply.code(ERROR_STATUS[api.code]).send(errorBody({
        code: api.code, message: api.message, action: op?.summary ?? name,
        fix: api.fix ?? (api.code === 'VERSION_CONFLICT' ? '최신 내용을 다시 불러온 뒤 다시 시도하세요.' : '입력과 현재 상태를 확인한 뒤 다시 시도하세요.'),
        errors: api.errors, details: redact(api.details) as Record<string, unknown>, requestId: request.id,
      }));
    });
    register((id, handler, params) => {
      const op = OPERATIONS.find((item) => item.id === id);
      assert(op, `계약에 없는 경로: ${id}`);
      actions.set(`${op.method} ${op.path}`, op);
      scope.route({
        method: op.method, url: op.path, handler,
        schema: { ...(op.body ? { body: op.body } : {}), ...(op.query ? { querystring: op.query } : {}), ...(params ? { params } : {}) },
      });
    });
    done();
  });
}

/** 변경 요청은 공통 관문이 연 트랜잭션(epoch 잠금 포함) 안에서 처리한다. */
export const clientOf = (request: FastifyRequest): PoolClient => {
  const client = request.platform?.client;
  assert(client, '변경 요청은 공통 관문이 연 트랜잭션 안에서 처리한다.');
  return client;
};

/** 조회는 한 시점의 스냅샷(읽기 전용 반복 읽기)으로 계산한다. 공통 관문이 이미 연 트랜잭션이 있으면(Runner GET) 그것을 쓴다. */
export async function read<T>(pool: Pool, request: FastifyRequest, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (request.platform?.client) return fn(request.platform.client);
  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const params = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties) });
export const TASK_PARAMS = params({ taskKey: { type: 'string', pattern: '^TASK-[0-9]{4,}$' } });
export const MESSAGE_PARAMS = params({ messageId: { type: 'string', pattern: UUID.source } });
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** 값을 JSON으로 저장할 때의 공통 표현(undefined·null은 SQL null). */
export const json = (value: unknown) => (value === undefined || value === null ? null : JSON.stringify(value));

/** 화면이 본 버전과 다르면 409 VERSION_CONFLICT. updatedAt은 마이크로초까지 비교한다. */
export async function assertSameVersion(client: PoolClient, current: string | null, expected: string | null, details: Record<string, unknown> = {}): Promise<void> {
  if (current === null || expected === null) {
    if (current === expected) return;
    throw new ApiError('VERSION_CONFLICT', { current: details.current ?? null }, [], '다른 곳에서 먼저 바뀌어 화면의 내용이 최신이 아닙니다.');
  }
  if (!isTimestamp(expected)) throw invalid([{ path: 'updatedAt', rule: 'format', message: '달력에 없거나 허용 범위(1970~9999년) 밖의 시각입니다.' }]);
  const same = (await client.query<{ same: boolean }>('select $1::timestamptz=$2::timestamptz as same', [current, expected])).rows[0]?.same;
  if (!same) throw new ApiError('VERSION_CONFLICT', { current: details.current ?? null, changes: details.changes ?? [] }, [], '다른 곳에서 먼저 바뀌어 화면의 내용이 최신이 아닙니다.');
}
