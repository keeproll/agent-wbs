// M4 통합 교차 리뷰 P1-3·4·5: RunnerApp 수명(시작 인증 실패·종료 경합)과 GitHub 토큰 갱신.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError, type ApiClient } from '../src/api/client.ts';
import { RunnerApp } from '../src/app.ts';
import { sealCredential } from '../src/github/credential.ts';
import type { HostSources } from '../src/resources/host.ts';
import { State } from '../src/state/state.ts';

let home: string;
let state: State;
beforeEach(async () => { home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'app-life-')); state = await State.open(home); });
afterEach(async () => { vi.restoreAllMocks(); await state.close(); await rm(home, { recursive: true, force: true }); });

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
function deferred() { let resolve: () => void = () => undefined; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
const hostSources: HostSources = {
  readFile: (path) => Promise.resolve(({ '/etc/machine-id': 'm', '/proc/sys/kernel/random/boot_id': 'b', '/proc/meminfo': 'MemTotal: 1 kB\nSwapTotal: 0 kB\n' } as Record<string, string>)[path] ?? ''),
  hostname: () => 'h', kernel: () => 'k', cores: () => 1, diskFree: () => Promise.resolve(1),
};
function app(api: ApiClient = vi.fn() as unknown as ApiClient, githubFetch?: typeof fetch) {
  return new RunnerApp({ state, api, home, version: 't', env: {}, warn: () => undefined, hostSources,
    cliRegistry: { latest: () => Promise.resolve('1.0.0'), install: () => Promise.resolve(), probe: () => Promise.resolve() },
    ...(githubFetch && { github: { repo: { owner: 'o', repo: 'r' }, mode: 'token' as const }, githubFetch }),
  });
}
const settle = (p: Promise<unknown>) => { const r = { value: 'pending' }; p.then(() => { r.value = 'resolved'; }, () => { r.value = 'rejected'; }); return r; };

test('P1-3: 통신 반복의 치명적 오류는 외부 신호 없이도 run()을 끝내고 오류를 전한다', async () => {
  const a = app(); const controller = new AbortController();
  vi.spyOn(a.runner, 'run').mockRejectedValue(new ApiError('heartbeat', 401, undefined, null));
  const running = a.run(controller.signal); const r = settle(running);
  await pause(50);
  expect(r.value).toBe('rejected');
  controller.abort(); await running.catch(() => undefined);
});

test('P1-3: 시작 보고의 WBS 401/403은 재시도하지 않고 앱을 멈춘다', async () => {
  const a = app(); const controller = new AbortController();
  vi.spyOn(a.runner, 'ready', 'get').mockReturnValue(true);
  vi.spyOn(a.runner, 'run').mockImplementation((signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve()); }));
  const host = vi.spyOn(a, 'reportHost').mockRejectedValue(new ApiError('reportHost', 403, undefined, null));
  const running = a.run(controller.signal); const r = settle(running);
  await pause(50);
  expect(r.value).toBe('rejected');
  expect(host).toHaveBeenCalledTimes(1);
  controller.abort(); await running.catch(() => undefined);
});

test('P1-4: 시작 보고 중 종료하면 새 예약 작업을 등록하지 않는다', async () => {
  const a = app(); const controller = new AbortController(); const boot = deferred();
  vi.spyOn(a.runner, 'ready', 'get').mockReturnValue(true);
  vi.spyOn(a, 'bootstrap').mockImplementation(() => boot.promise);
  vi.spyOn(a.runner, 'run').mockImplementation((signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve()); }));
  const schedules = vi.spyOn(a, 'startSchedules');
  const running = a.run(controller.signal);
  await pause(30); controller.abort(); await pause(20); boot.resolve(); await running;
  expect(schedules).not.toHaveBeenCalled();
});

test('P1-4: 종료는 이미 실행 중인 예약 보고가 끝날 때까지 기다린다', async () => {
  const a = app(); const controller = new AbortController(); const report = deferred();
  let complete = false;
  vi.spyOn(a.runner, 'ready', 'get').mockReturnValue(true);
  vi.spyOn(a, 'bootstrap').mockResolvedValue();
  vi.spyOn(a.runner, 'run').mockImplementation((signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve()); }));
  vi.spyOn(a, 'checkReadiness').mockResolvedValue({ at: new Date().toISOString(), items: [] });
  vi.spyOn(a, 'reportModels').mockResolvedValue();
  vi.spyOn(a.updater, 'check').mockResolvedValue(); vi.spyOn(a.updater, 'applyPending').mockResolvedValue();
  vi.spyOn(a.reporter, 'reportUsage').mockResolvedValue();
  const concurrency = vi.spyOn(a, 'reportConcurrency').mockImplementation(async () => { await report.promise; complete = true; });
  const running = a.run(controller.signal); const r = settle(running);
  await pause(50);
  expect(concurrency).toHaveBeenCalled();
  controller.abort(); await pause(30);
  expect(r.value).toBe('pending');
  report.resolve(); await running;
  expect(complete).toBe(true);
});

