// 시도 흐름 실제 연결(collect·execution.prepare) 시나리오.
// - 같은 계정: 실제 GitRepository·작업 폴더 준비·결과 수집·①(fake 명령)·가짜 GitHub·실제 CI 실행기로 claim→prepare→세션→①→collect→QA→②→병합→done.
// - 전용 계정(host): 이 PC에 래퍼(/usr/local/libexec/awbs-agent-exec)와 awbs-agent 계정이 있으면 같은 흐름을 실제 래퍼·사용자 scope로 한 번 돈다.
//   fake CLI는 래퍼 ci-run(Agent 계정, 고정 PATH의 node)으로 띄운다. 유료 호출·sudo 비밀번호·네트워크 없음.
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { Runner } from '../../../../agent-runner/src/api/runner.ts';
import { Execution, type ExecutionOptions } from '../../../../agent-runner/src/exec/session.ts';
import { AttemptFlow } from '../../../../agent-runner/src/jobs/attempt-flow.ts';
import { bindTaskCheck } from '../../../../agent-runner/src/jobs/task-check.ts';
import { bindCollect, FORMAT_FAILURE } from '../../../../agent-runner/src/jobs/collect.ts';
import { attemptWiring } from '../../../../agent-runner/src/jobs/wiring.ts';
import { CiJobs } from '../../../../agent-runner/src/ci/jobs.ts';
import { ciLaunch } from '../../../../agent-runner/src/ci/launch.ts';
import { GitRepository } from '../../../../agent-runner/src/git/repository.ts';
import { wrapperAgentEvidence, wrapperAgentFiles, wrapperAgentGit } from '../../../../agent-runner/src/git/agent-git.ts';
import { AGENT_EXEC, AGENT_ROOT, AGENT_USER, dedicatedCommand } from '../../../../agent-runner/src/cli/dedicated-user.ts';
import { withUserScope } from '../../../../agent-runner/src/exec/scope.ts';
import type { IsolationLayer } from '../../../../agent-runner/src/cli/isolation.ts';
import { fixture, file, commit, git } from '../../../../agent-runner/test/ci/int-fixture.ts';
import { HeavySemaphore } from '../../../../agent-runner/src/resources/heavy.ts';
import { ResourceReporter } from '../../../../agent-runner/src/resources/reporter.ts';
import { State } from '../../../../agent-runner/src/state/state.ts';
import { AGENT_CLI_SCRIPT, installAgentCli, type AgentScenario } from '../../../../agent-runner/test/fakes/agent-cli.ts';
import { scenario } from './scenario.ts';

const WRAPPER_SOURCE = join(import.meta.dirname, '../../../../agent-runner/scripts/isolation/awbs-agent-exec.sh');
const agentInstalled = spawnSync('id', ['-u', AGENT_USER]).status === 0 && existsSync(AGENT_EXEC);
/** 설치된 래퍼가 저장소의 지금 래퍼와 같으면 실제 Agent 계정으로, 다르면 새 래퍼 사본(같은 계정 fake sudo)으로 돈다. */
const wrapperCurrent = agentInstalled && readFileSync(AGENT_EXEC, 'utf8') === readFileSync(WRAPPER_SOURCE, 'utf8');
const scopeWorks = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '/bin/true'], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: `/run/user/${String(process.getuid?.())}` } }).status === 0;

type Harness = Awaited<ReturnType<typeof setup>>;
let current: Harness | undefined;
afterEach(async () => { await current?.close(); current = undefined; });

