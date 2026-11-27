import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import { ApiError, ApiTransportError, createApiClient } from '../../src/api/client.ts';
import { Outbox } from '../../src/api/outbox.ts';
import { Secret } from '../../src/security/secret.ts';
import { State } from '../../src/state/state.ts';
import { Execution } from '../../src/exec/session.ts';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { ResourceReporter } from '../../src/resources/reporter.ts';
import { installFakeCli } from '../fakes/cli.ts';
import type { ClaimedJob, ExecutionHold } from '../../src/api/generated/client.ts';
import type { ExecutionOptions } from '../../src/exec/session.ts';

const roots: string[] = [];
const states: State[] = [];
afterEach(async () => {
  await Promise.all(states.splice(0).map(s => s.close()));
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});
const job: Extract<ClaimedJob, { kind: 'attempt' }> = { id: 'job', kind: 'attempt', fence: 9, leaseUntil: new Date(Date.now() + 60000).toISOString(), payload: { taskKey: 'TASK-0001', kind: 'dev', agent: 'Codex', branch: 'agent/task', baseCommit: 'a'.repeat(40), inputVersion: 1, instructions: { spec: '작업 지시' } } };
async function setup({ installBad = false, installGood = false, isolation = true, lines, hang = false, recovered = true, startMismatch = false, renewPast = false, closeStdout = false, holdsUnavailable = false, prepare }: { installBad?: boolean; installGood?: boolean; isolation?: boolean; lines?: unknown[]; hang?: boolean; recovered?: boolean; startMismatch?: boolean; renewPast?: boolean; closeStdout?: boolean; holdsUnavailable?: boolean; prepare?: () => Promise<void> } = {}) {
  job.leaseUntil = new Date(Date.now() + 60000).toISOString();
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'session-')); roots.push(home);
  const fake = installFakeCli(join(home, 'fake'), 'codex', { lines: lines ?? [{ type: 'thread.started', thread_id: 'thread-1' }, { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } }], hang, closeStdout });
  const state = await State.open(home); states.push(state);
  const requests: { path: string; body: Record<string, unknown>; key: string | null }[] = [];
  const replay = new Map<string, Response>();
  const remote = new Map<string, ExecutionHold>();
  const reserve = (id: string, fence: number, attempt: string | null = null) => remote.set(id, {
    id: `hold-${id}`, project_id: null, job: id, attempt, epoch: state.snapshot.epoch,
    host_id: 'host', boot_id: 'boot', fence, pgid: null, cgroup: null, task: null, conflict_group: null,
    agent: 'Codex', slots: 1, heavy: true, slot_state: 'reserved', lock_state: 'held', lock_from_job: null,
    handed_to_job: null, release_proof: null, closed_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const api = createApiClient({ baseUrl: 'http://fake.invalid', token: new Secret('fake'), fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    requests.push({ path, body, key: new Headers(init?.headers).get('idempotency-key') });
    const key = new Headers(init?.headers).get('idempotency-key');
    const cached = key ? replay.get(key) : undefined;
    if (cached) return cached.clone();
    let reply: unknown;
    if (path.endsWith('/host')) reply = { mode: 'auto', caps: { total: 6, Codex: 6, Claude: 6, heavy: 1 }, recommended: { total: 6, Codex: 6, Claude: 6, heavy: 1 }, hostChanged: false };
    if (path.endsWith('/run-grade')) reply = { model: 'gpt-6.2-sol', effort: 'high', adjust: null, locked: false, floorEffort: 'low', allowedModels: ['gpt-6.2-sol'], policy: { onUsage: 'wait', lowPct: 20, onRework: 'up1', notifyAt: 2 } };
    else if (path.endsWith('/subagents')) reply = { enabled: installBad || installGood, items: installBad || installGood ? [{ id: 'def', key: 'helper', agent: 'Codex', version: 1, hash: installBad ? '0'.repeat(64) : createHash('sha256').update('instruction').digest('hex'), file: 'instruction', sandbox: 'read-only' }] : [] };
    else if (path.endsWith('/start')) {
      if (startMismatch) return Response.json({ error: { code: 'SUBAGENT_INSTALL_FAILED', message: '설치 중 허용 버전이 바뀜', action: '시작', fix: '정의 재조회', errors: [], details: {}, requestId: 'fake' } }, { status: 422 });
      const attemptId = `attempt-${requests.filter(r => r.path.endsWith('/start')).length}`;
      reply = { attemptId };
      reserve(path.split('/').at(-2) ?? '', Number(body.fence), attemptId);
    }
    else if (path.endsWith('/renew')) reply = { leaseUntil: renewPast ? '2020-01-01T00:00:00.000Z' : new Date(Date.now() + 60000).toISOString() };
    else if (path.endsWith('/holds')) { if (holdsUnavailable) throw new ApiTransportError('getExecutionHolds'); reply = { holds: [...remote.values()] }; }
    else if (path.endsWith('/jobs/claim')) reply = { job: (body.kinds as string[]).includes('attempt') ? job : { id: 'stop-job', kind: 'stop_attempt', fence: 1, leaseUntil: new Date(Date.now() + 60000).toISOString(), payload: { attemptId: 'attempt-1', reason: 'manual' } } };
    else if (path.endsWith('/interrupt')) reply = { taskStatus: 'paused' };
    else if (path.endsWith('/slots/acquire')) reserve(path.split('/').at(-3) ?? '', Number(body.fence));
    else if (path.endsWith('/process')) {
      expect(fake.calls()).toHaveLength(requests.filter(r => r.path.endsWith('/process')).length - 1);
      const hold = remote.get(path.split('/').at(-2) ?? '');
      if (hold) { hold.pgid = Number(body.processGroup); hold.slot_state = 'active'; }
    }
    else if (path.endsWith('/slots/release')) {
      const hold = remote.get(path.split('/').at(-3) ?? '');
      if (hold) hold.slot_state = 'none';
    }
    else if (path.endsWith('/release')) remote.delete(path.split('/').at(-2) ?? '');
    const response = reply === undefined ? new Response(null, { status: 204 }) : Response.json(reply);
    if (key) replay.set(key, response.clone());
    return response;
  } });
  const outbox = new Outbox(state, api);
  const sessions: { attemptId: string; agent: 'Codex' | 'Claude'; observed: number; reserved: number; state: 'ok' | 'unconfirmed'; children: number }[] = [];
  const heavy = new HeavySemaphore(1);
  const reporter = new ResourceReporter({ api, epoch: () => state.snapshot.epoch, heavy });
  await reporter.reportHost({ hostId: 'host', bootId: 'boot', cpu: 'fake', cores: 4, memGB: 16, swapGB: 0, diskFreeGB: 100, os: 'fake' });
  const options: ExecutionOptions = { home, identity: { hostId: 'host', bootId: 'boot' }, api, outbox, epoch: () => state.snapshot.epoch, ready: () => true, env: { PATH: process.env.PATH }, binaries: { Codex: fake.path, Claude: '/never-claude' }, prepare: async () => { await prepare?.(); return { cwd: home, headSha: 'a'.repeat(40) }; }, budget: () => 2, sessions, heavy, canStart: (agent, slots, local) => reporter.canStart(agent, slots, local), ...(isolation ? { isolation: { name: 'fake', flags: () => [], wrap: l => l } } : {}) };
  const exec = new Execution(options);
  if (recovered) await exec.recover();
  return { home, exec, requests, fake, sessions, outbox, heavy, options, remote };
}

