import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { RunnerApp, type RunnerAppDeps } from '../../src/app.ts';
import type { OperationId } from '../../src/api/client.ts';
import { buildDesignSnapshot } from '../../src/design/snapshot.ts';
import type { ClaimedJob } from '../../src/api/generated/client.ts';
import { GitPushUnknownError, type GitRepository } from '../../src/git/repository.ts';
import { PaidCalls } from '../../src/exec/paid-calls.ts';
import { QueuedJobs } from '../../src/jobs/queued.ts';
import { Outbox } from '../../src/api/outbox.ts';
import { State } from '../../src/state/state.ts';
import { bootstrapJob, content, HASH, inputJob, SHA, wbsSnapshot } from '../planning/harness.ts';
import { GitHubModel } from '../fakes/github/model.ts';
import { startFakeGitHub } from '../fakes/github/server.ts';
import { installPlanningCli, probe, queuedServer, testHostSources } from './queued-harness.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { const errors = []; for (const close of cleanup.splice(0).reverse()) try { await close(); } catch (error) { errors.push(error); } if (errors.length) throw errors[0]; });
const lease = () => ({ id: crypto.randomUUID(), fence: 1, leaseUntil: new Date(Date.now() + 60_000).toISOString() });
const task = () => ({ taskKey: 'TASK-0001', workType: 'Implementation' as const, subjectHash: HASH, content: content() });
const cases: [string, () => ClaimedJob, string][] = [
  ['repo_check', () => ({ ...lease(), kind: 'repo_check', payload: { repoCheckId: crypto.randomUUID(), url: 'https://github.com/o/r' } }), 'reportRepoCheck'],
  ['github_check', () => ({ ...lease(), kind: 'github_check', payload: { mode: 'token' } }), 'reportGithubStatus'],
  ['bootstrap', () => ({ ...bootstrapJob(), ...lease() }), 'submitTechProposals'],
  ['input_diff', () => ({ ...inputJob(), ...lease() }), 'submitPlanningProposal'],
  ['planning', () => ({ ...lease(), kind: 'planning', payload: { tasks: [], policy: {}, proposal: null, planning: { id: crypto.randomUUID(), title: '검토', scope: '계획' } } }), 'submitPlanningReviews'],
  ['estimate', () => ({ ...lease(), kind: 'estimate', payload: { tasks: [task()], policy: { largeHours: 8, recommendMax: 4, tokensMaxK: 50, per: 'each', requireAll: true, count: 'main', basis: 'assumed' } } } as ClaimedJob), 'submitEstimates'],
  ['split', () => ({ ...lease(), kind: 'split', payload: { tasks: [task()], policy: {}, wbs: wbsSnapshot() } }), 'submitPlanningProposal'],
];

async function setup(job: ClaimedJob, auto = true, limit = 30, overrides: Partial<RunnerAppDeps> = {}, extra?: (operation: OperationId) => unknown) {
  const home = await mkdtemp(join(tmpdir(), 'queued-app-')); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const state = await State.open(home); cleanup.push(() => state.close());
  await installPlanningCli(home);
  const server = queuedServer([job], extra);
  const github = await startFakeGitHub('fake-github'); cleanup.push(() => github.close());
  const model = new GitHubModel({ owner: 'o', repo: 'r', private: true, oauthScopes: 'repo', files: ['prototype/uiux/index.html', 'prototype/docs/design.md'] });
  if (overrides.github?.systemKey) model.deployKeys.push({ id: overrides.github.systemKey.id, read_only: false });
  model.install(github);
  const repo = { fetch: async () => SHA, hasCommit: async () => true, worktreeState: async () => ({ kind: 'none' }),
    createWorktree: async () => home, removeWorktree: async () => undefined, inputPath: async () => null, checkoutInput: async () => home,
    prepareProject: async () => ({ commit: SHA, parent: SHA }), inputObservation: async () => ({ changes: [] }),
  } as unknown as GitRepository;
  const warnings: string[] = [];
  const app = new RunnerApp({ state, api: server.api, home, version: 'fake', env: { ...process.env, AWBS_PLANNING_CODEX_MODEL: 'fake-codex', AWBS_PLANNING_CLAUDE_MODEL: 'fake-claude' },
    run: probe, cliRun: probe, cliUpdates: false, warn: message => warnings.push(message), hostSources: testHostSources(),
    cliRegistry: { latest: async () => '1.0.0', install: async () => undefined, probe: async () => undefined },
    planningAuto: auto, agentCallLimit: limit,
    repository: async () => repo, execution: { prepare: async () => { throw new Error('시도 아님'); }, isolation: { name: 'fake', flags: () => [], wrap: launch => launch } },
    ...overrides,
    github: { repo: { owner: 'o', repo: 'r' }, mode: 'token', ...overrides.github, baseUrl: github.url },
  });
  const controller = new AbortController(), running = app.run(controller.signal);
  void running.catch(() => undefined);
  cleanup.push(async () => { controller.abort(); await running; });
  return { app, server, home, warnings, model };
}

