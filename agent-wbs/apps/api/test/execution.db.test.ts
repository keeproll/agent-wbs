import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import { installRunner } from '../src/runner/routes.ts';
import { completeMergedTask, invalidateTaskGate } from '../src/execution/gate.ts';
import { inEpoch } from '../src/platform/transaction.ts';
import { RunnerRepository } from '../src/runner/repository.ts';
import { watchRunner } from '../src/runner/watch.ts';

const db = new URL(inject('testDatabaseUrl'));
db.pathname += '_execution';
const owner = createPool(db.href, { onError: () => undefined });
const appUrl = new URL(db);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { onError: () => undefined });
const root = await mkdtemp(join(tmpdir(), 'awbs-evidence-'));
const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40), pipeline = 'c'.repeat(40);
// 서버가 병합 기준 커밋에서 읽은 파이프라인을 대신한다. Runner 본문은 이 값을 정할 수 없다.
const app = buildApp(pool, false, { origin: 'http://127.0.0.1:3100', lan: false }, { dataRoot: root, resolveBasePipelineSha: async () => pipeline });
installRunner(app, pool);
let bearer: string, cookie: string, csrf: string, project: string, wp: string, input: string;
let sequence = 0;
const headers = () => ({ authorization: `Bearer ${bearer}`, 'x-project-epoch': '1', 'idempotency-key': randomUUID() });
const lead = () => ({ cookie, origin: 'http://127.0.0.1:3100', 'x-csrf-token': csrf, 'idempotency-key': randomUUID() });
const post = (path: string, payload: object, h = headers()) => app.inject({ method: 'POST', url: `/api/runner/${path}`, headers: h, payload });
const get = (path: string) => app.inject({ url: `/api/${path}`, headers: { cookie } });
const version = async (key: string) => ((await owner.query("select to_char(updated_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') v from tasks where task_key=$1", [key])).rows[0] as { v: string }).v;
interface Running { id: string; key: string; job: string; attempt: string; kind: string; fence: number }
async function running(kind = 'dev', slot = 'none'): Promise<Running> {
  const key = `TASK-${String(++sequence).padStart(4, '0')}`;
  const id = ((await owner.query(`insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state,planning_approved_at,src_input_version)
    values($1,$2,$3,1,'결과 시험','Implementation','BE','{}',1,'Codex','Codex',$4,'none',now(),$5) returning id`,
  [project, key, wp, kind === 'qa' ? 'qa' : kind === 'reverify' ? 'verifying' : 'running', input])).rows[0] as { id: string }).id;
  await owner.query("insert into task_specs(project_id,task,overview,spec,ac,revision) values($1,$2,'{}','{}','[]',1)", [project, id]);
  await owner.query("insert into task_grades(project_id,task,role,model_id,effort,reason,locked,effective_from) values($1,$2,'dev','gpt-6.1-sol','high','시험',false,now()),($1,$2,'qa','gpt-6.1-sol','high','시험',false,now())", [project,id]);
  await owner.query("insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order) values($1,$2,'CL-1','시험',true,false,'테스트',1)", [project,id]);
  await owner.query("insert into task_outputs(project_id,task,name,kind,required,verify,delivered) values($1,$2,'결과','파일',true,'테스트',true)", [project,id]);
  const job = ((await owner.query(`insert into runner_jobs(project_id,epoch,kind,payload,dedup_key,state,lease_owner,lease_until,fence,generation)
    values($1,1,'attempt',$2,$3,'started','runner:execution',now()+interval '5 minutes',1,1) returning id`,
  [project, { taskKey:key, kind, agent:'Codex', baseCommit:sha, branch:`agent/${key}-h1` },randomUUID()])).rows[0] as { id: string }).id;
  const attempt = ((await owner.query(`insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,input_version,kind,agent,status,started_at,model_id,effort,branch,generation)
    values($1,$2,$3,1,$4,$5,$5,1,$6,$7,'Codex','running',now(),'gpt-6.1-sol','high',$8,1) returning id`,
  [project,id,`${key}-A1`,job,sha,input,kind,`agent/${key}-h1`])).rows[0] as { id: string }).id;
  await owner.query(`insert into execution_holds(project_id,job,attempt,epoch,host_id,boot_id,fence,task,agent,slots,heavy,slot_state,lock_state,release_proof)
    values($1,$2,$3,1,'host-a','boot-a',1,$4,'Codex',1,false,$5,'held',$6)`, [project,job,attempt,id,'reserved',null]);
  if (slot === 'none') await owner.query("update execution_holds set slot_state='none',release_proof='no_process' where job=$1",[job]);
  return { id,key,job,attempt,kind,fence:1 };
}
async function check(a: Running, head = sha, status = 'pass') {
  return ((await owner.query(`insert into ci_runs(project_id,run_key,stage,pipeline_sha,head_sha,pr,ref,task,attempt,trigger,status,job,fence)
    values($1,$2,1,$3,$4,1,'agent/test',$5,$6,'task',$7,$8,$9) returning id`, [project,randomUUID(),pipeline,head,a.id,a.attempt,status,a.job,a.fence])).rows[0] as { id: string }).id;
}
function result(a: Running, outcome = 'PASS', extra: object = {}) {
  return { fence:a.fence, summary:'검증 결과', changedFiles:[], evidence:[],
    ...(['qa','reverify'].includes(a.kind) ? { verification:{ headSha:sha,specRevision:1,result:outcome,cmd:'pnpm test',expected:'성공',actual:outcome,defects:[],checklist:[{ itemKey:'CL-1',done:true }] } } : {}), ...extra };
}
const report = (a: Running, outcome = 'PASS', extra: object = {}) => post(`attempts/${a.attempt}/result`, result(a,outcome,extra));
async function next(a: Running, head = sha): Promise<Running> {
  const claimed = await post('jobs/claim', { kinds:['attempt'],capacity:20 });
  expect(claimed.statusCode,claimed.body).toBe(200);
  const job = claimed.json().job as { id: string; fence: number; payload: { kind: string } };
  const started = await post(`jobs/${job.id}/start`, { fence:job.fence,hostId:'host-a',bootId:'boot-a',headSha:head,installedSubagents:[] });
  expect(started.statusCode,started.body).toBe(200);
  await post(`jobs/${job.id}/slots/release`, { fence:job.fence,hostId:'host-a',proof:{ kind:'no_process',bootId:'boot-a' },at:new Date().toISOString() });
  return { ...a,job:job.id,attempt:started.json().attemptId as string,kind:job.payload.kind,fence:job.fence };
}
beforeAll(async () => {
  await recreateTestDatabase(db.href);
  await runMigrations(owner);
  await seedSystem(owner);
  bearer = await issueRunnerToken(pool,'execution','fake');
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method:'POST',url:'/api/auth/session',headers:{ origin:'http://127.0.0.1:3100' },payload:{ method:'link',token } });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await get('session')).json().csrfToken as string;
});
beforeEach(async () => {
  await owner.query('set session_replication_role=replica');
  await owner.query('truncate projects,runner_jobs,task_attempts,execution_holds,task_history,idempotency_keys,runner_hosts,runner_readiness,agent_usage,agent_models,external_write_authority cascade');
  await owner.query('set session_replication_role=origin');
  project = ((await owner.query("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('시험','https://github.com/test/execution','test','execution','','active') returning id")).rows[0] as { id: string }).id;
  input = ((await owner.query("insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,1,$2,'[]','[]','[]','') returning id",[project,sha])).rows[0] as { id: string }).id;
  const phase = ((await owner.query("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH','phase','단계',1) returning id",[project])).rows[0] as { id: string }).id;
  wp = ((await owner.query("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP','work_package',$2,'묶음',1) returning id",[project,phase])).rows[0] as { id: string }).id;
  await owner.query("insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at) values('host-a','boot-a','fake',20,32,0,100,'fake',0,now())");
  await owner.query("insert into external_write_authority(singleton,host_id,generation,state) values(true,'host-a',1,'granted')");
  await owner.query("insert into github_settings(mode,status,scopes) values('gh','ok',$1) on conflict(singleton) do nothing", [{ contents: 'verified', pulls: 'verified', statuses: 'verified', metadata: 'verified' }]);
  await owner.query("insert into agent_models(agent,model_id,rank,allowed,report) values('Codex','gpt-6.1-sol',1,true,'{\"efforts\":[\"high\",\"xhigh\",\"max\"]}')");
  await owner.query("insert into agent_usage(agent,remain_pct,reset_at) values('Codex',100,now())");
  await owner.query("insert into runner_readiness(key,status,detail,fix,at) select key,'ok','','',now() from unnest(array['codex','git','node','pnpm','pg','repo','disk','subs']) key");
});
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); await rm(root,{ recursive:true,force:true }); });

