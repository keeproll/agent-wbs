import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import { installProjectRunner } from '../src/project/runner-routes.ts';
import { installRunner } from '../src/runner/routes.ts';
// Runner 쪽 실제 코드(M5-04). 시험 안에서만 가져온다: 실제 서버 경로·DB와 Runner의 Planning orchestration을 끝까지 붙여 본다.
import { createApiClient } from '../../../../agent-runner/src/api/client.ts';
import type { ClaimedJob } from '../../../../agent-runner/src/api/generated/client.ts';
import { PlanningCheckpoints, runPlanningJob, type PlanningJob } from '../../../../agent-runner/src/planning/index.ts';
import { Secret } from '../../../../agent-runner/src/security/secret.ts';
import { FakeAgent, fakeWorkspace, tempHome } from '../../../../agent-runner/test/planning/harness.ts';
import { boundRef, judgedContentHash, refFingerprint } from '../../../../agent-runner/src/planning/binding.ts';
import { wbsSnapshot } from '../src/planning/job-snapshot.ts';

/*
 * M5-04 fix4: 서버 후속 4 계약 위에서 Runner Planning orchestration이 실제 서버와 끝까지 가는지 본다.
 * - 초기 분석: 등록(조건부 제약 포함) → claim → 단계 보고 → 기술 결정 제안 → 팀장 확정(반려 1건) → 초안 job → 초안 등록 → 팀장 승인
 * - 차이 분석 두 번 연속: 입력 변경 → 분석 시작 → claim → 단계 보고 → 기존 Task 수정 CP(taskJudgements) → cp:done → 다음 분석
 * Claude·Codex는 손으로 쓴 가짜 Agent다. 서버 쪽 규칙(계약·hash·스냅샷 대조)은 모두 실제 코드다.
 */
const origin = 'http://127.0.0.1:3100';
const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_planning_runner';
const ownerPool = createPool(dbUrl.href, { max: 4, onError: () => undefined });
const appUrl = new URL(dbUrl);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { max: 12, onError: () => undefined });
const app = buildApp(pool, false, { origin, lan: false });
installProjectRunner(app, pool);
installRunner(app, pool);

const REPO = 'https://github.com/acme/web';
const SHA1 = 'a'.repeat(40);
const fakeSha = (text: string) => createHash('sha1').update(text).digest('hex');
let cookie = '';
let csrf = '';
let bearer = '';
let home = '';
let cleanupHome: () => Promise<void> = () => Promise.resolve();

