import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { OPERATIONS } from '@awbs/shared/api';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import { subjectHash, type JudgedSource } from '../src/tasks/hash.ts';

const origin = 'http://127.0.0.1:3100';
const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_tasks';
const ownerPool = createPool(dbUrl.href, { max: 4, onError: () => undefined });
const appUrl = new URL(dbUrl);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { max: 12, onError: () => undefined });
const app = buildApp(pool, process.env.TASKS_DEBUG ? { level: 'error' } : false, { origin, lan: false });

// 응답 모양은 계약(TypeBox → JSON Schema)으로 검사한다. ajv는 shared의 개발 의존성을 빌려 쓴다.
const shared = createRequire(new URL('../../../packages/shared/package.json', import.meta.url));
const { Ajv } = shared('ajv') as { Ajv: new (options: object) => { validate: (schema: unknown, data: unknown) => boolean; errorsText: () => string } };
const ajv = new Ajv({ strict: false });
const op = (id: string) => {
  const found = OPERATIONS.find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
};
function expectShape(id: string, status: number, body: unknown) {
  const ok = ajv.validate(op(id).responses[status], body);
  expect(ok, `${id} ${String(status)}: ${ajv.errorsText()}`).toBe(true);
}

let cookie = '';
let csrf = '';
let projectId = '';
const nodes: Record<string, string> = {};

interface Detail {
  id: string; taskKey: string; wbsPath: string; title: string; lifecycleStatus: string; updatedAt: string; blocked: boolean;
  priority: number; assigneeAgent: string | null; verifierAgent: string | null; deletedAt: string | null; preds: string[];
  spec: { overview: JudgedSource['overview']; spec: Record<string, string[]>; ac: JudgedSource['ac'] };
  outputs: JudgedSource['outputs']; designs: JudgedSource['designs']; conflictGroup: string | null; planningApprovedAt: string | null;
  checklistItems: { itemKey: string; content: string; required: boolean; done: boolean }[];
  predecessors: { id: string; pred: string; succ: string; type: string }[]; successors: { id: string }[];
}

