import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RunnerApp } from '../src/app.ts';
import type { ApiClient } from '../src/api/client.ts';
import { DeployKeyError } from '../src/github/client.ts';
import { State } from '../src/state/state.ts';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));
let home: string;
let state: State;
let app: RunnerApp;
let github: NonNullable<RunnerApp['github']>;
let warnings: string[];
beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(join(tmpdir(), 'github-retry-')); state = await State.open(home); warnings = [];
  app = new RunnerApp({ state, home, api: vi.fn() as unknown as ApiClient, version: 'test', env: {},
    warn: (text) => { warnings.push(text); }, hostSources: {} as never,
    github: { repo: { owner: 'o', repo: 'r' }, mode: 'gh' },
    cliRegistry: {} as never });
  if (!app.github) throw new Error('GitHub 시험 설정이 없습니다.');
  github = app.github;
  vi.spyOn(app, 'reportHost').mockResolvedValue();
  vi.spyOn(app.updater, 'recover').mockResolvedValue();
  vi.spyOn(app, 'checkReadiness').mockResolvedValue({ at: new Date().toISOString(), items: [] });
  vi.spyOn(app, 'reportModels').mockResolvedValue();
  vi.spyOn(github.client, 'checkConnection').mockResolvedValue({ mode: 'gh', ok: true, account: 'owner', expiresAt: null,
    permissions: { metadata: 'verified', contents: 'verified', pulls: 'verified', statuses: 'verified' } });
  vi.spyOn(github.connector, 'reportConnection').mockResolvedValue(null);
});
afterEach(async () => { vi.restoreAllMocks(); await state.close(); await rm(home, { recursive: true, force: true }); });

test('M1: 일시 장애는 재시도하고 회복되면 연결 확인을 계속한다', async () => {
  const keys = vi.spyOn(github.client, 'assertDeployKeys')
    .mockRejectedValueOnce(new DeployKeyError('잠시 불가', 503, true, 7)).mockResolvedValue(undefined);
  await expect(app.bootstrap()).resolves.toBeUndefined();
  expect(keys).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(7000);
  expect(github.client.checkConnection).toHaveBeenCalledOnce();
  expect(warnings).toEqual([]);
});

test('M1: 세 번 실패하면 경고 후 시작을 계속하되 실제 쓰기는 여전히 막는다', async () => {
  const keys = vi.spyOn(github.client, 'assertDeployKeys').mockRejectedValue(new DeployKeyError('목록 통신 실패', 0, true));
  await expect(app.bootstrap()).resolves.toBeUndefined();
  expect(keys).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenNthCalledWith(1, 1000);
  expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('목록 통신 실패');
  expect(github.client.checkConnection).not.toHaveBeenCalled();
  await expect(github.client.setCommitStatus({ sha: 'a'.repeat(40), context: 'agentwbs/int', state: 'success' })).rejects.toBeInstanceOf(DeployKeyError);
});

test('M1: 다른 키 발견은 재시도하거나 경고로 넘기지 않는다', async () => {
  const keys = vi.spyOn(github.client, 'assertDeployKeys').mockRejectedValue(new DeployKeyError('시스템 키 외', -1, false));
  await expect(app.bootstrap()).rejects.toBeInstanceOf(DeployKeyError);
  expect(keys).toHaveBeenCalledOnce(); expect(sleep).not.toHaveBeenCalled();
  expect(warnings).toEqual(['시스템 키 외']);
});