/** host: 전용 계정 경로. 아니면 같은 계정(Agent도 Runner 계정, fake-only 격리). */
async function setup(options: { host?: 'account' | 'copy'; claude?: Partial<AgentScenario>; codex?: Partial<AgentScenario> } = {}) {
  const f = await fixture('agent/TASK-0001-h1');
  await file(join(f.source, 'prototype/docs/guide.md'), '시나리오 입력');
  commit(f.source); git(f.source, 'push', f.remote, 'main');
  // fixture가 만든 Task 브랜치는 이 시도와 이력이 다르다. 시도가 처음 push하는 브랜치가 되도록 원격에서 지운다.
  git(f.remote, 'update-ref', '-d', `refs/heads/${f.request.branch}`);
  const h = await scenario({ inputCommit: f.ref('main') });
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'wiring-'));
  const state = await State.open(home);
  await state.update(draft => { draft.epoch = 1; draft.runnerId = 'm209-fake'; });
  const runner = new Runner({ state, api: h.runner.api, version: 'wiring-fake' });
  await runner.poll();
  const identity = { hostId: h.runner.hostId, bootId: h.runner.bootId };
  const heavy = new HeavySemaphore(1);
  const reporter = new ResourceReporter({ api: h.runner.api, epoch: () => 1, heavy });
  await reporter.reportHost({ ...identity, cpu: 'fake', cores: 20, memGB: 32, swapGB: 0, diskFreeGB: 100, os: 'fake' });
  heavy.resize(1);

  // 저장소·격리·fake CLI 위치는 배치마다 다르다.
  let repo: GitRepository, isolation: IsolationLayer, binaries: ExecutionOptions['binaries'];
  let calls: (agent: 'claude' | 'codex') => { argv: string[]; cwd: string; stdin: string }[];
  let cleanupHost: () => Promise<void> = async () => undefined;
  const scenarios = { claude: { agent: 'claude' as const, ...options.claude }, codex: { agent: 'codex' as const, ...options.codex } };
  let agentFiles: ExecutionOptions['agentFiles'];
  let agentRoot: string | null = null;
  if (options.host) {
    const id = `host-e2e-${randomUUID().slice(0, 8)}`;
    // account: 설치된 래퍼 + 실제 sudoers 규칙(awbs-agent). copy: 새 래퍼 사본 + 같은 계정 fake sudo(계정 전환만 대신, dedicated-scope.host.ts와 같은 방법).
    let cfg: { user: string; root: string; exec: string; sudo?: string };
    if (options.host === 'account') cfg = { user: AGENT_USER, root: AGENT_ROOT, exec: AGENT_EXEC };
    else {
      const me = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
      const area = join(home, 'srv');
      for (const d of ['worktrees', 'inputs', 'cli']) await mkdir(join(area, d), { recursive: true });
      const conf = join(home, 'agent-exec.conf');
      await writeFile(conf, `AGENT_USER=${me}\nRUNNER_USER=${me}\nRUNNER_HOME=${join(home, 'no-runner-home')}\nAGENT_ROOT=${area}\nNODE_DIR=${dirname(process.execPath)}\n`);
      const exec = join(home, 'awbs-agent-exec');
      await writeFile(exec, readFileSync(WRAPPER_SOURCE, 'utf8').replace('\nCONF=/etc/agentwbs/agent-exec.conf\n', `\nCONF=${conf}\n`)); await chmod(exec, 0o755);
      const sudo = join(home, 'fake-sudo');
      await writeFile(sudo, '#!/bin/bash\n[[ $1 == -n && $2 == -u && $4 == -- ]] || exit 9\nshift 4\nexec env -i "$@"\n'); await chmod(sudo, 0o755);
      cfg = { user: me, root: area, exec, sudo };
    }
    agentRoot = cfg.root;
    const wrapper = { user: cfg.user, exec: cfg.exec, ...(cfg.sudo && { sudo: cfg.sudo }) };
    repo = await GitRepository.clone(join(home, 'runner'), id, f.remote, { agentRoot: cfg.root,
      // copy: 래퍼 사본의 git-inspect·git-bundle·evidence-read를 쓰게 직접 넘긴다(기본값은 고정 작업 영역일 때만 실제 래퍼다).
      ...(options.host === 'copy' && { restorePermissions: null, agentGit: wrapperAgentGit(wrapper), agentEvidence: wrapperAgentEvidence(wrapper) }) });
    agentFiles = wrapperAgentFiles(wrapper);
    // fake CLI와 시나리오는 Agent 계정이 읽을 수 있는 곳(입력 사본 모음, Agent는 읽기만)에 둔다.
    const fakeDir = join(cfg.root, 'inputs', `${id}-fake`);
    await mkdir(fakeDir, { mode: 0o750 });
    await copyFile(AGENT_CLI_SCRIPT, join(fakeDir, 'agent-cli.mjs'));
    for (const [name, value] of Object.entries(scenarios)) await writeFile(join(fakeDir, `${name}.json`), JSON.stringify(value), { mode: 0o640 });
    await chmod(join(fakeDir, 'agent-cli.mjs'), 0o640);
    const real = (path: string) => realpathSync.native(path);
    // 세션도 래퍼 ci-run(Agent 계정)으로 띄운다. 래퍼 run은 실제 CLI 진입점만 받으므로 fake는 이 길로만 돈다(조정자 결정 4).
    isolation = withUserScope({ name: 'host-fake-cli', flags: () => [],
      wrap: launch => dedicatedCommand(cfg, { ...launch, file: 'node', args: [join(fakeDir, 'agent-cli.mjs'), join(fakeDir, `${basename(launch.file)}.json`), ...launch.args], env: {} }, real),
      command: launch => dedicatedCommand(cfg, launch, real) });
    binaries = { Claude: '/fake/claude', Codex: '/fake/codex' };
    calls = () => [];
    cleanupHost = async () => {
      for (const name of await repo.recordedWorktrees().catch(() => [])) await repo.removeWorktree(name).catch(() => undefined);
      for (const name of await repo.inputIds().catch(() => [])) await repo.removeInput(name).catch(() => undefined);
      await rm(join(cfg.root, 'worktrees', id), { recursive: true, force: true });
      await rm(join(cfg.root, 'inputs', id), { recursive: true, force: true });
      await rm(fakeDir, { recursive: true, force: true });
    };
  } else {
    repo = f.repo;
    isolation = { name: 'fake-only', flags: () => [], wrap: launch => launch };
    const claude = installAgentCli(join(home, 'fake'), scenarios.claude), codex = installAgentCli(join(home, 'fake'), scenarios.codex);
    binaries = { Claude: claude.path, Codex: codex.path };
    calls = agent => (agent === 'claude' ? claude : codex).calls();
  }

  const wiring = attemptWiring({ home, agentRoot, repoUrl: 'https://github.com/fake/runner', api: h.runner.api,
    epoch: () => 1, warn: () => undefined, env: {}, repo: async () => repo, ...(options.host && { sessionHome: true }) });
  const executionOptions: ExecutionOptions = {
    home, identity, api: h.runner.api, outbox: runner.outbox, epoch: () => 1, ready: () => runner.ready, env: { PATH: process.env.PATH },
    binaries, budget: () => 0, sessions: [], heavy, canStart: (agent, slots, sessions) => reporter.canStart(agent, slots, sessions),
    isolation, ...(agentFiles && { agentFiles }), ...wiring.execution,
  };
  const execution = new Execution(executionOptions);
  await execution.recover();
  const jobs = wiring.jobs;
  if (!jobs || typeof jobs.collect === 'function' || typeof jobs.taskCheck === 'function') throw new Error('공급원 모양이 아닙니다.');
  const shared = { api: h.runner.api, runner, execution };
  const errors: unknown[] = [];
  const check = bindTaskCheck({ ...jobs.taskCheck, ...shared, github: f.deps.github, collectTests: f.deps.collectTests,
    launch: (_argv, cwd) => ciLaunch([options.host ? 'node' : process.execPath, '-e', '0'], cwd, {}) });
  const flow = new AttemptFlow({ ...shared, epoch: () => 1, identity, onError: error => errors.push(error),
    collect: bindCollect({ ...jobs.collect, ...shared }),
    // ① 명령은 pipeline의 fake argv 대신 통과하는 명령(node -e 0)으로 바꾼다. 래퍼 ci-run은 고정 PATH의 실행 파일만 받는다(셸 내장 true는 안 됨). 실행 경로(Execution.command → 격리 command)는 그대로다.
    taskCheck: async context => {
      const result = await check(context);
      // 실패하면 단계별 기록을 시험 출력에 남긴다(원인 확인용).
      if (result.status !== 'pass') errors.push({ failStep: result.failStep, steps: result.steps.filter(step => step.status === 'fail') });
      return result;
    },
    ...(jobs.settle && { settle: jobs.settle }) });
  const ci = new CiJobs({ ...f.deps, heavy, directory: join(home, 'ci-jobs'), api: h.runner.api, outbox: runner.outbox,
    runnerId: state.snapshot.runnerId, epoch: () => 1, ready: () => runner.ready, identity, execute: (_job, argv, cwd) => f.deps.execute(argv, cwd), warn: () => undefined });
  const harness = { f, h, home, repo, runner, execution, flow, ci, calls, errors,
    status: async () => (await h.lead('GET', '/api/tasks/TASK-0001')).body.lifecycleStatus as string,
    close: async () => {
      await ci.shutdown(); await flow.shutdown(); await state.close();
      // 입력 사본은 읽기 전용(0555)이라 일반 rm으로 지울 수 없다. 저장소의 삭제 경로로 지운다.
      for (const name of await repo.inputIds().catch(() => [])) await repo.removeInput(name).catch(() => undefined);
      await cleanupHost(); await h.close(); await f.close(); await rm(home, { recursive: true, force: true });
    } };
  current = harness;
  return harness;
}

