import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { OPERATIONS } from '@awbs/shared/api';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import { scheduleInput } from '../src/planning/schedule.ts';
import { schedule } from '@awbs/shared';

/*
 * M2-07 독립 리뷰(archive/2026-11-26/M2-07-review) F1~F7의 재현을 회귀 테스트로 남긴다.
 * 리뷰의 재현 코드를 그대로 가져왔고, 수정 전 코드에서 F1·F2·F3·F4·F6이 실패하는 것을 확인했다(M2-07/review-red.log).
 */
const findings: Record<string, unknown> = {};

/*
 * M2-07 완료 조건(milestones.md): Planning·변경 제안(CP) 미리보기=반영·자동/보류·추정·재조정·분할.
 * - 취소 반영과 SS 제거·이력·재조정이 한 트랜잭션, 미리보기 영향 = 반영 결과(D-27)
 * - D-33~35 보류: 자동·수동 승인·반영이 같은 판정, 재시뮬레이션 때 다시 판정
 * - 팀장 CP 판단 job 생성·재요청, 판단 저장 위치 이전과 hash 재대조
 * - CP splitBasis 선택/필수와 반영 저장, CP add 선택 필드 저장·상속 재계산
 */

const origin = 'http://127.0.0.1:3100';
const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_planning_review';
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
async function estimate(key: string, est: number, confidence = '상') {
  await ownerPool.query("insert into task_estimates(project_id,task,est,lo,hi,confidence,basis,agreed_by) values($1,$2,$3,$3,$3,$4,'근거','Claude,Codex')", [projectId, await idOf(key), est, confidence]);
}
async function history(key: string) {
  return (await ownerPool.query<{ kind: string; text: string; actor: string; ref: Record<string, unknown> | null }>(
    'select h.kind,h.text,h.actor,h.ref from task_history h join tasks t on t.id=h.task where t.task_key=$1 order by h.at,h.created_at', [key])).rows;
}

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
const judgementJobs = async (proposalId: string) => (await ownerPool.query<{ id: string; state: string; payload: {
  proposal: { id: string; ops: unknown[]; targets: { target: string; subjectHash: string; before: unknown; after: unknown }[]; splitSubjectHash: string | null; splitTasks: { taskKey: string }[] | null };
} }>("select id,state,payload from runner_jobs where kind='planning' and payload->'proposal'->>'id'=$1 order by created_at", [proposalId])).rows;
const met = (rules: string[], subjectHash?: string) => ({ schemaVersion: 1, items: rules.map((rule) => ({
  rule, result: 'met', agreedBy: ['Claude', 'Codex'], basis: '근거', judgedAt: '2026-11-26T00:00:00Z', sourceRef: `sha256:${subjectHash ?? 'a'.repeat(64)}`, ...(subjectHash ? { subjectHash } : {}),
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

test('existing DB trigger changes stored content: hash recheck must roll back and report hold',async()=>{
  await judgedRulesOn(true);
  try{
    const k=await task(); const cp=await leadCp([{op:'modify',task:k,field:'title',after:'accepted'}]); await submit(cp.id);
    const jobs=await judgementJobs(cp.id); const target=jobs[0]?.payload.proposal.targets[0]; if(!target) throw new Error('판단 job 없음');
    const report=await runner(`/api/planning/proposals/${cp.id}/judgements`,{jobId:await job(),fence:1,judgements:[{target:k,judgedRules:met(RULES,target.subjectHash)}]});
    expect(report.statusCode).toBe(204); expect((await approve(cp.id)).statusCode).toBe(200);
    await ownerPool.query("create function review_drift() returns trigger language plpgsql as $$ begin if new.title='accepted' then new.title='DB changed'; end if; return new; end $$");
    await ownerPool.query('create trigger review_drift before update on tasks for each row execute function review_drift()');
    let response;
    try {response=await apply(cp.id);} finally {await ownerPool.query('drop trigger review_drift on tasks'); await ownerPool.query('drop function review_drift()');}
    const data=response.json<{proposal:{status:string;holdReasons:unknown[]};holdReasons:{code:string}[]}>();
    const stored=(await ownerPool.query<{title:string}>('select title from tasks where task_key=$1',[k])).rows[0]?.title;
    findings.drift={http:response.statusCode,proposalStatus:data.proposal.status,topLevelHolds:data.holdReasons,proposalHolds:data.proposal.holdReasons,stored};
    expect(stored).toBe('작업'); expect(data.proposal.status).toBe('held');
    // Capture contradiction without hiding the successful rollback.
    expect(data.holdReasons).toEqual(data.proposal.holdReasons);
    expect(data.holdReasons.map((r)=>r.code)).toEqual(['JUDGEMENT_MISSING']);
  }finally{await judgedRulesOn(false);}
});
test('concurrent manual replans must assign different baseline versions',async()=>{
  const blocker=await ownerPool.connect();
  await blocker.query('begin');
  // 재조정 잠금을 먼저 잡아 두 요청을 모두 그 앞에 세운다. 잠금이 없던 수정 전 코드는 여기서 기다리지 않는다.
  await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`awbs:replan:${projectId}`]);
  const pending=[call('POST','/api/replans/run',{}),call('POST','/api/replans/run',{})];
  const promises=pending.map(p=>Promise.resolve(p));
  let waiters=0;
  try {
    for(let i=0;i<100;i++) {
      waiters=Number((await ownerPool.query("select count(*) n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%pg_advisory_xact_lock%'")).rows[0].n);
      if(waiters>=2)break;
      await new Promise(r=>setTimeout(r,10));
    }
  }finally{await blocker.query('commit');blocker.release();}
  const responses=await Promise.all(promises);
  findings.concurrentReplans={waiters,statuses:responses.map(r=>r.statusCode),bodies:responses.map(r=>r.json())};
  expect(waiters).toBe(2); expect(responses.map(r=>r.statusCode)).toEqual([201,201]);
  const versions=responses.map(r=>r.json<{baselineVersion:number}>().baselineVersion);
  expect(new Set(versions).size).toBe(2);
});
test('12 concurrent refused approvals must not exhaust their own pool',async()=>{
  await judgedRulesOn(true);
  const blocker=await ownerPool.connect();
  try{
    const cp=await leadCp([leadAdd('NEW-1')]); await submit(cp.id);
    const p=await preview(cp.id); const v=await version(cp.id);
    await blocker.query('begin'); await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`awbs:task-graph:${projectId}`]);
    const promises=Array.from({length:12},()=>Promise.resolve(call('POST',`/api/proposals/${cp.id}/approve`,{updatedAt:v,previewHash:p.previewHash})));
    let locks=0;
    for(let i=0;i<150;i++){
      locks=Number((await ownerPool.query("select count(*) n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and (query like '%change_proposals%for update%' or query like '%pg_advisory_xact_lock%')")).rows[0].n);
      if(locks>=12)break;
      await new Promise(r=>setTimeout(r,10));
    }
    await blocker.query('commit');
    const responses=await Promise.all(promises);
    findings.poolStarvation={locks,statuses:responses.map(r=>r.statusCode)};
    expect(responses.every(r=>r.statusCode===409)).toBe(true);
  }finally{await blocker.query('rollback');blocker.release();await judgedRulesOn(false);}
},15000);
test('replan moves are visible in each moved task history',async()=>{
  const k=await task(); await estimate(k,2);
  expect((await call('POST','/api/replans/run',{})).statusCode).toBe(201);
  await estimate(k,200);
  const before=await history(k); const response=await call('POST','/api/replans/run',{});
  expect(response.statusCode,response.body).toBe(201);
  const data=response.json<{moved:{taskKey:string}[]}>(); const after=await history(k);
  findings.replanHistory={moved:data.moved.filter((m)=>m.taskKey===k),newTaskHistory:after.slice(before.length)};
  expect(data.moved.some((m)=>m.taskKey===k)).toBe(true);
  expect(after.length).toBeGreaterThan(before.length);
});
test('schedule adapter respects a stored current Runner limit',async()=>{
  const keys=await Promise.all(Array.from({length:6},()=>task()));
  for(const k of keys)await estimate(k,48);
  await ownerPool.query("insert into concurrency_settings(mode,caps) values('manual',$1::jsonb) on conflict (singleton) do update set caps=excluded.caps",[JSON.stringify({total:4,Claude:4,Codex:4,heavy:1})]);
  await ownerPool.query('insert into runner_concurrency_log(host_id,"limit",running,subagents,heavy,resources) values($1,1,0,$2::jsonb,0,$3::jsonb)',['review-host',JSON.stringify({observed:0,held:0}),JSON.stringify({cpuPct:0,memFreeGB:16,swapGB:0})]);
  const client=await pool.connect();
  try{
    const {input}=await scheduleInput(client,projectId,{autoReplan:false,thresholdDays:1,assumeRate:0.6,windowDays:7,minHours:72});
    const actual=schedule(input);const expected=schedule({...input,concurrency:{...input.concurrency,current:1}});
    findings.runnerCapacity={storedLimit:1,adapterConcurrency:input.concurrency,actualEnd:actual.project.end,expectedEnd:expected.project.end};
    expect(input.concurrency.current).toBe(1);
  }finally{client.release();}
});

test('F1 관측 하위 Agent 비율: 창 안의 실행 세션당 하위 Agent 수 평균을 일정 입력에 넣는다', async () => {
  await ownerPool.query("insert into concurrency_settings(mode,caps) values('manual',$1::jsonb) on conflict (singleton) do update set caps=excluded.caps",[JSON.stringify({ total: 4, Claude: 4, Codex: 4, heavy: 1 })]);
  // 보고 기록은 추가 전용이다. 가장 최근 보고(limit 3)와 창 안의 실행 중 보고(세션 4개에 하위 Agent 2개 = 0.5)를 넣는다.
  await ownerPool.query(`insert into runner_concurrency_log(host_id,"limit",running,subagents,heavy,resources) values
    ('h',3,2,'1'::jsonb,0,'{}'::jsonb),('h',3,2,'{"observed":1}'::jsonb,0,'{}'::jsonb)`);
  const client = await pool.connect();
  try {
    const { input } = await scheduleInput(client, projectId, { autoReplan: false, thresholdDays: 1, assumeRate: 0.6, windowDays: 7, minHours: 72 });
    expect(input.concurrency).toMatchObject({ current: 3, subRatio: 0.5 });
  } finally { client.release(); }
});

test('F3 보류 승인(409)에서도 판단 job은 같은 트랜잭션에 커밋되어 남는다', async () => {
  await judgedRulesOn(true);
  try {
    const cp = await leadCp([leadAdd('NEW-1')]);
    await submit(cp.id);
    await ownerPool.query("update runner_jobs set state='done' where payload->'proposal'->>'id'=$1", [cp.id]);
    const refused = await approve(cp.id, 'x'.repeat(8));
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused).code).toBe('SPLIT_JUDGEMENT_REQUIRED');
    const jobs = (await ownerPool.query<{ state: string }>("select state from runner_jobs where payload->'proposal'->>'id'=$1 order by created_at", [cp.id])).rows.map((r) => r.state);
    expect(jobs).toEqual(['done', 'queued']);
    // 409로 끝났으므로 CP는 승인되지 않았다.
    expect((await getCp(cp.id))?.status).toBe('review');
  } finally { await judgedRulesOn(false); }
});

