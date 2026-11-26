/**
 * API 호출 계층 — 화면이 서버를 부르는 유일한 길.
 *
 * - 요청 이름(operation id)으로 부른다. 경로·방식은 계약(@awbs/shared/api)에서 가져온다.
 * - 변경 요청(GET 외)에는 X-CSRF-Token을 붙인다(contracts §2.4).
 *   CSRF(다른 사이트가 몰래 팀장 대신 요청을 보내는 공격)를 막는 값이다.
 * - POST에는 Idempotency-Key(같은 요청을 두 번 보내도 한 번만 처리되게 하는 번호)를 붙인다(contracts §1 「팀장 멱등」).
 * - 10초 안에 응답이 없으면 끊고 `timeout`으로 알린다(G§0.3).
 * - 오류는 모두 ApiError 하나로 바꾼다. 화면은 `kind`만 보고 오류 막대·충돌 창·안내를 고른다.
 */
import { OPERATIONS } from '@awbs/shared/api';
import { LOADING_RULES } from '../state/loading.ts';
import type { BodyOf, ErrorBody, ErrorCode, FileOperationId, FileParamsOf, FileQueryOf, OperationId, ParamsOf, QueryOf, ResponseOf } from './contract.ts';

/**
 * 화면이 오류를 다루는 갈래.
 * - validation: 400. 입력을 고쳐야 한다. 같은 요청 다시 시도 없음.
 * - conflict: 409 VERSION_CONFLICT. 충돌 창(MOD-01).
 * - rejected: 그 밖의 409. 지금 상태와 맞지 않음. 재시도하지 않고 최신을 다시 읽는다.
 * - unauthorized / forbidden: 401 / 403.
 * - notFound: 404. rateLimited: 429. server: 500 등. unavailable: 503.
 * - network: 서버에 닿지 못함. timeout: 10초 안에 응답 없음.
 */
export type ErrorKind =
  | 'validation' | 'conflict' | 'rejected' | 'unauthorized' | 'forbidden' | 'notFound'
  | 'rateLimited' | 'server' | 'unavailable' | 'network' | 'timeout';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly kind: ErrorKind;
  /** HTTP 상태. 서버에 닿지 못했으면 null */
  readonly status: number | null;
  readonly code: ErrorCode | 'NETWORK_ERROR' | 'TIMEOUT';
  /** 서버가 보낸 오류 본문(contracts §1.1). 없으면 null */
  readonly body: ErrorBody | null;
  /** 429의 Retry-After(초) */
  readonly retryAfterSec: number | null;
  constructor(kind: ErrorKind, status: number | null, code: ApiError['code'], body: ErrorBody | null, retryAfterSec: number | null = null) {
    super(body?.error.message ?? code);
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryAfterSec = retryAfterSec;
  }
  /** 서버가 알려 준 고칠 항목(400의 errors) */
  get fieldErrors(): ErrorBody['error']['errors'] {
    return this.body?.error.errors ?? [];
  }
}

function kindOf(status: number, code: string): ErrorKind {
  if (status === 400) return 'validation';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 409) return code === 'VERSION_CONFLICT' ? 'conflict' : 'rejected';
  if (status === 429) return 'rateLimited';
  if (status === 503) return 'unavailable';
  return 'server';
}

/** 본문이 계약 모양이 아닐 때(프록시 오류 화면 등) 상태 코드로 정하는 코드 */
const FALLBACK_CODE: Partial<Record<number, ErrorCode>> = {
  400: 'VALIDATION_FAILED', 401: 'LEAD_UNAUTHORIZED', 403: 'FORBIDDEN_PRINCIPAL', 404: 'NOT_FOUND', 429: 'RATE_LIMITED', 503: 'UNAVAILABLE',
};

