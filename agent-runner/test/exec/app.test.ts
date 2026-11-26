import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client.ts';
import type { ExecutionHold } from '../../src/api/generated/client.ts';
import { RunnerApp } from '../../src/app.ts';
import { nodeHostSources } from '../../src/resources/host.ts';
import { State } from '../../src/state/state.ts';

const roots: string[] = [], states: State[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(states.splice(0).map(s => s.close())); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
test('RunnerApp 시작은 서버 보유와 launch 대조 실패를 우회하지 않는다', async () => {
  const home = await mkdtemp('/home/keeproll/.orca/bots/agentwbs/archive/2026-11-27/M5-02/app-'); roots.push(home);
  const state = await State.open(home); states.push(state);
  let holds: ExecutionHold[] = [];
  const api = (async (operation: string) => ({ status: operation === 'getExecutionHolds' ? 200 : 204, headers: new Headers(), body: operation === 'getExecutionHolds' ? { holds } : undefined })) as unknown as ApiClient;
  const app = new RunnerApp({ home, state, api, version: 'fake', env: {}, warn: () => undefined, hostSources: nodeHostSources(), cliRegistry: { latest: () => Promise.resolve('1.0.0'), install: () => Promise.resolve(), probe: () => Promise.resolve() } });
  await app.init();
  vi.spyOn(app, 'reportHost').mockResolvedValue(); vi.spyOn(app.updater, 'recover').mockResolvedValue(); vi.spyOn(app, 'checkReadiness').mockResolvedValue({ at: new Date().toISOString(), items: [] }); vi.spyOn(app, 'reportModels').mockResolvedValue(); vi.spyOn(app, 'checkGithub').mockResolvedValue();
  holds = [{ id: 'hold', project_id: null, job: 'lost', attempt: null, epoch: 0, host_id: app.identity.hostId, boot_id: app.identity.bootId, fence: 1, pgid: null, cgroup: null, task: null, conflict_group: null, agent: 'Codex', slots: 1, heavy: false, slot_state: 'unconfirmed', lock_state: 'none', lock_from_job: null, handed_to_job: null, release_proof: null, closed_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  await expect(app.bootstrap()).rejects.toThrow('unconfirmed');
});
