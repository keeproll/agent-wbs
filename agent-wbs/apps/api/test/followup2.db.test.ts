import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import { installRunner } from '../src/runner/routes.ts';
import { installProjectRunner } from '../src/project/runner-routes.ts';
import { OPERATIONS } from '@awbs/shared/api';
import { createRequire } from 'node:module';
import { wbsSnapshot } from '../src/planning/job-snapshot.ts';

const shared = createRequire(new URL('../../../packages/shared/package.json', import.meta.url));
const { Ajv } = shared('ajv') as { Ajv: new (options: object) => { validate: (schema: unknown, data: unknown) => boolean; errorsText: () => string } };
const ajv = new Ajv({ strict: false });

const db = new URL(inject('testDatabaseUrl'));
db.pathname += '_followup2';
const owner = createPool(db.href, { max: 4, onError: () => undefined });
const appDb = new URL(db);
appDb.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appDb.href, { max: 8, onError: () => undefined });
const origin = 'http://127.0.0.1:3100';
const app = buildApp(pool, false, { origin, lan: false });
installRunner(app, pool);
installProjectRunner(app, pool);
let cookie = '', csrf = '', bearer = '', projectId = '', wp = '';
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, key?: string) => app.inject({
  method, url, headers: { cookie, origin, 'x-csrf-token': csrf, ...(key && { 'idempotency-key': key }) }, ...(payload && { payload }),
});
const runner = (url: string, payload: object) => app.inject({ method: 'POST', url, payload,
  headers: { authorization: `Bearer ${bearer}`, 'x-project-epoch': '1', 'idempotency-key': randomUUID() } });
interface Project { name: string; description: string; startDate: string; targetDate: string | null; updatedAt: string; inputCheckedAt: string | null }
const project = async () => (await call('GET', '/api/project')).json<Project>();
interface Proposal { id: string; cpKey: string; status: string; title: string; updatedAt: string; ops: object[]; events: { action: string; comment: string }[] }
const proposalBody = () => ({ title: '제안', reason: '필요', source: { kind: 'manual' }, ops: [
  { op: 'modify', task: 'TASK-0001', field: 'priority', after: 1 },
  { op: 'modify', task: 'TASK-0001', field: 'title', after: '수정' },
] });
const create = async () => {
  const r = await call('POST', '/api/proposals', proposalBody());
  expect(r.statusCode, r.body).toBe(201);
  return r.json<Proposal>();
};

beforeAll(async () => {
  await recreateTestDatabase(db.href);
  await runMigrations(owner);
  await seedSystem(owner);
  projectId = (await owner.query<{ id: string }>(`insert into projects(name,repo_url,repo_owner,repo_name,base_commit,lead_instruction,phase)
    values('원래 이름','https://github.com/a/b','a','b',$1,'','active') returning id`, ['a'.repeat(40)])).rows[0]?.id ?? '';
  await owner.query("insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,1,$2,'{}','[]','[]','')", [projectId, 'a'.repeat(40)]);
  const ph = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'p','phase','단계',0) returning id", [projectId])).rows[0]?.id;
  wp = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'wp','work_package',$2,'묶음',0) returning id", [projectId, ph])).rows[0]?.id ?? '';
  await owner.query("insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state) values($1,'TASK-0001',$2,0,'작업','Implementation','BE','{}',2,'Claude','Codex','ready','none')", [projectId, wp]);
  await owner.query("insert into task_estimates(project_id,task,est,lo,hi,confidence,basis,agreed_by) select $1,id,2,1,3,'상','근거','Claude,Codex' from tasks", [projectId]);
  await owner.query("update schedule_policy set auto_replan=true,threshold_days=1");
  await owner.query("insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at) values('followup2-host','boot','cpu',8,32,0,500,'linux',1,now())");
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token } });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await call('GET', '/api/session')).json<{ csrfToken: string }>().csrfToken;
  bearer = await issueRunnerToken(pool, 'followup2', 'test-key');
});
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