test.each(cases)('실제 앱 시작 → claim → 가짜 CLI 실행 → %s 결과 보고', { timeout: 15_000 }, async (_kind, make, operation) => {
  const job = make(), { app, server, warnings } = await setup(job);
  await expect.poll(() => server.finished.has(job.id), { timeout: 10_000 }).toBe(true);
  expect(server.finished.get(job.id), JSON.stringify(server.finished.get(job.id))).toMatchObject({ status: 'done' });
  expect(warnings).toEqual([]);
  expect(server.schemaErrors).toEqual([]);
  expect(server.calls.some(call => call.operation === operation)).toBe(true);
  expect(server.calls.some(call => call.operation === 'startJob')).toBe(true);
  if (!['repo_check', 'github_check'].includes(job.kind)) {
    expect(server.calls.some(call => call.operation === 'reportJobProcess')).toBe(true);
    await expect.poll(() => server.holds.get(job.id)?.closed_at).toBeTruthy();
    expect(await app.paidCalls.used()).toBeGreaterThan(0);
  } else expect(await app.paidCalls.used()).toBe(0);
});

test('추가 발급 job: deploy_check도 앱에서 받아 실제 배포 처리기로 실패 근거를 보고한다', { timeout: 10_000 }, async () => {
  const job: ClaimedJob = { ...lease(), kind: 'deploy_check', payload: { commit: SHA } };
  const pipeline = JSON.stringify({ version: 1, stages: { task: ['install', 'typecheck', 'lint', 'unit', 'build', 'contract'].map(name => ({ name, argv: ['false'] })), int: [{ name: 'unit', argv: ['false'] }], night: [{ name: 'unit', argv: ['false'] }], deploy: [{ name: 'up', argv: ['false'] }] } });
  const repo = { deployPipelineAt: async () => ({ pipelineSha: SHA, source: pipeline }) } as unknown as GitRepository;
  const { server, app } = await setup(job, false, 0, { ciAuto: true, repository: async () => repo });
  await expect.poll(() => server.finished.has(job.id), { timeout: 6000 }).toBe(true);
  expect(server.finished.get(job.id)).toMatchObject({ status: 'failed', error: { code: 'DEPLOY_CHECK_FAILED' } });
  expect(server.calls.filter(call => call.operation === 'updateCiRun').some(call => call.body.status === 'fail')).toBe(true);
  expect(server.schemaErrors).toEqual([]);
  expect(await app.paidCalls.used()).toBe(0);
});

