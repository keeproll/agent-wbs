import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, expect, inject, test } from 'vitest';
import { seoulDay } from '../../packages/shared/src/index.ts';
import { ApiTransportError, type ApiClient } from '../../../agent-runner/src/api/client.ts';
import { Outbox } from '../../../agent-runner/src/api/outbox.ts';
import { State } from '../../../agent-runner/src/state/state.ts';
import { Launches, type LaunchRecord } from '../../../agent-runner/src/exec/launches.ts';
import { processGroupEmpty } from '../../../agent-runner/src/cleanup/reset.ts';
import { scenario, type Scenario } from '../fakes/test/scenario.ts';
import type { Running } from '../fakes/runner.ts';

const docker = promisify(execFile);
const write = () => ({ epoch: 1, idempotencyKey: randomUUID() });
const metrics: { phase: string; operation: string; samplesMs: number[]; p95Ms: number; budgetMs: number }[] = [];
let h: Scenario;
let running: Running[];
let close: (() => Promise<void>) | undefined;

beforeEach(async () => {
  close = undefined;
  h = await scenario();
  close = h.close;
  // 준비 자료만 직접 넣는다. 실행 요청·claim(작업 수령)·시도 시작은 모두 실제 API를 쓴다.
  await h.rows(`insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state,planning_approved_at,src_input_version)
    select project_id,'TASK-'||lpad(n::text,4,'0'),wbs_node_id,n,'부하 작업 '||n,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,'ready','none',clock_timestamp(),src_input_version
    from tasks cross join generate_series(3,200) n where task_key='TASK-0001'`);
  await h.rows(`insert into task_specs(project_id,task,overview,spec,ac,revision)
    select project_id,id,'{}','{}','[]',1 from tasks where sort_order>2`);
  await h.rows(`insert into task_grades(project_id,task,role,model_id,effort,reason,locked,effective_from)
    select t.project_id,t.id,g.role,g.model_id,g.effort,g.reason,g.locked,clock_timestamp() from tasks t cross join task_grades g
    where t.sort_order>2 and g.task=(select id from tasks where task_key='TASK-0001')`);
  await h.rows(`insert into task_estimates(project_id,task,est,lo,hi,confidence,basis,agreed_by)
    select project_id,id,2,1,3,'상','고정 부하 자료','Claude,Codex' from tasks where sort_order>2`);
  await h.rows(`insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order)
    select project_id,id,'CL-1','확인',true,false,'시험',1 from tasks where sort_order>2`);
  await h.rows(`insert into task_outputs(project_id,task,name,kind,required,verify,delivered)
    select project_id,id,'src/result.ts','파일',true,'시험',false from tasks where sort_order>2`);
  await h.rows(`insert into concurrency_settings(singleton,mode,caps,subagent_budget)
    values(true,'manual','{"total":24,"Claude":24,"Codex":24,"heavy":24}','{"dev":0,"qa":0}')
    on conflict(singleton) do update set mode=excluded.mode,caps=excluded.caps,subagent_budget=excluded.subagent_budget`);
  await h.runner.api('reportConcurrency', { ...write(), body: { at: new Date().toISOString(), limit: 24,
    running: { Claude: 0, Codex: 0 }, subagents: 0, heavyJobs: 0, resources: { cpuPct: 10, memFreeGB: 24, swapGB: 0 }, sessions: [] } });
  const keys = Array.from({ length: 25 }, (_, i) => `TASK-${String(i + 1).padStart(4, '0')}`);
  // 같은 Task 요청 8개와 서로 다른 Task 25개가 경합해도 중복 job은 없어야 한다.
  const requests = await Promise.all([...keys, ...Array<string>(8).fill('TASK-0001')].map(key => h.run(key)));
  expect(requests.filter(r => r.status === 202)).toHaveLength(25);
  expect(requests.filter(r => r.status === 409)).toHaveLength(8);
  const claims = await Promise.all(Array.from({ length: 32 }, () => h.runner.startNext(undefined, 48)));
  running = claims.filter((a): a is Running => Boolean(a));
  expect(running).toHaveLength(24);
  expect(new Set(running.map(a => a.job.id)).size).toBe(24);
  expect(new Set(running.map(a => a.attemptId)).size).toBe(24);
  expect(await h.rows("select count(*)::int n,sum(slots)::int slots from execution_holds where slot_state='active' and closed_at is null")).toEqual([{ n: 24, slots: 24 }]);
  expect(await h.rows("select task from task_attempts where status='running' group by task having count(*)>1")).toEqual([]);
});
afterEach(async () => { await close?.(); });
afterAll(() => { process.stdout.write(`M8-02 측정값 ${JSON.stringify(metrics)}\n`); });

