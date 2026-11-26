import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { OPERATIONS } from '@awbs/shared/api';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import { installProjectRunner } from '../src/project/runner-routes.ts';
import { draft, met, task } from './project-fixture.ts';

/*
 * M2-03 프로젝트 등록·기술 결정·bootstrap·초기 WBS 승인·입력 변경·분석 안 함(G§4.2, contracts §2.2·§3.3).
 * job claim은 M2-05 범위라 여기서는 DB에서 임대(lease)를 직접 잡고 fence 대조만 검증한다.
 */
const origin = 'http://127.0.0.1:3100';
const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_project';
const ownerPool = createPool(dbUrl.href, { max: 4, onError: () => undefined });
const appUrl = new URL(dbUrl);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { max: 12, onError: () => undefined });
const app = buildApp(pool, process.env.PROJECT_DEBUG ? { level: 'error' } : false, { origin, lan: false });
installProjectRunner(app, pool);

const shared = createRequire(new URL('../../../packages/shared/package.json', import.meta.url));
const { Ajv } = shared('ajv') as { Ajv: new (options: object) => { validate: (schema: unknown, data: unknown) => boolean; errorsText: () => string } };
const ajv = new Ajv({ strict: false });
function expectShape(id: string, status: number, body: unknown) {
  const op = OPERATIONS.find((item) => item.id === id);
  const ok = ajv.validate(op?.responses[status], body);
  expect(ok, `${id} ${String(status)}: ${ajv.errorsText()}`).toBe(true);
}

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const SHA3 = 'c'.repeat(40);
const SHA4 = 'd'.repeat(40);
const REPO = 'https://github.com/acme/web';
const STRUCTURE = { uiux: true, uiuxFiles: 12, docs: ['prototype/docs/guide.md'], src: false, contracts: false, agentwbs: false };
let cookie = '';
let csrf = '';
let bearer = '';