test('계약의 예약 job: merge_followup도 앱 수신 뒤 실제 main 스냅샷을 보고한다', { timeout: 10_000 }, async () => {
  const job: ClaimedJob = { ...lease(), kind: 'merge_followup', payload: { pr: 1 } };
  const repo = { fetch: async () => SHA, hasCommit: async () => true, taskBase: async () => SHA, listFiles: async () => [] } as unknown as GitRepository;
  const { server, app, model } = await setup(job, false, 0, { ciAuto: true, repository: async () => repo });
  // getPullRequest는 실제 fake GitHub REST를 통과한다.
  model.pulls.set(1, { number: 1, title: 'merged', body: '', head: 'agent/task', base: 'main', state: 'closed', merged: true, mergeCommitSha: SHA });
  await expect.poll(() => server.finished.has(job.id), { timeout: 6000 }).toBe(true);
  expect(server.finished.get(job.id), JSON.stringify(server.finished.get(job.id))).toMatchObject({ status: 'done' });
  expect(server.calls.some(call => call.operation === 'reportDesignSnapshot' && call.body.commit === SHA)).toBe(true);
  expect(server.schemaErrors).toEqual([]);
  expect(await app.paidCalls.used()).toBe(0);
});

test.each([false, true])('design_apply는 관문 뒤 결과를 보고하고, push 응답 유실(%s)은 대조해 CLI·push를 반복하지 않는다', { timeout: 10_000 }, async lost => {
  const job: ClaimedJob = { ...lease(), kind: 'design_apply', payload: { itemKey: 'GET /a', driftId: crypto.randomUUID() } };
  const commit = 'b'.repeat(40), path = 'contracts/api.json';
  const raw = JSON.stringify({ openapi: '3.1.0', info: { title: 'fake', version: '1' }, paths: { '/a': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } } } } } });
  const snapshot = await buildDesignSnapshot({ commit, jobId: job.id, fence: 1, ref: 'main', jobKind: job.kind, files: [{ path, raw }] });
  const target = snapshot.items[0]?.contract; if (!target) throw new Error('target');
  const writes: string[] = [];
  let remote = SHA;
  const repo = { fetch: async () => remote, worktreeState: async () => ({ kind: 'none' }), createWorktree: async () => tmpdir(), removeWorktree: async () => undefined,
    importWorktree: async () => commit, commitParents: async () => [SHA], changedPaths: async () => [path], listFiles: async () => [path], fileAt: async () => Buffer.from(raw),
    pushSystemCommit: async (_commit: string, _parent: string, _ssh: unknown, gate: (operation: unknown) => Promise<void>) => { await gate({ kind: 'branch_push', branch: 'main', remote: 'https://github.com/o/r' }); writes.push(commit); remote = commit; if (lost) throw new GitPushUnknownError(); },
  } as unknown as GitRepository;
  const { server, app } = await setup(job, true, 30, { repository: async () => repo, github: { repo: { owner: 'o', repo: 'r' }, mode: 'token', systemKey: { id: 1, socket: '/tmp/fake-socket', knownHosts: '/tmp/fake-hosts' } } },
    op => op === 'getDesignApplyJob' ? { sourceCommit: SHA, path, target } : undefined);
  await expect.poll(() => server.finished.has(job.id), { timeout: 6000 }).toBe(true);
  expect(server.finished.get(job.id), JSON.stringify(server.finished.get(job.id))).toMatchObject({ status: 'done' });
  expect(writes).toEqual([commit]);
  expect(server.calls.some(call => call.operation === 'reportDesignSnapshot')).toBe(true);
  expect(server.schemaErrors).toEqual([]);
  expect(await app.paidCalls.used()).toBe(1);
});

test('기본 조회 작업은 자동 분석이 꺼져 있고 예산이 0이어도 처리한다', { timeout: 10_000 }, async () => {
  const job = cases[0]?.[1](); if (!job) throw new Error('fixture');
  const { app, server } = await setup(job, false, 0, { execution: { prepare: async () => { throw new Error('무료 확인은 작업 폴더를 쓰지 않는다'); } } });
  await expect.poll(() => server.finished.get(job.id), { timeout: 6000 }).toMatchObject({ status: 'done' });
  expect(await app.paidCalls.used()).toBe(0);
  expect(app.execution.isolation).toBeUndefined();
  expect(server.calls.filter(call => call.operation === 'claimJob').every(call => (call.body.kinds as string[]).every(kind => ['repo_check', 'github_check'].includes(kind)))).toBe(true);
});