async function measure(phase: string) {
  const samples = { list: [] as number[], runner: [] as number[], create: [] as number[], open: [] as number[] };
  const today = seoulDay(new Date());
  const timed = async (key: keyof typeof samples, method: string, path: string, body?: object) => {
    const started = performance.now();
    const result = await h.lead(method, path, body);
    samples[key].push(performance.now() - started);
    expect(result.status, JSON.stringify(result.body)).toBe(key === 'create' ? 201 : 200);
    return result.body;
  };
  // 벽시계 역행과 무관한 단조 시계로 본문 수신까지 잰다. 예열 값을 빼지 않는다.
  for (let i = 0; i < 20; i++) {
    const [list, state, report] = await Promise.all([
      timed('list', 'GET', `/api/projects/${h.project}/tasks`),
      timed('runner', 'GET', '/api/runner-state'),
      timed('create', 'POST', `/api/projects/${h.project}/reports`, { from: today, to: today, view: 'int' }),
    ]);
    expect(list.tasks).toHaveLength(200);
    expect(state.host.hostId).toBeTruthy();
    const opened = await timed('open', 'GET', `/api/reports/${String(report.id)}`);
    expect(opened.snapshot.all).toHaveLength(200);
  }
  for (const [operation, values] of Object.entries(samples)) {
    const sorted = [...values].sort((a, b) => a - b);
    const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
    assert(p95Ms !== undefined);
    const budgetMs = operation === 'list' || operation === 'runner' ? 1000 : 2000;
    metrics.push({ phase, operation, samplesMs: values, p95Ms, budgetMs });
    expect(p95Ms, `${phase} ${operation} p95`).toBeLessThanOrEqual(budgetMs);
  }
}

async function renewAll() {
  await Promise.all(running.map(a => h.runner.api('renewJob', { ...write(), params: { id: a.job.id }, body: { fence: a.job.fence } })));
}

async function release(a: Running, processGroup = a.processGroup) {
  return h.runner.api('releaseJob', { ...write(), params: { id: a.job.id }, body: { fence: a.job.fence, hostId: h.runner.hostId,
    proof: { kind: 'group_empty', bootId: a.bootId, processGroup }, at: new Date().toISOString() } });
}

async function noInventedResults(reason: string) {
  expect(await h.rows('select status,failure->>$$reason$$ reason from task_attempts order by attempt_no')).toEqual(
    Array.from({ length: 24 }, () => ({ status: 'interrupted', reason })));
  expect(await h.rows('select count(*)::int n from verifications')).toEqual([{ n: 0 }]);
  expect(await h.rows("select count(*)::int n from runner_jobs where state in ('leased','started')")).toEqual([{ n: 0 }]);
}

test('200 Task·24세션: 중복 요청·32개 동시 claim·시작 재전송에도 중복 실행 0이고 p95 목표를 지킨다', async () => {
  const a = running[0]; assert(a);
  const repeated = await Promise.all(Array.from({ length: 8 }, () => h.runner.api('startJob', { ...write(), params: { id: a.job.id },
    body: { fence: a.job.fence, hostId: h.runner.hostId, bootId: a.bootId, headSha: a.headSha, installedSubagents: [] } })));
  expect(repeated.every(r => r.body.attemptId === a.attemptId)).toBe(true);
  expect(await h.runner.startNext(undefined, 48)).toBeUndefined();
  expect(await h.rows('select count(*)::int n from task_attempts')).toEqual([{ n: 24 }]);
  await measure('24세션 보유 상태');
});