test('기본 격리 거부는 start와 실제 CLI 실행 전에 멈춘다', async () => {
  const t = await setup({ isolation: false });
  await expect(t.exec.run(job)).rejects.toMatchObject({ code: 'isolation_undecided' });
  expect(t.requests.some(r => r.path.endsWith('/start'))).toBe(false);
  expect(t.fake.calls()).toEqual([]);
});

test('claim도 run과 같은 하위 Agent 예산을 포함해 canStart를 검사한다', async () => {
  const t = await setup();
  const slots: number[] = [];
  t.options.canStart = (_agent, requested) => { slots.push(requested); return requested === 1 ? { ok: true } : { ok: false, reason: 'limit' }; };
  expect(await t.exec.claim(6)).toMatchObject({ kind: 'stop_attempt' });
  expect(slots.length).toBeGreaterThan(0);
  expect(slots.every(value => value === 3)).toBe(true);
  expect(t.requests.find(r => r.path.endsWith('/jobs/claim'))?.body.kinds).toEqual(['stop_attempt']);
});

test('job 결합은 실제 출력 전달 뒤 확인하고 슬롯 반환 뒤 같은 임대 안에서 결과를 수집한다', async () => {
  const t = await setup({ lines: [
    { type: 'item.completed', item: { type: 'agent_message', text: '검증한 결과' } },
    { type: 'turn.completed' },
  ] });
  const events: string[] = [];
  const result = await t.exec.run(job, {
    prompt: '추가 지시 데이터',
    delivered: async () => { expect(t.fake.calls()).toHaveLength(1); events.push('delivered'); },
    complete: async output => {
      expect(t.requests.some(r => r.path.endsWith('/slots/release'))).toBe(true);
      expect(t.sessions).toEqual([]);
      expect(output.text).toBe('검증한 결과');
      events.push('complete');
    },
  });
  expect(result.ok).toBe(true);
  expect(events).toEqual(['delivered', 'complete']);
  expect(t.fake.calls()[0]?.stdin).toContain('추가 지시 데이터');
});