test('설정과 다른 등록 저장소는 실제 접근 결과와 함께 불일치 이유를 보고한다', { timeout: 10_000 }, async () => {
  const job = cases[0]?.[1](); if (!job) throw new Error('fixture');
  const { server } = await setup(job, false, 0, { github: { repo: { owner: 'o', repo: 'other' }, mode: 'token' },
    githubFetch: async (input, init) => { const url = new URL(String(input)); url.pathname = url.pathname.replace('/repos/o/other', '/repos/o/r'); return fetch(url, init); } });
  await expect.poll(() => server.finished.has(job.id), { timeout: 6000 }).toBe(true);
  expect(server.calls.find(call => call.operation === 'reportRepoCheck')?.body).toMatchObject({ access: true, error: expect.stringContaining('AWBS_GITHUB_REPO') });
});

test('예산 상한은 재시작·동시 요청에도 유지되고 high 초과와 손상 기록은 거부한다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'paid-calls-')); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const budget = new PaidCalls(home, 2);
  expect((await Promise.allSettled([budget.take('high'), budget.take('medium'), budget.take('low')])).map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
  expect(await new PaidCalls(home, 2).available()).toBe(false);
  await expect(new PaidCalls(home, 30).take('xhigh')).rejects.toThrow('AGENT_EFFORT_LIMIT');
  expect(JSON.parse(await readFile(join(home, 'paid-calls.json'), 'utf8'))).toEqual({ used: 2 });
  await writeFile(join(home, 'paid-calls.json'), 'broken');
  await expect(new PaidCalls(home, 30).take('high')).rejects.toThrow();
  expect(() => new PaidCalls(home, 31)).toThrow();
});

test('앱의 초기 분석은 예산 2회에서 세 번째 교차 검토 CLI를 띄우지 않고 실패를 보고한다', { timeout: 10_000 }, async () => {
  const job = { ...bootstrapJob(), ...lease() };
  const { app, server } = await setup(job, true, 2);
  await expect.poll(() => server.finished.has(job.id), { timeout: 6000 }).toBe(true);
  expect(server.finished.get(job.id)).toMatchObject({ status: 'failed' });
  expect(new Set(server.calls.filter(call => call.operation === 'reportJobProcess').map(call => call.key)).size).toBe(2);
  expect(server.calls.some(call => call.operation === 'submitTechProposals')).toBe(false);
  expect(await app.paidCalls.used()).toBe(2);
});

test('5초 여유가 없는 임대는 start·실행·성공 보고를 하지 않는다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'queued-lease-')); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const state = await State.open(home); cleanup.push(() => state.close());
  const job = cases[0]?.[1](); if (!job) throw new Error('fixture');
  const server = queuedServer([job], operation => operation === 'renewJob' ? { leaseUntil: new Date(Date.now() + 2000).toISOString() } : undefined);
  let executed = false;
  const queued = new QueuedJobs({ home, api: server.api, outbox: new Outbox(state, server.api), runnerId: state.snapshot.runnerId,
    identity: () => ({ hostId: 'host', bootId: 'boot' }), epoch: () => 0, ready: () => true, kinds: async () => ['repo_check'],
    execute: async () => { executed = true; return { status: 'done', result: {} }; } });
  await expect(queued.runNext(1)).rejects.toThrow('임대');
  expect(executed).toBe(false);
  expect(server.calls.some(call => call.operation === 'startJob' || call.operation === 'finishJob')).toBe(false);
});

test('CLI가 정상 종료해도 모르는 분석 JSON을 성공으로 꾸미지 않는다', { timeout: 10_000 }, async () => {
  const job = { ...bootstrapJob(), ...lease() };
  const { app, server } = await setup(job);
  await writeFile(app.bins.codex, '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => { console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"{}"}})); console.log(JSON.stringify({type:"turn.completed"})); });\n', { mode: 0o700 });
  await expect.poll(() => server.finished.has(job.id), { timeout: 6000 }).toBe(true);
  expect(server.finished.get(job.id)).toMatchObject({ status: 'failed' });
  expect(server.calls.some(call => call.operation === 'submitTechProposals')).toBe(false);
  expect(await app.paidCalls.used()).toBe(1);
});
