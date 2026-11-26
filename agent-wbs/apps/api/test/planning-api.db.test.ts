import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { OPERATIONS } from '@awbs/shared/api';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import { subjectHash, type JudgedSource } from '../src/tasks/hash.ts';

/*
 * M2-07의 나머지 Planning API: 추정·재조정(D-10, owner 가정 가동률 60%·임계값 1일), 분할 요청·예외(G§5.2-1),
 * Planning의 Task 판단 보고(contracts §3.3 /plan), Planning 세션·교차 검토와 팀장 Planning 화면 API(G§4.5).
 */

const origin = 'http://127.0.0.1:3100';
const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_planning_api';
const ownerPool = createPool(dbUrl.href, { max: 4, onError: () => undefined });
const appUrl = new URL(dbUrl);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { max: 12, onError: () => undefined });
const app = buildApp(pool, false, { origin, lan: false });

const shared = createRequire(new URL('../../../packages/shared/package.json', import.meta.url));
const { Ajv } = shared('ajv') as { Ajv: new (options: object) => { validate: (schema: unknown, data: unknown) => boolean; errorsText: () => string } };
const ajv = new Ajv({ strict: false });
function expectShape(id: string, status: number, body: unknown) {
  const op = OPERATIONS.find((item) => item.id === id);
  if (!op) throw new Error(id);
  expect(ajv.validate(op.responses[status], body), `${id} ${String(status)}: ${ajv.errorsText()}`).toBe(true);
}

let cookie = '';
let csrf = '';
let bearer = '';
let epoch = 1;
let projectId = '';
let wp = '';

