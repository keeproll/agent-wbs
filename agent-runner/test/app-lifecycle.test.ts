// M4 통합 교차 리뷰 P1-3·4·5: RunnerApp 수명(시작 인증 실패·종료 경합)과 GitHub 토큰 갱신.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError, type ApiClient } from '../src/api/client.ts';
import { RunnerApp, type RunnerAppDeps } from '../src/app.ts';
import { sealCredential } from '../src/github/credential.ts';
import { DeployKeyError } from '../src/github/client.ts';
import type { HostSources } from '../src/resources/host.ts';
import { State } from '../src/state/state.ts';
import { protectedMainResponse } from './fakes/github/rules.ts';
import { fixture } from './ci/int-fixture.ts';

let home: string;
let state: State;
beforeEach(async () => { home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'app-life-')); state = await State.open(home); });
afterEach(async () => { vi.restoreAllMocks(); await state.close(); await rm(home, { recursive: true, force: true }); });

test('Runner 앱 반복이 실제 CI 실행기로 integrate·ci_retry를 예약한다', async () => {
  const f = await fixture(), controller = new AbortController();
  const claims:string[][] = [];
  const api = (async (operation:string,request:{body?:{kinds:string[]}}) => {
    if (operation === 'claimJob') claims.push(request.body?.kinds ?? []);
    return { status:204,body:undefined,headers:new Headers() };
  }) as unknown as ApiClient;
  const a = new RunnerApp({ state,api,home,version:'t',env:{},warn:()=>undefined,hostSources,
    cliRegistry:{ latest:async ()=>'1.0.0',install:async()=>undefined,probe:async()=>undefined },
    github:{ repo:{owner:'o',repo:'r'},mode:'gh',baseUrl:f.github.url },
    ci:{ repo:f.repo,execute:(_job,argv,cwd)=>f.deps.execute(argv,cwd),collectTests:f.deps.collectTests } });
  vi.spyOn(a.runner,'ready','get').mockReturnValue(true);
  vi.spyOn(a.reporter,'caps','get').mockReturnValue({ total:1,Claude:1,Codex:1,heavy:1 });
  vi.spyOn(a.runner,'run').mockImplementation(signal => new Promise(resolve=>{ signal.addEventListener('abort',()=>resolve()); }));
  vi.spyOn(a,'bootstrap').mockResolvedValue();
  vi.spyOn(a,'checkReadiness').mockResolvedValue({ at:new Date().toISOString(),items:[] });
  vi.spyOn(a,'reportModels').mockResolvedValue();
  vi.spyOn(a,'reportConcurrency').mockResolvedValue();
  vi.spyOn(a.reporter,'reportUsage').mockResolvedValue();
  vi.spyOn(a.updater,'check').mockResolvedValue();
  vi.spyOn(a.updater,'applyPending').mockResolvedValue();
  const running = a.run(controller.signal);
  try { await expect.poll(()=>claims,{ timeout:10_000 }).toEqual([['integrate','ci_retry']]); }
  finally { controller.abort(); await running; await f.close(); }
});

