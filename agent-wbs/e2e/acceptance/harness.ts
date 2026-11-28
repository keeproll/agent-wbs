import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createPool, runMigrations, seedSystem } from '../../packages/db/src/index.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { issueRunnerToken } from '../../apps/api/src/platform/credentials.ts';
import { installRunner } from '../../apps/api/src/runner/routes.ts';
import { registerRunnerMessageRoutes } from '../../apps/api/src/messages/routes.ts';
import { installProjectRunner } from '../../apps/api/src/project/runner-routes.ts';
import { installCiRunner } from '../../apps/api/src/ci/routes.ts';
import { FakeRunner } from '../fakes/runner.ts';
import { Runner } from '../../../agent-runner/src/api/runner.ts';
import { State } from '../../../agent-runner/src/state/state.ts';
import { Execution } from '../../../agent-runner/src/exec/session.ts';
import { AttemptFlow } from '../../../agent-runner/src/jobs/attempt-flow.ts';
import { attemptWiring } from '../../../agent-runner/src/jobs/wiring.ts';
import { bindCollect } from '../../../agent-runner/src/jobs/collect.ts';
import { bindTaskCheck } from '../../../agent-runner/src/jobs/task-check.ts';
import { CiJobs } from '../../../agent-runner/src/ci/jobs.ts';
import { ciLaunch } from '../../../agent-runner/src/ci/launch.ts';
import { HeavySemaphore } from '../../../agent-runner/src/resources/heavy.ts';
import { ResourceReporter } from '../../../agent-runner/src/resources/reporter.ts';
import { GitRepository } from '../../../agent-runner/src/git/repository.ts';
import { wrapperAgentEvidence, wrapperAgentFiles, wrapperAgentGit } from '../../../agent-runner/src/git/agent-git.ts';
import { dedicatedCommand } from '../../../agent-runner/src/cli/dedicated-user.ts';
import { PlanningCheckpoints, runPlanningJob } from '../../../agent-runner/src/planning/index.ts';
import type { DraftContent } from '../../../agent-runner/src/planning/agents.ts';
import { FakeAgent, draftContent } from '../../../agent-runner/test/planning/harness.ts';
import { fixture, file, commit, git } from '../../../agent-runner/test/ci/int-fixture.ts';
import { AGENT_CLI_SCRIPT } from '../../../agent-runner/test/fakes/agent-cli.ts';

const root = resolve(import.meta.dirname, '../..');