test('개발 완료는 기록된 ① 실패를 거부하고 결과·파일·QA 잠금 인계를 한 번만 저장한다', async () => {
  const a = await running();
  await check(a,sha,'fail');
  expect((await report(a)).statusCode).toBe(409);
  await check(a);
  const h = headers(), payload = result(a,'PASS',{ changedFiles:['src/a.ts'],tokens:12 });
  const send = () => post(`attempts/${a.attempt}/result`,payload,h);
  const r = await send();
  expect(r.statusCode,r.body).toBe(201);
  expect((await send()).headers['idempotency-replayed']).toBe('true');
  expect((await owner.query('select status,summary,tokens::int tokens from task_attempts where id=$1',[a.attempt])).rows).toEqual([{ status:'completed',summary:'검증 결과',tokens:12 }]);
  expect((await owner.query('select path from attempt_files where attempt=$1',[a.attempt])).rows).toEqual([{ path:'src/a.ts' }]);
  expect((await get(`tasks/${a.key}/attempts`)).json().items).toMatchObject([{ tokens:12,changedFiles:['src/a.ts'] }]);
  expect((await next(a)).kind).toBe('qa');
});

test('M7-06: ① 기록 없는 개발 완료는 거부하고 QA job과 산출물 제출을 만들지 않는다', async () => {
  const a = await running();
  const response = await report(a,'PASS',{ changedFiles:['src/a.ts'] });
  expect(response.statusCode,response.body).toBe(409);
  expect((await owner.query('select status from task_attempts where id=$1',[a.attempt])).rows).toEqual([{ status:'running' }]);
  expect((await owner.query("select count(*)::int n from runner_jobs where payload->>'kind'='qa'")).rows).toEqual([{ n:0 }]);
  expect((await owner.query('select count(*)::int n from attempt_files')).rows).toEqual([{ n:0 }]);
});

// M2-09 runner-basic의 시나리오 6과 FakeRunner.result 순서(그룹 등록→슬롯 반환→결과 보고)를 실제 HTTP로 재현한다.
test('M2-09 시나리오 6: 명시적인 ① 준비 기록으로 개발→QA FAIL→재작업→재검증 PASS까지 진행한다', async () => {
  const base = await app.listen({ host:'127.0.0.1',port:0 });
  const send = async (path: string, payload: object) => {
    const response = await fetch(`${base}/api/runner/${path}`,{ method:'POST',headers:{ ...headers(),'content-type':'application/json' },body:JSON.stringify(payload) });
    const text = await response.text();
    return { status:response.status,body:text ? JSON.parse(text) as Record<string, unknown> : null };
  };
  let group = 1000;
  const finish = async (a: Running, outcome = 'PASS') => {
    const pgid = ++group;
    expect((await send(`jobs/${a.job}/process`,{ fence:a.fence,processGroup:pgid,cgroup:null })).status).toBe(204);
    expect((await send(`jobs/${a.job}/slots/release`,{ fence:a.fence,hostId:'host-a',proof:{ kind:'group_empty',bootId:'boot-a',processGroup:pgid },at:new Date().toISOString() })).status).toBe(204);
    if (a.kind === 'dev' || a.kind === 'rework') await check(a);
    const reported = await send(`attempts/${a.attempt}/result`,result(a,outcome));
    expect(reported.status,JSON.stringify(reported.body)).toBe(201);
  };
  const startNext = async (a: Running) => {
    const claimed = await send('jobs/claim',{ kinds:['attempt'],capacity:20 });
    expect(claimed.status,JSON.stringify(claimed.body)).toBe(200);
    const job = claimed.body?.job as { id: string; fence: number; payload: { kind: string } };
    const started = await send(`jobs/${job.id}/start`,{ fence:job.fence,hostId:'host-a',bootId:'boot-a',headSha:sha,installedSubagents:[] });
    expect(started.status,JSON.stringify(started.body)).toBe(200);
    return { ...a,job:job.id,fence:job.fence,kind:job.payload.kind,attempt:started.body?.attemptId as string };
  };
  const dev = await running('dev','reserved');
  await finish(dev);
  const qa = await startNext(dev); expect(qa.kind).toBe('qa'); await finish(qa,'FAIL');
  const rework = await startNext(qa); expect(rework.kind).toBe('rework'); await finish(rework);
  const reverify = await startNext(rework); expect(reverify.kind).toBe('reverify'); await finish(reverify);
  expect((await owner.query('select kind,status,effort from task_attempts order by attempt_no')).rows).toMatchObject([
    { kind:'dev',status:'completed',effort:'high' },{ kind:'qa',status:'completed' },
    { kind:'rework',status:'completed',effort:'xhigh' },{ kind:'reverify',status:'completed' },
  ]);
  expect((await get(`tasks/${dev.key}`)).json()).toMatchObject({ lifecycleStatus:'gate',verifState:'pass' });
  expect((await owner.query('select * from ci_runs')).rowCount).toBe(2);
  expect((await get(`tasks/${dev.key}/gate`)).json()).toMatchObject({ passed:true });
});

test('① 기록이 없어도 명세가 바뀐 개발 결과를 자리표시로 통과시키지 않는다', async () => {
  const a = await running();
  await owner.query('update task_specs set revision=2 where task=$1',[a.id]);
  expect((await report(a)).statusCode).toBe(409);
  expect((await owner.query('select status from task_attempts where id=$1',[a.attempt])).rows).toEqual([{ status:'running' }]);
});

test('① PASS 뒤 새 ① FAIL이 기록되면 QA 예약을 거부한다', async () => {
  const a = await running();
  await check(a);
  expect((await report(a)).statusCode).toBe(201);
  await check(a,sha,'fail');
  expect((await post('jobs/claim',{ kinds:['attempt'],capacity:20 })).statusCode).toBe(204);
  expect((await owner.query('select kind from task_attempts where task=$1',[a.id])).rows).toEqual([{ kind:'dev' }]);
});