test('P1-5: GitHub 연결을 다시 확인하면 새 봉인 토큰을 받는다', async () => {
  let key = ''; let currentToken = 'old-token'; let credentialCalls = 0;
  const api = (async (operation: string, request: { body?: { publicKeyPem: string } }) => {
    await Promise.resolve();
    if (operation === 'registerGithubKey') { key = request.body?.publicKeyPem ?? ''; return { status: 200, body: { keyId: 'key' }, headers: new Headers() }; }
    if (operation === 'getGithubCredential') { credentialCalls++; return { status: 200, body: { sealed: sealCredential(key, currentToken) }, headers: new Headers() }; }
    return { status: 204, body: undefined, headers: new Headers() };
  }) as unknown as ApiClient;
  const auth: string[] = [];
  const githubFetch = (async (input: string | URL, init: RequestInit) => {
    await Promise.resolve();
    const authorization = new Headers(init.headers).get('authorization') ?? ''; auth.push(authorization);
    if (authorization !== `Bearer ${currentToken}`) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    return Response.json(new URL(input).pathname === '/user' ? { login: 'user' } : { permissions: { push: true, pull: true, admin: false } });
  }) as typeof fetch;
  const a = app(api, githubFetch); await a.init();
  await a.checkGithub(); currentToken = 'new-token'; await a.checkGithub();
  expect({ credentialCalls, lastToken: auth.at(-1) }).toEqual({ credentialCalls: 2, lastToken: 'Bearer new-token' });
});

test('P1-5: GitHub 401 응답은 토큰 캐시를 비워 다음 요청이 새 토큰을 받는다', async () => {
  let key = ''; let currentToken = 'old-token'; let credentialCalls = 0;
  const api = (async (operation: string, request: { body?: { publicKeyPem: string } }) => {
    await Promise.resolve();
    if (operation === 'registerGithubKey') { key = request.body?.publicKeyPem ?? ''; return { status: 200, body: { keyId: 'key' }, headers: new Headers() }; }
    credentialCalls++; return { status: 200, body: { sealed: sealCredential(key, currentToken) }, headers: new Headers() };
  }) as unknown as ApiClient;
  const githubFetch = (async (_input: string | URL, init: RequestInit) => {
    await Promise.resolve();
    const ok = new Headers(init.headers).get('authorization') === `Bearer ${currentToken}`;
    return ok ? Response.json({}, { status: 201 }) : Response.json({ message: 'Bad credentials' }, { status: 401 });
  }) as typeof fetch;
  const a = app(api, githubFetch); await a.init();
  await a.github?.client.setCommitStatus({ sha: 'a'.repeat(40), context: 'agentwbs/task', state: 'pending' });
  currentToken = 'new-token';
  await expect(a.github?.client.setCommitStatus({ sha: 'a'.repeat(40), context: 'agentwbs/task', state: 'pending' })).rejects.toThrow();
  await a.github?.client.setCommitStatus({ sha: 'a'.repeat(40), context: 'agentwbs/task', state: 'pending' });
  expect(credentialCalls).toBe(2);
});

test('M2 통합: 입력 변경 보고는 clone이 없으면 하지 않고, 공급원이 있으면 새 계약(base·head·트리 차이)으로 보낸다', async () => {
  // 기본 공급원: GitHub 설정의 저장소 clone이 아직 없으면 보고하지 않는다(초기 분석 전).
  expect(await app(vi.fn() as unknown as ApiClient, vi.fn() as unknown as typeof fetch).reportInputs()).toBeUndefined();
  const sha = (c: string) => c.repeat(40);
  const api = vi.fn((_op: string, request: { body: { base: string; head: string } }) =>
    Promise.resolve({ status: 200, headers: new Headers(), body: { head: request.body.head, recorded: false, historyRewritten: false } }));
  const a = new RunnerApp({ state, api: api as unknown as ApiClient, home, version: 't', env: {}, warn: () => undefined, hostSources,
    cliRegistry: { latest: () => Promise.resolve('1.0.0'), install: () => Promise.resolve(), probe: () => Promise.resolve() },
    inputSource: () => Promise.resolve({ fetch: () => Promise.resolve(sha('b')), inputObservation: () => Promise.resolve({ baseIsAncestor: true, treeHash: sha('d'), changes: [], commits: [] }) }) });
  expect(await a.reportInputs()).toEqual({ head: sha('b'), recorded: false, historyRewritten: false });
  expect(api).toHaveBeenCalledWith('reportInputChanges', expect.objectContaining({ epoch: state.snapshot.epoch, body: { base: sha('b'), head: sha('b'), baseIsAncestor: true, treeHash: sha('d'), changes: [], commits: [] } }));
});
