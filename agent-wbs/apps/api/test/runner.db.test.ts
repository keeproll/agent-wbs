import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test, vi } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import { inEpoch } from '../src/platform/transaction.ts';
import { watchRunner } from '../src/runner/watch.ts';
import { grantExternalAfterReconcile, handover, retryFailedAttempt } from '../src/runner/service.ts';
import { installRunner } from '../src/runner/routes.ts';
import { required, RunnerRepository } from '../src/runner/repository.ts';

// test:db가 안전성을 확인한 주소에서 이 파일 전용 DB를 만든다. 주소가 없으면 준비 단계에서 실패한다.
describe('runner 실제 PostgreSQL 검증', () => {
  const dbUrl = new URL(inject('testDatabaseUrl'));
  dbUrl.pathname += '_runner';
  const url = dbUrl.href;
  const owner = createPool(url, { onError: () => undefined });
  const appUrl = new URL(url);
  appUrl.searchParams.set('options', '-c role=awbs_app');
  const pool = createPool(appUrl.href, { onError: () => undefined });
  const app = buildApp(pool);
  installRunner(app, pool);
  const origin = 'http://127.0.0.1:3100';
  const sha = 'a'.repeat(40);
  let bearer: string, cookie: string, csrf: string, project: string, wp: string;
  let sequence = 0;
  const headers = () => ({ authorization: `Bearer ${bearer}`, 'x-project-epoch': '1', 'idempotency-key': randomUUID() });
  const lead = () => ({ cookie, origin, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() });
  const post = (path: string, payload: object) => app.inject({ method: 'POST', url: `/api/runner/${path}`, headers: headers(), payload });
  const now = () => new Date().toISOString();
  async function task(group: string | null = null) {
    const key = `TASK-${String(++sequence).padStart(4, '0')}`;
    const row = (await owner.query(`insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state,conflict_group)
      values($1,$2,$3,1,'실행 시험','Implementation','BE','{}',1,'Codex','Codex','ready','none',$4) returning id`, [project, key, wp, group])).rows[0] as { id: string };
    await owner.query("insert into task_specs(project_id,task,overview,spec,ac,revision) values($1,$2,'{}','{}','[]',1)", [project, row.id]);
    await owner.query("insert into task_grades(project_id,task,role,model_id,effort,reason,locked,effective_from) values($1,$2,'dev','gpt-6.1-sol','high','시험',false,now()),($1,$2,'qa','gpt-6.1-sol','high','시험',false,now())", [project, row.id]);
    return { id: row.id, key };
  }
  async function request(key: string, kind = 'dev') {
    const version = (await owner.query("select to_char(updated_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as v from tasks where task_key=$1", [key])).rows[0] as { v: string };
    return app.inject({ method: 'POST', url: `/api/tasks/${key}/runs`, headers: lead(), payload: { updatedAt: version.v, kind } });
  }
  async function claim(kinds = ['attempt']) {
    return post('jobs/claim', { kinds, capacity: 20 });
  }
  async function claimed(group: string | null = null) {
    const t = await task(group);
    const requested = await request(t.key);
    expect(requested.statusCode, requested.body).toBe(202);
    const r = await claim();
    expect(r.statusCode, r.body).toBe(200);
    return { t, job: r.json<{ job: { id: string; fence: number } }>().job };
  }
  const start = (job: { id: string; fence: number }, extra = {}) => post(`jobs/${job.id}/start`, { fence: job.fence, hostId: 'host-a', bootId: 'boot-a', headSha: sha, installedSubagents: [], ...extra });
  async function hold(job: string) { return (await owner.query('select * from execution_holds where job=$1', [job])).rows[0]; }
  async function release(job: { id: string; fence: number }, proof: object, slots = false) {
    return post(`jobs/${job.id}/${slots ? 'slots/release' : 'release'}`, { fence: job.fence, hostId: 'host-a', proof, at: now() });
  }
  beforeAll(async () => {
    await recreateTestDatabase(url);
    await runMigrations(owner);
    await seedSystem(owner);
    bearer = await issueRunnerToken(pool, 'runner-test', 'fake');
    const token = await issueLoginLink(pool);
    const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
    cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
  });
  beforeEach(async () => {
    // 초기화 서비스 대신 전용 DB의 시험 자료만 비운다. 불변 기록 트리거도 이 시험 연결에서만 우회한다.
    await owner.query("set session_replication_role=replica");
    await owner.query("truncate projects, runner_jobs, execution_holds, task_attempts, task_specs, task_grades, tasks, wbs_nodes, task_history, runner_job_events, runner_sessions, runner_hosts, runner_concurrency_log, runner_readiness, agent_usage, agent_models, idempotency_keys, external_write_authority cascade");
    await owner.query("set session_replication_role=origin");
    await owner.query("update system_state set cleanup_status='none' where id=1");
    project = ((await owner.query("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('시험','https://github.com/test/runner','test','runner','','active') returning id")).rows[0] as { id: string }).id;
    await owner.query("insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,1,$2,'[]','[]','[]','')", [project,sha]);
    const phase = ((await owner.query("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH-1','phase','단계',1) returning id", [project])).rows[0] as { id: string }).id;
    wp = ((await owner.query("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP-1','work_package',$2,'묶음',1) returning id", [project, phase])).rows[0] as { id: string }).id;
    expect((await post('host', { hostId: 'host-a', bootId: 'boot-a', cpu: 'fake', cores: 20, memGB: 32, swapGB: 0, diskFreeGB: 100, os: 'fake' })).statusCode).toBe(200);
    await post('models', { agent: 'Codex', models: [{ id: 'gpt-6.1-sol', label: '시험', efforts: ['high', 'xhigh', 'max'] }] });
    await owner.query("update agent_models set allowed=true where agent='Codex' and model_id='gpt-6.1-sol'");
    await post('readiness', { at: now(), items: ['codex','git','node','pnpm','pg','repo','disk','subs'].map(key => ({ key, status: 'ok', detail: '' })) });
    await post('usage', { agent: 'Codex', remainPct: 100, resetAt: now() });
  });
  afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

  test('holds 조회는 현재 principal·epoch의 미해제 보유만 읽으며 fence·lease를 보존한다', async () => {
    const { job } = await claimed();
    const before = await hold(job.id);
    const beforeJob = (await owner.query('select state,fence,lease_until,updated_at from runner_jobs where id=$1', [job.id])).rows;
    const otherToken = await issueRunnerToken(pool, 'runner-other', 'fake');
    const response = await app.inject({ url: '/api/runner/holds', headers: headers() });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().holds).toMatchObject([{ job: job.id, fence: job.fence, host_id: 'host-a', boot_id: 'boot-a', slot_state: 'reserved', lease_owner: expect.stringMatching(/^runner:/), lease_until: expect.any(String) }]);
    expect(await hold(job.id)).toEqual(before);
    expect((await owner.query('select state,fence,lease_until,updated_at from runner_jobs where id=$1', [job.id])).rows).toEqual(beforeJob);
    const other = await app.inject({ url: '/api/runner/holds', headers: { ...headers(), authorization: `Bearer ${otherToken}` } });
    expect(other.statusCode, other.body).toBe(200);
    expect(other.json()).toEqual({ holds: [] });
    await owner.query('set session_replication_role=replica');
    try { await owner.query('update execution_holds set epoch=0 where job=$1', [job.id]); }
    finally { await owner.query('set session_replication_role=origin'); }
    expect((await app.inject({ url: '/api/runner/holds', headers: headers() })).json()).toEqual({ holds: [] });
  });

  test('review: 준비 중 서버 등급이 바뀌면 이전 등급 CLI 실행을 거부해야 한다', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { createApiClient } = await import('../../../../agent-runner/src/api/client.ts');
    const { Outbox } = await import('../../../../agent-runner/src/api/outbox.ts');
    const { Secret } = await import('../../../../agent-runner/src/security/secret.ts');
    const { State } = await import('../../../../agent-runner/src/state/state.ts');
    const { Execution } = await import('../../../../agent-runner/src/exec/session.ts');
    const { HeavySemaphore } = await import('../../../../agent-runner/src/resources/heavy.ts');
    const { ResourceReporter } = await import('../../../../agent-runner/src/resources/reporter.ts');
    const { installFakeCli } = await import('../../../../agent-runner/test/fakes/cli.ts');
    const t = await task();
    const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'fix1-review-grade-'));
    const state = await State.open(home);
    await state.update(d => { d.epoch = 1; });
    const fake = installFakeCli(join(home, 'fake'), 'codex', { lines: [{ type: 'thread.started', thread_id: 'new-thread' }, { type: 'turn.completed', usage: {} }] });
    const api = createApiClient({ baseUrl: 'http://fake.invalid', token: new Secret(bearer), fetch: async (input, init) => {
      const u = new URL(String(input));
      const r = await app.inject({ method: init?.method as 'GET' | 'POST', url: u.pathname + u.search, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body && { payload: String(init.body) }) });
      return new Response(r.statusCode === 204 ? null : r.body, { status: r.statusCode, headers: r.headers as Record<string, string> });
    } });
    const reporter = new ResourceReporter({ api, epoch: () => 1, heavy: new HeavySemaphore(1) });
    await reporter.reportHost({ hostId: 'host-a', bootId: 'boot-a', cpu: 'fake', cores: 20, memGB: 32, swapGB: 0, diskFreeGB: 100, os: 'fake' });
    const exec = new Execution({ canStart: (agent, slots, local) => reporter.canStart(agent, slots, local), home, identity: { hostId: 'host-a', bootId: 'boot-a' }, api, outbox: new Outbox(state, api), epoch: () => 1, ready: () => true, env: { PATH: process.env.PATH }, binaries: { Codex: fake.path, Claude: fake.path }, prepare: async () => {
      await owner.query("update task_grades set effort='max' where task=$1 and role='dev'", [t.id]);
      return { cwd: home, headSha: sha };
    }, budget: () => 0, sessions: [], heavy: new HeavySemaphore(1), isolation: { name: 'fake', flags: () => [], wrap: l => l } });
    try {
      await exec.recover();
      expect((await request(t.key)).statusCode).toBe(202);
      const claimResponse = await claim();
      expect(claimResponse.statusCode).toBe(200);
      const job = claimResponse.json().job;
      const fullJob = (await owner.query('select * from runner_jobs where id=$1', [job.id])).rows[0];
      await expect(exec.run({ ...job, kind: 'attempt', payload: fullJob.payload, leaseUntil: fullJob.lease_until.toISOString() })).rejects.toMatchObject({ error: { code: 'CLAIM_REJECTED' } });
      expect((await owner.query('select effort,status from task_attempts where job=$1', [job.id])).rows).toEqual([{ effort: 'max', status: 'interrupted' }]);
      expect((await hold(job.id)).closed_at).not.toBeNull();
      expect(fake.calls()).toHaveLength(0);
    } finally { await exec.shutdown(); await state.close(); await rm(home, { recursive: true, force: true }); }
  });

  test.each(['before', 'after-process'])('review2: 미보고 메모리 보류를 ① 명령에 적용하고 슬롯을 정리한다(%s)', async stage => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { createApiClient } = await import('../../../../agent-runner/src/api/client.ts');
    const { Outbox } = await import('../../../../agent-runner/src/api/outbox.ts');
    const { Secret } = await import('../../../../agent-runner/src/security/secret.ts');
    const { State } = await import('../../../../agent-runner/src/state/state.ts');
    const { Execution } = await import('../../../../agent-runner/src/exec/session.ts');
    const { HeavySemaphore } = await import('../../../../agent-runner/src/resources/heavy.ts');
    const { ResourceReporter } = await import('../../../../agent-runner/src/resources/reporter.ts');
    const { installFakeCli } = await import('../../../../agent-runner/test/fakes/cli.ts');
    const t = await task();
    const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'fix2-review-grade-'));
    const state = await State.open(home);
    await state.update(d => { d.epoch = 1; });
    const fake = installFakeCli(join(home, 'fake'), 'codex', { lines: [{ type: 'thread.started', thread_id: 'new-thread' }, { type: 'turn.completed', usage: {} }] });
    let commandPhase = false;
    const api = createApiClient({ baseUrl: 'http://fake.invalid', token: new Secret(bearer), fetch: async (input, init) => {
      const u = new URL(String(input));
      const r = await app.inject({ method: init?.method as 'GET' | 'POST', url: u.pathname + u.search, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body && { payload: String(init.body) }) });
      if (commandPhase && stage === 'after-process' && u.pathname.endsWith('/process')) reporter.observe({ cpuPct: 1, memFreeGB: 0, swapUsedGB: 0 });
      return new Response(r.statusCode === 204 ? null : r.body, { status: r.statusCode, headers: r.headers as Record<string, string> });
    } });
    const reporter = new ResourceReporter({ api, epoch: () => 1, heavy: new HeavySemaphore(1) });
    await reporter.reportHost({ hostId: 'host-a', bootId: 'boot-a', cpu: 'fake', cores: 20, memGB: 32, swapGB: 0, diskFreeGB: 100, os: 'fake' });
    const exec = new Execution({ canStart: (agent, slots, local) => reporter.canStart(agent, slots, local), home, identity: { hostId: 'host-a', bootId: 'boot-a' }, api, outbox: new Outbox(state, api), epoch: () => 1, ready: () => true, env: { PATH: process.env.PATH }, binaries: { Codex: fake.path, Claude: fake.path }, prepare: async () => {
      return { cwd: home, headSha: sha };
    }, budget: () => 0, sessions: [], heavy: new HeavySemaphore(1), isolation: { name: 'fake', flags: () => [], wrap: l => l } });
    try {
      await exec.recover();
      expect((await request(t.key)).statusCode).toBe(202);
      const claimResponse = await claim();
      expect(claimResponse.statusCode).toBe(200);
      const job = claimResponse.json().job;
      const fullJob = (await owner.query('select * from runner_jobs where id=$1', [job.id])).rows[0];
      const result = await exec.run({ ...job, kind: 'attempt', payload: fullJob.payload, leaseUntil: fullJob.lease_until.toISOString() });
      expect(result.ok).toBe(true);
      commandPhase = true;
      if (stage === 'before') reporter.observe({ cpuPct: 1, memFreeGB: 0, swapUsedGB: 0 });
      await expect(exec.command({ id: job.id, fence: job.fence, epoch: 1 }, 'Codex', { file: fake.path, args: [], cwd: home, env: {}, stdin: '① 검사' })).rejects.toThrow('memory_pressure');
      expect(reporter.canStart('Codex', 1, [])).toMatchObject({ ok: false, reason: 'memory_pressure' });
      expect(fake.calls()).toHaveLength(1);
      expect((await hold(job.id)).slot_state).toBe('none');
    } finally { await exec.shutdown(); await state.close(); await rm(home, { recursive: true, force: true }); }
  });

  test('review3: process 등록이 거부돼도 서버 슬롯은 종료 증명으로 반환해야 한다', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { createApiClient } = await import('../../../../agent-runner/src/api/client.ts');
    const { Outbox } = await import('../../../../agent-runner/src/api/outbox.ts');
    const { Secret } = await import('../../../../agent-runner/src/security/secret.ts');
    const { State } = await import('../../../../agent-runner/src/state/state.ts');
    const { Execution } = await import('../../../../agent-runner/src/exec/session.ts');
    const { HeavySemaphore } = await import('../../../../agent-runner/src/resources/heavy.ts');
    const { ResourceReporter } = await import('../../../../agent-runner/src/resources/reporter.ts');
    const { installFakeCli } = await import('../../../../agent-runner/test/fakes/cli.ts');
    const t = await task();
    const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'review3-release-reject-'));
    const state = await State.open(home);
    await state.update(d => { d.epoch = 1; });
    const fake = installFakeCli(join(home, 'fake'), 'codex', { lines: [{ type: 'thread.started', thread_id: 'new-thread' }, { type: 'turn.completed', usage: {} }] });
    let commandPhase = false;
    const failures: unknown[] = [];
    const heavy = new HeavySemaphore(1);
    const api = createApiClient({ baseUrl: 'http://fake.invalid', token: new Secret(bearer), fetch: async (input, init) => {
      const u = new URL(String(input));
      if (commandPhase && u.pathname.endsWith('/process')) await owner.query("update runner_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [u.pathname.split('/').at(-2)]);
      const r = await app.inject({ method: init?.method as 'GET' | 'POST', url: u.pathname + u.search, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body && { payload: String(init.body) }) });
      if (commandPhase && r.statusCode >= 400) failures.push({ path: u.pathname, status: r.statusCode, body: r.body, request: String(init?.body) });
      return new Response(r.statusCode === 204 ? null : r.body, { status: r.statusCode, headers: r.headers as Record<string, string> });
    } });
    const reporter = new ResourceReporter({ api, epoch: () => 1, heavy: new HeavySemaphore(1) });
    await reporter.reportHost({ hostId: 'host-a', bootId: 'boot-a', cpu: 'fake', cores: 20, memGB: 32, swapGB: 0, diskFreeGB: 100, os: 'fake' });
    const exec = new Execution({ canStart: (agent, slots, local) => reporter.canStart(agent, slots, local), home, identity: { hostId: 'host-a', bootId: 'boot-a' }, api, outbox: new Outbox(state, api), epoch: () => 1, ready: () => true, env: { PATH: process.env.PATH }, binaries: { Codex: fake.path, Claude: fake.path }, prepare: async () => {
      return { cwd: home, headSha: sha };
    }, budget: () => 0, sessions: [], heavy, isolation: { name: 'fake', flags: () => [], wrap: l => l } });
    try {
      await exec.recover();
      expect((await request(t.key)).statusCode).toBe(202);
      const claimResponse = await claim();
      expect(claimResponse.statusCode).toBe(200);
      const job = claimResponse.json().job;
      const fullJob = (await owner.query('select * from runner_jobs where id=$1', [job.id])).rows[0];
      const result = await exec.run({ ...job, kind: 'attempt', payload: fullJob.payload, leaseUntil: fullJob.lease_until.toISOString() });
      expect(result.ok).toBe(true);
      expect((await hold(job.id)).slot_state).toBe('none');
      commandPhase = true;
      let error: unknown;
      try { await exec.command({ id: job.id, fence: job.fence, epoch: 1 }, 'Codex', { file: fake.path, args: [], cwd: home, env: {}, stdin: '① 검사' }); }
      catch (e) { error = e; }
      const after = await hold(job.id);
      expect(error).toMatchObject({ error: { code: 'LEASE_LOST' } });
      expect(failures).toMatchObject([{ status: 409, body: expect.stringContaining('LEASE_LOST') }]);
      expect(fake.calls()).toHaveLength(1);
      expect(heavy.snapshot().running).toBe(0);
      expect(after.slot_state).toBe('none');
    } finally { await exec.shutdown(); await state.close(); await rm(home, { recursive: true, force: true }); }
  });

  const releaseCases = [
    ...(['reserved', 'running', 'stopping', 'unregistered-stopping'] as const).flatMap(stage =>
      (['reject', 'failure', 'cancel', 'crash'] as const).map(cause => ({ stage, cause }))),
    { stage: 'running', cause: 'lost-response' } as const,
  ];
  test.each(releaseCases)('review3 matrix: $stage × $cause', async ({ stage, cause }) => {
    const unregistered = stage === 'reserved' || stage === 'unregistered-stopping';
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { setTimeout: sleep } = await import('node:timers/promises');
    const { createApiClient, ApiTransportError } = await import('../../../../agent-runner/src/api/client.ts');
    const { Outbox } = await import('../../../../agent-runner/src/api/outbox.ts');
    const { Secret } = await import('../../../../agent-runner/src/security/secret.ts');
    const { State } = await import('../../../../agent-runner/src/state/state.ts');
    const { Execution } = await import('../../../../agent-runner/src/exec/session.ts');
    const { HeavySemaphore } = await import('../../../../agent-runner/src/resources/heavy.ts');
    const { ResourceReporter } = await import('../../../../agent-runner/src/resources/reporter.ts');
    const { installFakeCli } = await import('../../../../agent-runner/test/fakes/cli.ts');
    const taskRow = await task();
    const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'fix3-matrix-'));
    const state = await State.open(home); await state.update(d => { d.epoch = 1; });
    const fake = installFakeCli(join(home, 'fake'), 'codex');
    const controller = new AbortController(), heavy = new HeavySemaphore(1);
    let phase = false, currentJob = '', watched = false;
    const releases: { state: string; pgid: number | null; kind: string; group?: number; status: number }[] = [];
    const transport = createApiClient({ baseUrl: 'http://fake.invalid', token: new Secret(bearer), fetch: async (input, init) => {
      const u = new URL(String(input));
      const releasing = phase && /\/(slots\/release|release)$/.test(u.pathname);
      if (phase && stage === 'stopping' && !watched && (releasing || cause === 'crash' && u.pathname.endsWith('/holds'))) {
        watched = true;
        await owner.query("update runner_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [currentJob]);
        await watchRunner(pool, 1);
      }
      const before = releasing ? await hold(currentJob) : undefined;
      const r = await app.inject({ method: init?.method as 'GET' | 'POST', url: u.pathname + u.search, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body && { payload: String(init.body) }) });
      if (before && before.slot_state !== 'none') {
        const proof = (JSON.parse(String(init?.body)) as { proof: { kind: string; processGroup?: number } }).proof;
        releases.push({ state: before.slot_state, pgid: before.pgid, kind: proof.kind, ...(proof.processGroup !== undefined && { group: proof.processGroup }), status: r.statusCode });
      }
      return new Response(r.statusCode === 204 ? null : r.body, { status: r.statusCode, headers: r.headers as Record<string, string> });
    } });
    const reporter = new ResourceReporter({ api: transport, epoch: () => 1, heavy });
    const api: typeof transport = async (operation, request) => {
      if (phase && operation === 'reportJobProcess' && unregistered) {
        if (stage === 'unregistered-stopping' && !watched) {
          watched = true;
          await owner.query("update runner_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [currentJob]);
          await watchRunner(pool, 1);
          expect(await hold(currentJob)).toMatchObject({ slot_state: 'unconfirmed', pgid: null });
        }
        if (cause === 'failure') throw new Error('REGISTER_IO_FAILED');
        if (cause === 'cancel') { controller.abort(); throw controller.signal.reason; }
        if (!watched) await owner.query("update runner_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [currentJob]);
      }
      const response = await transport(operation, request);
      if (phase && operation === 'reportJobProcess' && !unregistered) {
        if (cause === 'lost-response') {
          expect(response.status).toBe(204);
          expect(await hold(currentJob)).toMatchObject({ slot_state: 'active', pgid: expect.any(Number) });
          controller.abort(); throw new ApiTransportError('reportJobProcess');
        }
        if (cause === 'reject') reporter.observe({ cpuPct: 1, memFreeGB: 0, swapUsedGB: 0 });
        if (cause === 'cancel') controller.abort();
      }
      return response;
    };
    await reporter.reportHost({ hostId: 'host-a', bootId: 'boot-a', cpu: 'fake', cores: 20, memGB: 32, swapGB: 0, diskFreeGB: 100, os: 'fake' });
    const outbox = new Outbox(state, api);
    const exec = new Execution({ canStart: (agent, slots, local) => reporter.canStart(agent, slots, local), home, identity: { hostId: 'host-a', bootId: 'boot-a' }, api, outbox, epoch: () => 1, ready: () => true, env: { PATH: process.env.PATH }, binaries: { Codex: fake.path, Claude: fake.path }, prepare: async () => ({ cwd: home, headSha: sha }), budget: () => 0, sessions: [], heavy, isolation: { name: 'fake', flags: () => [], wrap: l => l } });
    let runner: ReturnType<typeof spawn> | undefined;
    try {
      await exec.recover();
      expect((await request(taskRow.key)).statusCode).toBe(202);
      const claimResponse = await exec.claim(6);
      if (!claimResponse || claimResponse.kind !== 'attempt') throw new Error('작업을 받지 못했습니다.');
      currentJob = claimResponse.id;
      expect((await exec.run(claimResponse)).ok).toBe(true);
      expect((await hold(currentJob)).slot_state).toBe('none');
      phase = true;
      installFakeCli(join(home, 'fake'), 'codex', { exitCode: 17, lines: [] });
      if (cause === 'crash') {
        expect((await post(`jobs/${currentJob}/slots/acquire`, { fence: claimResponse.fence, hostId: 'host-a' })).statusCode).toBe(204);
        runner = spawn(process.execPath, [join(import.meta.dirname, '../../../../agent-runner/test/exec/kill-worker.ts'), home, unregistered ? 'record' : 'exec', JSON.stringify({ identity: { hostId: 'host-a', bootId: 'boot-a' }, job: { id: currentJob, fence: claimResponse.fence, epoch: 1 } })], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        const exited = once(runner, 'exit');
        const [message] = await once(runner, 'message');
        const record = (message as { record: { pgid: number } }).record;
        if (!unregistered) {
          expect((await post(`jobs/${currentJob}/process`, { fence: claimResponse.fence, processGroup: record.pgid, cgroup: null })).statusCode).toBe(204);
          for (let i = 0; i < 200 && !await readFile(join(home, 'ran'), 'utf8').catch(() => ''); i++) await sleep(10);
          expect(await readFile(join(home, 'ran'), 'utf8')).toBe('ran');
        }
        if (stage === 'stopping' || stage === 'unregistered-stopping') {
          watched = true;
          await owner.query("update runner_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [currentJob]);
          await watchRunner(pool, 1);
        }
        expect((await hold(currentJob)).slot_state).toBe(stage === 'reserved' ? 'reserved' : stage === 'running' ? 'active' : 'unconfirmed');
        if (unregistered) expect((await hold(currentJob)).pgid).toBeNull();
        runner.kill('SIGKILL'); await exited;
        expect(runner.signalCode).toBe('SIGKILL');
        expect(await exec.recover()).toBe(true);
      } else {
        const command = exec.command({ id: currentJob, fence: claimResponse.fence, epoch: 1 }, 'Codex', { file: fake.path, args: [], cwd: home, env: {}, stdin: '' }, controller.signal);
        if (cause === 'failure' && !unregistered) expect((await command).code).toBe(17);
        else if (cause === 'reject' && unregistered) await expect(command).rejects.toMatchObject({ error: { code: 'LEASE_LOST' } });
        else if (cause === 'failure') await expect(command).rejects.toThrow('REGISTER_IO_FAILED');
        else if (cause === 'cancel' || cause === 'lost-response') await expect(command).rejects.toMatchObject({ name: 'AbortError' });
        else await expect(command).rejects.toThrow('memory_pressure');
        expect(fake.calls()).toHaveLength(cause === 'failure' && !unregistered ? 1 : 0);
      }
      const expectedState = cause === 'crash' ? 'unconfirmed' : stage === 'reserved' ? 'reserved' : stage === 'running' ? 'active' : 'unconfirmed';
      expect(releases).toHaveLength(1);
      expect(releases[0]).toMatchObject({ state: expectedState, kind: unregistered ? 'no_process' : 'group_empty', status: 204 });
      if (!unregistered) expect(releases[0]?.group).toBe(releases[0]?.pgid);
      expect((await hold(currentJob)).slot_state).toBe('none');
      expect((await exec.launches.list()).every(r => r.completedAt)).toBe(true);
      expect(heavy.snapshot().running).toBe(0);
    } finally {
      if (runner && runner.exitCode === null && runner.signalCode === null) { const ended = once(runner, 'exit'); runner.kill('SIGKILL'); await ended; }
      for (const record of await exec.launches.list().catch(() => [])) if (!record.completedAt) await exec.launches.reconcile({ job: record.job.id, hostId: record.hostId, bootId: record.bootId, processGroup: record.pgid });
      await exec.shutdown(); await state.close(); await rm(home, { recursive: true, force: true });
    }
  });

  test('review: 아직 서버에 보고하지 않은 예산 초과도 새 세션을 막아야 한다', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { setTimeout: sleep } = await import('node:timers/promises');
    const { createApiClient } = await import('../../../../agent-runner/src/api/client.ts');
    const { Outbox } = await import('../../../../agent-runner/src/api/outbox.ts');
    const { Secret } = await import('../../../../agent-runner/src/security/secret.ts');
    const { State } = await import('../../../../agent-runner/src/state/state.ts');
    const { Execution } = await import('../../../../agent-runner/src/exec/session.ts');
    const { HeavySemaphore } = await import('../../../../agent-runner/src/resources/heavy.ts');
    const { ResourceReporter } = await import('../../../../agent-runner/src/resources/reporter.ts');
    const { installFakeCli } = await import('../../../../agent-runner/test/fakes/cli.ts');
    const previousBudget = (await owner.query('select subagent_budget from concurrency_settings')).rows[0]?.subagent_budget as object;
    await owner.query("update concurrency_settings set subagent_budget='{\"dev\":0,\"qa\":0}'");
    const firstTask = await task(), secondTask = await task();
    const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'fix1-review-budget-'));
    const state = await State.open(home); await state.update(d => { d.epoch = 1; });
    const fake = installFakeCli(join(home, 'fake'), 'codex', { hang: true, lines: [{ type: 'thread.started', thread_id: 'thread' }, { type: 'item.completed', item: { type: 'collab_tool_call', tool: 'spawn_agent', status: 'completed', receiver_thread_ids: ['a','b','c','d','e','f'], agents_states: Object.fromEntries(['a','b','c','d','e','f'].map(id => [id, { status: 'running' }])) } }] });
    const api = createApiClient({ baseUrl: 'http://fake.invalid', token: new Secret(bearer), fetch: async (input, init) => {
      const u = new URL(String(input));
      const r = await app.inject({ method: init?.method as 'GET' | 'POST', url: u.pathname + u.search, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body && { payload: String(init.body) }) });
      return new Response(r.statusCode === 204 ? null : r.body, { status: r.statusCode, headers: r.headers as Record<string, string> });
    } });
    const sessions: import('../../../../agent-runner/src/exec/session.ts').ActiveSession[] = [];
    const reporter = new ResourceReporter({ api, epoch: () => 1, heavy: new HeavySemaphore(1) });
    await reporter.reportHost({ hostId: 'host-a', bootId: 'boot-a', cpu: 'fake', cores: 20, memGB: 32, swapGB: 0, diskFreeGB: 100, os: 'fake' });
    const exec = new Execution({ canStart: (agent, slots, local) => reporter.canStart(agent, slots, local), home, identity: { hostId: 'host-a', bootId: 'boot-a' }, api, outbox: new Outbox(state, api), epoch: () => 1, ready: () => true, env: { PATH: process.env.PATH }, binaries: { Codex: fake.path, Claude: fake.path }, prepare: async () => ({ cwd: home, headSha: sha }), budget: () => 0, sessions, heavy: new HeavySemaphore(1), isolation: { name: 'fake', flags: () => [], wrap: l => l } });
    const running: Promise<unknown>[] = [];
    try {
      await exec.recover();
      expect((await request(firstTask.key)).statusCode).toBe(202);
      expect((await request(secondTask.key)).statusCode).toBe(202);
      const firstJob = await exec.claim(6);
      expect(firstJob?.kind).toBe('attempt');
      running.push(exec.run(firstJob as Parameters<typeof exec.run>[0]));
      for (let i = 0; i < 200 && sessions[0]?.observed !== 6; i++) await sleep(10);
      expect(sessions[0]).toMatchObject({ reserved: 7, observed: 6, state: 'ok' });
      if (!firstJob) throw new Error('첫 job이 없습니다.');
      const storedHold = (await owner.query('select slots from execution_holds where job=$1', [firstJob.id])).rows[0];
      const secondJob = await exec.claim(6);
      if (secondJob?.kind === 'attempt') running.push(exec.run(secondJob));
      for (let i = 0; i < 200 && fake.calls().length < 2; i++) await sleep(10);
      console.log(JSON.stringify({ limit: 6, localHeldBeforeSecondClaim: 7, storedHold, secondJob, actualCliStarts: fake.calls().length }));
      expect(fake.calls()).toHaveLength(1);
    } finally {
      await exec.shutdown(); await Promise.allSettled(running); await state.close();
      await owner.query('update concurrency_settings set subagent_budget=$1::jsonb', [JSON.stringify(previousBudget)]);
      await rm(home, { recursive: true, force: true });
    }
  });

  test('review2: 여유 3자리에서는 3자리 세션을 하나 더 받을 수 있어야 한다', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { setTimeout: sleep } = await import('node:timers/promises');
    const { createApiClient } = await import('../../../../agent-runner/src/api/client.ts');
    const { Outbox } = await import('../../../../agent-runner/src/api/outbox.ts');
    const { Secret } = await import('../../../../agent-runner/src/security/secret.ts');
    const { State } = await import('../../../../agent-runner/src/state/state.ts');
    const { Execution } = await import('../../../../agent-runner/src/exec/session.ts');
    const { HeavySemaphore } = await import('../../../../agent-runner/src/resources/heavy.ts');
    const { ResourceReporter } = await import('../../../../agent-runner/src/resources/reporter.ts');
    const { installFakeCli } = await import('../../../../agent-runner/test/fakes/cli.ts');
    const previousBudget = (await owner.query('select subagent_budget from concurrency_settings')).rows[0]?.subagent_budget as object;
    await owner.query("insert into concurrency_settings(singleton,mode,subagent_budget) values(true,'auto','{\"dev\":2,\"qa\":2}') on conflict(singleton) do update set subagent_budget=excluded.subagent_budget");
    const firstTask = await task(), secondTask = await task(), thirdTask = await task();
    const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'fix2-review-budget-'));
    const state = await State.open(home); await state.update(d => { d.epoch = 1; });
    const fake = installFakeCli(join(home, 'fake'), 'codex', { hang: true, lines: [{ type: 'thread.started', thread_id: 'thread' }] });
    const claimRequests: unknown[] = [];
    const api = createApiClient({ baseUrl: 'http://fake.invalid', token: new Secret(bearer), fetch: async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith('/jobs/claim')) claimRequests.push(JSON.parse(String(init?.body)));
      const r = await app.inject({ method: init?.method as 'GET' | 'POST', url: u.pathname + u.search, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body && { payload: String(init.body) }) });
      return new Response(r.statusCode === 204 ? null : r.body, { status: r.statusCode, headers: r.headers as Record<string, string> });
    } });
    const sessions: import('../../../../agent-runner/src/exec/session.ts').ActiveSession[] = [];
    const reporter = new ResourceReporter({ api, epoch: () => 1, heavy: new HeavySemaphore(1) });
    await reporter.reportHost({ hostId: 'host-a', bootId: 'boot-a', cpu: 'fake', cores: 20, memGB: 32, swapGB: 0, diskFreeGB: 100, os: 'fake' });
    const exec = new Execution({ canStart: (agent, slots, local) => reporter.canStart(agent, slots, local), home, identity: { hostId: 'host-a', bootId: 'boot-a' }, api, outbox: new Outbox(state, api), epoch: () => 1, ready: () => true, env: { PATH: process.env.PATH }, binaries: { Codex: fake.path, Claude: fake.path }, prepare: async () => ({ cwd: home, headSha: sha }), budget: () => 2, sessions, heavy: new HeavySemaphore(1), isolation: { name: 'fake', flags: () => [], wrap: l => l } });
    const running: Promise<unknown>[] = [];
    try {
      await exec.recover();
      expect((await request(firstTask.key)).statusCode).toBe(202);
      expect((await request(secondTask.key)).statusCode).toBe(202);
      expect((await request(thirdTask.key)).statusCode).toBe(202);
      const firstJob = await exec.claim(6);
      expect(firstJob?.kind).toBe('attempt');
      running.push(exec.run(firstJob as Parameters<typeof exec.run>[0]));
      for (let i = 0; i < 200 && fake.calls().length < 1; i++) await sleep(10);
      expect(sessions[0]).toMatchObject({ reserved: 3, observed: 0, state: 'ok' });
      if (!firstJob) throw new Error('첫 job이 없습니다.');
      const storedHold = (await owner.query('select slots from execution_holds where job=$1', [firstJob.id])).rows[0];
      expect(storedHold.slots).toBe(3);
      const localAdmission = reporter.canStart('Codex', 3, sessions);
      expect(localAdmission.ok).toBe(true);
      const secondJob = await exec.claim(6);
      expect(secondJob?.kind).toBe('attempt');
      expect(claimRequests).toMatchObject([{ capacity: 6 }, { capacity: 6 }]);
      if (!secondJob || secondJob.kind !== 'attempt') throw new Error('두 번째 job이 없습니다.');
      running.push(exec.run(secondJob));
      for (let i = 0; i < 200 && fake.calls().length !== 2; i++) await sleep(10);
      expect(fake.calls()).toHaveLength(2);
      expect((await owner.query("select sum(slots)::integer as total from execution_holds where slot_state='active'")).rows).toEqual([{ total: 6 }]);
      expect((await post('jobs/claim', { kinds: ['attempt'], capacity: 6 })).statusCode).toBe(204);
      expect(await exec.claim(6)).toBeNull();
    } finally {
      await exec.shutdown(); await Promise.allSettled(running); await state.close();
      await owner.query('update concurrency_settings set subagent_budget=$1::jsonb', [JSON.stringify(previousBudget ?? { dev: 0, qa: 0 })]);
      await rm(home, { recursive: true, force: true });
    }
  });

  test('시작 버튼 없이는 job이 없고, 동시 claim 100회 중 한 번만 예약하며 start를 중복해도 시도는 하나다', async () => {
    const t = await task();
    expect((await claim()).statusCode).toBe(204);
    expect((await request(t.key)).statusCode).toBe(202);
    const responses = await Promise.all(Array.from({ length: 100 }, () => claim()));
    expect(responses.filter(r => r.statusCode === 200)).toHaveLength(1);
    expect(responses.every(r => [200,204].includes(r.statusCode))).toBe(true);
    const job = required(responses.find(r => r.statusCode === 200)).json<{ job: { id: string; fence: number } }>().job;
    expect((await owner.query('select * from task_attempts')).rowCount).toBe(0);
    const starts = await Promise.all([start(job), start(job)]);
    expect(starts.map(r => r.statusCode)).toEqual([200,200]);
    expect(required(starts[0]).json()).toEqual(required(starts[1]).json());
    expect((await hold(job.id)).slot_state).toBe('reserved');
    expect((await owner.query('select * from task_attempts')).rowCount).toBe(1);
  });

  test('start 뒤 process 전 단절도 unconfirmed이며 종료 증거 전 재개를 거부한다', async () => {
    const { t, job } = await claimed();
    await start(job);
    await owner.query("update runner_jobs set lease_until=now()-interval '1 hour' where id=$1", [job.id]);
    await watchRunner(pool, 1);
    expect(await hold(job.id)).toMatchObject({ slot_state: 'unconfirmed', lock_state: 'held' });
    expect((await request(t.key)).statusCode).toBe(409);
    expect((await release(job, { kind: 'no_process', bootId: 'boot-a' })).statusCode).toBe(204);
    expect((await request(t.key)).statusCode).toBe(202);
  });

  test('자손이 살아 있는 단절은 자동 반환하지 않고 pgid 있는 no_process를 거부, group_empty 뒤 재개한다', async () => {
    const { t, job } = await claimed();
    await start(job);
    expect((await post(`jobs/${job.id}/process`, { fence: job.fence, processGroup: 1234, cgroup: null })).statusCode).toBe(204);
    expect((await post(`jobs/${job.id}/process`, { fence: job.fence, processGroup: 1234, cgroup: null })).statusCode).toBe(204);
    expect((await post(`jobs/${job.id}/process`, { fence: job.fence, processGroup: 5678, cgroup: null })).statusCode).toBe(409);
    await owner.query("insert into runner_sessions(runner_id,started_at,last_heartbeat_at) values('runner-test',now()-interval '10 minutes',now()-interval '4 minutes')");
    await watchRunner(pool, 1);
    expect(await hold(job.id)).toMatchObject({ slot_state: 'unconfirmed', lock_state: 'held', pgid: 1234 });
    expect((await release(job, { kind: 'no_process', bootId: 'boot-a' })).json()).toMatchObject({ error: { code: 'INVALID_TRANSITION' } });
    expect((await request(t.key)).statusCode).toBe(409);
    expect((await release(job, { kind: 'group_empty', bootId: 'wrong', processGroup: 1234 })).statusCode).toBe(409);
    expect((await release(job, { kind: 'group_empty', bootId: 'boot-a', processGroup: 1234 })).statusCode).toBe(204);
    expect((await request(t.key)).statusCode).toBe(202);
  });

  test('설치 실패는 시도와 Task를 바꾸지 않고 이력을 남기며 수동 재시도만 허용한다', async () => {
    const { t, job } = await claimed();
    expect((await post(`jobs/${job.id}/finish`, { fence: job.fence, status: 'failed', error: { code: 'SUBAGENT_INSTALL_FAILED', message: '가짜 설치 실패' } })).statusCode).toBe(204);
    expect((await owner.query('select * from task_attempts')).rowCount).toBe(0);
    expect((await owner.query('select status from tasks where id=$1', [t.id])).rows[0]).toEqual({ status: 'ready' });
    expect((await owner.query("select * from runner_job_events where kind='prestart_failed'")).rowCount).toBe(1);
    expect((await owner.query("select ref from task_history where task=$1 and kind='시작 전 실패'", [t.id])).rows).toEqual([
      { ref: { jobId:job.id,error:{ code:'SUBAGENT_INSTALL_FAILED',message:'가짜 설치 실패' } } },
    ]);
    expect((await claim()).statusCode).toBe(204);
    expect((await release(job, { kind: 'no_process', bootId: 'boot-a' })).statusCode).toBe(204);
    expect((await request(t.key)).statusCode).toBe(202);
  });

  test('① 사이 슬롯만 반환해도 같은 충돌 묶음 claim을 막고 QA로 잠금을 원자적으로 인계한다', async () => {
    const { t, job } = await claimed('공통 파일');
    const other = await task('공통 파일');
    const started = await start(job);
    await release(job, { kind: 'no_process', bootId: 'boot-a' }, true);
    const qa = await inEpoch(pool, 1, async c => {
      const attempt = (await c.query('select id from task_attempts where job=$1', [job.id])).rows[0] as { id: string };
      await c.query("update task_attempts set status='completed',ended_at=now() where id=$1", [attempt.id]);
      await c.query("update tasks set status='qa' where id=$1", [t.id]);
      await c.query("insert into ci_runs(project_id,run_key,stage,pipeline_sha,head_sha,ref,task,attempt,trigger,status,job,fence) values($1,'CI-1',1,$2,$2,'agent/test',$3,$4,'task','pass',$5,$6)", [project,sha,t.id,started.json().attemptId,job.id,job.fence]);
      return handover(c, job.id, 'qa', attempt.id);
    });
    expect((await request(other.key)).statusCode).toBe(409);
    const next = await claim();
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().job.id).toBe(qa);
    expect((await start(next.json().job)).statusCode).toBe(200);
    expect(await hold(job.id)).toMatchObject({ lock_state: 'handed_over', handed_to_job: qa });
  });

  test('새 모델은 미허용이며 run-grade와 claim은 D-29 재판단 전 차단한다', async () => {
    const { t, job } = await claimed();
    await start(job);
    await post('attempts/' + ((await owner.query('select id from task_attempts where job=$1', [job.id])).rows[0] as { id: string }).id + '/interrupt', { fence: job.fence, reason: 'error', at: now() });
    await release(job, { kind: 'no_process', bootId: 'boot-a' });
    await owner.query("update agent_models set allowed=false where model_id='gpt-6.1-sol'");
    const grade = await app.inject({ url: `/api/runner/tasks/${t.key}/run-grade?role=dev`, headers: headers() });
    expect(grade.json()).toMatchObject({ error: { code: 'CLAIM_REJECTED' } });
    expect((await request(t.key)).statusCode).toBe(409);
    const model = await post('models', { agent: 'Codex', models: [{ id: 'gpt-6.2-sol', label: '새 모델', efforts: ['high','max'] }] });
    expect(model.json()).toMatchObject({ newModels: ['gpt-6.2-sol'] });
    await owner.query("update agent_models set allowed=true where model_id='gpt-6.2-sol'");
    await owner.query("update task_grades set model_id='gpt-6.2-sol',reason='허용 해제 후 재판단',effective_from=now() where task=$1", [t.id]);
    expect((await request(t.key)).statusCode).toBe(202);
    const next = await claim();
    const started = await start(next.json().job);
    expect(started.statusCode, started.body).toBe(200);
    const saved = (await owner.query('select grade_adjust from task_attempts where id=$1', [started.json().attemptId])).rows[0];
    expect(saved.grade_adjust).toMatchObject({ kind: 'regrade', from: { model: 'gpt-6.1-sol' }, to: { model: 'gpt-6.2-sol' } });
    // M2 통합: 실제 재개(start)도 D-29 이력(M2-08 recordResumeRegrade와 같은 기록)을 남긴다.
    const interrupted = ((await owner.query("select id from task_attempts where task=$1 and status='interrupted'", [t.id])).rows[0] as { id: string }).id;
    const regrade = (await owner.query("select actor,before,after,ref from task_history where task=$1 and kind='실행 등급'", [t.id])).rows;
    expect(regrade).toEqual([{ actor: '시스템', before: { modelId: 'gpt-6.1-sol', effort: 'high' }, after: { modelId: 'gpt-6.2-sol', effort: 'high' },
      ref: { taskKey: t.key, adjust: 'regrade', reason: 'MODEL_NOT_ALLOWED', attemptId: interrupted } }]);
    expect((await owner.query("select 1 from change_events where topic='task' and ref->>'taskKey'=$1", [t.key])).rowCount).toBeGreaterThan(0);
  });

  test('같은 등급으로 재개하면 재판단 이력을 남기지 않는다', async () => {
    const { t, job } = await claimed();
    await start(job);
    await post('attempts/' + ((await owner.query('select id from task_attempts where job=$1', [job.id])).rows[0] as { id: string }).id + '/interrupt', { fence: job.fence, reason: 'error', at: now() });
    await release(job, { kind: 'no_process', bootId: 'boot-a' });
    expect((await request(t.key)).statusCode).toBe(202);
    const started = await start((await claim()).json().job);
    expect(started.statusCode, started.body).toBe(200);
    expect((await owner.query("select 1 from task_history where task=$1 and kind='실행 등급'", [t.id])).rowCount).toBe(0);
  });

  test('연결 감시가 마지막 세션을 닫으면 전달 대기 메시지를 실패로 표시하고, 열린 세션이 남으면 그대로 둔다', async () => {
    const t = await task();
    const draft = await app.inject({ method: 'POST', url: '/api/messages', headers: lead(), payload: { taskKey: t.key, type: '질문', toAgent: 'Codex', body: '확인해 주세요.' } });
    expect(draft.statusCode, draft.body).toBe(201);
    const sent = await app.inject({ method: 'POST', url: `/api/messages/${String(draft.json().id)}/send`, headers: lead(), payload: { updatedAt: draft.json().updatedAt } });
    expect(sent.statusCode, sent.body).toBe(200);
    const delivery = async () => ((await owner.query('select delivery,fail_reason from messages where id=$1', [draft.json().id])).rows[0] as { delivery: string; fail_reason: string | null });
    await owner.query("insert into runner_sessions(runner_id,started_at,last_heartbeat_at) values('runner-old',now()-interval '10 minutes',now()-interval '4 minutes'),('runner-live',now()-interval '10 minutes',now())");
    await watchRunner(pool, 1);
    expect(await delivery()).toMatchObject({ delivery: 'Queued' });
    await owner.query("update runner_sessions set last_heartbeat_at=now()-interval '4 minutes' where runner_id='runner-live'");
    await watchRunner(pool, 1);
    expect(await delivery()).toEqual({ delivery: 'Failed', fail_reason: 'Runner 연결 불가 — heartbeat 응답 없음' });
    expect((await owner.query("select 1 from change_events where topic='message'")).rowCount).toBeGreaterThan(0);
  });

  test.each([0, 1, 2, 4])('자동 재시도는 설정 한도 %i회를 따르고 중복 보고가 한도를 소모하지 않는다', async (limit) => {
    await owner.query('update exec_policy set auto_retry_limit=$1 where singleton', [limit]);
    let current = await claimed();
    for (let i = 0; i <= limit; i++) {
      const started = await start(current.job);
      const attemptId = started.json<{ attemptId: string }>().attemptId;
      await release(current.job, { kind: 'no_process', bootId: 'boot-a' }, true);
      await inEpoch(pool, 1, async c => {
        await c.query("update task_attempts set status='failed',ended_at=now() where id=$1", [attemptId]);
        await c.query("update tasks set status='failed' where id=$1", [current.t.id]);
        await retryFailedAttempt(c, attemptId);
        await retryFailedAttempt(c, attemptId);
      });
      const next = await claim();
      expect(next.statusCode, next.body).toBe(i < limit ? 200 : 204);
      if (i < limit) current = { ...current, job: next.json().job };
    }
    expect((await request(current.t.key)).statusCode).toBe(202);
    await owner.query('update exec_policy set auto_retry_limit=2 where singleton');
  });

  test('renew 성공 뒤 정지·PC 전환은 옛 쓰기와 새 외부 job을 차단하고 대조 완료 뒤에만 허용한다', async () => {
    const row = (await owner.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'integrate',$2,'queued',1,'외부 효과') returning id", [project,{ pr:1,commit:sha }])).rows[0] as { id: string };
    const response = await claim(['integrate']);
    expect(response.statusCode,response.body).toBe(200);
    const job = response.json().job;
    expect((await post(`jobs/${job.id}/renew`, { fence:job.fence })).statusCode).toBe(200);
    expect((await post(`jobs/${job.id}/start`, { fence:job.fence,hostId:'host-a',bootId:'boot-a',headSha:sha,installedSubagents:[] })).statusCode).toBe(200);
    const changed = await post('host', { hostId:'host-b',bootId:'boot-b',cpu:'fake',cores:12,memGB:16,swapGB:0,diskFreeGB:100,os:'fake' });
    expect(changed.json()).toMatchObject({ hostChanged:true });
    expect(await hold(row.id)).toMatchObject({ slot_state:'unconfirmed' });
    expect((await post(`jobs/${job.id}/renew`, { fence:job.fence })).statusCode).toBe(409);
    expect((await post(`jobs/${job.id}/start`, { fence:job.fence,hostId:'host-a',bootId:'boot-a',headSha:sha,installedSubagents:[] })).statusCode).toBe(409);
    const proof = { oldHostStopped:true,oldOutboxDrained:true,oldCallsChecked:true,credentialRevoked:false,oldCredentialStatus:null,newCredentialRegistered:false,
      mainChecked:true,prsChecked:true,branchesChecked:true,statusesChecked:true };
    await expect(inEpoch(pool,1,c=>grantExternalAfterReconcile(c,2,{ ...proof,statusesChecked:false }))).rejects.toMatchObject({ code:'EXTERNAL_WRITE_BLOCKED' });
    await expect(inEpoch(pool,1,c=>grantExternalAfterReconcile(c,1,proof))).rejects.toMatchObject({ code:'EXTERNAL_WRITE_BLOCKED' });
    expect((await release(job,{ kind:'no_process',bootId:'boot-a' })).statusCode).toBe(204);
    expect((await post(`jobs/${job.id}/reconcile`, { fence:job.fence,evidence:{ outcome:'none',checkedAt:now(),detail:{ main:sha,pr:1 } } })).statusCode).toBe(204);
    expect((await claim(['integrate'])).statusCode).toBe(204);
    await inEpoch(pool,1,c=>grantExternalAfterReconcile(c,2,proof));
    const next = await claim(['integrate']);
    expect(next.statusCode,next.body).toBe(200);
    expect(next.json().job.id).not.toBe(job.id);
  });

  test.each(['repo_check','planning','attempt','integrate','deploy_check','ci_retry'])('%s 종류에 맞는 headSha만 받는다', async kind => {
    let job: { id:string;fence:number };
    if (kind==='attempt') job=(await claimed()).job;
    else {
      await owner.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,$2::job_kind,$3,'queued',1,$2::text)", [project,kind,kind==='repo_check' ? { repoCheckId:randomUUID(),url:'https://github.com/test/runner' } : {}]);
      const c=await claim([kind]);
      expect(c.statusCode,c.body).toBe(200);
      job=c.json().job;
    }
    const required=['attempt','integrate','deploy_check','ci_retry'].includes(kind);
    const base={ fence:job.fence,hostId:'host-a',bootId:'boot-a',installedSubagents:[] };
    expect((await post(`jobs/${job.id}/start`,{ ...base,...(required ? {} : { headSha:sha }) })).statusCode).toBe(400);
    expect((await post(`jobs/${job.id}/start`,{ ...base,...(required ? { headSha:sha } : {}) })).statusCode).toBe(200);
  });

  test('동일 묶음의 동시 claim은 부분 unique와 함께 하나만 허용하고 ① 전 슬롯 재획득은 한 번만 센다', async () => {
    const a=await task('공유 파일'),b=await task('공유 파일');
    expect((await request(a.key)).statusCode).toBe(202);
    expect((await request(b.key)).statusCode).toBe(202);
    const results=await Promise.all([claim(),claim()]);
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,204]);
    const job=required(results.find(r=>r.statusCode===200)).json().job;
    await start(job);
    await release(job,{ kind:'no_process',bootId:'boot-a' },true);
    expect((await claim()).statusCode).toBe(204);
    expect((await post(`jobs/${job.id}/slots/acquire`,{ fence:job.fence,hostId:'host-a' })).statusCode).toBe(204);
    expect((await post(`jobs/${job.id}/slots/acquire`,{ fence:job.fence,hostId:'host-a' })).statusCode).toBe(409);
    expect(await hold(job.id)).toMatchObject({ slot_state:'reserved',lock_state:'held',heavy:true });
  });

  test('D-30: 없는 목표 단계를 건너뛰는 모델은 제외하고 다음 지원 모델로 한 단계만 상향한다', async () => {
    const t=await task();
    const j=(await owner.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'attempt','{}','done',1,'과거 개발') returning id",[project])).rows[0] as { id:string };
    await owner.query("insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,kind,agent,status,started_at,ended_at,model_id,effort) values($1,$2,'과거-1',1,$3,$4,$4,1,'dev','Codex','completed',now(),now(),'gpt-5.5','xhigh')",[project,t.id,j.id,sha]);
    await owner.query("update tasks set status='rework' where id=$1",[t.id]);
    await owner.query("update app_settings set model_settings=jsonb_set(model_settings,'{rankOrder,Codex}','[\"gpt-5.5\",\"gpt-6.2-sol\",\"gpt-6.2-astra\"]')");
    await post('models',{ agent:'Codex',models:[{ id:'gpt-5.5',label:'4단계',efforts:['xhigh'] },{ id:'gpt-6.2-sol',label:'목표 미지원',efforts:['xhigh'] },{ id:'gpt-6.2-astra',label:'목표 지원',efforts:['max'] }] });
    await owner.query("update agent_models set allowed=(model_id in ('gpt-5.5','gpt-6.2-sol','gpt-6.2-astra'))");
    await owner.query("update task_grades set model_id='gpt-5.5',effort='xhigh' where task=$1 and role='dev'",[t.id]);
    const grade=await app.inject({ url:`/api/runner/tasks/${t.key}/run-grade?role=dev`,headers:headers() });
    expect(grade.json()).toMatchObject({ model:'gpt-6.2-astra',effort:'max',adjust:{ kind:'up' } });
    // claim에서도 같은 판정을 사용하는지 자동 재작업 원인을 갖춘 job으로 확인한다.
    await owner.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'attempt',$2,'queued',1,'D30 재작업')",[project,{ taskKey:t.key,kind:'rework',agent:'Codex',branch:'agent/test',baseCommit:sha,inputVersion:1,instructions:{},integrationFailed:true }]);
    const c=await claim();
    expect(c.statusCode,c.body).toBe(200);
    const s=await start(c.json().job);
    expect(s.statusCode,s.body).toBe(200);
    expect((await owner.query('select model_id,effort from task_attempts where id=$1',[s.json().attemptId])).rows[0]).toEqual({ model_id:'gpt-6.2-astra',effort:'max' });
  });

  test('관측 미확인은 보유량을 줄이지 않고 새 시작을 막으며 정책과 상태는 계약 필드를 반환한다', async () => {
    const { job }=await claimed();
    const s=await start(job),attemptId=s.json().attemptId;
    const report={ at:now(),limit:4,running:{ Claude:0,Codex:1 },subagents:3,heavyJobs:0,resources:{ cpuPct:10,memFreeGB:20,swapGB:0 },sessions:[{ attemptId,observed:3,reserved:0,state:'unconfirmed' }] };
    expect((await post('concurrency',report)).statusCode).toBe(200);
    expect((await post('concurrency',{ ...report,at:now(),subagents:0,sessions:[{ attemptId,observed:0,reserved:0,state:'ok' }] })).statusCode).toBe(200);
    expect(await hold(job.id)).toMatchObject({ slots:4,slot_state:'unconfirmed' });
    const next=await task();
    expect((await request(next.key)).statusCode).toBe(409);
    const policy=await app.inject({ url:'/api/runner/policy',headers:headers() });
    expect(policy.json()).toMatchObject({ caps:{ total:25,Claude:19,Codex:19,heavy:6 },heartbeatSeconds:60,subagentBudget:{ dev:0,qa:0 } });
    expect((await app.inject({ url:'/api/runner/policy',headers:{ ...headers(),'if-none-match':required(policy.headers.etag) } })).statusCode).toBe(304);
    const state=await app.inject({ url:'/api/runner-state',headers:{ cookie } });
    expect(state.statusCode,state.body).toBe(200);
    expect(state.json()).toMatchObject({ concurrency:{ used:{ total:4,Codex:4 },subagentsHeld:3 },sessions:[{ attemptId,reserved:3 }],externalWrite:{ state:'granted' } });
  });

  test('프로세스 그룹의 실제 자식이 살아 있으면 연락이 끊겨도 예약을 유지한다', async () => {
    const fake=spawn(process.execPath,['-e',"const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);"],{ detached:true,stdio:['ignore','pipe','pipe'] });
    const [chunk]=await once(required(fake.stdout),'data') as [Buffer];
    const child=Number(chunk.toString().trim());
    const pgid=required(fake.pid);
    try {
      process.kill(child,0);
      const { job }=await claimed();
      await start(job);
      await post(`jobs/${job.id}/process`,{ fence:job.fence,processGroup:pgid,cgroup:null });
      await owner.query("update runner_jobs set lease_until=now()-interval '1 hour' where id=$1",[job.id]);
      await watchRunner(pool,1);
      process.kill(child,0);
      expect(await hold(job.id)).toMatchObject({ slot_state:'unconfirmed',pgid });
      expect((await release(job,{ kind:'no_process',bootId:'boot-a' })).statusCode).toBe(409);
      process.kill(-pgid,'SIGTERM');
      await once(fake,'exit');
      expect((await release(job,{ kind:'group_empty',bootId:'boot-a',processGroup:pgid })).statusCode).toBe(204);
    } finally { try { process.kill(-pgid,'SIGKILL'); } catch { /* 이미 비어 있는 시험 그룹 */ } }
  });

  test('자동 재작업은 3회까지이며 재작업 안의 실행 실패 재시도는 새 회차로 세지 않는다', async () => {
    let current=await claimed();
    for (let round=0;round<4;round++) {
      const started=await start(current.job);
      expect(started.statusCode,started.body).toBe(200);
      const attemptId=started.json().attemptId;
      await release(current.job,{ kind:'no_process',bootId:'boot-a' },true);
      if(round===3) {
        const status=await post(`attempts/${attemptId}/status`,{ fence:current.job.fence,status:'failed',at:now(),model:'gpt-6.1-sol',effort:'max' });
        expect(status.statusCode,status.body).toBe(204);
        const released=await release(current.job,{ kind:'no_process',bootId:'boot-a' });
        expect(released.statusCode,released.body).toBe(204);
        const retry=await claim();
        expect(retry.statusCode,retry.body).toBe(200);
        expect(retry.json().job.payload.automaticCause).toBe(`QA-${round}`);
        current={ ...current,job:retry.json().job };
        const retryStart=await start(current.job);
        expect(retryStart.statusCode,retryStart.body).toBe(200);
        await release(current.job,{ kind:'no_process',bootId:'boot-a' },true);
      }
      const next=await inEpoch(pool,1,async c=>{
        await c.query("update task_attempts set status='completed',ended_at=now() where job=$1 and status='running'",[current.job.id]);
        await c.query("update tasks set status='rework' where id=$1",[current.t.id]);
        return handover(c,current.job.id,'rework',`QA-${round+1}`,{ integrationFailed:true });
      });
      if(round<3) {
        expect(next).toBeTypeOf('string');
        const c=await claim();
        expect(c.statusCode,c.body).toBe(200);
        current={ ...current,job:c.json().job };
      } else expect(next).toBeNull();
    }
    expect((await claim()).statusCode).toBe(204);
    expect((await owner.query("select * from alerts where key like 'rework-limit:%'")).rowCount).toBe(1);
  });

  test('할당한 하위 Agent 설치와 hash가 일치해야 start하고 설치 목록을 보존한다', async () => {
    const { t,job }=await claimed();
    const def=(await owner.query("insert into subagent_defs(def_key,version,agent,role,tools,sandbox,text,hash,allowed) values('시험 도우미',1,'Codex','dev','{}','read-only','시험 지침',$1,true) returning id",['b'.repeat(64)])).rows[0] as { id:string };
    await owner.query("insert into task_subagents(project_id,task,role,subagent_id,basis) values($1,$2,'dev',$3,'시험')",[project,t.id,def.id]);
    expect((await start(job)).statusCode).toBe(422);
    expect((await start(job,{ installedSubagents:[{ id:def.id,version:1,hash:'잘못된 값' }] })).statusCode).toBe(422);
    const s=await start(job,{ installedSubagents:[{ id:def.id,version:1,hash:'b'.repeat(64) }] });
    expect(s.statusCode,s.body).toBe(200);
    expect((await owner.query('select installed,def_hash from attempt_subagents where attempt=$1',[s.json().attemptId])).rows).toEqual([{ installed:true,def_hash:'b'.repeat(64) }]);
  });

  test('꽉 찬 자원에서도 중단 명령을 claim할 수 있다', async () => {
    const { job }=await claimed();
    const started=await start(job);
    await owner.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'stop_attempt',$2,'queued',1,'중단')",[project,{ attemptId:started.json().attemptId,reason:'manual' }]);
    const stop=await post('jobs/claim',{ kinds:['stop_attempt'],capacity:0 });
    expect(stop.statusCode,stop.body).toBe(200);
  });

  test('조회 전용 job만 만료 뒤 새 fence로 임대하고 낡은 갱신을 거부한다', async () => {
    await owner.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'repo_check',$2,'queued',1,'조회')",[project,{ repoCheckId:randomUUID(),url:'https://github.com/test/runner' }]);
    const first=(await claim(['repo_check'])).json().job;
    await owner.query("update runner_jobs set lease_until=now()-interval '1 hour' where id=$1",[first.id]);
    const next=(await claim(['repo_check'])).json().job;
    expect(next.id).toBe(first.id);
    expect(next.fence).toBe(first.fence+1);
    expect((await post(`jobs/${first.id}/renew`,{ fence:first.fence })).json()).toMatchObject({ error:{ code:'LEASE_LOST' } });
  });

  test('같은 PC의 boot 변경은 자동 해제하지 않고 저장된 새 boot와 맞는 증거만 받는다', async () => {
    const { job }=await claimed();
    await start(job);
    await post(`jobs/${job.id}/process`,{ fence:job.fence,processGroup:321,cgroup:null });
    await post('host',{ hostId:'host-a',bootId:'boot-new',cpu:'fake',cores:20,memGB:32,swapGB:0,diskFreeGB:100,os:'fake' });
    expect(await hold(job.id)).toMatchObject({ slot_state:'unconfirmed',lock_state:'held' });
    expect((await release(job,{ kind:'boot_changed',bootId:'boot-a',processGroup:321,currentBootId:'거짓 부팅' })).statusCode).toBe(409);
    expect((await release(job,{ kind:'boot_changed',bootId:'boot-a',processGroup:321,currentBootId:'boot-new' })).statusCode).toBe(204);
  });

  test('PC 변경 전 대기한 job도 새 세대 브랜치를 쓰며 옛 보유 해제 전 로컬 재개를 허용한다', async () => {
    const { t,job }=await claimed();
    await start(job);
    const waiting=await task();
    expect((await request(waiting.key)).statusCode).toBe(202);
    await post('host',{ hostId:'host-b',bootId:'boot-b',cpu:'fake',cores:12,memGB:16,swapGB:0,diskFreeGB:100,os:'fake' });
    expect(await hold(job.id)).toMatchObject({ slot_state:'unconfirmed',lock_state:'orphaned' });
    expect((await request(t.key)).statusCode).toBe(202);
    const queued=await claim();
    expect(queued.json().job.payload.branch).toBe(`agent/${waiting.key}-h2`);
    expect((await start(queued.json().job,{ hostId:'host-b',bootId:'boot-b' })).statusCode).toBe(200);
    const resumed=await claim();
    expect(resumed.statusCode,resumed.body).toBe(200);
    expect((await start(resumed.json().job,{ hostId:'host-b',bootId:'boot-b' })).statusCode).toBe(200);
    const state=await app.inject({ url:'/api/runner-state',headers:{ cookie } });
    expect(state.json()).toMatchObject({ externalWrite:{ state:'blocked' } });
  });

  test('독립 감시 worker 진입점이 만료된 실행을 중단하고 종료 신호에 DB 연결을 닫는다', { timeout: 15_000 }, async () => {
    const { job }=await claimed();
    await start(job);
    await owner.query("update runner_jobs set lease_until=now()-interval '1 hour' where id=$1",[job.id]);
    const worker=spawn(process.execPath,['--conditions=awbs-source',new URL('../src/runner/worker.ts',import.meta.url).pathname],{ env:{ ...process.env,DATABASE_URL:appUrl.href },stdio:'pipe' });
    let output='';
    worker.stdout.on('data',chunk=>{output+=String(chunk);});
    worker.stderr.on('data',chunk=>{output+=String(chunk);});
    try {
      // 시계가 몇 초 뒤로 가도 만료되게 두고, 20초 주기 전의 시작 직후 점검을 확인한다.
      await vi.waitFor(async()=>{
        expect(worker.exitCode,output).toBeNull();
        expect((await hold(job.id)).slot_state,output).toBe('unconfirmed');
      },{timeout:5_000});
      const ended=once(worker,'exit');
      worker.kill('SIGTERM');
      expect((await ended)[0]).toBe(0);
    } finally { if(worker.exitCode===null) worker.kill('SIGKILL'); }
  });

  test('resetAt 미보고는 DB와 상태 API에서 null로 남고 보고한 시각은 보존한다', async () => {
    expect((await post('usage',{ agent:'Codex',remainPct:0 })).statusCode).toBe(204);
    expect((await owner.query("select reset_at from agent_usage where agent='Codex' order by created_at desc limit 1")).rows).toEqual([{ reset_at:null }]);
    const state=await app.inject({ url:'/api/runner-state',headers:{ cookie } });
    expect(state.statusCode,state.body).toBe(200);
    expect(state.json().usage).toContainEqual(expect.objectContaining({ agent:'Codex',remainPct:0,resetAt:null }));
    const resetAt='2026-12-01T01:02:03.000Z';
    expect((await post('usage',{ agent:'Codex',remainPct:50,resetAt })).statusCode).toBe(204);
    expect((await owner.query("select reset_at from agent_usage where agent='Codex' order by created_at desc limit 1")).rows).toEqual([{ reset_at:new Date(resetAt) }]);
  });

  test('원래 PC 복귀 A→B→A도 매번 새 세대로 차단하고 대조 뒤 해제한다', async () => {
    const proof={ oldHostStopped:true,oldOutboxDrained:true,oldCallsChecked:true,credentialRevoked:false,oldCredentialStatus:null,newCredentialRegistered:false,
      mainChecked:true,prsChecked:true,branchesChecked:true,statusesChecked:true };
    for(const [hostId,bootId,generation] of [['host-b','boot-b',2],['host-a','boot-a2',3]] as const) {
      const changed=await post('host',{ hostId,bootId,cpu:'fake',cores:20,memGB:32,swapGB:0,diskFreeGB:100,os:'fake' });
      expect(changed.statusCode,changed.body).toBe(200);
      expect(changed.json()).toMatchObject({ hostChanged:true });
      expect((await owner.query('select host_id,generation,state from external_write_authority')).rows).toEqual([{ host_id:hostId,generation,state:'blocked' }]);
      const job=(await owner.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'integrate',$2,'queued',1,$3) returning id",[project,{ pr:generation,commit:sha },`복귀-${generation}`])).rows[0] as { id:string };
      expect((await claim(['integrate'])).statusCode).toBe(204);
      await expect(inEpoch(pool,1,c=>grantExternalAfterReconcile(c,generation,{ ...proof,statusesChecked:false }))).rejects.toMatchObject({ code:'EXTERNAL_WRITE_BLOCKED' });
      await expect(inEpoch(pool,1,c=>grantExternalAfterReconcile(c,generation-1,proof))).rejects.toMatchObject({ code:'EXTERNAL_WRITE_BLOCKED' });
      await inEpoch(pool,1,c=>grantExternalAfterReconcile(c,generation,proof));
      const claimedJob=await claim(['integrate']);
      expect(claimedJob.statusCode,claimedJob.body).toBe(200);
      expect(claimedJob.json().job.id).toBe(job.id);
      expect((await post(`jobs/${job.id}/start`,{ fence:claimedJob.json().job.fence,hostId,bootId,headSha:sha,installedSubagents:[] })).statusCode).toBe(200);
      expect((await post(`jobs/${job.id}/finish`,{ fence:claimedJob.json().job.fence,status:'done' })).statusCode).toBe(204);
      expect((await post(`jobs/${job.id}/release`,{ fence:claimedJob.json().job.fence,hostId,proof:{ kind:'no_process',bootId },at:now() })).statusCode).toBe(204);
    }
  });

  async function queued(t: { key:string }, dedup: string) {
    return (await owner.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'attempt',$2,'queued',1,$3) returning id",[project,
      { taskKey:t.key,kind:'dev',agent:'Codex',branch:'agent/test',baseCommit:sha,inputVersion:1,instructions:{},leaderRequested:true },dedup])).rows[0] as { id:string };
  }
  async function limit(value: number) {
    expect((await post('concurrency',{ at:now(),limit:value,running:{ Claude:0,Codex:0 },subagents:0,heavyJobs:0,resources:{ cpuPct:1,memFreeGB:20,swapGB:0 },sessions:[] })).statusCode).toBe(200);
  }
  async function waitForDatabaseLock(blocker: number, event: string) {
    await vi.waitFor(async()=>{
      const blocked=await owner.query("select 1 from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid)) and wait_event_type='Lock' and wait_event=$2",[blocker,event]);
      expect(blocked.rowCount,`기대한 DB 잠금 대기가 없습니다: ${event}`).toBeGreaterThan(0);
    },{timeout:10_000});
  }

  test('상한 1에서 자기 예약은 한 번만 세고 설치 중 타 job이 잡은 용량은 start에서 재검사한다', async () => {
    await limit(1);
    const first=await claimed('설치 경합');
    expect((await start(first.job)).statusCode).toBe(200);
    const other=await task('설치 경합');
    const blocked=await queued(other,'타 묶음 잠금');
    await limit(6);
    expect((await claim()).statusCode).toBe(204);
    expect((await owner.query("select detail from runner_job_events where job=$1 and code='CLAIM_REJECTED'",[blocked.id])).rows).toContainEqual({ detail:{ reasons:expect.arrayContaining(['다른 job 또는 낡은 epoch/host의 보유가 남아 있습니다.']) } });
    const installing=await claimed();
    await limit(2);
    const foreign=(await owner.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'planning','{}','leased',1,'설치 사이 새 예약') returning id",[project])).rows[0] as { id:string };
    await pool.query("insert into execution_holds(project_id,job,epoch,host_id,boot_id,fence,agent,slots,heavy,slot_state,lock_state) values($1,$2,1,'host-a','boot-a',1,'Codex',1,false,'reserved','none')",[project,foreign.id]);
    const denied=await start(installing.job);
    expect(denied.statusCode,denied.body).toBe(409);
    expect(denied.json()).toMatchObject({ error:{ code:'CLAIM_REJECTED',details:{ reasons:expect.arrayContaining(['전체 실행 상한 또는 Runner 한도를 넘습니다.']) } } });
    expect((await owner.query('select id from task_attempts where job=$1',[installing.job.id])).rows).toEqual([]);
    expect(await hold(installing.job.id)).toMatchObject({ slot_state:'reserved',lock_state:'held' });
  });

  test('인계 트랜잭션 동안 claim은 조정 잠금에서 기다리고 커밋 뒤 QA만 받는다', async () => {
    const { t,job }=await claimed('인계 경합');
    const started=await start(job);
    await release(job,{ kind:'no_process',bootId:'boot-a' },true);
    const other=await task('인계 경합');
    await queued(other,'인계 사이 끼어드는 작업');
    const tx=await pool.connect();
    let pending: ReturnType<typeof claim> | undefined;
    let next: string | null;
    try {
      await tx.query('begin');
      await tx.query('select public.lock_epoch(1)');
      await new RunnerRepository(tx).lock();
      const pid=(await tx.query<{ pid:number }>('select pg_backend_pid() as pid')).rows[0];
      await tx.query("update task_attempts set status='completed',ended_at=now() where job=$1",[job.id]);
      await tx.query("update tasks set status='qa' where id=$1",[t.id]);
      await tx.query("insert into ci_runs(project_id,run_key,stage,pipeline_sha,head_sha,ref,task,attempt,trigger,status,job,fence) values($1,'CI-원자성',1,$2,$2,'agent/test',$3,$4,'task','pass',$5,$6)",[project,sha,t.id,started.json().attemptId,job.id,job.fence]);
      next=await handover(tx,job.id,'qa',started.json().attemptId);
      pending=claim();
      await waitForDatabaseLock(required(pid).pid,'advisory');
      expect((await owner.query("select job,lock_state from execution_holds where task=$1",[t.id])).rows).toEqual([{ job:job.id,lock_state:'held' }]);
      await tx.query('commit');
    } finally {
      await tx.query('rollback');
      tx.release();
      if(pending) await pending;
    }
    const result=await required(pending);
    expect(result.statusCode,result.body).toBe(200);
    expect(result.json().job.id).toBe(next);
    expect(await hold(job.id)).toMatchObject({ lock_state:'handed_over',handed_to_job:next });
    expect(await hold(required(next))).toMatchObject({ lock_state:'held',lock_from_job:job.id });
    expect((await start(result.json().job)).statusCode).toBe(200);
    expect((await claim()).statusCode).toBe(204);
  });

  test.each(['task','conflict_group'] as const)('앱 역할의 두 연결이 %s 부분 unique에서 실제로 경합한다', async axis => {
    const group=axis==='task' ? null : '부분 고유키 경합';
    const first=await task(group),second=axis==='task' ? first : await task(group);
    const job1=await queued(first,'고유키-1'),job2=await queued(second,'고유키-2');
    const a=await pool.connect(),b=await pool.connect();
    const insert=(client: typeof a,jobId: string,taskId: string)=>client.query("insert into execution_holds(project_id,job,epoch,host_id,boot_id,fence,task,conflict_group,agent,slots,heavy,slot_state,lock_state) values($1,$2,1,'host-a','boot-a',1,$3,$4,'Codex',1,false,'reserved','held')",[project,jobId,taskId,group]);
    let pending: Promise<unknown> | undefined;
    try {
      await a.query('begin');
      await b.query('begin');
      const roles=await Promise.all([a.query('select current_user as role'),b.query('select current_user as role')]);
      expect(roles.map(r=>r.rows[0].role)).toEqual(['awbs_app','awbs_app']);
      await insert(a,job1.id,first.id);
      const pid=required((await a.query<{ pid:number }>('select pg_backend_pid() as pid')).rows[0]).pid;
      pending=insert(b,job2.id,second.id).then(()=>({ succeeded:true }),error=>({ code:(error as { code:string }).code,constraint:(error as { constraint:string }).constraint }));
      await waitForDatabaseLock(pid,'transactionid');
      await a.query('commit');
      expect(await pending).toEqual({ code:'23505',constraint:axis==='task' ? 'one_task_lock' : 'one_conflict_lock' });
    } finally {
      await a.query('rollback');
      if(pending) await pending;
      await b.query('rollback');
      a.release();b.release();
    }
    expect((await owner.query("select count(*)::int as count from execution_holds where lock_state='held'")).rows).toEqual([{ count:1 }]);
  });
});