test('과거 자리표시 이벤트만 남은 개발 결과를 현재 ① 통과 근거로 삼지 않는다', async () => {
  const a = await running();
  await owner.query("update task_attempts set status='completed',ended_at=greatest(started_at,clock_timestamp()) where id=$1",[a.attempt]);
  await owner.query("insert into runner_job_events(project_id,job,kind,detail) values($1,$2,'finished','{\"taskCheckPlaceholder\":true}')",[project,a.job]);
  const client = await owner.connect();
  try {
    const repo = new RunnerRepository(client), task = await repo.taskById(a.id);
    if (!task) throw new Error('시험 Task가 필요합니다.');
    expect(await repo.taskCheck(task,sha)).toBe(false);
  } finally { client.release(); }
});

test('QA FAIL 뒤 자동 재작업·재검증 PASS가 차단 결함을 해소하고 통합 job을 자동 생성한다', async () => {
  const a = await running(); await check(a); expect((await report(a)).statusCode).toBe(201);
  const qa = await next(a);
  expect((await owner.query('select verif_state from tasks where id=$1',[a.id])).rows).toEqual([{ verif_state:'running' }]);
  const failed = await report(qa,'FAIL',{ verification:{ ...(result(qa).verification),result:'FAIL',defects:[{ text:'수용 기준 미충족',blocking:true }] } });
  expect(failed.statusCode,failed.body).toBe(201);
  const rework = await next(qa); expect(rework.kind).toBe('rework');
  await check(rework); expect((await report(rework)).statusCode).toBe(201);
  const reverify = await next(rework); expect(reverify.kind).toBe('reverify');
  expect((await report(reverify)).statusCode).toBe(201);
  expect((await get(`tasks/${a.key}/gate`)).json()).toMatchObject({ passed:true });
  expect((await get(`tasks/${a.key}`)).json()).toMatchObject({ gate:{ passed:5,total:5 } });
  expect((await owner.query("select kind from runner_jobs where kind='integrate'")).rows).toEqual([{ kind:'integrate' }]);
  expect((await owner.query('select kind from defect_events')).rows).toEqual([{ kind:'resolved' }]);
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'gate' }]);
});

test.each(['PASS','BLOCKED'])('%s에 모순된 결함을 함께 보고해도 새 결함을 저장하지 않고 검증 흐름을 유지한다', async outcome => {
  const a = await running(); await check(a); expect((await report(a)).statusCode).toBe(201);
  const qa = await next(a);
  expect((await report(qa,'FAIL',{ verification:{ ...result(qa).verification,result:'FAIL',defects:[{ text:'기존 차단 결함',blocking:true }] } })).statusCode).toBe(201);
  const rework = await next(qa); await check(rework); expect((await report(rework)).statusCode).toBe(201);
  const reverify = await next(rework);
  const r = await report(reverify,outcome,{ verification:{ ...result(reverify).verification,result:outcome,
    defects:[{ text:'모순된 차단 결함',blocking:true },{ text:'모순된 비차단 결함',blocking:false }] } });
  expect(r.statusCode,r.body).toBe(201);
  expect((await owner.query('select content from defects order by def_key')).rows).toEqual([{ content:'기존 차단 결함' }]);
  const current = (await get(`tasks/${a.key}/verifications`)).json().items.find((v: { attemptId: string }) => v.attemptId === reverify.attempt);
  expect(current).toMatchObject({ result:outcome,defects:[] });
  expect((await owner.query('select kind from defect_events')).rows).toEqual(outcome === 'PASS' ? [{ kind:'resolved' }] : []);
  if (outcome === 'BLOCKED') {
    expect((await owner.query('select status,verif_state from tasks where id=$1',[a.id])).rows).toEqual([{ status:'verifying',verif_state:'blocked' }]);
    expect((await owner.query("select * from runner_jobs where kind='integrate'")).rowCount).toBe(0);
    expect((await get(`tasks/${a.key}/gate`)).json()).toMatchObject({ passed:false,conditions:expect.arrayContaining([expect.objectContaining({ key:'defects',result:'FAIL' })]) });
    const request = await app.inject({ method:'POST',url:`/api/tasks/${a.key}/runs`,headers:lead(),payload:{ updatedAt:await version(a.key),kind:'reverify' } });
    expect(request.statusCode,request.body).toBe(202);
    expect((await report(await next(reverify))).statusCode).toBe(201);
  }
  expect((await get(`tasks/${a.key}/gate`)).json()).toMatchObject({ passed:true });
  expect((await owner.query("select kind from runner_jobs where kind='integrate'")).rows).toEqual([{ kind:'integrate' }]);
});

test('BLOCKED는 체크리스트와 상태를 보존하고 자동 반복하지 않으며 버튼으로 새 검증을 만든다', async () => {
  const a = await running('qa'); await check(a);
  const blocked = await report(a,'BLOCKED'); expect(blocked.statusCode,blocked.body).toBe(201);
  expect((await owner.query('select status,verif_state from tasks where id=$1',[a.id])).rows).toEqual([{ status:'qa',verif_state:'blocked' }]);
  expect((await owner.query('select done from checklist_items where task=$1',[a.id])).rows).toEqual([{ done:false }]);
  expect((await post('jobs/claim',{ kinds:['attempt'],capacity:20 })).statusCode).toBe(204);
  const request = await app.inject({ method:'POST',url:`/api/tasks/${a.key}/runs`,headers:lead(),payload:{ updatedAt:await version(a.key),kind:'qa' } });
  expect(request.statusCode,request.body).toBe(202);
  const retry = await next(a); expect(retry.attempt).not.toBe(a.attempt);
  expect((await report(retry)).statusCode).toBe(201);
  expect((await get(`tasks/${a.key}/verifications`)).json().items.map((v: { result: string }) => v.result).sort()).toEqual(['BLOCKED','PASS']);
});

test('QA 프로세스 오류는 검증 FAIL이 아니며 같은 종류의 새 시도를 자동으로 두 번만 만든다', async () => {
  let a = await running('qa'); await check(a);
  for (let i = 0; i < 3; i++) {
    const status = await post(`attempts/${a.attempt}/status`,{ fence:a.fence,status:'failed',at:new Date().toISOString(),model:'gpt-6.1-sol',effort:'high' });
    expect(status.statusCode,status.body).toBe(204);
    expect((await owner.query('select verif_state from tasks where id=$1',[a.id])).rows).toEqual([{ verif_state:'none' }]);
    expect((await post(`jobs/${a.job}/release`,{ fence:a.fence,hostId:'host-a',proof:{ kind:'no_process',bootId:'boot-a' },at:new Date().toISOString() })).statusCode).toBe(204);
    if (i < 2) a = await next(a);
  }
  expect((await post('jobs/claim',{ kinds:['attempt'],capacity:20 })).statusCode).toBe(204);
  expect((await owner.query('select * from verifications')).rowCount).toBe(0);
  expect((await owner.query('select count(*)::int n from task_attempts')).rows).toEqual([{ n:3 }]);
});

test.each(['head','spec','input'])('낡은 %s의 PASS는 기록만 남기고 Gate·체크리스트에 반영하지 않는다', async which => {
  const a = await running('qa'); await check(a);
  if (which === 'head') await owner.query('update task_attempts set head_sha=$2 where id=$1',[a.attempt,otherSha]);
  if (which === 'spec') await owner.query('update task_specs set revision=2 where task=$1',[a.id]);
  if (which === 'input') {
    const changed = ((await owner.query("insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,2,$2,'[]','[]','[]','') returning id",[project,otherSha])).rows[0] as { id: string }).id;
    await owner.query('update tasks set src_input_version=$2 where id=$1',[a.id,changed]);
  }
  const r = await report(a); expect(r.statusCode,r.body).toBe(201);
  expect((await get(`tasks/${a.key}/gate`)).json()).toMatchObject({ passed:false,conditions:expect.arrayContaining([expect.objectContaining({ key:'verification',result:'BLOCKED' })]) });
  expect((await owner.query('select done from checklist_items where task=$1',[a.id])).rows).toEqual([{ done:false }]);
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'qa' }]);
  expect((await owner.query('select count(*)::int n from verification_invalidations')).rows).toEqual([{ n:1 }]);
});

