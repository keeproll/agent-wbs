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

// M2-09 runner-basic의 시나리오 6과 FakeRunner.result 순서(그룹 등록→슬롯 반환→결과 보고)를 실제 HTTP로 재현한다.
test('M2-09 시나리오 6: ① 자리표시로 개발→QA FAIL→재작업→재검증 PASS까지 진행한다', async () => {
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
  expect((await owner.query('select * from ci_runs')).rowCount).toBe(0);
  expect((await get(`tasks/${dev.key}/gate`)).json()).toMatchObject({ passed:false,conditions:expect.arrayContaining([expect.objectContaining({ key:'verification',result:'BLOCKED' })]) });
});

test('① 기록이 없어도 명세가 바뀐 개발 결과를 자리표시로 통과시키지 않는다', async () => {
  const a = await running();
  await owner.query('update task_specs set revision=2 where task=$1',[a.id]);
  expect((await report(a)).statusCode).toBe(409);
  expect((await owner.query('select status from task_attempts where id=$1',[a.attempt])).rows).toEqual([{ status:'running' }]);
});

test('자리표시 뒤 실제 ① FAIL이 기록되면 QA 예약을 거부한다', async () => {
  const a = await running();
  expect((await report(a)).statusCode).toBe(201);
  await check(a,sha,'fail');
  expect((await post('jobs/claim',{ kinds:['attempt'],capacity:20 })).statusCode).toBe(204);
  expect((await owner.query('select kind from task_attempts where task=$1',[a.id])).rows).toEqual([{ kind:'dev' }]);
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
  expect((await complete()).json()).toMatchObject({ error:{ code:'GATE_NOT_PASSED' } });
  await owner.query('update ci_runs set pipeline_sha=$2 where id=$1',[ci,pipeline]);
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
  await check(a);
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