const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie, origin, 'x-csrf-token': csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const runner = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${bearer}`, 'x-project-epoch': String(epoch), 'idempotency-key': randomUUID() }, payload: payload as object });
const errorOf = (response: { json: <T>() => T }) => response.json<{ error: { code: string; errors: { path: string; rule: string }[] } }>().error;

async function task(body: Record<string, unknown> = {}): Promise<string> {
  const response = await call('POST', `/api/projects/${projectId}/tasks`, { title: '작업', wbsNodeId: wp, workType: 'Implementation', primaryDomain: 'BE', ...body });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ taskKey: string }>().taskKey;
}
interface Detail { id: string; updatedAt: string; title: string; spec: { overview: JudgedSource['overview']; spec: Record<string, string[]>; ac: JudgedSource['ac'] }; outputs: JudgedSource['outputs']; designs: JudgedSource['designs']; conflictGroup: string | null; split: { exceptions: { rule: string; why: string }[]; judgedRules: unknown } | null; grades: { dev: { modelId: string } | null } }
const detail = async (key: string) => (await call('GET', `/api/tasks/${key}`)).json<Detail>();
const sourceOf = (d: Detail): JudgedSource => ({ title: d.title, overview: d.spec.overview, spec: d.spec.spec, ac: d.spec.ac, outputs: d.outputs, designs: d.designs, conflictGroup: d.conflictGroup });
const idOf = async (key: string) => (await ownerPool.query<{ id: string }>('select id from tasks where task_key=$1', [key])).rows[0]?.id ?? '';
async function job(kind = 'planning') {
  return (await ownerPool.query<{ id: string }>(
    "insert into runner_jobs(project_id,kind,payload,state,fence,epoch,dedup_key,lease_owner,lease_until) values($1,$2,'{}','leased',1,$3,$4,'r',now()+interval '1 minute') returning id",
    [projectId, kind, epoch, `test:${randomUUID()}`])).rows[0]?.id ?? '';
}
const estimateItem = (taskKey: string, est: number) => ({ taskKey, estHours: est, loHours: est, hiHours: est, confidence: '중', basis: '근거', agreedBy: ['Claude', 'Codex'] });

beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  await runMigrations(ownerPool);
  await seedSystem(ownerPool);
  epoch = (await ownerPool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch ?? 1;
  projectId = (await ownerPool.query<{ id: string }>(
    "insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('테스트','https://github.com/o/r','o','r','','active') returning id")).rows[0]?.id ?? '';
  const phase = (await ownerPool.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'p1','phase',null,'p1',0) returning id", [projectId])).rows[0]?.id;
  wp = (await ownerPool.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'wp1','work_package',$2,'wp1',0) returning id", [projectId, phase])).rows[0]?.id ?? '';
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
  bearer = await issueRunnerToken(pool, 'planning-api-runner', 'fake');
});
afterAll(async () => { await app.close(); await pool.end(); await ownerPool.end(); });

describe('planning 추정·재조정', () => {
  test('추정은 추가 전용으로 쌓이고 이력을 남기며, 기준이 없으면 재조정을 같은 요청에서 기록한다(자동 재조정 끔 = pending)', async () => {
    const a = await task();
    const response = await runner('/api/planning/estimates', { jobId: await job('estimate'), fence: 1, items: [estimateItem(a, 3)] });
    expect(response.statusCode, response.body).toBe(200);
    expectShape('submitEstimates', 200, response.json());
    const { replan } = response.json<{ replan?: { replanId: string; baselineVersion: number | null; moved: { taskKey: string; kind: string }[] } }>();
    expect(replan?.baselineVersion).toBeNull();
    expect(replan?.moved.find((m) => m.taskKey === a)?.kind).toBe('new');
    const status = (await ownerPool.query<{ status: string }>('select status from replans where rp_key=$1', [replan?.replanId])).rows[0]?.status;
    expect(status).toBe('pending');
    const again = await runner('/api/planning/estimates', { jobId: await job('estimate'), fence: 1, items: [estimateItem(a, 4)] });
    expect(again.statusCode).toBe(200);
    expect((await ownerPool.query('select 1 from task_estimates where task=$1', [await idOf(a)])).rowCount).toBe(2);
    expect((await ownerPool.query("select 1 from task_history h where h.task=$1 and h.kind='추정'", [await idOf(a)])).rowCount).toBe(2);
  });

  test('완료 Task 추정은 409, 없는 Task 404, 낙관>예상은 400', async () => {
    const done = await task();
    await ownerPool.query("update tasks set status='done',act_start=now()-interval '1 hour',act_end=now() where task_key=$1", [done]);
    expect(errorOf(await runner('/api/planning/estimates', { jobId: await job('estimate'), fence: 1, items: [estimateItem(done, 2)] })).code).toBe('INVALID_TRANSITION');
    expect(errorOf(await runner('/api/planning/estimates', { jobId: await job('estimate'), fence: 1, items: [estimateItem('TASK-9999', 2)] })).code).toBe('TASK_NOT_FOUND');
    const bad = await runner('/api/planning/estimates', { jobId: await job('estimate'), fence: 1, items: [{ ...estimateItem(done, 2), loHours: 5 }] });
    expect(errorOf(bad).errors.map((e) => e.rule)).toEqual(['estimateBounds']);
  });

  test('재조정 요청: 자동 재조정이 꺼지면 202 pending(기준 없음), 켜지면 201과 새 기준 버전. 팀장 재조정 실행은 항상 201 확정', async () => {
    const off = await runner('/api/planning/replans', { jobId: await job(), fence: 1, trigger: '입력 변경', capacity: { rate: 0.9, concurrency: 1, subRatio: 0 } });
    expect(off.statusCode, off.body).toBe(202);
    expectShape('requestReplan', 202, off.json());
    expect(off.json<{ baselineVersion: number | null }>().baselineVersion).toBeNull();
    await ownerPool.query('update schedule_policy set auto_replan=true');
    try {
      const on = await runner('/api/planning/replans', { jobId: await job(), fence: 1, trigger: '입력 변경', capacity: { rate: 0.9, concurrency: 1, subRatio: 0 } });
      expect(on.statusCode, on.body).toBe(201);
      const v = on.json<{ baselineVersion: number }>().baselineVersion;
      expect(v).toBeGreaterThan(0);
      // 제출 용량은 참고값이다. 서버는 저장된 정책(owner 가정 가동률 60%)으로 계산한다.
      expect(Number((await ownerPool.query<{ rate: string }>('select applied_rate as rate from schedule_baselines where v=$1', [v])).rows[0]?.rate)).toBe(0.6);
    } finally { await ownerPool.query('update schedule_policy set auto_replan=null'); }
    const manual = await call('POST', '/api/replans/run');
    expect(manual.statusCode, manual.body).toBe(201);
    expectShape('runReplan', 201, manual.json());
    expect(manual.json<{ baselineVersion: number | null }>().baselineVersion).toBeGreaterThan(1);
    const list = await call('GET', '/api/replans?limit=2');
    expect(list.statusCode).toBe(200);
    expectShape('listReplans', 200, list.json());
    const page = list.json<{ items: { status: string; actor: string }[]; nextCursor: string | null }>();
    expect(page.items[0]).toMatchObject({ status: 'applied', actor: '팀장' });
    expect(page.nextCursor).not.toBeNull();
    const next = (await call('GET', `/api/replans?limit=2&cursor=${page.nextCursor ?? ''}`)).json<{ items: unknown[] }>();
    expect(next.items.length).toBeGreaterThan(0);
  });

  test('기준과 어긋남이 임계값(1일) 미만이면 재추정해도 재조정을 기록하지 않는다', async () => {
    const a = await task();
    expect((await call('POST', '/api/replans/run')).statusCode).toBe(201);
    const before = Number((await ownerPool.query<{ n: string }>('select count(*) as n from replans')).rows[0]?.n);
    const response = await runner('/api/planning/estimates', { jobId: await job('estimate'), fence: 1, items: [estimateItem(a, 0)] });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ replan?: unknown }>().replan).toBeUndefined();
    expect(Number((await ownerPool.query<{ n: string }>('select count(*) as n from replans')).rows[0]?.n)).toBe(before);
  });

  test('낡은 fence의 Planning 보고는 409 LEASE_LOST', async () => {
    const response = await runner('/api/planning/replans', { jobId: await job(), fence: 7, trigger: 't', capacity: { rate: 0.5, concurrency: 1, subRatio: 0 } });
    expect(errorOf(response).code).toBe('LEASE_LOST');
  });
});

describe('planning 분할 요청·예외 사유', () => {
  test('시작 전 Task의 분할 요청은 판단 대상 내용·hash를 실은 split job을 하나 만든다(같은 내용 재요청은 같은 job)', async () => {
    const key = await task({ title: '분할할 작업' });
    const d = await detail(key);
    const response = await call('POST', `/api/tasks/${key}/split`, { updatedAt: d.updatedAt });
    expect(response.statusCode, response.body).toBe(202);
    expectShape('splitTask', 202, response.json());
    const { jobId } = response.json<{ jobId: string }>();
    const stored = (await ownerPool.query<{ kind: string; payload: { tasks: { taskKey: string; subjectHash: string; content: { title: string } }[] } }>('select kind,payload from runner_jobs where id=$1', [jobId])).rows[0];
    expect(stored?.kind).toBe('split');
    expect(stored?.payload.tasks).toEqual([expect.objectContaining({ taskKey: key, subjectHash: subjectHash(sourceOf(d)), content: expect.objectContaining({ title: '분할할 작업' }) })]);
    const again = await call('POST', `/api/tasks/${key}/split`, { updatedAt: (await detail(key)).updatedAt });
    expect(again.json<{ jobId: string }>().jobId).toBe(jobId);
    expect(errorOf(await call('POST', `/api/tasks/${key}/split`, { updatedAt: '2020-01-01T00:00:00Z' })).code).toBe('VERSION_CONFLICT');
  });

  test('시작한 Task는 분할 요청 409, 위반·의심 기준만 예외 사유로 기록한다', async () => {
    const key = await task({ title: '조회 및 수정' });
    await ownerPool.query("update tasks set status='running' where task_key=$1", [key]);
    expect(errorOf(await call('POST', `/api/tasks/${key}/split`, { updatedAt: (await detail(key)).updatedAt })).code).toBe('INVALID_TRANSITION');
    const ok = await call('POST', `/api/tasks/${key}/split-exceptions`, { updatedAt: (await detail(key)).updatedAt, rule: 'one', why: '같은 화면 흐름이라 함께 검증' });
    expect(ok.statusCode, ok.body).toBe(201);
    expectShape('addSplitException', 201, ok.json());
    expect((await detail(key)).split?.exceptions).toEqual([expect.objectContaining({ rule: 'one', why: '같은 화면 흐름이라 함께 검증' })]);
    const notFlagged = await call('POST', `/api/tasks/${key}/split-exceptions`, { updatedAt: (await detail(key)).updatedAt, rule: 'cg', why: 'x' });
    expect(errorOf(notFlagged).code).toBe('VALIDATION_FAILED');
    const fresh = await task({ title: '시작 전 및 작업' });
    expect(errorOf(await call('POST', `/api/tasks/${fresh}/split-exceptions`, { updatedAt: (await detail(fresh)).updatedAt, rule: 'one', why: 'x' })).code).toBe('INVALID_TRANSITION');
  });
});

describe('planning Task 판단 보고(/plan)', () => {
  const plan = (key: string, body: Record<string, unknown>) => job().then((jobId) => runner(`/api/planning/tasks/${key}/plan`, {
    jobId, fence: 1, grades: { dev: { modelId: 'claude-sonnet-5-5', effort: 'high', reason: '구현' }, qa: { modelId: 'gpt-5.5', effort: 'medium', reason: '검증' } },
    subagents: { dev: [], qa: [], basis: '' }, conflictGroup: null, ...body,
  }));
  const judged = (hash: string) => ({ schemaVersion: 1, items: ['revert', 'contract', 'refactor'].map((rule) => ({ rule, result: 'met', agreedBy: ['Claude', 'Codex'], basis: '근거', judgedAt: '2026-11-26T00:00:00Z', sourceRef: 'job', subjectHash: hash })) });

  test('payload hash가 현재와 같으면 판단·등급·충돌 묶음을 저장하고 다르면 409 VERSION_CONFLICT', async () => {
    const key = await task();
    const hash = subjectHash(sourceOf(await detail(key)));
    const stale = await plan(key, { judgedRules: judged('e'.repeat(64)) });
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    const ok = await plan(key, { judgedRules: judged(hash), conflictGroup: { name: 'orders', reason: '같은 테이블' } });
    expect(ok.statusCode, ok.body).toBe(204);
    const d = await detail(key);
    expect(d.conflictGroup).toBe('orders');
    expect(d.grades.dev?.modelId).toBe('claude-sonnet-5-5');
    // 함께 정한 충돌 묶음을 반영한 내용으로 서버가 hash를 다시 붙인다. 그래서 착수 승인(M2-02) 판정에서 바로 유효하다.
    expect(subjectHash(sourceOf(d))).not.toBe(hash);
    expect(d.split?.judgedRules).toMatchObject({ items: [{ subjectHash: subjectHash(sourceOf(d)) }, {}, {}] });
    const kinds = (await ownerPool.query<{ kind: string }>('select kind from task_history where task=$1 order by at', [await idOf(key)])).rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['분할 판단', '충돌 묶음', '등급']));
  });

  test('고정된 등급은 Planning 판단으로 바꾸지 않는다', async () => {
    const key = await task();
    await ownerPool.query("insert into task_grades(project_id,task,role,model_id,effort,reason,locked,locked_by,effective_from) values($1,$2,'dev','claude-opus-5-5','high','고정',true,'팀장',now())", [projectId, await idOf(key)]);
    expect((await plan(key, {})).statusCode).toBe(204);
    expect((await detail(key)).grades.dev?.modelId).toBe('claude-opus-5-5');
  });
});

describe('planning 세션·교차 검토와 팀장 Planning API', () => {
  test('팀장 Planning 시작 → Planning 분석·검토 보고 → 이견 선택 → 선택한 변경으로 CP 작성', async () => {
    const target = await task({ title: '검토 대상' });
    const started = await call('POST', '/api/plannings', { title: '알림 개편', scope: '알림 API' });
    expect(started.statusCode, started.body).toBe(202);
    expectShape('createPlanning', 202, started.json());
    const { id, jobId } = started.json<{ id: string; jobId: string }>();
    await ownerPool.query("update runner_jobs set state='leased',fence=1 where id=$1", [jobId]);
    for (const agent of ['Codex', 'Claude']) {
      const analysis = await runner(`/api/planning/sessions/${id}/analyses`, { jobId, fence: 1, agent, summary: `${agent} 요약`, items: ['항목'] });
      expect(analysis.statusCode, analysis.body).toBe(201);
    }
    const modify = (after: number) => ({ op: 'modify', task: target, field: 'priority', after });
    const reviews = await runner(`/api/planning/sessions/${id}/reviews`, { jobId, fence: 1, reviews: [
      { topic: '우선순위', kind: '이견', codex: '0으로', claude: '1로', codexOps: [modify(0)], claudeOps: [modify(1)] },
    ] });
    expect(reviews.statusCode, reviews.body).toBe(201);
    const list = await call('GET', '/api/plannings');
    expectShape('listPlannings', 200, list.json());
    const planning = list.json<{ items: { id: string; analyses: unknown[]; reviews: { id: string; updatedAt: string; choice: string | null }[] }[] }>().items.find((p) => p.id === id);
    expect(planning?.analyses).toHaveLength(2);
    const review = planning?.reviews[0];
    const chosen = await call('POST', `/api/plannings/${id}/reviews/${review?.id ?? ''}/choice`, { updatedAt: review?.updatedAt, choice: 'claude' });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expectShape('choosePlanningReview', 200, chosen.json());
    const cp = await call('POST', `/api/plannings/${id}/proposals`, { title: '우선순위 조정', reason: '교차 검토 결과' });
    expect(cp.statusCode, cp.body).toBe(201);
    expectShape('createPlanningProposal', 201, cp.json());
    expect(cp.json<{ ops: unknown[]; source: { kind: string; id: string } }>()).toMatchObject({ ops: [modify(1)], source: { kind: 'planning', id } });
    const after = (await call('GET', '/api/plannings')).json<{ items: { id: string; proposalId: string | null }[] }>().items.find((p) => p.id === id);
    expect(after?.proposalId).toBe(cp.json<{ id: string }>().id);
  });

  test('Planning이 스스로 세션을 열 수 있고, 선택하지 않은 이견이 있으면 CP 작성은 400', async () => {
    const session = await runner('/api/planning/sessions', { jobId: await job(), fence: 1, title: '입력 변경 분석', scope: 'v2' });
    expect(session.statusCode, session.body).toBe(201);
    const { id } = session.json<{ id: string }>();
    const jobId = await job();
    const target = await task();
    const common = [{ op: 'modify', task: target, field: 'priority', after: 3 }];
    const reviews = await runner(`/api/planning/sessions/${id}/reviews`, { jobId, fence: 1, reviews: [{ topic: 't', kind: '이견', codex: 'a', claude: 'b', ops: common, codexOps: [], claudeOps: [] }] });
    expect(reviews.statusCode, reviews.body).toBe(201);
    const cp = await call('POST', `/api/plannings/${id}/proposals`, { title: 't', reason: 'r' });
    expect(errorOf(cp).code).toBe('VALIDATION_FAILED');
    expect(errorOf(cp).errors.map((e) => e.path)).toEqual(['reviews.0.choice']);
  });
});
