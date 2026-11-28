import type { Secret } from '../security/secret.ts';
import { createRedactor } from '../security/redact.ts';
import { OPERATIONS, type ErrorResponse, type Operations } from './generated/client.ts';

export type OperationId = keyof Operations;
export type ApiRequest<K extends OperationId> = Operations[K]['request'];
export type ApiResponse<K extends OperationId> = {
  [S in keyof Operations[K]['responses']]: {
    status: S;
    body: Operations[K]['responses'][S];
    headers: Headers;
  };
}[keyof Operations[K]['responses']];

/** 서버가 오류로 답했다. 재시도 여부는 호출자(outbox)가 status로 판단한다. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  /** 계약 형식의 오류 본문. 프록시 응답 등 형식이 다르면 없다. */
  readonly error: ErrorResponse['error'] | undefined;
  readonly retryAfter: string | null;

  constructor(operation: OperationId, status: number, error: ErrorResponse['error'] | undefined, retryAfter: string | null) {
    super(`${operation}: ${String(status)} ${error?.code ?? '계약에 없는 응답'}`);
    this.status = status;
    this.error = error;
    this.retryAfter = retryAfter;
  }
}

/** 요청 검증 오류와 네트워크 단절을 구분하며 원문(토큰 포함 가능)은 보존하지 않는다. */
export class ApiTransportError extends Error {
  override name = 'ApiTransportError';
  constructor(operation: OperationId) { super(`${operation}: 서버에 연결하거나 응답을 읽지 못했습니다.`); }
}

export interface ApiClientOptions {
  baseUrl: string;
  token: Secret;
  fetch?: typeof fetch;
}

interface AnyRequest {
  params?: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
  epoch: number;
  idempotencyKey?: string;
  ifNoneMatch?: string;
}

// contracts §1.2
const TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 120_000;

function form(body: Record<string, unknown>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(body)) {
    if (value instanceof Blob) data.append(name, value, name);
    else data.append(name, String(value));
  }
  return data;
}

function errorOf(value: unknown): ErrorResponse['error'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { error } = value as Partial<ErrorResponse>;
  return typeof error === 'object' && typeof (error as { code?: unknown } | null)?.code === 'string' ? error : undefined;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 요청 1회. 재시도와 영속 저장은 Outbox가 맡는다. */
export function createApiClient({ baseUrl, token, fetch: send = fetch }: ApiClientOptions) {
  const redact = createRedactor([token.reveal()]);
  return async <K extends OperationId>(id: K, request: ApiRequest<K>): Promise<ApiResponse<K>> => {
    const op = OPERATIONS[id];
    const { params, query, body, epoch, idempotencyKey, ifNoneMatch } = request as AnyRequest;
    const path = op.path.replaceAll(/\{(\w+)\}/g, (_, name: string) => {
      const value = params?.[name];
      // `.`·`..`은 인코딩되지 않아 다른 경로가 된다.
      if (!value || value === '.' || value === '..') throw new TypeError(`${id}: 경로 값 ${name}이 올바르지 않습니다.`);
      return encodeURIComponent(value);
    });
    const url = new URL(baseUrl + path);
    for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(name, value);

    const headers = new Headers({ authorization: `Bearer ${token.reveal()}`, 'x-project-epoch': String(epoch) });
    if (idempotencyKey !== undefined) headers.set('idempotency-key', idempotencyKey);
    if (ifNoneMatch !== undefined) headers.set('if-none-match', ifNoneMatch);
    let payload: string | FormData | null = null;
    if (body && op.content === 'multipart') payload = form(body);
    else if (body) {
      headers.set('content-type', 'application/json');
      payload = JSON.stringify(body);
    }

    let response: Response;
    let text: string;
    try {
      response = await send(url, {
        method: op.method,
        headers,
        body: payload,
        // 토큰을 다른 주소로 보내지 않는다.
        redirect: 'manual',
        signal: AbortSignal.timeout(op.content === 'multipart' ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS),
      });
      text = await response.text();
    } catch { throw new ApiTransportError(id); }
    // 오류는 거부 기록 파일에도 남는다. 서버가 인증 정보를 되비춰도 메모리 밖으로 나가지 않게 한다.
    const value = json(text);
    // 선언한 상태라도 본문이 JSON이 아니면 서버 응답으로 믿지 않는다.
    const hasBody = (op.statuses as Readonly<Record<number, boolean>>)[response.status];
    if (hasBody === undefined || (hasBody && value === undefined)) {
      throw new ApiError(id, response.status, errorOf(redact(value)), redact(response.headers.get('retry-after')));
    }
    return { status: response.status, body: value, headers: response.headers } as unknown as ApiResponse<K>;
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
