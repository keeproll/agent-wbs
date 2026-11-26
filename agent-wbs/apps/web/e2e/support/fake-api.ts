/**
 * E2E용 가짜 API — 브라우저의 /api 요청을 Playwright가 가로채 계약 모양의 응답을 준다.
 * 기본 응답: 로그인됨, 프로젝트 active, Runner 연결됨, 변경 이벤트 없음.
 * 시험마다 `api.on('GET /api/project', handler)`로 바꾼다.
 * 응답 모양은 계약 타입(ResponseOf)으로 적어 서버 계약과 어긋나면 typecheck가 실패한다.
 */
import type { BrowserContext, Page, Request, Route } from '@playwright/test';
import type { ErrorCode, ResponseOf } from '../../src/shared/api/contract.ts';

export const SESSION: ResponseOf<'getSession'> = {
  principal: 'lead', method: 'password', expiresAt: '2026-11-26T13:00:00.000Z', csrfToken: 'password.csrf-test',
};

export const ACTIVE_PROJECT = {
  state: 'active', id: 'p1', name: 'Verum-SDN Agent WBS — Self Development', epoch: 1, cleanup: 'none',
  approvedAt: '2026-11-01T00:00:00.000Z', approvedTaskCount: 12,
} as unknown as ResponseOf<'getProject'>;
export const NO_PROJECT = { state: 'none', epoch: 1, cleanup: 'none' } as unknown as ResponseOf<'getProject'>;

export const RUNNER = { connection: { online: true, runnerId: 'r1', version: '1', lastHeartbeatAt: null, sessionStartedAt: null } } as unknown as ResponseOf<'getRunnerState'>;

export const errorBody = (code: ErrorCode, extra: { message?: string; fix?: string; errors?: { path: string; rule: string; message: string }[]; details?: unknown } = {}) => ({
  error: { code, message: extra.message ?? '요청을 처리하지 못했습니다.', action: '저장', fix: extra.fix ?? '입력을 확인하세요.', errors: extra.errors ?? [], details: extra.details ?? {}, requestId: 'req-e2e' },
});

export type Handler = (route: Route, request: Request) => Promise<void> | void;

export const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers, body: body === null ? '' : JSON.stringify(body) });

/** 응답을 보내지 않는 요청(서버 무응답). release()를 부르면 그때 handler로 응답한다. */
export function hold(then: Handler): { handler: Handler; release: () => void } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { handler: async (route, request) => { await gate; await then(route, request); }, release: () => { open(); } };
}

export const delay = (ms: number, then: Handler): Handler => async (route, request) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await then(route, request);
};

export interface FakeApi {
  on: (key: string, handler: Handler) => void;
  /** 받은 요청 기록 `METHOD /path?query` */
  calls: () => string[];
  requests: (key: string) => Request[];
}

/** page 대신 context를 주면 그 context에서 새로 열리는 탭(popup)도 같은 가짜 API를 쓴다. */
export async function fakeApi(page: Page | BrowserContext, options: { session?: boolean; project?: ResponseOf<'getProject'> } = {}): Promise<FakeApi> {
  const handlers = new Map<string, Handler>([
    ['GET /api/session', (route) => (options.session === false ? json(route, 401, errorBody('LEAD_UNAUTHORIZED')) : json(route, 200, SESSION))],
    ['GET /api/project', (route) => json(route, 200, options.project ?? ACTIVE_PROJECT)],
    ['GET /api/runner-state', (route) => json(route, 200, RUNNER)],
    ['GET /api/changes', (route) => json(route, 200, { events: [], next: 0, reset: false })],
  ]);
  const seen: Request[] = [];
  await page.route('**/api/**', async (route, request) => {
    const url = new URL(request.url());
    seen.push(request);
    const handler = handlers.get(`${request.method()} ${url.pathname}`);
    if (handler) await handler(route, request);
    else await json(route, 404, errorBody('NOT_FOUND', { message: `가짜 API에 없는 요청: ${request.method()} ${url.pathname}` }));
  });
  return {
    on: (key, handler) => { handlers.set(key, handler); },
    calls: () => seen.map((r) => { const u = new URL(r.url()); return `${r.method()} ${u.pathname}${u.search}`; }),
    requests: (key) => seen.filter((r) => `${r.method()} ${new URL(r.url()).pathname}` === key),
  };
}