test('DB 강제 재시작: 실행·보유를 보존하고 영속 outbox 결과를 재전송해도 후속 QA는 하나다', async () => {
  const a = running[0]; assert(a);
  const home = await mkdtemp(join(tmpdir(), 'awbs-m802-outbox-'));
  let state = await State.open(home);
  let started = false;
  const container = inject('resilienceContainer');
  try {
    await state.update(d => { d.epoch = 1; });
    await h.runner.api('releaseJobSlots', { ...write(), params: { id: a.job.id }, body: { fence: a.job.fence, hostId: h.runner.hostId,
      proof: { kind: 'group_empty', bootId: a.bootId, processGroup: a.processGroup }, at: new Date().toISOString() } });
    const check = await h.runner.api('startCiRun', { ...write(), body: { jobId: a.job.id, fence: a.job.fence, stage: 'task', taskKey: a.job.payload.taskKey,
      attemptId: a.attemptId, ref: a.job.payload.branch, trigger: 'fixture', pipelineSha: 'c'.repeat(40), headSha: a.headSha } });
    for (const status of ['run', 'pass'] as const) await h.runner.api('updateCiRun', { ...write(), params: { id: check.body.id }, body: { fence: a.job.fence, status } });
    let tick = 0;
    let outbox = new Outbox(state, h.runner.api, { monotonic: () => tick, random: () => 0 });
    await outbox.enqueue('reportAttemptResult', { epoch: 1, params: { attemptId: a.attemptId }, body: { fence: a.job.fence,
      summary: 'DB 장애 전 저장한 결과', changedFiles: ['src/result.ts'], evidence: [] } });
    const before = await h.rows('select id,fence,state from runner_jobs order by id');
    const transaction = await h.pool.connect();
    try {
      await transaction.query('begin');
      await transaction.query('select public.lock_epoch(1)');
      await transaction.query("update tasks set title='커밋 전 변경' where task_key='TASK-0200'");
      await docker('docker', ['stop', '--timeout', '0', container]);
    } finally { transaction.release(true); }
    expect((await h.lead('GET', `/api/projects/${h.project}/tasks`)).status).toBe(503);
    await outbox.flush();
    expect(outbox.pending).toHaveLength(1);
    await state.close();
    state = await State.open(home);
    expect(state.snapshot.outbox).toHaveLength(1);
    await docker('docker', ['start', container]); started = true;
    await expect.poll(async () => (await h.lead('GET', `/api/projects/${h.project}/tasks`)).status, { timeout: 30_000, interval: 100 }).toBe(200);
    expect(await h.rows('select id,fence,state from runner_jobs order by id')).toEqual(before);
    expect(await h.rows("select title from tasks where task_key='TASK-0200'")).toEqual([{ title: '부하 작업 200' }]);
    await renewAll();
    // 서버 커밋 직후 응답만 잃는다. 같은 멱등 키로 다시 보내도 결과와 QA를 두 번 만들면 안 된다.
    let lost = false;
    const transport: ApiClient = async (operation, request) => {
      const response = await h.runner.api(operation, request);
      if (operation === 'reportAttemptResult' && !lost) { lost = true; throw new ApiTransportError(operation); }
      return response;
    };
    outbox = new Outbox(state, transport, { monotonic: () => tick, random: () => 0 });
    await expect.poll(async () => { tick += 60_001; await outbox.flush(); return lost; }, { timeout: 10_000 }).toBe(true);
    expect(outbox.pending).toHaveLength(1);
    tick += 60_001; await outbox.flush();
    expect(outbox.pending).toEqual([]);
    expect(outbox.rejected).toEqual([]);
    expect(await h.rows("select count(*)::int n from task_attempts where status='completed'")).toEqual([{ n: 1 }]);
    expect(await h.rows("select count(*)::int n from runner_jobs where payload->>'kind'='qa'")).toEqual([{ n: 1 }]);
    expect(await h.rows("select count(*)::int n from execution_holds where slot_state='active' and closed_at is null")).toEqual([{ n: 23 }]);
    expect(await h.rows('select count(*)::int n from task_attempts')).toEqual([{ n: 24 }]);
    await measure('DB 재시작 뒤');
  } finally {
    if (!started) await docker('docker', ['start', container]);
    await state.close(); await rm(home, { recursive: true, force: true });
  }
});

