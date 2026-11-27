import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiUrl, createApiClient, downloadFile } from '../src/shared/api/client.ts';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const errorBody = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: 'm', action: 'a', fix: 'f', errors: [], details: {}, requestId: 'r1', ...extra },
});

function setup(response: () => Promise<Response> | Response) {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => Promise.resolve(response()));
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
    expect(init?.cache).toBe('no-store');
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

  // 독립 리뷰 eebac50 #2: 헤더만 오고 본문이 멈춘 경우
  it('본문이 멈춰도 10초 제한이 본문 읽기까지 적용된다', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_u: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"a":'));
            init.signal?.addEventListener('abort', () => { controller.error(init.signal?.reason); });
          },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
      });
      const client = createApiClient({ fetch: fetch as unknown as typeof globalThis.fetch, csrfToken: () => null });
      const pending = client.call('getProject', {}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toMatchObject({ kind: 'timeout', code: 'TIMEOUT' });
    } finally { vi.useRealTimers(); }
  });

  it('성공 응답 본문이 JSON이 아니면 ApiError(server)', async () => {
    const { client } = setup(() => new Response('{bad', { status: 200 }));
    const error = await client.call('getProject', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'server', status: 200, code: 'INTERNAL' });
  });

  it('본문을 읽다가 연결이 끊기면 ApiError(network)', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError('network')); } });
    const { client } = setup(() => new Response(body, { status: 200 }));
    await expect(client.call('getProject', {})).rejects.toMatchObject({ kind: 'network', code: 'NETWORK_ERROR' });
  });

  it('이미 취소된 signal이면 요청을 보내지 않는다', async () => {
    const { fetch, client } = setup(() => json(200, {}));
    const controller = new AbortController();
    controller.abort();
    await expect(client.call('getProject', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  // 독립 리뷰 eebac50 #5: 파일 응답
  it('파일(바이너리) 응답 요청은 call로 부를 수 없고 apiUrl로 내려받기 주소를 만든다', async () => {
    const { fetch, client } = setup(() => new Response('%PDF-1.7', { status: 200 }));
    // @ts-expect-error 파일 응답 요청은 OperationId에서 빠진다.
    await expect(client.call('getReportPdf', { params: { reportId: 'r 1' } })).rejects.toThrow(/파일 응답/);
    expect(fetch).not.toHaveBeenCalled();
    // 재리뷰 c16d765 #3: 계약의 필수 query(view)는 필수 인수다. 도우미가 임의로 고르지 않는다.
    // @ts-expect-error 필수 query(view)가 없으면 타입 오류다.
    expect(() => apiUrl('getReportPdf', { params: { reportId: 'r 1' } })).toThrow(/view/);
    expect(apiUrl('getReportPdf', { params: { reportId: 'r 1' }, query: { view: 'int' } })).toBe('/api/reports/r%201/pdf?view=int');
    expect(() => apiUrl('getReportPdf', { params: { reportId: 'r1' } } as never)).toThrow(/view/);
    expect(apiUrl('exportProject', {})).toBe('/api/project/export');
  });
});

describe('파일 내려받기(downloadFile, M6-02 보고서 PDF)', () => {
  const pdfFetch = (response: () => Response | Promise<Response>) =>
    vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => Promise.resolve(response()));

  it('성공하면 내용과 Content-Disposition의 한글 파일 이름(filename*)을 돌려준다', async () => {
    const fetch = pdfFetch(() => new Response('%PDF-1.7', {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="RPT-W-261026.pdf"; filename*=UTF-8''${encodeURIComponent('RPT-W-261026_팀장용.pdf')}` },
    }));
    const file = await downloadFile('getReportPdf', { params: { reportId: 'r-1' }, query: { view: 'int' } }, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/reports/r-1/pdf?view=int');
    expect(file.fileName).toBe('RPT-W-261026_팀장용.pdf');
    expect(await file.blob.text()).toBe('%PDF-1.7');
  });

  it('503 PDF_FAILED는 서버 본문(안내 포함)을 담은 ApiError다', async () => {
    const fetch = pdfFetch(() => json(503, errorBody('PDF_FAILED', { fix: '기간을 나눠 생성하세요.' })));
    const error = await downloadFile('getReportPdf', { params: { reportId: 'r-1' }, query: { view: 'int' } }, { fetch: fetch as unknown as typeof globalThis.fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PDF_FAILED');
    expect((error as ApiError).kind).toBe('unavailable');
    expect((error as ApiError).body?.error.fix).toBe('기간을 나눠 생성하세요.');
  });

  it('PDF는 만드는 데 시간이 걸리므로 일반 요청(10초)보다 길게 기다린다', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      // 실제 fetch처럼 취소 신호를 받으면 실패한다.
      const fetch = vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>((_, reject) => { signal?.addEventListener('abort', () => { reject(signal?.reason as Error); }); });
      });
      const pending = downloadFile('getReportPdf', { params: { reportId: 'r-1' }, query: { view: 'int' } }, { fetch: fetch as unknown as typeof globalThis.fetch }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(((await pending) as ApiError).code).toBe('TIMEOUT');
    } finally { vi.useRealTimers(); }
  });
});
