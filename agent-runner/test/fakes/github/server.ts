import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (request: FakeRequest) => FakeResponse | Promise<FakeResponse>;

export interface FakeGitHub {
  url: string;
  requests: FakeRequest[];
  /** `METHOD /path` 완전 일치. 같은 키를 다시 등록하면 바꾼다. */
  on(route: string, handler: Handler): void;
  /** 등록하지 않은 호출이 있었으면 실패한다. */
  assertNoUnexpected(): void;
  close(): Promise<void>;
}

/** 127.0.0.1에만 뜨는 가짜 GitHub REST API. 엔드포인트 동작은 M4-04에서 추가한다. */
export async function startFakeGitHub(token: string): Promise<FakeGitHub> {
  const routes = new Map<string, Handler>();
  const requests: FakeRequest[] = [];
  const unexpected: string[] = [];

  const server = createServer((req, res) => {
    const respond = ({ status = 200, body, headers }: FakeResponse) => {
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
      const handler = routes.get(key);
      if (!handler) {
        unexpected.push(key);
        respond({ status: 501, body: { message: `fake에 없는 호출: ${key}` } });
        return;
      }
      respond(await handler(request));
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
