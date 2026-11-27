import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Runner } from '../../../../agent-runner/src/api/runner.ts';
import { ApiTransportError } from '../../../../agent-runner/src/api/client.ts';
import { Execution, type ExecutionOptions } from '../../../../agent-runner/src/exec/session.ts';
import { AttemptFlow, finishJob, type AttemptFlowOptions } from '../../../../agent-runner/src/jobs/attempt-flow.ts';
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
const checks: string[] = [];

function cli(result: 'PASS' | 'FAIL' = 'PASS', hang = false): CliScenario {
  const report = {
    summary: '가짜 CLI가 낸 결과', changedFiles: ['src/result.ts'], evidence: [],
    verification: { headSha: HEAD, specRevision: 1, result, cmd: 'fake check', expected: '수용 기준 충족', actual: result,
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
  h = await scenario();
  home = await mkdtemp('/home/keeproll/.orca/bots/agentwbs/archive/2026-11-27/M5-05/flow-');
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
  executionOptions = {
    home, identity, api: h.runner.api, outbox: runner.outbox,
    epoch: () => 1, ready: () => runner.ready, env: { PATH: process.env.PATH },
    binaries: { Claude: claude.path, Codex: cx.path },
    prepare: async () => ({ cwd: home, headSha: HEAD }), budget: () => 0,
    sessions: [], heavy, canStart: (agent, slots, sessions) => reporter.canStart(agent, slots, sessions),
    isolation: { name: 'fake-only', flags: () => [], wrap: launch => launch },
  };
  execution = new Execution(executionOptions);
  await execution.recover();
  checks.length = 0;
  options = {
    execution, runner, api: h.runner.api, epoch: () => 1, identity,
    taskCheck: async ({ job }) => { checks.push(job.payload.kind); },
    // 가짜 CLI의 고정 결과만 읽는 시험 공급원이다. 실제 출력 검증·Git·Evidence는 M7-06 공급원의 책임이다.
    collect: async ({ job, output, messages }) => {
      const parsed = JSON.parse(output.text) as Awaited<ReturnType<AttemptFlowOptions['collect']>>['report'] & { verification: object };
      const dev = { summary: parsed.summary, changedFiles: parsed.changedFiles, evidence: parsed.evidence };
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
}, 25_000);

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
}, 25_000);

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
});