test('done 정리: CI 실행기가 병합을 확인하면 그 Task 브랜치의 작업 폴더 정리(jobs.merged)를 부르고, 실패는 경고만 남긴다', async () => {
  const f = await fixture(), controller = new AbortController();
  const api = (async () => ({ status:204,body:undefined,headers:new Headers() })) as unknown as ApiClient;
  const released: string[] = [], warnings: string[] = [];
  const a = new RunnerApp({ state,api,home,version:'t',env:{},warn:message => { warnings.push(message); },hostSources,
    cliRegistry:{ latest:async ()=>'1.0.0',install:async()=>undefined,probe:async()=>undefined },
    github:{ repo:{owner:'o',repo:'r'},mode:'gh',baseUrl:f.github.url },
    ci:{ repo:f.repo,execute:(_job,argv,cwd)=>f.deps.execute(argv,cwd),collectTests:f.deps.collectTests },
    jobs:{ collect:async () => ({ report:{ summary:'',changedFiles:[],evidence:[] } }),taskCheck:async () => { throw new Error('실행하지 않음'); },
      merged:async branch => { released.push(branch); throw new Error('정리 실패 흉내'); } } });
  vi.spyOn(a.runner,'ready','get').mockReturnValue(true);
  vi.spyOn(a.reporter,'caps','get').mockReturnValue({ total:1,Claude:1,Codex:1,heavy:1 });
  vi.spyOn(a.runner,'run').mockImplementation(signal => new Promise(resolve=>{ signal.addEventListener('abort',()=>resolve()); }));
  for (const name of ['bootstrap','checkReadiness','reportModels','reportConcurrency'] as const) vi.spyOn(a,name).mockResolvedValue(undefined as never);
  vi.spyOn(a.reporter,'reportUsage').mockResolvedValue();
  vi.spyOn(a.updater,'check').mockResolvedValue();
  vi.spyOn(a.updater,'applyPending').mockResolvedValue();
  if (!a.jobs || !a.ci) throw new Error('시도 흐름·CI 실행기가 연결되지 않았습니다.');
  vi.spyOn(a.jobs,'poll').mockResolvedValue();
  let merged = false;
  vi.spyOn(a.ci,'runNext').mockImplementation(async () => {
    if (merged) return null;
    merged = true;
    return { job:{} as never,result:{ kind:'merged',branch:'agent/TASK-0001-h1' } as never };
  });
  const running = a.run(controller.signal);
  try {
    await expect.poll(()=>released,{ timeout:10_000 }).toEqual(['agent/TASK-0001-h1']);
    await expect.poll(()=>warnings.some(w => w.includes('병합 뒤 작업 폴더 정리 실패'))).toBe(true);
  } finally { controller.abort(); await running; await f.close(); }
});