test('Runner SIGKILL: 자손 종료 증거 전 재개 금지·24개 결과 모름·복구 뒤 잠금과 슬롯 정리', async () => {
  const a = running[0]; assert(a);
  const home = await mkdtemp(join(tmpdir(), 'awbs-m802-kill-'));
  const identity = { hostId: h.runner.hostId, bootId: a.bootId };
  const launches = new Launches(home, identity);
  await h.runner.api('releaseJobSlots', { ...write(), params: { id: a.job.id }, body: { fence: a.job.fence, hostId: h.runner.hostId,
    proof: { kind: 'group_empty', bootId: a.bootId, processGroup: a.processGroup }, at: new Date().toISOString() } });
  await h.runner.api('acquireJobSlots', { ...write(), params: { id: a.job.id }, body: { fence: a.job.fence, hostId: h.runner.hostId } });
  const child = spawn(process.execPath, [join(import.meta.dirname, '../../../agent-runner/test/exec/kill-worker.ts'), home, 'exec',
    JSON.stringify({ identity, job: { id: a.job.id, fence: a.job.fence, epoch: 1 } })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
  const exited = once(child, 'exit');
  try {
    const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`Runner가 준비 전에 종료됐습니다: ${errors}`); })]);
    const { record } = message as { record: LaunchRecord };
    assert(record.pgid);
    await h.runner.api('reportJobProcess', { ...write(), params: { id: a.job.id }, body: { fence: a.job.fence, processGroup: record.pgid, cgroup: null } });
    await expect.poll(() => readFile(join(home, 'ran'), 'utf8'), { timeout: 10_000 }).toBe('ran');
    child.kill('SIGKILL'); await exited;
    expect(child.signalCode).toBe('SIGKILL');
    expect(await processGroupEmpty(record.pgid)).toBe(false);
    await h.watchDisconnected();
    await noInventedResults('unknown');
    expect(await h.rows("select count(*)::int n,sum(slots)::int slots from execution_holds where slot_state='unconfirmed' and closed_at is null")).toEqual([{ n: 24, slots: 24 }]);
    await Promise.all(running.filter(r => r !== a).map(r => release(r)));
    expect(await h.rows("select count(*)::int n,sum(slots)::int slots from execution_holds where closed_at is null")).toEqual([{ n: 1, slots: 1 }]);
    const detail = await h.lead('GET', `/api/tasks/${a.job.payload.taskKey}`);
    const refused = await h.lead('POST', `/api/attempts/${a.attemptId}/resume`, { updatedAt: detail.body.updatedAt });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'CLAIM_REJECTED', details: { reasons: expect.arrayContaining(['종료를 확인하지 못한 보유가 있습니다.']) } });
    expect(refused.body.error.details.reasons).not.toContain('전체 실행 상한 또는 Runner 한도를 넘습니다.');
    const proof = await launches.reconcile({ job: a.job.id, ...identity, processGroup: record.pgid, cgroup: null });
    expect(proof).toMatchObject({ kind: 'group_empty', processGroup: record.pgid }); assert(proof);
    expect(await processGroupEmpty(record.pgid)).toBe(true);
    await release(a, record.pgid); await launches.complete(record.launchId, proof);
    expect(await h.rows('select count(*)::int n from execution_holds where closed_at is null')).toEqual([{ n: 0 }]);
    await expect(h.runner.api('reportAttemptResult', { ...write(), params: { attemptId: a.attemptId }, body: { fence: a.job.fence + 1, summary: '잘못된 번호표', changedFiles: [], evidence: [] } })).rejects.toMatchObject({ status: 409, error: { code: 'LEASE_LOST' } });
    expect(await h.rows("select count(*)::int n from task_history where kind='중단 뒤 결과 수신'")).toEqual([{ n: 0 }]);
    const late = { ...write(), params: { attemptId: a.attemptId }, body: { fence: a.job.fence, summary: '낡은 결과', changedFiles: [], evidence: [] } };
    for (let i = 0; i < 2; i++) await expect(h.runner.api('reportAttemptResult', late)).rejects.toMatchObject({ status: 409, error: { code: 'ATTEMPT_CLOSED' } });
    expect(await h.rows("select ref from task_history where kind='중단 뒤 결과 수신'")).toEqual([{ ref: { attemptId: a.attemptId, summary: '낡은 결과' } }]);
    await noInventedResults('unknown');
    const current = await h.lead('GET', `/api/tasks/${a.job.payload.taskKey}`);
    expect((await h.lead('POST', `/api/attempts/${a.attemptId}/resume`, { updatedAt: current.body.updatedAt })).status).toBe(202);
    const next = await Promise.all([h.runner.startNext(undefined, 48), h.runner.startNext(undefined, 48)]);
    const resumed = next.find(r => r?.job.payload.taskKey === a.job.payload.taskKey); assert(resumed);
    expect(resumed.attemptId).not.toBe(a.attemptId);
    expect(await h.rows(`select resumed_from from task_attempts where id='${resumed.attemptId}'`)).toEqual([{ resumed_from: a.attemptId }]);
    expect(await h.rows("select count(*)::int n from task_attempts where status='running'")).toEqual([{ n: 2 }]);
    await measure('Runner kill 복구 뒤');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    for (const record of await launches.list()) if (!record.completedAt) await launches.retire(record);
    await rm(home, { recursive: true, force: true });
  }
});