interface ErrorBody { error: { code: string; errors: { path: string; rule: string }[]; details: Record<string, unknown>; message: string } }
const errorOf = (response: { json: <T>() => T }) => response.json<ErrorBody>().error;
function lead(method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { cookie, origin, 'x-csrf-token': csrf, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
}
async function epoch() { return (await ownerPool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch ?? 0; }
async function runner(url: string, payload: unknown, key: string = crypto.randomUUID()) {
  return app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${bearer}`, 'x-project-epoch': String(await epoch()), 'idempotency-key': key }, payload: payload as object });
}
/**
 * M2-05의 claim 대신 queued job 하나를 이 Runner에 임대하고 새 fence를 돌려준다.
 * claim처럼 외부 효과 job에는 현재 외부 쓰기 권한의 generation을 붙인다.
 */
async function lease(kind: string): Promise<{ id: string; fence: number; payload: Record<string, unknown> }> {
  const row = (await ownerPool.query<{ id: string; fence: number; payload: Record<string, unknown> }>(
    `update runner_jobs set state='leased',lease_owner='runner:test-runner',lease_until=now()+interval '60 seconds',fence=fence+1,
       generation=case when kind in ('bootstrap','input_diff') then (select generation from external_write_authority where singleton) end
     where id=(select id from runner_jobs where kind=$1 and state='queued' order by created_at desc limit 1) returning id,fence,payload`, [kind])).rows[0];
  if (!row) throw new Error(`${kind} job 없음`);
  return row;
}
async function finishJob(id: string) { await ownerPool.query("update runner_jobs set state='done' where id=$1", [id]); }
async function state() {
  const response = await lead('GET', '/api/project');
  expect(response.statusCode, response.body).toBe(200);
  expectShape('getProject', 200, response.json());
  return response.json<{
    state: string; id: string; updatedAt: string; epoch: number; constraints: { id: string; level: string }[];
    bootstrap: { jobId: string; runNo: number; status: string; steps: { key: string; status: string; note: string }[]; logs: { text: string }[];
      fail: { reason: string } | null; revision: number | null; decisions: { id: string; tdKey: string; status: string; authority: string; level: string | null; updatedAt: string; title: string }[];
      draft: { tasks: { ref: string; judgedRules?: { items: { subjectHash: string }[] } }[]; splitCheck: { pass: number; suspect: number; violation: number } } | null };
    inputs: { v: number; commit: string; mdList: string[]; changes: { path: string; change: string }[]; result: string | null; taskCount: number }[];
    changeCommits: { sha: string; state: string; author: string; message: string; files: { path: string }[] }[];
    inputJob: { jobId: string; status: string; version: number } | null;
    approvedTaskCount: number;
  }>();
}
async function count(sql: string) { return Number((await ownerPool.query<{ n: string }>(sql)).rows[0]?.n ?? 0); }
const step = (s: Awaited<ReturnType<typeof state>>, key: string) => s.bootstrap.steps.find((item) => item.key === key)?.status;

async function checkedRepo(structure: object = STRUCTURE, url = REPO): Promise<string> {
  const created = await lead('POST', '/api/project/repo-checks', { url });
  expect(created.statusCode, created.body).toBe(202);
  const { id } = created.json<{ id: string }>();
  const job = await lease('repo_check');
  expect(job.payload).toMatchObject({ url, repoCheckId: id });
  const reported = await runner(`/api/runner/repo-checks/${id}/result`, { fence: job.fence, access: true, private: true, commit: SHA1, structure });
  expect(reported.statusCode, reported.body).toBe(204);
  await finishJob(job.id);
  return id;
}
const registration = (repoCheckId: string, extra: object = {}) => ({
  name: '웹 제품', url: REPO, targetDate: '2027-02-27', instruction: '계약 먼저',
  constraints: [{ name: 'PostgreSQL 16', level: 'must' }, { name: '외부 클라우드', level: 'ban' }, { name: 'QuestDB', level: 'cond', condition: '시계열 데이터가 있으면' }],
  repoCheckId, ...extra,
});
async function progress(jobId: string, fence: number, stepKey: string, status = 'done', note?: string) {
  const response = await runner(`/api/runner/bootstrap/${jobId}/progress`, { fence, stepKey, status, at: new Date().toISOString(), ...(note && { note }) });
  expect(response.statusCode, response.body).toBe(204);
}
async function resetDb() {
  await ownerPool.query("select public.reset_project((select epoch from system_state where id=1),(select name from projects),true,'test') where exists(select 1 from projects)");
  await ownerPool.query("update system_state set cleanup_status='none' where id=1");
  await ownerPool.query('update runner_commands set status=\'done\' where status<>\'done\'').catch(() => undefined);
}

beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  await runMigrations(ownerPool);
  await seedSystem(ownerPool);
  bearer = await issueRunnerToken(pool, 'test-runner', 'fake-public-key');
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
  expect(login.statusCode, login.body).toBe(204);
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
  // 기준 일정 v1 계산에 필요한 PC 사양 보고와 가정 가동률(G§6.2·§6.6).
  await ownerPool.query("insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at) values('host-1','boot-1','cpu',8,32,0,500,'linux',1,now())");
  await ownerPool.query('update schedule_policy set assume_rate=0.5');
  // M2-05: 초기 분석·차이 분석은 외부 효과 job이라 현재 PC가 외부 쓰기 권한을 가져야 보고를 받는다.
  await ownerPool.query("insert into external_write_authority(singleton,host_id,generation,state) values(true,'host-1',1,'granted')");
});
afterAll(async () => { await app.close(); await pool.end(); await ownerPool.end(); });

describe('project 등록(G§4.2 ①, contracts §2.2)', () => {
  test('등록 전에는 state=none이고 저장소까지만 받는다', async () => {
    const none = await state();
    expect(none).toMatchObject({ state: 'none', epoch: await epoch() });
    for (const url of [`${REPO}/tree/main`, `${REPO}/blob/main/a.md`, 'https://gitlab.com/acme/web', 'https://github.com/acme/..']) {
      const response = await lead('POST', '/api/project/repo-checks', { url });
      expect(response.statusCode, url).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    }
    expect(await count("select count(*) n from runner_jobs where kind='repo_check'")).toBe(0);
  });

  test('저장소 확인 결과는 job의 현재 fence만 받고 필수 구조가 없으면 실패로 남긴다', async () => {
    const created = await lead('POST', '/api/project/repo-checks', { url: `${REPO}.git` });
    const { id } = created.json<{ id: string }>();
    const queued = await lead('GET', `/api/project/repo-checks/${id}`);
    expectShape('getRepoCheck', 200, queued.json());
    expect(queued.json()).toMatchObject({ id, url: REPO, status: 'queued', commit: null });
    const job = await lease('repo_check');
    const stale = await runner(`/api/runner/repo-checks/${id}/result`, { fence: job.fence - 1, access: true, private: true, commit: SHA1, structure: STRUCTURE });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale).code).toBe('LEASE_LOST');
    const missing = await runner(`/api/runner/repo-checks/${id}/result`, { fence: job.fence, access: true, private: true, commit: SHA1, structure: { ...STRUCTURE, uiux: false, docs: [] } });
    expect(missing.statusCode, missing.body).toBe(204);
    const failed = (await lead('GET', `/api/project/repo-checks/${id}`)).json<{ status: string; error: string }>();
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('prototype/uiux/');
    expect(failed.error).toContain('prototype/docs/');
    const unknown = await lead('GET', '/api/project/repo-checks/00000000-0000-4000-8000-000000000000');
    expect(unknown.statusCode).toBe(404);
    // 실패한 확인으로는 등록할 수 없다.
    const rejected = await lead('POST', '/api/project', registration(id));
    expect(rejected.statusCode).toBe(409);
    expect(errorOf(rejected).code).toBe('INVALID_TRANSITION');
    await finishJob(job.id);
  });

  test('없는 확인·다른 주소의 확인으로는 등록할 수 없다', async () => {
    const missing = await lead('POST', '/api/project', registration('00000000-0000-4000-8000-000000000000'));
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('NOT_FOUND');
    const id = await checkedRepo();
    const other = await lead('POST', '/api/project', registration(id, { url: 'https://github.com/acme/other' }));
    expect(other.statusCode).toBe(409);
    expect(errorOf(other).code).toBe('INVALID_TRANSITION');
  });

  test('정리 대기 중에는 등록하지 않는다(CLEANUP_PENDING)', async () => {
    const id = await checkedRepo();
    await ownerPool.query("update system_state set cleanup_status='pending' where id=1");
    try {
      const response = await lead('POST', '/api/project', registration(id));
      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('CLEANUP_PENDING');
    } finally { await ownerPool.query("update system_state set cleanup_status='none' where id=1"); }
    expect(await count('select count(*) n from projects')).toBe(0);
  });

  test('동시에 두 번 등록하면 하나만 성공하고 나머지는 PROJECT_EXISTS', async () => {
    const id = await checkedRepo();
    const results = await Promise.all([1, 2, 3].map(() => lead('POST', '/api/project', registration(id))));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409)) expect(errorOf(r).code).toBe('PROJECT_EXISTS');
    const created = results.find((r) => r.statusCode === 201);
    expectShape('createProject', 201, created?.json());
    expect(await count('select count(*) n from projects')).toBe(1);
    expect(await count("select count(*) n from planning_jobs where kind='bootstrap'")).toBe(1);
  });

  test('등록하면 main 커밋을 입력 v1과 기준 커밋으로 고정하고 초기 분석 job을 만든다', async () => {
    const s = await state();
    expect(s.state).toBe('boot');
    expect(s.inputs).toEqual([expect.objectContaining({ v: 1, commit: SHA1, mdList: ['prototype/docs/guide.md'], changes: [] })]);
    const project = (await ownerPool.query<{ base_commit: string; repo_owner: string; repo_name: string; phase: string; target_date: string }>(
      "select base_commit,repo_owner,repo_name,phase,to_char(target_date,'YYYY-MM-DD') target_date from projects")).rows[0];
    expect(project).toEqual({ base_commit: SHA1, repo_owner: 'acme', repo_name: 'web', phase: 'boot', target_date: '2027-02-27' });
    expect(await count('select count(*) n from tech_constraints')).toBe(3);
    expect(s.bootstrap).toMatchObject({ runNo: 1, status: 'queued', revision: null, draft: null, decisions: [] });
    expect(s.bootstrap.steps.map((x) => `${x.key}:${x.status}`)).toEqual(
      ['check', 'unzip', 'repo', 'codex', 'claude', 'cross', 'tech', 'draft', 'approve'].map((k) => `${k}:wait`));
    const job = (await ownerPool.query<{ payload: Record<string, unknown>; project_id: string; epoch: number }>("select payload,project_id,epoch from runner_jobs where kind='bootstrap'")).rows[0];
    expect(job?.payload).toMatchObject({ planningJobId: s.bootstrap.jobId, commit: SHA1, previousCommit: null, resumeStep: null, runNo: 1, instruction: '계약 먼저' });
    expect(job?.project_id).toBe(s.id);
  });

  test('Idempotency-Key가 같은 저장소 확인 재전송은 확인을 하나만 만들고 응답을 재생한다', async () => {
    const key = crypto.randomUUID();
    const before = await count("select count(*) n from runner_jobs where kind='repo_check'");
    const first = await lead('POST', '/api/project/repo-checks', { url: REPO }, { 'idempotency-key': key });
    const again = await lead('POST', '/api/project/repo-checks', { url: REPO }, { 'idempotency-key': key });
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await count("select count(*) n from runner_jobs where kind='repo_check'")).toBe(before + 1);
    await ownerPool.query("update runner_jobs set state='cancelled' where kind='repo_check' and state='queued'");
  });
});

describe('project 초기 분석 진행과 다시 시도', () => {
  test('Runner 진행 보고를 단계·로그에 남기고, 팀장 단계는 Runner가 끝낼 수 없다', async () => {
    const job = await lease('bootstrap');
    for (const key of ['check', 'unzip']) {
      await progress(job.id, job.fence, key, 'run');
      await progress(job.id, job.fence, key, 'done', `${key} 완료`);
    }
    const s = await state();
    expect(s.bootstrap.status).toBe('running');
    expect(step(s, 'unzip')).toBe('done');
    expect(s.bootstrap.logs.length).toBeGreaterThanOrEqual(4);
    // 초안 단계의 완료는 초안 등록(draft API)만 기록한다. 진행 보고로 끝내면 승인할 초안 없이 멈춘다.
    for (const stepKey of ['tech', 'approve', 'diff', 'draft']) {
      const response = await runner(`/api/runner/bootstrap/${job.id}/progress`, { fence: job.fence, stepKey, status: 'done', at: new Date().toISOString() });
      expect(response.statusCode, stepKey).toBe(400);
    }
    const stale = await runner(`/api/runner/bootstrap/${job.id}/progress`, { fence: job.fence + 5, stepKey: 'repo', status: 'run', at: new Date().toISOString() });
    expect(errorOf(stale).code).toBe('LEASE_LOST');
  });

  test('실패하면 사유를 보이고, 다시 시도는 분석 회차를 비교해 실패 단계부터 새 job을 만든다', async () => {
    const running = (await ownerPool.query<{ id: string; fence: number }>("select id,fence from runner_jobs where kind='bootstrap' and state='leased'")).rows[0];
    if (!running) throw new Error('임대 job 없음');
    await progress(running.id, running.fence, 'repo', 'fail', 'git-lfs가 없어 checkout 실패');
    await finishJob(running.id);
    const failed = await state();
    expect(failed.bootstrap.status).toBe('failed');
    expect(failed.bootstrap.fail?.reason).toContain('git-lfs');
    const stale = await lead('POST', '/api/project/bootstrap/retry', { revision: null, runNo: 2 });
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    await ownerPool.query("update system_state set cleanup_status='pending' where id=1");
    try {
      expect(errorOf(await lead('POST', '/api/project/bootstrap/retry', { revision: null, runNo: 1 })).code).toBe('CLEANUP_PENDING');
    } finally { await ownerPool.query("update system_state set cleanup_status='none' where id=1"); }
    const retry = await lead('POST', '/api/project/bootstrap/retry', { revision: null, runNo: 1 });
    expect(retry.statusCode, retry.body).toBe(202);
    expectShape('retryBootstrap', 202, retry.json());
    expect(retry.json<{ jobId: string }>().jobId).toBe(failed.bootstrap.jobId);
    const again = await state();
    expect(again.bootstrap).toMatchObject({ status: 'queued', fail: null, runNo: 1 });
    expect(step(again, 'repo')).toBe('wait');
    expect(step(again, 'unzip')).toBe('done');
    const job = await lease('bootstrap');
    expect(job.payload).toMatchObject({ resumeStep: 'repo', runNo: 1 });
    const twice = await lead('POST', '/api/project/bootstrap/retry', { revision: null, runNo: 1 });
    expect(errorOf(twice).code).toBe('INVALID_TRANSITION');
  });
});

describe('project 기술 결정 확정(G§4.2·§4.12)', () => {
  let jobId = '';
  let fence = 0;
  test('기술 결정 제안은 팀장 제약(필수·금지는 확정, 조건부는 대기)과 Agent 제안(대기)을 만든다', async () => {
    const job = (await ownerPool.query<{ id: string; fence: number }>("select id,fence from runner_jobs where kind='bootstrap' and state='leased'")).rows[0];
    if (!job) throw new Error('임대 job 없음');
    ({ id: jobId, fence } = job);
    for (const key of ['repo', 'codex', 'claude', 'cross']) await progress(jobId, fence, key);
    const early = await lead('POST', `/api/projects/${(await state()).id}/boot/tech/confirm`, { decisions: [] });
    expect(errorOf(early).code).toBe('INVALID_TRANSITION');
    // 조건부 선호마다 조건 충족 판단과 근거가 정확히 하나 있어야 한다(G§4.12, 리뷰 4).
    const constraints = (await state()).constraints;
    const condId = constraints.find((c) => c.level === 'cond')?.id ?? '';
    const mustId = constraints.find((c) => c.level === 'must')?.id ?? '';
    const proposals = [{ area: 'a', title: 't', choice: 'c', reason: 'r', alternatives: '' }];
    for (const conditionJudgements of [undefined, [], [{ constraintId: mustId, result: 'met', reason: '근거' }],
      [{ constraintId: condId, result: 'met', reason: '근거' }, { constraintId: condId, result: 'met', reason: '근거' }],
      [{ constraintId: condId, result: 'met', reason: '   ' }]]) {
      const bad = await runner(`/api/planning/bootstrap/${jobId}/tech`, { fence, decisions: proposals, ...(conditionJudgements && { conditionJudgements }) });
      expect(bad.statusCode, JSON.stringify(conditionJudgements)).toBe(400);
    }
    const response = await runner(`/api/planning/bootstrap/${jobId}/tech`, { fence,
      conditionJudgements: [{ constraintId: condId, result: 'met', reason: '센서 시계열이 초당 수백 건' }], decisions: [
      { area: '통신', title: '실시간 갱신 방식', choice: 'SSE', reason: '단방향 알림이면 충분', alternatives: 'WebSocket' },
      { area: '데이터', title: '캐시', choice: 'Redis', reason: '세션 캐시', alternatives: '' },
    ] });
    expect(response.statusCode, response.body).toBe(201);
    const s = await state();
    expect(step(s, 'tech')).toBe('run');
    expect(s.bootstrap.decisions.map((d) => `${d.tdKey}:${d.authority}:${d.level ?? '-'}:${d.status}`)).toEqual([
      'TD-01:lead:must:fixed', 'TD-02:lead:ban:fixed', 'TD-03:lead:cond:pending', 'TD-04:agent:-:pending', 'TD-05:agent:-:pending',
    ]);
    expect(s.bootstrap.decisions[2]).toMatchObject({ constraintId: condId, conditionResult: 'met', reason: '센서 시계열이 초당 수백 건' });
    const twice = await runner(`/api/planning/bootstrap/${jobId}/tech`, { fence, decisions: [{ area: 'a', title: 't', choice: 'c', reason: 'r', alternatives: '' }] });
    expect(errorOf(twice).code).toBe('INVALID_TRANSITION');
    await finishJob(jobId);
  });

  test('미결정이 남거나 낡은 버전이면 아무것도 바꾸지 않고 409', async () => {
    const s = await state();
    const pending = s.bootstrap.decisions.filter((d) => d.status === 'pending');
    const [cond, sse, redis] = pending;
    if (!cond || !sse || !redis) throw new Error('대기 결정 없음');
    const confirm = (decisions: object[]) => lead('POST', `/api/projects/${s.id}/boot/tech/confirm`, { decisions });
    const partial = await confirm([{ id: cond.id, choice: 'approve', updatedAt: cond.updatedAt }]);
    expect(partial.statusCode).toBe(409);
    expect(errorOf(partial).code).toBe('DECISIONS_PENDING');
    expect(errorOf(partial).details).toMatchObject({ pending: [sse.tdKey, redis.tdKey] });
    const stale = await confirm(pending.map((d) => ({ id: d.id, choice: 'approve', updatedAt: '2020-01-01T00:00:00Z' })));
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    const fixed = s.bootstrap.decisions.find((d) => d.status === 'fixed');
    const notPending = await confirm([...pending.map((d) => ({ id: d.id, choice: 'approve', updatedAt: d.updatedAt })), { id: fixed?.id, choice: 'reject', updatedAt: fixed?.updatedAt }]);
    expect(errorOf(notPending).code).toBe('INVALID_TRANSITION');
    const wrongProject = await lead('POST', '/api/projects/00000000-0000-4000-8000-000000000000/boot/tech/confirm', { decisions: [] });
    expect(wrongProject.statusCode).toBe(404);
    expect(errorOf(wrongProject).code).toBe('PROJECT_NOT_FOUND');
    expect((await state()).bootstrap.decisions.filter((d) => d.status === 'pending')).toHaveLength(3);
  });

  test('모두 정하면 확정하고 초안 작성 job을 만든다', async () => {
    const s = await state();
    const pending = s.bootstrap.decisions.filter((d) => d.status === 'pending');
    const response = await lead('POST', `/api/projects/${s.id}/boot/tech/confirm`, {
      decisions: pending.map((d, i) => ({ id: d.id, choice: i === 2 ? 'reject' : 'approve', updatedAt: d.updatedAt })) });
    expect(response.statusCode, response.body).toBe(200);
    expectShape('confirmTech', 200, response.json());
    const after = await state();
    expect(after.bootstrap.decisions.map((d) => d.status)).toEqual(['fixed', 'fixed', 'approved', 'approved', 'rejected']);
    expect(step(after, 'tech')).toBe('done');
    expect(await count("select count(*) n from tech_decision_events where kind in ('approve','reject')")).toBe(3);
    const job = await lease('bootstrap');
    expect(job.payload).toMatchObject({ resumeStep: 'draft', runNo: 1 });
  });
});

describe('project 초기 WBS 초안과 승인(D-33)', () => {
  const current = async () => {
    const row = (await ownerPool.query<{ id: string; fence: number }>("select id,fence from runner_jobs where kind='bootstrap' and state='leased'")).rows[0];
    if (!row) throw new Error('임대 job 없음');
    return row;
  };
  const notMet = draft([task('t1', { judgedRules: { schemaVersion: 1, items: [{ ...met('revert'), result: 'not_met' }, met('contract'), met('refactor')] } }), task('t2', { judgedRules: undefined })]);

  test('순환·참조 오류 초안은 400이고, 판단이 모자란 초안도 저장해 화면에 보인다', async () => {
    const job = await current();
    const cyclic = draft(undefined, [{ predRef: 't1', succRef: 't2', depType: 'FS' }, { predRef: 't2', succRef: 't1', depType: 'FS' }]);
    const bad = await runner(`/api/planning/bootstrap/${job.id}/draft`, { fence: job.fence, ...cyclic });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).errors).toEqual([expect.objectContaining({ path: 'deps.1', rule: 'dependencyCycle' })]);
    const withHash = await runner(`/api/planning/bootstrap/${job.id}/draft`, { fence: job.fence, ...draft([task('t1', { judgedRules: { schemaVersion: 1, items: [{ ...met('revert'), subjectHash: 'f'.repeat(64) }] } as never })], []) });
    expect(withHash.statusCode).toBe(400);
    const saved = await runner(`/api/planning/bootstrap/${job.id}/draft`, { fence: job.fence, ...notMet });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(saved.json()).toEqual({ revision: 1 });
    const s = await state();
    expect(s.bootstrap.revision).toBe(1);
    expect(step(s, 'draft')).toBe('done');
    expect(step(s, 'approve')).toBe('run');
    expect(s.bootstrap.draft?.tasks[0]?.judgedRules?.items[0]?.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.bootstrap.draft?.splitCheck).toEqual({ pass: 2, suspect: 0, violation: 0 });
    await finishJob(job.id);
  });

  test('불충족·미기록 판단이 있으면 SPLIT_JUDGEMENT_REQUIRED로 보류하고 아무것도 만들지 않는다', async () => {
    const stale = await lead('POST', '/api/project/bootstrap/approve', { revision: 2 });
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    const held = await lead('POST', '/api/project/bootstrap/approve', { revision: 1 });
    expect(held.statusCode).toBe(409);
    const error = errorOf(held);
    expect(error.code).toBe('SPLIT_JUDGEMENT_REQUIRED');
    expect((error.details.items as { ref: string; rule: string; code: string }[]).map((i) => `${i.ref}:${i.rule}:${i.code}`)).toEqual([
      't1:revert:JUDGEMENT_NOT_MET', 't2:revert:JUDGEMENT_MISSING', 't2:contract:JUDGEMENT_MISSING', 't2:refactor:JUDGEMENT_MISSING']);
    expect(await count('select count(*) n from tasks')).toBe(0);
    expect(await count('select count(*) n from schedule_baselines')).toBe(0);
    expect((await state()).state).toBe('boot');
  });

  test('규칙을 끄면 그 규칙의 판단은 요구하지 않는다', async () => {
    await ownerPool.query("update app_settings set split=jsonb_set(split,'{on,revert}','false')");
    try {
      const held = await lead('POST', '/api/project/bootstrap/approve', { revision: 1 });
      expect((errorOf(held).details.items as { rule: string }[]).map((i) => i.rule)).toEqual(['contract', 'refactor']);
    } finally { await ownerPool.query("update app_settings set split=jsonb_set(split,'{on,revert}','true')"); }
  });

  test('재분석은 확정된 기술 결정을 유지하고 Codex 분석부터 새 회차를 시작한다', async () => {
    const response = await lead('POST', '/api/project/bootstrap/rerun', { revision: 1, instruction: '판단을 다시 받으세요' });
    expect(response.statusCode, response.body).toBe(202);
    const s = await state();
    expect(s.bootstrap).toMatchObject({ runNo: 2, status: 'queued', revision: null, draft: null });
    expect(s.bootstrap.steps.map((x) => `${x.key}:${x.status}`)).toEqual([
      'check:done', 'unzip:done', 'repo:done', 'codex:wait', 'claude:wait', 'cross:wait', 'tech:done', 'draft:wait', 'approve:wait']);
    expect(s.bootstrap.decisions.map((d) => d.status)).toEqual(['fixed', 'fixed', 'approved', 'approved', 'rejected']);
    const old = await lead('POST', '/api/project/bootstrap/approve', { revision: 1 });
    expect(errorOf(old).code).toBe('INVALID_TRANSITION');
    const job = await lease('bootstrap');
    expect(job.payload).toMatchObject({ resumeStep: 'codex', runNo: 2, instruction: '판단을 다시 받으세요' });
  });

  test('PC 사양 보고가 없으면 기준 일정 v1을 계산할 수 없어 승인하지 않는다', async () => {
    const job = await current();
    for (const key of ['codex', 'claude', 'cross']) await progress(job.id, job.fence, key);
    const deps = [{ predRef: 't1', succRef: 't2', depType: 'FS' as const }, { predRef: 't1', succRef: 't3', depType: 'SS' as const }];
    const saved = await runner(`/api/planning/bootstrap/${job.id}/draft`, { fence: job.fence, ...draft([task('t1'), task('t2'), task('t3', { conflictGroup: 'auth' })], deps) });
    expect(saved.json()).toEqual({ revision: 2 });
    await finishJob(job.id);
    await ownerPool.query('alter table runner_hosts rename to runner_hosts_hidden');
    await ownerPool.query('create table runner_hosts (like runner_hosts_hidden including all)');
    await ownerPool.query('grant select on runner_hosts to awbs_app');
    try {
      const response = await lead('POST', '/api/project/bootstrap/approve', { revision: 2 });
      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('INVALID_TRANSITION');
      expect(errorOf(response).message).toContain('PC 사양');
    } finally {
      await ownerPool.query('drop table runner_hosts');
      await ownerPool.query('alter table runner_hosts_hidden rename to runner_hosts');
    }
    expect(await count('select count(*) n from tasks')).toBe(0);
  });

  test('유효한 판단이면 WBS와 기준 일정 v1을 한 트랜잭션으로 만들고, 동시 승인은 하나만 성공한다', async () => {
    const results = await Promise.all([1, 2].map(() => lead('POST', '/api/project/bootstrap/approve', { revision: 2 })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const ok = results.find((r) => r.statusCode === 200);
    expectShape('approveBootstrap', 200, ok?.json());
    expect(ok?.json()).toEqual({ baselineVersion: 1, taskCount: 3 });
    const tasks = (await ownerPool.query<{ task_key: string; status: string; approved: boolean; title: string; conflict_group: string | null; src: number }>(
      `select t.task_key,t.status,t.planning_approved_at is not null approved,t.title,t.conflict_group,v.v src
       from tasks t join input_versions v on v.id=t.src_input_version order by t.task_key`)).rows;
    expect(tasks).toEqual([
      { task_key: 'TASK-0001', status: 'ready', approved: true, title: '작업 t1', conflict_group: null, src: 1 },
      { task_key: 'TASK-0002', status: 'ready', approved: true, title: '작업 t2', conflict_group: null, src: 1 },
      { task_key: 'TASK-0003', status: 'ready', approved: true, title: '작업 t3', conflict_group: 'auth', src: 1 },
    ]);
    const deps = (await ownerPool.query<{ dep: string }>(
      "select p.task_key||'>'||s.task_key||':'||d.dep_type dep from task_dependencies d join tasks p on p.id=d.pred join tasks s on s.id=d.succ order by 1")).rows.map((r) => r.dep);
    expect(deps).toEqual(['TASK-0001>TASK-0002:FS', 'TASK-0001>TASK-0003:SS']);
    expect(await count('select count(*) n from wbs_nodes')).toBe(2);
    expect(await count('select count(*) n from task_specs')).toBe(3);
    expect(await count('select count(*) n from checklist_items')).toBe(3);
    expect(await count('select count(*) n from task_outputs')).toBe(3);
    expect(await count('select count(*) n from task_estimates')).toBe(3);
    expect(await count('select count(*) n from task_grades')).toBe(6);
    // 승인 뒤에도 같은 내용이면 같은 hash다(이후 착수 승인·CP 재대조가 이 기록을 그대로 쓴다).
    const split = (await ownerPool.query<{ basis: string; judged_rules: { items: { subjectHash: string }[] } }>(
      "select s.basis,s.judged_rules from task_splits s join tasks t on t.id=s.task where t.task_key='TASK-0001'")).rows[0];
    const draftHash = (await ownerPool.query<{ h: string }>("select content->'tasks'->0->>'subjectHash' h from wbs_drafts where revision=2")).rows[0]?.h;
    expect(split?.basis).toBe('목적 하나');
    expect(split?.judged_rules.items.map((i) => i.subjectHash)).toEqual([draftHash, draftHash, draftHash]);
    const baseline = (await ownerPool.query<{ v: number; items: string }>('select b.v,(select count(*) from baseline_items i where i.baseline=b.id) items from schedule_baselines b')).rows;
    expect(baseline).toEqual([{ v: 1, items: '3' }]);
    expect(await count("select count(*) n from replans where status='applied' and baseline_v=1")).toBe(1);
    expect(await count("select count(*) n from task_history where kind='생성'")).toBe(3);
    const s = await state();
    expect(s).toMatchObject({ state: 'active', approvedTaskCount: 3 });
    expect(s.inputs[0]?.taskCount).toBe(3);
    expect(s.inputs[0]?.result).toContain('초기 WBS 3건');
    expect(await count("select count(*) n from planning_jobs where kind='bootstrap' and status='done'")).toBe(1);
  });
});

describe('project 입력 자료 변경·분석·분석 안 함(G§4.2 ②)', () => {
  const files = (sha: string, path: string, change = 'modified') => ({ commitSha: sha, path, change, added: 3, deleted: 1 });
  const report = (commits: string[], changed: object[]) => runner('/api/runner/input-changes', {
    commits: commits.map((sha, i) => ({ sha, at: `2026-11-2${String(6 + i)}T0${String(i)}:00:00Z`, author: '팀장', message: `입력 수정 ${String(i)}` })), files: changed });

  test('Runner가 보고한 입력 커밋을 감지 목록에 올리고, 같은 보고는 한 번만 남긴다', async () => {
    const changes = [files(SHA2, 'prototype/docs/guide.md'), files(SHA2, 'prototype/docs/new.md', 'added')];
    expect((await report([SHA2], changes)).statusCode).toBe(204);
    expect((await report([SHA2], changes)).statusCode).toBe(204);
    const unknown = await report([SHA3], [files(SHA4, 'prototype/uiux/a.html')]);
    expect(unknown.statusCode).toBe(400);
    const s = await state();
    expect(s.changeCommits).toEqual([expect.objectContaining({ sha: SHA2, state: 'pending', author: '팀장', message: '입력 수정 0', files: [expect.objectContaining({ path: 'prototype/docs/guide.md' }), expect.objectContaining({ path: 'prototype/docs/new.md' })] })]);
  });

  test('「분석 안 함」은 화면이 본 커밋 목록·프로젝트 버전이 맞을 때만 확인함으로 기록한다', async () => {
    const s = await state();
    const stale = await lead('POST', '/api/project/inputs/skip', { updatedAt: s.updatedAt, commits: [SHA2, SHA3] });
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    const old = await lead('POST', '/api/project/inputs/skip', { updatedAt: '2020-01-01T00:00:00Z', commits: [SHA2] });
    expect(errorOf(old).code).toBe('VERSION_CONFLICT');
    const skipped = await lead('POST', '/api/project/inputs/skip', { updatedAt: s.updatedAt, commits: [SHA2] });
    expect(skipped.statusCode, skipped.body).toBe(204);
    const after = await state();
    expect(after.changeCommits[0]?.state).toBe('skipped');
    expect(after.updatedAt).not.toBe(s.updatedAt);
  });

  test('「이 버전으로 분석」은 건너뛴 변경까지 함께 비교하는 새 입력 버전과 차이 분석 job을 만든다', async () => {
    expect((await report([SHA3], [files(SHA3, 'prototype/docs/new.md'), files(SHA3, 'prototype/uiux/a.html', 'deleted')])).statusCode).toBe(204);
    const s = await state();
    const same = await lead('POST', '/api/project/inputs', { updatedAt: s.updatedAt, commit: SHA1, commits: [SHA3] });
    expect(errorOf(same).code).toBe('INPUT_UNCHANGED');
    const notListed = await lead('POST', '/api/project/inputs', { updatedAt: s.updatedAt, commit: SHA4, commits: [SHA3] });
    expect(notListed.statusCode).toBe(400);
    await ownerPool.query("update system_state set cleanup_status='pending' where id=1");
    try {
      expect(errorOf(await lead('POST', '/api/project/inputs', { updatedAt: s.updatedAt, commit: SHA3, commits: [SHA3] })).code).toBe('CLEANUP_PENDING');
    } finally { await ownerPool.query("update system_state set cleanup_status='none' where id=1"); }
    const response = await lead('POST', '/api/project/inputs', { updatedAt: s.updatedAt, commit: SHA3, commits: [SHA3], instr: '화면 변경 위주' });
    expect(response.statusCode, response.body).toBe(202);
    expectShape('analyzeInputs', 202, response.json());
    const after = await state();
    expect(after.inputs.map((i) => i.v)).toEqual([1, 2]);
    expect(after.inputs[1]).toMatchObject({ commit: SHA3, mdList: ['prototype/docs/guide.md', 'prototype/docs/new.md'],
      changes: [{ path: 'prototype/docs/guide.md', change: 'modified' }, { path: 'prototype/docs/new.md', change: 'added' }, { path: 'prototype/uiux/a.html', change: 'deleted' }] });
    expect(after.changeCommits.map((c) => `${c.sha.slice(0, 1)}:${c.state}`)).toEqual(['b:analyzed', 'c:analyzed']);
    expect(after.inputJob).toMatchObject({ jobId: response.json<{ jobId: string }>().jobId, status: 'queued', version: 2 });
    const job = await lease('input_diff');
    expect(job.payload).toMatchObject({ planningJobId: after.inputJob?.jobId, commit: SHA3, previousCommit: SHA1, version: 2, instruction: '화면 변경 위주', resumeStep: null });
    const again = await lead('POST', '/api/project/inputs', { updatedAt: after.updatedAt, commit: SHA3, commits: [SHA3] });
    expect(errorOf(again).code).toBe('INPUT_UNCHANGED');
  });

  test('차이 분석이 실패하면 실패한 버전으로 끝난 단계를 건너뛰고 다시 시도한다', async () => {
    const job = (await ownerPool.query<{ id: string; fence: number }>("select id,fence from runner_jobs where kind='input_diff' and state='leased'")).rows[0];
    if (!job) throw new Error('임대 job 없음');
    await progress(job.id, job.fence, 'check');
    const wrong = await runner(`/api/runner/bootstrap/${job.id}/progress`, { fence: job.fence, stepKey: 'codex', status: 'run', at: new Date().toISOString() });
    expect(wrong.statusCode).toBe(400);
    await progress(job.id, job.fence, 'unzip', 'fail', '입력 checkout 실패');
    await finishJob(job.id);
    const s = await state();
    expect(s.inputJob?.status).toBe('failed');
    const wrongVersion = await lead('POST', '/api/project/inputs/retry', { updatedAt: s.updatedAt, version: 1 });
    expect(errorOf(wrongVersion).code).toBe('INVALID_TRANSITION');
    const retry = await lead('POST', '/api/project/inputs/retry', { updatedAt: s.updatedAt, version: 2 });
    expect(retry.statusCode, retry.body).toBe(202);
    const next = await lease('input_diff');
    expect(next.payload).toMatchObject({ resumeStep: 'unzip', version: 2 });
    expect((await state()).inputJob?.status).toBe('queued');
  });

  test('Runner 토큰으로는 팀장 프로젝트 API를, 팀장 세션으로는 Runner 보고를 부를 수 없다', async () => {
    const asRunner = await app.inject({ method: 'POST', url: '/api/project/inputs/skip', headers: { authorization: `Bearer ${bearer}`, 'x-project-epoch': String(await epoch()) }, payload: { updatedAt: AT_NOW(), commits: [SHA2] } });
    expect(asRunner.statusCode).toBe(403);
    const asLead = await lead('POST', '/api/runner/input-changes', { commits: [], files: [] });
    expect(asLead.statusCode).toBe(401);
  });
});

function AT_NOW() { return new Date().toISOString(); }

describe('project 리뷰 지적 회귀(M2-03-REVIEW 1~8)', () => {
  /** 초기화 뒤 새 프로젝트를 등록하고 초안 승인 대기까지 진행한다. */
  async function fresh(d = draft()) {
    await resetDb();
    const check = await checkedRepo();
    expect((await lead('POST', '/api/project', registration(check, { constraints: [] }))).statusCode).toBe(201);
    const first = await lease('bootstrap');
    for (const key of ['check', 'unzip', 'repo', 'codex', 'claude', 'cross']) await progress(first.id, first.fence, key);
    expect((await runner(`/api/planning/bootstrap/${first.id}/tech`, { fence: first.fence, decisions: [] })).statusCode).toBe(201);
    await finishJob(first.id);
    const s = await state();
    expect((await lead('POST', `/api/projects/${s.id}/boot/tech/confirm`, { decisions: [] })).statusCode).toBe(200);
    const current = await lease('bootstrap');
    expect((await runner(`/api/planning/bootstrap/${current.id}/draft`, { fence: current.fence, ...d })).statusCode).toBe(201);
    return { current, s: await state() };
  }
  const commit = (sha: string, at: string) => ({ sha, at, author: 'reviewer', message: sha.slice(0, 1) });
  const file = (sha: string, path: string) => ({ commitSha: sha, path, change: 'added', added: 1, deleted: 0 });
  const progressOf = (job: { id: string; fence: number }, stepKey: string, status: string, note?: string) =>
    runner(`/api/runner/bootstrap/${job.id}/progress`, { fence: job.fence, stepKey, status, at: AT_NOW(), ...(note && { note }) });

  test('1. 재분석 뒤 이전 회차 job의 늦은 보고는 409이고 새 회차를 바꾸지 않는다', async () => {
    const { current, s } = await fresh();
    expect((await lead('POST', '/api/project/bootstrap/rerun', { revision: s.bootstrap.revision, instruction: 'new run' })).statusCode).toBe(202);
    const late = await progressOf(current, 'codex', 'fail', 'late run1 error');
    expect(late.statusCode).toBe(409);
    expect(errorOf(late).code).toBe('LEASE_LOST');
    expect((await state()).bootstrap).toMatchObject({ runNo: 2, status: 'queued', fail: null });
    const draftLate = await runner(`/api/planning/bootstrap/${current.id}/draft`, { fence: current.fence, ...draft() });
    expect(errorOf(draftLate).code).toBe('LEASE_LOST');
  });

  test('1. 다시 시도 뒤 이전 job의 늦은 실패 보고는 409이고 새 시도를 실패로 만들지 않는다', async () => {
    const { current } = await fresh();
    await progress(current.id, current.fence, 'codex', 'fail', 'first failure');
    const s = await state();
    expect((await lead('POST', '/api/project/bootstrap/retry', { revision: s.bootstrap.revision })).statusCode).toBe(202);
    const next = await lease('bootstrap');
    const late = await progressOf(current, 'codex', 'fail', 'old retry report');
    expect(errorOf(late).code).toBe('LEASE_LOST');
    expect((await state()).bootstrap).toMatchObject({ status: 'queued', fail: null });
    expect((await progressOf(next, 'codex', 'run')).statusCode).toBe(204);
  });

  test('2. 확인한 커밋 중 최신(보고 순서상 마지막)만 고정하고, 옛 커밋 선택은 400이며 아무것도 소비하지 않는다', async () => {
    const { s } = await fresh();
    expect((await lead('POST', '/api/project/bootstrap/approve', { revision: s.bootstrap.revision })).statusCode).toBe(200);
    // 커밋 시각은 Git 순서가 아니다. 보고 순서(main 이력 순서)가 기준이다: SHA3이 시각은 이르지만 나중 커밋이다.
    expect((await runner('/api/runner/input-changes', { commits: [commit(SHA2, '2026-11-26T03:00:00Z'), commit(SHA3, '2026-11-26T02:00:00Z')],
      files: [file(SHA2, 'prototype/docs/older.md'), file(SHA3, 'prototype/docs/newer.md')] })).statusCode).toBe(204);
    const before = await state();
    expect(before.changeCommits.map((c) => c.sha)).toEqual([SHA2, SHA3]);
    const old = await lead('POST', '/api/project/inputs', { updatedAt: before.updatedAt, commit: SHA2, commits: [SHA2, SHA3] });
    expect(old.statusCode).toBe(400);
    expect(errorOf(old).errors).toEqual([expect.objectContaining({ path: 'commit', rule: 'latest' })]);
    expect((await state()).changeCommits.map((c) => c.state)).toEqual(['pending', 'pending']);
    const ok = await lead('POST', '/api/project/inputs', { updatedAt: before.updatedAt, commit: SHA3, commits: [SHA2, SHA3] });
    expect(ok.statusCode, ok.body).toBe(202);
    expect((await state()).inputs[1]).toMatchObject({ commit: SHA3, mdList: ['prototype/docs/guide.md', 'prototype/docs/newer.md', 'prototype/docs/older.md'] });
  });

  test('3. 외부 쓰기 권한이 막히면(PC 교체) 초기 분석 보고를 EXTERNAL_WRITE_BLOCKED로 거부한다', async () => {
    const { current } = await fresh();
    await ownerPool.query("update external_write_authority set host_id='host-new',generation=generation+1,state='blocked',blocked_reason='PC changed'");
    try {
      const result = await progressOf(current, 'codex', 'run');
      expect(result.statusCode).toBe(409);
      expect(errorOf(result).code).toBe('EXTERNAL_WRITE_BLOCKED');
    } finally {
      await ownerPool.query("update external_write_authority set host_id='host-1',generation=generation+1,state='granted',blocked_reason=null,reconciled_at=now()");
    }
  });

  test('5. 공개 저장소와 prototype/docs 밖 문서로는 저장소 확인이 실패한다', async () => {
    await resetDb();
    for (const result of [{ private: false, structure: STRUCTURE }, { private: true, structure: { ...STRUCTURE, docs: ['src/readme.txt', 'prototype/docs/img.png'] } }]) {
      const id = (await lead('POST', '/api/project/repo-checks', { url: REPO })).json<{ id: string }>().id;
      const job = await lease('repo_check');
      expect((await runner(`/api/runner/repo-checks/${id}/result`, { fence: job.fence, access: true, commit: SHA1, ...result })).statusCode).toBe(204);
      await finishJob(job.id);
      const check = (await lead('GET', `/api/project/repo-checks/${id}`)).json<{ status: string; error: string }>();
      expect(check.status, JSON.stringify(result)).toBe('failed');
      expect(errorOf(await lead('POST', '/api/project', registration(id))).code).toBe('INVALID_TRANSITION');
    }
  });

  test('6. prototype/ 밖 파일은 입력 변경이 아니고, 입력 파일이 없는 커밋은 감지 목록에 올리지 않는다', async () => {
    await fresh();
    const response = await runner('/api/runner/input-changes', { commits: [commit(SHA2, '2026-11-26T01:00:00Z'), commit(SHA3, '2026-11-26T02:00:00Z'), commit(SHA4, '2026-11-26T03:00:00Z')],
      files: [file(SHA2, 'src/agent.ts'), file(SHA4, 'prototype/extra.md'), file(SHA4, 'src/b.ts')] });
    expect(response.statusCode, response.body).toBe(204);
    const s = await state();
    expect(s.changeCommits.map((c) => [c.sha, c.files.map((f) => f.path)])).toEqual([[SHA4, ['prototype/extra.md']]]);
  });

  test('7. 같은 멱등 키의 등록 재전송은 성공 응답을 재생한다', async () => {
    await resetDb();
    const id = await checkedRepo();
    const key = crypto.randomUUID();
    const first = await lead('POST', '/api/project', registration(id), { 'idempotency-key': key });
    expect(first.statusCode).toBe(201);
    const again = await lead('POST', '/api/project', registration(id), { 'idempotency-key': key });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
  });

  test('8. 선언하지 않은 필드 오류는 그 필드 경로를 알려 준다', async () => {
    const result = await lead('POST', '/api/project/repo-checks', { url: REPO, extraField: 'extra-value' });
    expect(result.statusCode).toBe(400);
    expect(errorOf(result).errors).toEqual([expect.objectContaining({ path: 'extraField', rule: 'additionalProperties' })]);
    const wrongType = await lead('POST', '/api/project/bootstrap/approve', { revision: '1' });
    expect(errorOf(wrongType).errors).toEqual([expect.objectContaining({ path: 'revision' })]);
  });
});

describe('project 초기화 뒤 다시 등록', () => {
  test('초기화하면 state=none이고 정리가 끝나야 다시 등록할 수 있다', async () => {
    await resetDb();
    await ownerPool.query("update system_state set cleanup_status='pending' where id=1");
    const s = await state();
    expect(s).toMatchObject({ state: 'none' });
    await ownerPool.query("update system_state set cleanup_status='none' where id=1");
    const id = await checkedRepo();
    const created = await lead('POST', '/api/project', registration(id));
    expect(created.statusCode, created.body).toBe(201);
  });
});