test('지금 확인 요청 번호가 바뀌면 5분 주기를 기다리지 않고 새 입력 관측을 한다', async () => {
  const a = app();
  vi.spyOn(a, 'checkReadiness').mockResolvedValue({ at: new Date().toISOString(), items: [] });
  vi.spyOn(a.updater, 'check').mockResolvedValue();
  vi.spyOn(a.updater, 'applyPending').mockResolvedValue();
  vi.spyOn(a, 'reportModels').mockResolvedValue();
  vi.spyOn(a, 'reportConcurrency').mockResolvedValue();
  vi.spyOn(a.reporter, 'reportUsage').mockResolvedValue();
  const report = vi.spyOn(a, 'reportInputs').mockResolvedValue(undefined);
  a.runner.policy = { inputCheckMinutes: 5, inputRecheck: 0, inputCheckRequest: 0 } as typeof a.runner.policy;
  vi.useFakeTimers();
  try {
    a.startSchedules();
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(report).toHaveBeenCalledTimes(1);
    if (a.runner.policy) a.runner.policy.inputCheckRequest = 1;
    await vi.advanceTimersByTimeAsync(5000);
    expect(report).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(report).toHaveBeenCalledTimes(2);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

function deferred() { let resolve: () => void = () => undefined; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
const hostSources: HostSources = {
  readFile: (path) => Promise.resolve(({ '/etc/machine-id': 'm', '/proc/sys/kernel/random/boot_id': 'b', '/proc/meminfo': 'MemTotal: 1 kB\nSwapTotal: 0 kB\n' } as Record<string, string>)[path] ?? ''),
  hostname: () => 'h', kernel: () => 'k', cores: () => 1, diskFree: () => Promise.resolve(1),
};
function app(api: ApiClient = vi.fn() as unknown as ApiClient, githubFetch?: typeof fetch, warn: (message: string) => void = () => undefined, jobs?: RunnerAppDeps['jobs']) {
  return new RunnerApp({ state, api, home, version: 't', env: {}, warn, hostSources,
    cliRegistry: { latest: () => Promise.resolve('1.0.0'), install: () => Promise.resolve(), probe: () => Promise.resolve() },
    ...(githubFetch && { github: { repo: { owner: 'o', repo: 'r' }, mode: 'token' as const }, githubFetch }),
    ...(jobs && { jobs }),
  });
}

test('M5-05: 조립한 job 실행은 같은 Execution을 사용하고 앱 종료가 진행 중인 흐름도 기다린다', async () => {
  const a = app(undefined, undefined, undefined, { collect: async () => ({ report: { summary: '', changedFiles: [], evidence: [] } }), taskCheck: async () => { throw new Error('이 시험에서는 실행하지 않습니다.'); } });
  expect(a.jobs).toBeDefined();
  if (!a.jobs) throw new Error('시도 흐름이 연결되지 않았습니다.');
  const shutdown = vi.spyOn(a.jobs, 'shutdown').mockResolvedValue();
  const controller = new AbortController();
  controller.abort();
  await a.run(controller.signal);
  expect(shutdown).toHaveBeenCalledOnce();
});
const settle = (p: Promise<unknown>) => { const r = { value: 'pending' }; p.then(() => { r.value = 'resolved'; }, () => { r.value = 'rejected'; }); return r; };

test.each([false, true])('M4-06: 연결 확인과 쓰기 전에 다른 deploy key를 경고하고 중단한다(경고 출력 실패=%s)', async (warningFails) => {
  let key = '';
  const api = (async (operation: string, request: { body?: { publicKeyPem: string } }) => {
    if (operation === 'registerGithubKey') { key = request.body?.publicKeyPem ?? ''; return { body: { keyId: 'k' } }; }
    return { body: { sealed: sealCredential(key, 'guard-token') } };
  }) as unknown as ApiClient;
  const requests: string[] = []; const warnings: string[] = [];
  const send = (async (input: string | URL) => {
    requests.push(new URL(input).pathname);
    return Response.json([{ id: 8, read_only: false }]);
  }) as typeof fetch;
  const a = app(api, send, (text) => { warnings.push(text); if (warningFails) throw new Error('경고 출력 장애'); }); await a.init();
  await expect(a.checkGithub()).rejects.toBeInstanceOf(DeployKeyError);
  await expect(a.github?.client.setCommitStatus({ sha: 'a'.repeat(40), context: 'agentwbs/int', state: 'success' })).rejects.toBeInstanceOf(DeployKeyError);
  expect(requests).toEqual(['/repos/o/r/keys', '/repos/o/r/keys']);
  expect(warnings).toHaveLength(2);
  expect(warnings.every((text) => text.includes('시스템 키 외'))).toBe(true);
});

test('M4-06: 시작 점검에서 키 정책을 확인할 수 없으면 계속 실행하지 않는다', async () => {
  const a = app();
  vi.spyOn(a.execution, 'recover').mockResolvedValue(true);
  vi.spyOn(a, 'reportHost').mockResolvedValue();
  vi.spyOn(a.updater, 'recover').mockResolvedValue();
  vi.spyOn(a, 'checkReadiness').mockResolvedValue({ at: new Date().toISOString(), items: [] });
  vi.spyOn(a, 'reportModels').mockResolvedValue();
  vi.spyOn(a, 'checkGithub').mockRejectedValue(new DeployKeyError('시스템 키 외 deploy key', -1, false));
  await expect(a.bootstrap()).rejects.toBeInstanceOf(DeployKeyError);
});

test('M1: 다른 키가 확인된 시작 실패는 Runner 반복도 종료한다', { timeout: 15_000 }, async () => {
  const a = app(); const controller = new AbortController();
  vi.spyOn(a.runner, 'ready', 'get').mockReturnValue(true);
  vi.spyOn(a.runner, 'run').mockImplementation((signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve()); }));
  vi.spyOn(a, 'bootstrap').mockRejectedValue(new DeployKeyError('시스템 키 외 deploy key', -1, false));
  const running = a.run(controller.signal); const result = settle(running);
  try {
    await vi.waitFor(() => { expect(result.value).toBe('rejected'); }, { timeout: 10_000 });
  } finally { controller.abort(); await running.catch(() => undefined); }
});

test('H1: owner의 한정 토큰으로 키 목록을 읽고 우회 불가 연결 확인도 통과한다', async () => {
  let key = '';
  const api = (async (operation: string, request: { body?: { publicKeyPem: string } }) => {
    if (operation === 'registerGithubKey') { key = request.body?.publicKeyPem ?? ''; return { body: { keyId: 'key' } }; }
    return { body: { sealed: sealCredential(key, 'owner-fine-grained-fixture') } };
  }) as unknown as ApiClient;
  const paths: string[] = [];
  const send = (async (input: string | URL) => {
    const path = new URL(input).pathname; paths.push(path);
    if (path.endsWith('/keys')) return Response.json([]);
    if (path === '/user') return Response.json({ login: 'owner' });
    return protectedMainResponse(path) ?? Response.json({ permissions: { admin: true, push: true, pull: true } });
  }) as typeof fetch;
  const a = app(api, send); await a.init();
  if (!a.github) throw new Error('GitHub 시험 설정이 없습니다.');
  const report = vi.spyOn(a.github.connector, 'reportConnection');
  await a.checkGithub();
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ ok: true, account: 'owner',
    permissions: { metadata: 'verified', contents: 'unverified', pulls: 'unverified', statuses: 'unverified' } }));
  expect(paths).toContain('/repos/o/r/keys');
  expect(paths).toContain('/repos/o/r/rulesets/1');
});

