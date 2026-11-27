// M8 전 연결: 앱이 전용 계정 격리(Q-08)를 고르고, 실제 ①을 앱의 GitHub 클라이언트로 묶는다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ApiClient } from '../src/api/client.ts';
import type { HostSources } from '../src/resources/host.ts';
import type { RunCommand } from '../src/readiness/command.ts';
import { State } from '../src/state/state.ts';

const bound: unknown[] = [];
vi.mock('../src/jobs/task-check.ts', async (original) => {
  const actual = await original<typeof import('../src/jobs/task-check.ts')>();
  return { ...actual, bindTaskCheck: (deps: unknown) => { bound.push(deps); return actual.bindTaskCheck(deps as Parameters<typeof actual.bindTaskCheck>[0]); } };
});
const { RunnerApp } = await import('../src/app.ts');

let home: string;
let state: State;
beforeEach(async () => { home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'app-iso-')); state = await State.open(home); bound.length = 0; });
afterEach(async () => { vi.restoreAllMocks(); await state.close(); await rm(home, { recursive: true, force: true }); });

const hostSources: HostSources = {
  readFile: (path) => Promise.resolve(({ '/etc/machine-id': 'm', '/proc/sys/kernel/random/boot_id': 'b', '/proc/meminfo': 'MemTotal: 1 kB\nSwapTotal: 0 kB\n' } as Record<string, string>)[path] ?? ''),
  hostname: () => 'h', kernel: () => 'k', cores: () => 1, diskFree: () => Promise.resolve(1),
};
const registry = { latest: () => Promise.resolve('1.0.0'), install: () => Promise.resolve(), probe: () => Promise.resolve() };
const api = vi.fn() as unknown as ApiClient;

function app(run: RunCommand, agentRoot: string | null, warn: (message: string) => void = () => undefined) {
  return new RunnerApp({ state, api, home, version: 't', env: {}, warn, hostSources, cliRegistry: registry, run, cliRun: run, agentRoot, cliUpdates: false });
}

test('전용 계정 설정이 없으면 격리를 고르지 않고 명령도 돌리지 않는다(기본 거부 유지)', async () => {
  const run = vi.fn<RunCommand>(async () => ({ code: 0, stdout: 'ok\n', stderr: '' }));
  const a = app(run, null);
  expect(await a.refreshIsolation()).toBeUndefined();
  expect(a.execution.isolation).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
});

test('전용 계정이면 래퍼 check와 사용자 scope 시험을 통과할 때만 「전용 계정 + scope」를 쓰고, 실패 이유는 바뀔 때만 경고한다', async () => {
  let scopeOk = true;
  const run = vi.fn<RunCommand>(async (cmd) => cmd === '/usr/bin/sudo' ? { code: 0, stdout: 'ok\n', stderr: '' } : { code: scopeOk ? 0 : 1, stdout: '', stderr: '' });
  const warn = vi.fn();
  const a = app(run, '/srv/agentwbs', warn);
  expect((await a.refreshIsolation())?.name).toBe('dedicated-user+user-scope');
  expect(a.execution.isolation?.name).toBe('dedicated-user+user-scope');
  expect(warn).not.toHaveBeenCalled();
  scopeOk = false;
  expect(await a.refreshIsolation()).toBeUndefined();
  expect(await a.refreshIsolation()).toBeUndefined();
  expect(a.execution.isolation).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toContain('실제 Agent 실행 보류');
  scopeOk = true;
  expect((await a.refreshIsolation())?.name).toBe('dedicated-user+user-scope');
});

test('시도 흐름의 실제 ①은 앱이 만든 GitHub 클라이언트·Execution·Runner로 bindTaskCheck에 묶인다', async () => {
  const run = vi.fn<RunCommand>(async () => ({ code: 0, stdout: '', stderr: '' }));
  const sources = { repo: {} as never, worktree: () => ({ id: 'w', branch: 'agent/w' }), launch: () => ({ file: '/bin/true', args: [], env: {}, cwd: '/', stdin: '' }), collectTests: async () => [], observeMainPipeline: async () => undefined };
  const a = new RunnerApp({ state, api, home, version: 't', env: {}, warn: () => undefined, hostSources, cliRegistry: registry, run, cliRun: run, cliUpdates: false,
    github: { repo: { owner: 'o', repo: 'r' }, mode: 'gh' }, githubFetch: vi.fn() as unknown as typeof fetch,
    jobs: { collect: async () => ({ report: { summary: '', changedFiles: [], evidence: [] } }), taskCheck: sources } });
  expect(a.jobs).toBeDefined();
  expect(bound).toHaveLength(1);
  const deps = bound[0] as Record<string, unknown>;
  expect(deps.github).toBe(a.github?.client);
  expect(deps.execution).toBe(a.execution);
  expect(deps.runner).toBe(a.runner);
  expect(deps.api).toBe(api);
  expect(deps.worktree).toBe(sources.worktree);
});

test('GitHub 설정이 없으면 ①은 PR 없이(github=null) 묶인다', async () => {
  const run = vi.fn<RunCommand>(async () => ({ code: 0, stdout: '', stderr: '' }));
  const sources = { repo: {} as never, worktree: () => ({ id: 'w', branch: 'agent/w' }), launch: () => ({ file: '/bin/true', args: [], env: {}, cwd: '/', stdin: '' }), collectTests: async () => [], observeMainPipeline: async () => undefined };
  new RunnerApp({ state, api, home, version: 't', env: {}, warn: () => undefined, hostSources, cliRegistry: registry, run, cliRun: run, cliUpdates: false,
    jobs: { collect: async () => ({ report: { summary: '', changedFiles: [], evidence: [] } }), taskCheck: sources } });
  expect((bound[0] as Record<string, unknown>).github).toBeNull();
});