test('F4 재조정 이력은 RP 키·전후 날짜와 확정을 남기고, 검토 대기는 Task별 이력 없이 재조정 기록만 남긴다(G§9.2-1·D-10)', async () => {
  const k = await task(); await estimate(k, 3);
  // Task별 이력은 이전 기준이 있을 때 날짜가 바뀐 Task에만 남는다. 먼저 기준을 만들고, 이 Task의 날짜를 바꾼 뒤 다시 확정한다.
  expect((await call('POST', '/api/replans/run', {})).statusCode).toBe(201);
  await estimate(k, 30);
  const run = await call('POST', '/api/replans/run', {});
  expect(run.statusCode, run.body).toBe(201);
  const { replanId } = run.json<{ replanId: string }>();
  const rows = (await history(k)).filter((h) => h.kind === '재조정');
  expect(rows.at(-1)?.text).toContain(replanId);
  expect(rows.at(-1)?.text).toContain('확정');
  expect(rows.at(-1)?.ref).toMatchObject({ replanId, status: 'applied' });
  const before = (await history(k)).filter((h) => h.kind === '재조정').length;
  await estimate(k, 300);
  const pending = await runner('/api/planning/replans', { jobId: await job(), fence: 1, trigger: '재추정', capacity: { rate: 0.5, concurrency: 1, subRatio: 0 } });
  expect(pending.statusCode, pending.body).toBe(202);
  const pendingId = pending.json<{ replanId: string }>().replanId;
  expect((await history(k)).filter((h) => h.kind === '재조정')).toHaveLength(before);
  expect((await ownerPool.query('select status from replans where rp_key=$1', [pendingId])).rows).toEqual([{ status: 'pending' }]);
  expect((await ownerPool.query('select 1 from replan_moves m join replans r on r.id=m.replan where r.rp_key=$1', [pendingId])).rowCount).toBe(0);
});

