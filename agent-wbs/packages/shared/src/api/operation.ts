import type { Static, TProperties, TSchema } from 'typebox';
import { ERROR_STATUS, type ErrorCode } from './errors.ts';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** `none`은 인증 전 요청(로그인·health)뿐이다. */
export type Principal = 'lead' | 'runner' | 'none';
/**
 * 팀장 수정의 비교 대상(contracts §1.3).
 * body·query: `updatedAt` 필수 / revision·epoch: 본문의 해당 필드 / none: 기존 행을 수정하지 않거나 §1.3이 제외
 */
export type VersionRule = 'body' | 'query' | 'revision' | 'epoch' | 'list' | 'none';

export interface Operation {
  readonly id: string;
  readonly method: Method;
  /** Fastify 형식(`:taskKey`) */
  readonly path: string;
  readonly principal: Principal;
  readonly summary: string;
  readonly params?: TSchema;
  readonly query?: TSchema;
  readonly body?: TSchema;
  readonly multipart?: true;
  /** 상태 코드 → 본문. null은 본문 없음 */
  readonly responses: Readonly<Record<number, TSchema | null>>;
  /** JSON이 아닌 성공 응답의 형식 */
  readonly binary?: string;
  readonly responseHeaders?: readonly ('X-Current-Epoch' | 'ETag' | 'Content-Disposition' | 'X-Content-Type-Options')[];
  readonly ifNoneMatch?: true;
  readonly errors: readonly ErrorCode[];
  readonly version?: VersionRule;
  readonly idempotency: 'required' | 'optional' | 'none';
  /** 이전 epoch 허용(D-04) */
  readonly staleEpoch?: true;
}

export type BodyOf<T extends Operation> = T['body'] extends TSchema ? Static<T['body']> : undefined;

export const pathParams = (path: string): string[] => [...path.matchAll(/:(\w+)/g)].map((m) => m[1] ?? '');

/** Runner 토큰을 쓰는 모든 요청은 epoch를 보낸다. 경로가 아니라 주체가 기준이다(G§8.6). */
export const usesEpoch = (op: Pick<Operation, 'principal'>): boolean => op.principal === 'runner';

type Input = Omit<Operation, 'errors' | 'idempotency' | 'responses'> & {
  responses: Operation['responses'];
  errors?: readonly ErrorCode[];
  idempotency?: Operation['idempotency'];
};

/** 본문이 union이면 모든 갈래의 필드 */
const properties = (schema: TSchema | undefined): TProperties => {
  const { properties: own, anyOf } = (schema ?? {}) as { properties?: TProperties; anyOf?: TSchema[] };
  return own ?? Object.assign({}, ...(anyOf ?? []).map(properties)) as TProperties;
};

/** 전용 404 코드가 있거나 자원이 아닌 경로 값 */
const COVERED_PARAMS = new Set(['taskKey', 'projectId', 'attemptId', 'messageId', 'dependencyId', 'kind']);

/** 라우트 정의. 공통 오류와 멱등 규칙을 채우고, 계약 위반이면 정의 시점에 실패한다. */
export function operation<const T extends Input>(input: T): T & Pick<Operation, 'errors' | 'idempotency'> {
  const { method, path, principal } = input;
  const params = pathParams(path);
  const write = method !== 'GET';
  const body = properties(input.body);
  const query = properties(input.query);
  const fail = (reason: string): never => {
    throw new Error(`${input.id} (${method} ${path}): ${reason}`);
  };

  const errors = new Set<ErrorCode>(['INTERNAL', 'UNAVAILABLE', ...(input.errors ?? [])]);
  // 빈 값·형식이 틀린 경로 값도 400이다.
  if (input.body || input.query || params.length > 0) errors.add('VALIDATION_FAILED');
  if (principal === 'lead') errors.add('LEAD_UNAUTHORIZED').add('FORBIDDEN_PRINCIPAL');
  if (principal === 'runner') errors.add('RUNNER_UNAUTHORIZED').add('RATE_LIMITED');
  if (usesEpoch(input) && !input.staleEpoch) errors.add('EPOCH_MISMATCH');
  if (params.includes('taskKey')) errors.add('TASK_NOT_FOUND');
  if (params.includes('projectId')) errors.add('PROJECT_NOT_FOUND');
  if (params.includes('attemptId')) errors.add('ATTEMPT_NOT_FOUND');
  if (params.includes('messageId')) errors.add('MESSAGE_NOT_FOUND');
  if (params.includes('dependencyId')) errors.add('DEPENDENCY_NOT_FOUND');
  if (params.some((name) => !COVERED_PARAMS.has(name)) || 'jobId' in body) errors.add('NOT_FOUND');
  if ('fence' in body) errors.add('LEASE_LOST');

  const idempotency =
    input.idempotency ??
    (principal === 'runner' && (method === 'POST' || method === 'PATCH')
      ? 'required'
      : principal === 'lead' && method === 'POST'
        ? 'optional'
        : 'none');
  if (idempotency !== 'none') errors.add('IDEMPOTENCY_CONFLICT');
  if (idempotency === 'required') errors.add('IDEMPOTENCY_KEY_REQUIRED');

  if (principal === 'lead' && write) {
    if (!input.version) fail('팀장 수정은 version 규칙이 필요하다.');
    const has = {
      body: 'updatedAt' in body,
      query: 'updatedAt' in query,
      revision: 'revision' in body,
      epoch: 'epoch' in body,
      list: 'decisions' in body,
      none: !('updatedAt' in body || 'updatedAt' in query),
    };
    if (input.version && !has[input.version]) fail(`version '${input.version}' 필드가 없다.`);
    if (input.version !== 'none') errors.add('VERSION_CONFLICT');
  } else if (input.version) fail('version은 팀장 수정에만 쓴다.');
  if (principal !== 'runner' && /^\/api\/(runner|planning)\//.test(path)) fail('Runner 경로는 Runner 토큰만 쓴다.');

  return {
    ...input,
    idempotency,
    errors: [...errors].sort((a, b) => ERROR_STATUS[a] - ERROR_STATUS[b] || a.localeCompare(b)),
  };
}