function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { cookie, origin, 'x-csrf-token': csrf, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
}
async function create(body: Record<string, unknown> = {}): Promise<string> {
  const response = await call('POST', `/api/projects/${projectId}/tasks`, { title: '작업', wbsNodeId: nodes.wp1, workType: 'Implementation', primaryDomain: 'BE', ...body });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ taskKey: string }>().taskKey;
}
async function detail(key: string): Promise<Detail> {
  const response = await call('GET', `/api/tasks/${key}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Detail>();
}
const version = async (key: string) => (await detail(key)).updatedAt;
async function setStatus(key: string, status: string) {
  await ownerPool.query('update tasks set status=$2 where task_key=$1', [key, status]);
}
const addDep = async (succ: string, pred: string, depType = 'FS') =>
  call('POST', `/api/tasks/${succ}/dependencies`, { updatedAt: await version(succ), predTaskKey: pred, depType });
async function history(key: string) {
  return (await ownerPool.query<{ kind: string; actor: string; text: string; before: unknown; after: unknown; ref: unknown }>(
    'select h.kind,h.actor,h.text,h.before,h.after,h.ref from task_history h join tasks t on t.id=h.task where t.task_key=$1 order by h.at,h.created_at', [key])).rows;
}
const errorOf = (response: { json: <T>() => T }) => response.json<{ error: { code: string; errors: { path: string }[]; details: Record<string, unknown> } }>().error;

/** 착수 승인에 필요한 명세를 채운다(목적·완료 조건·AC·체크리스트·필수 산출물). */
async function completeSpec(key: string) {
  let response = await call('PATCH', `/api/tasks/${key}/spec`, {
    updatedAt: await version(key),
    overview: { purpose: '목적', background: '', scope: ['범위'], out: [], precond: '', doneCond: '완료 조건' },
    ac: [{ given: 'g', when: 'w', then: 't', method: '통합 테스트' }],
  });
  expect(response.statusCode, response.body).toBe(200);
  response = await call('POST', `/api/tasks/${key}/checklist`, { updatedAt: await version(key), content: '확인', required: true });
  expect(response.statusCode, response.body).toBe(201);
  response = await call('PATCH', `/api/tasks/${key}/outputs`, { updatedAt: await version(key), outputs: [{ name: 'API', kind: '코드', required: true, verify: '테스트', delivered: false }] });
  expect(response.statusCode, response.body).toBe(200);
}
const sourceOf = (d: Detail): JudgedSource => ({
  title: d.title, overview: d.spec.overview, spec: d.spec.spec, ac: d.spec.ac, outputs: d.outputs, designs: d.designs, conflictGroup: d.conflictGroup,
});
async function judge(key: string, items: (readonly [string, 'met' | 'not_met'])[], hash?: string) {
  const d = await detail(key);
  const record = { schemaVersion: 1, items: items.map(([rule, result]) => ({
    rule, result, agreedBy: ['Claude', 'Codex'], basis: '근거', subjectHash: hash ?? subjectHash(sourceOf(d)), judgedAt: '2026-11-26T00:00:00Z', sourceRef: 'planning-job-1',
  })) };
  await ownerPool.query(`insert into task_splits(project_id,task,basis,judged_rules,exceptions) values($1,$2,'',$3,'[]')
    on conflict (task) do update set judged_rules=excluded.judged_rules`, [projectId, d.id, record]);
}
const ALL_MET = [['revert', 'met'], ['contract', 'met'], ['refactor', 'met']] as const;
async function toApproval(key: string) {
  await completeSpec(key);
  const response = await call('POST', `/api/tasks/${key}/request-approval`, { updatedAt: await version(key) });
  expect(response.statusCode, response.body).toBe(200);
}

beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  await runMigrations(ownerPool);
  await seedSystem(ownerPool);
  projectId = (await ownerPool.query<{ id: string }>(
    "insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('테스트','https://github.com/o/r','o','r','','active') returning id")).rows[0]?.id ?? '';
  const node = async (key: string, kind: string, parent: string | null, sort: number) => {
    nodes[key] = (await ownerPool.query<{ id: string }>('insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,$2,$3,$4,$2,$5) returning id',
      [projectId, key, kind, parent, sort])).rows[0]?.id ?? '';
  };
  await node('p1', 'phase', null, 0);
  await node('p2', 'phase', null, 1);
  await node('wp1', 'work_package', nodes.p1 ?? null, 0);
  await node('wp2', 'work_package', nodes.p1 ?? null, 1);
  await node('wp3', 'work_package', nodes.p2 ?? null, 0);
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
  expect(login.statusCode, login.body).toBe(204);
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
});
afterAll(async () => { await app.close(); await pool.end(); await ownerPool.end(); });

describe('tasks 생성·조회', () => {
  test('생성은 표시 ID를 순서대로 주고 계획 중 상태·WBS 번호·명세·체크리스트·이력을 한 번에 저장한다', async () => {
    const body = {
      title: '목록 API', wbsNodeId: nodes.wp2, workType: 'Implementation', primaryDomain: 'BE', relatedDomains: ['API'], priority: 1,
      overview: { purpose: '목적', background: '배경', scope: ['a'], out: [], precond: '', doneCond: '완료' },
      checklist: [{ content: '단위 테스트', required: true, verifyMethod: 'pnpm test' }, { content: '문서', required: false }],
    };
    const response = await call('POST', `/api/projects/${projectId}/tasks`, body, { 'idempotency-key': 'create-1' });
    expect(response.statusCode, response.body).toBe(201);
    expectShape('createTask', 201, response.json());
    const created = response.json<{ id: string; taskKey: string; wbsPath: string; lifecycleStatus: string }>();
    expect(created).toMatchObject({ lifecycleStatus: 'planning', wbsPath: '1.2.1' });
    expect(created.taskKey).toMatch(/^TASK-\d{4}$/);
    const replay = await call('POST', `/api/projects/${projectId}/tasks`, body, { 'idempotency-key': 'create-1' });
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const next = await create({ wbsNodeId: nodes.wp2 });
    expect(Number(next.slice(5))).toBe(Number(created.taskKey.slice(5)) + 1);

    const d = await detail(created.taskKey);
    expectShape('getTask', 200, d);
    expect(d).toMatchObject({ assigneeAgent: 'Claude', verifierAgent: 'Codex', priority: 1, blocked: false, planningApprovedAt: null });
    expect(d.checklistItems.map((item) => [item.itemKey, item.content, item.required, item.done])).toEqual([
      [`CL-${created.taskKey.slice(5)}-1`, '단위 테스트', true, false], [`CL-${created.taskKey.slice(5)}-2`, '문서', false, false],
    ]);
    expect(d.spec.overview.purpose).toBe('목적');
    expect((await history(created.taskKey)).map((h) => [h.kind, h.actor])).toEqual([['생성', '팀장']]);
  });

  test('기본 담당은 Workflow 설정의 개발·검증 Agent를 따른다', async () => {
    await ownerPool.query(`update app_settings set workflow='{"devAgent":"Codex","qaAgent":"Claude"}'`);
    try {
      expect(await detail(await create())).toMatchObject({ assigneeAgent: 'Codex', verifierAgent: 'Claude' });
      expect(await detail(await create({ assigneeAgent: 'Claude', verifierAgent: 'Claude' }))).toMatchObject({ assigneeAgent: 'Claude', verifierAgent: 'Claude' });
    } finally { await ownerPool.query('update app_settings set workflow=null'); }
  });

  test('생성 입력 오류: Phase 부모·없는 노드 404, 없는 프로젝트 404, 주 영역 중복·정의 안 된 필드 400', async () => {
    const body = { title: 't', wbsNodeId: nodes.p1, workType: 'Implementation', primaryDomain: 'BE' };
    expect(errorOf(await call('POST', `/api/projects/${projectId}/tasks`, body)).code).toBe('WBS_NODE_NOT_FOUND');
    expect(errorOf(await call('POST', `/api/projects/${projectId}/tasks`, { ...body, wbsNodeId: crypto.randomUUID() })).code).toBe('WBS_NODE_NOT_FOUND');
    expect(errorOf(await call('POST', `/api/projects/${crypto.randomUUID()}/tasks`, { ...body, wbsNodeId: nodes.wp1 })).code).toBe('PROJECT_NOT_FOUND');
    const dup = await call('POST', `/api/projects/${projectId}/tasks`, { ...body, wbsNodeId: nodes.wp1, relatedDomains: ['BE'] });
    expect(dup.statusCode).toBe(400);
    expect(errorOf(dup).errors.map((e) => e.path)).toEqual(['relatedDomains']);
    const extra = await call('POST', `/api/projects/${projectId}/tasks`, { ...body, wbsNodeId: nodes.wp1, status: 'ready' });
    expect(extra.statusCode).toBe(400);
    expect(errorOf(extra).errors.map((e) => e.path)).toEqual(['status']);
  });

  test('목록은 노드·WBS 번호·차단·선행·체크리스트 수를 계산하고 상태·검색·삭제 포함 필터를 적용한다', async () => {
    const a = await create({ title: '검색-선행', wbsNodeId: nodes.wp3 });
    const b = await create({ title: '검색-후속', wbsNodeId: nodes.wp3, checklist: [{ content: 'c', required: true }] });
    expect((await addDep(b, a)).statusCode).toBe(201);
    await setStatus(a, 'ready');
    const response = await call('GET', `/api/projects/${projectId}/tasks?q=검색-`);
    expect(response.statusCode, response.body).toBe(200);
    expectShape('listTasks', 200, response.json());
    const list = response.json<{ nodes: { id: string; wbsPath: string }[]; tasks: { taskKey: string; wbsPath: string; blocked: boolean; preds: string[]; checklist: object; gate: { total: number } }[] }>();
    expect(list.nodes.find((n) => n.id === nodes.wp3)?.wbsPath).toBe('2.1');
    expect(list.tasks.map((t) => t.taskKey)).toEqual([a, b]);
    expect(list.tasks[1]).toMatchObject({ wbsPath: '2.1.2', blocked: true, preds: [a], checklist: { done: 0, total: 1 }, gate: { total: 5 } });
    const ready = (await call('GET', `/api/projects/${projectId}/tasks?status=ready&q=검색-`)).json<{ tasks: { taskKey: string }[] }>();
    expect(ready.tasks.map((t) => t.taskKey)).toEqual([a]);
    expect(errorOf(await call('GET', `/api/projects/${crypto.randomUUID()}/tasks`)).code).toBe('PROJECT_NOT_FOUND');
  });

  test('없는 Task는 404, 형식이 틀린 표시 ID는 400', async () => {
    expect(errorOf(await call('GET', '/api/tasks/TASK-9999')).code).toBe('TASK_NOT_FOUND');
    expect((await call('GET', '/api/tasks/task-1')).statusCode).toBe(400);
  });

  test('Runner 토큰으로 Task를 바꾸면 403, 로그인 없이는 401', async () => {
    const key = await create();
    const bearer = await issueRunnerToken(pool, 'tasks-runner', 'fake');
    const runner = await app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: { authorization: `Bearer ${bearer}`, 'x-project-epoch': '1' }, payload: { updatedAt: await version(key), title: 'x' } });
    expect(runner.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${key}` })).statusCode).toBe(401);
  });
});

