import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../src/shared/api/client.ts';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const errorBody = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: 'm', action: 'a', fix: 'f', errors: [], details: {}, requestId: 'r1', ...extra },
});

function setup(response: () => Promise<Response> | Response) {
  const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(response()));
  const client = createApiClient({ fetch: fetch as unknown as typeof globalThis.fetch, csrfToken: () => 'csrf-1', newKey: () => 'key-1' });
  return { fetch, client };
}

describe('API 호출 계층(api client)', () => {
  it('경로 값과 query를 채워 GET한다. CSRF·멱등 키는 보내지 않는다', async () => {
    const { fetch, client } = setup(() => json(200, { items: [], nextCursor: null }));
    await client.call('listHistory', { query: { limit: 20 } });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/history?limit=20');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).has('x-csrf-token')).toBe(false);
    await client.call('getTask', { params: { taskKey: 'TASK-0007' } });
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/tasks/TASK-0007');
  });

  it('변경 요청에는 X-CSRF-Token, POST에는 Idempotency-Key를 붙인다', async () => {
    const { fetch, client } = setup(() => json(200, {}));
    await client.call('updateTask', { params: { taskKey: 'TASK-0001' }, body: { updatedAt: '2026-11-26T00:00:00Z', title: 't' } });
    let headers = new Headers(fetch.mock.calls[0]?.[1].headers);
    expect(headers.get('x-csrf-token')).toBe('csrf-1');
    expect(headers.has('idempotency-key')).toBe(false);
    expect(fetch.mock.calls[0]?.[1].body).toBe('{"updatedAt":"2026-11-26T00:00:00Z","title":"t"}');
    await client.call('createMessage', { body: { taskKey: 'TASK-0001', text: 'x' } as never });
    headers = new Headers(fetch.mock.calls[1]?.[1].headers);
    expect(headers.get('idempotency-key')).toBe('key-1');
  });

  it('204는 undefined를 돌려준다', async () => {
    const { client } = setup(() => new Response(null, { status: 204 }));
    await expect(client.call('logout', {})).resolves.toBeUndefined();
  });

  it.each([
    [400, 'VALIDATION_FAILED', 'validation'],
    [401, 'LEAD_UNAUTHORIZED', 'unauthorized'],
    [404, 'TASK_NOT_FOUND', 'notFound'],
    [409, 'VERSION_CONFLICT', 'conflict'],
    [409, 'DEPENDENCY_CYCLE', 'rejected'],
    [429, 'RATE_LIMITED', 'rateLimited'],
    [500, 'INTERNAL', 'server'],
    [503, 'UNAVAILABLE', 'unavailable'],
  ] as const)('%i %s → kind %s', async (status, code, kind) => {
    const { client } = setup(() => json(status, errorBody(code), { 'retry-after': '7' }));
    const error = await client.call('getProject', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code, kind, body: { error: { code, requestId: 'r1' } } });
    if (kind === 'rateLimited') expect((error as ApiError).retryAfterSec).toBe(7);
  });

  it('응답 본문이 계약 모양이 아니면 상태 코드로만 분류한다', async () => {
    const { client } = setup(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(client.call('getProject', {})).rejects.toMatchObject({ kind: 'server', status: 502, code: 'INTERNAL', body: null });
  });

  it('연결 실패는 network', async () => {
    const { client } = setup(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(client.call('getProject', {})).rejects.toMatchObject({ kind: 'network', status: null, code: 'NETWORK_ERROR' });
  });

  it('10초 안에 응답이 없으면 timeout으로 끊는다', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => { reject(init.signal?.reason as Error); });
      }));
      const client = createApiClient({ fetch: fetch as unknown as typeof globalThis.fetch, csrfToken: () => null });
      const pending = client.call('getProject', {}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ kind: 'timeout', code: 'TIMEOUT', status: null });
    } finally { vi.useRealTimers(); }
  });

  it('호출한 쪽이 취소하면 timeout이 아니라 취소 오류를 그대로 던진다', async () => {
    const fetch = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
    }));
    const client = createApiClient({ fetch: fetch as unknown as typeof globalThis.fetch, csrfToken: () => null });
    const controller = new AbortController();
    const pending = client.call('getProject', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('401을 받으면 onUnauthorized를 부른다(로그인 화면으로 보내기)', async () => {
    const onUnauthorized = vi.fn();
    const client = createApiClient({ fetch: (() => Promise.resolve(json(401, errorBody('LEAD_UNAUTHORIZED')))) as unknown as typeof globalThis.fetch, csrfToken: () => null, onUnauthorized });
    await client.call('getProject', {}).catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