test('열린 슬롯·낡은 fence·다른 종류 본문·다른 시도의 증거는 결과를 저장하지 않는다', async () => {
  const a = await running('qa','reserved'); await check(a);
  expect((await report(a)).statusCode).toBe(409);
  await owner.query("update execution_holds set slot_state='none',release_proof='no_process' where job=$1",[a.job]);
  expect((await report(a,'PASS',{ fence:0 })).statusCode).toBe(409);
  const noVerification = { ...result(a) }; delete noVerification.verification;
  expect((await post(`attempts/${a.attempt}/result`,noVerification)).statusCode).toBe(400);
  expect((await report(a,'PASS',{ evidence:[randomUUID()] })).statusCode).toBe(400);
  expect((await owner.query('select * from verifications')).rowCount).toBe(0);
});

test('중단 뒤 결과는 소유자·fence를 확인하고 요약만 남긴 뒤 ATTEMPT_CLOSED로 거부한다', async () => {
  const a = await running('qa');
  await watchRunner(pool, 1, new Date(Date.now() + 600_000));
  const other = await issueRunnerToken(pool, 'late-result-other', '시험');
  const body = { ...result(a), summary: '늦게 도착한 결과', tokens: 999, changedFiles: ['늦은-파일.ts'] };
  expect((await post(`attempts/${a.attempt}/result`, body, { ...headers(), authorization: `Bearer ${other}` })).json()).toMatchObject({ error: { code: 'LEASE_LOST' } });
  expect((await post(`attempts/${a.attempt}/result`, { ...body, fence: a.fence + 1 })).json()).toMatchObject({ error: { code: 'LEASE_LOST' } });
  expect((await owner.query("select count(*)::int n from task_history where kind='중단 뒤 결과 수신'")).rows).toEqual([{ n: 0 }]);
  const lateHeaders = headers();
  const late = await post(`attempts/${a.attempt}/result`, body, lateHeaders);
  expect(late.statusCode).toBe(409);
  expect(late.json()).toMatchObject({ error: { code: 'ATTEMPT_CLOSED' } });
  const replay = await post(`attempts/${a.attempt}/result`, body, lateHeaders);
  expect(replay.statusCode).toBe(409);
  expect(replay.body).toBe(late.body);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect((await post(`attempts/${a.attempt}/result`, { ...body, summary: '다른 요약' }, lateHeaders)).json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  expect((await owner.query("select ref from task_history where kind='중단 뒤 결과 수신'")).rows).toEqual([{ ref: { attemptId: a.attempt, summary: '늦게 도착한 결과' } }]);
  expect((await owner.query('select status,summary,tokens from task_attempts where id=$1', [a.attempt])).rows).toEqual([{ status: 'interrupted', summary: null, tokens: null }]);
  expect((await owner.query('select count(*)::int n from verifications')).rows).toEqual([{ n: 0 }]);
  expect((await owner.query('select count(*)::int n from attempt_files')).rows).toEqual([{ n: 0 }]);
  expect((await get(`tasks/${a.key}`)).json()).toMatchObject({ lifecycleStatus: 'paused' });
});

test('아직 claim하지 않은 실행 job도 Task 삭제를 막는다', async () => {
  const a = await running();
  await owner.query('set session_replication_role=replica');
  await owner.query('delete from execution_holds where job=$1',[a.job]);
  await owner.query('delete from task_attempts where id=$1',[a.attempt]);
  await owner.query("update runner_jobs set state='queued',lease_owner=null,lease_until=null where id=$1",[a.job]);
  await owner.query("update tasks set status='ready' where id=$1",[a.id]);
  await owner.query('set session_replication_role=origin');
  const deleted = await app.inject({ method:'DELETE',url:`/api/tasks/${a.key}?updatedAt=${encodeURIComponent(await version(a.key))}`,headers:lead() });
  expect(deleted.statusCode,deleted.body).toBe(409);
  expect((await get(`tasks/${a.key}`)).json()).toMatchObject({ deletedAt:null });
});

test('Evidence는 해시·크기를 검사해 저장하고 첨부 다운로드로만 제공한다', async () => {
  const a = await running('qa'); await check(a);
  const bytes = Buffer.from('<script>시험</script>');
  async function upload(hash: string, size = bytes.length) {
    const form = new FormData();
    form.set('file',new Blob([bytes]),'../../attack.html'); form.set('kind','시험');
    form.set('sha256',hash); form.set('size',String(size)); form.set('fence','1');
    const request = new Request('http://localhost',{ method:'POST',body:form });
    return app.inject({ method:'POST',url:`/api/runner/attempts/${a.attempt}/evidence`,headers:{ ...headers(),'content-type':request.headers.get('content-type') ?? '' },payload:Buffer.from(await request.arrayBuffer()) });
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  expect((await upload('0'.repeat(64))).statusCode).toBe(400);
  expect((await upload(hash,1)).statusCode).toBe(400);
  const uploaded = await upload(hash); expect(uploaded.statusCode,uploaded.body).toBe(201);
  const id = uploaded.json().id as string;
  const download = await get(`evidence/${id}/content`);
  expect(download.rawPayload).toEqual(bytes);
  expect(download.headers['content-disposition']).toMatch(/^attachment;/);
  expect(download.headers['x-content-type-options']).toBe('nosniff');
  const r = await report(a,'PASS',{ evidence:[id],verification:{ ...result(a).verification,checklist:[{ itemKey:'CL-1',done:true,evidence:id }] } });
  expect(r.statusCode,r.body).toBe(201);
  expect((await get(`evidence?taskKey=${a.key}`)).json().items).toMatchObject([{ id,attemptId:a.attempt,verificationId:expect.any(String),checklistItemKey:'CL-1',sha256:hash,size:bytes.length }]);
});

test.each(['자동','버튼'])('%s 완료는 실제 병합·통합과 서버가 고정한 basePipelineSha를 다시 대조한다', async mode => {
  const a = await running('qa'); await check(a); expect((await report(a)).statusCode).toBe(201);
  const complete = () => app.inject({ method:'POST',url:`/api/tasks/${a.key}/complete`,headers:lead(),payload:{ updatedAt:awaitVersion } });
  let awaitVersion = await version(a.key);
  expect((await complete()).statusCode).toBe(409);
  const verification = ((await owner.query('select id from verifications where attempt=$1',[a.attempt])).rows[0] as { id: string }).id;
  const job = ((await owner.query("select id from runner_jobs where kind='integrate'")).rows[0] as { id: string }).id;
  await owner.query('update runner_jobs set fence=1 where id=$1',[job]);
  const ci = ((await owner.query("insert into ci_runs(project_id,run_key,stage,pipeline_sha,head_sha,base_sha,tree_sha,ref,task,trigger,status,job,fence) values($1,$2,2,$3,$4,$4,$5,'agent/test',$6,'int','pass',$7,1) returning id",[project,randomUUID(),otherSha,sha,otherSha,a.id,job])).rows[0] as { id: string }).id;
  await owner.query("insert into merge_queue(project_id,task,pr,position,status,qa_head_sha,synced_head_sha,base_sha,verification,ci_run,tested_tree_sha,actual_merge_sha,actual_tree_sha) values($1,$2,1,1,'merged',$3,$3,$3,$4,$5,$6,$7,$6)",[project,a.id,sha,verification,ci,otherSha,'d'.repeat(40)]);
  await owner.query('update merge_queue set merge_parents=$2::jsonb where task=$1',[a.id,JSON.stringify([sha,sha])]);
  expect((await complete()).json()).toMatchObject({ error:{ code:'GATE_NOT_PASSED' } });
  await owner.query('update ci_runs set pipeline_sha=$2 where id=$1',[ci,pipeline]);
  await owner.query('update merge_queue set merge_parents=null where task=$1',[a.id]);
  expect((await complete()).statusCode).toBe(409);
  await owner.query('update merge_queue set merge_parents=$2::jsonb where task=$1',[a.id,JSON.stringify([sha,sha])]);
  awaitVersion = await version(a.key);
  if (mode === '자동') {
    await inEpoch(pool,1,client => completeMergedTask(client,a.key,pipeline));
    expect((await get(`tasks/${a.key}`)).json()).toMatchObject({ lifecycleStatus:'done' });
  } else {
    const r = await complete(); expect(r.statusCode,r.body).toBe(200);
    expect(r.json()).toMatchObject({ task:{ lifecycleStatus:'done' } });
  }
  expect((await owner.query('select act_end is not null ended from tasks where id=$1',[a.id])).rows).toEqual([{ ended:true }]);
});

test('낡은 PASS를 낸 QA는 원인을 고친 뒤 같은 종류의 새 시도로 검증한다', async () => {
  const a = await running('qa'); await check(a);
  expect((await report(a,'PASS',{ verification:{ ...result(a).verification,headSha:otherSha } })).statusCode).toBe(201);
  const r = await app.inject({ method:'POST',url:`/api/tasks/${a.key}/runs`,headers:lead(),payload:{ updatedAt:await version(a.key),kind:'qa' } });
  expect(r.statusCode,r.body).toBe(202);
  const retry = await next(a);
  expect((await report(retry)).statusCode).toBe(201);
});

test('QA 시작 때 검사한 head와 다른 커밋은 새 시도를 만들지 않는다', async () => {
  const a = await running(); await check(a); expect((await report(a)).statusCode).toBe(201);
  const claimed = await post('jobs/claim',{ kinds:['attempt'],capacity:20 });
  const job = claimed.json().job as { id: string; fence: number };
  const r = await post(`jobs/${job.id}/start`,{ fence:job.fence,hostId:'host-a',bootId:'boot-a',headSha:otherSha,installedSubagents:[] });
  expect(r.statusCode,r.body).toBe(409);
  expect((await owner.query('select * from task_attempts where task=$1',[a.id])).rowCount).toBe(1);
});

test('명세가 바뀐 뒤 보고 본문만 최신 revision으로 바꿔도 과거 QA를 PASS로 쓸 수 없다', async () => {
  const a = await running('qa'); await check(a);
  await owner.query('update task_specs set revision=2 where task=$1',[a.id]);
  const r = await report(a,'PASS',{ verification:{ ...result(a).verification,specRevision:2 } });
  expect(r.statusCode,r.body).toBe(201);
  expect((await get(`tasks/${a.key}/gate`)).json()).toMatchObject({ passed:false });
  expect((await owner.query('select done from checklist_items where task=$1',[a.id])).rows).toEqual([{ done:false }]);
});

test('Gate에서 참조 입력 버전만 바뀌어도 무효 기록을 남기고 대기 통합을 취소한다', async () => {
  const a = await running('qa'); await check(a); expect((await report(a)).statusCode).toBe(201);
  await inEpoch(pool,1,async client => {
    const changed = ((await client.query("insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,2,$2,'[]','[]','[]','') returning id",[project,otherSha])).rows[0] as { id: string }).id;
    await client.query('update tasks set src_input_version=$2 where id=$1',[a.id,changed]);
    expect(await invalidateTaskGate(client,a.key)).toBe(true);
  });
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'verifying' }]);
  expect((await owner.query("select state from runner_jobs where kind='integrate'")).rows).toEqual([{ state:'cancelled' }]);
  expect((await get(`tasks/${a.key}/verifications`)).json().items).toMatchObject([{ result:'PASS',invalidated:true }]);
});