test('P1-3: 통신 반복의 치명적 오류는 외부 신호 없이도 run()을 끝내고 오류를 전한다', { timeout: 15_000 }, async () => {
  const a = app(); const controller = new AbortController();
  vi.spyOn(a.runner, 'run').mockRejectedValue(new ApiError('heartbeat', 401, undefined, null));
  const running = a.run(controller.signal); const r = settle(running);
  try { await vi.waitFor(() => { expect(r.value).toBe('rejected'); }, { timeout: 10_000 }); }
  finally { controller.abort(); await running.catch(() => undefined); }
});

test('P1-3: 시작 보고의 WBS 401/403은 재시도하지 않고 앱을 멈춘다', { timeout: 15_000 }, async () => {
  const a = app(); const controller = new AbortController();
  vi.spyOn(a.runner, 'ready', 'get').mockReturnValue(true);
  vi.spyOn(a.runner, 'run').mockImplementation((signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve()); }));
  const host = vi.spyOn(a, 'reportHost').mockRejectedValue(new ApiError('reportHost', 403, undefined, null));
  const running = a.run(controller.signal); const r = settle(running);
  try {
    await vi.waitFor(() => { expect(r.value).toBe('rejected'); }, { timeout: 10_000 });
    expect(host).toHaveBeenCalledTimes(1);
  } finally { controller.abort(); await running.catch(() => undefined); }
});

test('P1-4: 시작 보고 중 종료하면 새 예약 작업을 등록하지 않는다', { timeout: 15_000 }, async () => {
  const a = app(); const controller = new AbortController(); const boot = deferred();
  vi.spyOn(a.runner, 'ready', 'get').mockReturnValue(true);
  const bootstrap = vi.spyOn(a, 'bootstrap').mockImplementation(() => boot.promise);
  vi.spyOn(a.runner, 'run').mockImplementation((signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve()); }));
  const schedules = vi.spyOn(a, 'startSchedules');
  const running = a.run(controller.signal);
  try { await vi.waitFor(() => { expect(bootstrap).toHaveBeenCalled(); }, { timeout: 10_000 }); }
  finally { controller.abort(); boot.resolve(); await running; }
  expect(schedules).not.toHaveBeenCalled();
});

test('P1-4: 종료는 이미 실행 중인 예약 보고가 끝날 때까지 기다린다', { timeout: 15_000 }, async () => {
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
  try {
    await vi.waitFor(() => { expect(concurrency).toHaveBeenCalled(); }, { timeout: 10_000 });
    controller.abort();
    // 이미 들어온 종료 신호의 Promise 처리를 한 차례 마친 뒤에도 보고를 기다려야 한다.
    await setImmediate();
    expect(r.value).toBe('pending');
  } finally { controller.abort(); report.resolve(); await running; }
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
    const protection = protectedMainResponse(new URL(input).pathname);
    if (protection) return protection;
    if (new URL(input).pathname.endsWith('/keys')) return Response.json([]);
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
  const githubFetch = (async (input: string | URL, init: RequestInit) => {
    await Promise.resolve();
    const ok = new Headers(init.headers).get('authorization') === `Bearer ${currentToken}`;
    if (!ok) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    return new URL(input).pathname.endsWith('/keys') ? Response.json([]) : Response.json({}, { status: 201 });
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
