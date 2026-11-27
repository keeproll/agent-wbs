import { scheduleInput as baselineInput } from '../src/project/baseline.ts';
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { OPERATIONS } from '@awbs/shared/api';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import { installProjectRunner } from '../src/project/runner-routes.ts';
import { installRunner } from '../src/runner/routes.ts';
import { watchRunner } from '../src/runner/watch.ts';
import { RunnerRepository } from '../src/runner/repository.ts';
import { GitRepo } from './git-observe.ts';
import { draft, met, task } from './project-fixture.ts';
import { snapshotHash, wbsSnapshot } from '../src/planning/job-snapshot.ts';
import { judgedContentHash } from '../src/tasks/hash.ts';

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
// M2-05의 claim·release·reconcile 실제 경로로 복구 흐름을 검사한다(재리뷰 R2).
installRunner(app, pool);

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
/** blob·트리 해시처럼 보이는 40자리 SHA(테스트용) */
const fakeSha = (text: string) => createHash('sha1').update(text).digest('hex');
/** 서버 head 시점의 prototype/ 파일별 blob과 트리 해시(테스트의 Runner가 기억하는 값). 새 프로젝트마다 비운다. */
const runnerView = { blobs: new Map<string, string>(), tree: null as string | null };
const forgetRunnerView = () => { runnerView.blobs.clear(); runnerView.tree = null; };
/**
 * 입력 변경 보고. 테스트 편의상 커밋별 파일 변경을 받아 base→head의 prototype/ 트리 차이(raw diff)로 합쳐 보낸다.
 * base를 주지 않으면 서버의 현재 inputHead(Runner가 지난 응답의 head를 쓰는 것과 같다), head는 목록의 마지막 커밋이다.
 */
async function chainReport(commits: object[], files: { commitSha: string; path: string; change: string; added: number; deleted: number }[],
  options: { base?: string; head?: string; baseIsAncestor?: boolean; treeHash?: string; changes?: object[] } = {}) {
  const base = options.base ?? (await app.inject({ url: '/api/project', headers: { cookie } })).json<{ inputHead: string }>().inputHead;
  const head = options.head ?? (commits.at(-1) as { sha: string } | undefined)?.sha ?? base;
  const order = commits.map((c) => (c as { sha: string }).sha);
  const byPath = new Map<string, { first: string; last: string; added: number; deleted: number }>();
  for (const f of [...files].sort((a, b) => order.indexOf(a.commitSha) - order.indexOf(b.commitSha))) {
    const prev = byPath.get(f.path);
    byPath.set(f.path, { first: prev?.first ?? f.change, last: f.change, added: (prev?.added ?? 0) + f.added, deleted: (prev?.deleted ?? 0) + f.deleted });
  }
  const changes = options.changes ?? [...byPath].flatMap(([path, c]) => {
    const before = c.first !== 'added';
    const after = c.last !== 'deleted';
    if (!before && !after) return [];
    const oldBlob = before ? runnerView.blobs.get(path) ?? fakeSha(`${path}@init`) : null;
    const newBlob = after ? fakeSha(`${path}@${head}`) : null;
    return [{ status: !before ? 'A' : !after ? 'D' : 'M', path, oldBlob, newBlob, oldMode: before ? '100644' : null, newMode: after ? '100644' : null, added: c.added, deleted: c.deleted }];
  });
  const treeHash = options.treeHash ?? (changes.length ? fakeSha(`tree@${head}`) : runnerView.tree ?? fakeSha(`tree@${base}`));
  const response = await runner('/api/runner/input-changes', { base, head, baseIsAncestor: options.baseIsAncestor ?? true, treeHash, changes, commits });
  if (response.statusCode === 200 && !options.changes && response.json<{ historyRewritten: boolean }>().historyRewritten === false) {
    for (const c of changes as { path: string; newBlob: string | null }[]) { if (c.newBlob) runnerView.blobs.set(c.path, c.newBlob); else runnerView.blobs.delete(c.path); }
    runnerView.tree = treeHash;
  }
  return response;
}
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
    state: string; id: string; updatedAt: string; epoch: number; inputHead: string; constraints: { id: string; level: string }[];
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