test('PC 변경: 옛 24세션을 결과 모름으로 닫고 이전 보유를 보존하며 외부 쓰기는 계속 차단한다', async () => {
  const old = running[0]; assert(old);
  await h.runner.api('releaseJobSlots', { ...write(), params: { id: old.job.id }, body: { fence: old.job.fence, hostId: h.runner.hostId,
    proof: { kind: 'group_empty', bootId: old.bootId, processGroup: old.processGroup }, at: new Date().toISOString() } });
  await h.rows(`insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key)
    select id,'integrate','{"pr":1,"commit":"${'a'.repeat(40)}"}','queued',1,'m802-external-'||n from projects cross join generate_series(1,2) n`);
  const claimed = await h.runner.api('claimJob', { ...write(), body: { kinds: ['integrate'], capacity: 48 } });
  assert(claimed.status === 200);
  const external = claimed.body.job;
  await h.runner.api('startJob', { ...write(), params: { id: external.id }, body: { fence: external.fence, hostId: h.runner.hostId,
    bootId: old.bootId, headSha: old.headSha, installedSubagents: [] } });
  // 24개 슬롯을 이미 쓰므로 두 번째 외부 작업은 대기한다.
  expect((await h.runner.api('claimJob', { ...write(), body: { kinds: ['integrate'], capacity: 48 } })).status).toBe(204);
  const changed = await h.runner.api('reportHost', { ...write(), body: { hostId: 'm802-new-pc', bootId: 'new-boot', cpu: 'fake', cores: 64, memGB: 128, swapGB: 0, diskFreeGB: 100, os: 'fake' } });
  expect(changed.body.hostChanged).toBe(true);
  await noInventedResults('host_changed');
  expect(await h.rows("select count(*)::int n from execution_holds where slot_state='unconfirmed' and lock_state='orphaned' and closed_at is null")).toEqual([{ n: 23 }]);
  expect(await h.rows(`select state from runner_jobs where id='${external.id}'`)).toEqual([{ state: 'reconcile' }]);
  expect(await h.rows("select count(*)::int n from runner_job_events where kind='reconciled'")).toEqual([{ n: 0 }]);
  expect(await h.rows('select host_id,generation,state from external_write_authority')).toEqual([{ host_id: 'm802-new-pc', generation: 2, state: 'blocked' }]);
  await expect(h.runner.api('renewJob', { ...write(), params: { id: old.job.id }, body: { fence: old.job.fence } })).rejects.toMatchObject({ status: 409, error: { code: 'LEASE_LOST' } });
  expect((await h.runner.api('claimJob', { ...write(), body: { kinds: ['integrate'], capacity: 48 } })).status).toBe(204);
  await Promise.all(running.map(a => release(a)));
  await h.runner.api('releaseJob', { ...write(), params: { id: external.id }, body: { fence: external.fence, hostId: h.runner.hostId,
    proof: { kind: 'no_process', bootId: old.bootId }, at: new Date().toISOString() } });
  expect(await h.rows('select count(*)::int n from execution_holds where closed_at is null')).toEqual([{ n: 0 }]);
  expect((await h.runner.api('claimJob', { ...write(), body: { kinds: ['integrate'], capacity: 48 } })).status).toBe(204);
  const state = await h.lead('GET', '/api/runner-state');
  expect(state.body).toMatchObject({ host: { hostId: 'm802-new-pc' }, externalWrite: { state: 'blocked' }, concurrency: { used: { total: 0 } } });
  expect(state.body.hostHistory).toHaveLength(2);
  expect(await h.rows(`select state from runner_jobs where id='${external.id}'`)).toEqual([{ state: 'reconcile' }]);
  await measure('PC 변경 뒤');
});