/** dev → QA PASS → ② → 병합 → done을 끝까지 돌리고 남은 것이 없는지 본다. */
async function fullFlow(t: Harness) {
  expect((await t.h.run('TASK-0001')).status).toBe(202);
  expect((await t.flow.runNext(20))?.payload).toMatchObject({ kind: 'dev', agent: 'Claude' });
  // 개발 결과: Agent가 작업 폴더에서 커밋한 것을 ①이 bundle로 가져와 검사·push했다. 변경 파일은 git diff다.
  const head = t.f.ref(t.f.request.branch);
  expect(await t.h.rows("select kind,status,pr from task_attempts order by attempt_no")).toEqual([{ kind: 'dev', status: 'completed', pr: 1 }]);
  expect(await t.h.rows('select path from attempt_files')).toEqual([{ path: 'src/result.ts' }]);
  expect(await t.h.rows("select kind from evidence order by created_at")).toEqual([{ kind: 'dev-report' }]);
  expect(await t.h.rows('select head_sha,status from ci_runs where stage=1')).toEqual([{ head_sha: head, status: 'pass' }]);
  expect((await t.flow.runNext(20))?.payload).toMatchObject({ kind: 'qa', agent: 'Codex' });
  expect(await t.status()).toBe('gate');
  // QA 근거 고정: 준비 때의 headSha(①이 검사한 커밋)와 지시문의 명세 버전.
  expect(await t.h.rows('select v.result,v.head_sha,v.spec_revision from verifications v')).toEqual([{ result: 'PASS', head_sha: head, spec_revision: 1 }]);
  // QA 증거: 보고 JSON과, QA가 .awbs-evidence/에 남긴 파일(Agent 계정으로 받아 올림)이 체크리스트 항목에 연결됐다.
  expect(await t.h.rows("select kind,size::int size from evidence where kind<>'dev-report' order by kind")).toEqual([{ kind: 'agent-evidence', size: Buffer.byteLength('검사 결과 PASS\n') }, { kind: 'qa-report', size: expect.any(Number) }]);
  const [agentEvidence] = await t.h.rows("select id from evidence where kind='agent-evidence'") as { id: string }[];
  expect(JSON.stringify(await t.h.rows("select evidence from checklist_items c join tasks t on t.id=c.task where t.task_key='TASK-0001'"))).toContain(agentEvidence?.id);
  expect(await t.h.rows("select item_key,done from checklist_items c join tasks t on t.id=c.task where t.task_key='TASK-0001'")).toEqual([{ item_key: 'CL-1', done: true }]);
  expect(await t.flow.runNext(20)).toBeNull();
  const outcome = await t.ci.runNext(20);
  expect(outcome?.result).toMatchObject({ kind: 'merged', qaHeadSha: head });
  await t.runner.outbox.flush();
  expect(await t.status()).toBe('done');
  expect(await t.h.rows('select count(*)::int n from execution_holds where closed_at is null')).toEqual([{ n: 0 }]);
  // 정리: QA PASS를 보고한 뒤 개발·검증 폴더를 모두 지웠다. ① 검사 사본도 남지 않는다.
  expect(await t.repo.recordedWorktrees()).toEqual([]);
  expect(t.errors).toEqual([]);
  return head;
}