async function checkedRepo(structure: object = STRUCTURE, url = REPO, commit = SHA1): Promise<string> {
  const created = await lead('POST', '/api/project/repo-checks', { url });
  expect(created.statusCode, created.body).toBe(202);
  const { id } = created.json<{ id: string }>();
  const job = await lease('repo_check');
  expect(job.payload).toMatchObject({ url, repoCheckId: id });
  const reported = await runner(`/api/runner/repo-checks/${id}/result`, { fence: job.fence, access: true, private: true, commit, structure });
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
// 테스트 DB를 새로 만들고 마이그레이션 전체를 돌린다. 다른 작업과 PC를 함께 쓸 때 기본 10초를 넘긴 적이 있어 넉넉히 둔다.
}, 60_000);
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
    // M2 통합: 기준 일정 v1은 M2-07 일정과 같은 저장 모양이다(expected에 rLo·rHi, range에 lo·hi, 날짜는 서울 기준).
    const stored = (await ownerPool.query<{ expected: Record<string, unknown>; range: Record<string, unknown> }>('select expected,range from schedule_baselines')).rows[0];
    expect(Object.keys(stored?.expected ?? {}).sort()).toEqual(['actor', 'end', 'rHi', 'rLo', 'trigger']);
    expect(Object.keys(stored?.range ?? {}).sort()).toEqual(['hi', 'lo']);
    const days = (await ownerPool.query<{ key: string; end: string }>(
      "select t.task_key key,to_char(i.\"end\" at time zone 'Asia/Seoul','YYYY-MM-DD') \"end\",to_char(i.\"end\" at time zone 'Asia/Seoul','HH24:MI') hm from baseline_items i join tasks t on t.id=i.task order by 1")).rows;
    expect(days.every((d) => (d as unknown as { hm: string }).hm === '00:00')).toBe(true);
    const schedule = await lead('GET', '/api/schedule');
    expect(schedule.statusCode, schedule.body).toBe(200);
    const viewed = schedule.json<{ tasks: { taskKey: string; baselineEnd: string | null }[] }>().tasks.map((t) => ({ key: t.taskKey, end: t.baselineEnd })).sort((a, b) => a.key.localeCompare(b.key));
    expect(viewed).toEqual(days.map(({ key, end }) => ({ key, end })));
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
  const pushed = (commits: string[]) => commits.map((sha, i) => ({ sha, at: `2026-11-2${String(6 + i)}T0${String(i)}:00:00Z`, author: '팀장', message: `입력 수정 ${String(i)}` }));
  const report = (commits: string[], changed: ReturnType<typeof files>[]) => chainReport(pushed(commits), changed);

  test('Runner가 보고한 입력 커밋을 감지 목록에 올리고, 같은 보고를 다시 보내면 base가 낡아 409와 현재 head를 받는다', async () => {
    const changes = [files(SHA2, 'prototype/docs/guide.md'), files(SHA2, 'prototype/docs/new.md', 'added')];
    const first = await report([SHA2], changes);
    expect(first.statusCode, first.body).toBe(200);
    expectShape('reportInputChanges', 200, first.json());
    expect(first.json()).toEqual({ head: SHA2, recorded: true, historyRewritten: false });
    const again = await chainReport(pushed([SHA2]), changes, { base: SHA1 });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again)).toMatchObject({ code: 'VERSION_CONFLICT', details: { current: { base: SHA2 } } });
    // 상태와 blob이 맞지 않는 차이(수정인데 전후 blob이 같음)는 계산이 잘못된 보고다.
    const broken = await chainReport(pushed([SHA3]), [], { changes: [{ status: 'M', path: 'prototype/uiux/a.html', oldBlob: fakeSha('a'), newBlob: fakeSha('a'), oldMode: '100644', newMode: '100644', added: 0, deleted: 0 }] });
    expect(broken.statusCode).toBe(400);
    const s = await state();
    expect(s.changeCommits).toEqual([expect.objectContaining({ sha: SHA2, state: 'pending', author: '팀장', message: '입력 수정 0', files: [expect.objectContaining({ path: 'prototype/docs/guide.md' }), expect.objectContaining({ path: 'prototype/docs/new.md' })] })]);
  });

  test('「분석 안 함」은 화면이 본 커밋 목록·프로젝트 버전이 맞을 때만 확인함으로 기록한다', async () => {
    const s = await state();
    expect((await chainReport([], [])).statusCode).toBe(200);
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
    expect((await report([SHA3], [files(SHA3, 'prototype/docs/new.md'), files(SHA3, 'prototype/uiux/a.html', 'deleted')])).statusCode).toBe(200);
    const s = await state();
    const same = await lead('POST', '/api/project/inputs', { updatedAt: s.updatedAt, commit: SHA1, commits: [SHA3] });
    expect((await chainReport([], [])).statusCode).toBe(200);
    expect(errorOf(same).code).toBe('INPUT_UNCHANGED');
    const notListed = await lead('POST', '/api/project/inputs', { updatedAt: s.updatedAt, commit: SHA4, commits: [SHA3] });
    expect(notListed.statusCode).toBe(400);
    await ownerPool.query("update system_state set cleanup_status='pending' where id=1");
    try {
      expect(errorOf(await lead('POST', '/api/project/inputs', { updatedAt: s.updatedAt, commit: SHA3, commits: [SHA3] })).code).toBe('CLEANUP_PENDING');
    } finally { await ownerPool.query("update system_state set cleanup_status='none' where id=1"); }
    // M2 통합(M2-06 P3-1): Gate에 있는 Task는 새 입력 버전과 같은 트랜잭션에서 근거 무효화 판정을 받는다.
    const gateTask = (await ownerPool.query<{ id: string }>("update tasks set status='gate' where id=(select id from tasks where deleted_at is null order by task_key limit 1) returning id")).rows[0]?.id;
    const response = await lead('POST', '/api/project/inputs', { updatedAt: s.updatedAt, commit: SHA3, commits: [SHA3], instr: '화면 변경 위주' });
    expect(response.statusCode, response.body).toBe(202);
    expectShape('analyzeInputs', 202, response.json());
    expect((await ownerPool.query('select status from tasks where id=$1', [gateTask])).rows).toEqual([{ status: 'verifying' }]);
    expect((await ownerPool.query<{ text: string }>("select text from task_history where task=$1 and kind='재검증'", [gateTask])).rows[0]?.text).toContain('입력 버전');
    await ownerPool.query("update tasks set status='ready' where id=$1", [gateTask]);
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

describe('서버 후속 4: Runner 계약과 분석 완료', () => {
  async function finishClaim(job: { id: string; fence: number }) {
    expect((await runner(`/api/runner/jobs/${job.id}/finish`, { fence: job.fence, status: 'done' })).statusCode).toBe(204);
    expect((await runner(`/api/runner/jobs/${job.id}/release`, { fence: job.fence, hostId: 'host-1', proof: { kind: 'no_process', bootId: 'boot-1' }, at: AT_NOW() })).statusCode).toBe(204);
  }
  async function claim(kind: string) {
    const response = await runner('/api/runner/jobs/claim', { kinds: [kind], capacity: 10 });
    expect(response.statusCode, response.body).toBe(200);
    expectShape('claimJob', 200, response.json());
    return response.json<{ job: { id: string; fence: number; kind: string; leaseUntil: string; payload: Record<string, unknown> } }>().job;
  }
  async function confirmed(subagentDefs: Record<string, unknown>[] = []) {
    await resetDb();
    forgetRunnerView();
    const check = await checkedRepo();
    expect((await lead('POST', '/api/project', registration(check, {
      constraints: [{ name: 'QuestDB', level: 'cond', condition: '시계열 데이터가 있으면' }],
    }))).statusCode).toBe(201);
    const first = await claim('bootstrap');
    const constraints = (await ownerPool.query('select id,name,level,condition from tech_constraints order by created_at,id')).rows;
    expect(first.payload).toEqual({
      planningJobId: (await state()).bootstrap.jobId, runNo: 1, version: 1, commit: SHA1, previousCommit: null,
      instruction: '계약 먼저', resumeStep: null, techConstraints: constraints, subagentDefs,
      techDecisions: [], techDecisionVersion: snapshotHash([]),
    });
    expect(constraints).toEqual([{ id: expect.any(String), name: 'QuestDB', level: 'cond', condition: '시계열 데이터가 있으면' }]);
    for (const field of ['planningJobId', 'runNo', 'version', 'techConstraints', 'techDecisionVersion']) {
      const payload = Object.fromEntries(Object.entries(first.payload).filter(([key]) => key !== field));
      expect(ajv.validate(OPERATIONS.find((op) => op.id === 'claimJob')?.responses[200], { job: { ...first, payload } }), field).toBe(false);
    }
    for (const key of ['check', 'unzip', 'repo', 'codex', 'claude', 'cross']) await progress(first.id, first.fence, key);
    const proposed = await runner(`/api/planning/bootstrap/${first.id}/tech`, {
      fence: first.fence,
      decisions: [{ area: '데이터', title: '캐시', choice: 'Redis', reason: '속도', alternatives: '메모리' }],
      conditionJudgements: [{ constraintId: constraints[0]?.id, result: 'not_met', reason: '시계열 데이터가 없습니다.' }],
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    await finishClaim(first);
    const s = await state();
    expect((await lead('POST', `/api/projects/${s.id}/boot/tech/confirm`, {
      decisions: s.bootstrap.decisions.map((decision) => ({ id: decision.id, choice: 'reject', updatedAt: decision.updatedAt })),
    })).statusCode).toBe(200);
    const next = await claim('bootstrap');
    expect(next.payload).toMatchObject({ ...first.payload, resumeStep: 'draft', techDecisions: expect.any(Array), techDecisionVersion: expect.any(String) });
    const decisions = next.payload.techDecisions as { id: string; status: string; updatedAt: string; content: { choice: string } }[];
    expect(decisions.map((decision) => ({ status: decision.status, choice: decision.content.choice }))).toEqual([
      { status: 'rejected', choice: 'QuestDB' }, { status: 'rejected', choice: 'Redis' },
    ]);
    expect(next.payload.techDecisionVersion).toBe(snapshotHash(decisions));
    return { job: next, s: await state(), decisions };
  }
  async function active(content = draft()) {
    const { job, s } = await confirmed();
    const submitted = await runner(`/api/planning/bootstrap/${job.id}/draft`, { fence: job.fence, ...content });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const approved = await lead('POST', '/api/project/bootstrap/approve', { revision: submitted.json<{ revision: number }>().revision });
    expect(approved.statusCode, approved.body).toBe(200);
    await finishClaim(job);
    return s.id;
  }
  async function input(sha: string) {
    expect((await chainReport([{ sha, at: AT_NOW(), author: '개발자', message: '입력 변경' }], [
      { commitSha: sha, path: `prototype/docs/${sha[0] ?? ''}.md`, change: 'added', added: 1, deleted: 0 },
    ])).statusCode).toBe(200);
    const s = await state();
    const response = await lead('POST', '/api/project/inputs', { updatedAt: s.updatedAt, commit: sha, commits: [sha] });
    expect(response.statusCode, response.body).toBe(202);
    return claim('input_diff');
  }

  test('조건부 제약의 실제 claim→제안→반려 후, 결정이 바뀌면 옛 초안을 거부한다', async () => {
    const { job, decisions } = await confirmed();
    await ownerPool.query("update tech_decisions set content=content||'{\"choice\":\"새 결정\"}'::jsonb where id=$1", [decisions[0]?.id]);
    const stale = await runner(`/api/planning/bootstrap/${job.id}/draft`, { fence: job.fence, ...draft() });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    expect(await count('select count(*) n from wbs_drafts')).toBe(0);
    await progress(job.id, job.fence, 'draft', 'fail', '기술 결정이 바뀜');
    await finishClaim(job);
    expect((await lead('POST', '/api/project/bootstrap/retry', { revision: null, runNo: 1 })).statusCode).toBe(202);
    const retried = await claim('bootstrap');
    expect(retried.payload).toMatchObject({ runNo: 2, version: 1, resumeStep: 'codex', techConstraints: job.payload.techConstraints });
    expect(retried.payload.techDecisionVersion).not.toBe(job.payload.techDecisionVersion);
    for (const key of ['codex', 'claude', 'cross']) await progress(retried.id, retried.fence, key);
    expect((await runner(`/api/planning/bootstrap/${retried.id}/draft`, { fence: retried.fence, ...draft() })).statusCode).toBe(201);
  });

  test('초안의 옛 입력 지문은 새 제목으로 바꿔 저장하지 않으며 같은 입력 지문만 받는다', async () => {
    const { job } = await confirmed();
    const old = draft();
    const first = old.tasks[0];
    if (!first) throw new Error('초안 없음');
    first.title = '판단 뒤 바꾼 제목';
    const rejected = await runner(`/api/planning/bootstrap/${job.id}/draft`, { fence: job.fence, ...old });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(errorOf(rejected).code).toBe('VERSION_CONFLICT');
    expect(errorOf(rejected).details.subjectHash).toBe(draft([task('t1', { title: first.title })], []).tasks[0]?.judgedRules?.items[0]?.sourceRef.slice(7));
    expect(await count('select count(*) n from wbs_drafts')).toBe(0);
    const invalid = draft();
    const invalidTask = invalid.tasks[0];
    if (!invalidTask) throw new Error('초안 없음');
    invalidTask.title = '\ud800';
    expect((await runner(`/api/planning/bootstrap/${job.id}/draft`, { fence: job.fence, ...invalid })).statusCode).toBe(400);
    const correct = draft([task('t1', { title: first.title }), task('t2')]);
    const accepted = await runner(`/api/planning/bootstrap/${job.id}/draft`, { fence: job.fence, ...correct });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const stored = (await state()).bootstrap.draft?.tasks[0]?.judgedRules?.items[0];
    expect(stored?.subjectHash).toBe(correct.tasks[0]?.judgedRules?.items[0]?.sourceRef.slice(7));
  });

  test('저장한 초안도 결정이 바뀌면 승인할 수 없고 재분석은 새 결정 스냅샷을 받는다', async () => {
    const { job, decisions } = await confirmed();
    const submitted = await runner(`/api/planning/bootstrap/${job.id}/draft`, { fence: job.fence, ...draft() });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const revision = submitted.json<{ revision: number }>().revision;
    await ownerPool.query("update tech_decisions set content=content||'{\"choice\":\"새 결정\"}'::jsonb where id=$1", [decisions[0]?.id]);
    const stale = await lead('POST', '/api/project/bootstrap/approve', { revision });
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    expect((await lead('POST', '/api/project/bootstrap/rerun', { revision, instruction: '새 결정으로 분석' })).statusCode).toBe(202);
    await finishClaim(job);
    const next = await claim('bootstrap');
    expect(next.payload).toMatchObject({ runNo: 2, version: 1, resumeStep: 'codex', techConstraints: job.payload.techConstraints });
    expect(next.payload.techDecisionVersion).not.toBe(job.payload.techDecisionVersion);
    expect((next.payload.techDecisions as typeof decisions)[0]?.content.choice).toBe('새 결정');
    for (const key of ['codex', 'claude', 'cross']) await progress(next.id, next.fence, key);
    expect((await runner(`/api/planning/bootstrap/${next.id}/draft`, { fence: next.fence, ...draft() })).statusCode).toBe(201);
  });

  test('현재 WBS를 전달하고, 앞 단계가 끝난 cp:done 뒤 다음 차이 분석을 시작한다(변경 없음 포함)', async () => {
    const projectId = await active();
    const first = await input(SHA2);
    expect(first.payload).toEqual({ planningJobId: (await state()).inputJob?.jobId, runNo: 1, version: 2,
      commit: SHA2, previousCommit: SHA1, instruction: '', resumeStep: null, wbs: await wbsSnapshot(ownerPool, projectId) });
    const wbs = first.payload.wbs as Awaited<ReturnType<typeof wbsSnapshot>>;
    expect(wbs.tasks).toHaveLength(2);
    expect(wbs.tasks[0]).toMatchObject({ taskKey: 'TASK-0001', workType: 'Implementation', status: 'ready', wp: expect.any(String), content: { title: '작업 t1' } });
    expect(wbs.dependencies).toEqual([{ pred: 'TASK-0001', succ: 'TASK-0002', type: 'FS' }]);
    const premature = await runner(`/api/runner/bootstrap/${first.id}/progress`, { fence: first.fence, stepKey: 'cp', status: 'done', at: AT_NOW() });
    expect(errorOf(premature).code).toBe('INVALID_TRANSITION');
    for (const key of ['check', 'unzip', 'diff', 'impact']) await progress(first.id, first.fence, key);
    const complete = { fence: first.fence, stepKey: 'cp', status: 'done', at: AT_NOW(), note: '변경 없음' };
    const key = crypto.randomUUID();
    expect((await runner(`/api/runner/bootstrap/${first.id}/progress`, complete, key)).statusCode).toBe(204);
    expect((await runner(`/api/runner/bootstrap/${first.id}/progress`, complete, key)).statusCode).toBe(204);
    expect((await runner(`/api/runner/bootstrap/${first.id}/progress`, complete)).statusCode).toBe(204);
    expect((await state()).inputJob?.status).toBe('done');
    await finishClaim(first);
    const second = await input(SHA3);
    expect(second.payload).toMatchObject({ version: 3, previousCommit: SHA2 });
    for (const step of ['check', 'unzip', 'diff', 'impact', 'cp']) await progress(second.id, second.fence, step);
    expect((await state()).inputJob?.status).toBe('done');
  });

  test('차이 분석 중 내용·작업 유형·상태·작업 묶음·의존 관계가 바뀌면 제안을 거부한다', async () => {
    await active();
    const movedWp = (await ownerPool.query<{ id: string }>(`insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order)
      select project_id,'WP-99','work_package',parent_id,'다른 묶음',99 from wbs_nodes where kind='work_package' limit 1 returning id`)).rows[0]?.id;
    const job = await input(SHA2);
    const submit = () => runner('/api/planning/proposals', { jobId: job.id, fence: job.fence, title: '완료 조건 수정', reason: '입력 변경', source: { kind: 'input' },
      ops: [{ op: 'modify', task: 'TASK-0001', field: 'doneCond', after: '새 완료 조건' }] });
    await ownerPool.query("update tasks set title='바뀐 제목' where task_key='TASK-0001'");
    expect(errorOf(await submit()).code).toBe('VERSION_CONFLICT');
    await ownerPool.query("update tasks set title='작업 t1',status='planning' where task_key='TASK-0001'");
    expect(errorOf(await submit()).code).toBe('VERSION_CONFLICT');
    await ownerPool.query("update tasks set status='ready' where task_key='TASK-0001'");
    await ownerPool.query("update tasks set work_type='Analysis' where task_key='TASK-0001'");
    expect(errorOf(await submit()).code).toBe('VERSION_CONFLICT');
    await ownerPool.query("update tasks set work_type='Implementation' where task_key='TASK-0001'");
    const oldWp = (job.payload.wbs as Awaited<ReturnType<typeof wbsSnapshot>>).tasks[0]?.wp;
    await ownerPool.query("update tasks set wbs_node_id=$1 where task_key='TASK-0001'", [movedWp]);
    expect(errorOf(await submit()).code).toBe('VERSION_CONFLICT');
    await ownerPool.query("update tasks set wbs_node_id=$1 where task_key='TASK-0001'", [oldWp]);
    await ownerPool.query("update task_dependencies set dep_type='SS'");
    expect(errorOf(await submit()).code).toBe('VERSION_CONFLICT');
    await ownerPool.query("update task_dependencies set dep_type='FS'");
    const ok = await submit();
    expect(ok.statusCode, ok.body).toBe(201);
    const judgement = await claim('planning');
    expect(judgement.payload).toMatchObject({ planning: null, proposal: { id: ok.json<{ id: string }>().id } });
    await finishClaim(judgement);
    for (const step of ['check', 'unzip', 'diff', 'impact', 'cp']) await progress(job.id, job.fence, step);
    expect((await state()).inputJob?.status).toBe('done');
    expect(errorOf(await submit()).code).toBe('INVALID_TRANSITION');
  });

  test('낡은 WBS로 실패한 차이 분석을 다시 시도하면 새 회차·현재 스냅샷으로 비교부터 한다', async () => {
    await active();
    const first = await input(SHA2);
    for (const key of ['check', 'unzip', 'diff', 'impact']) await progress(first.id, first.fence, key);
    await ownerPool.query("update tasks set title='수정한 제목' where task_key='TASK-0001'");
    await progress(first.id, first.fence, 'cp', 'fail', '판단 대상이 바뀜');
    await finishClaim(first);
    const s = await state();
    expect((await lead('POST', '/api/project/inputs/retry', { updatedAt: s.updatedAt, version: 2 })).statusCode).toBe(202);
    const next = await claim('input_diff');
    expect(next.payload).toMatchObject({ runNo: 2, version: 2, resumeStep: 'diff' });
    expect((next.payload.wbs as Awaited<ReturnType<typeof wbsSnapshot>>).tasks[0]?.content.title).toBe('수정한 제목');
    for (const key of ['diff', 'impact', 'cp']) await progress(next.id, next.fence, key);
    expect((await state()).inputJob?.status).toBe('done');
  });

  test('분할 job은 원 Task의 작업 묶음과 양쪽 그래프를 전달하고 그래프가 바뀌면 거부한다', async () => {
    await active(draft([task('t1'), task('t2', { workType: 'Analysis', conflictGroup: 'shared-db' }), task('t3')], [
      { predRef: 't1', succRef: 't2', depType: 'FS' }, { predRef: 't2', succRef: 't3', depType: 'FS' },
    ]));
    const detail = async () => (await lead('GET', '/api/tasks/TASK-0002')).json<{ updatedAt: string }>();
    const split = () => detail().then((d) => lead('POST', '/api/tasks/TASK-0002/split', { updatedAt: d.updatedAt }));
    const queued = await split();
    expect(queued.statusCode, queued.body).toBe(202);
    const job = await claim('split');
    const wbs = job.payload.wbs as Awaited<ReturnType<typeof wbsSnapshot>>;
    expect(job.payload.tasks).toEqual([expect.objectContaining({ taskKey: 'TASK-0002', workType: 'Analysis' })]);
    expect(wbs.tasks.find((item) => item.taskKey === 'TASK-0002')?.workType).toBe('Analysis');
    const wp = wbs.tasks.find((item) => item.taskKey === 'TASK-0002')?.wp;
    expect(wp).toEqual(expect.any(String));
    expect(wbs.dependencies).toEqual([
      { pred: 'TASK-0001', succ: 'TASK-0002', type: 'FS' }, { pred: 'TASK-0002', succ: 'TASK-0003', type: 'FS' },
    ]);
    const part = (ref: string) => ({ op: 'add', ref, preds: [{ pred: 'TASK-0001', type: 'FS' }],
      t: { title: ref, type: 'Analysis', domain: 'BE', wp, priority: 1, assignee: 'Claude', verifier: 'Codex', purpose: '분할', doneCond: '완료', splitBasis: '목적별 분할' } });
    const body = { jobId: job.id, fence: job.fence, title: '분할', reason: '목적별 분할', source: { kind: 'split', id: 'TASK-0002' }, ops: [
      part('NEW-1'), part('NEW-2'), { op: 'remove', task: 'TASK-0002' },
      { op: 'dep-add', pred: 'NEW-1', succ: 'TASK-0003', type: 'FS' }, { op: 'dep-add', pred: 'NEW-2', succ: 'TASK-0003', type: 'FS' },
    ] };
    await ownerPool.query("update task_dependencies set dep_type='SS' where pred=(select id from tasks where task_key='TASK-0001')");
    expect(errorOf(await runner('/api/planning/proposals', body)).code).toBe('VERSION_CONFLICT');
    expect((await split()).json<{ jobId: string }>().jobId).not.toBe(job.id);
    await ownerPool.query("update task_dependencies set dep_type='FS'");
    const result = await runner('/api/planning/proposals', body);
    expect(result.statusCode, result.body).toBe(201);
    const preview = await lead('GET', `/api/proposals/${result.json<{ id: string }>().id}/preview`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json<{ diff: { field: string; after: unknown }[] }>().diff.filter((item) => item.field === 'conflictGroup').map((item) => item.after))
      .toEqual(['shared-db', 'shared-db']);
  });

  test('Planning 세션의 실제 claim에는 세션 ID·제목·범위가 있다', async () => {
    await active();
    const started = await lead('POST', '/api/plannings', { title: '알림 개편', scope: '알림 API' });
    expect(started.statusCode, started.body).toBe(202);
    const job = await claim('planning');
    expect(job.payload).toEqual({ tasks: [], policy: {}, proposal: null,
      planning: { id: started.json<{ id: string }>().id, title: '알림 개편', scope: '알림 API' } });
  });

  test('허용한 하위 Agent 정의의 ID·버전·역할을 초기 분석과 후속 job에 전달한다', async () => {
    const id = (await ownerPool.query<{ id: string }>(`insert into subagent_defs(def_key,version,agent,role,tools,sandbox,text,hash,allowed)
      values('srv4-dev',1,'Claude','dev','{}','workspace-write','개발 역할',$1,true) returning id`, ['a'.repeat(64)])).rows[0]?.id;
    try {
      const { job } = await confirmed([{ id, defKey: 'srv4-dev', version: 1, agent: 'Claude', role: 'dev' }]);
      expect(job.payload.subagentDefs).toEqual([{ id, defKey: 'srv4-dev', version: 1, agent: 'Claude', role: 'dev' }]);
    } finally { await ownerPool.query('update subagent_defs set allowed=false where id=$1', [id]); }
  });

  test('R1: 무관한 Task의 상태·내용 변경은 허용하고 인접 Task의 내용 변경은 거부한다', async () => {
    await active(draft([task('t1'), task('t2'), task('t3')]));
    const job = await input(SHA2);
    const submit = () => runner('/api/planning/proposals', { jobId: job.id, fence: job.fence, title: '수정', reason: '입력 변경', source: { kind: 'input' },
      ops: [{ op: 'modify', task: 'TASK-0001', field: 'doneCond', after: '새 완료 조건' }] });
    await ownerPool.query("update tasks set status='planning',title='무관한 변경' where task_key='TASK-0003'");
    const accepted = await submit();
    expect(accepted.statusCode, accepted.body).toBe(201);
    await ownerPool.query("update tasks set title='선후행 이웃 변경' where task_key='TASK-0002'");
    expect(errorOf(await submit()).code).toBe('VERSION_CONFLICT');
  });

  test('R1: 새로 연결된 인접 그래프도 낡은 대상이며, 추가 Task의 선행 대상도 검사한다', async () => {
    await active(draft([task('t1'), task('t2'), task('t3')], []));
    const job = await input(SHA2);
    await ownerPool.query(`insert into task_dependencies(project_id,pred,succ,dep_type)
      select p.project_id,p.id,s.id,'FS' from tasks p,tasks s where p.task_key='TASK-0001' and s.task_key='TASK-0003'`);
    const response = await runner('/api/planning/proposals', { jobId: job.id, fence: job.fence, title: '수정', reason: '입력 변경', source: { kind: 'input' },
      ops: [{ op: 'modify', task: 'TASK-0001', field: 'doneCond', after: '새 완료 조건' }] });
    expect(errorOf(response).code).toBe('VERSION_CONFLICT');
    const wp = (job.payload.wbs as Awaited<ReturnType<typeof wbsSnapshot>>).tasks[0]?.wp;
    const added = await runner('/api/planning/proposals', { jobId: job.id, fence: job.fence, title: '추가', reason: '입력 변경', source: { kind: 'input' }, ops: [
      { op: 'add', ref: 'NEW-1', preds: [{ pred: 'TASK-0001', type: 'FS' }], t: {
        title: '추가 작업', type: 'Implementation', domain: 'BE', wp, priority: 1, assignee: 'Claude', verifier: 'Codex', purpose: '목적', doneCond: '완료',
      } },
    ] });
    expect(errorOf(added).code).toBe('VERSION_CONFLICT');
  });

  test('R2: 자동 반영한 같은 분석의 여러 CP를 순서대로 받고 무관한 외부 변경은 기준에 섞지 않는다', async () => {
    await active(draft([task('t1'), task('t2'), task('t3')]));
    await ownerPool.query('update schedule_policy set cp_auto=true');
    try {
      const job = await input(SHA2);
      await ownerPool.query("update tasks set title='외부에서 바뀐 제목' where task_key='TASK-0003'");
      const submit = async (target: string, after: string) => {
        const current = (await wbsSnapshot(ownerPool, (await state()).id)).tasks.find((task) => task.taskKey === target);
        const hash = judgedContentHash({ ...current?.content, doneCond: after });
        return runner('/api/planning/proposals', { jobId: job.id, fence: job.fence, title: '수정', reason: '입력 변경', source: { kind: 'input' },
          ops: [{ op: 'modify', task: target, field: 'doneCond', after }],
          taskJudgements: [{ taskKey: target, judgedRules: { schemaVersion: 1, items: [met('revert', hash), met('contract', hash), met('refactor', hash)] } }] });
      };
      for (const [target, after] of [['TASK-0001', '첫 변경'], ['TASK-0001', '같은 대상의 다음 변경'], ['TASK-0002', '이웃의 다음 변경']]) {
        const result = await submit(target ?? '', after ?? '');
        expect(result.statusCode, result.body).toBe(201);
        expect(result.json<{ status: string }>().status).toBe('applied');
      }
      const payload = (await ownerPool.query<{ payload: { wbs: Awaited<ReturnType<typeof wbsSnapshot>> } }>('select payload from runner_jobs where id=$1', [job.id])).rows[0]?.payload;
      expect(payload?.wbs.tasks.find((t) => t.taskKey === 'TASK-0001')?.content.doneCond).toBe('같은 대상의 다음 변경');
      expect(payload?.wbs.tasks.find((t) => t.taskKey === 'TASK-0003')?.content.title).toBe('작업 t3');
      expect(errorOf(await submit('TASK-0003', '낡은 대상 변경')).code).toBe('VERSION_CONFLICT');
    } finally { await ownerPool.query('update schedule_policy set cp_auto=false'); }
  });

  test.each(['failed', 'cancelled'])('R3: 단계 fail 없이 Runner가 %s로 끝나도 원인을 남기고 다시 시도할 수 있다', async (status) => {
    await active();
    const job = await input(SHA2);
    for (const key of ['check', 'unzip', 'diff', 'impact']) await progress(job.id, job.fence, key);
    const body = { fence: job.fence, status, error: { code: 'RUNNER_PROCESS_FAILED', message: '분석 프로세스 종료' } };
    const key = crypto.randomUUID();
    expect((await runner(`/api/runner/jobs/${job.id}/finish`, body, key)).statusCode).toBe(204);
    expect((await runner(`/api/runner/jobs/${job.id}/finish`, body, key)).statusCode).toBe(204);
    const planning = (await ownerPool.query<{ status: string; fail: { code: string; reason: string } }>('select status,fail from planning_jobs where id=$1', [job.payload.planningJobId])).rows[0];
    expect(planning).toMatchObject({ status: 'failed', fail: { code: 'RUNNER_PROCESS_FAILED', reason: '분석 프로세스 종료' } });
    const s = await state();
    const retry = await lead('POST', '/api/project/inputs/retry', { updatedAt: s.updatedAt, version: 2 });
    expect(retry.statusCode, retry.body).toBe(202);
    // 이전 job의 뒤늦은 종료 처리는 새 시도를 바꾸지 않는다.
    const client = await ownerPool.connect();
    try { await client.query('begin'); await new RunnerRepository(client).state(job.id, status); await client.query('commit'); }
    catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
    expect((await state()).inputJob?.status).toBe('queued');
  });

  test('R3: 임대 만료는 분석을 실패로 닫고, 수동 재시도 뒤 옛 reconcile은 새 job을 덮지 않는다', async () => {
    await active();
    const job = await input(SHA2);
    for (const key of ['check', 'unzip', 'diff', 'impact']) await progress(job.id, job.fence, key);
    expect(await watchRunner(pool, await epoch(), new Date(Date.now() + 61_000))).toBe(1);
    const row = (await ownerPool.query<{ status: string; fail: { code: string } }>('select status,fail from planning_jobs where id=$1', [job.payload.planningJobId])).rows[0];
    expect(row).toMatchObject({ status: 'failed', fail: { code: 'LEASE_LOST' } });
    const s = await state();
    expect((await lead('POST', '/api/project/inputs/retry', { updatedAt: s.updatedAt, version: 2 })).statusCode).toBe(202);
    expect((await runner(`/api/runner/jobs/${job.id}/release`, { fence: job.fence, hostId: 'host-1', proof: { kind: 'no_process', bootId: 'boot-1' }, at: AT_NOW() })).statusCode).toBe(204);
    expect((await runner(`/api/runner/jobs/${job.id}/reconcile`, { fence: job.fence, evidence: { outcome: 'none', checkedAt: AT_NOW(), detail: {} } })).statusCode).toBe(204);
    expect((await ownerPool.query('select 1 from runner_jobs where dedup_key=$1', [`reconcile:${job.id}:${job.fence}`])).rowCount).toBe(0);
    const next = await claim('input_diff');
    for (const key of ['cp']) await progress(next.id, next.fence, key);
    expect((await state()).inputJob?.status).toBe('done');
  });

  test('R3: Runner crash로 생존 보고가 멈추어도 분석을 닫고 다음 입력 분석이 시작된다', async () => {
    await active();
    const job = await input(SHA2);
    expect((await runner('/api/runner/sessions', { runnerId: 'test-runner', event: 'start', at: new Date(Date.now() - 86_400_000).toISOString() })).statusCode).toBe(204);
    expect(await watchRunner(pool, await epoch())).toBe(1);
    expect((await state()).inputJob?.status).toBe('failed');
    expect((await ownerPool.query('select slot_state from execution_holds where job=$1', [job.id])).rows[0]?.slot_state).toBe('unconfirmed');
    expect((await runner(`/api/runner/jobs/${job.id}/release`, { fence: job.fence, hostId: 'host-1', proof: { kind: 'no_process', bootId: 'boot-1' }, at: AT_NOW() })).statusCode).toBe(204);
    const next = await input(SHA3);
    expect(next.payload.version).toBe(3);
  });

  test('R3: bootstrap의 단계 fail 없는 종료도 분석 실패가 되며 다시 시도한다', async () => {
    const { job } = await confirmed();
    const finished = await runner(`/api/runner/jobs/${job.id}/finish`, { fence: job.fence, status: 'failed', error: { code: 'PROCESS_EXIT', message: '초안 작성 프로세스 종료' } });
    expect(finished.statusCode, finished.body).toBe(204);
    expect((await state()).bootstrap).toMatchObject({ status: 'failed', fail: { reason: '초안 작성 프로세스 종료' } });
    expect((await lead('POST', '/api/project/bootstrap/retry', { revision: null, runNo: 1 })).statusCode).toBe(202);
  });

  test('R3: cp:done 없이 성공 종료한 Runner도 분석을 방치하지 않고 누락 원인을 남긴다', async () => {
    await active();
    const job = await input(SHA2);
    const response = await runner(`/api/runner/jobs/${job.id}/finish`, { fence: job.fence, status: 'done' });
    expect(response.statusCode, response.body).toBe(204);
    expect((await ownerPool.query('select status,fail from planning_jobs where id=$1', [job.payload.planningJobId])).rows[0])
      .toMatchObject({ status: 'failed', fail: { code: 'INCOMPLETE_ANALYSIS' } });
  });

  async function analyzedBootstrap() {
    await resetDb();
    forgetRunnerView();
    const check = await checkedRepo();
    expect((await lead('POST', '/api/project', registration(check, { constraints: [] }))).statusCode).toBe(201);
    const job = await claim('bootstrap');
    for (const key of ['check', 'unzip', 'repo', 'codex', 'claude', 'cross']) await progress(job.id, job.fence, key);
    return job;
  }

  test.each([
    ['T1', 'tech', 'expiry'], ['T1', 'tech', 'restart'], ['T1', 'tech', 'failed'], ['T1', 'tech', 'cancelled'],
    ['T2', 'approve', 'expiry'], ['T2', 'approve', 'restart'], ['T2', 'approve', 'failed'], ['T2', 'approve', 'cancelled'],
  ])('%s: %s 대기 중 %s여도 사람의 결정만 기다리며 재시도·대체 job을 만들지 않는다', async (_id, phase, stop) => {
    const job = phase === 'tech' ? await analyzedBootstrap() : (await confirmed()).job;
    const submitted = phase === 'tech'
      ? await runner(`/api/planning/bootstrap/${job.id}/tech`, { fence: job.fence, decisions: [] })
      : await runner(`/api/planning/bootstrap/${job.id}/draft`, { fence: job.fence, ...draft() });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const before = await state();
    const jobsBefore = await count("select count(*) n from runner_jobs where kind='bootstrap'");
    const host = (bootId: string) => runner('/api/runner/host', { hostId: 'host-1', bootId, cpu: 'cpu', cores: 8, memGB: 32, swapGB: 0, diskFreeGB: 500, os: 'linux', samples: 1 });
    if (stop === 'expiry') expect(await watchRunner(pool, await epoch(), new Date(Date.now() + 61_000))).toBe(1);
    else if (stop === 'restart') {
      const response = await host('boot-restarted');
      expect(response.statusCode, response.body).toBe(200);
      expect((await host('boot-1')).statusCode).toBe(200);
    } else {
      const response = await runner(`/api/runner/jobs/${job.id}/finish`, { fence: job.fence, status: stop, error: { code: 'PROCESS_EXIT', message: '팀장 결정 대기 중 프로세스 종료' } });
      expect(response.statusCode, response.body).toBe(204);
    }
    const after = await state();
    expect(after.bootstrap).toMatchObject({ status: before.bootstrap.status, fail: null, revision: before.bootstrap.revision, steps: before.bootstrap.steps });
    const retryBody = phase === 'tech' ? { revision: null, runNo: 1 } : { revision: before.bootstrap.revision };
    expect(errorOf(await lead('POST', '/api/project/bootstrap/retry', retryBody)).code).toBe('INVALID_TRANSITION');
    // 이전 버전에서 이미 failed로 기록했어도 사람 결정 대기 중 잘못된 재개 작업을 발급하지 않는다.
    await ownerPool.query("update planning_jobs set status='failed' where id=$1", [before.bootstrap.jobId]);
    expect(errorOf(await lead('POST', '/api/project/bootstrap/retry', retryBody)).code).toBe('INVALID_TRANSITION');
    await ownerPool.query('update planning_jobs set status=$2 where id=$1', [before.bootstrap.jobId, before.bootstrap.status]);
    expect(await count("select count(*) n from runner_jobs where kind='bootstrap'")).toBe(jobsBefore);
    expect((await runner(`/api/runner/jobs/${job.id}/release`, { fence: job.fence, hostId: 'host-1', proof: { kind: 'no_process', bootId: 'boot-1' }, at: AT_NOW() })).statusCode).toBe(204);
    if (stop === 'expiry' || stop === 'restart') {
      const reconciled = await runner(`/api/runner/jobs/${job.id}/reconcile`, { fence: job.fence, evidence: { outcome: 'none', checkedAt: AT_NOW(), detail: {} } });
      expect(reconciled.statusCode, reconciled.body).toBe(204);
      expect(await count("select count(*) n from runner_jobs where kind='bootstrap'")).toBe(jobsBefore);
      expect((await state()).bootstrap.fail).toBeNull();
    }
    if (phase === 'tech') {
      const response = await lead('POST', `/api/projects/${before.id}/boot/tech/confirm`, { decisions: [] });
      expect(response.statusCode, response.body).toBe(200);
      expect((await ownerPool.query("select payload from runner_jobs where kind='bootstrap' and state='queued'")).rows[0]?.payload).toMatchObject({ resumeStep: 'draft', runNo: 1 });
    } else {
      const response = await lead('POST', '/api/project/bootstrap/approve', { revision: before.bootstrap.revision });
      expect(response.statusCode, response.body).toBe(200);
      expect((await ownerPool.query('select status from planning_jobs where id=$1', [before.bootstrap.jobId])).rows[0]?.status).toBe('done');
      expect(await count("select count(*) n from runner_jobs where kind='bootstrap'")).toBe(jobsBefore);
    }
  });

  test('재시도는 나중 단계의 fail 표시보다 DB의 마지막 완료 단계 다음을 선택한다', async () => {
    const job = await analyzedBootstrap();
    expect((await runner(`/api/runner/jobs/${job.id}/finish`, { fence: job.fence, status: 'failed' })).statusCode).toBe(204);
    // cross는 끝났고 tech는 아직 wait다. 뒤의 draft fail로 건너뛰지 않는다.
    const response = await lead('POST', '/api/project/bootstrap/retry', { revision: null, runNo: 1 });
    expect(response.statusCode, response.body).toBe(202);
    expect((await ownerPool.query("select payload from runner_jobs where kind='bootstrap' and state='queued'")).rows[0]?.payload.resumeStep).toBe('tech');
  });

  test('fail 표시가 없어도 마지막 완료 단계에서 이어가며 모든 단계가 끝났으면 재개 작업을 만들지 않는다', async () => {
    const { job, s } = await confirmed();
    await ownerPool.query("update planning_jobs set status='failed' where id=$1", [s.bootstrap.jobId]);
    const retried = await lead('POST', '/api/project/bootstrap/retry', { revision: null, runNo: 1 });
    expect(retried.statusCode, retried.body).toBe(202);
    expect((await ownerPool.query("select payload from runner_jobs where kind='bootstrap' and state='queued'")).rows[0]?.payload.resumeStep).toBe('draft');
    await finishClaim(job);
    const current = await claim('bootstrap');
    const submitted = await runner(`/api/planning/bootstrap/${current.id}/draft`, { fence: current.fence, ...draft() });
    expect(submitted.statusCode, submitted.body).toBe(201);
    expect((await lead('POST', '/api/project/bootstrap/approve', { revision: submitted.json<{ revision: number }>().revision })).statusCode).toBe(200);
    await ownerPool.query("update planning_jobs set status='failed' where id=$1", [s.bootstrap.jobId]);
    const countBefore = await count("select count(*) n from runner_jobs where kind='bootstrap'");
    const response = await lead('POST', '/api/project/bootstrap/retry', { revision: null, runNo: 1 });
    expect(errorOf(response).code).toBe('INVALID_TRANSITION');
    expect(await count("select count(*) n from runner_jobs where kind='bootstrap'")).toBe(countBefore);
  });
});

describe('project 리뷰 지적 회귀(M2-03-REVIEW 1~8)', () => {
  /** 초기화 뒤 새 프로젝트를 등록하고 초안 승인 대기까지 진행한다. */
  async function fresh(d = draft(), registrationCommit = SHA1) {
    await resetDb();
    forgetRunnerView();
    const check = await checkedRepo(STRUCTURE, REPO, registrationCommit);
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
    const { s: original } = await fresh();
    expect((await lead('POST', '/api/project/bootstrap/rerun', { revision: original.bootstrap.revision, instruction: '재분석' })).statusCode).toBe(202);
    const current = await lease('bootstrap');
    await progress(current.id, current.fence, 'codex', 'fail', 'first failure');
    const s = await state();
    expect((await lead('POST', '/api/project/bootstrap/retry', { revision: null, runNo: s.bootstrap.runNo })).statusCode).toBe(202);
    const next = await lease('bootstrap');
    const late = await progressOf(current, 'codex', 'fail', 'old retry report');
    expect(errorOf(late).code).toBe('LEASE_LOST');
    expect((await state()).bootstrap).toMatchObject({ status: 'queued', fail: null });
    expect((await progressOf(next, 'codex', 'run')).statusCode).toBe(204);
  });

  test('2. 입력 사슬 끝(head)만 고정하고, 목록 중간 커밋 선택은 400이며 아무것도 소비하지 않는다', async () => {
    const { s } = await fresh();
    expect((await lead('POST', '/api/project/bootstrap/approve', { revision: s.bootstrap.revision })).statusCode).toBe(200);
    // 순서는 서버가 계산하지 않는다. 커밋 시각이 거꾸로여도 git 목록 순서(B → C)를 그대로 쓴다.
    expect((await chainReport([commit(SHA2, '2026-11-26T03:00:00Z')], [file(SHA2, 'prototype/docs/older.md')])).statusCode).toBe(200);
    expect((await chainReport([commit(SHA3, '2026-11-26T02:00:00Z')], [file(SHA3, 'prototype/docs/newer.md')])).statusCode).toBe(200);
    const before = await state();
    expect(before.changeCommits.map((c) => c.sha)).toEqual([SHA2, SHA3]);
    expect(before.inputHead).toBe(SHA3);
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

  test('6. prototype/ 밖 경로가 있는 차이는 계산이 잘못된 보고라 400이고, prototype/ 차이만 받는다', async () => {
    await fresh();
    // 차이는 `git diff ... -- prototype/`로 계산하므로 src/ 경로가 나올 수 없다.
    const bad = await chainReport([commit(SHA2, AT_NOW())], [file(SHA2, 'src/agent.ts'), file(SHA2, 'prototype/extra.md')]);
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).errors).toEqual([expect.objectContaining({ rule: 'prototype' })]);
    expect((await state()).changeCommits).toEqual([]);
    const ok = await chainReport([commit(SHA4, AT_NOW())], [file(SHA4, 'prototype/extra.md')]);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await state()).changeCommits.map((c) => [c.sha, c.files.map((f) => f.path)])).toEqual([[SHA4, ['prototype/extra.md']]]);
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

  test('D1·R1·F1. 늦게·중복으로 도착한 옛 보고는 base가 낡아 409이고 원장을 바꾸지 않으며, 버전은 앞으로만 간다', async () => {
    const { s } = await fresh();
    expect((await lead('POST', '/api/project/bootstrap/approve', { revision: s.bootstrap.revision })).statusCode).toBe(200);
    // Runner의 첫 보고: base = 등록 커밋(SHA1). 등록 이전 이력이나 등록 커밋의 깊이는 몰라도 된다(D1).
    const first = await chainReport([commit(SHA2, AT_NOW()), commit(SHA3, AT_NOW())], [file(SHA2, 'prototype/docs/b.md'), file(SHA3, 'prototype/docs/c.md')], { base: SHA1 });
    expect(first.json()).toEqual({ head: SHA3, recorded: true, historyRewritten: false });
    const before = await state();
    expect((await lead('POST', '/api/project/inputs', { updatedAt: before.updatedAt, commit: SHA3, commits: [SHA3] })).statusCode).toBe(202);
    // 같은 첫 보고(옛 base)가 늦게 다시 도착하거나, [B]만 담은 지연 보고가 와도 붙이지 않는다.
    for (const late of [
      await chainReport([commit(SHA2, AT_NOW()), commit(SHA3, AT_NOW())], [file(SHA2, 'prototype/docs/b.md'), file(SHA3, 'prototype/docs/c.md')], { base: SHA1 }),
      await chainReport([commit(SHA2, AT_NOW())], [file(SHA2, 'prototype/docs/b.md')], { base: SHA1, head: SHA2 }),
    ]) {
      expect(late.statusCode).toBe(409);
      expect(errorOf(late)).toMatchObject({ code: 'VERSION_CONFLICT', details: { current: { base: SHA3 } } });
    }
    const after = await state();
    expect(after.changeCommits.map((c) => `${c.sha.slice(0, 1)}:${c.state}`)).toEqual(['c:analyzed']);
    expect(after.inputs.map((i) => i.commit)).toEqual([SHA1, SHA3]);
    // 이미 v2에 들어간 B로는 버전을 되돌릴 수 없다.
    const back = await lead('POST', '/api/project/inputs', { updatedAt: after.updatedAt, commit: SHA2, commits: [SHA2] });
    expect(back.statusCode).toBe(409);
    expect((await state()).inputs.map((i) => i.commit)).toEqual([SHA1, SHA3]);
  });

  test('N1. feature에 main을 -s ours로 합친 뒤 fast-forward해 커밋 목록이 비어도, 트리 차이의 삭제를 입력 변경으로 받는다', async () => {
    const { s } = await fresh();
    expect((await lead('POST', '/api/project/bootstrap/approve', { revision: s.bootstrap.revision })).statusCode).toBe(200);
    const doc = 'prototype/docs/deleted-by-merge.md';
    // rev-list --first-parent 결과는 비어 있지만 git diff --raw는 삭제를 보여 준다.
    const result = await chainReport([], [], { head: SHA4, changes: [{ status: 'D', path: doc, oldBlob: fakeSha('d'), newBlob: null, oldMode: '100644', newMode: null, added: 0, deleted: 5 }], treeHash: fakeSha('tree-after-delete') });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({ head: SHA4, recorded: true, historyRewritten: false });
    const before = await state();
    expect(before.changeCommits).toEqual([expect.objectContaining({ sha: SHA4, state: 'pending', files: [expect.objectContaining({ path: doc, change: 'deleted' })] })]);
    const analyzed = await lead('POST', '/api/project/inputs', { updatedAt: before.updatedAt, commit: SHA4, commits: [SHA4] });
    expect(analyzed.statusCode, analyzed.body).toBe(202);
    expect((await state()).inputs.at(-1)).toMatchObject({ commit: SHA4, changes: [{ path: doc, change: 'deleted' }] });
  });

  test('N2. 빈 차이 보고도 head를 옮겨 저장하고, 쌓인 변경을 그 최신 head로 고정한다', async () => {
    const { s } = await fresh();
    expect((await lead('POST', '/api/project/bootstrap/approve', { revision: s.bootstrap.revision })).statusCode).toBe(200);
    expect((await chainReport([commit(SHA2, AT_NOW())], [file(SHA2, 'prototype/docs/b.md')])).statusCode).toBe(200);
    const tip = 'e'.repeat(40);
    // src만 바뀐 C: prototype/ 차이는 비고 트리 해시도 같다.
    const empty = await chainReport([], [], { head: tip });
    expect(empty.json()).toEqual({ head: tip, recorded: false, historyRewritten: false });
    const before = await state();
    expect(before.inputHead).toBe(tip);
    expect(before.changeCommits.map((c) => c.sha)).toEqual([SHA2]);
    expect(errorOf(await lead('POST', '/api/project/inputs', { updatedAt: before.updatedAt, commit: SHA2, commits: [SHA2] })).errors).toEqual([expect.objectContaining({ rule: 'latest' })]);
    expect((await lead('POST', '/api/project/inputs', { updatedAt: before.updatedAt, commit: tip, commits: [SHA2] })).statusCode).toBe(202);
    expect((await state()).inputs.map((i) => i.commit)).toEqual([SHA1, tip]);
    // 다음 빈 보고는 새 head에서 이어진다.
    expect((await chainReport([], [], { head: 'f'.repeat(40) })).json()).toMatchObject({ head: 'f'.repeat(40), recorded: false });
  });

  test('이력 재작성(base가 main의 조상이 아님)은 붙이지 않고 팀장 경고를 남긴다', async () => {
    await fresh();
    const result = await chainReport([commit(SHA2, AT_NOW())], [file(SHA2, 'prototype/docs/b.md')], { baseIsAncestor: false });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({ head: SHA1, recorded: false, historyRewritten: true });
    expect((await state()).changeCommits).toEqual([]);
    expect(await count("select count(*) n from alerts where key='input_history_rewritten' and resolved_at is null")).toBe(1);
    // 같은 경고는 열린 동안 하나만 남는다.
    await chainReport([commit(SHA2, AT_NOW())], [file(SHA2, 'prototype/docs/b.md')], { baseIsAncestor: false });
    expect(await count("select count(*) n from alerts where key='input_history_rewritten' and resolved_at is null")).toBe(1);
  });

  test('D3. 모순된 관측(경로 중복·빈 차이인데 트리 변경·지난 보고와 다른 이전 blob)은 400이고 아무것도 바꾸지 않는다', async () => {
    await fresh();
    const doc = 'prototype/docs/b.md';
    const twice = await chainReport([], [], { head: SHA2, changes: [{ status: 'A', path: doc, oldBlob: null, newBlob: fakeSha('1'), oldMode: null, newMode: '100644', added: 1, deleted: 0 }, { status: 'M', path: doc, oldBlob: fakeSha('0'), newBlob: fakeSha('1'), oldMode: '100644', newMode: '100644', added: 1, deleted: 1 }] });
    expect(errorOf(twice).errors).toEqual([expect.objectContaining({ rule: 'unique' })]);
    expect((await chainReport([commit(SHA2, AT_NOW())], [file(SHA2, doc)])).statusCode).toBe(200);
    const tree = await chainReport([], [], { head: SHA3, treeHash: fakeSha('other-tree') });
    expect(errorOf(tree).errors).toEqual([expect.objectContaining({ rule: 'tree' })]);
    const blob = await chainReport([], [], { head: SHA3, changes: [{ status: 'M', path: doc, oldBlob: fakeSha('not-the-last'), newBlob: fakeSha('2'), oldMode: '100644', newMode: '100644', added: 1, deleted: 1 }] });
    expect(errorOf(blob).errors).toEqual([expect.objectContaining({ rule: 'blob' })]);
    const s = await state();
    expect([s.inputHead, s.changeCommits.map((c) => c.sha)]).toEqual([SHA2, [SHA2]]);
  });

  test('R2. M2-05 reconcile이 만든 새 job은 현재 실행이라 초안을 받는다(실제 claim·만료·release·reconcile 경로)', async () => {
    await resetDb();
    const check = await checkedRepo();
    expect((await lead('POST', '/api/project', registration(check, { constraints: [] }))).statusCode).toBe(201);
    const first = await lease('bootstrap');
    for (const key of ['check', 'unzip', 'repo', 'codex', 'claude', 'cross']) await progress(first.id, first.fence, key);
    expect((await runner(`/api/planning/bootstrap/${first.id}/tech`, { fence: first.fence, decisions: [] })).statusCode).toBe(201);
    await finishJob(first.id);
    const s = await state();
    expect((await lead('POST', `/api/projects/${s.id}/boot/tech/confirm`, { decisions: [] })).statusCode).toBe(200);
    const claim = async () => {
      const claimed = await runner('/api/runner/jobs/claim', { kinds: ['bootstrap'], capacity: 10 });
      expect(claimed.statusCode, claimed.body).toBe(200);
      return claimed.json<{ job: { id: string; fence: number } }>().job;
    };
    const current = await claim();
    expect(await watchRunner(pool, await epoch(), new Date(Date.now() + 61_000))).toBe(1);
    expect((await runner(`/api/runner/jobs/${current.id}/release`, { fence: current.fence, hostId: 'host-1', proof: { kind: 'no_process', bootId: 'boot-1' }, at: AT_NOW() })).statusCode).toBe(204);
    expect((await runner(`/api/runner/jobs/${current.id}/reconcile`, { fence: current.fence, evidence: { outcome: 'none', checkedAt: AT_NOW(), detail: { checked: true } } })).statusCode).toBe(204);
    const next = await claim();
    expect(next.id).not.toBe(current.id);
    const result = await runner(`/api/planning/bootstrap/${next.id}/draft`, { fence: next.fence, ...draft() });
    expect(result.statusCode, result.body).toBe(201);
    // 대체된 옛 job은 더 이상 현재 실행이 아니다.
    expect(errorOf(await progressOf(current, 'draft', 'fail')).code).not.toBe(undefined);
  });

  test('N3. 실제 git: 실행 권한만 바뀐 M(blob 같음)을 받아 head를 옮기고, 이어지는 문서·심볼릭 링크·빈 파일·종류 변경을 분석한다', async () => {
    const repo = new GitRepo();
    try {
      repo.sh('mkdir -p prototype/docs prototype/uiux && echo guide > prototype/docs/guide.md && echo "run()" > prototype/uiux/mode.js && echo "<p>" > prototype/uiux/index.html && chmod 644 prototype/uiux/mode.js');
      const a = repo.commit('A: 등록 커밋');
      const { s } = await fresh(draft(), a);
      expect((await lead('POST', '/api/project/bootstrap/approve', { revision: s.bootstrap.revision })).statusCode).toBe(200);

      // B: 실행 권한만 바꿈(100644 → 100755). git은 같은 blob의 M을 낸다.
      repo.sh('chmod 755 prototype/uiux/mode.js');
      const b = repo.commit('B: chmod +x');
      const modeOnly = repo.observe(a, b);
      expect(modeOnly.changes).toEqual([expect.objectContaining({ status: 'M', path: 'prototype/uiux/mode.js', oldMode: '100644', newMode: '100755' })]);
      expect(modeOnly.changes[0]?.oldBlob).toBe(modeOnly.changes[0]?.newBlob);
      const first = await runner('/api/runner/input-changes', modeOnly);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({ head: b, recorded: false, historyRewritten: false });
      const afterMode = await state();
      expect([afterMode.inputHead, afterMode.changeCommits]).toEqual([b, []]);
      expect(errorOf(await lead('POST', '/api/project/inputs', { updatedAt: afterMode.updatedAt, commit: b, commits: [b] })).code).not.toBe(undefined);

      // C: 새 문서, 빈 파일, 심볼릭 링크, index.html을 링크로 바꿈(T).
      repo.sh('echo next > prototype/docs/next.md && : > prototype/docs/empty.md && ln -s ../docs/guide.md prototype/uiux/guide-link && rm prototype/uiux/index.html && ln -s ../docs/next.md prototype/uiux/index.html');
      const c = repo.commit('C: 문서·빈 파일·링크·종류 변경');
      const next = repo.observe(b, c);
      expect(next.changes.map((x) => `${x.status}:${x.path}`).sort()).toEqual(
        ['A:prototype/docs/empty.md', 'A:prototype/docs/next.md', 'A:prototype/uiux/guide-link', 'T:prototype/uiux/index.html']);
      const second = await runner('/api/runner/input-changes', next);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual({ head: c, recorded: true, historyRewritten: false });
      const before = await state();
      expect(before.changeCommits.map((x) => x.sha)).toEqual([c]);
      const analyzed = await lead('POST', '/api/project/inputs', { updatedAt: before.updatedAt, commit: c, commits: [c] });
      expect(analyzed.statusCode, analyzed.body).toBe(202);
      // 실행 권한 변경(mode.js)은 내용 변경이 아니라 순 변경에 없다.
      expect((await state()).inputs.at(-1)).toMatchObject({ commit: c, changes: [
        { path: 'prototype/docs/empty.md', change: 'added' }, { path: 'prototype/docs/next.md', change: 'added' },
        { path: 'prototype/uiux/guide-link', change: 'added' }, { path: 'prototype/uiux/index.html', change: 'modified' }] });
    } finally { repo.dispose(); }
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


test('기준 일정 v1도 owner 기본 가동률과 관측 창의 하위 Agent 비율을 쓴다', async () => {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('update schedule_policy set assume_rate=null,window_days=7');
    await client.query('delete from runner_concurrency_log');
    await client.query(`insert into runner_concurrency_log(host_id,"limit",running,subagents,heavy,resources,created_at)
      values('host-1',2,2,'1',0,'{}',clock_timestamp()),('host-1',2,2,'{"observed":3}',0,'{}',clock_timestamp()),
      ('host-1',2,1,'100',0,'{}',clock_timestamp()-interval '8 days')`);
    const input = await baselineInput(client, [], []);
    expect(input.assumeRate).toBe(0.6);
    expect(input.concurrency.subRatio).toBe(1);
    await client.query('update schedule_policy set assume_rate=0.8');
    expect((await baselineInput(client, [], [])).assumeRate).toBe(0.8);
  } finally { await client.query('rollback'); client.release(); }
});