test('개발 결과의 실행 오류는 ① 없이 실패로 보존하고 같은 종류로 재시도한다', async () => {
  const a = await running();
  const r = await report(a,'PASS',{ failure:'가짜 CLI 프로세스 오류' });
  expect(r.statusCode,r.body).toBe(201);
  expect((await owner.query('select status,failure from task_attempts where id=$1',[a.attempt])).rows).toEqual([{ status:'failed',failure:{ reason:'가짜 CLI 프로세스 오류' } }]);
  expect((await next(a)).kind).toBe('dev');
  expect((await owner.query('select * from verifications')).rowCount).toBe(0);
});

test('자동 재작업은 3회에서 멈추고 마지막 QA job과 잠금도 닫는다', async () => {
  let a = await running(); await check(a); expect((await report(a)).statusCode).toBe(201);
  a = await next(a);
  for (let round = 0; round < 4; round++) {
    const r = await report(a,'FAIL'); expect(r.statusCode,r.body).toBe(201);
    if (round < 3) {
      const rework = await next(a); expect(rework.kind).toBe('rework');
      await check(rework); expect((await report(rework)).statusCode).toBe(201);
      a = await next(rework);
    }
  }
  expect((await post('jobs/claim',{ kinds:['attempt'],capacity:20 })).statusCode).toBe(204);
  expect((await owner.query("select count(*)::int n from task_attempts where kind='rework'")).rows).toEqual([{ n:3 }]);
  expect((await owner.query('select state from runner_jobs where id=$1',[a.job])).rows).toEqual([{ state:'done' }]);
  expect((await owner.query("select * from execution_holds where lock_state='held'")).rowCount).toBe(0);
});

test('병합한 계약대로 모델 보고의 rank는 거부하고 서버 설정의 순서로 등급을 계산한다', async () => {
  const a = await running();
  const report = { agent:'Codex',models:[{ id:'gpt-6.1-sol',label:'보고',efforts:['high','xhigh','max'] }] };
  expect((await post('models',{ ...report,models:[{ ...report.models[0],rank:999 }] })).statusCode).toBe(400);
  expect((await post('models',report)).statusCode).toBe(200);
  const rank = ((await owner.query('select model_settings from app_settings')).rows[0] as { model_settings: { rankOrder: { Codex: string[] } } }).model_settings.rankOrder.Codex.indexOf('gpt-6.1-sol')+1;
  expect((await owner.query("select rank from agent_models where agent='Codex' and model_id='gpt-6.1-sol'")).rows).toEqual([{ rank }]);
  const policy = await app.inject({ url:'/api/runner/policy',headers:headers() });
  expect(policy.statusCode,policy.body).toBe(200);
  expect(policy.json()).toMatchObject({ claudeModels:expect.arrayContaining(['claude-opus-5-5']),cliGrades:[] });
  expect((await app.inject({ url:`/api/runner/tasks/${a.key}/run-grade?role=dev`,headers:headers() })).statusCode).toBe(200);
});