function lead(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { cookie, origin, 'x-csrf-token': csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
}
async function epoch() { return (await ownerPool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch ?? 0; }

/** Runner의 실제 API 클라이언트가 HTTP 대신 app.inject로 서버 경로를 부르게 하는 fetch */
const injectFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const response = await app.inject({ method: (init?.method ?? 'GET') as 'GET', url: url.pathname + url.search, headers, ...(typeof init?.body === 'string' && { payload: init.body }) });
  const status = response.statusCode;
  const out = new Headers();
  for (const [k, v] of Object.entries(response.headers)) if (v !== undefined) out.set(k, String(v));
  return new Response(status === 204 ? null : response.body, { status, headers: out });
};
const api = () => createApiClient({ baseUrl: 'http://wbs.test', token: new Secret(bearer), fetch: injectFetch });

async function claim(kind: ClaimedJob['kind']): Promise<PlanningJob> {
  const response = await api()('claimJob', { epoch: await epoch(), idempotencyKey: `claimJob:runner-1:${crypto.randomUUID()}`, body: { kinds: [kind], capacity: 1 } });
  expect(response.status).toBe(200);
  return (response.body as { job: PlanningJob }).job;
}
async function finish(job: PlanningJob, outcome: Awaited<ReturnType<typeof runPlanningJob>>) {
  if (outcome.status === 'lost') return;
  const body = outcome.status === 'done' ? { fence: job.fence, status: 'done' as const, result: outcome.result } : { fence: job.fence, status: 'failed' as const, error: outcome.error };
  const response = await api()('finishJob', { epoch: await epoch(), idempotencyKey: `finishJob:runner-1:${crypto.randomUUID()}`, params: { id: job.id }, body });
  expect(response.status).toBe(204);
  // job 계층(M5-05)이 할 일: Planning은 프로세스를 띄우지 않았으므로 no_process 증거로 보유를 푼다(contracts §3.4-2).
  const released = await api()('releaseJob', { epoch: await epoch(), idempotencyKey: `releaseJob:runner-1:${crypto.randomUUID()}`, params: { id: job.id },
    body: { fence: job.fence, hostId: 'host-1', proof: { kind: 'no_process', bootId: 'boot-1' }, at: new Date().toISOString() } });
  expect(released.status).toBe(204);
}

/** 이 시험의 가짜 Agent: 조건부 제약에는 서버가 발급한 id로 판단하고, 차이 분석은 스냅샷의 기존 Task를 고친다. */
function agents() {
  const claude = new FakeAgent('Claude');
  const codex = new FakeAgent('Codex');
  const cross = claude.crossReview.bind(claude);
  claude.crossReview = async (request) => {
    const base = await cross(request);
    const conds = (request.techConstraints ?? []).filter((c) => c.level === 'cond');
    return { ...base, tech: { decisions: [{ area: '데이터', title: '캐시', choice: 'Redis 7', reason: '세션 캐시', alternatives: '없음' }],
      conditionJudgements: conds.map((c) => ({ constraintId: c.id, result: 'not_met' as const, reason: `${c.condition ?? ''} — 시계열 데이터 없음` })) } };
  };
  claude.proposeChanges = async (request) => {
    claude.calls.push({ method: 'proposeChanges', request: structuredClone(request) });
    const [existing] = request.wbs.tasks;
    const wp = request.wbs.phases[0]?.wps[0]?.id ?? '';
    if (!existing) throw new Error('스냅샷에 Task가 없습니다.');
    return { title: '입력 변경 반영', reason: '문서 수정', ops: [
      { op: 'modify', task: existing.taskKey, field: 'doneCond', after: `완료 조건 갱신 ${request.jobId.slice(0, 8)}` },
      { op: 'add', ref: 'NEW-1', preds: [], t: { title: `새 화면 ${request.jobId.slice(0, 8)}`, type: 'Implementation', domain: 'FE', wp, priority: 1,
        assignee: 'Claude', verifier: 'Codex', purpose: '목적', doneCond: '테스트 통과', ac: [{ given: 'g', when: 'w', then: 't' }] } },
    ] };
  };
  return { Claude: claude, Codex: codex };
}
async function context() {
  const ws = fakeWorkspace();
  const pair = agents();
  return { ws, agents: pair, ctx: { api: api(), epoch: await epoch(), runnerId: 'runner-1', checkpoints: await PlanningCheckpoints.open(home), workspace: ws.workspace,
    agents: pair, sleep: () => Promise.resolve() } };
}
async function project() {
  const response = await lead('GET', '/api/project');
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ id: string; updatedAt: string; inputHead: string; state: string; constraints: { id: string; level: string }[];
    bootstrap: { revision: number | null; steps: { key: string; status: string }[]; decisions: { id: string; tdKey: string; status: string; updatedAt: string; title: string }[] } }>();
}
async function planningStatus(kind: string) {
  return (await ownerPool.query<{ status: string }>('select status from planning_jobs where kind=$1 order by created_at', [kind])).rows.map((r) => r.status);
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
  await ownerPool.query("insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at) values('host-1','boot-1','cpu',8,32,0,500,'linux',1,now())");
  await ownerPool.query('update schedule_policy set assume_rate=0.5');
  await ownerPool.query("insert into external_write_authority(singleton,host_id,generation,state) values(true,'host-1',1,'granted')");
  ({ home, cleanup: cleanupHome } = await tempHome());
}, 60_000);
afterAll(async () => { await cleanupHome(); await app.close(); await pool.end(); await ownerPool.end(); });