const isErrorBody = (value: unknown): value is ErrorBody => {
  const error = (value as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return typeof error?.code === 'string' && typeof error.message === 'string';
};

export type CallArgs<Id extends OperationId> = {
  signal?: AbortSignal;
  /** POST 재시도 때 같은 키를 다시 쓰려면 넘긴다. 없으면 새로 만든다. */
  idempotencyKey?: string;
} & ([ParamsOf<Id>] extends [never] ? { params?: never } : { params: ParamsOf<Id> })
  & ([BodyOf<Id>] extends [never] ? { body?: never } : { body: BodyOf<Id> })
  & ([QueryOf<Id>] extends [never] ? { query?: never } : { query?: QueryOf<Id> });

export interface ApiClientOptions {
  fetch?: typeof globalThis.fetch;
  /** 현재 세션의 CSRF 값(GET /api/session의 csrfToken). 없으면 null */
  csrfToken: () => string | null;
  /** 401을 받으면 부른다(로그인 화면으로 보내기). */
  onUnauthorized?: () => void;
  newKey?: () => string;
  timeoutMs?: number;
}

export interface ApiClient {
  call<Id extends OperationId>(id: Id, args: CallArgs<Id>): Promise<ResponseOf<Id>>;
}

function buildUrl(id: string, params?: Record<string, string>, query?: Record<string, unknown>) {
  const op = OPERATIONS.find((candidate) => candidate.id === id);
  if (!op) throw new Error(`계약에 없는 요청: ${id}`);
  let url = op.path.replace(/:(\w+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`${id}: 경로 값 ${name}이 없습니다.`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) search.set(key, String(value));
  if (search.size > 0) url += `?${search.toString()}`;
  return { op, url };
}

/**
 * 파일(PDF·ZIP·Evidence 원본)을 내려받는 주소. `<a href={apiUrl(...)} download>`처럼 브라우저에 맡긴다.
 * 왜 call로 읽지 않나: 파일은 JSON이 아니고, 큰 파일을 화면 메모리에 올릴 필요가 없다. 세션 쿠키는 같은 출처라 함께 간다.
 */
export function apiUrl<Id extends FileOperationId>(
  id: Id,
  args: ([FileParamsOf<Id>] extends [never] ? { params?: never } : { params: FileParamsOf<Id> }) & ([FileQueryOf<Id>] extends [never] ? { query?: never } : { query: FileQueryOf<Id> }),
): string {
  const { params, query } = args as { params?: Record<string, string>; query?: Record<string, unknown> };
  const built = buildUrl(id, params, query);
  // 계약의 필수 query가 빠진 주소는 서버가 400으로 거부한다. 만들기 전에 막는다.
  const required = (built.op.query as { required?: string[] } | undefined)?.required ?? [];
  const missing = required.filter((name) => query?.[name] === undefined || query[name] === null);
  if (missing.length > 0) throw new Error(`${id}: 필수 query ${missing.join(', ')}가 없습니다.`);
  return built.url;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const newKey = options.newKey ?? (() => crypto.randomUUID());
  const timeoutMs = options.timeoutMs ?? LOADING_RULES.timeoutMs;

  return {
    async call(id, args) {
      const { params, query, body, signal, idempotencyKey } = args as {
        params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal; idempotencyKey?: string;
      };
      const { op, url } = buildUrl(id, params, query);
      if (op.binary) throw new Error(`${id}는 파일 응답(${op.binary}) 요청이라 call로 부를 수 없습니다. apiUrl로 내려받기 주소를 만드세요.`);
      // 이미 취소된 요청은 보내지 않는다.
      signal?.throwIfAborted();

      const headers = new Headers({ accept: 'application/json' });
      if (body !== undefined) headers.set('content-type', 'application/json');
      if (op.method !== 'GET') {
        const csrf = options.csrfToken();
        if (csrf) headers.set('x-csrf-token', csrf);
      }
      if (op.method === 'POST' && op.idempotency !== 'none') headers.set('idempotency-key', idempotencyKey ?? newKey());

      // 10초 제한과 취소는 응답 본문을 다 읽을 때까지 유지한다(헤더만 오고 본문이 멈추는 경우).
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(new DOMException('timeout', 'TimeoutError')); }, timeoutMs);
      const onAbort = () => { controller.abort(signal?.reason); };
      signal?.addEventListener('abort', onAbort, { once: true });
      let response: Response;
      let text: string;
      try {
        response = await doFetch(url, {
          method: op.method,
          headers,
          credentials: 'same-origin',
          signal: controller.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        text = await response.text();
      } catch (error) {
        if (signal?.aborted) throw error;
        if (controller.signal.aborted) throw new ApiError('timeout', null, 'TIMEOUT', null);
        throw new ApiError('network', null, 'NETWORK_ERROR', null);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }

      let parsed: unknown = null;
      let parseFailed = false;
      if (text !== '') {
        try { parsed = JSON.parse(text); } catch { parseFailed = true; }
      }
      if (response.ok) {
        if (response.status === 204) return undefined as ResponseOf<typeof id>;
        // 성공 상태인데 본문이 JSON이 아니면 서버(또는 중간 장치) 문제로 본다.
        if (parseFailed || text === '') throw new ApiError('server', response.status, 'INTERNAL', null);
        return parsed as ResponseOf<typeof id>;
      }
      const errorBody = isErrorBody(parsed) ? parsed : null;
      const code = (errorBody?.error.code as ErrorCode | undefined) ?? FALLBACK_CODE[response.status] ?? (response.status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED');
      const retryAfter = Number(response.headers.get('retry-after'));
      const error = new ApiError(kindOf(response.status, code), response.status, code, errorBody, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
      if (error.kind === 'unauthorized') options.onUnauthorized?.();
      throw error;
    },
  };
}
