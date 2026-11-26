import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { OPERATIONS } from '@awbs/shared/api';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';

/*
 * M2-07 완료 조건(milestones.md): Planning·변경 제안(CP) 미리보기=반영·자동/보류·추정·재조정·분할.
 * - 취소 반영과 SS 제거·이력·재조정이 한 트랜잭션, 미리보기 영향 = 반영 결과(D-27)
 * - D-33~35 보류: 자동·수동 승인·반영이 같은 판정, 재시뮬레이션 때 다시 판정
 * - 팀장 CP 판단 job 생성·재요청, 판단 저장 위치 이전과 hash 재대조
 * - CP splitBasis 선택/필수와 반영 저장, CP add 선택 필드 저장·상속 재계산
 */

const origin = 'http://127.0.0.1:3100';
const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_planning';
const ownerPool = createPool(dbUrl.href, { max: 4, onError: () => undefined });
const appUrl = new URL(dbUrl);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { max: 12, onError: () => undefined });
const app = buildApp(pool, process.env.PLANNING_DEBUG ? { level: 'error' } : false, { origin, lan: false });

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

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const call = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie, origin, 'x-csrf-token': csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const runner = (url: string, payload: unknown, key = randomUUID()) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${bearer}`, 'x-project-epoch': String(epoch), 'idempotency-key': key }, payload: payload as object });
const errorOf = (response: { json: <T>() => T }) => response.json<{ error: { code: string; errors: { path: string; rule: string }[]; details: Record<string, unknown> } }>().error;

interface Proposal {
  id: string; cpKey: string; status: string; updatedAt: string; idMap: Record<string, string>; ops: { op: string; t?: Record<string, unknown> }[];
  holdReasons: { code: string; taskKey?: string; rule?: string }[]; issues: { code: string }[];
  taskJudgements: { taskKey: string }[]; splitJudgements: unknown; events: { action: string }[];
}
interface Impact { removedDependencies: { pred: string; succ: string; type: string; reason: string }[]; unblockedSuccessors: { taskKey: string; remainingBlockers: { pred: string }[] }[] }
interface Preview { previewHash: string; impact: Impact; holdReasons: Proposal['holdReasons']; issues: { code: string; taskKey?: string }[]; diff: { target: string; field: string; before: unknown; after: unknown }[]; idMap: Record<string, string> }

async function task(body: Record<string, unknown> = {}): Promise<string> {
  const response = await call('POST', `/api/projects/${projectId}/tasks`, { title: '작업', wbsNodeId: wp, workType: 'Implementation', primaryDomain: 'BE', ...body });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ taskKey: string }>().taskKey;
}
const idOf = async (key: string) => (await ownerPool.query<{ id: string }>('select id from tasks where task_key=$1', [key])).rows[0]?.id ?? '';
const setStatus = (key: string, status: string) => ownerPool.query('update tasks set status=$2 where task_key=$1', [key, status]);
async function dep(pred: string, succ: string, type: 'FS' | 'SS' = 'FS') {
  await ownerPool.query('insert into task_dependencies(project_id,pred,succ,dep_type) values($1,$2,$3,$4)', [projectId, await idOf(pred), await idOf(succ), type]);
}
async function estimate(key: string, est: number, confidence = '상') {
  await ownerPool.query("insert into task_estimates(project_id,task,est,lo,hi,confidence,basis,agreed_by) values($1,$2,$3,$3,$3,$4,'근거','Claude,Codex')", [projectId, await idOf(key), est, confidence]);
}
async function history(key: string) {
  return (await ownerPool.query<{ kind: string; text: string; actor: string; ref: Record<string, unknown> | null }>(
    'select h.kind,h.text,h.actor,h.ref from task_history h join tasks t on t.id=h.task where t.task_key=$1 order by h.at,h.created_at', [key])).rows;
}
const depsOf = async (key: string) => (await ownerPool.query<{ pred: string; succ: string; type: string }>(
  `select p.task_key as pred,s.task_key as succ,d.dep_type as type from task_dependencies d join tasks p on p.id=d.pred join tasks s on s.id=d.succ
   where p.task_key=$1 or s.task_key=$1 order by 1,2`, [key])).rows;
const statusOf = async (key: string) => (await ownerPool.query<{ status: string }>('select status from tasks where task_key=$1', [key])).rows[0]?.status;
const countRows = async (table: string) => Number((await ownerPool.query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0]?.n);

const leadAdd = (ref: string, t: Record<string, unknown> = {}, preds: { pred: string; type: string }[] = []) => ({
  op: 'add', ref, preds,
  t: { title: `추가 ${ref}`, type: 'Implementation', domain: 'BE', wp, priority: 2, assignee: 'Claude', verifier: 'Codex', purpose: '목적', doneCond: '완료', ...t },
});
async function leadCp(ops: unknown[], source: { kind: string; id?: string } = { kind: 'manual' }) {
  const response = await call('POST', '/api/proposals', { title: '변경', reason: '사유', source, ops });
  expect(response.statusCode, response.body).toBe(201);
  expectShape('createProposal', 201, response.json());
  return response.json<Proposal>();
}
const getCp = async (id: string) => (await ownerPool.query<{ status: string; updated_at: string }>(
  `select status,to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at from change_proposals where id=$1`, [id])).rows[0];
const version = async (id: string) => (await getCp(id))?.updated_at ?? '';
async function submit(id: string) {
  const response = await call('POST', `/api/proposals/${id}/submit`, { updatedAt: await version(id) });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Proposal>();
}
async function preview(id: string) {
  const response = await call('GET', `/api/proposals/${id}/preview`);
  expect(response.statusCode, response.body).toBe(200);
  expectShape('previewProposal', 200, response.json());
  return response.json<Preview>();
}
const approve = async (id: string, hash?: string) =>
  call('POST', `/api/proposals/${id}/approve`, { updatedAt: await version(id), previewHash: hash ?? (await preview(id)).previewHash });
const apply = async (id: string, hash?: string) =>
  call('POST', `/api/proposals/${id}/apply`, { updatedAt: await version(id), previewHash: hash ?? (await preview(id)).previewHash });

/** Planning Agent가 받은 job(임대 중, fence 1). Planning 보고 API는 jobId·fence로 job을 확인한다. */
async function job(kind = 'planning', payload: object = {}) {
  return (await ownerPool.query<{ id: string }>(
    "insert into runner_jobs(project_id,kind,payload,state,fence,epoch,dedup_key,lease_owner,lease_until) values($1,$2,$3,'leased',1,$4,$5,'r',now()+interval '1 minute') returning id",
    [projectId, kind, payload, epoch, `test:${randomUUID()}`])).rows[0]?.id ?? '';
}
async function planningCp(body: Record<string, unknown>) {
  const response = await runner('/api/planning/proposals', { jobId: await job(), fence: 1, title: 'Planning 제안', reason: '사유', source: { kind: 'planning' }, ...body });
  expect(response.statusCode, response.body).toBe(201);
  expectShape('submitPlanningProposal', 201, response.json());
  const { id } = response.json<{ id: string }>();
  return proposalOf(id);
}
async function proposalOf(id: string): Promise<Proposal> {
  const response = await call('GET', '/api/proposals?limit=200');
  expect(response.statusCode, response.body).toBe(200);
  expectShape('listProposals', 200, response.json());
  const found = response.json<{ items: Proposal[] }>().items.find((item) => item.id === id);
  if (!found) throw new Error(`CP ${id} 없음`);
  return found;
}
const judgementJobs = async (proposalId: string) => (await ownerPool.query<{ id: string; state: string; payload: {
  proposal: { id: string; ops: unknown[]; targets: { target: string; subjectHash: string; before: unknown; after: unknown }[]; splitSubjectHash: string | null; splitTasks: { taskKey: string }[] | null };
} }>("select id,state,payload from runner_jobs where kind='planning' and payload->'proposal'->>'id'=$1 order by created_at", [proposalId])).rows;
const met = (rules: string[], subjectHash?: string) => ({ schemaVersion: 1, items: rules.map((rule) => ({
  rule, result: 'met', agreedBy: ['Claude', 'Codex'], basis: '근거', judgedAt: '2026-11-26T00:00:00Z', sourceRef: 'planning-job', ...(subjectHash ? { subjectHash } : {}),
})) });
const RULES = ['revert', 'contract', 'refactor'];

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
  expect(login.statusCode, login.body).toBe(204);
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
  bearer = await issueRunnerToken(pool, 'planning-runner', 'fake');
  // 판단 규칙을 끄고 시작한다. 판단 보류를 보는 테스트만 켠다.
  await ownerPool.query(`update app_settings set split=jsonb_set(split,'{on}',split->'on' || '{"revert":false,"contract":false,"refactor":false}')`);
});
afterAll(async () => { await app.close(); await pool.end(); await ownerPool.end(); });

const judgedRulesOn = async (on: boolean) => {
  const value = JSON.stringify({ revert: on, contract: on, refactor: on });
  await ownerPool.query(`update app_settings set split=jsonb_set(split,'{on}',split->'on' || $1::jsonb)`, [value]);
};

describe('planning 취소 반영(D-27): 미리보기 영향 = 반영 결과, 한 트랜잭션', () => {
  test('취소된 선행의 SS·FS 관계를 제거하고 풀리는 후속과 남은 선행을 구분하며, 반영 결과가 미리보기와 같다', async () => {
    const a = await task({ title: '취소할 선행' });
    const b = await task({ title: 'SS 후속' });
    const c = await task({ title: 'FS 후속' });
    const d = await task({ title: '남는 선행' });
    await setStatus(a, 'ready');
    await dep(a, b, 'SS');
    await dep(a, c, 'FS');
    await dep(d, c, 'FS');
    const replansBefore = await countRows('replans');

    const cp = await leadCp([{ op: 'remove', task: a }]);
    expect(cp.status).toBe('draft');
    expect((await submit(cp.id)).status).toBe('review');
    const seen = await preview(cp.id);
    expect(seen.holdReasons).toEqual([]);
    expect(seen.issues).toEqual([]);
    expect(seen.impact.removedDependencies).toEqual(expect.arrayContaining([
      { pred: a, succ: b, type: 'SS', reason: 'pred-cancelled' }, { pred: a, succ: c, type: 'FS', reason: 'pred-cancelled' },
    ]));
    const unblocked = Object.fromEntries(seen.impact.unblockedSuccessors.map((item) => [item.taskKey, item.remainingBlockers.map((x) => x.pred)]));
    expect(unblocked).toEqual({ [b]: [], [c]: [d] });

    const approved = await approve(cp.id, seen.previewHash);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<Proposal>().status).toBe('approved');
    const applied = await apply(cp.id, seen.previewHash);
    expect(applied.statusCode, applied.body).toBe(200);
    expectShape('applyProposal', 200, applied.json());
    const result = applied.json<{ proposal: Proposal } & Preview>();
    expect(result.proposal.status).toBe('applied');
    // 미리보기와 반영은 같은 함수 — 팀장이 본 영향이 실제 반영 결과다.
    expect(result.impact).toEqual(seen.impact);
    expect(result.diff).toEqual(seen.diff);

    expect(await statusOf(a)).toBe('cancelled');
    expect(await depsOf(a)).toEqual([]);
    expect(await depsOf(c)).toEqual([{ pred: d, succ: c, type: 'FS' }]);
    expect((await history(a)).map((h) => h.kind)).toContain('취소');
    expect((await history(b)).some((h) => h.kind === '선행 관계' && h.text.includes(a))).toBe(true);
    expect((await history(b)).some((h) => h.kind === '차단' && h.text.includes('해제'))).toBe(true);
    expect((await history(c)).some((h) => h.kind === '차단')).toBe(false);
    // 재조정도 같은 반영에서 기록된다.
    expect(await countRows('replans')).toBe(replansBefore + 1);
    expect(result.proposal.events.map((e) => e.action)).toEqual(['created', 'submitted', 'approved', 'applied']);
  });

  test('반영 중 재조정 기록이 실패하면 취소·관계 제거·이력이 모두 되돌려진다', async () => {
    const a = await task({ title: '원자성 선행' });
    const b = await task({ title: '원자성 후속' });
    await dep(a, b, 'SS');
    const cp = await leadCp([{ op: 'remove', task: a }]);
    await submit(cp.id);
    expect((await approve(cp.id)).statusCode).toBe(200);
    const historyBefore = (await history(a)).length;
    await ownerPool.query(`create function test_fail_replan() returns trigger language plpgsql as $$ begin raise exception 'replan 실패 주입'; end $$`);
    await ownerPool.query('create trigger test_fail_replan before insert on replans for each row execute function test_fail_replan()');
    try {
      const failed = await apply(cp.id);
      expect(failed.statusCode).toBe(500);
    } finally {
      await ownerPool.query('drop trigger test_fail_replan on replans');
      await ownerPool.query('drop function test_fail_replan()');
    }
    expect(await statusOf(a)).toBe('planning');
    expect(await depsOf(a)).toEqual([{ pred: a, succ: b, type: 'SS' }]);
    expect((await history(a)).length).toBe(historyBefore);
    expect((await getCp(cp.id))?.status).toBe('approved');
  });

  test('낡은 미리보기로 승인·반영하면 409 VERSION_CONFLICT, 상태가 맞지 않으면 409 INVALID_TRANSITION', async () => {
    const a = await task();
    const cp = await leadCp([{ op: 'modify', task: a, field: 'priority', after: 0 }]);
    expect(errorOf(await approve(cp.id)).code).toBe('INVALID_TRANSITION');
    await submit(cp.id);
    const seen = await preview(cp.id);
    await ownerPool.query('update tasks set priority=0 where task_key=$1', [a]);
    // 같은 값이 되어 「이미 적용된 변경」 issue가 생기므로 미리보기 hash가 달라진다.
    expect(errorOf(await approve(cp.id, seen.previewHash)).code).toBe('VERSION_CONFLICT');
    const stale = await call('POST', `/api/proposals/${cp.id}/approve`, { updatedAt: '2020-01-01T00:00:00Z', previewHash: (await preview(cp.id)).previewHash });
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
  });

  test('반영 불가 사유(issues)만 있으면 수동 반영은 200 held로 사유를 저장한다', async () => {
    const a = await task();
    const cp = await leadCp([{ op: 'modify', task: a, field: 'title', after: '새 제목' }]);
    await submit(cp.id);
    expect((await approve(cp.id)).statusCode).toBe(200);
    await setStatus(a, 'done');
    const response = await apply(cp.id);
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<{ proposal: Proposal; issues: { code: string }[] }>();
    expect(result.proposal.status).toBe('held');
    expect(result.issues.map((i) => i.code)).toEqual(['COMPLETED_TASK']);
    expect(result.proposal.issues.map((i) => i.code)).toEqual(['COMPLETED_TASK']);
    expect((await ownerPool.query<{ title: string }>('select title from tasks where task_key=$1', [a])).rows[0]?.title).toBe('작업');
  });
});

describe('planning D-33~35 보류: 자동·수동 같은 판정, 재시뮬레이션 때 다시 판정', () => {
  test('판단 기록 없는 새 Task: 자동 정책은 held, 수동 승인은 409 SPLIT_JUDGEMENT_REQUIRED — 같은 사유', async () => {
    await judgedRulesOn(true);
    try {
      const auto = await planningCp({ ops: [leadAdd('NEW-1')] });
      expect(auto.status).toBe('held');
      const autoReasons = auto.holdReasons.map((r) => [r.code, r.rule]);
      expect(autoReasons).toEqual(RULES.map((rule) => ['JUDGEMENT_MISSING', rule]));

      const manual = await leadCp([leadAdd('NEW-1')]);
      await submit(manual.id);
      const seen = await preview(manual.id);
      expect(seen.holdReasons.map((r) => [r.code, r.rule])).toEqual(autoReasons);
      const refused = await approve(manual.id, seen.previewHash);
      expect(refused.statusCode).toBe(409);
      expect(errorOf(refused).code).toBe('SPLIT_JUDGEMENT_REQUIRED');
      expect((errorOf(refused).details.holdReasons as { code: string }[]).map((r) => r.code)).toEqual(['JUDGEMENT_MISSING', 'JUDGEMENT_MISSING', 'JUDGEMENT_MISSING']);
    } finally { await judgedRulesOn(false); }
  });

  test('승인 뒤 후속이 실행 중이 되면 반영 때 다시 판정해 409 ACTIVE_TASK_BLOCKED, 자동 정책은 held', async () => {
    const pred = await task({ title: '새 선행' });
    const succ = await task({ title: '진행될 후속' });
    await setStatus(succ, 'ready');
    const cp = await leadCp([{ op: 'dep-add', pred, succ, type: 'FS' }]);
    await submit(cp.id);
    expect((await approve(cp.id)).statusCode).toBe(200);
    await setStatus(succ, 'running');
    const refused = await apply(cp.id);
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused).code).toBe('ACTIVE_TASK_BLOCKED');
    expect(await depsOf(succ)).toEqual([]);

    const auto = await planningCp({ ops: [{ op: 'dep-add', pred, succ, type: 'FS' }] });
    expect(auto.status).toBe('held');
    expect(auto.holdReasons.map((r) => [r.code, r.taskKey])).toEqual([['ACTIVE_TASK_BLOCKED', succ]]);
    expect(await depsOf(succ)).toEqual([]);
  });

  test('분할 CP가 원래 순서를 잃으면 자동은 held, 수동 승인은 409 ORDER_NOT_PRESERVED', async () => {
    const a = await task({ title: '분할 선행' });
    const original = await task({ title: '큰 작업' });
    await setStatus(a, 'ready');
    await dep(a, original, 'FS');
    await estimate(original, 10);
    const ac = [{ given: 'g', when: 'w', then: '하나' }, { given: 'g', when: 'w', then: '둘' }];
    await ownerPool.query("update task_specs set ac=$2 where task=$1", [await idOf(original), JSON.stringify(ac.map((x) => ({ ...x, method: '' })))]);
    const part = (ref: string, index: number, preds: { pred: string; type: string }[]) =>
      leadAdd(ref, { est: 3, conf: '상', splitBasis: '크기 상한 초과로 분할', ac: [ac[index]] }, preds);
    // 두 번째 조각에는 원래 선행 a가 없다.
    const ops = [part('NEW-1', 0, [{ pred: a, type: 'FS' }]), part('NEW-2', 1, []), { op: 'remove', task: original }];
    const auto = await planningCp({ source: { kind: 'split', id: original }, ops, splitJudgements: met(['ac_meaning', 'layer_order', 'test_included']) });
    expect(auto.status).toBe('held');
    expect(auto.holdReasons.map((r) => r.code)).toEqual(['ORDER_NOT_PRESERVED']);

    const manual = await leadCp(ops, { kind: 'split', id: original });
    await submit(manual.id);
    const refused = await approve(manual.id);
    expect(refused.statusCode).toBe(409);
    // 판단 기록이 없는 분할 판단(D-34)과 순서 보장이 함께 보류 사유다. 판단 보류가 먼저 409 코드를 정한다.
    const reasons = (errorOf(refused).details.holdReasons as { code: string }[]).map((r) => r.code);
    expect(reasons).toContain('ORDER_NOT_PRESERVED');
    expect(reasons).toContain('JUDGEMENT_MISSING');
    expect(errorOf(refused).code).toBe('SPLIT_JUDGEMENT_REQUIRED');
    expect(await statusOf(original)).toBe('planning');
  });

  test('보류 사유가 없으면 자동 정책은 바로 반영한다', async () => {
    const a = await task();
    const auto = await planningCp({ ops: [{ op: 'modify', task: a, field: 'priority', after: 1 }] });
    expect(auto.status).toBe('applied');
    expect((await ownerPool.query<{ priority: number }>('select priority from tasks where task_key=$1', [a])).rows[0]?.priority).toBe(1);
  });
});

describe('planning 팀장 CP 판단 job: 생성·재요청, 저장 위치 이전과 hash 재대조', () => {
  test('판단이 필요한 CP가 review에 들어오면 job을 하나 만들고, 대상 hash가 바뀌면 다시 만든다', async () => {
    await judgedRulesOn(true);
    try {
      const existing = await task({ title: '제목 바꿀 Task' });
      const cp = await leadCp([leadAdd('NEW-1', { scope: ['범위'] }), { op: 'modify', task: existing, field: 'title', after: '바뀐 제목' }]);
      expect(await judgementJobs(cp.id)).toEqual([]);
      await submit(cp.id);
      const [first, ...rest] = await judgementJobs(cp.id);
      expect(rest).toEqual([]);
      expect(first?.state).toBe('queued');
      const payload = first?.payload.proposal;
      expect(payload?.targets.map((t) => t.target).sort()).toEqual(['NEW-1', existing]);
      expect(payload?.targets.find((t) => t.target === 'NEW-1')?.before).toBeNull();
      expect(payload?.targets.find((t) => t.target === existing)?.after).toMatchObject({ title: '바뀐 제목' });
      expect(payload?.splitSubjectHash).toBeNull();
      // 같은 hash 조합으로는 다시 만들지 않는다(미리보기·승인 시도).
      await preview(cp.id);
      expect((await approve(cp.id)).statusCode).toBe(409);
      expect(await judgementJobs(cp.id)).toHaveLength(1);

      // 기존 Task의 범위가 바뀌면 변경 후 내용의 hash가 달라진다. 승인 시도(409)에서도 새 job은 남는다.
      await ownerPool.query(`update task_specs set overview=jsonb_set(overview,'{scope}','["다른 범위"]') where task=$1`, [await idOf(existing)]);
      const refused = await approve(cp.id);
      expect(errorOf(refused).code).toBe('SPLIT_JUDGEMENT_REQUIRED');
      const jobs = await judgementJobs(cp.id);
      expect(jobs).toHaveLength(2);
      expect(jobs[1]?.payload.proposal.targets.find((t) => t.target === existing)?.subjectHash)
        .not.toBe(jobs[0]?.payload.proposal.targets.find((t) => t.target === existing)?.subjectHash);
    } finally { await judgedRulesOn(false); }
  });

  test('판단 보고는 payload hash가 현재와 같아야 저장되고, 반영 때 새 Task·기존 Task의 task_splits로 옮겨진다', async () => {
    await judgedRulesOn(true);
    try {
      const existing = await task({ title: '판단 이전 대상' });
      const cp = await leadCp([leadAdd('NEW-1', { splitBasis: '일반 CP 근거' }), { op: 'modify', task: existing, field: 'doneCond', after: '새 완료 조건' }]);
      await submit(cp.id);
      const [pending] = await judgementJobs(cp.id);
      expect(pending).toBeDefined();
      await ownerPool.query("update runner_jobs set state='leased',fence=1,lease_owner='r',lease_until=now()+interval '1 minute' where id=$1", [pending?.id]);
      const hashOf = (target: string) => pending?.payload.proposal.targets.find((t) => t.target === target)?.subjectHash ?? '';
      const report = (judgements: unknown[]) => runner(`/api/planning/proposals/${cp.id}/judgements`, { jobId: pending?.id, fence: 1, judgements });

      const wrong = await report([{ target: 'NEW-1', judgedRules: met(RULES, 'f'.repeat(64)) }]);
      expect(wrong.statusCode).toBe(409);
      expect(errorOf(wrong).code).toBe('VERSION_CONFLICT');
      const staleFence = await runner(`/api/planning/proposals/${cp.id}/judgements`, { jobId: pending?.id, fence: 0, judgements: [] });
      expect(errorOf(staleFence).code).toBe('LEASE_LOST');

      const before = await version(cp.id);
      const ok = await report([{ target: 'NEW-1', judgedRules: met(RULES, hashOf('NEW-1')) }, { target: existing, judgedRules: met(RULES, hashOf(existing)) }]);
      expect(ok.statusCode, ok.body).toBe(204);
      expect(await version(cp.id)).not.toBe(before);
      const stored = await proposalOf(cp.id);
      expect(stored.ops[0]?.t?.judgedRules).toMatchObject({ items: [{ rule: 'revert', subjectHash: hashOf('NEW-1') }, {}, {}] });
      expect(stored.taskJudgements.map((j) => j.taskKey)).toEqual([existing]);
      // 반영 전에는 기존 Task의 task_splits를 바꾸지 않는다.
      expect((await ownerPool.query('select 1 from task_splits where task=$1', [await idOf(existing)])).rowCount).toBe(0);

      const seen = await preview(cp.id);
      expect(seen.holdReasons).toEqual([]);
      expect((await approve(cp.id, seen.previewHash)).statusCode).toBe(200);
      const applied = await apply(cp.id, seen.previewHash);
      expect(applied.statusCode, applied.body).toBe(200);
      const newKey = seen.idMap['NEW-1'] ?? '';
      const splits = (await ownerPool.query<{ task_key: string; basis: string; judged_rules: { items: { subjectHash: string }[] } }>(
        'select t.task_key,s.basis,s.judged_rules from task_splits s join tasks t on t.id=s.task where t.task_key=any($1) order by t.task_key', [[newKey, existing]])).rows;
      expect(splits.map((s) => [s.task_key, s.basis, s.judged_rules.items[0]?.subjectHash])).toEqual([
        [existing, '', hashOf(existing)], [newKey, '일반 CP 근거', hashOf('NEW-1')],
      ].sort((x, y) => ((x[0] ?? '') < (y[0] ?? '') ? -1 : 1)));
      expect((await history(existing)).some((h) => h.kind === '분할 판단')).toBe(true);
      // 반영된 Task는 착수 승인 판정(M2-02)에서도 같은 hash로 유효하다.
      expect((await ownerPool.query<{ done: string }>("select overview->>'doneCond' as done from task_specs where task=$1", [await idOf(existing)])).rows[0]?.done).toBe('새 완료 조건');
    } finally { await judgedRulesOn(false); }
  });

  test('applied·rejected CP의 판단 보고는 409 INVALID_TRANSITION', async () => {
    const cp = await leadCp([leadAdd('NEW-1')]);
    await submit(cp.id);
    const rejected = await call('POST', `/api/proposals/${cp.id}/reject`, { updatedAt: await version(cp.id), comment: '불필요' });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json<Proposal>().status).toBe('rejected');
    const response = await runner(`/api/planning/proposals/${cp.id}/judgements`, { jobId: await job(), fence: 1, judgements: [] });
    expect(errorOf(response).code).toBe('INVALID_TRANSITION');
  });
});

describe('planning CP splitBasis와 add 선택 필드', () => {
  test('분할 CP의 추가 Task에 splitBasis가 없으면 400, 원래 Task 키가 없어도 400', async () => {
    const original = await task();
    const noBasis = await call('POST', '/api/proposals', { title: 't', reason: 'r', source: { kind: 'split', id: original }, ops: [leadAdd('NEW-1')] });
    expect(noBasis.statusCode).toBe(400);
    const noSource = await call('POST', '/api/proposals', { title: 't', reason: 'r', source: { kind: 'split' }, ops: [leadAdd('NEW-1', { splitBasis: '근거' })] });
    expect(noSource.statusCode).toBe(400);
  });

  test('팀장 작성의 conflictGroup·판단 기록은 400, 같은 설계 kind는 uniqueDesignKind 400', async () => {
    expect((await call('POST', '/api/proposals', { title: 't', reason: 'r', source: { kind: 'manual' }, ops: [leadAdd('NEW-1', { conflictGroup: 'G' })] })).statusCode).toBe(400);
    expect((await call('POST', '/api/proposals', { title: 't', reason: 'r', source: { kind: 'manual' }, ops: [leadAdd('NEW-1', { judgedRules: met(RULES) })] })).statusCode).toBe(400);
    const dup = await call('POST', '/api/proposals', { title: 't', reason: 'r', source: { kind: 'manual' }, ops: [leadAdd('NEW-1', { design: [{ kind: 'DB', content: {} }, { kind: 'DB', content: {} }] })] });
    expect(dup.statusCode).toBe(400);
    expect(errorOf(dup).errors).toEqual([expect.objectContaining({ path: 'ops.0.t.design.1.kind', rule: 'uniqueDesignKind' })]);
  });

  test('add 선택 필드(scope·files·design)와 splitBasis를 반영 때 저장하고, 생략하면 빈 값·영역별 빈 설계 구역이다', async () => {
    const cp = await leadCp([
      leadAdd('NEW-1', { scope: ['목록'], files: ['src/a.ts'], design: [{ kind: 'DB', content: { ents: [{ f: { name: 't' } }], b: {} } }], splitBasis: '근거 문장' }),
      leadAdd('NEW-2', { rel: ['FE'] }),
    ]);
    await submit(cp.id);
    expect((await approve(cp.id)).statusCode).toBe(200);
    const applied = await apply(cp.id);
    expect(applied.statusCode, applied.body).toBe(200);
    const { idMap } = applied.json<Preview>();
    const read = async (key: string) => (await call('GET', `/api/tasks/${key}`)).json<{
      spec: { overview: { scope: string[] }; spec: { files: string[] } }; designs: { kind: string; content: unknown }[]; conflictGroup: string | null; split: { basis: string } | null; checklistItems: unknown[];
    }>();
    const one = await read(idMap['NEW-1'] ?? '');
    expect(one.spec.overview.scope).toEqual(['목록']);
    expect(one.spec.spec.files).toEqual(['src/a.ts']);
    expect(one.designs).toEqual([{ kind: 'DB', content: { ents: [{ f: { name: 't' } }], b: {} } }]);
    expect(one.split?.basis).toBe('근거 문장');
    expect(one.conflictGroup).toBeNull();
    const two = await read(idMap['NEW-2'] ?? '');
    expect(two.spec.overview.scope).toEqual([]);
    expect(two.spec.spec.files).toEqual([]);
    expect(two.designs).toEqual([{ kind: 'API', content: { ents: [], b: {} } }, { kind: 'FE', content: { ents: [], b: {} } }]);
    // 일반 CP에서 생략한 분할 근거는 빈 문자열 = 미기록. 문구를 지어 넣지 않는다.
    expect(two.split?.basis).toBe('');
    expect((await history(idMap['NEW-1'] ?? '')).map((h) => h.kind)).toContain('생성');
  });

  test('분할 CP가 생략한 충돌 묶음은 원래 Task 묶음을 상속하고, 원래 묶음이 바뀌면 미리보기·반영 때 다시 계산한다', async () => {
    const original = await task({ title: '묶음 원래' });
    await ownerPool.query("update tasks set conflict_group='orders' where task_key=$1", [original]);
    await estimate(original, 10);
    const ac = [{ given: 'g', when: 'w', then: '하나' }, { given: 'g', when: 'w', then: '둘' }];
    await ownerPool.query('update task_specs set ac=$2 where task=$1', [await idOf(original), JSON.stringify(ac.map((x) => ({ ...x, method: '' })))]);
    const ops = [
      leadAdd('NEW-1', { est: 3, conf: '상', splitBasis: '크기 분할', ac: [ac[0]] }),
      leadAdd('NEW-2', { est: 3, conf: '상', splitBasis: '크기 분할', ac: [ac[1]] }, [{ pred: 'NEW-1', type: 'FS' }]),
      { op: 'remove', task: original },
    ];
    const cp = await planningCp({ source: { kind: 'split', id: original }, ops, splitJudgements: met(['ac_meaning', 'layer_order', 'test_included']) });
    expect(cp.status).toBe('applied');
    const read = async (key: string) => (await ownerPool.query<{ cg: string | null }>('select conflict_group as cg from tasks where task_key=$1', [key])).rows[0]?.cg;
    expect(await read(cp.idMap['NEW-1'] ?? '')).toBe('orders');
    expect(await read(cp.idMap['NEW-2'] ?? '')).toBe('orders');
    const links = (await ownerPool.query('select 1 from task_source_links where split_from=$1', [await idOf(original)])).rowCount;
    expect(links).toBe(2);

    // 저장만 한 분할 CP(정책 끔): 미리보기 뒤 원래 묶음이 바뀌면 상속 값과 diff가 다시 계산된다.
    await ownerPool.query('update schedule_policy set cp_auto=false');
    try {
      const second = await task({ title: '묶음 원래 2' });
      await ownerPool.query("update tasks set conflict_group='pay' where task_key=$1", [second]);
      await estimate(second, 10);
      await ownerPool.query('update task_specs set ac=$2 where task=$1', [await idOf(second), JSON.stringify(ac.map((x) => ({ ...x, method: '' })))]);
      const opsTwo = ops.map((op) => ('task' in op ? { ...op, task: second } : op));
      const stored = await planningCp({ source: { kind: 'split', id: second }, ops: opsTwo, splitJudgements: met(['ac_meaning', 'layer_order', 'test_included']) });
      expect(stored.status).toBe('review');
      const first = await preview(stored.id);
      expect(first.diff.filter((d) => d.field === 'conflictGroup').map((d) => [d.before, d.after])).toEqual([['pay', 'pay'], ['pay', 'pay']]);
      await ownerPool.query("update tasks set conflict_group='billing' where task_key=$1", [second]);
      const again = await preview(stored.id);
      expect(again.diff.filter((d) => d.field === 'conflictGroup').map((d) => [d.before, d.after])).toEqual([['billing', 'billing'], ['billing', 'billing']]);
      // 분할 판단은 원래 Task의 현재 내용(묶음 포함)으로 계산하므로 다시 판단이 필요하다.
      expect(again.holdReasons.map((r) => r.code)).toEqual(['JUDGEMENT_MISSING', 'JUDGEMENT_MISSING', 'JUDGEMENT_MISSING']);
    } finally { await ownerPool.query('update schedule_policy set cp_auto=true'); }
  });
});
