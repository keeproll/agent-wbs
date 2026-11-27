import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Runner } from '../../../../agent-runner/src/api/runner.ts';
import { ApiTransportError } from '../../../../agent-runner/src/api/client.ts';
import { Execution, type ExecutionOptions } from '../../../../agent-runner/src/exec/session.ts';
import { AttemptFlow, finishJob, type AttemptFlowOptions } from '../../../../agent-runner/src/jobs/attempt-flow.ts';
import { bindTaskCheck } from '../../../../agent-runner/src/jobs/task-check.ts';
import { CiJobs } from '../../../../agent-runner/src/ci/jobs.ts';
import { parsePipeline } from '../../../../agent-runner/src/ci/pipeline.ts';
import { fixture, file, commit, git } from '../../../../agent-runner/test/ci/int-fixture.ts';
import { HeavySemaphore } from '../../../../agent-runner/src/resources/heavy.ts';
import { ResourceReporter } from '../../../../agent-runner/src/resources/reporter.ts';
import { State } from '../../../../agent-runner/src/state/state.ts';
import { installFakeCli, type Scenario as CliScenario } from '../../../../agent-runner/test/fakes/cli.ts';
import { HEAD, scenario, type Scenario } from './scenario.ts';

let h: Scenario;
let home: string;
let state: State;
let execution: Execution;
let flow: AttemptFlow;
let runner: Runner;
let options: AttemptFlowOptions;
let executionOptions: ExecutionOptions;
let f: Awaited<ReturnType<typeof fixture>>;
let head = HEAD;
let failCheckStep: string | undefined;
const checks: string[] = [];

function cli(result: 'PASS' | 'FAIL' = 'PASS', hang = false): CliScenario {
  const report = {
    summary: '가짜 CLI가 낸 결과', changedFiles: ['src/result.ts'], evidence: [],
    verification: { headSha: head, specRevision: 1, result, cmd: 'fake check', expected: '수용 기준 충족', actual: result,
      defects: result === 'FAIL' ? [{ text: '수용 기준 미충족', blocking: true }] : [], checklist: [{ itemKey: 'CL-1', done: result === 'PASS' }] },
  };
  return { hang, lines: [
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: JSON.stringify(report) }] } },
    { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report) },
  ] };
}

function codex(result: 'PASS' | 'FAIL' = 'PASS', hang = false): CliScenario {
  const data = cli(result);
  const text = (data.lines?.[1] as { result: string }).result;
  return { hang, lines: [
    { type: 'item.completed', item: { type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } },
  ] };
}