test('프로젝트 편집: 날짜 검증·버전 충돌·전후 이력·기준 v1 보존·시작일 반영', async () => {
  const initial = await project();
  expect(initial).toMatchObject({ description: '', inputCheckedAt: null });
  expect(initial.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const first = await call('POST', '/api/replans/run');
  expect(first.statusCode, first.body).toBe(201);
  const v1 = (await owner.query('select * from schedule_baselines where v=1')).rows;
  const next = { updatedAt: initial.updatedAt, name: '새 이름', description: '설명', startDate: '2030-01-10', targetDate: '2030-01-01' };
  // 목표일이 시작일보다 빠른 것은 여유일 음수로 표시한다. 원본에 없는 날짜 순서 제한은 더하지 않는다.
  for (const bad of [{ name: ' ' }, { startDate: '2030-02-30' }, { startDate: '' }, { targetDate: '2030-13-01' }, { status: 'done' }]) {
    const r = await call('PATCH', '/api/project', { ...next, ...bad });
    expect(r.statusCode, r.body).toBe(400);
  }
  const saved = await call('PATCH', '/api/project', next);
  expect(saved.statusCode, saved.body).toBe(200);
  expect(await project()).toMatchObject({ name: next.name, description: next.description, startDate: next.startDate, targetDate: next.targetDate });
  expect((await call('PATCH', '/api/project', next)).statusCode).toBe(409);
  const history = (await call('GET', '/api/history?kind=프로젝트 수정')).json<{ items: { actor: string; before: string; after: string }[] }>().items;
  expect(history).toHaveLength(1);
  expect(history[0]?.actor).toBe('팀장');
  expect(JSON.parse(history[0]?.before ?? '{}')).toMatchObject({ name: initial.name, startDate: initial.startDate });
  expect(JSON.parse(history[0]?.after ?? '{}')).toMatchObject({ name: next.name, startDate: next.startDate });
  expect((await owner.query('select * from schedule_baselines where v=1')).rows).toEqual(v1);
  expect((await owner.query('select max(v) v from schedule_baselines')).rows[0]).toMatchObject({ v: 2 });
  const schedule = (await call('GET', '/api/schedule')).json<{ project: { start: string }; tasks: { start: string }[] }>();
  expect(schedule.project.start).toBe(next.startDate);
  expect(schedule.tasks[0]?.start).toBe(next.startDate);
  // 설명만 바꾸면 일정 기준을 추가하지 않는다.
  const current = await project();
  expect((await call('PATCH', '/api/project', { ...next, updatedAt: current.updatedAt, description: '설명만 변경' })).statusCode).toBe(200);
  expect((await owner.query('select max(v) v from schedule_baselines')).rows[0]).toMatchObject({ v: 2 });
  await owner.query('update schedule_policy set auto_replan=false');
  const pending = await call('PATCH', '/api/project', { ...next, updatedAt: (await project()).updatedAt, startDate: '2040-01-10' });
  expect(pending.statusCode, pending.body).toBe(200);
  expect((await owner.query('select max(v) v from schedule_baselines')).rows[0]).toMatchObject({ v: 2 });
  expect((await owner.query('select status from replans order by created_at desc,id desc limit 1')).rows[0]).toMatchObject({ status: 'pending' });
  const stable = await project();
  await owner.query("create function fail_followup_replan() returns trigger language plpgsql as 'begin raise exception ''재조정 기록 실패''; end'");
  await owner.query('create trigger fail_followup_replan before insert on replans for each row execute function fail_followup_replan()');
  try {
    expect((await call('PATCH', '/api/project', { ...next, updatedAt: stable.updatedAt, startDate: '2050-01-10' })).statusCode).toBe(500);
    expect(await project()).toMatchObject({ updatedAt: stable.updatedAt, startDate: stable.startDate });
  } finally {
    await owner.query('drop trigger fail_followup_replan on replans');
    await owner.query('drop function fail_followup_replan()');
    await owner.query('update schedule_policy set auto_replan=true');
  }
});

test('지금 확인은 요청만 접수하고, 실제 Runner 관측이 확인 시각을 갱신한다', async () => {
  const before = await project();
  const key = randomUUID();
  const requested = await call('POST', '/api/project/inputs/check', { updatedAt: before.updatedAt }, key);
  expect(requested.statusCode, requested.body).toBe(202);
  expect((await call('POST', '/api/project/inputs/check', { updatedAt: before.updatedAt }, key)).headers['idempotency-replayed']).toBe('true');
  expect((await project()).inputCheckedAt).toBe(before.inputCheckedAt);
  const policy = await app.inject({ url: '/api/runner/policy', headers: { authorization: `Bearer ${bearer}`, 'x-project-epoch': '1' } });
  expect(policy.statusCode, policy.body).toBe(200);
  expect(policy.json<{ inputCheckRequest: number }>().inputCheckRequest).toBe(requested.json<{ inputCheckRequest: number }>().inputCheckRequest);
  const awaiting = await project();
  const observed = await runner('/api/runner/input-changes', { base: 'a'.repeat(40), head: 'a'.repeat(40), baseIsAncestor: true, treeHash: 'b'.repeat(40), changes: [], commits: [] });
  expect(observed.statusCode, observed.body).toBe(200);
  expect((await project()).inputCheckedAt).toMatch(/^\d{4}-/);
  expect((await project()).updatedAt).toBe(awaiting.updatedAt);
  expect((await call('POST', '/api/project/inputs/check', { updatedAt: before.updatedAt })).statusCode).toBe(409);
});

test('빈 관측 반복은 변경 이벤트·일정 계산 버전을 늘리지 않고 읽어 둔 버전으로 프로젝트를 편집할 수 있다', async () => {
  const before = await project();
  const count = async () => (await owner.query<{ n: number }>('select count(*)::int n from change_events')).rows[0]?.n;
  const events = await count();
  const version = (await call('GET', '/api/schedule')).json<{ calcVersion: number }>().calcVersion;
  for (let n = 0; n < 2; n++) {
    const observed = await runner('/api/runner/input-changes', { base: 'a'.repeat(40), head: 'a'.repeat(40), baseIsAncestor: true, treeHash: 'b'.repeat(40), changes: [], commits: [] });
    expect(observed.statusCode, observed.body).toBe(200);
  }
  expect(await count()).toBe(events);
  expect((await call('GET', '/api/schedule')).json<{ calcVersion: number }>().calcVersion).toBe(version);
  const edit = { ...before, description: '관측 뒤 편집' };
  const payload = { updatedAt: edit.updatedAt, name: edit.name, description: edit.description, startDate: edit.startDate, targetDate: edit.targetDate };
  expect((await call('PATCH', '/api/project', payload)).statusCode).toBe(200);
  expect((await call('PATCH', '/api/project', payload)).statusCode).toBe(409);
});

test('이력 재작성으로 거부한 관측은 마지막 유효 관측 시각과 편집 버전을 보존한다', async () => {
  const before = await project();
  const rejected = await runner('/api/runner/input-changes', { base: 'a'.repeat(40), head: 'c'.repeat(40), baseIsAncestor: false, treeHash: 'c'.repeat(40), changes: [], commits: [] });
  expect(rejected.statusCode, rejected.body).toBe(200);
  expect(rejected.json()).toMatchObject({ historyRewritten: true });
  expect(await project()).toMatchObject({ inputCheckedAt: before.inputCheckedAt, updatedAt: before.updatedAt });
  // 복구된 유효 관측은 경고를 해소한다. 이후 시험에 재작성 경고를 남기지 않는다.
  expect((await runner('/api/runner/input-changes', { base: 'a'.repeat(40), head: 'a'.repeat(40), baseIsAncestor: true, treeHash: 'b'.repeat(40), changes: [], commits: [] })).statusCode).toBe(200);
});

test('GitHub 상태 조회: 미확인·정상·권한 부족·만료를 저장된 사실대로 보여 주고 비밀을 숨긴다', async () => {
  const empty = await call('GET', '/api/settings/github');
  expect(empty.statusCode, empty.body).toBe(200);
  expect(empty.json()).toMatchObject({ mode: 'gh', tokenSet: false, status: 'unchecked', scopes: null, updatedAt: null });
  const scopes = { contents: 'verified', pulls: 'unverified', statuses: 'verified', metadata: 'verified' };
  const report = { mode: 'gh', ok: true, account: 'test', scopes, expiresAt: null, warning: '쓰기 권한 미확인' };
  expect((await runner('/api/runner/github/status', report)).statusCode).toBe(204);
  expect((await call('GET', '/api/settings/github')).json()).toMatchObject({ status: 'ok', scopes, warning: report.warning });
  expect((await runner('/api/runner/github/status', { ...report, ok: false, scopes: { ...scopes, pulls: 'missing' }, error: '권한 부족' })).statusCode).toBe(204);
  expect((await call('GET', '/api/settings/github')).json()).toMatchObject({ status: 'failed', scopes: { ...scopes, pulls: 'missing' } });
  expect((await runner('/api/runner/github/status', { mode: 'gh', ok: false, account: null, scopes: null, expiresAt: null, error: '인증 만료' })).statusCode).toBe(204);
  const expired = await call('GET', '/api/settings/github');
  expect(expired.json()).toMatchObject({ status: 'failed', account: null, warning: null, scopes: null });
  expect(expired.body).not.toMatch(/secret_key|ciphertext|nonce|test-key/);
  expect((await app.inject({ url: '/api/settings/github' })).statusCode).toBe(401);
});

test('CP 단건 조회·초안 수정·삭제는 버전·상태와 이력을 지킨다', async () => {
  const cp = await create();
  const read = await call('GET', `/api/proposals/${cp.id}`);
  expect(read.statusCode, read.body).toBe(200);
  expect(read.json()).toMatchObject({ id: cp.id, cpKey: cp.cpKey });
  expect((await call('GET', `/api/proposals/${cp.cpKey}`)).statusCode).toBe(200);
  const edited = await call('PATCH', `/api/proposals/${cp.id}`, { ...proposalBody(), title: '수정한 초안', updatedAt: cp.updatedAt });
  expect(edited.statusCode, edited.body).toBe(200);
  expect((await call('PATCH', `/api/proposals/${cp.id}`, { ...proposalBody(), updatedAt: cp.updatedAt })).statusCode).toBe(409);
  const version = edited.json<Proposal>().updatedAt;
  const removed = await call('DELETE', `/api/proposals/${cp.id}?updatedAt=${encodeURIComponent(version)}`);
  expect(removed.statusCode, removed.body).toBe(204);
  expect((await call('GET', `/api/proposals/${cp.id}`)).statusCode).toBe(404);
  expect((await call('GET', '/api/proposals')).json<{ items: Proposal[] }>().items.some((p) => p.id === cp.id)).toBe(false);
  expect((await owner.query('select kind from change_proposal_events where proposal=$1 order by created_at,id', [cp.id])).rows.map((r: { kind: string }) => r.kind)).toEqual(['created', 'edited', 'deleted']);
  const next = await create();
  const submitted = await call('POST', `/api/proposals/${next.id}/submit`, { updatedAt: next.updatedAt });
  const current = submitted.json<Proposal>();
  expect((await call('DELETE', `/api/proposals/${next.id}?updatedAt=${encodeURIComponent(current.updatedAt)}`)).statusCode).toBe(409);
});

test('반려·수정 요청 의견은 필수이며 수정 요청 중 항목 제외와 재제출은 원자적으로 기록한다', async () => {
  const cp = await create();
  const submitted = (await call('POST', `/api/proposals/${cp.id}/submit`, { updatedAt: cp.updatedAt })).json<Proposal>();
  for (const action of ['reject', 'request-changes']) for (const comment of [undefined, '', '   ']) {
    const rejected = await call('POST', `/api/proposals/${cp.id}/${action}`, { updatedAt: submitted.updatedAt, ...(comment !== undefined && { comment }) });
    expect(rejected.statusCode, rejected.body).toBe(400);
  }
  const changes = (await call('POST', `/api/proposals/${cp.id}/request-changes`, { updatedAt: submitted.updatedAt, comment: '두 번째 항목 제외' })).json<Proposal>();
  const excluded = await call('POST', `/api/proposals/${cp.id}/exclude`, { updatedAt: changes.updatedAt, index: 1 });
  expect(excluded.statusCode, excluded.body).toBe(200);
  expect(excluded.json<Proposal>().ops).toEqual([proposalBody().ops[0]]);
  expect((await call('POST', `/api/proposals/${cp.id}/exclude`, { updatedAt: changes.updatedAt, index: 0 })).statusCode).toBe(409);
  const latest = excluded.json<Proposal>();
  expect((await call('POST', `/api/proposals/${cp.id}/exclude`, { updatedAt: latest.updatedAt, index: 10 })).statusCode).toBe(400);
  const again = await call('POST', `/api/proposals/${cp.id}/submit`, { updatedAt: latest.updatedAt });
  expect(again.statusCode, again.body).toBe(200);
  expect(again.json<Proposal>().events.map((e) => e.action)).toEqual(['created', 'submitted', 'changes', 'excluded', 'submitted']);
  expect((await owner.query('select priority,title from tasks where task_key=$1', ['TASK-0001'])).rows[0]).toMatchObject({ priority: 2, title: '작업' });
});

test('Planning 표시 키와 원본 agree/diff 계약은 미선택 이견의 CP 생성을 막는다', async () => {
  const started = (await call('POST', '/api/plannings', { title: '분석', scope: '범위' })).json<{ id: string; jobId: string }>();
  await owner.query("update runner_jobs set state='leased',fence=1 where id=$1", [started.jobId]);
  const body = { jobId: started.jobId, fence: 1, reviews: [{ topic: '우선순위', kind: 'diff', codex: 'a', claude: 'b', ops: [proposalBody().ops[0]], codexOps: [proposalBody().ops[0]], claudeOps: [proposalBody().ops[1]] }] };
  const report = await runner(`/api/planning/sessions/${started.id}/reviews`, body);
  expect(report.statusCode, report.body).toBe(201);
  const list = (await call('GET', '/api/plannings')).json<{ items: { id: string; planningKey: string; reviews: { kind: string }[] }[] }>();
  expect(list.items.find((p) => p.id === started.id)).toMatchObject({ planningKey: 'PL-001', reviews: [{ kind: 'diff' }] });
  expect((await call('POST', `/api/plannings/${started.id}/proposals`, { title: '제안', reason: '근거' })).statusCode).toBe(400);
  expect((await runner(`/api/planning/sessions/${started.id}/reviews`, { ...body, reviews: [{ ...body.reviews[0], kind: 'unknown' }] })).statusCode).toBe(400);
});

test('입력 차이 분석에서 제출한 CP는 해당 inputJob에만 연결한다', async () => {
  const planning = (await owner.query<{ id: string }>("insert into planning_jobs(project_id,kind,run_no,status,instruction) values($1,'input_diff',1,'running','') returning id", [projectId])).rows[0]?.id;
  const jobId = (await owner.query<{ id: string }>("insert into runner_jobs(project_id,kind,payload,state,fence,epoch,dedup_key) values($1,'input_diff',$2::jsonb,'leased',1,1,$3) returning id", [projectId, JSON.stringify({ planningJobId: planning, version: 2, wbs: await wbsSnapshot(owner, projectId) }), `input_diff:${planning ?? ''}:1`])).rows[0]?.id;
  await owner.query('update schedule_policy set cp_auto=false');
  expect((await runner('/api/planning/proposals', { ...proposalBody(), source: { kind: 'input', id: '다른 작업' }, jobId, fence: 1 })).statusCode).toBe(400);
  const cp = await runner('/api/planning/proposals', { ...proposalBody(), source: { kind: 'input' }, jobId, fence: 1 });
  expect(cp.statusCode, cp.body).toBe(201);
  const state = (await call('GET', '/api/project')).json<{ inputJob: { proposalId: string } }>();
  expect(state.inputJob.proposalId).toBe(cp.json<{ id: string }>().id);
});

test('대시보드는 취소를 제외한 실제 집계·미조정 이견·실행 대기와 같은 일정값을 보인다', async () => {
  const r = await call('GET', '/api/dashboard');
  expect(r.statusCode, r.body).toBe(200);
  expect(ajv.validate(OPERATIONS.find((o) => o.id === 'getDashboard')?.responses[200], r.json()), ajv.errorsText()).toBe(true);
  const dash = r.json<{ tasks: { total: number; done: number }; byDomain: { key: string; count: number }[]; panels: { approvals: { kind: string; unresolved?: number }[]; executions: { kind: string; taskKey: string }[] }; schedule: { end: string; start: string } }>();
  expect(dash.tasks).toMatchObject({ total: 1, done: 0 });
  expect(dash.byDomain.find((d) => d.key === 'BE')?.count).toBe(1);
  expect(dash.panels.approvals.some((p) => p.kind === 'planning' && p.unresolved === 1)).toBe(true);
  expect(dash.panels.executions).toContainEqual(expect.objectContaining({ kind: 'ready', taskKey: 'TASK-0001' }));
  const schedule = (await call('GET', '/api/schedule')).json<{ project: { end: string; start: string } }>();
  expect(dash.schedule).toMatchObject({ start: schedule.project.start, end: schedule.project.end });
});

test('팀장은 기존 검증에 Evidence 경로를 추가할 수 있고 빈·중복·위험 경로는 거부한다', async () => {
  const taskId = (await owner.query<{ id: string }>("select id from tasks where task_key='TASK-0001'")).rows[0]?.id;
  const jobId = (await owner.query<{ id: string }>("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'attempt','{}','done',1,$2) returning id", [projectId, randomUUID()])).rows[0]?.id;
  const attempt = (await owner.query<{ id: string }>(`insert into task_attempts(project_id,task,attempt_key,attempt_no,kind,agent,status,job,model_id,effort,spec_revision,base_sha,head_sha,started_at,ended_at)
    values($1,$2,'A-evidence',1,'qa','Codex','completed',$3,'m','high',1,$4,$4,now(),now()) returning id`, [projectId, taskId, jobId, 'a'.repeat(40)])).rows[0]?.id;
  const verification = (await owner.query<{ id: string }>("insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual) values($1,$2,'PASS',$3,1,'test','통과','통과') returning id", [projectId, attempt, 'a'.repeat(40)])).rows[0]?.id;
  const endpoint = `/api/verifications/${verification}/evidence`;
  for (const path of ['', '   ', '../secret', '/etc/passwd', 'javascript:alert(1)']) {
    const invalid = await call('POST', endpoint, { path });
    expect(invalid.statusCode, invalid.body).toBe(400);
  }
  const added = await call('POST', endpoint, { path: ' evidence/TASK-0001/test.log ' });
  expect(added.statusCode, added.body).toBe(201);
  const evidence = added.json<{ id: string }>();
  expect(added.json()).toMatchObject({ taskKey: 'TASK-0001', verificationId: verification, attemptId: attempt, path: 'evidence/TASK-0001/test.log', sha256: null, size: null });
  expect((await call('POST', endpoint, { path: 'evidence/TASK-0001/test.log' })).statusCode).toBe(400);
  expect((await call('GET', `/api/evidence/${evidence.id}/content`)).statusCode).toBe(404);
  const list = (await call('GET', '/api/evidence?taskKey=TASK-0001')).json<{ items: { id: string; path: string }[] }>();
  expect(list.items).toContainEqual(expect.objectContaining({ id: evidence.id, path: 'evidence/TASK-0001/test.log' }));
  expect((await call('POST', endpoint, { path: 'https://example.com/evidence' })).statusCode).toBe(201);
  await owner.query("insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,evidence,sort_order) values($1,$2,'check-ref','확인',true,true,'test',to_jsonb($3::text),0)", [projectId, taskId, 'evidence/TASK-0001/test.log']);
  const linked = (await call('GET', '/api/evidence?taskKey=TASK-0001')).json<{ items: { id: string; checklistItemKey: string | null }[] }>();
  expect(linked.items.find((e) => e.id === evidence.id)?.checklistItemKey).toBe('check-ref');
  expect((await call('GET', '/api/project/export')).statusCode).toBe(200);
});

test('다른 멱등 키나 다른 내용이어도 Planning 세션당 살아 있는 CP는 하나이며 반려·삭제 뒤에는 다시 작성할 수 있다', async () => {
  const started = (await call('POST', '/api/plannings', { title: '중복 확인', scope: '범위' })).json<{ id: string; jobId: string }>();
  await owner.query("update runner_jobs set state='leased',fence=1 where id=$1", [started.jobId]);
  expect((await runner(`/api/planning/sessions/${started.id}/reviews`, { jobId: started.jobId, fence: 1,
    reviews: [{ topic: '합의', kind: 'agree', codex: '', claude: '', ops: [proposalBody().ops[0]] }] })).statusCode).toBe(201);
  const endpoint = `/api/plannings/${started.id}/proposals`;
  const responses = await Promise.all([call('POST', endpoint, { title: '제안', reason: '근거' }, randomUUID()),
    call('POST', endpoint, { title: '제안 재전송', reason: '같은 내용' }, randomUUID())]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  const cp = responses.find((r) => r.statusCode === 201)?.json<Proposal>();
  if (!cp) throw new Error('생성된 CP가 없습니다.');
  const edited = await call('PATCH', `/api/proposals/${cp.id}`, { title: '초안 수정', reason: '다른 내용', source: { kind: 'planning', id: started.id },
    ops: [proposalBody().ops[1]], updatedAt: cp.updatedAt });
  expect(edited.statusCode, edited.body).toBe(200);
  expect((await call('POST', endpoint, { title: '다른 CP', reason: '내용 변경' })).statusCode).toBe(409);
  expect((await call('POST', '/api/proposals', { ...proposalBody(), source: { kind: 'planning', id: started.id } })).statusCode).toBe(409);
  const submitted = (await call('POST', `/api/proposals/${cp.id}/submit`, { updatedAt: edited.json<Proposal>().updatedAt })).json<Proposal>();
  expect((await call('POST', `/api/proposals/${cp.id}/reject`, { updatedAt: submitted.updatedAt, comment: '재조정' })).statusCode).toBe(200);
  const again = await call('POST', endpoint, { title: '다시 작성', reason: '반려 뒤' });
  expect(again.statusCode).toBe(201);
  const draft = again.json<Proposal>();
  expect((await call('DELETE', `/api/proposals/${draft.id}?updatedAt=${encodeURIComponent(draft.updatedAt)}`)).statusCode).toBe(204);
  expect((await call('POST', endpoint, { title: '다시 작성', reason: '삭제 뒤' })).statusCode).toBe(201);
});

test('CP가 있는 Planning 세션에서는 이견 선택과 메모도 잠그고 반려 뒤에는 다시 조정한다', async () => {
  const started = (await call('POST', '/api/plannings', { title: '선택 잠금', scope: '범위' })).json<{ id: string; jobId: string }>();
  await owner.query("update runner_jobs set state='leased',fence=1 where id=$1", [started.jobId]);
  expect((await runner(`/api/planning/sessions/${started.id}/reviews`, { jobId: started.jobId, fence: 1,
    reviews: [{ topic: '선택', kind: 'diff', codex: '', claude: '', codexOps: [proposalBody().ops[0]], claudeOps: [proposalBody().ops[1]] }] })).statusCode).toBe(201);
  interface Review { id: string; updatedAt: string; choice: string; memo: string }
  const session = (await call('GET', '/api/plannings')).json<{ items: { id: string; reviews: Review[] }[] }>().items.find((p) => p.id === started.id);
  const review = session?.reviews[0];
  if (!review) throw new Error('검토가 없습니다.');
  const endpoint = `/api/plannings/${started.id}/reviews/${review.id}/choice`;
  const chosen = await call('POST', endpoint, { updatedAt: review.updatedAt, choice: 'codex', memo: '원래 메모' });
  const current = chosen.json<{ reviews: Review[] }>().reviews[0];
  if (!current) throw new Error('선택 결과가 없습니다.');
  const cp = (await call('POST', `/api/plannings/${started.id}/proposals`, { title: '제안', reason: '근거' })).json<Proposal>();
  const change = { updatedAt: current.updatedAt, choice: 'claude', memo: '바꾼 메모' };
  const blocked = await call('POST', endpoint, change);
  expect(blocked.statusCode, blocked.body).toBe(409);
  expect(blocked.json()).toMatchObject({ error: { code: 'INVALID_TRANSITION', details: { proposalId: cp.id } } });
  const stored = (await call('GET', '/api/plannings')).json<{ items: { id: string; reviews: Review[] }[] }>().items.find((p) => p.id === started.id)?.reviews[0];
  expect(stored).toMatchObject({ choice: 'codex', memo: '원래 메모', updatedAt: current.updatedAt });
  const submitted = (await call('POST', `/api/proposals/${cp.id}/submit`, { updatedAt: cp.updatedAt })).json<Proposal>();
  expect((await call('POST', `/api/proposals/${cp.id}/reject`, { updatedAt: submitted.updatedAt, comment: '재조정' })).statusCode).toBe(200);
  expect((await call('POST', endpoint, change)).statusCode).toBe(200);
});

test('초기화 뒤에는 대시보드도 빈 데이터이며 경로 참조·숨긴 CP까지 정리된다', async () => {
  const before = await project();
  const reset = await call('POST', '/api/project/reset', { confirmName: before.name, keepSettings: true, epoch: 1 });
  expect(reset.statusCode, reset.body).toBe(200);
  const r = await call('GET', '/api/dashboard');
  expect(r.statusCode, r.body).toBe(200);
  expect(ajv.validate(OPERATIONS.find((o) => o.id === 'getDashboard')?.responses[200], r.json()), ajv.errorsText()).toBe(true);
  expect(r.json()).toMatchObject({ tasks: { total: 0, done: 0, active: 0, blocked: 0 }, schedule: null,
    panels: { late: [], approvals: [], executions: [], rework: [], gate: [], messages: [] }, recent: [], grades: [] });
});