describe('실제 서버 + Runner Planning orchestration', () => {
  test('초기 분석: 등록 → 분석 → 기술 결정 제안 → 팀장 확정(반려 포함) → 초안 → 승인', async () => {
    const check = await lead('POST', '/api/project/repo-checks', { url: REPO });
    expect(check.statusCode, check.body).toBe(202);
    const repoCheck = await claim('repo_check');
    const reported = await api()('reportRepoCheck', { epoch: await epoch(), idempotencyKey: `reportRepoCheck:runner-1:${crypto.randomUUID()}`, params: { id: check.json<{ id: string }>().id },
      body: { fence: repoCheck.fence, access: true, private: true, commit: SHA1, structure: { uiux: true, uiuxFiles: 3, docs: ['prototype/docs/guide.md'], src: false, contracts: false, agentwbs: false } } });
    expect(reported.status).toBe(204);
    const created = await lead('POST', '/api/project', { name: '웹 제품', url: REPO, targetDate: '2027-02-27', instruction: '계약 먼저', repoCheckId: check.json<{ id: string }>().id,
      constraints: [{ name: 'PostgreSQL 16', level: 'must' }, { name: 'QuestDB', level: 'cond', condition: '시계열 데이터가 있으면' }] });
    expect(created.statusCode, created.body).toBe(201);

    // 1회차: 분석 → 교차 검토 → 기술 결정 제안(조건부 제약은 서버 발급 id로 판단)
    const first = await claim('bootstrap');
    const one = await context();
    const outcome1 = await runPlanningJob(first, one.ctx);
    expect(outcome1).toEqual({ status: 'done', result: { waiting: 'tech' } });
    await finish(first, outcome1);
    const cond = (await project()).constraints.find((c) => c.level === 'cond');
    const sent = (one.agents.Codex.calls.find((c) => c.method === 'analyze')?.request as { techConstraints: { id: string; level: string }[] }).techConstraints;
    expect(sent).toContainEqual(expect.objectContaining({ id: cond?.id, level: 'cond', condition: '시계열 데이터가 있으면' }));
    let s = await project();
    expect(s.bootstrap.steps.filter((x) => ['check', 'unzip', 'repo', 'codex', 'claude', 'cross'].includes(x.key)).every((x) => x.status === 'done')).toBe(true);
    expect(s.bootstrap.steps.find((x) => x.key === 'tech')?.status).toBe('run');

    // 팀장: Redis 제안은 반려, 나머지 승인
    const pending = s.bootstrap.decisions.filter((d) => d.status === 'pending');
    const confirm = await lead('POST', `/api/projects/${s.id}/boot/tech/confirm`, {
      decisions: pending.map((d) => ({ id: d.id, choice: d.title === '캐시' ? 'reject' : 'approve', updatedAt: d.updatedAt })) });
    expect(confirm.statusCode, confirm.body).toBe(200);

    // 2회차(resumeStep=draft): 확정 결정 스냅샷을 받아 초안 작성 → 서버가 결정 버전 대조 후 저장
    const second = await claim('bootstrap');
    expect(second.kind === 'bootstrap' && second.payload.resumeStep).toBe('draft');
    const two = await context();
    const outcome2 = await runPlanningJob(second, two.ctx);
    expect(outcome2).toMatchObject({ status: 'done', result: { revision: 1, disagreements: [] } });
    await finish(second, outcome2);
    const draftRequest = two.agents.Claude.calls.find((c) => c.method === 'draft')?.request as { decisions: { rejected: string[]; decisions: { title: string; status: string; tdKey: string }[] } };
    const redis = draftRequest.decisions.decisions.find((d) => d.title === '캐시');
    expect(redis?.status).toBe('rejected');
    expect(draftRequest.decisions.rejected).toEqual([redis?.tdKey]);

    s = await project();
    expect(s.bootstrap.revision).toBe(1);
    // 5차 리뷰 P1: 초안 Task마다 서버가 저장한 subjectHash(draftSource) = Runner가 판단에 묶은 입력 지문
    const stored = (await ownerPool.query<{ content: { tasks: { subjectHash: string; judgedRules: { items: { sourceRef: string }[] } }[] } }>(
      "select content from wbs_drafts where status='pending' order by revision desc limit 1")).rows[0]?.content.tasks ?? [];
    expect(stored.length).toBeGreaterThan(0);
    for (const t of stored) expect(t.judgedRules.items.every((i) => refFingerprint(i.sourceRef) === t.subjectHash)).toBe(true);
    const approve = await lead('POST', '/api/project/bootstrap/approve', { revision: 1 });
    expect(approve.statusCode, approve.body).toBe(200);
    expect((await project()).state).toBe('active');
    expect(await planningStatus('bootstrap')).toEqual(['done']);
  });

  test('차이 분석 두 번 연속: 스냅샷의 기존 Task 수정 CP(taskJudgements) → cp:done → 다음 분석 시작', async () => {
    const blobs = new Map<string, string>();
    for (const [round, sha] of [[1, 'c'.repeat(40)], [2, 'd'.repeat(40)]] as const) {
      // Runner의 입력 변경 보고(서버 원장 기준 base→head)
      const s = await project();
      const path = 'prototype/docs/guide.md';
      const oldBlob = blobs.get(path) ?? fakeSha(`${path}@init`);
      const newBlob = fakeSha(`${path}@${sha}`);
      const changed = await api()('reportInputChanges', { epoch: await epoch(), idempotencyKey: `reportInputChanges:runner-1:${crypto.randomUUID()}`, body: {
        base: s.inputHead, head: sha, baseIsAncestor: true, treeHash: fakeSha(`tree@${sha}`),
        changes: [{ status: 'M', path, oldBlob, newBlob, oldMode: '100644', newMode: '100644', added: 3, deleted: 1 }],
        commits: [{ sha, at: `2026-11-2${String(6 + round)}T00:00:00Z`, author: '팀장', message: `입력 수정 ${String(round)}` }] } });
      expect(changed.status).toBe(200);
      blobs.set(path, newBlob);
      const after = await project();
      const started = await lead('POST', '/api/project/inputs', { updatedAt: after.updatedAt, commit: sha, commits: [sha] });
      expect(started.statusCode, `${String(round)}회 분석 시작: ${started.body}`).toBe(202);

      const job = await claim('input_diff');
      const run = await context();
      const outcome = await runPlanningJob(job, run.ctx);
      expect(outcome, `${String(round)}회 차이 분석`).toMatchObject({ status: 'done', result: { cpKey: expect.stringMatching(/^CP-/) } });
      await finish(job, outcome);
      // 기존 Task 판단은 두 Agent 합의로 보냈고, 서버가 변경 후 hash를 붙여 저장했다.
      const cp = (await ownerPool.query<{ task_judgements: { taskKey: string; judgedRules: { items: { agreedBy: string[]; subjectHash: string }[] } }[]; source: string }>(
        "select task_judgements,source from change_proposals where id=$1", [(outcome as unknown as { result: { proposalId: string } }).result.proposalId])).rows[0];
      expect(cp?.source).toBe('input');
      expect(cp?.task_judgements).toHaveLength(1);
      expect(cp?.task_judgements[0]?.judgedRules.items.every((i) => i.agreedBy.join() === 'Claude,Codex' && /^[0-9a-f]{64}$/.test(i.subjectHash))).toBe(true);
      // 5차 리뷰 P1: 서버가 변경 후 내용으로 붙인 hash = Runner가 판단에 묶은 입력 지문(기존 Task 수정·새 Task 모두)
      const stamped = (await ownerPool.query<{ task_judgements: { judgedRules: { items: { subjectHash: string; sourceRef: string }[] } }[]; ops: { op: string; t?: { judgedRules?: { items: { subjectHash: string; sourceRef: string }[] } } }[] }>(
        'select task_judgements,ops from change_proposals where id=$1', [(outcome as unknown as { result: { proposalId: string } }).result.proposalId])).rows[0];
      const items = [...(stamped?.task_judgements.flatMap((j) => j.judgedRules.items) ?? []), ...(stamped?.ops.flatMap((o) => o.t?.judgedRules?.items ?? []) ?? [])];
      expect(items.length).toBeGreaterThan(3);
      for (const i of items) expect(refFingerprint(i.sourceRef), '지문과 서버 hash').toBe(i.subjectHash);
      expect(await planningStatus('input_diff'), `${String(round)}회 뒤 차이 분석 상태`).toEqual(Array(round).fill('done'));
    }
  });

  /** 기존 Task 재판단 job(계약 5: planning:null, proposal:null, tasks ≥ 1)을 서버 스냅샷으로 만든다. */
  async function rejudgeJob(dedup: string) {
    const s = await project();
    const task = (await wbsSnapshot(ownerPool, s.id)).tasks[0];
    if (!task) throw new Error('Task 없음');
    const payload = { tasks: [{ taskKey: task.taskKey, subjectHash: task.subjectHash, content: task.content }], policy: { judgedRules: ['revert'] }, planning: null, proposal: null };
    await ownerPool.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'planning',$2::jsonb,'queued',$3,$4)", [s.id, JSON.stringify(payload), await epoch(), dedup]);
    return { project: s, task, job: await claim('planning') };
  }

  test('4차 리뷰 P1(실제 DB): 새 충돌 묶음을 고르면 그 묶음을 본 판단이 저장되고, 판단의 입력 지문이 저장된 hash와 같다', async () => {
    const { project: s, task, job } = await rejudgeJob('fix5-task-plan');
    expect(task.content.conflictGroup).toBeNull();
    const run = await context();
    const plan = run.agents.Claude.planTask.bind(run.agents.Claude);
    run.agents.Claude.planTask = async (request) => ({ ...await plan(request), conflictGroup: { name: 'shared-db', reason: '공통 파일' } });
    for (const agent of Object.values(run.agents)) {
      const judge = agent.judgeRules.bind(agent);
      agent.judgeRules = async (request) => (await judge(request)).map((v) => ({ ...v,
        result: (request.subjects[0]?.content as { conflictGroup: string | null }).conflictGroup === 'shared-db' ? 'not_met' as const : 'met' as const }));
    }
    const outcome = await runPlanningJob(job, run.ctx);
    expect(outcome).toMatchObject({ status: 'done' });
    await finish(job, outcome);
    const updated = (await wbsSnapshot(ownerPool, s.id)).tasks.find((t) => t.taskKey === task.taskKey);
    const recorded = (await ownerPool.query<{ judged_rules: { items: { result: string; subjectHash: string; sourceRef: string }[] } }>(
      'select s.judged_rules from task_splits s join tasks t on t.id=s.task where t.task_key=$1', [task.taskKey])).rows[0]?.judged_rules.items[0];
    const shown = (run.agents.Codex.calls.find((c) => c.method === 'judgeRules')?.request as { subjects: { content: { conflictGroup: string | null } }[] }).subjects[0]?.content.conflictGroup;
    expect(shown).toBe('shared-db');
    expect(updated?.content.conflictGroup).toBe('shared-db');
    expect(recorded?.result).toBe('not_met');
    expect(recorded?.subjectHash).toBe(updated?.subjectHash);
    // 판단 기록에 묶은 「보여 준 입력」의 지문 = 서버가 저장한 새 내용의 hash(같은 계산식)
    expect(refFingerprint(recorded?.sourceRef)).toBe(updated?.subjectHash);
  });

  test('서버 확인(srv4 fix3): 옛 내용에 묶인 판단을 새 묶음과 함께 보내면 409 VERSION_CONFLICT이고 아무것도 저장하지 않는다', async () => {
    const { project: s, task, job } = await rejudgeJob('fix6-server-probe');
    const before = (await wbsSnapshot(ownerPool, s.id)).tasks.find((t) => t.taskKey === task.taskKey);
    // 옛 내용(지금 묶음)을 본 판단이라고 적고, 다른 새 묶음을 함께 보낸다. Runner는 이런 본문을 보내지 않는다(bind).
    const oldFingerprint = judgedContentHash(task.content);
    const item = { rule: 'revert', result: 'met', agreedBy: ['Claude', 'Codex'], basis: '옛 내용 판단', judgedAt: new Date().toISOString(),
      sourceRef: boundRef(oldFingerprint), subjectHash: task.subjectHash };
    const error = await api()('submitTaskPlan', { epoch: await epoch(), idempotencyKey: `submitTaskPlan:runner-1:${crypto.randomUUID()}`, params: { taskKey: task.taskKey },
      body: { jobId: job.id, fence: job.fence, grades: { dev: { modelId: 'm', effort: 'high', reason: 'r' }, qa: { modelId: 'm', effort: 'high', reason: 'r' } },
        subagents: { dev: [], qa: [], basis: '' }, conflictGroup: { name: 'probe-group', reason: '시험' }, judgedRules: { schemaVersion: 1, items: [item] } as never } })
      .then(() => null, (e: unknown) => e as { status: number; error?: { code: string; details?: { subjectHash?: string } } });
    await finish(job, { status: 'failed', error: { code: 'VERSION_CONFLICT', message: '시험' } });
    expect(error?.status).toBe(409);
    expect(error?.error?.code).toBe('VERSION_CONFLICT');
    // 서버가 알려 준 현재 대상 hash = 새 묶음을 반영한 내용의 지문(Runner 계산과 같다)
    expect(error?.error?.details?.subjectHash).toBe(judgedContentHash({ ...task.content, conflictGroup: 'probe-group' }));
    const after = (await wbsSnapshot(ownerPool, s.id)).tasks.find((t) => t.taskKey === task.taskKey);
    expect(after?.content.conflictGroup).toBe(before?.content.conflictGroup ?? null);
  });

  test('409 뒤 다시 판단(실제 DB): 판단하는 동안 Task가 바뀌면 VERSION_CONFLICT로 멈추고, 새 job은 새 내용을 보고 다시 판단해 저장된다', async () => {
    const { project: s, task, job } = await rejudgeJob('fix6-stale-1');
    const judgedRow = async () => JSON.stringify((await ownerPool.query('select sp.judged_rules,t.conflict_group from tasks t left join task_splits sp on sp.task=t.id where t.task_key=$1', [task.taskKey])).rows);
    const beforeRow = await judgedRow();
    const run = await context();
    // 판단 도중 팀장이 Task 제목을 바꾼 상황: 첫 판단이 끝난 뒤 DB의 내용을 바꾼다.
    const judge = run.agents.Codex.judgeRules.bind(run.agents.Codex);
    run.agents.Codex.judgeRules = async (request) => {
      await ownerPool.query('update tasks set title=$2 where task_key=$1', [task.taskKey, `${task.content.title} (수정)`]);
      return judge(request);
    };
    const outcome = await runPlanningJob(job, run.ctx);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'VERSION_CONFLICT' } });
    await finish(job, outcome);
    // 거부된 보고는 판단 기록·충돌 묶음을 하나도 바꾸지 않았다.
    expect(await judgedRow()).toBe(beforeRow);
    // 새 job(서버가 다시 만든 것처럼 지금 스냅샷)으로 다시 판단하면 새 제목을 보고 판단하고 저장된다.
    const retry = await rejudgeJob('fix6-stale-2');
    expect(retry.task.content.title).toBe(`${task.content.title} (수정)`);
    const again = await context();
    const outcome2 = await runPlanningJob(retry.job, again.ctx);
    expect(outcome2).toMatchObject({ status: 'done' });
    await finish(retry.job, outcome2);
    const shown = (again.agents.Codex.calls.find((c) => c.method === 'judgeRules')?.request as { subjects: { content: { title: string } }[] }).subjects[0]?.content.title;
    expect(shown).toBe(`${task.content.title} (수정)`);
    const updated = (await wbsSnapshot(ownerPool, s.id)).tasks.find((t) => t.taskKey === task.taskKey);
    const recorded = (await ownerPool.query<{ judged_rules: { items: { subjectHash: string; sourceRef: string }[] } }>(
      'select s.judged_rules from task_splits s join tasks t on t.id=s.task where t.task_key=$1', [task.taskKey])).rows[0]?.judged_rules.items[0];
    expect(recorded?.subjectHash).toBe(updated?.subjectHash);
    expect(refFingerprint(recorded?.sourceRef)).toBe(updated?.subjectHash);
  });

  test('5차 리뷰 P1(실제 DB): 원 Task를 취소하는 분할의 새 Task는 상속될 묶음(shared-db)을 보고 판단하고, 지문이 서버 hash와 같다', async () => {
    const s = await project();
    const original = (await wbsSnapshot(ownerPool, s.id)).tasks.find((t) => t.status !== 'done' && t.status !== 'cancelled');
    if (!original) throw new Error('분할할 Task 없음');
    await ownerPool.query("update tasks set conflict_group='shared-db' where task_key=$1", [original.taskKey]);
    const detail = await lead('GET', `/api/tasks/${original.taskKey}`);
    const requested = await lead('POST', `/api/tasks/${original.taskKey}/split`, { updatedAt: detail.json<{ updatedAt: string }>().updatedAt });
    expect(requested.statusCode, requested.body).toBe(202);
    const job = await claim('split');
    const run = await context();
    run.agents.Claude.proposeSplit = async (request) => {
      run.agents.Claude.calls.push({ method: 'proposeSplit', request: structuredClone(request) });
      const wp = request.wbs.tasks.find((t) => t.taskKey === original.taskKey)?.wp ?? '';
      const add = (ref: string) => ({ op: 'add' as const, ref, preds: [], t: { title: `분할 ${ref}`, type: 'Implementation' as const, domain: 'BE' as const, wp, priority: 1,
        assignee: 'Claude' as const, verifier: 'Codex' as const, purpose: '목적', doneCond: '테스트 통과', splitBasis: '계약 먼저', ac: [{ given: 'g', when: 'w', then: 't' }] } });
      return { title: '분할', reason: '크기 상한', ops: [add('NEW-1'), add('NEW-2'), { op: 'remove' as const, task: original.taskKey }] };
    };
    for (const agent of Object.values(run.agents)) {
      const judge = agent.judgeRules.bind(agent);
      agent.judgeRules = async (request) => (await judge(request)).map((v) => ({ ...v,
        result: (request.subjects.find((x) => x.target === v.target)?.content as { conflictGroup: string | null }).conflictGroup === 'shared-db' ? 'not_met' as const : 'met' as const }));
    }
    const outcome = await runPlanningJob(job, run.ctx);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'done' });
    await finish(job, outcome);
    const shown = (run.agents.Codex.calls.find((c) => c.method === 'judgeRules')?.request as { subjects: { content: { conflictGroup: string | null } }[] }).subjects.map((x) => x.content.conflictGroup);
    expect(shown).toEqual(['shared-db', 'shared-db']);
    const cp = (await ownerPool.query<{ ops: { op: string; t?: { judgedRules?: { items: { result: string; subjectHash: string; sourceRef: string }[] } } }[] }>(
      'select ops from change_proposals where id=$1', [(outcome as unknown as { result: { proposalId: string } }).result.proposalId])).rows[0];
    const items = cp?.ops.flatMap((o) => o.t?.judgedRules?.items ?? []) ?? [];
    expect(items.length).toBe(6);
    // 서버가 상속을 적용한 변경 후 내용으로 붙인 hash = Runner가 판단에 보여 준 입력의 지문
    for (const i of items) {
      expect(i.result).toBe('not_met');
      expect(refFingerprint(i.sourceRef)).toBe(i.subjectHash);
    }
  });
});