describe('tasks 수정·삭제와 동시 수정', () => {
  test('PATCH는 바뀐 필드만 이력에 남기고 updatedAt을 올린다', async () => {
    const key = await create({ title: '처음' });
    const before = await version(key);
    const response = await call('PATCH', `/api/tasks/${key}`, { updatedAt: before, title: '바꿈', priority: 2, assigneeAgent: 'Claude' });
    expect(response.statusCode, response.body).toBe(200);
    expectShape('updateTask', 200, response.json());
    const changed = response.json<{ task: Detail; changes: { field: string; before: unknown; after: unknown }[] }>();
    expect(changed.changes).toEqual([{ field: 'title', before: '처음', after: '바꿈' }]);
    expect(changed.task.updatedAt > before).toBe(true);
    expect((await history(key)).filter((h) => h.kind === '수정').map((h) => [h.before, h.after, h.ref])).toEqual([['처음', '바꿈', { field: 'title' }]]);
  });

  test('낡은 버전은 409 VERSION_CONFLICT와 그 뒤의 변경 목록, 버전 누락·status·빈 수정은 400', async () => {
    const key = await create({ title: 'v1' });
    const old = await version(key);
    expect((await call('PATCH', `/api/tasks/${key}`, { updatedAt: old, title: 'v2' })).statusCode).toBe(200);
    const stale = await call('PATCH', `/api/tasks/${key}`, { updatedAt: old, title: 'v3' });
    expect(stale.statusCode).toBe(409);
    const error = errorOf(stale);
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(error.details.current).toMatchObject({ taskKey: key, title: 'v2' });
    expect(error.details.changes).toEqual([expect.objectContaining({ actor: '팀장', field: 'title', before: 'v1', after: 'v2', at: expect.any(String) })]);
    expect((await detail(key)).title).toBe('v2');
    expect((await call('PATCH', `/api/tasks/${key}`, { title: 'x' })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/tasks/${key}`, { updatedAt: await version(key), status: 'done' })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/tasks/${key}`, { updatedAt: await version(key), title: 'y', status: 'done' })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/tasks/${key}`, { updatedAt: await version(key) })).statusCode).toBe(400);
  });

  test('이력 시각은 DB 시계가 뒤로 가도 같은 Task의 현재 버전보다 늦다', async () => {
    // 시계가 뒤로 간 상황: 버전(updated_at)이 지금보다 1시간 뒤인 Task를 직접 넣는다.
    const key = 'TASK-8001';
    await ownerPool.query(`insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,
      assignee_agent,verifier_agent,status,verif_state,updated_at) values($1,$2,$3,99,'미래','Implementation','BE','{}',2,'Claude','Codex','planning','none',now()+interval '1 hour')`,
    [projectId, key, nodes.wp2]);
    await ownerPool.query(`insert into task_specs(project_id,task,overview,spec,ac,revision) select project_id,id,'{}','{}','[]',1 from tasks where task_key=$1`, [key]);
    const future = await version(key);
    const response = await call('PATCH', `/api/tasks/${key}`, { updatedAt: future, title: '다음' });
    expect(response.statusCode, response.body).toBe(200);
    const at = (await ownerPool.query<{ ok: boolean }>(
      `select h.at>$2::timestamptz as ok from task_history h join tasks t on t.id=h.task where t.task_key=$1`, [key, future])).rows;
    expect(at).toEqual([{ ok: true }]);
    // 그 버전 이후의 충돌 목록에는 그 뒤의 변경만 있고, 그 버전을 만든 자기 변경은 없다.
    const seen = response.json<{ task: Detail }>().task.updatedAt;
    expect((await call('PATCH', `/api/tasks/${key}`, { updatedAt: seen, title: '그다음' })).statusCode).toBe(200);
    const stale = await call('PATCH', `/api/tasks/${key}`, { updatedAt: future, title: '낡음' });
    expect((errorOf(stale).details.changes as { after: unknown }[]).map((c) => c.after)).toEqual(['다음', '그다음']);
    const stale2 = await call('PATCH', `/api/tasks/${key}`, { updatedAt: seen, title: '낡음' });
    expect((errorOf(stale2).details.changes as { after: unknown }[]).map((c) => c.after)).toEqual(['그다음']);
  });

  test('같은 버전으로 동시에 고치면 하나만 성공한다', async () => {
    for (let round = 0; round < 5; round++) {
      const key = await create();
      const v = await version(key);
      const results = await Promise.all(['a', 'b', 'c'].map((title) => call('PATCH', `/api/tasks/${key}`, { updatedAt: v, title })));
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
      expect((await history(key)).filter((h) => h.kind === '수정')).toHaveLength(1);
    }
  });

  test('삭제는 soft delete이고 후속이 있으면 409, 낡은 버전 409, 버전 누락 400', async () => {
    const pred = await create();
    const succ = await create();
    expect((await addDep(succ, pred)).statusCode).toBe(201);
    expect(errorOf(await call('DELETE', `/api/tasks/${pred}?updatedAt=${encodeURIComponent(await version(pred))}`)).code).toBe('TASK_HAS_SUCCESSORS');
    const old = await version(succ);
    await call('PATCH', `/api/tasks/${succ}`, { updatedAt: old, title: '변경' });
    expect(errorOf(await call('DELETE', `/api/tasks/${succ}?updatedAt=${encodeURIComponent(old)}`)).code).toBe('VERSION_CONFLICT');
    expect((await call('DELETE', `/api/tasks/${succ}`)).statusCode).toBe(400);
    const deleted = await call('DELETE', `/api/tasks/${succ}?updatedAt=${encodeURIComponent(await version(succ))}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    const gone = await detail(succ);
    expect(gone.deletedAt).not.toBeNull();
    // 지운 Task의 선행 관계는 함께 정리되어 선행 Task를 지울 수 있다.
    expect(gone.predecessors).toEqual([]);
    expect((await history(succ)).map((h) => h.kind)).toEqual(expect.arrayContaining(['선행 관계', '삭제']));
    expect((await call('DELETE', `/api/tasks/${pred}?updatedAt=${encodeURIComponent(await version(pred))}`)).statusCode).toBe(204);
    const list = (await call('GET', `/api/projects/${projectId}/tasks`)).json<{ tasks: { taskKey: string }[] }>();
    expect(list.tasks.some((t) => t.taskKey === succ)).toBe(false);
    const all = (await call('GET', `/api/projects/${projectId}/tasks?includeDeleted=true`)).json<{ tasks: { taskKey: string; wbsPath: string }[] }>();
    expect(all.tasks.find((t) => t.taskKey === succ)?.wbsPath).toBe('');
    expect(errorOf(await call('PATCH', `/api/tasks/${succ}`, { updatedAt: gone.updatedAt, title: 'x' })).code).toBe('TASK_NOT_FOUND');
  });

  test('삭제와 의존성 추가가 겹쳐도 후속이 있는 Task는 지워지지 않는다', async () => {
    for (let round = 0; round < 5; round++) {
      const pred = await create();
      const succ = await create();
      const [added, removed] = await Promise.all([addDep(succ, pred), version(pred).then((v) => call('DELETE', `/api/tasks/${pred}?updatedAt=${encodeURIComponent(v)}`))]);
      const succDetail = await detail(succ);
      const predDetail = await detail(pred);
      if (removed.statusCode === 204) {
        expect(added.statusCode).toBe(404);
        expect(succDetail.predecessors).toEqual([]);
      } else {
        expect(errorOf(removed).code).toBe('TASK_HAS_SUCCESSORS');
        expect(added.statusCode).toBe(201);
        expect(predDetail.deletedAt).toBeNull();
      }
    }
  });
});