test('F5 일정 조회와 Task 일정 요약은 같은 계산·기준을 쓴다', async () => {
  const k = await task(); await estimate(k, 5);
  expect((await call('POST', '/api/replans/run', {})).statusCode).toBe(201);
  const response = await call('GET', '/api/schedule');
  expect(response.statusCode, response.body).toBe(200);
  expectShape('getSchedule', 200, response.json());
  const view = response.json<{ tasks: { taskKey: string; end: string; estHours: number; baselineEnd: string | null; isNew: boolean }[]; project: { baselineVersion: number; taskCount: number }; calcVersion: number }>();
  const item = view.tasks.find((t) => t.taskKey === k);
  expect(item).toMatchObject({ estHours: 5, isNew: false });
  expect(item?.baselineEnd).toBe(item?.end);
  expect(view.project.baselineVersion).toBeGreaterThan(0);
  const list = await call('GET', `/api/projects/${projectId}/tasks`);
  const summary = list.json<{ tasks: { taskKey: string; schedule: { estHours: number; end: string | null; baselineEnd: string | null } | null }[] }>().tasks.find((t) => t.taskKey === k);
  expect(summary?.schedule).toEqual(expect.objectContaining({ estHours: 5, end: item?.end, baselineEnd: item?.baselineEnd }));
  // 내용이 바뀌면 calcVersion이 커진다.
  await estimate(k, 6);
  await call('POST', '/api/replans/run', {});
  expect((await call('GET', '/api/schedule')).json<{ calcVersion: number }>().calcVersion).toBeGreaterThan(view.calcVersion);
});

test('F7 완료 Task 추정 거부(409 INVALID_TRANSITION)는 경로 계약에 선언되어 있다', async () => {
  const k = await task(); await setStatus(k, 'done');
  await ownerPool.query('update tasks set act_start=now()-interval \'1 hour\',act_end=now() where task_key=$1', [k]);
  const response = await runner('/api/planning/estimates', { jobId: await job(), fence: 1, items: [{ taskKey: k, estHours: 1, loHours: 1, hiHours: 1, confidence: '상', basis: 'b', agreedBy: ['Claude'] }] });
  expect(errorOf(response).code).toBe('INVALID_TRANSITION');
  expect(OPERATIONS.find((op) => op.id === 'submitEstimates')?.errors).toContain('INVALID_TRANSITION');
});