test('Gate에서 명세 변경 뒤 새 ① 검사를 하면 새 revision의 재검증을 시작할 수 있다', async () => {
  const a = await running('qa'); await check(a); expect((await report(a)).statusCode).toBe(201);
  await inEpoch(pool,1,async client => {
    await client.query('update task_specs set revision=2 where task=$1',[a.id]);
    await invalidateTaskGate(client,a.key);
  });
  const freshCheck = await check(a);
  await owner.query('set session_replication_role=replica');
  await owner.query("update ci_runs set created_at='2000-01-01' where id=$1",[freshCheck]);
  await owner.query('set session_replication_role=origin');
  const request = await app.inject({ method:'POST',url:`/api/tasks/${a.key}/runs`,headers:lead(),payload:{ updatedAt:await version(a.key),kind:'reverify' } });
  expect(request.statusCode,request.body).toBe(202);
  const retry = await next(a); expect(retry.kind).toBe('reverify');
  expect((await report(retry,'PASS',{ verification:{ ...result(retry).verification,specRevision:2 } })).statusCode).toBe(201);
  expect((await get(`tasks/${a.key}/gate`)).json()).toMatchObject({ passed:true });
});

test('자동 생성된 통합 job은 계약의 PR 번호와 검사할 commit을 포함한다', async () => {
  const a = await running('qa'); await check(a); expect((await report(a)).statusCode).toBe(201);
  const claimed = await post('jobs/claim',{ kinds:['integrate'],capacity:20 });
  expect(claimed.statusCode,claimed.body).toBe(200);
  expect(claimed.json()).toMatchObject({ job:{ kind:'integrate',payload:{ pr:1,commit:sha } } });
});

test('같은 시도의 동시 결과 20개도 검증과 후속 job을 하나만 저장한다', async () => {
  const a = await running(); await check(a);
  const results = await Promise.all(Array.from({ length:20 },() => report(a)));
  expect(results.filter(r => r.statusCode === 201)).toHaveLength(1);
  expect(results.every(r => [201,409].includes(r.statusCode))).toBe(true);
  expect((await owner.query("select * from runner_jobs where payload->>'kind'='qa'")).rowCount).toBe(1);
  expect((await owner.query("select * from task_history where kind='시도 결과'")).rowCount).toBe(1);
});

test('이력 저장 실패는 검증·결함·체크·상태·인계 전체를 되돌리고 같은 키 재요청을 허용한다', async () => {
  const a = await running('qa'); await check(a);
  await owner.query("create function public.fail_execution_history() returns trigger language plpgsql as 'begin if NEW.kind=''시도 결과'' then raise exception ''시험 실패 주입''; end if; return NEW; end'");
  await owner.query('create trigger fail_execution_history before insert on task_history for each row execute function public.fail_execution_history()');
  const h = headers(), payload = result(a,'FAIL',{ verification:{ ...result(a).verification,result:'FAIL',defects:[{ text:'결함',blocking:true }] } });
  try {
    expect((await post(`attempts/${a.attempt}/result`,payload,h)).statusCode).toBe(500);
  } finally {
    await owner.query('drop trigger fail_execution_history on task_history');
    await owner.query('drop function public.fail_execution_history()');
  }
  expect((await owner.query('select status from task_attempts where id=$1',[a.attempt])).rows).toEqual([{ status:'running' }]);
  expect((await owner.query('select * from verifications')).rowCount).toBe(0);
  expect((await owner.query('select * from defects')).rowCount).toBe(0);
  expect((await owner.query('select done from checklist_items where task=$1',[a.id])).rows).toEqual([{ done:false }]);
  expect((await owner.query('select lock_state from execution_holds where job=$1',[a.job])).rows).toEqual([{ lock_state:'held' }]);
  expect((await post(`attempts/${a.attempt}/result`,payload,h)).statusCode).toBe(201);
});

test('Gate의 마지막 체크를 채우면 버튼 승인 없이 통합 job을 만든다', async () => {
  const a = await running('qa'); await check(a);
  const r = await report(a,'PASS',{ verification:{ ...result(a).verification,checklist:[{ itemKey:'CL-1',done:false }] } });
  expect(r.statusCode,r.body).toBe(201);
  expect((await owner.query("select * from runner_jobs where kind='integrate'")).rowCount).toBe(0);
  const updated = await app.inject({ method:'PATCH',url:`/api/tasks/${a.key}/checklist/CL-1`,headers:lead(),payload:{ updatedAt:await version(a.key),done:true } });
  expect(updated.statusCode,updated.body).toBe(200);
  expect((await owner.query("select * from runner_jobs where kind='integrate'")).rowCount).toBe(1);
});

test('① 시작 때 고정한 명세와 입력 근거를 나중에 덮어쓸 수 없다', async () => {
  const a = await running();
  const id = await check(a);
  await expect(owner.query('update ci_runs set spec_revision=99 where id=$1',[id])).rejects.toMatchObject({ code:'23514' });
});

test.each([false,true])('실행 실패=%s인 개발 결과의 변경 파일은 성공 때만 산출물 제출로 연결한다', async failed => {
  const a = await running(); await check(a);
  await owner.query("update task_outputs set name='src/*',delivered=false where task=$1",[a.id]);
  const r = await report(a,'PASS',{ changedFiles:['src/api.ts'],...(failed ? { failure:'가짜 실행 실패' } : {}) });
  expect(r.statusCode,r.body).toBe(201);
  expect((await owner.query('select delivered,delivered_attempt from task_outputs where task=$1',[a.id])).rows).toEqual([{ delivered:!failed,delivered_attempt:failed ? null : a.attempt }]);
});

test('QA FAIL은 선택 체크리스트를 미완료로 되돌린다', async () => {
  const a = await running('qa'); await check(a);
  await owner.query('update checklist_items set done=true where task=$1',[a.id]);
  expect((await report(a,'FAIL')).statusCode).toBe(201);
  expect((await owner.query('select done from checklist_items where task=$1',[a.id])).rows).toEqual([{ done:false }]);
});

test.each(['tokens','specRevision'])('저장 범위를 넘는 %s 숫자는 업무 변경 전에 입력 오류로 거부한다', async field => {
  const a = await running('qa'); await check(a);
  const r = await report(a,'PASS',field === 'tokens' ? { tokens:1e30 } : { verification:{ ...result(a).verification,specRevision:1e30 } });
  expect(r.statusCode,r.body).toBe(400);
  expect((await owner.query('select status from task_attempts where id=$1',[a.attempt])).rows).toEqual([{ status:'running' }]);
});

test('Gate 뒤 브랜치 head가 바뀌면 옛 시도를 보존하고 새 head에서 재검증한다', async () => {
  const a = await running('qa'); await check(a); expect((await report(a)).statusCode).toBe(201);
  await inEpoch(pool,1,async client => { expect(await invalidateTaskGate(client,a.key,otherSha)).toBe(true); });
  expect((await get(`tasks/${a.key}/gate`)).json()).toMatchObject({ passed:false });
  await check(a,otherSha);
  const request = await app.inject({ method:'POST',url:`/api/tasks/${a.key}/runs`,headers:lead(),payload:{ updatedAt:await version(a.key),kind:'reverify' } });
  expect(request.statusCode,request.body).toBe(202);
  const retry = await next(a,otherSha);
  expect((await report(retry,'PASS',{ verification:{ ...result(retry).verification,headSha:otherSha } })).statusCode).toBe(201);
  expect((await get(`tasks/${a.key}/gate`)).json()).toMatchObject({ passed:true });
  expect((await owner.query('select head_sha from task_attempts where id=$1',[a.attempt])).rows).toEqual([{ head_sha:sha }]);
});