test('설치 실패면 시도를 만들지 않고 SUBAGENT_INSTALL_FAILED를 outbox에 남긴다', async () => {
  const t = await setup({ installBad: true });
  await expect(t.exec.run(job)).rejects.toMatchObject({ code: 'SUBAGENT_INSTALL_FAILED' });
  await t.outbox.flush();
  expect(t.requests.some(r => r.path.endsWith('/start'))).toBe(false);
  expect(t.requests.find(r => r.path.endsWith('/finish'))?.body).toMatchObject({ fence: 9, status: 'failed', error: { code: 'SUBAGENT_INSTALL_FAILED' } });
  expect(t.requests.find(r => r.path.endsWith('/release'))?.body).toMatchObject({ proof: { kind: 'no_process' } });
  expect(t.fake.calls()).toEqual([]);
});

test('설치 후 서버의 정의 버전 대조가 거절되어도 실제 CLI를 실행하지 않는다', async () => {
  const t = await setup({ startMismatch: true });
  await expect(t.exec.run(job)).rejects.toMatchObject({ status: 422, error: { code: 'SUBAGENT_INSTALL_FAILED' } });
  expect(t.fake.calls()).toEqual([]);
  expect(t.requests.find(r => r.path.endsWith('/finish'))?.body).toMatchObject({ status: 'failed', error: { code: 'SUBAGENT_INSTALL_FAILED' } });
});

test('start→process 순서를 지키고 예산을 지시문에 넣으며 같은 등급·작업 폴더에서만 CLI resume', async () => {
  const t = await setup();
  const first = await t.exec.run(job);
  expect(first.observation.state).toBe('ok');
  expect(first.reserved).toBe(3);
  expect(t.fake.calls()[0]?.stdin).toContain('동시 하위 Agent 예산: 2');
  expect(t.requests.findIndex(r => r.path.endsWith('/start'))).toBeLessThan(t.requests.findIndex(r => r.path.endsWith('/process')));
  expect(t.sessions).toHaveLength(0);
  expect((await t.exec.launches.list()).every(r => r.completedAt)).toBe(true);
  await t.exec.run({ ...job, id: 'job-2', fence: 10 }, { resume: true });
  expect(t.fake.calls()[1]?.argv).toContain('resume');
  expect(t.fake.calls()[1]?.argv).toContain('thread-1');
  await t.outbox.flush();
  expect(t.requests.filter(r => r.path.endsWith('/slots/release')).every(r => (r.body.proof as { kind: string }).kind === 'group_empty')).toBe(true);
  expect([...new Map(t.requests.filter(r => r.path.endsWith('/start')).map(r => [r.key, r.body.fence])).values()]).toEqual([9, 10]);
}, 15000);