describe('tasks 의존성', () => {
  test('선행 추가는 후속 버전을 비교하고 차단 여부·이력·updatedAt을 남긴다', async () => {
    const pred = await create();
    const succ = await create();
    const before = await version(succ);
    const response = await addDep(succ, pred, 'SS');
    expect(response.statusCode, response.body).toBe(201);
    expectShape('addDependency', 201, response.json());
    const body = response.json<{ dependency: { id: string; pred: string; succ: string; type: string }; blocked: boolean }>();
    expect(body).toMatchObject({ dependency: { pred, succ, type: 'SS' }, blocked: true });
    expect((await version(succ)) > before).toBe(true);
    expect((await history(succ)).map((h) => [h.kind, h.actor])).toEqual([['생성', '팀장'], ['선행 관계', '팀장'], ['차단', '시스템']]);
    const d = await detail(succ);
    expect(d.predecessors).toEqual([body.dependency]);
    expect((await detail(pred)).successors.map((s) => s.id)).toEqual([body.dependency.id]);
    await setStatus(pred, 'running');
    expect((await detail(succ)).blocked).toBe(false);
  });

  test('자기 참조 400, 중복·순환·취소 선행 409, 낡은 후속 버전 409, 없는 선행 404', async () => {
    const a = await create();
    const b = await create();
    const c = await create();
    expect(errorOf(await addDep(a, a)).code).toBe('DEPENDENCY_SELF');
    expect((await addDep(b, a)).statusCode).toBe(201);
    expect(errorOf(await addDep(b, a)).code).toBe('DEPENDENCY_DUPLICATE');
    expect((await addDep(c, b)).statusCode).toBe(201);
    const cycle = errorOf(await addDep(a, c));
    expect(cycle.code).toBe('DEPENDENCY_CYCLE');
    // 경로는 선행 → 후속 방향: a → b → c → (추가하려던) a
    expect(cycle.details.path).toEqual([a, b, c, a]);
    const cancelled = await create();
    await setStatus(cancelled, 'cancelled');
    expect(errorOf(await addDep(a, cancelled)).code).toBe('INVALID_TRANSITION');
    const old = await version(c);
    await call('PATCH', `/api/tasks/${c}`, { updatedAt: old, title: '변경' });
    expect(errorOf(await call('POST', `/api/tasks/${c}/dependencies`, { updatedAt: old, predTaskKey: a, depType: 'FS' })).code).toBe('VERSION_CONFLICT');
    expect(errorOf(await addDep(a, 'TASK-9999')).code).toBe('TASK_NOT_FOUND');
    expect((await history(a)).filter((h) => h.kind === '선행 관계')).toHaveLength(0);
  });

  test('동시에 반대 방향 관계를 추가하면 하나만 저장되고 그래프는 순환이 없다(이력 포함)', async () => {
    for (let round = 0; round < 8; round++) {
      const a = await create();
      const b = await create();
      const [va, vb] = await Promise.all([version(a), version(b)]);
      const results = await Promise.all([
        call('POST', `/api/tasks/${b}/dependencies`, { updatedAt: vb, predTaskKey: a, depType: 'FS' }),
        call('POST', `/api/tasks/${a}/dependencies`, { updatedAt: va, predTaskKey: b, depType: 'FS' }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(results.map((r) => r.statusCode === 409 ? errorOf(r).code : 'ok').sort()).toEqual(['DEPENDENCY_CYCLE', 'ok']);
      const edges = [...(await detail(a)).predecessors, ...(await detail(b)).predecessors];
      expect(edges).toHaveLength(1);
      const kinds = [...await history(a), ...await history(b)].filter((h) => h.kind === '선행 관계');
      expect(kinds).toHaveLength(1);
    }
    // 세 Task 순환: A→B가 있을 때 B→C와 C→A를 동시에
    for (let round = 0; round < 5; round++) {
      const [a, b, c] = [await create(), await create(), await create()];
      expect((await addDep(b, a)).statusCode).toBe(201);
      const [vc, va] = await Promise.all([version(c), version(a)]);
      const results = await Promise.all([
        call('POST', `/api/tasks/${c}/dependencies`, { updatedAt: vc, predTaskKey: b, depType: 'SS' }),
        call('POST', `/api/tasks/${a}/dependencies`, { updatedAt: va, predTaskKey: c, depType: 'FS' }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    }
  });

  test('겹치는 Task가 없는 두 관계가 동시에 4개짜리 순환을 만들면 하나만 저장한다', async () => {
    // A→B, C→D가 있을 때 B→C와 D→A는 서로 다른 Task 행을 잠그므로 행 잠금만으로는 막히지 않는다.
    for (let round = 0; round < 8; round++) {
      const [a, b, c, d] = [await create(), await create(), await create(), await create()];
      expect((await addDep(b, a)).statusCode).toBe(201);
      expect((await addDep(d, c)).statusCode).toBe(201);
      const [vc, va] = await Promise.all([version(c), version(a)]);
      const results = await Promise.all([
        call('POST', `/api/tasks/${c}/dependencies`, { updatedAt: vc, predTaskKey: b, depType: 'FS' }),
        call('POST', `/api/tasks/${a}/dependencies`, { updatedAt: va, predTaskKey: d, depType: 'FS' }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    }
  });

  test('선행 삭제는 후속 버전을 비교하고 이력을 남긴다. 없는 관계 404', async () => {
    const pred = await create();
    const succ = await create();
    const { dependency } = (await addDep(succ, pred)).json<{ dependency: { id: string } }>();
    const old = await version(succ);
    await call('PATCH', `/api/tasks/${succ}`, { updatedAt: old, title: '바꿈' });
    expect(errorOf(await call('DELETE', `/api/dependencies/${dependency.id}?updatedAt=${encodeURIComponent(old)}`)).code).toBe('VERSION_CONFLICT');
    expect((await call('DELETE', `/api/dependencies/${dependency.id}`)).statusCode).toBe(400);
    const v = await version(succ);
    const removed = await call('DELETE', `/api/dependencies/${dependency.id}?updatedAt=${encodeURIComponent(v)}`);
    expect(removed.statusCode, removed.body).toBe(204);
    const d = await detail(succ);
    expect(d.predecessors).toEqual([]);
    expect(d.blocked).toBe(false);
    expect(d.updatedAt > v).toBe(true);
    expect((await history(succ)).filter((h) => h.kind === '선행 관계').map((h) => h.after)).toEqual([`${pred} (FS)`, null]);
    expect(errorOf(await call('DELETE', `/api/dependencies/${dependency.id}?updatedAt=${encodeURIComponent(d.updatedAt)}`)).code).toBe('DEPENDENCY_NOT_FOUND');
    expect(errorOf(await call('DELETE', `/api/dependencies/not-a-uuid?updatedAt=${encodeURIComponent(d.updatedAt)}`)).code).toBe('DEPENDENCY_NOT_FOUND');
  });

  test('D-35: 진행 중 Task를 새로 차단하는 선행 추가는 409이고 아무것도 저장하지 않는다', async () => {
    for (const status of ['running', 'qa', 'verifying']) {
      const succ = await create();
      const unmet = await create();
      await setStatus(succ, status);
      const blocked = await addDep(succ, unmet);
      expect(errorOf(blocked).code, status).toBe('ACTIVE_TASK_BLOCKED');
      expect((await detail(succ)).predecessors).toEqual([]);
      expect((await history(succ)).filter((h) => h.kind === '선행 관계')).toHaveLength(0);
      // 이미 충족된 선행(완료 FS·시작된 SS)은 차단하지 않으므로 허용한다.
      const done = await create();
      await setStatus(done, 'done');
      expect((await addDep(succ, done)).json()).toMatchObject({ blocked: false });
      const started = await create();
      await setStatus(started, 'running');
      expect((await addDep(succ, started, 'SS')).statusCode).toBe(201);
    }
    // 변경 전에 이미 차단된 진행 Task, 진행 중이 아닌 Task는 새 차단이 아니므로 허용한다.
    const already = await create();
    const first = await create();
    expect((await addDep(already, first)).statusCode).toBe(201);
    await setStatus(already, 'running');
    expect((await addDep(already, await create())).json()).toMatchObject({ blocked: true });
    for (const status of ['ready', 'rework', 'paused', 'gate']) {
      const succ = await create();
      await setStatus(succ, status);
      expect((await addDep(succ, await create())).statusCode, status).toBe(201);
    }
  });
});

describe('tasks 명세·설계·체크리스트·산출물', () => {
  test('명세 수정은 revision과 Task 버전을 올리고 이력을 남긴다', async () => {
    const key = await create();
    const before = await detail(key);
    const revision = async () => (await ownerPool.query<{ revision: number }>('select s.revision from task_specs s join tasks t on t.id=s.task where t.task_key=$1', [key])).rows[0]?.revision;
    expect(await revision()).toBe(1);
    const response = await call('PATCH', `/api/tasks/${key}/spec`, { updatedAt: before.updatedAt, spec: { req: ['요구'], work: [], steps: [], inputs: [], outputs: [], files: ['a.ts'], constraints: [], errors: [], docs: [], verify: [] } });
    expect(response.statusCode, response.body).toBe(200);
    expectShape('updateTaskSpec', 200, response.json());
    const changed = response.json<{ task: Detail; changes: { field: string }[] }>();
    expect(changed.task.spec.spec.files).toEqual(['a.ts']);
    expect(changed.changes.map((c) => c.field)).toEqual(['spec']);
    expect(changed.task.updatedAt > before.updatedAt).toBe(true);
    expect(await revision()).toBe(2);
    expect((await history(key)).at(-1)?.kind).toBe('명세 수정');
    expect(errorOf(await call('PATCH', `/api/tasks/${key}/spec`, { updatedAt: before.updatedAt, ac: [] })).code).toBe('VERSION_CONFLICT');
    expect((await call('PATCH', `/api/tasks/${key}/spec`, { updatedAt: changed.task.updatedAt, overview: { purpose: 'p' } })).statusCode).toBe(400);
  });

  test('설계는 종류별로 저장·교체하고 Task 버전을 올린다', async () => {
    const key = await create();
    let response = await call('PATCH', `/api/tasks/${key}/design/API`, { updatedAt: await version(key), content: { ents: [{ method: 'GET' }] } });
    expect(response.statusCode, response.body).toBe(200);
    expectShape('updateTaskDesign', 200, response.json());
    response = await call('PATCH', `/api/tasks/${key}/design/API`, { updatedAt: await version(key), content: { ents: [] } });
    expect(response.json<{ task: Detail }>().task.designs).toEqual([{ kind: 'API', content: { ents: [] } }]);
    expect((await call('PATCH', `/api/tasks/${key}/design/XX`, { updatedAt: await version(key), content: {} })).statusCode).toBe(400);
    expect((await history(key)).filter((h) => h.kind === '설계 수정')).toHaveLength(2);
  });

  test('체크리스트 추가·수정·삭제는 번호를 재사용하지 않고 각 단계가 버전을 비교한다', async () => {
    const key = await create();
    const added = await call('POST', `/api/tasks/${key}/checklist`, { updatedAt: await version(key), content: '항목1', required: true, verifyMethod: 'test' });
    expect(added.statusCode, added.body).toBe(201);
    expectShape('addChecklistItem', 201, added.json());
    const first = added.json<{ task: Detail }>().task.checklistItems[0]?.itemKey ?? '';
    const patched = await call('PATCH', `/api/tasks/${key}/checklist/${first}`, { updatedAt: await version(key), done: true, note: '완료' });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<{ task: Detail; changes: { field: string; before: unknown; after: unknown }[] }>().changes)
      .toEqual([{ field: `checklist.${first}.done`, before: false, after: true }, { field: `checklist.${first}.note`, before: null, after: '완료' }]);
    const v = await version(key);
    expect((await call('DELETE', `/api/tasks/${key}/checklist/${first}?updatedAt=${encodeURIComponent(v)}`)).statusCode).toBe(204);
    expect(errorOf(await call('DELETE', `/api/tasks/${key}/checklist/${first}?updatedAt=${encodeURIComponent(await version(key))}`)).code).toBe('NOT_FOUND');
    expect(errorOf(await call('PATCH', `/api/tasks/${key}/checklist/${first}`, { updatedAt: v, done: false })).code).toBe('VERSION_CONFLICT');
    const again = (await call('POST', `/api/tasks/${key}/checklist`, { updatedAt: await version(key), content: '항목2', required: false })).json<{ task: Detail }>();
    expect(again.task.checklistItems.map((item) => item.itemKey)).toEqual([`CL-${key.slice(5)}-2`]);
    expect((await history(key)).filter((h) => h.kind === '체크리스트').map((h) => h.text)).toHaveLength(4);
  });

  test('산출물은 목록 전체를 교체하고 같은 이름은 400', async () => {
    const key = await create();
    const outputs = [{ name: 'A', kind: '코드', required: true, verify: 'v', delivered: false }, { name: 'B', kind: '문서', required: false, verify: '', delivered: false }];
    const response = await call('PATCH', `/api/tasks/${key}/outputs`, { updatedAt: await version(key), outputs });
    expect(response.statusCode, response.body).toBe(200);
    expectShape('updateTaskOutputs', 200, response.json());
    const replaced = await call('PATCH', `/api/tasks/${key}/outputs`, { updatedAt: await version(key), outputs: [outputs[1]] });
    expect(replaced.json<{ task: Detail }>().task.outputs.map((o) => o.name)).toEqual(['B']);
    const dup = await call('PATCH', `/api/tasks/${key}/outputs`, { updatedAt: await version(key), outputs: [outputs[0], outputs[0]] });
    expect(dup.statusCode).toBe(400);
    expect(errorOf(dup).errors.map((e) => e.path)).toEqual(['outputs.1.name']);
  });
});

describe('tasks 착수 승인 요청→승인/반려', () => {
  test('필수 항목이 모자라면 400 errors[], 채우면 approval로 바꾸고 이력을 남긴다', async () => {
    const key = await create();
    const missing = await call('POST', `/api/tasks/${key}/request-approval`, { updatedAt: await version(key) });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing).code).toBe('VALIDATION_FAILED');
    expect(errorOf(missing).errors.map((e) => e.path)).toEqual(['overview.purpose', 'overview.doneCond', 'ac', 'checklist', 'outputs']);
    expect((await detail(key)).lifecycleStatus).toBe('planning');
    await completeSpec(key);
    const response = await call('POST', `/api/tasks/${key}/request-approval`, { updatedAt: await version(key), comment: '검토 부탁' });
    expect(response.statusCode, response.body).toBe(200);
    expectShape('requestTaskApproval', 200, response.json());
    const changed = response.json<{ task: Detail; changes: unknown[] }>();
    expect(changed.task.lifecycleStatus).toBe('approval');
    expect(changed.changes).toEqual([{ field: 'lifecycleStatus', before: 'planning', after: 'approval' }]);
    const last = (await history(key)).at(-1);
    expect(last).toMatchObject({ kind: '승인 요청', before: 'planning', after: 'approval' });
    expect(last?.text).toContain('검토 부탁');
  });

  test('다른 상태 409 INVALID_TRANSITION, 낡은 버전 409, 없는 Task 404', async () => {
    const key = await create();
    await completeSpec(key);
    await setStatus(key, 'ready');
    expect(errorOf(await call('POST', `/api/tasks/${key}/request-approval`, { updatedAt: await version(key) })).code).toBe('INVALID_TRANSITION');
    const other = await create();
    await completeSpec(other);
    const old = await version(other);
    await call('PATCH', `/api/tasks/${other}`, { updatedAt: old, priority: 0 });
    expect(errorOf(await call('POST', `/api/tasks/${other}/request-approval`, { updatedAt: old })).code).toBe('VERSION_CONFLICT');
    expect(errorOf(await call('POST', '/api/tasks/TASK-9999/request-approval', { updatedAt: old })).code).toBe('TASK_NOT_FOUND');
  });

  test('중복 요청: 동시에 보내면 하나만 바꾸고, 같은 멱등 키 재전송은 저장된 응답을 재생한다', async () => {
    const key = await create();
    await completeSpec(key);
    const v = await version(key);
    const results = await Promise.all([1, 2, 3].map(() => call('POST', `/api/tasks/${key}/request-approval`, { updatedAt: v })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect((await history(key)).filter((h) => h.kind === '승인 요청')).toHaveLength(1);
    const again = await call('POST', `/api/tasks/${key}/request-approval`, { updatedAt: await version(key) });
    expect(errorOf(again).code).toBe('INVALID_TRANSITION');

    const keyed = await create();
    await completeSpec(keyed);
    const body = { updatedAt: await version(keyed) };
    const first = await call('POST', `/api/tasks/${keyed}/request-approval`, body, { 'idempotency-key': `req-${keyed}` });
    const replay = await call('POST', `/api/tasks/${keyed}/request-approval`, body, { 'idempotency-key': `req-${keyed}` });
    expect(first.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toBe(first.body);
    expect((await history(keyed)).filter((h) => h.kind === '승인 요청')).toHaveLength(1);
  });

  test('승인은 approval에서만, 필수 항목을 다시 검사하고 낡은 버전은 409', async () => {
    const key = await create();
    await completeSpec(key);
    await judge(key, [...ALL_MET]);
    expect(errorOf(await call('POST', `/api/tasks/${key}/approve`, { updatedAt: await version(key) })).code).toBe('INVALID_TRANSITION');
    const request = await call('POST', `/api/tasks/${key}/request-approval`, { updatedAt: await version(key) });
    expect(request.statusCode).toBe(200);
    // 승인 대기 중에 체크리스트를 지우면 승인이 필수 항목 검사에서 멈춘다.
    const item = (await detail(key)).checklistItems[0]?.itemKey ?? '';
    await call('DELETE', `/api/tasks/${key}/checklist/${item}?updatedAt=${encodeURIComponent(await version(key))}`);
    const missing = await call('POST', `/api/tasks/${key}/approve`, { updatedAt: await version(key) });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing).errors.map((e) => e.path)).toEqual(['checklist']);
    await call('POST', `/api/tasks/${key}/checklist`, { updatedAt: await version(key), content: '다시', required: true });
    const old = await version(key);
    await call('PATCH', `/api/tasks/${key}`, { updatedAt: old, priority: 3 });
    expect(errorOf(await call('POST', `/api/tasks/${key}/approve`, { updatedAt: old })).code).toBe('VERSION_CONFLICT');
    const approved = await call('POST', `/api/tasks/${key}/approve`, { updatedAt: await version(key), comment: '좋음' });
    expect(approved.statusCode, approved.body).toBe(200);
    expectShape('approveTask', 200, approved.json());
    const task = approved.json<{ task: Detail }>().task;
    expect(task.lifecycleStatus).toBe('ready');
    expect(task.planningApprovedAt).not.toBeNull();
    expect((await history(key)).at(-1)).toMatchObject({ kind: '승인', before: 'approval', after: 'ready' });
    expect(errorOf(await call('POST', `/api/tasks/${key}/approve`, { updatedAt: task.updatedAt })).code).toBe('INVALID_TRANSITION');
  });

  test('반려는 approval → planning, 필수 항목은 다시 보지 않고 다른 상태는 409', async () => {
    const key = await create();
    expect(errorOf(await call('POST', `/api/tasks/${key}/reject`, { updatedAt: await version(key) })).code).toBe('INVALID_TRANSITION');
    await toApproval(key);
    await ownerPool.query("update task_specs set overview=jsonb_set(overview,'{purpose}','\"\"') where task=(select id from tasks where task_key=$1)", [key]);
    const rejected = await call('POST', `/api/tasks/${key}/reject`, { updatedAt: await version(key), comment: '범위 보완' });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expectShape('rejectTask', 200, rejected.json());
    expect(rejected.json<{ task: Detail }>().task).toMatchObject({ lifecycleStatus: 'planning', planningApprovedAt: null });
    expect((await history(key)).at(-1)).toMatchObject({ kind: '반려', before: 'approval', after: 'planning' });
  });

  test('D-33: 규칙 5·7·9 판단이 유효한 충족이 아니면 착수 승인을 보류한다(409 SPLIT_JUDGEMENT_REQUIRED)', async () => {
    const key = await create();
    await toApproval(key);
    const items = async () => {
      const response = await call('POST', `/api/tasks/${key}/approve`, { updatedAt: await version(key) });
      expect(response.statusCode, response.body).toBe(409);
      expect(errorOf(response).code).toBe('SPLIT_JUDGEMENT_REQUIRED');
      return errorOf(response).details.items as { rule: string; reason: string }[];
    };
    // 기록 없음
    expect((await items()).map((i) => [i.rule, i.reason])).toEqual([['revert', 'JUDGEMENT_MISSING'], ['contract', 'JUDGEMENT_MISSING'], ['refactor', 'JUDGEMENT_MISSING']]);
    // 불충족 1건
    await judge(key, [['revert', 'met'], ['contract', 'not_met'], ['refactor', 'met']]);
    expect((await items()).map((i) => [i.rule, i.reason])).toEqual([['contract', 'JUDGEMENT_NOT_MET']]);
    // 판단 뒤 완료 조건이 바뀌면 hash가 달라 기록 없음
    await judge(key, [...ALL_MET]);
    await call('PATCH', `/api/tasks/${key}/spec`, { updatedAt: await version(key), overview: { purpose: '목적', background: '', scope: ['범위'], out: [], precond: '', doneCond: '바뀐 완료 조건' } });
    expect((await items()).map((i) => i.reason)).toEqual(['JUDGEMENT_MISSING', 'JUDGEMENT_MISSING', 'JUDGEMENT_MISSING']);
    // 목적만 바꾼 것은 판단 대상이 아니다
    await judge(key, [...ALL_MET]);
    await call('PATCH', `/api/tasks/${key}/spec`, { updatedAt: await version(key), overview: { purpose: '다른 목적', background: '', scope: ['범위'], out: [], precond: '', doneCond: '바뀐 완료 조건' } });
    // 설정에서 끈 규칙은 제외한다
    await judge(key, [['revert', 'met'], ['contract', 'met']]);
    expect((await items()).map((i) => i.rule)).toEqual(['refactor']);
    await ownerPool.query(`update app_settings set split=jsonb_set(split,'{on,refactor}','false')`);
    try {
      const approved = await call('POST', `/api/tasks/${key}/approve`, { updatedAt: await version(key) });
      expect(approved.statusCode, approved.body).toBe(200);
      expect((await detail(key)).lifecycleStatus).toBe('ready');
    } finally { await ownerPool.query(`update app_settings set split=jsonb_set(split,'{on,refactor}','true')`); }
  });

  test('D-33: 낡은 hash인 판단은 규칙별로 기록 없음으로 본다', async () => {
    const key = await create();
    await toApproval(key);
    await judge(key, [...ALL_MET], 'a'.repeat(64));
    const stale = await call('POST', `/api/tasks/${key}/approve`, { updatedAt: await version(key) });
    expect(errorOf(stale).code).toBe('SPLIT_JUDGEMENT_REQUIRED');
    const d = await detail(key);
    await ownerPool.query(`update task_splits set judged_rules=jsonb_set(judged_rules,'{items,0,subjectHash}',to_jsonb($2::text)) where task=$1`, [d.id, subjectHash(sourceOf(d))]);
    await ownerPool.query(`update task_splits set judged_rules=jsonb_set(judged_rules,'{items,1,subjectHash}',to_jsonb($2::text)) where task=$1`, [d.id, subjectHash(sourceOf(d))]);
    const partial = errorOf(await call('POST', `/api/tasks/${key}/approve`, { updatedAt: await version(key) }));
    expect((partial.details.items as { rule: string }[]).map((i) => i.rule)).toEqual(['refactor']);
  });
});