test('조정자 결정 3(0040): cgroup이 기록된 보유는 같은 경로·그룹의 cgroup_empty로만, cgroup 없는 보유는 group_empty로만 닫힌다', async () => {
  const cgroup = `/user.slice/user-1000.slice/user@1000.service/app.slice/awbs-${randomUUID()}.scope`;
  const at = () => new Date().toISOString();
  const scoped = await running('dev', 'reserved');
  // 경로 모양이 아니면 /process가 거부한다.
  for (const bad of ['relative/x.scope', '/a//b', '/a/../b', '/a b']) {
    expect((await post(`jobs/${scoped.job}/process`, { fence: 1, processGroup: 4242, cgroup: bad })).statusCode, bad).toBe(400);
  }
  expect((await post(`jobs/${scoped.job}/process`, { fence: 1, processGroup: 4242, cgroup })).statusCode).toBe(204);
  const release = (proof: object) => post(`jobs/${scoped.job}/slots/release`, { fence: 1, hostId: 'host-a', proof, at: at() });
  expect((await release({ kind: 'group_empty', bootId: 'boot-a', processGroup: 4242 })).statusCode).toBe(409);
  expect((await release({ kind: 'cgroup_empty', bootId: 'boot-a', processGroup: 4242, cgroup: cgroup.replace('awbs-', 'awbs-x') })).statusCode).toBe(409);
  expect((await release({ kind: 'cgroup_empty', bootId: 'boot-a', processGroup: 4243, cgroup })).statusCode).toBe(409);
  expect((await release({ kind: 'cgroup_empty', bootId: 'boot-a', processGroup: 4242, cgroup })).statusCode).toBe(204);
  expect((await owner.query('select slot_state,release_proof::text proof from execution_holds where job=$1', [scoped.job])).rows[0]).toEqual({ slot_state: 'none', proof: 'cgroup_empty' });

  const plain = await running('dev', 'reserved');
  expect((await post(`jobs/${plain.job}/process`, { fence: 1, processGroup: 4244, cgroup: null })).statusCode).toBe(204);
  expect((await post(`jobs/${plain.job}/slots/release`, { fence: 1, hostId: 'host-a', proof: { kind: 'cgroup_empty', bootId: 'boot-a', processGroup: 4244, cgroup }, at: at() })).statusCode).toBe(409);
  expect((await post(`jobs/${plain.job}/slots/release`, { fence: 1, hostId: 'host-a', proof: { kind: 'group_empty', bootId: 'boot-a', processGroup: 4244 }, at: at() })).statusCode).toBe(204);

  // DB 트리거도 같은 규칙을 지킨다(서비스를 거치지 않은 쓰기).
  const direct = await running('dev', 'reserved');
  await owner.query("update execution_holds set slot_state='active',pgid=4245,cgroup=$2 where job=$1", [direct.job, cgroup]);
  await expect(owner.query("update execution_holds set slot_state='none',release_proof='group_empty' where job=$1", [direct.job])).rejects.toThrow(/release proof/);
  await owner.query("update execution_holds set slot_state='none',release_proof='cgroup_empty' where job=$1", [direct.job]);
});

test('M8 선행: 시계가 뒤로 가도 API의 시도 번호(attemptNo)·검증 순번(seq)과 보고서의 최신 시도·검증·FAIL 뒤 메시지·직전 재조정은 서버 순서·연결을 따른다', async () => {
  // QA 시도(번호 1) FAIL → 재검증 시도(번호 2) FAIL. 나중 시도·검증이지만 PC 시계가 뒤로 가서 시각은 2.3초 이르다.
  const a = await running('qa');
  await owner.query("update task_attempts set started_at=now()-interval '10 minutes',ended_at=now()-interval '5 minutes',status='completed' where id=$1", [a.attempt]);
  // 메시지(Codex 리뷰 P2-2): 「FAIL 뒤」는 서버 저장 순서로 가른다. 넣는 순서가 곧 서버 순서이고, 시각(created_at)은 일부러 거꾸로 준다.
  const msg = (key: string, attempt: string | null, at: string, draft = false) => owner.query(`insert into messages(project_id,task,msg_key,attempt,dir,type,to_agent,body,delivery,pending_next,work_state,draft,created_at)
    values($1,$2,$3,$4,'out','수정 요청','Codex','지시',$5,false,'',$6,${at})`, [project, a.id, key, attempt, draft ? 'Draft' : 'Sent', draft]);
  // MSG-904: QA 시도가 실행 중일 때 그 시도에 보낸 지시. FAIL(v1)보다 먼저 보냈지만 시각은 v1보다 늦다 → 어느 FAIL의 「뒤 메시지」도 아니다.
  await msg('MSG-904', a.attempt, "now()-interval '4 minutes'");
  const v1 = ((await owner.query(`insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual,created_at)
    values($1,$2,'FAIL',$3,1,'pnpm test','성공','옛 FAIL',now()-interval '5 minutes') returning id`, [project, a.attempt, sha])).rows[0] as { id: string }).id;
  // MSG-903: v1 뒤에 시도를 지정하지 않고 보낸 수정 지시. 시각은 v1보다 이르다 → v1의 「뒤 메시지」다.
  await msg('MSG-903', null, "now()-interval '6 minutes'");
  // MSG-905: v2 전에 초안으로 만들고, v2 뒤에 보냈다(초안→전송). 판정은 「보낸」 기록 기준 → v1·v2 모두의 「뒤 메시지」다.
  await msg('MSG-905', null, "now()-interval '7 minutes'", true);
  const job = ((await owner.query(`insert into runner_jobs(project_id,epoch,kind,payload,dedup_key,state,fence,generation) values($1,1,'attempt',$2,$3,'done',1,1) returning id`,
    [project, { taskKey: a.key, kind: 'reverify', agent: 'Codex', baseCommit: sha, branch: `agent/${a.key}-h1` }, randomUUID()])).rows[0] as { id: string }).id;
  const second = ((await owner.query(`insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,input_version,kind,agent,status,started_at,ended_at,model_id,effort,branch,generation)
    values($1,$2,$3,2,$4,$5,$5,1,$6,'reverify','Codex','completed',now()-interval '10 minutes 2.3 seconds',now()-interval '5 minutes 2.3 seconds','gpt-6.1-sol','high',$7,1) returning id`,
  [project, a.id, `${a.key}-A2`, job, sha, input, `agent/${a.key}-h1`])).rows[0] as { id: string }).id;
  const v2 = ((await owner.query(`insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual,created_at)
    values($1,$2,'FAIL',$3,1,'pnpm test','성공','최신 FAIL',now()-interval '5 minutes 2.3 seconds') returning id`, [project, second, sha])).rows[0] as { id: string }).id;
  await owner.query("update messages set draft=false,delivery='Queued' where msg_key='MSG-905'");
  await owner.query("update tasks set status='rework' where id=$1", [a.id]);
  // 같은 트랜잭션에서 함께 넣은 검증·메시지도 이력 순번(seq)이 실제 실행 순서다(Codex 재리뷰 P2) → 벽시계로 되돌아가지 않는다.
  // MSG-906은 v3 뒤에 넣었고 시각만 v3보다 이르다 → v3의 「뒤 메시지」다.
  const b = await running('qa');
  await owner.query("update task_attempts set started_at=now()-interval '10 minutes',ended_at=now()-interval '3 minutes',status='completed' where id=$1", [b.attempt]);
  const tx = await owner.connect();
  const v3 = await (async () => { try {
    await tx.query('begin');
    const id = ((await tx.query(`insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual,created_at)
      values($1,$2,'FAIL',$3,1,'pnpm test','성공','일괄 FAIL',now()-interval '3 minutes') returning id`, [project, b.attempt, sha])).rows[0] as { id: string }).id;
    await tx.query(`insert into messages(project_id,task,msg_key,attempt,dir,type,to_agent,body,delivery,pending_next,work_state,draft,created_at)
      values($1,$2,'MSG-906',null,'out','수정 요청','Codex','일괄','Sent',false,'',false,now()-interval '4 minutes')`, [project, b.id]);
    await tx.query('commit');
    return id;
  } finally { tx.release(); } })();
  // 재조정(시계 역행): RP-002가 나중 번호지만 시각은 RP-001보다 2.3초 이르다. 둘 다 사흘 전(기간 시작 전)이다 → 직전·마지막 재조정은 RP-002.
  const replan = (key: string, end: string, at: string) => owner.query(`insert into replans(project_id,rp_key,trigger,actor,baseline_v,status,before,after,created_at)
    values($1,$2,'시험','시스템',1,'applied','{"end":null}',$3::jsonb,now()-interval '3 days'-interval '${at}')`, [project, key, JSON.stringify({ end, lo: end, hi: end })]);
  await replan('RP-001', '2026-12-01', '0 seconds');
  await replan('RP-002', '2026-12-09', '2.3 seconds');

  const attempts = (await get(`tasks/${a.key}/attempts`)).json().items as { id: string; attemptNo: number; startedAt: string }[];
  const byId = new Map(attempts.map((x) => [x.id, x]));
  expect([byId.get(a.attempt)?.attemptNo, byId.get(second)?.attemptNo]).toEqual([1, 2]);
  expect((byId.get(second)?.startedAt ?? '') < (byId.get(a.attempt)?.startedAt ?? '')).toBe(true);
  for (const path of [`tasks/${a.key}/verifications`, `verifications?taskKey=${a.key}`]) {
    const res = await get(path);
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as { id: string; seq: number; at: string }[];
    const old = items.find((x) => x.id === v1), latest = items.find((x) => x.id === v2);
    expect(latest && old && latest.seq > old.seq, path).toBe(true);
    expect(latest && old && latest.at < old.at, path).toBe(true);
  }

  const { buildSnapshot } = await import('../src/reports/snapshot.ts');
  const client = await owner.connect();
  try {
    // 기간: 어제~오늘(KST). 자정 직후에 돌려도 몇 분 전 기록이 기간 안에 든다.
    const day = (offset: number) => new Date(Date.now() + 9 * 3600_000 - offset * 86_400_000).toISOString().slice(0, 10);
    const snap = await buildSnapshot(client, project, { kind: 'custom', from: day(1), to: day(0), at: new Date(Date.now() + 1000).toISOString() }, 'live');
    const row = snap.active.find((t) => t.taskKey === a.key);
    expect(row?.lastAttempt?.attemptKey).toBe(`${a.key}-A2`);
    expect(row?.verification?.id).toBe(v2);
    const fail = (id: string) => snap.failures.find((f) => f.verificationId === id)?.messages.map((m) => m.msgKey);
    // 목록 표시 순서는 시각순(표시용)이다. 포함 여부만 서버 순서로 정한다.
    expect(fail(v1)).toEqual(['MSG-905', 'MSG-903']);
    expect(fail(v2)).toEqual(['MSG-905']);
    expect(fail(v3)).toEqual(['MSG-906']);
    expect(snap.issues.filter((i) => i.text.includes('판정 불가'))).toEqual([]);
    expect([snap.summary.forecast, snap.summary.forecastBefore]).toEqual(['2026-12-09', '2026-12-09']);
  } finally { client.release(); }
});