test('출력 단절은 수를 0으로 확정하지 않고 보수 예산을 유지한다', async () => {
  const t = await setup({ lines: [{ type: 'thread.started', thread_id: 'thread-1' }] });
  const result = await t.exec.run(job);
  expect(result.observation.state).toBe('unconfirmed');
  expect(result.reserved).toBe(3);
  expect(result.ok).toBe(false);
  await t.outbox.flush();
  expect(t.requests.find(r => r.path.endsWith('/status') && r.body.status === 'failed')?.body).toMatchObject({ status: 'failed', model: 'gpt-6.2-sol', effort: 'high', fence: 9 });
});

test('M5-01 호환: 배경 여부가 빠진 Claude 호출은 전경으로 추정하지 않고 보유를 유지한다', async () => {
  const t = await setup({ lines: [
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Agent', id: 'call-1' }] } },
    { type: 'system', subtype: 'task_started', task_id: 'task-1', task_type: 'agent', tool_use_id: 'call-1' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1' }] } },
    { type: 'result', subtype: 'success', is_error: false },
  ] });
  t.options.binaries.Claude = t.fake.path;
  const result = await t.exec.run({ ...job, payload: { ...job.payload, agent: 'Claude' } });
  expect(result.observation).toMatchObject({ observed: 1, state: 'unconfirmed' });
  expect(result.reserved).toBe(3);
});

test.each([{ cwd: '/다른/폴더' }, { agent: 'Claude' }, { model: '다른-model' }, { effort: 'low' }])('CLI resume 로컬 조건이 달라지면 새 세션: %j', async change => {
  const t = await setup();
  await t.exec.run(job);
  const dir = join(t.home, 'state/sessions'), [name] = await readdir(dir);
  if (!name) throw new Error('세션 기록이 없습니다.');
  const path = join(dir, name);
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')) as object, ...change }));
  await t.exec.run({ ...job, id: 'next-job' }, { resume: true });
  expect(t.fake.calls()[1]?.argv).not.toContain('resume');
}, 15000);

test('실행 중 lease 만료는 스트림이 살아 있어도 그룹을 멈춘다', async () => {
  const t = await setup({ hang: true });
  const result = await t.exec.run({ ...job, leaseUntil: new Date(Date.now() + 1500).toISOString() });
  expect(result.ok).toBe(false);
  expect(result.proof.kind).toBe('group_empty');
  expect(t.sessions).toEqual([]);
});

test('재시작 대조를 마친 뒤에만 attempt claim을 보내고 기본 격리에서는 받지 않는다', async () => {
  const t = await setup({ recovered: false });
  expect(await t.exec.claim(3)).toBeNull();
  expect(t.requests.some(r => r.path.endsWith('/jobs/claim'))).toBe(false);
  expect(await t.exec.recover()).toBe(true);
  expect(await t.exec.claim(3)).toMatchObject({ id: 'job', fence: 9 });
  const pending = await setup({ isolation: false });
  await pending.exec.recover();
  expect(await pending.exec.claim(3)).toBeNull();
});

test('보유 조회 통신이 끊겨도 종료 신호는 재시작 대조의 재시도를 끝낸다', async () => {
  const t = await setup({ recovered: false, holdsUnavailable: true });
  const controller = new AbortController();
  const recovering = t.exec.recover(undefined, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await expect(recovering).rejects.toThrow();
}, 500);

test('관측 미확인은 새 세션을 막지만 중단 명령은 계속 받는다', async () => {
  const t = await setup();
  t.sessions.push({ attemptId: 'attempt-1', agent: 'Codex', observed: 2, reserved: 3, state: 'unconfirmed', children: 3 });
  expect(await t.exec.claim(10)).toMatchObject({ kind: 'stop_attempt' });
  expect(t.requests.find(r => r.path.endsWith('/jobs/claim'))?.body).toMatchObject({ kinds: ['stop_attempt'], capacity: 10 });
});

test('프로세스가 살아 있는 동안 stdout만 끊겨도 즉시 미확인으로 보유한다', async () => {
  const t = await setup({ hang: true, closeStdout: true, lines: [{ type: 'thread.started', thread_id: 'thread-1' }] });
  const running = t.exec.run(job);
  try {
    for (let i = 0; i < 100 && t.sessions[0]?.state !== 'unconfirmed'; i++) await sleep(10);
    expect(t.sessions[0]).toMatchObject({ state: 'unconfirmed', reserved: 3 });
    expect(await t.exec.claim(3)).toMatchObject({ kind: 'stop_attempt' });
  } finally { await t.exec.shutdown(); await running.catch(() => undefined); }
});

test('임대가 이미 끝났으면 실제 실행과 start를 거부한다', async () => {
  const t = await setup();
  await expect(t.exec.run({ ...job, leaseUntil: '2020-01-01T00:00:00.000Z' })).rejects.toThrow();
  expect(t.fake.calls()).toEqual([]);
  expect(t.requests.some(r => r.path.endsWith('/start'))).toBe(false);
});

test('① 명령도 같은 HeavySemaphore와 acquire→process→release 절차를 사용한다', async () => {
  const t = await setup();
  const release = await t.heavy.acquire('다른 전체 테스트');
  const command = t.exec.command({ id: 'job', fence: 9, epoch: 0 }, 'Codex', { file: t.fake.path, args: [], cwd: t.home, env: {}, stdin: '명령' });
  await sleep(30);
  expect(t.fake.calls()).toEqual([]);
  expect(t.heavy.snapshot().waiting).toBe(1);
  release();
  expect((await command).code).toBe(0);
  expect(t.heavy.snapshot().running).toBe(0);
  expect(t.requests.filter(r => /slots\/acquire|\/process|slots\/release/.test(r.path)).map(r => r.path.split('/').slice(-2).join('/'))).toEqual(['slots/acquire', 'job/process', 'slots/release']);
});

test('① 명령도 임대가 유지되는지 확인한 뒤에만 실행한다', async () => {
  const t = await setup({ renewPast: true });
  await expect(t.exec.command({ id: 'job', fence: 9, epoch: 0 }, 'Codex', { file: t.fake.path, args: [], cwd: t.home, env: {}, stdin: '' })).rejects.toThrow('임대');
  expect(t.fake.calls()).toEqual([]);
  expect(t.heavy.snapshot().running).toBe(0);
});

test('실제 ① 어댑터에 명령의 stdout·stderr와 종료 코드를 함께 돌려준다', async () => {
  const t = await setup();
  installFakeCli(join(t.home, 'fake'), 'codex', { lines: ['검사 출력'], stderr: '검사 진단' });
  const output = await t.exec.command({ id: 'job', fence: 9, epoch: 0 }, 'Codex', { file: t.fake.path, args: [], cwd: t.home, env: {}, stdin: '' });
  expect(output).toMatchObject({ code: 0, stdout: '검사 출력\n', stderr: '검사 진단' });
});

test('세션용 하위 Agent 정의는 실행 중 유지하고 실제 ① 전에 소유 hash를 확인해 걷어 낸다', async () => {
  const t = await setup({ installGood: true });
  await t.exec.run(job, {
    delivered: async () => { expect(await readFile(join(t.home, '.codex/agents/helper.toml'), 'utf8')).toContain('instruction'); },
    complete: async () => {
      await expect(readFile(join(t.home, '.codex/agents/helper.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(t.home, '.codex/agents/.awbs-installed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  });
});

test('실행 중 중단은 그룹 종료 뒤 interrupt를 보고하고 새 시도는 다른 attemptId를 쓴다', async () => {
  const t = await setup({ hang: true });
  const running = t.exec.run(job);
  for (let i = 0; i < 100 && !t.fake.calls().length; i++) await sleep(10);
  expect(t.exec.stop('attempt-1')).toBe(true);
  const result = await running;
  expect(result.ok).toBe(false);
  expect(result.proof.kind).toBe('group_empty');
  await t.outbox.flush();
  expect(t.requests.find(r => r.path.endsWith('/interrupt'))?.body).toMatchObject({ fence: 9, reason: 'error' });
  expect(t.sessions).toEqual([]);
});

test('같은 job을 동시에 두 번 실행해도 두 번째 CLI를 띄우지 않는다', async () => {
  const t = await setup({ hang: true });
  const first = t.exec.run(job);
  try {
    await expect(t.exec.run(job)).rejects.toThrow('이미 실행 중');
  } finally {
    await t.exec.shutdown();
    await first.catch(() => undefined);
  }
  expect(t.fake.calls().length).toBeLessThanOrEqual(1);
});

test('review: 먼저 받은 job도 관측 미확인 뒤에는 새 실행을 시작하지 않아야 한다', async () => {
  const t = await setup({ hang: true, closeStdout: true, lines: [{ type: 'thread.started', thread_id: 'thread-1' }] });
  const first = t.exec.run(job);
  let second: Promise<unknown> | undefined;
  try {
    for (let i = 0; i < 100 && t.sessions[0]?.state !== 'unconfirmed'; i++) await sleep(10);
    expect(t.sessions[0]?.state).toBe('unconfirmed');
    second = t.exec.run({ ...job, id: 'already-claimed-job-2', fence: 10 });
    await expect(second).rejects.toThrow('unconfirmed_session');
    console.log(JSON.stringify({ unconfirmedBeforeSecondRun: true, actualCliStarts: t.fake.calls().length }));
    expect(t.fake.calls()).toHaveLength(1);
  } finally {
    await t.exec.shutdown(); await first.catch(() => undefined); await second?.catch(() => undefined);
  }
});

test('review: 서버 보유가 없는 완료 기록의 pgid 재사용은 새 Runner를 막지 않아야 한다', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const t = await setup({ recovered: false });
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  try {
    await once(other, 'spawn');
    const record = await t.exec.launches.create({ id: 'finished-job', fence: 1, epoch: 0 });
    // 이미 완료한 과거 launch의 pgid가 이후 관계없는 프로세스에 재사용된 상황.
    record.pgid = other.pid ?? 0; record.startTime = '0';
    await t.exec.launches.save(record);
    const recovered = await t.exec.recover();
    expect(process.kill(other.pid ?? 0, 0)).toBe(true);
    expect(recovered).toBe(true);
  } finally {
    const exited = once(other, 'exit'); other.kill('SIGKILL'); await exited;
  }
});

test('review: 비동기 준비도 자리를 먼저 예약해 동시 상한을 넘지 않는다', async () => {
  const gate = Promise.withResolvers<undefined>();
  const t = await setup({ prepare: () => gate.promise });
  const first = t.exec.run(job), second = t.exec.run({ ...job, id: 'second' });
  try {
    await expect(t.exec.run({ ...job, id: 'third' })).rejects.toThrow('limit');
    expect(t.fake.calls()).toEqual([]);
  } finally { gate.resolve(undefined); await t.exec.shutdown(); await Promise.allSettled([first, second]); }
});

test('review: 준비 중 생긴 미확인을 start 직전에 다시 검사한다', async () => {
  const entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<undefined>();
  const t = await setup({ prepare: () => { entered.resolve(undefined); return gate.promise; } });
  const running = t.exec.run(job);
  await entered.promise;
  t.sessions.push({ attemptId: 'other', agent: 'Codex', observed: 0, reserved: 1, state: 'unconfirmed', children: 1 });
  gate.resolve(undefined);
  await expect(running).rejects.toThrow('unconfirmed_session');
  expect(t.requests.some(r => r.path.endsWith('/start'))).toBe(false);
  expect(t.fake.calls()).toEqual([]);
});

test('review: 완료된 launch는 보유 없는 재시작 대조에서 제외한다', async () => {
  const t = await setup();
  await t.exec.run(job);
  const records = await t.exec.launches.list();
  expect(records.every(r => r.completedAt)).toBe(true);
  t.remote.clear();
  const record = records.find(r => r.pgid !== null);
  if (!record) throw new Error('실행 기록이 없습니다.');
  record.pgid = process.pid; record.startTime = '0';
  await t.exec.launches.save(record);
  expect(await t.exec.recover()).toBe(true);
});

test('review: process 응답을 기다리는 사이 생긴 미확인도 실행 허가를 막는다', async () => {
  const t = await setup();
  const api = t.options.api;
  t.options.api = async (operation, request) => {
    const response = await api(operation, request);
    if (operation === 'reportJobProcess') t.sessions.push({ attemptId: 'other', agent: 'Codex', observed: 0, reserved: 1, state: 'unconfirmed', children: 1 });
    return response;
  };
  await expect(t.exec.run(job)).rejects.toThrow('unconfirmed_session');
  expect(t.fake.calls()).toEqual([]);
});

test('review2: ① 명령도 최신 로컬 미확인을 보고 실행을 보류해야 한다', async () => {
  const t = await setup();
  t.sessions.push({ attemptId: 'other', agent: 'Codex', observed: 2, reserved: 3, state: 'unconfirmed', children: 3 });
  const denied = t.options.canStart('Codex', 1, t.sessions);
  expect(denied).toMatchObject({ ok: false, reason: 'unconfirmed_session' });
  await expect(t.exec.command({ id: 'job', fence: 9, epoch: 0 }, 'Codex', { file: t.fake.path, args: [], cwd: t.home, env: {}, stdin: '① 검사' })).rejects.toThrow('unconfirmed_session');
  expect(t.fake.calls()).toHaveLength(0);
});

test('review2: 무거운 번호표를 기다리다 미확인이 생기면 명령 슬롯도 예약하지 않는다', async () => {
  const t = await setup();
  const release = await t.heavy.acquire('다른 작업');
  const command = t.exec.command({ id: 'job', fence: 9, epoch: 0 }, 'Codex', { file: t.fake.path, args: [], cwd: t.home, env: {}, stdin: '' });
  const rejected = expect(command).rejects.toThrow('unconfirmed_session');
  try {
    for (let i = 0; i < 100 && t.heavy.snapshot().waiting !== 1; i++) await sleep(10);
    expect(t.heavy.snapshot().waiting).toBe(1);
    t.sessions.push({ attemptId: 'other', agent: 'Codex', observed: 0, reserved: 1, state: 'unconfirmed', children: 1 });
  } finally { release(); }
  await rejected;
  expect(t.requests.some(r => r.path.endsWith('/slots/acquire'))).toBe(false);
  expect(t.fake.calls()).toEqual([]);
  expect(t.heavy.snapshot().running).toBe(0);
});

test('review2: process 응답 뒤 명령 거부도 종료 증명으로 슬롯을 반환한다', async () => {
  const t = await setup();
  const api = t.options.api;
  t.options.api = async (operation, request) => {
    const response = await api(operation, request);
    if (operation === 'reportJobProcess') t.sessions.push({ attemptId: 'other', agent: 'Codex', observed: 0, reserved: 1, state: 'unconfirmed', children: 1 });
    return response;
  };
  await expect(t.exec.command({ id: 'job', fence: 9, epoch: 0 }, 'Codex', { file: t.fake.path, args: [], cwd: t.home, env: {}, stdin: '' })).rejects.toThrow('unconfirmed_session');
  expect(t.fake.calls()).toEqual([]);
  expect(t.requests.find(r => r.path.endsWith('/slots/release'))?.body).toMatchObject({ proof: { kind: 'group_empty' } });
  expect((await t.exec.launches.list()).every(r => r.completedAt)).toBe(true);
  expect(t.heavy.snapshot().running).toBe(0);
});

test('review2: 준비 중인 명령도 세션과 같은 로컬 자리를 예약한다', async () => {
  const t = await setup();
  t.sessions.push({ attemptId: 'other', agent: 'Codex', observed: 2, reserved: 3, state: 'ok', children: 3 });
  const release = await t.heavy.acquire('다른 작업');
  const controller = new AbortController();
  const command = t.exec.command({ id: 'command', fence: 9, epoch: 0 }, 'Codex', { file: t.fake.path, args: [], cwd: t.home, env: {}, stdin: '' }, controller.signal);
  const ended = command.catch(() => undefined);
  try {
    for (let i = 0; i < 100 && t.heavy.snapshot().waiting !== 1; i++) await sleep(10);
    expect(t.heavy.snapshot().waiting).toBe(1);
    await expect(t.exec.run(job)).rejects.toThrow('limit');
  } finally { controller.abort(); release(); await ended; await t.exec.shutdown(); }
  expect(t.fake.calls()).toEqual([]);
});

test('review2: 명령 기록이 사라지면 과거 완료 기록으로 해제하지 않고 미확인 예약을 유지한다', async () => {
  const t = await setup();
  await t.exec.run(job);
  const api = t.options.api;
  t.options.api = async (operation, request) => {
    const response = await api(operation, request);
    if (operation === 'reportJobProcess') {
      const record = (await t.exec.launches.list()).find(r => !r.completedAt && r.pgid !== null);
      if (!record) throw new Error('진행 중인 명령 기록이 없습니다.');
      await rm(join(t.exec.launches.directory, `${record.launchId}.json`));
    }
    return response;
  };
  await expect(t.exec.command({ id: job.id, fence: job.fence, epoch: 0 }, 'Codex', { file: t.fake.path, args: [], cwd: t.home, env: {}, stdin: '' })).rejects.toThrow();
  expect(t.heavy.snapshot().running).toBe(1);
  expect(await t.exec.claim(6)).toMatchObject({ kind: 'stop_attempt' });
}, 15000);


test('review3: 등록 거부는 서버의 no_process와 로컬 그룹 종료를 각각 확인한다', async () => {
  const t = await setup();
  const api = t.options.api;
  const denied = new ApiError('reportJobProcess', 409, { code: 'LEASE_LOST', message: '임대 만료', action: '정리', fix: '다시 받기', errors: [], details: {}, requestId: 'fake' }, null);
  t.options.api = async (operation, request) => {
    if (operation === 'reportJobProcess') throw denied;
    return api(operation, request);
  };
  await expect(t.exec.command({ id: job.id, fence: job.fence, epoch: 0 }, 'Codex', { file: t.fake.path, args: [], cwd: t.home, env: {}, stdin: '' })).rejects.toBe(denied);
  expect(t.requests.find(r => r.path.endsWith('/slots/release'))?.body).toMatchObject({ proof: { kind: 'no_process' } });
  expect(t.fake.calls()).toEqual([]);
  expect((await t.exec.launches.list()).every(r => r.completedAt)).toBe(true);
  expect(t.heavy.snapshot().running).toBe(0);
});
