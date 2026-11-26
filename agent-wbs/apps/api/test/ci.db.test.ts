import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import { installRunner } from '../src/runner/routes.ts';
import { installCiRunner } from '../src/ci/routes.ts';
import { resolveBasePipelineSha } from '../src/ci/service.ts';

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
  expect((await report(a)).statusCode).toBe(201);
  const job = ((await owner.query("select id from runner_jobs where kind='integrate'")).rows[0] as { id: string }).id;
  await owner.query("update runner_jobs set state='started',lease_owner='runner:ci',lease_until=now()+interval '5 minutes',fence=1,generation=1 where id=$1",[job]);
  await owner.query(`insert into execution_holds(project_id,job,epoch,host_id,boot_id,fence,task,agent,slots,heavy,slot_state,lock_state)
    values($1,$2,1,'host-a','boot-a',1,$3,'Codex',1,true,'reserved','held')`,[project,job,a.id]);
  await owner.query("update execution_holds set slot_state='none',release_proof='no_process' where job=$1",[job]);
  return { ...a,job };
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
  expect((await queue(a,'merged',{ ...extra,actualMergeSha:'9'.repeat(40),actualTreeSha:tree,mergeParents:[head,otherSha] })).statusCode).toBe(409);
  expect((await queue(a,'merged',{ ...extra,actualMergeSha:'9'.repeat(40),actualTreeSha:sha,mergeParents:[otherSha,head] })).statusCode).toBe(409);
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
    expect(await resolveBasePipelineSha(client,otherSha)).toBeNull();
    const a = await running();
    expect((await start(a)).statusCode).toBe(201);
    expect(await resolveBasePipelineSha(client,otherSha)).toBe(pipeline);
    expect((await start(a,'task',{ pipelineSha:sha })).statusCode).toBe(201);
    expect(await resolveBasePipelineSha(client,otherSha)).toBeNull();
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
  const ids = created.map(r => r.json().id as string).sort();
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
  expect((await owner.query('select status from tasks where id=$1',[a.id])).rows).toEqual([{ status:'failed' }]);
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