test('M8 선행: 이력이 없어 순서를 복원할 수 없는 메시지는 벽시계로 추정하지 않고 「FAIL 뒤 메시지」에서 빼며 경고한다', async () => {
  // c: 검증·메시지 모두 이력 시작 전 행(seed 기록만 있음) + 기록이 아예 없는 메시지 → 순서 복원 불가.
  // d: seed 메시지(이력 시작 전)와 실제 저장된 FAIL → 순서를 안다(seed가 먼저) → 「뒤 메시지」 아님, 경고 없음.
  const c = await running('qa'), d = await running('qa');
  for (const x of [c, d]) await owner.query("update task_attempts set started_at=now()-interval '10 minutes',ended_at=now()-interval '5 minutes',status='completed' where id=$1", [x.attempt]);
  const raw = await owner.connect();
  const seed = (tbl: string, id: string, data: object) => raw.query("insert into state_log(project_id,tbl,row_id,op,data) values($1,$2,$3,'seed',$4)", [project, tbl, id, data]);
  const insertMessage = async (task: string, key: string) => ((await raw.query(`insert into messages(project_id,task,msg_key,attempt,dir,type,to_agent,body,delivery,pending_next,work_state,draft,created_at)
    values($1,$2,$3,null,'out','수정 요청','Codex','옛 지시','Sent',false,'',false,now()-interval '1 minute') returning id`, [project, task, key])).rows[0] as { id: string }).id;
  const v4 = await (async () => { try {
    // 기록 트리거를 끄고 넣은 뒤, 0028처럼 seed 기록만 남긴다. 시각은 메시지가 FAIL보다 늦게 준다(시각으로 보면 「뒤」).
    await raw.query("set session_replication_role='replica'");
    const id = ((await raw.query(`insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual,created_at)
      values($1,$2,'FAIL',$3,1,'pnpm test','성공','옛 FAIL',now()-interval '5 minutes') returning id`, [project, c.attempt, sha])).rows[0] as { id: string }).id;
    await seed('verifications', id, { id });
    await seed('messages', await insertMessage(c.id, 'MSG-907'), { draft: false });
    await insertMessage(c.id, 'MSG-909'); // 기록이 아예 없다
    await seed('messages', await insertMessage(d.id, 'MSG-908'), { draft: false });
    return id;
  } finally { await raw.query("set session_replication_role='origin'"); raw.release(); } })();
  const v5 = ((await owner.query(`insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual,created_at)
    values($1,$2,'FAIL',$3,1,'pnpm test','성공','새 FAIL',now()-interval '5 minutes') returning id`, [project, d.attempt, sha])).rows[0] as { id: string }).id;

  const { buildSnapshot } = await import('../src/reports/snapshot.ts');
  const client = await owner.connect();
  try {
    const day = (offset: number) => new Date(Date.now() + 9 * 3600_000 - offset * 86_400_000).toISOString().slice(0, 10);
    const snap = await buildSnapshot(client, project, { kind: 'custom', from: day(1), to: day(0), at: new Date(Date.now() + 1000).toISOString() }, 'live');
    const fail = (id: string) => snap.failures.find((f) => f.verificationId === id)?.messages.map((m) => m.msgKey);
    expect(fail(v4)).toEqual([]);
    expect(fail(v5)).toEqual([]);
    const warns = snap.issues.filter((i) => i.text.includes('판정 불가'));
    expect(warns.map((i) => [i.level, i.taskKey])).toEqual([['warn', c.key]]);
    expect(warns[0]?.text).toContain('MSG-907, MSG-909');
  } finally { client.release(); }
});
