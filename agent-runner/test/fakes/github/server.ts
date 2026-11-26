import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  /** `:name` 경로 변수 값. 완전 일치 경로면 비어 있다. */
  params?: Record<string, string>;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** 처리는 끝났지만 응답을 보내지 않고 연결을 끊는다(응답 유실 흉내). */
  drop?: boolean;
}

export type Handler = (request: FakeRequest) => FakeResponse | Promise<FakeResponse>;

export interface FakeGitHub {
  url: string;
  requests: FakeRequest[];
  /** `METHOD /path` 완전 일치, 또는 `:name` 경로 변수(한 마디). 같은 키를 다시 등록하면 바꾼다. 완전 일치가 먼저다. */
  on(route: string, handler: Handler): void;
  /** 등록하지 않은 호출이 있었으면 실패한다. */
  assertNoUnexpected(): void;
  close(): Promise<void>;
}

function match(routes: Map<string, Handler>, method: string, path: string) {
  const exact = routes.get(`${method} ${path}`);
  if (exact) return { handler: exact, params: {} };
  const parts = path.split('/');
  for (const [key, handler] of routes) {
    const [routeMethod, routePath = ''] = key.split(' ');
    const pattern = routePath.split('/');
    if (routeMethod !== method || pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = pattern.every((segment, i) => {
      const actual = parts[i] ?? '';
      if (!segment.startsWith(':')) return segment === actual;
      if (actual === '') return false;
      params[segment.slice(1)] = decodeURIComponent(actual);
      return true;
    });
    if (ok) return { handler, params };
  }
  return undefined;
}

/** 127.0.0.1에만 뜨는 가짜 GitHub REST API. 저장소 동작은 `model.ts`가 이 위에 올린다. */
export async function startFakeGitHub(token: string): Promise<FakeGitHub> {
  const routes = new Map<string, Handler>();
  const requests: FakeRequest[] = [];
  const unexpected: string[] = [];

  const server = createServer((req, res) => {
    const respond = ({ status = 200, body, headers, drop }: FakeResponse) => {
      if (drop) {
        req.socket.destroy();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const handle = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.headers.authorization !== `Bearer ${token}`) {
        respond({ status: 401, body: { message: 'Bad credentials' } });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://fake');
      const request: FakeRequest = {
        method: req.method ?? '',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
      };
      requests.push(request);
      const key = `${request.method} ${request.path}`;
      const matched = match(routes, request.method, request.path);
      if (!matched) {
        unexpected.push(key);
        respond({ status: 501, body: { message: `fake에 없는 호출: ${key}` } });
        return;
      }
      if (Object.keys(matched.params).length > 0) request.params = matched.params;
      respond(await matched.handler(request));
    };
    handle().catch((error: unknown) => {
      respond({ status: 500, body: { message: String(error) } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    requests,
    on: (route, handler) => routes.set(route, handler),
    assertNoUnexpected: () => {
      if (unexpected.length > 0) throw new Error(`fake GitHub에 없는 호출: ${unexpected.join(', ')}`);
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
