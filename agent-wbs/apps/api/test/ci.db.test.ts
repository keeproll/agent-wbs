import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import { installRunner } from '../src/runner/routes.ts';
import { installCiRunner } from '../src/ci/routes.ts';
import { resolveBasePipelineSha } from '../src/ci/service.ts';
import { installProjectRunner } from '../src/project/runner-routes.ts';
import { policyOf, scheduleInput } from '../src/planning/schedule.ts';
import { loadSnapshot } from '../src/planning/snapshot.ts';
import { RunnerRepository } from '../src/runner/repository.ts';
import { inputHead } from '../src/project/service.ts';

const db = new URL(inject('testDatabaseUrl'));
db.pathname += '_ci';
const owner = createPool(db.href, { onError: () => undefined });
const appUrl = new URL(db);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { onError: () => undefined });
const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40), pipeline = 'c'.repeat(40);
const app = buildApp(pool, false, { origin: 'http://127.0.0.1:3100', lan: false });
installRunner(app, pool);
installCiRunner(app);
installProjectRunner(app,pool);
let bearer: string, cookie: string, csrf: string, project: string, wp: string, input: string;
let sequence = 0;
const headers = () => ({ authorization: `Bearer ${bearer}`, 'x-project-epoch': '1', 'idempotency-key': randomUUID() });
const lead = () => ({ cookie,origin:'http://127.0.0.1:3100','x-csrf-token':csrf,'idempotency-key':randomUUID() });
const post = (path: string, payload: object, h = headers()) => app.inject({ method: 'POST', url: `/api/runner/${path}`, headers: h, payload });
const get = (path: string) => app.inject({ url: `/api/${path}`, headers: { cookie } });
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
    values($1,1,'attempt',$2,$3,'started','runner:ci',now()+interval '5 minutes',1,1) returning id`,
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
beforeAll(async () => {
  await recreateTestDatabase(db.href);
  await runMigrations(owner);
  await seedSystem(owner);
  bearer = await issueRunnerToken(pool,'ci','fake');
  const token = await issueLoginLink(pool);
  const login = await app.inject({ method:'POST',url:'/api/auth/session',headers:{ origin:'http://127.0.0.1:3100' },payload:{ method:'link',token } });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await get('session')).json().csrfToken as string;
});
beforeEach(async () => {
  await owner.query('update notify_settings set enabled=true where singleton');
  await owner.query("insert into notify_rules(key,enabled) values('buildFail',true),('buildOk',false),('done',false) on conflict(key) do update set enabled=excluded.enabled");
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
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

const patch = (id: string, payload: object, h = headers()) => app.inject({ method:'PATCH',url:`/api/runner/ci/runs/${id}`,headers:h,payload });
async function start(a: Running, stage = 'task', extra: object = {}) {
  return post('ci/runs',{ jobId:a.job,fence:a.fence,stage,taskKey:a.key,attemptId:a.attempt,ref:'agent/test',pr:1,trigger:'task',pipelineSha:pipeline,headSha:sha,baseSha:otherSha,...extra });
}
async function gateTask() {
  const a = await running('qa'); await check(a);
  await owner.query('update task_attempts set attempt_no=2 where id=$1',[a.attempt]);
  const dev = ((await owner.query(`insert into runner_jobs(project_id,epoch,kind,payload,dedup_key,state,generation)
    values($1,1,'attempt',$2,$3,'done',1) returning id`,[project,{ taskKey:a.key,kind:'dev',agent:'Codex' },randomUUID()])).rows[0] as { id: string }).id;
  await owner.query(`insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,input_version,kind,agent,status,started_at,ended_at,model_id,effort,branch,generation)
    values($1,$2,$3,1,$4,$5,$5,1,$6,'dev','Codex','completed',now(),now(),'gpt-6.1-sol','high','agent/test',1)`,[project,a.id,`${a.key}-dev`,dev,sha,input]);
  await observe();
  expect((await report(a)).statusCode).toBe(201);
  const job = ((await owner.query("select id from runner_jobs where kind='integrate'")).rows[0] as { id: string }).id;
  await owner.query("update runner_jobs set state='started',lease_owner='runner:ci',lease_until=now()+interval '5 minutes',fence=1,generation=1 where id=$1",[job]);
  await owner.query(`insert into execution_holds(project_id,job,epoch,host_id,boot_id,fence,task,agent,slots,heavy,slot_state,lock_state)
    values($1,$2,1,'host-a','boot-a',1,$3,'Codex',1,true,'reserved','held')`,[project,job,a.id]);
  await owner.query("update execution_holds set slot_state='none',release_proof='no_process' where job=$1",[job]);
  return { ...a,job };
}
async function observe(baseSha = otherSha, pipelineSha = pipeline) {
  const r = await post('input-changes',{ base:await inputHead(owner,project),head:baseSha,baseIsAncestor:true,treeHash:sha,changes:[],commits:[],
    pipelineObservation:{ baseSha,pipelineSha,definition:{ path:'.agentwbs/pipeline.yaml',commit:baseSha,status:'ok',error:null,raw:'version: 1',stages:[] } } });
  expect(r.statusCode,r.body).toBe(200);
}
const queue = (a: Running, status: string, extra: object = {}, h = headers()) => post('ci/queue',{
  jobId:a.job,fence:a.fence,pr:1,taskKey:a.key,status,qaHeadSha:sha,syncedHeadSha:sha,baseSha:otherSha,...extra,
},h);

test('CI API는 시작·진행·결과·상세를 저장하고 멱등 재요청을 한 번만 반영한다', async () => {
  const a = await running();
  const h = headers(), body = { jobId:a.job,fence:1,stage:'task',taskKey:a.key,attemptId:a.attempt,ref:'agent/test',trigger:'task',pipelineSha:pipeline,headSha:sha,baseSha:otherSha };
  const r = await post('ci/runs',body,h); expect(r.statusCode,r.body).toBe(201);
  expect((await post('ci/runs',body,h)).headers['idempotency-replayed']).toBe('true');
  const id = r.json().id as string;
  expect((await patch(id,{ fence:1,status:'pass' })).statusCode).toBe(409);
  expect((await patch(id,{ fence:1,status:'run' })).statusCode).toBe(204);
  expect((await patch(id,{ fence:1,status:'pass',steps:[{ name:'단위 테스트',status:'pass',durationMs:55 }],artifacts:['runs/log.txt'],logExcerpt:'요약' })).statusCode).toBe(204);
  expect((await get(`projects/${project}/ci/runs/${id}`)).json()).toMatchObject({ id,stage:'task',status:'pass',pipelineSha:pipeline,steps:[{ name:'단위 테스트',status:'pass',durationMs:55 }],artifacts:['runs/log.txt'] });
  expect((await get(`projects/${project}/ci/runs?stage=task&taskKey=${a.key}&limit=1`)).json()).toMatchObject({ items:[{ id }],nextCursor:null });
  expect((await patch(id,{ fence:1,status:'fail' })).statusCode).toBe(409);
});

test('다른 job·Task·시도·낡은 fence·만료 lease·다른 Runner는 CI 기록을 오염시키지 못한다', async () => {
  const a = await running(), b = await running();
  expect((await start(a,'task',{ taskKey:b.key })).statusCode).toBe(409);
  expect((await start(a,'task',{ attemptId:b.attempt })).statusCode).toBe(409);
  expect((await start(a,'int')).statusCode).toBe(409);
  expect((await start(a,'task',{ fence:0 })).statusCode).toBe(409);
  const r = await start(a); expect(r.statusCode,r.body).toBe(201);
  const id = r.json().id as string;
  expect((await patch(id,{ fence:0,status:'run' })).statusCode).toBe(409);
  const other = await issueRunnerToken(pool,'other','fake');
  expect((await patch(id,{ fence:1,status:'run' },{ ...headers(),authorization:`Bearer ${other}` })).statusCode).toBe(409);
  expect((await patch(id,{ fence:1,pipelineSha:sha })).statusCode).toBe(409);
  await owner.query("update runner_jobs set lease_until=now()-interval '1 second' where id=$1",[a.job]);
  expect((await patch(id,{ fence:1,status:'run' })).statusCode).toBe(409);
  expect((await owner.query('select count(*)::int n from ci_runs')).rows).toEqual([{ n:1 }]);
});

test('job 없는 야간 실행은 시작한 Runner만 null fence로 갱신한다', async () => {
  const r = await post('ci/runs',{ stage:'night',ref:'main',trigger:'night',pipelineSha:pipeline,headSha:sha });
  expect(r.statusCode,r.body).toBe(201);
  const id = r.json().id as string;
  expect((await patch(id,{ fence:1,status:'run' })).statusCode).toBe(409);
  const other = await issueRunnerToken(pool,'other','fake');
  expect((await patch(id,{ fence:null,status:'run' },{ ...headers(),authorization:`Bearer ${other}` })).statusCode).toBe(409);
  expect((await patch(id,{ fence:null,status:'run' })).statusCode).toBe(204);
});

test('②·③·④ 실패는 단계·CI 상세 참조와 함께 중복 억제되고 성공 때 원인 키만 해소된다', async () => {
  await owner.query("insert into notify_rules(key,enabled) values('buildFail',true),('buildOk',true) on conflict(key) do update set enabled=true");
  const make = async (status: string) => {
    const r = await post('ci/runs',{ stage:'night',ref:'main',trigger:'night',pipelineSha:pipeline,headSha:sha });
    expect(r.statusCode,r.body).toBe(201);
    const id = r.json().id as string;
    expect((await patch(id,{ fence:null,status:'run' })).statusCode).toBe(204);
    expect((await patch(id,{ fence:null,status,steps:[{ name:'E2E',status,durationMs:10 }] })).statusCode).toBe(204);
    return id;
  };
  const id = await make('fail'); await make('fail');
  expect((await owner.query("select kind,dup_count,ref from notify_events where resolved_at is null")).rows).toMatchObject([{ kind:'buildFail',dup_count:1,ref:{ id,failStep:'E2E',path:expect.stringContaining('/ci/') } }]);
  expect((await owner.query('select count(*)::int n from alerts where resolved_at is null')).rows).toEqual([{ n:1 }]);
  expect((await get('alerts')).json().items).toMatchObject([{ key:'ci:buildFail|night|main',target:id }]);
  await make('pass');
  expect((await owner.query('select count(*)::int n from notify_events where resolved_at is null')).rows).toEqual([{ n:0 }]);
  await make('fail');
  expect((await owner.query("select count(*)::int n from notify_events where kind='buildFail'")).rows).toEqual([{ n:2 }]);
});

test('① 실패와 꺼진 규칙은 Telegram 이벤트를 만들지 않는다', async () => {
  const a = await running(); const r = await start(a); expect(r.statusCode,r.body).toBe(201);
  await patch(r.json().id as string,{ fence:1,status:'run' });
  expect((await patch(r.json().id as string,{ fence:1,status:'fail' })).statusCode).toBe(204);
  await owner.query("update notify_rules set enabled=false where key='buildFail'");
  const night = await post('ci/runs',{ stage:'night',ref:'main',trigger:'night',pipelineSha:pipeline });
  await patch(night.json().id as string,{ fence:null,status:'run' });
  await patch(night.json().id as string,{ fence:null,status:'fail' });
  expect((await owner.query('select count(*)::int n from notify_events')).rows).toEqual([{ n:0 }]);
});

test('알림 전체 끄기는 CI 이벤트를 남기지 않고 현재 상태 경고만 보여 준다', async () => {
  await owner.query("update notify_rules set enabled=true where key='buildFail'");
  await owner.query('update notify_settings set enabled=false where singleton');
  const r = await post('ci/runs',{ stage:'night',ref:'main',trigger:'night',pipelineSha:pipeline,headSha:sha });
  await patch(r.json().id as string,{ fence:null,status:'run' });
  expect((await patch(r.json().id as string,{ fence:null,status:'fail' })).statusCode).toBe(204);
  expect((await owner.query('select count(*)::int n from notify_events')).rows).toEqual([{ n:0 }]);
  expect((await get('alerts')).json().items).toHaveLength(1);
});

test.each([false,true])('H→H′=%s의 실제 병합 보고는 기록된 ①·②·QA·base pipeline을 대조한 뒤 한 번만 완료한다', async synced => {
  await owner.query("insert into notify_rules(key,enabled) values('done',true) on conflict(key) do update set enabled=true");
  const a = await gateTask(), head = synced ? 'e'.repeat(40) : sha, tree = 'f'.repeat(40);
  const proof = { qaHeadSha:sha,headSha:head,preserved:true,parents:[sha,otherSha],autoMergeTreeSha:tree,headTreeSha:tree,additionalChanges:false };
  expect((await queue(a,'queued')).statusCode).toBe(204);
  const taskRun = await start(a,'task',{ attemptId:undefined,headSha:head }); expect(taskRun.statusCode,taskRun.body).toBe(201);
  const intRun = await start(a,'int',{ attemptId:undefined,headSha:head,treeSha:tree }); expect(intRun.statusCode,intRun.body).toBe(201);
  for (const id of [taskRun.json().id,intRun.json().id] as string[]) {
    expect((await patch(id,{ fence:1,status:'run' })).statusCode).toBe(204);
    expect((await patch(id,{ fence:1,status:'pass' })).statusCode).toBe(204);
  }
  const extra = { syncedHeadSha:head,ciRunId:intRun.json().id,testedTreeSha:tree,...(synced ? { headSync:proof } : {}) };
  if (synced) for (const changed of [{ parents:[otherSha,sha] },{ autoMergeTreeSha:sha },{ additionalChanges:true }]) {
    expect((await queue(a,'checking',{ ...extra,headSync:{ ...proof,...changed } })).statusCode).toBe(409);
  }
  expect((await queue(a,'checking',extra)).statusCode).toBe(204);
  expect((await queue(a,'merged',{ ...extra,actualMergeSha:'8'.repeat(40),actualTreeSha:tree,mergeParents:[head,otherSha] })).statusCode).toBe(409);
  expect((await queue(a,'merged',{ ...extra,actualMergeSha:'7'.repeat(40),actualTreeSha:sha,mergeParents:[otherSha,head] })).statusCode).toBe(409);
  const h = headers(), merged = { ...extra,actualMergeSha:'9'.repeat(40),actualTreeSha:tree,mergeParents:[otherSha,head] };
  const completed = await queue(a,'merged',merged,h); expect(completed.statusCode,completed.body).toBe(204);
  expect((await queue(a,'merged',merged,h)).headers['idempotency-replayed']).toBe('true');
  expect((await get(`tasks/${a.key}`)).json()).toMatchObject({ lifecycleStatus:'done' });
  expect((await owner.query("select count(*)::int n from task_history where kind='완료'")).rows).toEqual([{ n:1 }]);
  expect((await owner.query("select count(*)::int n from notify_events where kind='done'")).rows).toEqual([{ n:1 }]);
});

async function integration() {
  const a = await gateTask(), tree = 'f'.repeat(40);
  expect((await queue(a,'queued')).statusCode).toBe(204);
  const taskRun = await start(a,'task',{ attemptId:undefined }); expect(taskRun.statusCode,taskRun.body).toBe(201);
  await patch(taskRun.json().id as string,{ fence:1,status:'run' }); await patch(taskRun.json().id as string,{ fence:1,status:'pass' });
  const r = await start(a,'int',{ attemptId:undefined,treeSha:tree }); expect(r.statusCode,r.body).toBe(201);
  const id = r.json().id as string;
  await patch(id,{ fence:1,status:'run' }); await patch(id,{ fence:1,status:'pass' });
  return { a,id,tree,extra:{ ciRunId:id,testedTreeSha:tree } };
}

test.each(['foreign-job','stale-spec','invalidated-QA','pipeline-conflict','failed-int','wrong-base','wrong-head','wrong-tree'])('%s 근거는 checking·완료를 거부하고 상태를 보존한다', async fault => {
  const { a,id,tree,extra } = await integration();
  if (fault === 'foreign-job') await owner.query('update ci_runs set job=$2 where id=$1',[id,((await owner.query('select job from task_attempts where id=$1',[a.attempt])).rows[0] as { job: string }).job]);
  if (fault === 'stale-spec') await owner.query('update task_specs set revision=2 where task=$1',[a.id]);
  if (fault === 'invalidated-QA') await owner.query("insert into verification_invalidations(project_id,verification,reason) select $1,id,'시험' from verifications",[project]);
  if (fault === 'pipeline-conflict') await owner.query('update ci_runs set pipeline_sha=$2 where id=$1',[id,sha]);
  if (fault === 'failed-int') await owner.query("update ci_runs set status='fail' where id=$1",[id]);
  const changed = fault === 'wrong-base' ? { baseSha:sha } : fault === 'wrong-head' ? { syncedHeadSha:otherSha } : fault === 'wrong-tree' ? { testedTreeSha:sha } : {};
  const checking = await queue(a,'checking',{ ...extra,...changed });
  if (fault === 'failed-int') {
    expect(checking.statusCode,checking.body).toBe(204);
    expect((await queue(a,'merged',{ ...extra,actualMergeSha:'9'.repeat(40),actualTreeSha:tree,mergeParents:[otherSha,sha] })).statusCode).toBe(409);
  } else expect(checking.statusCode,checking.body).toBe(409);
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'gate' }]);
  expect((await owner.query("select count(*)::int n from task_history where kind='완료'")).rows).toEqual([{ n:0 }]);
});

test('basePipelineSha는 기록이 없거나 같은 A에서 정의가 서로 다르면 비어 있다', async () => {
  const client = await owner.connect();
  try {
    expect(await resolveBasePipelineSha(client,otherSha,project)).toBeNull();
    await observe();
    const a = await running();
    const first = await start(a); expect(first.statusCode).toBe(201);
    expect(await resolveBasePipelineSha(client,otherSha,project)).toBeNull();
    await patch(first.json().id as string,{ fence:1,status:'run' });
    expect(await resolveBasePipelineSha(client,otherSha,project)).toBe(pipeline);
    expect((await start(a,'task',{ pipelineSha:sha })).statusCode).toBe(201);
    expect(await resolveBasePipelineSha(client,otherSha,project)).toBe(pipeline);
    expect(await resolveBasePipelineSha(client,otherSha,randomUUID())).toBeNull();
  } finally { client.release(); }
});

test('완료 이력 저장 실패는 병합 상태와 Task·알림을 모두 되돌리고 재전송으로 복구한다', async () => {
  const { a,tree,extra } = await integration();
  expect((await queue(a,'checking',extra)).statusCode).toBe(204);
  await owner.query("create function public.fail_ci_history() returns trigger language plpgsql as 'begin if NEW.kind=''완료'' then raise exception ''시험 실패 주입''; end if; return NEW; end'");
  await owner.query('create trigger fail_ci_history before insert on task_history for each row execute function public.fail_ci_history()');
  const h = headers(), merged = { ...extra,actualMergeSha:'9'.repeat(40),actualTreeSha:tree,mergeParents:[otherSha,sha] };
  try { expect((await queue(a,'merged',merged,h)).statusCode).toBe(500); }
  finally { await owner.query('drop trigger fail_ci_history on task_history'); await owner.query('drop function public.fail_ci_history()'); }
  expect((await owner.query('select status,actual_merge_sha from merge_queue where task=$1',[a.id])).rows).toEqual([{ status:'checking',actual_merge_sha:null }]);
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'gate' }]);
  expect((await queue(a,'merged',merged,h)).statusCode).toBe(204);
});

test('실패한 단계가 있는 실행은 PASS로 바꿀 수 없고 실패 단계 이름·시간을 보존한다', async () => {
  const a = await running(), r = await start(a); expect(r.statusCode,r.body).toBe(201);
  const id = r.json().id as string;
  await patch(id,{ fence:1,status:'run',steps:[{ name:'lint',status:'fail',durationMs:10 }] });
  expect((await patch(id,{ fence:1,status:'pass' })).statusCode).toBe(409);
  expect((await patch(id,{ fence:1,steps:[{ name:'lint',status:'pass',durationMs:1e30 }] })).statusCode).toBe(400);
  expect((await get(`projects/${project}/ci/runs/${id}`)).json()).toMatchObject({ status:'run',failStep:'lint',steps:[{ name:'lint',durationMs:10,status:'fail' }] });
});

test('조회는 프로젝트·단계·커서로 분리하고 재실행·배포 요청은 실제 실행 대신 job을 만든다', async () => {
  const a = await running();
  const created = [await start(a),await start(a),await start(a)];
  const ids = created.map(r => r.json().id as string).reverse();
  const first = await get(`projects/${project}/ci/runs?limit=2`);
  expect(first.json().items.map((r: { id: string }) => r.id)).toEqual(ids.slice(0,2));
  expect((await get(`projects/${project}/ci/runs?limit=2&cursor=${first.json().nextCursor}`)).json()).toMatchObject({ items:[{ id:ids[2] }],nextCursor:null });
  expect((await get(`projects/${randomUUID()}/ci/runs/${ids[0]}`)).statusCode).toBe(404);
  expect((await app.inject({ method:'POST',url:`/api/projects/${project}/ci/runs/${ids[0]}/retry`,headers:lead() })).statusCode).toBe(409);
  await patch(ids[0] ?? '',{ fence:1,status:'run' }); await patch(ids[0] ?? '',{ fence:1,status:'fail' });
  await owner.query("insert into input_change_commits(project_id,sha,files,state) values($1,$2,$3,'skipped')",[project,otherSha,{ seq:1,base:sha,head:otherSha,tree:sha,changes:[] }]);
  for (const path of [`runs/${ids[0]}/retry`,'deploy-check']) {
    const r = await app.inject({ method:'POST',url:`/api/projects/${project}/ci/${path}`,headers:lead() }); expect(r.statusCode,r.body).toBe(202);
    expect((await owner.query('select payload from runner_jobs where id=$1',[r.json().jobId])).rows).toMatchObject([{ payload:{ commit:path === 'deploy-check' ? otherSha : sha } }]);
  }
  await owner.query("update external_write_authority set state='blocked' where singleton");
  expect((await app.inject({ method:'POST',url:`/api/projects/${project}/ci/deploy-check`,headers:lead() })).statusCode).toBe(409);
  expect((await owner.query("select count(*)::int n from runner_jobs where kind='deploy_check'")).rows).toEqual([{ n:1 }]);
});

test('불안정 테스트 격리는 최신 버전으로만 저장하고 실행 결과를 조작하지 않는다', async () => {
  const a = await running();
  await owner.query("insert into flaky_tests(project_id,test_key,rate,quarantined,task) values($1,'flaky',0.2,false,$2)",[project,a.id]);
  const row = (await get(`projects/${project}/ci/flaky`)).json().items[0] as { id: string; updatedAt: string };
  const update = () => app.inject({ method:'PATCH',url:`/api/projects/${project}/ci/flaky/${row.id}`,headers:lead(),payload:{ updatedAt:row.updatedAt,quarantined:true } });
  expect((await update()).statusCode).toBe(200);
  expect((await update()).statusCode).toBe(409);
  expect((await owner.query('select * from ci_runs')).rowCount).toBe(0);
});

test('통합 실패 보고는 같은 트랜잭션에서 재작업 job에 잠금을 넘기고 완료를 막는다', async () => {
  const a = await gateTask();
  expect((await queue(a,'queued')).statusCode).toBe(204);
  const r = await start(a,'int',{ attemptId:undefined,treeSha:'f'.repeat(40) }); expect(r.statusCode,r.body).toBe(201);
  await patch(r.json().id as string,{ fence:1,status:'run' });
  expect((await patch(r.json().id as string,{ fence:1,status:'fail',steps:[{ name:'E2E',status:'fail',durationMs:50 }] })).statusCode).toBe(204);
  const failed = await queue(a,'failed',{ ciRunId:r.json().id }); expect(failed.statusCode,failed.body).toBe(204);
  expect((await owner.query("select payload->>'kind' kind from runner_jobs where kind='attempt' and state='queued'")).rows).toEqual([{ kind:'rework' }]);
  expect((await owner.query('select lock_state from execution_holds where job=$1',[a.job])).rows).toEqual([{ lock_state:'handed_over' }]);
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'rework' }]);
  expect((await owner.query("select payload->'integrationFailed' failed from runner_jobs where kind='attempt' and state='queued'")).rows).toEqual([{ failed:true }]);
  expect((await owner.query("select kind from task_history where task=$1 and kind='통합 실패'",[a.id])).rows).toEqual([{ kind:'통합 실패' }]);
  const claimed = await post('jobs/claim',{ kinds:['attempt'],capacity:20 });
  expect(claimed.statusCode,claimed.body).toBe(200);
  expect(claimed.json()).toMatchObject({ job:{ kind:'attempt',payload:{ kind:'rework',integrationFailed:true } } });
});

test('리뷰 R1: removed 뒤 다시 연 대기열의 checking은 열린 행 하나만 바꾼다', async () => {
  const { a,extra } = await integration();
  expect((await queue(a,'removed')).statusCode).toBe(204);
  expect((await queue(a,'queued')).statusCode).toBe(204);
  const r = await queue(a,'checking',extra); expect(r.statusCode,r.body).toBe(204);
  expect((await owner.query('select status from merge_queue where task=$1 order by created_at',[a.id])).rows).toEqual([{ status:'removed' },{ status:'checking' }]);
});

test('리뷰 R2: 실제 병합 불일치는 SHA·경고를 커밋하고 Task는 완료하지 않는다', async () => {
  const { a,tree,extra } = await integration(); await queue(a,'checking',extra);
  const mergedAt = '2026-11-27T00:01:00.000000Z';
  const r = await queue(a,'merged',{ ...extra,actualMergeSha:'9'.repeat(40),actualTreeSha:tree,mergeParents:[sha,otherSha],mergedAt });
  expect(r.statusCode,r.body).toBe(409);
  expect(r.json()).toMatchObject({ error:{ code:'MERGE_MISMATCH' } });
  expect((await owner.query('select status,actual_merge_sha from merge_queue where task=$1',[a.id])).rows).toEqual([{ status:'checking',actual_merge_sha:'9'.repeat(40) }]);
  expect((await get(`projects/${project}/ci/queue`)).json()).toMatchObject({ items:[{ mergedAt }] });
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'gate' }]);
  expect((await get('alerts')).json().items).toMatchObject([{ key:'ci:mergeMismatch|#1' }]);
  expect((await owner.query("select kind from notify_events where dedup_key='ci:mergeMismatch|#1'")).rows).toEqual([{ kind:'buildFail' }]);
  expect((await queue(a,'merged',{ ...extra,actualMergeSha:'9'.repeat(40),actualTreeSha:tree,mergeParents:[otherSha,sha] })).statusCode).toBe(409);
  expect((await owner.query('select merge_parents from merge_queue where task=$1',[a.id])).rows).toEqual([{ merge_parents:[sha,otherSha] }]);
  expect((await get('alerts')).json().items).toHaveLength(1);
});

test('병합 뒤 명세 변경을 발견해도 실제 병합 사실과 경보는 잃지 않는다', async () => {
  const { a,tree,extra } = await integration(); await queue(a,'checking',extra);
  await owner.query('update task_specs set revision=2 where task=$1',[a.id]);
  const r = await queue(a,'merged',{ ...extra,actualMergeSha:'9'.repeat(40),actualTreeSha:tree,mergeParents:[otherSha,sha] });
  expect(r.statusCode,r.body).toBe(409);
  expect(r.json()).toMatchObject({ error:{ code:'MERGE_MISMATCH' } });
  expect((await owner.query('select actual_merge_sha from merge_queue where task=$1',[a.id])).rows).toEqual([{ actual_merge_sha:'9'.repeat(40) }]);
});

test('리뷰 R5: 늦은 이전 실행의 PASS는 최신 실패 경고를 해소하지 않는다', async () => {
  const a = await gateTask();
  const older = await start(a,'int',{ attemptId:undefined,treeSha:sha }), newer = await start(a,'int',{ attemptId:undefined,treeSha:sha });
  for (const r of [older,newer]) await patch(r.json().id as string,{ fence:1,status:'run' });
  await patch(newer.json().id as string,{ fence:1,status:'fail' });
  await patch(older.json().id as string,{ fence:1,status:'pass' });
  expect((await get('alerts')).json().items).toHaveLength(1);
});

test('리뷰 R6: 완료한 병합을 새 멱등 키로 재전송해도 같은 증거면 204다', async () => {
  const { a,tree,extra } = await integration(); await queue(a,'checking',extra);
  const merged = { ...extra,actualMergeSha:'9'.repeat(40),actualTreeSha:tree,mergeParents:[otherSha,sha] };
  expect((await queue(a,'merged',merged)).statusCode).toBe(204);
  await owner.query("update runner_jobs set state='done',lease_until=now()-interval '1 second' where id=$1",[a.job]);
  expect((await queue(a,'merged',merged)).statusCode).toBe(204);
  expect((await queue(a,'merged',{ ...merged,actualMergeSha:'8'.repeat(40) })).statusCode).toBe(409);
});

test('리뷰 R8: CI 설정 두 경로는 같은 버전과 값을 저장하고 정의 조회도 등록돼 있다', async () => {
  const r = await get(`projects/${project}/ci/settings`); expect(r.statusCode,r.body).toBe(200);
  const settings = r.json() as { updatedAt: string };
  const saved = await app.inject({ method:'PATCH',url:`/api/projects/${project}/ci/settings`,headers:lead(),payload:{ updatedAt:settings.updatedAt,retry:2 } });
  expect(saved.statusCode,saved.body).toBe(200);
  expect((await get('settings/ci')).json()).toMatchObject({ retry:2,updatedAt:saved.json().updatedAt });
  const defaults = await app.inject({ method:'PUT',url:'/api/settings/ci',headers:lead(),payload:{ updatedAt:saved.json().updatedAt,nightAt:saved.json().nightAt,deployUrl:saved.json().deployUrl,retry:1 } });
  expect(defaults.statusCode,defaults.body).toBe(200);
  expect((await get(`projects/${project}/ci/settings`)).json()).toMatchObject({ retry:1 });
  expect((await get(`projects/${project}/ci/pipeline`)).statusCode).toBe(200);
});

test('리뷰 R4: ①·②가 같은 잘못된 정의를 보고해도 별도 main 첫 관측과 다르면 거부한다', async () => {
  const a = await gateTask(), x = 'd'.repeat(40), tree = 'f'.repeat(40);
  await observe(otherSha,x);
  expect((await get(`projects/${project}/ci/pipeline`)).json()).toMatchObject({ status:'ok',raw:'version: 1',commit:otherSha });
  expect((await owner.query("select pipeline_observations->$2->>'pipelineSha' sha from projects where id=$1",[project,otherSha])).rows).toEqual([{ sha:pipeline }]);
  await queue(a,'queued');
  const taskRun = await start(a,'task',{ attemptId:undefined,pipelineSha:x }), intRun = await start(a,'int',{ attemptId:undefined,pipelineSha:x,treeSha:tree });
  for (const r of [taskRun,intRun]) {
    expect(r.statusCode,r.body).toBe(201);
    await patch(r.json().id as string,{ fence:1,status:'run' }); await patch(r.json().id as string,{ fence:1,status:'pass' });
  }
  expect((await queue(a,'checking',{ ciRunId:intRun.json().id,testedTreeSha:tree })).statusCode).toBe(409);
});

test('리뷰 시계 되돌림: 새 ① FAIL은 옛 PASS보다 이른 시각이어도 Gate를 막는다', async () => {
  const a = await gateTask();
  const newer = await check(a,sha,'fail');
  await owner.query('set session_replication_role=replica');
  await owner.query("update ci_runs set created_at='2000-01-01' where id=$1",[newer]);
  await owner.query('set session_replication_role=origin');
  expect((await get(`tasks/${a.key}/gate`)).json()).toMatchObject({ passed:false });
});

test('실행 목록은 최신 시각·증가 순번 순이며 같은 시각도 커서로 빠짐없이 넘긴다', async () => {
  const a = await running();
  const ids = [(await start(a)).json().id,(await start(a)).json().id,(await start(a)).json().id] as string[];
  await owner.query('set session_replication_role=replica');
  await owner.query("update ci_runs set created_at='2026-01-01' where id=any($1::uuid[])",[ids]);
  await owner.query('set session_replication_role=origin');
  const first = (await get(`projects/${project}/ci/runs?limit=2`)).json();
  expect(first.items.map((r: { id: string }) => r.id)).toEqual([ids[2],ids[1]]);
  expect((await get(`projects/${project}/ci/runs?limit=2&cursor=${first.nextCursor}`)).json()).toMatchObject({ items:[{ id:ids[0] }],nextCursor:null });
  const bad = Buffer.from(JSON.stringify(['2026-02-30T00:00:00Z','9999999999999999999'])).toString('base64url');
  expect((await get(`projects/${project}/ci/runs?cursor=${bad}`)).statusCode).toBe(400);
});

test('기준선 ① 실패는 Task를 재작업시키지 않고 기준 경보를 남긴다', async () => {
  const a = await running(), r = await start(a); await patch(r.json().id as string,{ fence:1,status:'run' });
  const failed = await patch(r.json().id as string,{ fence:1,status:'fail',failScope:'baseline' });
  expect(failed.statusCode,failed.body).toBe(204);
  expect((await get(`projects/${project}/ci/runs/${r.json().id}`)).json()).toMatchObject({ failScope:'baseline' });
  expect((await get('alerts')).json().items).toMatchObject([{ key:expect.stringContaining('ci:baseline|') }]);
  expect((await report(a,'PASS',{ failure:'기준 테스트 실패' })).statusCode).toBe(409);
  expect((await owner.query("select count(*)::int n from runner_jobs where state='queued'")).rows).toEqual([{ n:0 }]);
});

test('통합 중 기준선 검사 실패도 Gate를 보존하고 재작업 job을 만들지 않는다', async () => {
  const a = await gateTask(); await queue(a,'queued');
  const run = await start(a,'task',{ attemptId:undefined });
  await patch(run.json().id as string,{ fence:1,status:'run' });
  expect((await patch(run.json().id as string,{ fence:1,status:'fail',failScope:'baseline' })).statusCode).toBe(204);
  const r = await queue(a,'failed',{ ciRunId:run.json().id }); expect(r.statusCode,r.body).toBe(204);
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'gate' }]);
  expect((await owner.query("select count(*)::int n from runner_jobs where state='queued'")).rows).toEqual([{ n:0 }]);
  expect((await owner.query('select lock_state from execution_holds where job=$1',[a.job])).rows).toEqual([{ lock_state:'released' }]);
});

test('완료 버튼도 저장된 H→H′ 증거와 basePipelineSha를 사용한다', async () => {
  const a = await gateTask(), head = 'e'.repeat(40), tree = 'f'.repeat(40);
  expect((await queue(a,'queued')).statusCode).toBe(204);
  const taskRun = await start(a,'task',{ attemptId:undefined,headSha:head });
  const intRun = await start(a,'int',{ attemptId:undefined,headSha:head,treeSha:tree });
  for (const r of [taskRun,intRun]) {
    expect(r.statusCode,r.body).toBe(201);
    await patch(r.json().id as string,{ fence:1,status:'run' }); await patch(r.json().id as string,{ fence:1,status:'pass' });
  }
  expect((await queue(a,'checking',{ syncedHeadSha:head,ciRunId:intRun.json().id,testedTreeSha:tree,
    headSync:{ qaHeadSha:sha,headSha:head,preserved:true,parents:[sha,otherSha],autoMergeTreeSha:tree,headTreeSha:tree,additionalChanges:false } })).statusCode).toBe(204);
  await owner.query("update merge_queue set status='merged',actual_merge_sha=$2,actual_tree_sha=$3,merge_parents=$4 where task=$1",[a.id,'9'.repeat(40),tree,JSON.stringify([otherSha,head])]);
  await owner.query('update notify_settings set enabled=false where singleton');
  const task = (await get(`tasks/${a.key}`)).json() as { updatedAt: string };
  const r = await app.inject({ method:'POST',url:`/api/tasks/${a.key}/complete`,headers:lead(),payload:{ updatedAt:task.updatedAt } });
  expect(r.statusCode,r.body).toBe(200);
  expect(r.json()).toMatchObject({ task:{ lifecycleStatus:'done' } });
  expect((await owner.query("select count(*)::int n from notify_events where kind='done'")).rows).toEqual([{ n:0 }]);
});


async function baselineFailed() {
  const a = await gateTask(); await queue(a,'queued');
  const run = await start(a,'task',{ attemptId:undefined }); const id = run.json().id as string;
  await patch(id,{ fence:1,status:'run' }); await patch(id,{ fence:1,status:'fail',failScope:'baseline' });
  expect((await queue(a,'failed',{ ciRunId:id })).statusCode).toBe(204);
  return { a,id };
}

test('결정 11: 기준 실패 뒤 팀장 다시 시도는 같은 main에서도 새 통합 차수를 만든다', async () => {
  const { a,id } = await baselineFailed();
  const r = await app.inject({ method:'POST',url:`/api/projects/${project}/ci/runs/${id}/retry`,headers:lead(),payload:{} });
  expect(r.statusCode,r.body).toBe(202);
  expect((await owner.query('select kind,dedup_key from runner_jobs where id=$1',[r.json().jobId])).rows).toEqual([{ kind:'integrate',dedup_key:expect.stringMatching(new RegExp(`^integrate:[^:]+:${otherSha}:2$`)) }]);
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'gate' }]);
  const claimed = await post('jobs/claim',{ kinds:['integrate'],capacity:20 });
  expect(claimed.statusCode,claimed.body).toBe(200);
  expect(claimed.json()).toMatchObject({ job:{ id:r.json().jobId,kind:'integrate' } });
  expect((await owner.query('select task from execution_holds where job=$1',[r.json().jobId])).rows).toEqual([{ task:a.id }]);
});

test('결정 11: 기준 실패 뒤 main 이동은 자동 재통합하며 이전 기준 경보를 해소한다', async () => {
  const { a } = await baselineFailed(); const base = 'd'.repeat(40);
  await observe(base);
  await observe(base);
  expect((await owner.query("select kind,dedup_key from runner_jobs where state='queued'")).rows).toEqual([{ kind:'integrate',dedup_key:expect.stringContaining(`:${base}:1`) }]);
  expect((await get('alerts')).json().items).toHaveLength(0);
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'gate' }]);
});

test('결정 13: 최신 H′ ①만 다른 pipeline이어도 올바른 ②로 완료하지 못한다', async () => {
  const a = await gateTask(), head = 'e'.repeat(40), tree = 'f'.repeat(40);
  await queue(a,'queued');
  const one = await start(a,'task',{ attemptId:undefined,headSha:head,pipelineSha:'d'.repeat(40) });
  const two = await start(a,'int',{ attemptId:undefined,headSha:head,treeSha:tree });
  for (const r of [one,two]) { await patch(r.json().id as string,{ fence:1,status:'run' }); await patch(r.json().id as string,{ fence:1,status:'pass' }); }
  const r = await queue(a,'checking',{ syncedHeadSha:head,ciRunId:two.json().id,testedTreeSha:tree,headSync:{ qaHeadSha:sha,headSha:head,preserved:true,parents:[sha,otherSha],autoMergeTreeSha:tree,headTreeSha:tree,additionalChanges:false } });
  expect(r.statusCode,r.body).toBe(409);
});

test.each(['error','missing'])('결정 14: %s 관측 뒤 성공한 같은 main 정의를 다시 받는다', async status => {
  const r = await post('input-changes',{ base:sha,head:otherSha,baseIsAncestor:true,treeHash:sha,changes:[],commits:[],pipelineObservation:{ baseSha:otherSha,pipelineSha:null,definition:{ path:'.agentwbs/pipeline.yaml',commit:otherSha,status,error:'다시 확인',raw:null,stages:null } } });
  expect(r.statusCode,r.body).toBe(200);
  expect((await owner.query('select pipeline_observations from projects where id=$1',[project])).rows).toEqual([{ pipeline_observations:{} }]);
  await observe();
  expect((await get(`projects/${project}/ci/pipeline`)).json()).toMatchObject({ status:'ok',raw:'version: 1' });
});

test('결정 15: 같은 병합 사실에서 늦은 ② PASS만 보충되면 보류를 풀 수 있다', async () => {
  const { a,id,tree,extra } = await integration();
  await owner.query("update ci_runs set status='run' where id=$1",[id]);
  expect((await queue(a,'checking',extra)).statusCode).toBe(204);
  const merged = { ...extra,actualMergeSha:'9'.repeat(40),actualTreeSha:tree,mergeParents:[otherSha,sha] };
  expect((await queue(a,'merged',merged)).statusCode).toBe(409);
  expect((await patch(id,{ fence:1,status:'pass' })).statusCode).toBe(204);
  expect((await queue(a,'merged',merged)).statusCode).toBe(204);
});


test('결정 12: 미래 시각인 옛 추정과 사용량이 새 기록을 가리지 않는다', async () => {
  const a = await running();
  await owner.query(`insert into task_estimates(project_id,task,est,lo,hi,tokens_k,confidence,basis,agreed_by,created_at)
    values($1,$2,1,1,1,null,'중','이전','Codex',now()+interval '1 hour'),($1,$2,2,2,2,33,'중','최신','Codex',now()-interval '1 hour')`,[project,a.id]);
  expect((await get(`tasks/${a.key}`)).json()).toMatchObject({ estimate:{ tokensK:33,estHours:2 } });
  const client = await pool.connect();
  try {
    expect((await loadSnapshot(client,project)).snapshot.tasks.find(t => t.id===a.key)?.estimate).toMatchObject({ est:2 });
    await owner.query("insert into agent_usage(agent,remain_pct,reset_at,created_at) values('Codex',10,now(),now()+interval '1 hour'),('Codex',77,now(),now()-interval '1 hour')");
    const repo = new RunnerRepository(client);
    expect((await scheduleInput(client,project,await policyOf(client))).input.tasks.find(t => t.id===a.key)).toMatchObject({ est:2 });
    expect(Number((await repo.usage('Codex'))?.remain_pct)).toBe(77);
    expect((await repo.allUsage()).map(u => Number(u.remain_pct))).toEqual([77]);
  } finally { client.release(); }
});


test.each([false,true])('결정 16: 두 단계 main 사슬은 원래 QA를 유지하고 변조=%s이면 재QA 상태로 보낸다', async tampered => {
  const a = await gateTask(), head1 = 'e'.repeat(40), head2 = 'f'.repeat(40), base2 = 'd'.repeat(40), tree1 = '1'.repeat(40), tree2 = '2'.repeat(40);
  await observe(base2);
  const first = { qaHeadSha:sha,headSha:head1,preserved:true,parents:[sha,otherSha],autoMergeTreeSha:tree1,headTreeSha:tree1,additionalChanges:false };
  const last = { qaHeadSha:head1,headSha:head2,preserved:true,parents:[head1,base2],autoMergeTreeSha:tree2,headTreeSha:tree2,additionalChanges:false };
  const proof = { ...last,qaHeadSha:sha,chain:[{ ...first,...(tampered ? { headTreeSha:sha } : {}) },last] };
  expect((await queue(a,'queued',{ baseSha:base2,syncedHeadSha:head2,headSync:proof })).statusCode).toBe(tampered ? 409 : 204);
  if (tampered) {
    expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'verifying' }]);
    expect((await owner.query('select count(*)::int n from verification_invalidations')).rows).toEqual([{ n:1 }]);
    return;
  }
  const one = await start(a,'task',{ attemptId:undefined,baseSha:base2,headSha:head2 });
  const two = await start(a,'int',{ attemptId:undefined,baseSha:base2,headSha:head2,treeSha:tree2 });
  for (const r of [one,two]) { expect(r.statusCode,r.body).toBe(201); await patch(r.json().id as string,{ fence:1,status:'run' }); await patch(r.json().id as string,{ fence:1,status:'pass' }); }
  const extra = { baseSha:base2,syncedHeadSha:head2,headSync:proof,testedTreeSha:tree2,ciRunId:two.json().id };
  expect((await queue(a,'checking',extra)).statusCode).toBe(204);
  expect((await queue(a,'merged',{ ...extra,actualMergeSha:'9'.repeat(40),actualTreeSha:tree2,mergeParents:[base2,head2] })).statusCode).toBe(204);
  expect((await owner.query('select head_sha from verifications')).rows).toEqual([{ head_sha:sha }]);
});


test('M7-05: Runner가 보고한 실행 설명·E2E 수·완료 시각·실제 GitHub 보고와 flaky 실패 시각을 조회한다', async () => {
  const a = await running(), r = await start(a), id = r.json().id as string;
  expect((await patch(id,{ fence:1,status:'run' })).statusCode).toBe(204);
  const finishedAt = '2026-11-27T00:00:00.000000Z';
  const githubStatus = { headSha:sha,context:'agentwbs/task',state:'success',reportedAt:finishedAt };
  const done = await patch(id,{ fence:1,status:'pass',note:'E2E 재시도 통과',e2e:{ passed:12,total:12 },finishedAt,githubStatus,
    flakyTests:[{ testKey:'E2E/login',rate:0.2,lastFailedAt:finishedAt }] });
  expect(done.statusCode,done.body).toBe(204);
  expect((await get(`projects/${project}/ci/runs/${id}`)).json()).toMatchObject({ note:'E2E 재시도 통과',e2e:{ passed:12,total:12 },finishedAt,githubStatus });
  expect((await get(`projects/${project}/ci/flaky`)).json()).toMatchObject({ items:[{ testKey:'E2E/login',rate:'0.2',lastFailedAt:finishedAt,taskKey:a.key }] });
  const unknown = await start(a);
  expect((await get(`projects/${project}/ci/runs/${unknown.json().id}`)).json()).toMatchObject({ e2e:null,note:null,githubStatus:null,finishedAt:null });
  expect((await patch(unknown.json().id as string,{ fence:1,e2e:{ passed:13,total:12 } })).statusCode).toBe(400);
  expect((await patch(unknown.json().id as string,{ fence:1,githubStatus:{ ...githubStatus,headSha:otherSha } })).statusCode).toBe(409);
});

test('M7-05: 관측한 main 서비스 구성을 읽고 실제 병합 시각과 서버 대기열 수신 시각을 구분한다', async () => {
  const a = await gateTask(), base = 'd'.repeat(40);
  const serviceConfig = { path:'docker-compose.ci.yml',commit:base,status:'ok',raw:'services: {}',error:null };
  const observed = await post('input-changes',{ base:otherSha,head:base,baseIsAncestor:true,treeHash:sha,changes:[],commits:[],pipelineObservation:{ baseSha:base,pipelineSha:pipeline,definition:{ path:'.agentwbs/pipeline.yaml',commit:base,status:'ok',error:null,raw:'version: 1',stages:[],serviceConfig } } });
  expect(observed.statusCode,observed.body).toBe(200);
  expect((await get(`projects/${project}/ci/settings`)).json()).toMatchObject({ serviceConfig });
  expect((await get('settings/ci')).json()).toMatchObject({ serviceConfig });
  expect((await get(`projects/${project}/ci/pipeline`)).json()).toMatchObject({ serviceConfig });
  await queue(a,'queued',{ baseSha:base });
  const one = await start(a,'task',{ attemptId:undefined,baseSha:base }), two = await start(a,'int',{ attemptId:undefined,treeSha:sha,baseSha:base });
  for (const r of [one,two]) { await patch(r.json().id as string,{ fence:1,status:'run' }); await patch(r.json().id as string,{ fence:1,status:'pass' }); }
  const extra = { ciRunId:two.json().id,testedTreeSha:sha,baseSha:base };
  expect((await queue(a,'checking',extra)).statusCode).toBe(204);
  const mergedAt = '2026-11-27T00:01:00.000000Z';
  expect((await queue(a,'merged',{ ...extra,actualMergeSha:'9'.repeat(40),actualTreeSha:sha,mergeParents:[base,sha],mergedAt })).statusCode).toBe(204);
  expect((await get(`projects/${project}/ci/queue`)).json()).toMatchObject({ items:[{ mergedAt,queuedAt:expect.stringMatching(/^\d{4}-/) }] });
});


test('결정 12: 호스트·부팅·동시 실행 한도·시도 관측·세션도 시계 역행보다 수신 순번을 따른다', async () => {
  const a = await running();
  await owner.query(`insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at,created_at)
    values('host-a','future-old','fake',20,32,0,100,'fake',0,now()+interval '1 hour',now()+interval '1 hour'),
      ('host-a','past-new','fake',20,32,0,100,'fake',0,now()-interval '1 hour',now()-interval '1 hour')`);
  await owner.query(`insert into runner_concurrency_log(host_id,"limit",running,subagents,heavy,resources,created_at)
    values('host-a',1,0,'{}',0,'{}',now()+interval '1 hour'),('host-a',7,0,'{}',0,'{}',now()-interval '1 hour')`);
  await owner.query(`insert into attempt_observations(project_id,attempt,cli,version,grade,reserved,observed,state,process_state,at,created_at)
    values($1,$2,'Codex','old','ok',1,1,'ok','{}',now()+interval '1 hour',now()+interval '1 hour'),($1,$2,'Codex','new','ok',1,1,'ok','{}',now()-interval '1 hour',now()-interval '1 hour')`,[project,a.attempt]);
  await owner.query(`insert into runner_sessions(runner_id,started_at,last_heartbeat_at,ended_at,end_reason)
    values('old',now()+interval '1 hour',now()+interval '1 hour',now()+interval '2 hour','manual'),('new',now()-interval '1 hour',now()-interval '1 hour',now(),'manual')`);
  const client = await pool.connect();
  try {
    const repo = new RunnerRepository(client);
    expect((await repo.host())?.boot_id).toBe('past-new');
    expect(await repo.hostBoot('host-a')).toBe('past-new');
    expect((await repo.hostHistory())[0]?.boot_id).toBe('past-new');
    expect((await repo.concurrency())?.limit).toBe(7);
    expect((await repo.latestObservation(a.attempt))?.version).toBe('new');
    expect((await repo.sessions()).at(-1)?.runner_id).toBe('new');
  } finally { client.release(); }
});

test('결정 16: ② 없는 기준 실패 차수에도 동기화 근거를 보존하고 새 main 차수를 연다', async () => {
  const a = await gateTask(), head = 'e'.repeat(40), tree = 'f'.repeat(40);
  const headSync = { qaHeadSha:sha,headSha:head,preserved:true,parents:[sha,otherSha],autoMergeTreeSha:tree,headTreeSha:tree,additionalChanges:false };
  await queue(a,'queued',{ syncedHeadSha:head,headSync });
  const run = await start(a,'task',{ attemptId:undefined,headSha:head }); const id = run.json().id as string;
  await patch(id,{ fence:1,status:'run' }); await patch(id,{ fence:1,status:'fail',failScope:'baseline' });
  expect((await queue(a,'failed',{ syncedHeadSha:head,headSync,ciRunId:id })).statusCode).toBe(204);
  const nextBase = 'd'.repeat(40); await observe(nextBase);
  const job = (await owner.query("select id from runner_jobs where state='queued' and kind='integrate'")).rows[0]?.id as string;
  expect(job).toBeTypeOf('string');
  await owner.query("update runner_jobs set state='started',fence=1,lease_owner='runner:ci',lease_until=now()+interval '5 minutes' where id=$1",[job]);
  expect((await queue({ ...a,job },'queued',{ baseSha:nextBase,syncedHeadSha:head,headSync })).statusCode).toBe(204);
  expect((await owner.query('select status,head_sync,tested_tree_sha from merge_queue where task=$1 order by queue_no',[a.id])).rows).toEqual([
    { status:'failed',head_sync:headSync,tested_tree_sha:null },{ status:'queued',head_sync:headSync,tested_tree_sha:null },
  ]);
});


test('결정 11: 같은 기준의 실패마다 알리고 자동 재작업 상한과 무관하게 수동 재통합한다', async () => {
  const a = await gateTask();
  for (let n=0;n<2;n++) {
    const r = await start(a,'task',{ attemptId:undefined });
    await patch(r.json().id as string,{ fence:1,status:'run' });
    expect((await patch(r.json().id as string,{ fence:1,status:'fail',failScope:'baseline' })).statusCode).toBe(204);
  }
  expect((await owner.query("select count(*)::int n from notify_events where ref->>'failScope'='baseline'")).rows).toEqual([{ n:2 }]);
  await owner.query("update runner_jobs set state='failed' where id=$1",[a.job]);
  const id = (await owner.query('select id from ci_runs where task=$1 order by run_no desc limit 1',[a.id])).rows[0]?.id as string;
  for (let n=2;n<=4;n++) {
    const r = await app.inject({ method:'POST',url:`/api/projects/${project}/ci/runs/${id}/retry`,headers:lead() });
    expect(r.statusCode,r.body).toBe(202);
    expect((await owner.query('select dedup_key from runner_jobs where id=$1',[r.json().jobId])).rows[0]?.dedup_key).toMatch(new RegExp(`:${otherSha}:${n}$`));
    await owner.query("update runner_jobs set state='failed' where id=$1",[r.json().jobId]);
  }
});


test('M7-05: 같은 main의 뒤늦은 서비스 구성만 보충하며 첫 pipeline과 첫 구성은 덮어쓰지 않는다', async () => {
  await observe();
  const send = (raw: string, pipelineSha = pipeline) => post('input-changes',{ base:otherSha,head:otherSha,baseIsAncestor:true,treeHash:sha,changes:[],commits:[],pipelineObservation:{ baseSha:otherSha,pipelineSha,definition:{ path:'.agentwbs/pipeline.yaml',commit:otherSha,status:'ok',error:null,raw:'version: 1',stages:[],serviceConfig:{ path:'docker-compose.ci.yml',commit:otherSha,status:'ok',raw,error:null } } } });
  expect((await send('다른 정의','d'.repeat(40))).statusCode).toBe(200);
  expect((await get(`projects/${project}/ci/settings`)).json()).toMatchObject({ serviceConfig:null });
  expect((await send('services: {}')).statusCode).toBe(200);
  expect((await send('바꾸려는 내용')).statusCode).toBe(200);
  expect((await get(`projects/${project}/ci/settings`)).json()).toMatchObject({ serviceConfig:{ raw:'services: {}' } });
});


test('기준 경보는 최신 올바른 main 정의의 ① PASS 때만 해소한다', async () => {
  const a = await gateTask();
  const old = await start(a,'task',{ attemptId:undefined }); const oldId = old.json().id as string;
  await patch(oldId,{ fence:1,status:'run' });
  const failed = await start(a,'task',{ attemptId:undefined }); const failedId = failed.json().id as string;
  await patch(failedId,{ fence:1,status:'run' }); await patch(failedId,{ fence:1,status:'fail',failScope:'baseline' });
  await patch(oldId,{ fence:1,status:'pass' });
  expect((await get('alerts')).json().items).toHaveLength(1);
  const wrong = await start(a,'task',{ attemptId:undefined,pipelineSha:'d'.repeat(40) }); const wrongId = wrong.json().id as string;
  await patch(wrongId,{ fence:1,status:'run' }); await patch(wrongId,{ fence:1,status:'pass' });
  expect((await get('alerts')).json().items).toHaveLength(1);
  const good = await start(a,'task',{ attemptId:undefined }); const goodId = good.json().id as string;
  await patch(goodId,{ fence:1,status:'run' }); await patch(goodId,{ fence:1,status:'pass' });
  expect((await get('alerts')).json().items).toHaveLength(0);
  expect((await owner.query("select count(*)::int n from notify_events where ref->>'failScope'='baseline' and resolved_at is null")).rows).toEqual([{ n:0 }]);
});

test('이전 통합 멱등 키를 가진 작업도 자동 중복 생성 없이 수동 재시도한다', async () => {
  const { a,id } = await baselineFailed();
  const legacy = await owner.connect();
  try {
    await legacy.query('set session_replication_role=replica');
    await legacy.query("update runner_jobs set dedup_key=regexp_replace(dedup_key,':[a-f0-9]{40}:[0-9]+$',''),payload=payload-'baseSha' where id=$1",[a.job]);
  } finally { await legacy.query('set session_replication_role=origin'); legacy.release(); }
  await observe();
  expect((await owner.query("select count(*)::int n from runner_jobs where kind='integrate'")).rows).toEqual([{ n:1 }]);
  const r = await app.inject({ method:'POST',url:`/api/projects/${project}/ci/runs/${id}/retry`,headers:lead() });
  expect(r.statusCode,r.body).toBe(202);
  expect((await owner.query('select dedup_key from runner_jobs where id=$1',[r.json().jobId])).rows[0]?.dedup_key).toMatch(new RegExp(`:${otherSha}:2$`));
});


test('기준 실패 재통합 분기는 아직 Gate 전인 Task의 기존 CI 다시 시도를 막지 않는다', async () => {
  const a = await running(), run = await start(a), id = run.json().id as string;
  await patch(id,{ fence:1,status:'run' }); await patch(id,{ fence:1,status:'fail',failScope:'baseline' });
  const r = await app.inject({ method:'POST',url:`/api/projects/${project}/ci/runs/${id}/retry`,headers:lead() });
  expect(r.statusCode,r.body).toBe(202);
  expect((await owner.query('select kind from runner_jobs where id=$1',[r.json().jobId])).rows).toEqual([{ kind:'ci_retry' }]);
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'running' }]);
});


test('결정 14: 이전 버전이 이미 저장한 error 관측도 첫 성공 관측으로 복구한다', async () => {
  await owner.query('update projects set pipeline_observations=$2::jsonb where id=$1',[project,JSON.stringify({ [otherSha]:{ baseSha:otherSha,pipelineSha:null,definition:{ path:'.agentwbs/pipeline.yaml',commit:otherSha,status:'error',error:'이전 읽기 실패',raw:null,stages:null } } })]);
  await observe();
  expect((await get(`projects/${project}/ci/pipeline`)).json()).toMatchObject({ status:'ok',raw:'version: 1' });
});


test.each([false,true])('리뷰3 Q1·Q7: 기준 실패가 아닌 통합 종료 뒤 main 이동은 재통합하지 않는다(불일치=%s)', async mismatch => {
  const prepared = mismatch ? await integration() : null;
  const a = prepared?.a ?? await gateTask();
  if (prepared) {
    await queue(a,'checking',prepared.extra);
    const r = await queue(a,'merged',{ ...prepared.extra,actualMergeSha:'9'.repeat(40),actualTreeSha:prepared.tree,mergeParents:[sha,otherSha] });
    expect(r.statusCode,r.body).toBe(409);
    expect(r.json().error.code).toBe('MERGE_MISMATCH');
  }
  await owner.query("update runner_jobs set state='done' where id=$1",[a.job]);
  await observe('9'.repeat(40));
  expect((await owner.query("select count(*)::int n from runner_jobs where kind='integrate' and state='queued'")).rows).toEqual([{ n:0 }]);
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'gate' }]);
  if (mismatch) expect((await get('alerts')).json().items).toHaveLength(1);
});

test.each(['alert','fact','reconcile'])('리뷰3: 기준 실패가 있어도 %s 보류는 자동·수동 재통합에서 제외한다', async held => {
  const { a,id } = await baselineFailed();
  if (held==='alert') await owner.query("insert into alerts(project_id,key,severity,target) values($1,'ci:mergeMismatch|#1','error',$2)",[project,{ taskKey:a.key }]);
  else if (held==='fact') await owner.query('update merge_queue set actual_merge_sha=$2 where task=$1',[a.id,'9'.repeat(40)]);
  else await owner.query("insert into runner_jobs(project_id,epoch,kind,payload,dedup_key,state,generation) select $1,1,'integrate',$2,'integrate:'||verification::text||':reconcile','reconcile',1 from merge_queue where task=$3",[project,{ taskKey:a.key,pr:1 },a.id]);
  await observe('d'.repeat(40));
  expect((await owner.query("select count(*)::int n from runner_jobs where kind='integrate' and state='queued'")).rows).toEqual([{ n:0 }]);
  const r = await app.inject({ method:'POST',url:`/api/projects/${project}/ci/runs/${id}/retry`,headers:lead() });
  expect(r.statusCode,r.body).toBe(409);
});