beforeEach(async () => {
  f = await fixture('agent/TASK-0001-h1');
  await file(join(f.source, 'prototype/docs/guide.md'), '시나리오 입력');
  commit(f.source); git(f.source, 'push', f.remote, 'main');
  head = f.ref(f.request.branch);
  h = await scenario({ inputCommit: f.ref('main') });
  home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'flow-'));
  const work = await f.repo.createWorktree('task', 'agent/m505-work', head);
  await file(join(work, 'src/result.ts'), 'export const result = true;\n');
  head = commit(work);
  state = await State.open(home);
  await state.update(draft => { draft.epoch = 1; draft.runnerId = 'm209-fake'; });
  runner = new Runner({ state, api: h.runner.api, version: 'm505-fake' });
  await runner.poll();
  const claude = installFakeCli(join(home, 'fake'), 'claude', cli());
  const cx = installFakeCli(join(home, 'fake'), 'codex', codex());
  const identity = { hostId: h.runner.hostId, bootId: h.runner.bootId };
  const heavy = new HeavySemaphore(1);
  const reporter = new ResourceReporter({ api: h.runner.api, epoch: () => 1, heavy });
  await reporter.reportHost({ ...identity, cpu: 'fake', cores: 20, memGB: 32, swapGB: 0, diskFreeGB: 100, os: 'fake' });
  heavy.resize(1);
  executionOptions = {
    home, identity, api: h.runner.api, outbox: runner.outbox,
    epoch: () => 1, ready: () => runner.ready, env: { PATH: process.env.PATH },
    binaries: { Claude: claude.path, Codex: cx.path },
    prepare: async () => ({ cwd: work, headSha: head }), budget: () => 0,
    sessions: [], heavy, canStart: (agent, slots, sessions) => reporter.canStart(agent, slots, sessions),
    isolation: { name: 'fake-only', flags: () => [], wrap: launch => launch },
  };
  execution = new Execution(executionOptions);
  await execution.recover();
  checks.length = 0;
  failCheckStep = undefined;
  let inputHead = f.ref('main');
  const taskCheck = bindTaskCheck({ get execution() { return execution; }, get runner() { return runner; }, api: h.runner.api, repo: f.repo, worktree: () => ({ id: 'task', branch: 'agent/m505-work' }),
    collectTests: f.deps.collectTests,
    // 실제 M4 GitHub 계층(가짜 GitHub 서버). Runner가 push 뒤 PR을 열고 번호를 ①·시도 결과로 보낸다(조정자 결정 1).
    github: f.deps.github,
    launch: (argv, cwd) => {
      const failed = argv[1] === failCheckStep;
      const command = installFakeCli(join(home, 'checks'), 'codex', { lines: [failed ? '검사 실패' : '검사 통과'], exitCode: failed ? 1 : 0 });
      return { file: command.path, args: [...argv.slice(1)], cwd, env: { PATH: process.env.PATH }, stdin: '' };
    },
    observeMainPipeline: async basis => {
      const pipeline = parsePipeline(basis.source);
      await h.runner.api('reportInputChanges', { epoch: 1, idempotencyKey: crypto.randomUUID(), body: {
        base: inputHead, head: basis.baseSha, ...await f.repo.inputObservation(inputHead, basis.baseSha),
        pipelineObservation: { baseSha: basis.baseSha, pipelineSha: basis.pipelineSha, definition: {
          path: '.agentwbs/pipeline.yaml', commit: basis.baseSha, status: 'ok', error: null, raw: basis.source,
          stages: Object.entries(pipeline.stages).map(([stage, steps]) => ({ stage: stage as 'task' | 'int' | 'night' | 'deploy', when: '시험', gate: '시험', steps: steps.map(s => s.name) })),
        } },
      } });
      inputHead = basis.baseSha;
    },
  });
  options = {
    execution, runner, api: h.runner.api, epoch: () => 1, identity,
    taskCheck: async context => {
      checks.push(context.job.payload.kind);
      const result = await taskCheck(context);
      expect(result.status, JSON.stringify(result)).toBe(failCheckStep ? 'fail' : 'pass');
      return result;
    },
    // 종료 JSON은 가짜 자료다. 변경 파일과 작업 폴더 청결은 실제 Git으로 확인한다.
    collect: async ({ job, output, messages }) => {
      const parsed = JSON.parse(output.text) as Awaited<ReturnType<AttemptFlowOptions['collect']>>['report'] & { verification: object };
      await f.repo.taskCheckPath('task', head);
      const base = git(f.repo.path, 'merge-base', f.ref('main'), head);
      const changedFiles = git(f.repo.path, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, head, '--').split('\0').filter(Boolean);
      const dev = { summary: parsed.summary, changedFiles, evidence: parsed.evidence };
      return { report: job.payload.kind === 'qa' || job.payload.kind === 'reverify' ? { ...parsed, changedFiles: [] } : dev,
        responses: messages.map(m => ({ messageId: m.id, text: '지시를 반영했습니다.', workState: '완료' })) };
    },
  };
  flow = new AttemptFlow(options);
});
afterEach(async () => {
  await flow?.shutdown();
  await state?.close();
  await h?.close();
  await f?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

test.each(['dev', 'qa', 'reverify'] as const)('시나리오 7: %s 중 보낸 지시는 다음 같은 Agent 실행에서만 전달·ack·업무 응답한다', async kind => {
  installFakeCli(join(home, 'fake'), 'codex', codex('FAIL'));
  const reached = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>();
  const collect = options.collect;
  let held = false;
  options.collect = async context => {
    if (context.job.payload.kind === kind && !held) { held = true; reached.resolve(undefined); await proceed.promise; }
    return collect(context);
  };
  expect((await h.run('TASK-0001')).status).toBe(202);
  const before = kind === 'dev' ? 0 : kind === 'qa' ? 1 : 3;
  for (let i = 0; i < before; i++) await flow.runNext(20);
  const running = flow.runNext(20);
  try {
    await Promise.race([reached.promise, running.then(() => { throw new Error('전달 대기 경계를 지나쳤습니다.'); })]);
    const agent = kind === 'dev' ? 'Claude' : 'Codex';
    const draft = await h.lead('POST', '/api/messages', { taskKey: 'TASK-0001', type: '추가 지시', toAgent: agent, body: '다음 실행에서 오류 설명을 한글로 작성해 주세요.' });
    expect(draft.status).toBe(201);
    const id = String(draft.body.id);
    expect((await h.lead('POST', `/api/messages/${id}/send`, { updatedAt: draft.body.updatedAt })).status).toBe(200);
    await runner.poll();
    expect(await h.message(id)).toMatchObject({ pendingNext: true, delivery: 'Sent', workState: null });
    expect(runner.messages.map(m => m.id)).toEqual([id]);
    proceed.resolve(undefined);
    await running;
    // 현재 실행은 새 지시를 받지 않는다. 대상이 다른 Agent인 다음 job도 수신 확인하지 않는다.
    await flow.runNext(20);
    expect(await h.message(id)).toMatchObject({ delivery: 'Sent', workState: null });
    const seen = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>();
    options.collect = async context => {
      expect(context.messages.map(m => m.id)).toEqual([id]);
      expect(context.output.ok).toBe(true);
      expect(await h.message(id)).toMatchObject({ delivery: 'Acknowledged', workState: null });
      expect((await h.lead('GET', '/api/tasks/TASK-0001')).body.lifecycleStatus).not.toBe('done');
      seen.resolve(undefined); await finish.promise;
      return collect(context);
    };
    const next = flow.runNext(20);
    try {
      await Promise.race([seen.promise, next.then(() => { throw new Error('응답 대기 경계를 지나쳤습니다.'); })]);
      const calls = (await readFile(join(home, 'fake', `${agent.toLowerCase()}.calls.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { stdin: string });
      expect(calls.at(-1)?.stdin).toContain(id);
      expect(calls.slice(0, -1).some(call => call.stdin.includes(id))).toBe(false);
    } finally { finish.resolve(undefined); await next; }
    expect(await h.message(id)).toMatchObject({ delivery: 'Acknowledged', workState: null });
    expect(await h.rows("select body,work_state from messages where dir='in'")).toEqual([{ body: '지시를 반영했습니다.', work_state: '완료' }]);
    expect(runner.messages).toEqual([]);
  } finally { proceed.resolve(undefined); await running.catch(() => undefined); }
}, 60_000);

test('시나리오 9: 실제 CLI 실행 중 재부팅 보고→보유 해제 전 재개 거부→대조→같은 등급 새 시도', async () => {
  const fake = installFakeCli(join(home, 'fake'), 'claude', cli('PASS', true));
  expect((await h.run('TASK-0001')).status).toBe(202);
  const running = flow.runNext(20);
  void running.catch(() => undefined);
  await expect.poll(() => fake.calls().length, { timeout: 10_000 }).toBe(1);
  const first = (await h.rows('select id,model_id,effort from task_attempts'))[0] as { id: string; model_id: string; effort: string };
  await h.runner.reboot();
  expect(await h.rows('select status from task_attempts')).toEqual([{ status: 'interrupted' }]);
  expect((await h.resume(first.id)).status).toBe(409);
  await flow.shutdown();
  await running.catch(() => undefined);
  const identity = { hostId: h.runner.hostId, bootId: h.runner.bootId };
  execution = new Execution({ ...executionOptions, identity });
  expect(await execution.recover()).toBe(true);
  flow = new AttemptFlow({ ...options, execution, identity });
  expect((await h.resume(first.id)).status).toBe(202);
  installFakeCli(join(home, 'fake'), 'claude', cli());
  await flow.runNext(20);
  const attempts = await h.rows('select id,status,model_id,effort,resumed_from from task_attempts order by attempt_no');
  expect(attempts).toMatchObject([
    { id: first.id, status: 'interrupted' },
    { status: 'completed', model_id: first.model_id, effort: first.effort, resumed_from: first.id },
  ]);
  expect(attempts[1]?.id).not.toBe(first.id);
}, 25_000);

test('M5-04 job 경계: 프로세스 없는 Planning finish 뒤 no_process로 모든 보유를 해제한다', async () => {
  await h.rows(`insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key)
    select id,'estimate','{"tasks":[],"policy":{}}','queued',1,'m505-estimate' from projects`);
  const claimed = await h.runner.api('claimJob', { epoch: 1, idempotencyKey: crypto.randomUUID(), body: { kinds: ['estimate'], capacity: 20 } });
  if (claimed.status !== 200) throw new Error('Planning job이 필요합니다.');
  const job = claimed.body.job;
  await h.runner.api('startJob', { epoch: 1, idempotencyKey: crypto.randomUUID(), params: { id: job.id }, body: { fence: job.fence, hostId: h.runner.hostId, bootId: h.runner.bootId, installedSubagents: [] } });
  await finishJob(options, job, { status: 'done' });
  expect(await h.rows('select state from runner_jobs')).toEqual([{ state: 'done' }]);
  expect(await h.rows('select slot_state,lock_state,release_proof from execution_holds')).toEqual([{ slot_state: 'none', lock_state: 'none', release_proof: 'no_process' }]);
  expect(await h.rows('select count(*)::int n from execution_holds where closed_at is null')).toEqual([{ n: 0 }]);
});

test('결과 응답을 잃어도 같은 멱등 키로 재전송해 QA와 결과를 한 번만 만든다', async () => {
  const api = options.api;
  const keys: string[] = [];
  options.api = async (operation, request) => {
    const response = await api(operation, request);
    if (operation === 'reportAttemptResult') {
      keys.push((request as { idempotencyKey: string }).idempotencyKey);
      if (keys.length === 1) throw new ApiTransportError(operation);
    }
    return response;
  };
  expect((await h.run('TASK-0001')).status).toBe(202);
  await flow.runNext(20);
  expect(keys.length).toBeGreaterThanOrEqual(2);
  expect(new Set(keys).size).toBe(1);
  await runner.outbox.flush();
  expect(await h.rows('select kind,status from task_attempts')).toEqual([{ kind: 'dev', status: 'completed' }]);
  expect(await h.rows("select count(*)::int n from runner_jobs where payload->>'kind'='qa'")).toEqual([{ n: 1 }]);
});

test('시작 직전 메시지를 다시 받아 정기 조회 사이에 보낸 지시도 이번 실행에 전달한다', async () => {
  const draft = await h.lead('POST', '/api/messages', { taskKey: 'TASK-0001', type: '추가 지시', toAgent: 'Claude', body: '시작 직전 지시입니다.' });
  const id = String(draft.body.id);
  expect((await h.lead('POST', `/api/messages/${id}/send`, { updatedAt: draft.body.updatedAt })).status).toBe(200);
  expect(runner.messages).toEqual([]);
  expect((await h.run('TASK-0001')).status).toBe(202);
  await flow.runNext(20);
  expect(await h.message(id)).toMatchObject({ delivery: 'Acknowledged' });
  expect(await h.rows("select body from messages where dir='in'")).toEqual([{ body: '지시를 반영했습니다.' }]);
});

test('긴 CLI 중에도 poll은 중단 job을 받고 그룹 종료를 기다린 뒤 완료한다', async () => {
  const fake = installFakeCli(join(home, 'fake'), 'claude', cli('PASS', true));
  expect((await h.run('TASK-0001')).status).toBe(202);
  await flow.poll(20);
  await expect.poll(() => fake.calls().length, { timeout: 10_000 }).toBe(1);
  const task = (await h.lead('GET', '/api/tasks/TASK-0001')).body;
  const attempt = (await h.lead('GET', '/api/tasks/TASK-0001/attempts')).body.items[0] as { id: string; updatedAt: string };
  expect((await h.lead('POST', `/api/attempts/${attempt.id}/stop`, { updatedAt: task.updatedAt, attemptUpdatedAt: attempt.updatedAt })).status).toBe(202);
  expect((await flow.runNext(20))?.kind).toBe('stop_attempt');
  expect(await h.rows('select status from task_attempts')).toEqual([{ status: 'interrupted' }]);
  expect(await h.rows("select state from runner_jobs where kind='stop_attempt'")).toEqual([{ state: 'done' }]);
  expect(await h.rows('select count(*)::int n from execution_holds where closed_at is null')).toEqual([{ n: 0 }]);
  expect(await execution.launches.list()).toEqual(expect.arrayContaining([expect.objectContaining({ completedAt: expect.any(String) })]));
});

test('start 응답을 기다리는 사이 받은 중단도 실제 CLI 허가 전에 반영한다', async () => {
  const started = Promise.withResolvers<undefined>(), allow = Promise.withResolvers<undefined>(), stoppingRead = Promise.withResolvers<undefined>();
  const api = executionOptions.api;
  executionOptions.api = async (operation, request) => {
    const response = await api(operation, request);
    if (operation === 'startJob') { started.resolve(undefined); await allow.promise; }
    return response;
  };
  const reports = options.api;
  options.api = async (operation, request) => {
    const response = await reports(operation, request);
    if (operation === 'getExecutionHolds') stoppingRead.resolve(undefined);
    return response;
  };
  expect((await h.run('TASK-0001')).status).toBe(202);
  const job = await execution.claim(20);
  if (!job) throw new Error('개발 job이 필요합니다.');
  const running = flow.run(job);
  void running.catch(() => undefined);
  let stopping: Promise<unknown> | undefined;
  try {
    await started.promise;
    const task = (await h.lead('GET', '/api/tasks/TASK-0001')).body;
    const attempt = (await h.lead('GET', '/api/tasks/TASK-0001/attempts')).body.items[0] as { id: string; updatedAt: string };
    expect((await h.lead('POST', `/api/attempts/${attempt.id}/stop`, { updatedAt: task.updatedAt, attemptUpdatedAt: attempt.updatedAt })).status).toBe(202);
    stopping = flow.runNext(20);
    await stoppingRead.promise;
    allow.resolve(undefined);
    await stopping;
    await running.catch(() => undefined);
    expect(await h.rows('select status from task_attempts')).toEqual([{ status: 'interrupted' }]);
    const calls = await readFile(join(home, 'fake', 'claude.calls.jsonl'), 'utf8');
    expect(calls).toBe('');
  } finally { allow.resolve(undefined); await running.catch(() => undefined); await stopping?.catch(() => undefined); }
});

test('① 공급원이 실패하면 결과와 다음 QA를 만들지 않고 종료 증거로 보유를 해제한다', async () => {
  options.taskCheck = async () => { throw new Error('① 검사 실패'); };
  expect((await h.run('TASK-0001')).status).toBe(202);
  await expect(flow.runNext(20)).rejects.toThrow('① 검사 실패');
  expect((await h.lead('GET', '/api/tasks/TASK-0001')).body.lifecycleStatus).toBe('paused');
  expect(await h.rows("select count(*)::int n from runner_jobs where payload->>'kind'='qa'")).toEqual([{ n: 0 }]);
  expect(await h.rows('select count(*)::int n from execution_holds where closed_at is null')).toEqual([{ n: 0 }]);
});

test('조정자 결정 3: 실제 ①의 Task 코드 실패는 failed와 자동 재작업으로 이어지고 재작업 횟수에 센다', async () => {
  failCheckStep = 'unit';
  expect((await h.run('TASK-0001')).status).toBe(202);
  await flow.runNext(20);
  expect((await h.lead('GET', '/api/tasks/TASK-0001')).body.lifecycleStatus).toBe('rework');
  expect(await h.rows('select status from task_attempts')).toEqual([{ status: 'failed' }]);
  expect(await h.rows("select status,fail_scope from ci_runs where stage=1")).toEqual([{ status: 'fail', fail_scope: 'task' }]);
  failCheckStep = undefined;
  expect((await flow.runNext(20))?.payload).toMatchObject({ kind: 'rework' });
  expect(await h.rows("select count(distinct j.payload->>'automaticCause')::int n from task_attempts a join runner_jobs j on j.id=a.job where a.kind='rework'")).toEqual([{ n: 1 }]);
});

test('조정자 결정 3: 실제 ①의 baseline 실패는 interrupted이며 재작업 없이 같은 종류·등급으로 재개한다', async () => {
  failCheckStep = 'install';
  expect((await h.run('TASK-0001')).status).toBe(202);
  await expect(flow.runNext(20)).rejects.toThrow('기준 또는 실행 환경');
  expect((await h.lead('GET', '/api/tasks/TASK-0001')).body.lifecycleStatus).toBe('paused');
  const first = (await h.rows('select id,model_id,effort,status from task_attempts'))[0] as { id: string; model_id: string; effort: string };
  expect(first).toMatchObject({ status: 'interrupted' });
  expect(await h.rows("select fail_scope from ci_runs where stage=1")).toEqual([{ fail_scope: 'baseline' }]);
  expect(await flow.runNext(20)).toBeNull();
  expect((await h.resume(first.id)).status).toBe(202);
  failCheckStep = undefined;
  await flow.runNext(20);
  expect(await h.rows("select kind,model_id,effort from task_attempts where resumed_from is not null")).toEqual([{ kind: 'dev', model_id: first.model_id, effort: first.effort }]);
  expect(await h.rows("select count(*)::int n from task_attempts where kind='rework'")).toEqual([{ n: 0 }]);
});

test.each(['process', 'collect', 'interrupt', 'qa-fail'] as const)('조정자 결정 4: %s 뒤 ack된 지시를 디스크에서 복구해 다음 시도에 다시 넣고 ack한다', async failure => {
  const agent = failure === 'qa-fail' ? 'Codex' : 'Claude';
  const collect = options.collect;
  expect((await h.run('TASK-0001')).status).toBe(202);
  if (failure === 'qa-fail') await flow.runNext(20);
  const draft = await h.lead('POST', '/api/messages', { taskKey: 'TASK-0001', type: '추가 지시', toAgent: agent, body: '실패해도 다음 시도에서 지켜야 하는 지시입니다.' });
  const id = String(draft.body.id);
  expect((await h.lead('POST', `/api/messages/${id}/send`, { updatedAt: draft.body.updatedAt })).status).toBe(200);
  if (failure === 'process') installFakeCli(join(home, 'fake'), 'claude', { ...cli(), exitCode: 1 });
  if (failure === 'qa-fail') installFakeCli(join(home, 'fake'), 'codex', codex('FAIL'));
  if (failure === 'collect') options.collect = async () => { throw new Error('결과 수집 실패'); };
  if (failure === 'interrupt') installFakeCli(join(home, 'fake'), 'claude', cli('PASS', true));
  const firstRun = flow.runNext(20);
  void firstRun.catch(() => undefined);
  if (failure === 'interrupt') {
    await expect.poll(async () => (await h.message(id)).delivery, { timeout: 10_000 }).toBe('Acknowledged');
    const first = (await h.rows('select id from task_attempts order by attempt_no desc limit 1'))[0] as { id: string };
    execution.stop(first.id);
  }
  if (failure === 'collect') await expect(firstRun).rejects.toThrow('결과 수집 실패');
  else await firstRun;
  expect(await h.message(id)).toMatchObject({ delivery: 'Acknowledged' });
  expect(runner.retainedMessages.map(m => m.id)).toEqual([id]);
  const first = (await h.rows('select id,status from task_attempts order by attempt_no desc limit 1'))[0] as { id: string; status: string };
  await flow.shutdown();
  await state.close();
  state = await State.open(home);
  let acknowledgements = 0;
  const api = h.runner.api;
  runner = new Runner({ state, version: 'm505-restarted', api: async (operation, request) => {
    if (operation === 'ackMessage') acknowledgements++;
    return api(operation, request);
  } });
  await runner.poll();
  executionOptions = { ...executionOptions, outbox: runner.outbox };
  execution = new Execution(executionOptions);
  await execution.recover();
  options.collect = collect;
  flow = new AttemptFlow({ ...options, execution, runner });
  if (first.status === 'interrupted') expect((await h.resume(first.id)).status).toBe(202);
  if (agent === 'Claude') installFakeCli(join(home, 'fake'), 'claude', cli());
  else installFakeCli(join(home, 'fake'), 'codex', codex());
  if (failure === 'qa-fail') await flow.runNext(20);
  await flow.runNext(20);
  const calls = await readFile(join(home, 'fake', `${agent.toLowerCase()}.calls.jsonl`), 'utf8');
  expect(calls).toContain('이전 시도에서 받은 지시');
  expect(calls).toContain(id);
  expect(acknowledgements).toBe(1);
  expect(runner.retainedMessages).toEqual([]);
}, 60_000);

// M5·M7 통합(M5-05 리뷰 P3-3): QA FAIL 시도에서 응답한 지시는 재검증에 다시 전달되지만 업무 응답은 한 번만 남긴다.
// 왜: 같은 지시에 응답 행이 두 개 생기면 팀장 화면에 같은 답이 두 번 보이고, 어느 쪽이 최신인지 헷갈린다.
test('QA FAIL 뒤 재검증에 다시 전달한 지시에는 업무 응답을 다시 보내지 않는다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  await flow.runNext(20);
  const draft = await h.lead('POST', '/api/messages', { taskKey: 'TASK-0001', type: '추가 지시', toAgent: 'Codex', body: '검증 때 이 항목도 확인하세요.' });
  const id = String(draft.body.id);
  expect((await h.lead('POST', `/api/messages/${id}/send`, { updatedAt: draft.body.updatedAt })).status).toBe(200);
  installFakeCli(join(home, 'fake'), 'codex', codex('FAIL'));
  expect((await flow.runNext(20))?.payload).toMatchObject({ kind: 'qa' });
  expect(runner.retainedMessages.map(m => m.id)).toEqual([id]);
  expect((await flow.runNext(20))?.payload).toMatchObject({ kind: 'rework' });
  installFakeCli(join(home, 'fake'), 'codex', codex('PASS'));
  expect((await flow.runNext(20))?.payload).toMatchObject({ kind: 'reverify' });
  await runner.outbox.flush();
  const calls = await readFile(join(home, 'fake', 'codex.calls.jsonl'), 'utf8');
  expect(calls).toContain('이전 시도에서 받은 지시');
  expect(await h.rows("select count(*)::int n from messages where dir='in' and type='응답'")).toEqual([{ n: 1 }]);
  expect(runner.retainedMessages).toEqual([]);
}, 60_000);

test('프로세스가 남아 있는 job은 no_process로 끝냈다고 보고하지 않는다', async () => {
  const fake = installFakeCli(join(home, 'fake'), 'claude', cli('PASS', true));
  expect((await h.run('TASK-0001')).status).toBe(202);
  const job = await execution.claim(20);
  if (!job) throw new Error('개발 job이 필요합니다.');
  const running = flow.run(job);
  try {
    await expect.poll(() => fake.calls().length, { timeout: 10_000 }).toBe(1);
    await expect(finishJob(options, job, { status: 'done' })).rejects.toThrow('no_process');
    expect(await h.rows('select status from task_attempts')).toEqual([{ status: 'running' }]);
  } finally { await execution.shutdown(); await running; }
});

test('전달하지 않은 메시지의 업무 응답은 보고하지 않는다', async () => {
  const collect = options.collect;
  options.collect = async context => ({ ...await collect(context), responses: [{ messageId: crypto.randomUUID(), text: '임의 응답', workState: '완료' }] });
  expect((await h.run('TASK-0001')).status).toBe(202);
  await expect(flow.runNext(20)).rejects.toThrow('전달하지 않은 메시지');
  expect(await h.rows("select count(*)::int n from messages where dir='in'")).toEqual([{ n: 0 }]);
  expect((await h.lead('GET', '/api/tasks/TASK-0001')).body.lifecycleStatus).toBe('paused');
});

test('시작 전 정책·메시지 조회 실패는 시도 없이 job을 실패 처리하고 no_process로 해제한다', async () => {
  runner.poll = async () => { throw new ApiTransportError('pollMessages'); };
  expect((await h.run('TASK-0001')).status).toBe(202);
  await expect(flow.runNext(20)).rejects.toBeInstanceOf(ApiTransportError);
  expect(await h.rows('select count(*)::int n from task_attempts')).toEqual([{ n: 0 }]);
  expect(await h.rows('select state from runner_jobs')).toEqual([{ state: 'failed' }]);
  expect(await h.rows('select count(*)::int n from execution_holds where closed_at is null')).toEqual([{ n: 0 }]);
});

test.each(['prepare', 'getRunGrade', 'getTaskSubagents', 'canStart', 'aborted', 'sync-before', 'sync-after'] as const)('리뷰 R1·R5: %s 시작 전 거부는 임대 만료 뒤에도 거짓 미확인과 409 막힘을 남기지 않는다', async boundary => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const job = await execution.claim(20);
  if (!job) throw new Error('예약한 개발 job이 필요합니다.');
  if (boundary === 'sync-before') Object.defineProperty(runner, 'ready', { configurable: true, get: () => false });
  if (boundary === 'sync-after') runner.poll = async () => { Object.defineProperty(runner, 'ready', { configurable: true, get: () => false }); };
  if (boundary === 'prepare') executionOptions.prepare = async () => { throw new Error('작업 폴더 준비 실패'); };
  if (boundary === 'canStart') executionOptions.canStart = () => ({ ok: false, reason: 'limit' });
  if (boundary === 'getRunGrade' || boundary === 'getTaskSubagents') {
    const api = executionOptions.api;
    executionOptions.api = async (operation, request) => {
      if (operation === boundary) throw new Error('조회 실패');
      return api(operation, request);
    };
  }
  const controller = new AbortController();
  if (boundary === 'aborted') controller.abort();
  await expect(flow.run(job, controller.signal)).rejects.toThrow();
  if (boundary === 'sync-before' || boundary === 'sync-after') Reflect.deleteProperty(runner, 'ready');
  expect(await h.rows('select count(*)::int n from task_attempts')).toEqual([{ n: 0 }]);
  expect(await h.rows('select state from runner_jobs')).toEqual([{ state: boundary === 'canStart' ? 'queued' : 'failed' }]);
  expect(await h.rows('select slot_state,lock_state,release_proof from execution_holds')).toEqual([{ slot_state: 'none', lock_state: boundary === 'canStart' ? 'held' : 'released', release_proof: 'no_process' }]);
  expect(await h.rows("select count(*)::int n from runner_job_events where kind='prestart_failed'")).toEqual([{ n: boundary === 'canStart' ? 0 : 1 }]);
  await h.watchDisconnected();
  expect(await h.rows("select count(*)::int n from alerts where key like 'unconfirmed:%'")).toEqual([{ n: 0 }]);
  await h.runner.reconnect();
  if (boundary !== 'canStart') expect((await h.run('TASK-0001')).status).toBe(202);
});

test('claim 응답 사이 자원이 부족해지면 물리 슬롯을 반납하고 같은 job을 다시 실행한다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const calls: number[] = [];
  executionOptions.canStart = (_agent, slots) => { calls.push(slots); return calls.length === 1 ? { ok: true } : { ok: false, reason: 'limit' }; };
  // 짧은 대기 뒤에도 자원이 부족하면 같은 job을 서버 대기열에 돌려준다.
  executionOptions.admissionWaitMs = 300;
  await expect(execution.claim(20)).resolves.toBeNull();
  expect(calls.length).toBeGreaterThan(2);
  expect(new Set(calls)).toEqual(new Set([1]));
  expect(await h.rows('select state,fence,attempts from runner_jobs')).toEqual([{ state: 'queued',fence:1,attempts:0 }]);
  expect(await h.rows('select slot_state,lock_state from execution_holds where closed_at is null')).toEqual([{ slot_state:'none',lock_state:'held' }]);
  executionOptions.canStart = () => ({ ok:true });
  await flow.runNext(20);
  expect(await h.rows('select kind,status from task_attempts')).toEqual([{ kind:'dev',status:'completed' }]);
});

// M5·M7 통합(M5-05 리뷰 P3-4): claim 직후의 짧은 자원 경합은 시작 전 실패가 아니라 대기다(contracts §3.4-8 「잠금을 유지한 채 대기」).
// 왜: 자동으로 만든 QA·재작업 job이 몇 초 경합 때문에 실패하면 팀장이 「다시 시도」를 눌러야만 이어진다.
test('claim 응답 사이 자원이 잠깐 줄었다 돌아오면 실패하지 않고 같은 임대로 기다렸다 시작한다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const calls: number[] = [];
  executionOptions.canStart = () => { calls.push(1); return calls.length === 1 || calls.length >= 4 ? { ok: true } : { ok: false, reason: 'limit' }; };
  expect(await execution.claim(20)).toMatchObject({ kind: 'attempt' });
  expect(calls.length).toBeGreaterThanOrEqual(4);
  expect(await h.rows('select state from runner_jobs')).toEqual([{ state: 'leased' }]);
});

test.each(['qa','rework'] as const)('자동 %s도 자원 반환 뒤 팀장 버튼 없이 같은 job을 실행한다', async kind => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  await flow.runNext(20);
  if (kind === 'rework') {
    installFakeCli(join(home,'fake'),'codex',codex('FAIL'));
    await flow.runNext(20);
  }
  const before = await h.rows(`select id from runner_jobs where state='queued' and payload->>'kind'='${kind}'`);
  let checks = 0;
  executionOptions.canStart = () => ++checks === 1 ? { ok:true } : { ok:false,reason:'limit' };
  executionOptions.admissionWaitMs = 0;
  expect(await flow.runNext(20)).toBeNull();
  expect(await h.rows(`select id,state,attempts,fence from runner_jobs where state='queued'`)).toEqual([{ id:before[0]?.id,state:'queued',attempts:0,fence:1 }]);
  executionOptions.canStart = () => ({ ok:true });
  installFakeCli(join(home,'fake'),'codex',codex('PASS'));
  await flow.runNext(20);
  expect(await h.rows(`select kind,status from task_attempts where kind='${kind}'`)).toEqual([{ kind,status:'completed' }]);
  expect(await h.rows("select count(*)::int n from runner_job_events where kind='prestart_failed'")).toEqual([{ n:0 }]);
});

test.each(['before','after'] as const)('자원 반환 전송 %s 응답 유실 뒤 복구해도 대기열 잠금을 닫지 않는다', async lost => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const api = executionOptions.api;
  let checks = 0;
  executionOptions.canStart = () => ++checks === 1 ? { ok:true } : { ok:false,reason:'limit' };
  executionOptions.admissionWaitMs = 0;
  executionOptions.api = async (operation,request) => {
    if (operation === 'returnJob') {
      if (lost === 'after') await api(operation,request);
      throw new ApiTransportError('returnJob');
    }
    return api(operation,request);
  };
  await expect(execution.claim(20)).rejects.toThrow();
  executionOptions.api = api;
  const holds = (await api('getExecutionHolds',{ epoch:state.snapshot.epoch })).body.holds;
  expect(await execution.recover(holds)).toBe(true);
  expect(await h.rows('select state,attempts,fence from runner_jobs')).toEqual([{ state:'queued',attempts:0,fence:1 }]);
  expect(await h.rows('select slot_state,lock_state,closed_at from execution_holds')).toEqual([{ slot_state:'none',lock_state:'held',closed_at:null }]);
  executionOptions.canStart = () => ({ ok:true });
  await flow.runNext(20);
  expect(await h.rows('select kind,status from task_attempts')).toEqual([{ kind:'dev',status:'completed' }]);
});

test('실행 실패는 같은 종류를 총 3회만 자동 실행하고 QA 결과를 만들지 않는다', async () => {
  installFakeCli(join(home, 'fake'), 'claude', { ...cli(), exitCode: 1 });
  expect((await h.run('TASK-0001')).status).toBe(202);
  for (let i = 0; i < 3; i++) await flow.runNext(20);
  expect(await flow.runNext(20)).toBeNull();
  expect(await h.rows('select kind,status from task_attempts order by attempt_no')).toEqual([
    { kind: 'dev', status: 'failed' }, { kind: 'dev', status: 'failed' }, { kind: 'dev', status: 'failed' },
  ]);
  expect(await h.rows('select count(*)::int n from verifications')).toEqual([{ n: 0 }]);
  expect(checks).toEqual([]);
});

test('QA FAIL은 자동 재작업 3회 뒤 멈추고 중단이나 실행 실패와 섞지 않는다', async () => {
  installFakeCli(join(home, 'fake'), 'codex', codex('FAIL'));
  expect((await h.run('TASK-0001')).status).toBe(202);
  for (let i = 0; i < 8; i++) await flow.runNext(20);
  expect(await flow.runNext(20)).toBeNull();
  expect(await h.rows("select count(*)::int n from task_attempts where kind='rework'")).toEqual([{ n: 3 }]);
  expect((await h.lead('GET', '/api/tasks/TASK-0001')).body.lifecycleStatus).toBe('rework');
}, 60_000);

test('재작업 안의 프로세스 실패 재시도는 같은 재작업 회차를 유지한다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  await flow.runNext(20);
  installFakeCli(join(home, 'fake'), 'codex', codex('FAIL'));
  await flow.runNext(20);
  installFakeCli(join(home, 'fake'), 'claude', { ...cli(), exitCode: 1 });
  await flow.runNext(20);
  installFakeCli(join(home, 'fake'), 'claude', cli());
  await flow.runNext(20);
  expect(await h.rows("select kind,status from task_attempts where kind='rework' order by attempt_no")).toEqual([
    { kind: 'rework', status: 'failed' }, { kind: 'rework', status: 'completed' },
  ]);
  expect(await h.rows("select count(distinct j.payload->>'automaticCause')::int n from task_attempts a join runner_jobs j on j.id=a.job where a.kind='rework'")).toEqual([{ n: 1 }]);
}, 60_000);

// M5·M7 통합(M5-05 리뷰 P3-5): M5-05 시도 흐름과 M7-06 CI 실행기를 한 줄로 잇는다.
// 왜: 두 브랜치는 각각 자기 쪽을 실제로, 다른 쪽은 준비 코드로 시험했다. 통합 뒤에는 실제 dev·①·QA가 실제 ②·병합으로 이어져야 한다.
// 두 실행기는 claim하는 job 종류가 다르다(attempt·stop_attempt / integrate·ci_retry). 같은 무거운 작업 상한(HeavySemaphore)을 쓴다.
test('M5·M7 통합: 실제 시도 흐름(dev → push → PR 열기 → ① → QA PASS) 뒤 실제 CI 실행기가 ②·병합을 하고 Task가 자동 완료된다', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  expect((await flow.runNext(20))?.payload).toMatchObject({ kind: 'dev', agent: 'Claude' });
  expect((await flow.runNext(20))?.payload).toMatchObject({ kind: 'qa', agent: 'Codex' });
  expect((await h.lead('GET', '/api/tasks/TASK-0001')).body).toMatchObject({ lifecycleStatus: 'gate' });
  expect(checks).toEqual(['dev']);
  // 시도 흐름이 검사한 커밋을 PR 브랜치에 올리고, 그 브랜치의 PR을 한 번만 열어 번호를 시도 기록과 ① 보고에 남겼는지 확인한다.
  expect(f.ref(f.request.branch)).toBe(head);
  expect(f.pullCreates).toEqual([f.request.branch]);
  expect(await h.rows("select kind,pr from task_attempts order by attempt_no")).toEqual([{ kind: 'dev', pr: 1 }, { kind: 'qa', pr: null }]);
  expect(await h.rows('select pr from ci_runs where stage=1')).toEqual([{ pr: 1 }]);
  const ci = new CiJobs({ ...f.deps, heavy: executionOptions.heavy, directory: join(home, 'ci-jobs'), api: h.runner.api, outbox: runner.outbox,
    runnerId: state.snapshot.runnerId, epoch: () => 1, ready: () => runner.ready, identity: executionOptions.identity,
    execute: (_job, argv, cwd) => f.deps.execute(argv, cwd), warn: () => undefined });
  try {
    expect(await flow.runNext(20)).toBeNull();
    const outcome = await ci.runNext(20);
    expect(outcome?.job.kind).toBe('integrate');
    expect(outcome?.result).toMatchObject({ kind: 'merged', qaHeadSha: head });
    await runner.outbox.flush();
    expect((await h.lead('GET', '/api/tasks/TASK-0001')).body).toMatchObject({ lifecycleStatus: 'done' });
    expect(await h.rows("select count(*)::int n from execution_holds where closed_at is null")).toEqual([{ n: 0 }]);
    const intermediate=git(f.repo.path,'rev-parse',`${head}^`);
    const merged=f.ref('main');
    const night=await h.runner.api('startCiRun',{ epoch:1,idempotencyKey:crypto.randomUUID(),body:{ stage:'night',ref:'main',trigger:'night',headSha:merged,pipelineSha:f.ref('main') } });
    await h.runner.api('updateCiRun',{ epoch:1,idempotencyKey:crypto.randomUUID(),params:{ id:night.body.id },body:{ fence:null,status:'run',causeCandidates:[{ commit:intermediate }] } });
    expect((await h.lead('GET',`/api/projects/${h.project}/ci/runs/${night.body.id}`)).body.causeCandidates).toEqual([{ commit:intermediate,taskKey:'TASK-0001' }]);
  } finally { await ci.shutdown(); }
}, 60_000);

// 조정자 결정 1: GitHub 쓰기 권한이 없으면 PR을 열지 못한다. 시도는 Task 실패가 아니라 외부 쓰기 막힘 보류(중단)다.
test('PR 쓰기 권한이 없으면 ①·QA로 넘어가지 않고 외부 쓰기 막힘으로 보류한다', async () => {
  f.github.on('POST /repos/o/r/pulls', () => ({ status: 403, body: { message: 'Resource not accessible by integration' }, headers: { 'x-accepted-github-permissions': 'pull_requests=write' } }));
  expect((await h.run('TASK-0001')).status).toBe(202);
  await expect(flow.runNext(20)).rejects.toThrow('외부 쓰기 막힘');
  expect((await h.lead('GET', '/api/tasks/TASK-0001')).body.lifecycleStatus).toBe('paused');
  expect(f.client.permissions().pulls).toBe('missing');
  expect(await h.rows('select count(*)::int n from ci_runs where stage=1')).toEqual([{ n: 0 }]);
  expect(await h.rows("select count(*)::int n from runner_jobs where payload->>'kind'='qa'")).toEqual([{ n: 0 }]);
  expect(await h.rows('select count(*)::int n from execution_holds where closed_at is null')).toEqual([{ n: 0 }]);
});

test('시나리오 6: 실제 세션 결합으로 개발→QA FAIL→상향 재작업→재검증 PASS→Gate 대기', async () => {
  expect(await flow.runNext(20)).toBeNull();
  expect((await h.run('TASK-0001')).status).toBe(202);
  expect((await flow.runNext(20))?.payload).toMatchObject({ kind: 'dev', agent: 'Claude' });
  installFakeCli(join(home, 'fake'), 'codex', codex('FAIL'));
  expect((await flow.runNext(20))?.payload).toMatchObject({ kind: 'qa', agent: 'Codex' });
  expect((await flow.runNext(20))?.payload).toMatchObject({ kind: 'rework', agent: 'Claude' });
  installFakeCli(join(home, 'fake'), 'codex', codex('PASS'));
  expect((await flow.runNext(20))?.payload).toMatchObject({ kind: 'reverify', agent: 'Codex' });
  expect((await h.lead('GET', '/api/tasks/TASK-0001')).body).toMatchObject({ lifecycleStatus: 'gate' });
  expect(checks).toEqual(['dev', 'rework']);
  expect(await h.rows('select kind,status,effort from task_attempts order by attempt_no')).toMatchObject([
    { kind: 'dev', status: 'completed', effort: 'high' }, { kind: 'qa', status: 'completed' },
    { kind: 'rework', status: 'completed', effort: 'xhigh' }, { kind: 'reverify', status: 'completed' },
  ]);
  expect(await flow.runNext(20)).toBeNull();
  expect(await h.rows("select count(*)::int n from ci_runs where stage=2")).toEqual([{ n: 0 }]);
  expect(await h.rows("select count(*)::int n from execution_holds where closed_at is null")).toEqual([{ n: 0 }]);
}, 60_000);