describe('같은 계정 배치', () => {
  test('실제 prepare·collect로 claim→prepare→세션→①→collect→QA→②→병합→done', async () => {
    const t = await setup();
    await fullFlow(t);
    const [dev] = t.calls('claude'), [qa] = t.calls('codex');
    expect(dev?.cwd).toMatch(/\/w-[0-9a-f]{20}-dev$/);
    expect(qa?.cwd).toMatch(/\/w-[0-9a-f]{20}-qa$/);
    // 지시문에 입력 사본 위치·종료 메시지 형식·체크리스트 키가 들어갔다.
    expect(dev?.stdin).toContain('[Runner 안내]');
    expect(dev?.stdin).toMatch(/입력 문서\(prototype\/\) 읽기 전용 사본: \/.+\/in-v1-[0-9a-f]{12}/);
    expect(qa?.stdin).toContain('CL-1=수용 기준 확인');
  }, 90_000);

  test('형식 오류는 같은 세션에 한 번만 수정 요청하고(슬롯 재획득·반환) 고친 결과로 진행한다', async () => {
    const t = await setup({ claude: { devInvalidFirst: true } });
    expect((await t.h.run('TASK-0001')).status).toBe(202);
    await t.flow.runNext(20);
    const calls = t.calls('claude');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.argv).toEqual(expect.arrayContaining(['--resume', 'fake-session-0001']));
    expect(calls[1]?.cwd).toBe(calls[0]?.cwd);
    expect(calls[1]?.stdin).toContain('한 번뿐인 수정 요청');
    expect(await t.h.rows("select kind,status,summary from task_attempts")).toEqual([{ kind: 'dev', status: 'completed', summary: '형식을 고쳐 다시 냅니다' }]);
    expect(await t.h.rows("select count(*)::int n from runner_jobs where payload->>'kind'='qa'")).toEqual([{ n: 1 }]);
    expect(await t.h.rows('select count(*)::int n from execution_holds where closed_at is null and slot_state<>$$none$$')).toEqual([{ n: 0 }]);
  }, 60_000);

  test('수정 요청 뒤에도 형식이 틀리면 개발 시도를 실패로 보고하고 더 묻지 않는다', async () => {
    const t = await setup({ claude: { devInvalidFirst: true, fixInvalid: true } });
    expect((await t.h.run('TASK-0001')).status).toBe(202);
    await t.flow.runNext(20);
    expect(t.calls('claude')).toHaveLength(2);
    expect(await t.h.rows("select status,failure->>'reason' reason from task_attempts")).toEqual([{ status: 'failed', reason: FORMAT_FAILURE }]);
    expect(await t.h.rows('select kind from evidence')).toEqual([{ kind: 'agent-output-invalid' }]);
    expect(await t.h.rows("select count(*)::int n from runner_jobs where payload->>'kind'='qa'")).toEqual([{ n: 0 }]);
  }, 60_000);

  test('QA가 작업 폴더를 더럽히면 판정을 지어내지 않고 시도를 중단한다', async () => {
    const t = await setup({ codex: { qaDirty: true } });
    expect((await t.h.run('TASK-0001')).status).toBe(202);
    await t.flow.runNext(20);
    await expect(t.flow.runNext(20)).rejects.toThrow('커밋하지 않은 변경');
    expect(await t.h.rows('select kind,status from task_attempts order by attempt_no')).toEqual([{ kind: 'dev', status: 'completed' }, { kind: 'qa', status: 'interrupted' }]);
    expect(await t.h.rows('select count(*)::int n from verifications')).toEqual([{ n: 0 }]);
    expect(await t.status()).toBe('paused');
  }, 60_000);

  test('QA FAIL 뒤 재작업은 같은 개발 폴더를 다시 쓰고, 재검증은 새 커밋으로 검증 폴더를 다시 만든다', async () => {
    const t = await setup({ codex: { qaVerdict: 'FAIL' } });
    expect((await t.h.run('TASK-0001')).status).toBe(202);
    await t.flow.runNext(20);
    const first = t.f.ref(t.f.request.branch);
    expect((await t.flow.runNext(20))?.payload).toMatchObject({ kind: 'qa' });
    installAgentCli(join(t.home, 'fake'), { agent: 'codex', qaVerdict: 'PASS' });
    expect((await t.flow.runNext(20))?.payload).toMatchObject({ kind: 'rework' });
    const second = t.f.ref(t.f.request.branch);
    expect(second).not.toBe(first);
    expect(git(t.f.remote, 'rev-parse', `${second}^`)).toBe(first);
    expect((await t.flow.runNext(20))?.payload).toMatchObject({ kind: 'reverify' });
    const dev = t.calls('claude');
    expect(dev.map(c => c.cwd)).toEqual([dev[0]?.cwd, dev[0]?.cwd]);
    expect(await t.h.rows('select kind,head_sha from task_attempts order by attempt_no')).toEqual([
      { kind: 'dev', head_sha: first }, { kind: 'qa', head_sha: first }, { kind: 'rework', head_sha: second }, { kind: 'reverify', head_sha: second }]);
    expect(await t.status()).toBe('gate');
    expect(await t.repo.recordedWorktrees()).toEqual([]);
  }, 90_000);
});

describe.skipIf(!scopeWorks)('전용 계정 배치(host: 래퍼·사용자 scope)', () => {
  // 설치된 래퍼가 지금 래퍼와 다르면(owner가 설치 스크립트를 다시 돌리기 전) 실제 계정 경로는 돌 수 없다. 그때는 새 래퍼 사본으로 돈다.
  const mode = agentInstalled && wrapperCurrent ? 'account' : 'copy';
  test(`래퍼 경로(${mode === 'account' ? '실제 Agent 계정' : '새 래퍼 사본·같은 계정'})로 claim→prepare→세션→①→collect→QA→②→병합→done을 한 번 돈다`, async () => {
    const t = await setup({ host: mode });
    t.flow.runNext = (orig => async (...args: Parameters<typeof orig>) => {
      try { return await orig(...args); } catch (error) { throw new Error(`${String(error)} ${JSON.stringify(t.errors)}`, { cause: error }); }
    })(t.flow.runNext.bind(t.flow));
    await fullFlow(t);
    // 보유가 모두 닫혔다는 것은 세션·① 명령마다 서버가 기록한 cgroup이 비었음(cgroup_empty)을 Runner가 확인했다는 뜻이다.
  }, 180_000);
});