/** 제품 DB는 system seed·인증 초기값만 쓴다. 프로젝트 이후의 업무 데이터는 모두 HTTP로 만든다. */
export async function startAcceptance() {
  const dbUrl = process.env.DATABASE_URL;
  assert(dbUrl && new URL(dbUrl).pathname === '/awbs_test_m801', '인수 시험 전용 DB가 필요합니다.');
  const owner = createPool(dbUrl, { onError: () => undefined });
  await runMigrations(owner);
  await seedSystem(owner);
  const appUrl = new URL(dbUrl); appUrl.searchParams.set('options', '-c role=awbs_app');
  const pool = createPool(appUrl.href, { onError: () => undefined });
  const home = await mkdtemp(join(tmpdir(), 'awbs-acceptance-'));
  const password = `acceptance-${randomBytes(16).toString('base64url')}`;
  const origin = `http://127.0.0.1:${process.env.AWBS_E2E_PORT ?? ''}`;
  const app = buildApp(pool, false, { origin, lan: true }, { dataRoot: join(home, 'data') });
  installRunner(app, pool); registerRunnerMessageRoutes(app); installProjectRunner(app, pool); installCiRunner(app);
  await app.listen({ host: '127.0.0.2', port: Number(process.env.AWBS_PORT) });
  const token = await issueRunnerToken(pool, 'm209-fake', '무료 인수 시험 전용 공개키');
  const fake = new FakeRunner(process.env.AWBS_E2E_API ?? '', token);
  const write = () => ({ epoch: 1, idempotencyKey: randomUUID() });
  const f = await fixture('agent/TASK-0001-h1');
  await file(join(f.source, 'prototype/docs/guide.md'), '결과 파일을 만들고 자동 검사로 확인한다.\n');
  await file(join(f.source, 'prototype/uiux/index.html'), '<h1>인수 결과</h1>\n');
  await file(join(f.source, 'src/.gitkeep'), '');
  await file(join(f.source, 'contracts/.gitkeep'), '');
  commit(f.source); git(f.source, 'push', f.remote, 'main');
  git(f.remote, 'update-ref', '-d', `refs/heads/${f.request.branch}`);

  // 운영 래퍼의 사본을 사용한다. 계정 전환만 fake sudo가 대신한다(유료 CLI·운영 계정 변경 없음).
  // Runner는 Agent 작업 폴더에서 git을 실행하지 않는다. git-inspect·bundle·증거 읽기는 이 래퍼로 넘긴다.
  const area = join(home, 'agent');
  for (const dir of ['worktrees', 'inputs', 'cli']) await mkdir(join(area, dir), { recursive: true });
  const me = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
  const conf = join(home, 'agent-exec.conf'), wrapper = join(home, 'awbs-agent-exec'), sudo = join(home, 'fake-sudo');
  await writeFile(conf, `AGENT_USER=${me}\nRUNNER_USER=${me}\nRUNNER_HOME=${join(home, 'no-runner-home')}\nAGENT_ROOT=${area}\nNODE_DIR=${dirname(process.execPath)}\n`);
  await writeFile(wrapper, (await readFile(resolve(root, '../agent-runner/scripts/isolation/awbs-agent-exec.sh'), 'utf8')).replace('\nCONF=/etc/agentwbs/agent-exec.conf\n', `\nCONF=${conf}\n`));
  await writeFile(sudo, '#!/bin/bash\n[[ $1 == -n && $2 == -u && $4 == -- ]] || exit 9\nshift 4\nexec env -i "$@"\n');
  await chmod(wrapper, 0o755); await chmod(sudo, 0o755);
  const cfg = { user: me, root: area, exec: wrapper, sudo };
  const agent = { user: me, exec: wrapper, sudo };
  const repo = await GitRepository.clone(join(home, 'runner'), 'acceptance', f.remote, {
    agentRoot: area, restorePermissions: null, agentGit: wrapperAgentGit(agent), agentEvidence: wrapperAgentEvidence(agent),
  });
  const fakeDir = join(area, 'inputs', 'fake'); await mkdir(fakeDir);
  await writeFile(join(fakeDir, 'agent-cli.mjs'), await readFile(AGENT_CLI_SCRIPT));
  const qa = (verdict: 'PASS' | 'FAIL') => writeFile(join(fakeDir, 'codex.json'), JSON.stringify({ agent: 'codex', qaVerdict: verdict }));
  await qa('FAIL'); await writeFile(join(fakeDir, 'claude.json'), JSON.stringify({ agent: 'claude' }));
  const state = await State.open(join(home, 'state'));
  await state.update(d => { d.epoch = 1; d.runnerId = 'm209-fake'; });
  const runner = new Runner({ state, api: fake.api, version: 'acceptance-fake' });
  const heavy = new HeavySemaphore(1);
  const resources = new ResourceReporter({ api: fake.api, epoch: () => 1, heavy });
  const identity = { hostId: fake.hostId, bootId: fake.bootId };
  const wiring = attemptWiring({ home, agentRoot: area, repoUrl: 'https://github.com/o/r', api: fake.api, epoch: () => 1,
    warn: () => undefined, env: {}, repo: async () => repo, sessionHome: true });
  const execution = new Execution({ home, identity, api: fake.api, outbox: runner.outbox, epoch: () => 1, ready: () => runner.ready,
    env: { PATH: process.env.PATH }, binaries: { Claude: '/fake/claude', Codex: '/fake/codex' }, budget: () => 0, sessions: [], heavy,
    canStart: (a, slots, sessions) => resources.canStart(a, slots, sessions), agentFiles: wrapperAgentFiles(agent),
    isolation: { name: 'acceptance-wrapper', flags: () => [],
      wrap: launch => dedicatedCommand(cfg, { ...launch, file: 'node', args: [join(fakeDir, 'agent-cli.mjs'), join(fakeDir, `${basename(launch.file)}.json`), ...launch.args], env: {} }, p => realpathSync.native(p)),
      command: launch => dedicatedCommand(cfg, launch, p => realpathSync.native(p)) }, ...wiring.execution });
  await execution.recover();
  const jobs = wiring.jobs;
  assert(jobs && typeof jobs.collect !== 'function' && typeof jobs.taskCheck !== 'function');
  const shared = { api: fake.api, runner, execution };
  const flowErrors: unknown[] = [];
  const check = bindTaskCheck({ ...jobs.taskCheck, ...shared, github: f.client, collectTests: f.deps.collectTests,
    launch: (_argv, cwd) => ciLaunch(['node', '-e', '0'], cwd, {}) });
  const flow = new AttemptFlow({ ...shared, epoch: () => 1, identity, onError: e => flowErrors.push(e),
    collect: bindCollect({ ...jobs.collect, ...shared }), taskCheck: check, ...(jobs.settle && { settle: jobs.settle }) });
  const ci = new CiJobs({ ...f.deps, repo, heavy, directory: join(home, 'ci'), api: fake.api, outbox: runner.outbox,
    runnerId: 'm209-fake', epoch: () => 1, ready: () => runner.ready, identity,
    execute: (_job, argv, cwd) => f.deps.execute(argv, cwd), warn: () => undefined });

  const claude = new FakeAgent('Claude'), codex = new FakeAgent('Codex');
  claude.draft = async () => {
    const draft: DraftContent = draftContent();
    for (const [i, task] of draft.tasks.entries()) {
      task.title = i === 0 ? '인수 결과 파일 구현' : '후속 문서 정리';
      task.outputs = [{ name: 'src/result.ts', kind: '파일', required: true, verify: '자동 테스트', delivered: false }];
      task.grades = { dev: { modelId: 'claude-sonnet-5-5', effort: 'high', reason: '무료 인수 시험' }, qa: { modelId: 'gpt-6.1-sol', effort: 'high', reason: '독립 검증' } };
    }
    return draft;
  };
  const checkpoints = await PlanningCheckpoints.open(join(home, 'planning'));
  const heartbeat = () => fake.api('heartbeat', { ...write(), body: { runnerId: 'm209-fake', version: 'acceptance-fake', epoch: 1 } });
  const claim = async (kind: 'repo_check' | 'bootstrap') => {
    await heartbeat();
    const result = await fake.api('claimJob', { ...write(), body: { kinds: [kind], capacity: 1 } });
    assert.equal(result.status, 200, `${kind} 작업이 없습니다.`);
    return result.body.job;
  };
  return {
    password,
    configurePassword: async () => {
      execFileSync(process.execPath, ['--conditions=awbs-source', 'apps/api/src/platform/auth-cli.ts', 'set-password'], {
        cwd: root, env: { ...process.env, AWBS_HOST: '127.0.0.2', AWBS_ALLOW_LAN: 'true', AWBS_ORIGIN: origin }, input: `${password}\n`, stdio: ['pipe', 'ignore', 'pipe'],
      });
    },
    counts: async () => {
      const row = (await owner.query<{ projects: number; tasks: number; attempts: number; reports: number }>(`select
      (select count(*)::int from projects) projects,(select count(*)::int from tasks) tasks,
      (select count(*)::int from task_attempts) attempts,(select count(*)::int from reports) reports`)).rows[0];
      assert(row); return row;
    },
    connect: async () => {
      await fake.initialize();
      await resources.reportHost({ ...identity, cpu: 'fake', cores: 20, memGB: 32, swapGB: 0, diskFreeGB: 100, os: 'fake' });
      heavy.resize(1); await runner.poll();
      await fake.api('reportGithubStatus', { ...write(), body: { mode: 'gh', ok: true, account: '무료 시험 계정', scopes: { contents: 'verified', pulls: 'verified', statuses: 'verified', metadata: 'verified' }, expiresAt: null } });
    },
    repoCheck: async () => {
      const job = await claim('repo_check'); assert(job.kind === 'repo_check');
      await fake.api('reportRepoCheck', { ...write(), params: { id: job.payload.repoCheckId }, body: { fence: job.fence, access: true, private: true, commit: f.ref('main'),
        structure: { uiux: true, uiuxFiles: 1, docs: ['prototype/docs/guide.md'], src: true, contracts: true, agentwbs: true } } });
    },
    planning: async () => {
      const job = await claim('bootstrap'); assert(job.kind === 'bootstrap');
      const outcome = await runPlanningJob(job, { api: fake.api, epoch: 1, runnerId: 'm209-fake', checkpoints, agents: { Claude: claude, Codex: codex },
        workspace: {
          fixCommit: async sha => { assert.equal(await repo.fetch(), sha); return { note: '로컬 fake GitHub main 커밋 확인' }; },
          checkoutInput: async (name, sha) => ({ path: await repo.inputPath(name) ?? await repo.checkoutInput(name, sha), note: '입력 문서 읽기 전용 사본' }),
          prepareWork: async sha => {
            const dirs = git(repo.path, 'ls-tree', '-d', '--name-only', sha).split('\n');
            for (const dir of ['src', 'contracts', '.agentwbs']) assert(dirs.includes(dir), `기존 저장소의 ${dir} 경로가 없습니다.`);
            return { note: 'clone된 기존 저장소의 src·contracts·pipeline 준비 확인' };
          },
          diff: async (from, to) => (await repo.inputObservation(from, to)).changes,
        } });
      assert(outcome.status !== 'lost', JSON.stringify(outcome));
      await fake.api('finishJob', { ...write(), params: { id: job.id }, body: outcome.status === 'done'
        ? { fence: job.fence, status: 'done', result: outcome.result } : { fence: job.fence, status: 'failed', error: outcome.error } });
      await fake.api('releaseJob', { ...write(), params: { id: job.id }, body: { fence: job.fence, hostId: fake.hostId, proof: { kind: 'no_process', bootId: fake.bootId }, at: new Date().toISOString() } });
      assert.equal(outcome.status, 'done', JSON.stringify(outcome));
      return outcome;
    },
    qaPass: () => qa('PASS'),
    attempt: async () => {
      await heartbeat(); await runner.poll();
      const result = await flow.runNext(20);
      assert.deepEqual(flowErrors, [], flowErrors.map(String).join('\n'));
      assert(result?.kind === 'attempt', '실행할 시도 작업이 없습니다.');
      return result?.payload.kind;
    },
    integrate: async () => {
      await heartbeat(); await runner.poll(); const outcome = await ci.runNext(20); await runner.outbox.flush(); return outcome?.result?.kind;
    },
    merged: () => f.merged.size,
    openHolds: async () => (await owner.query<{ n: number }>('select count(*)::int n from execution_holds where closed_at is null')).rows[0]?.n,
    output: (name: string) => join(process.env.AWBS_ACCEPTANCE_OUT ?? home, name),
    close: async () => {
      await ci.shutdown(); await flow.shutdown(); await state.close();
      for (const id of await repo.inputIds()) await repo.removeInput(id);
      await app.close(); await pool.end(); await owner.end(); await f.close(); await rm(home, { recursive: true, force: true });
    },
  };
}
export type Acceptance = Awaited<ReturnType<typeof startAcceptance>>;
