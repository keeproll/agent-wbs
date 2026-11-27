// Codex 독립 리뷰(M2-08-INDEPENDENT-REVIEW.md)의 재현 검사를 옮긴 회귀 테스트. 지적 1~6은 「지적 N」 이름의 테스트다.
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { harness, projectWith, attemptFor, type Harness, type ProjectFixture } from './m208-fixture.ts';
import { inEpoch } from '../src/platform/transaction.ts';
import { applyRegrade, getModels, putModels, resumeGrade, recordResumeRegrade } from '../src/policy/service.ts';
import { failUndelivered } from '../src/messages/service.ts';
import { emitChange } from '../src/changes/events.ts';
import { encodeCursor } from '../src/changes/history.ts';
import { jobPayloadErrors } from '@awbs/shared/api';
import { subjectHash } from '../src/tasks/hash.ts';

let h: Harness;
let f: ProjectFixture;
const efforts = ['low','medium','high','xhigh','max'];
beforeAll(async () => {
  h = await harness('m208_review');
  f = await projectWith(h.owner, ['ready','running','paused','done']);
  await h.owner.query("update tasks set planning_approved_at=now(),verif_state='pass' where status='done'");
  await h.owner.query("insert into agent_models(agent,model_id,allowed,is_new,report) values ('Claude','claude-opus-5-5',true,false,$1),('Claude','claude-sonnet-5-5',true,false,$1),('Codex','gpt-6.2-sol',true,false,$1)", [{ efforts }]);
  await h.owner.query("insert into agent_usage(agent,remain_pct,reset_at) values('Claude',80,now()+interval '1 day')");
});
afterAll(async () => h.close());
const get = async (path: string) => (await h.lead('GET',path)).body;
const obs = (name: string, data: unknown) => console.log('OBS',name,JSON.stringify(data));

test('concurrent policy writes: exactly one stale writer gets 409', async () => {
  const current = await get('/api/settings/exec-policy');
  const result = await Promise.all([10,30].map(lowPct => h.lead('PUT','/api/settings/exec-policy',{...current,lowPct})));
  obs('policy concurrent',result.map(r => ({status:r.status,code:r.body.error?.code})));
  expect(result.map(r=>r.status).sort()).toEqual([200,409]);
});

test('policy and model writes may both save; stale model writer gets 409', async () => {
  const policy = await get('/api/settings/exec-policy');
  const models = await get('/api/settings/models');
  const order = {...models.rankOrder,Claude:[...models.rankOrder.Claude].reverse()};
  const result = await Promise.all([
    h.lead('PUT','/api/settings/exec-policy',{...policy,lowPct:20}),
    h.lead('PUT','/api/settings/models',{updatedAt:models.updatedAt,models:[],rankOrder:order}),
  ]);
  expect(result.map(r=>r.status)).toEqual([200,200]);
  const stale = await h.lead('PUT','/api/settings/models',{updatedAt:models.updatedAt,models:[]});
  obs('policy/model concurrent and stale',{statuses:result.map(r=>r.status),stale:stale.status});
  expect(stale.status).toBe(409);
});

test('concurrent model writes from the same version permit exactly one save', async () => {
  const current = (await h.lead('GET','/api/settings/models')).body;
  const result = await Promise.all([
    h.lead('PUT','/api/settings/models',{updatedAt:current.updatedAt,models:[],codexFamilyOrder:[...current.codexFamilyOrder].reverse()}),
    h.lead('PUT','/api/settings/models',{updatedAt:current.updatedAt,models:[],claudeModels:[...current.claudeModels].reverse()}),
  ]);
  console.log('OBS concurrent model saves',JSON.stringify(result.map(x=>({status:x.status,code:x.body.error?.code}))));
  expect(result.map(x=>x.status).sort()).toEqual([200,409]);
});

test('지적 3: 실행 중인데 역할 등급이 없으면 무결성 실패', async () => {
  const result = await get('/api/system/integrity');
  const item = result.items.find((i: {key: string})=>i.key==='grade_allowed');
  obs('missing grades integrity',result);
  expect(item.ok).toBe(false);
});

test('지적 4: 검증 기록 없이 done/pass 표시만 있으면 무결성 실패', async () => {
  expect((await h.owner.query('select count(*)::int as n from verifications')).rows[0].n).toBe(0);
  const result = await get('/api/system/integrity');
  const item = result.items.find((i: {key: string})=>i.key==='done_gate');
  obs('no verification integrity',item);
  expect(item.ok).toBe(false);
});

test('integrity detects an actual cross-Task message/attempt mismatch', async () => {
  const attempt = await attemptFor(h.owner,f.project,f.tasks['TASK-0004'] ?? '',{status:'completed'});
  await h.owner.query("insert into messages(project_id,task,msg_key,attempt,dir,type,to_agent,body,delivery,pending_next,work_state,draft) values($1,$2,'MSG-900',$3,'out','질문','Claude','mismatch','Queued',false,'',false)",[f.project,f.tasks['TASK-0001'],attempt]);
  const item = (await get('/api/system/integrity')).items.find((i: {key: string})=>i.key==='message_attempt');
  obs('cross task integrity',item);
  expect(item).toMatchObject({ok:false,detail:'MSG-900'});
});

test('read preserves exact message version; failure, resend and late ack have history', async () => {
  const m = (await h.lead('POST','/api/messages',{taskKey:'TASK-0001',type:'질문',toAgent:'Claude',body:'review'})).body;
  expect((await h.lead('POST',`/api/messages/${m.id}/read`)).status).toBe(204);
  expect((await get('/api/messages?taskKey=TASK-0001')).items.find((x: {id: string})=>x.id===m.id).updatedAt).toBe(m.updatedAt);
  expect((await h.lead('POST',`/api/messages/${m.id}/send`,{updatedAt:m.updatedAt})).status).toBe(200);
  await inEpoch(h.pool,1,c=>failUndelivered(c,'review offline'));
  const failed=(await get('/api/messages?taskKey=TASK-0001')).items.find((x: {id:string})=>x.id===m.id);
  expect(failed).toMatchObject({delivery:'Failed',failReason:'review offline'});
  expect((await h.runner('POST',`/api/runner/messages/${m.id}/ack`)).status).toBe(204);
  const history = await get('/api/tasks/TASK-0001/history');
  obs('failure/late ack history',history.items.filter((x: {text:string})=>x.text.includes(m.msgKey)));
  expect(history.items.some((x: {text:string})=>x.text.includes('전달 실패'))).toBe(true);
});

test('Q-07·지적 5: 기존 live_inject=true여도 실행 중 재전송은 다음 실행 대기', async () => {
  const m = (await h.lead('POST','/api/messages',{taskKey:'TASK-0001',type:'질문',toAgent:'Claude',body:'resend'})).body;
  await h.lead('POST',`/api/messages/${m.id}/send`,{updatedAt:m.updatedAt});
  await inEpoch(h.pool,1,c=>failUndelivered(c,'offline'));
  const failed=(await get('/api/messages?taskKey=TASK-0001')).items.find((x: {id:string})=>x.id===m.id);
  await h.owner.query("update tasks set status='running' where id=$1",[f.tasks['TASK-0001']]);
  await h.owner.query('update exec_policy set live_inject=true');
  const resent = await h.lead('POST',`/api/messages/${m.id}/resend`,{updatedAt:failed.updatedAt});
  obs('resend in active task',resent);
  expect(resent.body.pendingNext).toBe(true);
});

test('지적 6: 형식만 맞고 날짜·UUID가 틀린 커서는 400', async () => {
  const cursor=encodeCursor(['not-a-date','not-a-uuid']);
  const result=await h.lead('GET',`/api/history?cursor=${cursor}`);
  obs('invalid cursor',result);
  expect(result.status).toBe(400);
  // 같은 도우미를 쓰는 메시지 목록·Runner 메시지 조회도 400
  expect((await h.lead('GET',`/api/messages?cursor=${cursor}`)).status).toBe(400);
  expect((await h.runner('GET',`/api/runner/messages?cursor=${cursor}`)).status).toBe(400);
});

test('disallow affects active and paused grades; D-29 helper blocks before and records after regrade', async () => {
  for (const key of ['TASK-0002','TASK-0003','TASK-0004']) await h.owner.query("insert into task_grades(project_id,task,role,model_id,effort,reason,locked,locked_by,effective_from) values($1,$2,'dev','claude-opus-5-5','high','review',true,'팀장',now())",[f.project,f.tasks[key]]);
  const active=await attemptFor(h.owner,f.project,f.tasks['TASK-0002'] ?? '',{status:'running'});
  const interrupted=await attemptFor(h.owner,f.project,f.tasks['TASK-0003'] ?? '',{status:'interrupted'});
  const models=await get('/api/settings/models');
  const saved=await h.lead('PUT','/api/settings/models',{updatedAt:models.updatedAt,models:[{agent:'Claude',id:'claude-opus-5-5',allowed:false}]});
  expect(saved.status).toBe(200);
  const grades=(await h.owner.query('select t.task_key,g.locked from task_grades g join tasks t on t.id=g.task order by t.task_key')).rows;
  const jobs=(await h.owner.query("select kind,payload from runner_jobs where payload->'policy' ? 'rejudge'")).rows;
  obs('disallow effects',{grades,jobs,activeAttempt:(await h.owner.query('select status,model_id from task_attempts where id=$1',[active])).rows});
  expect(grades).toEqual([{task_key:'TASK-0002',locked:false},{task_key:'TASK-0003',locked:false},{task_key:'TASK-0004',locked:true}]);
  expect(await inEpoch(h.pool,1,c=>resumeGrade(c,interrupted))).toEqual({ok:false,code:'MODEL_NOT_ALLOWED'});
  await inEpoch(h.pool,1,c=>applyRegrade(c,{taskKey:'TASK-0003',role:'dev',modelId:'claude-sonnet-5-5',effort:'high',reason:'review regrade'}));
  await inEpoch(h.pool,1,c=>recordResumeRegrade(c,interrupted));
  const hist=(await h.owner.query("select actor,before,after,ref from task_history where ref->>'adjust'='regrade'")).rows;
  obs('D29 regrade history',hist);
  expect(hist).toHaveLength(1);
});

test('지적 1: 재판단 작업은 estimate payload 계약을 따른다', async () => {
  const job=(await h.owner.query("select kind,payload from runner_jobs where kind='estimate' and payload->'policy' ? 'rejudge' limit 1")).rows[0];
  obs('actual estimate payload',job);
  expect(job.kind).toBe('estimate');
  expect(job.payload).toHaveProperty('policy');
  expect(job.payload.tasks[0]).toHaveProperty('content');
  expect(job.payload.tasks[0]).toHaveProperty('subjectHash');
  // 공용 계약(claimJob 응답의 estimate payload) 전체와 맞는다
  expect(jobPayloadErrors('estimate', job.payload)).toEqual([]);
  expect(job.payload.policy.rejudge).toEqual({ reason: 'model_disallowed', trigger: expect.stringContaining('claude-opus-5-5'),
    targets: [{ taskKey: 'TASK-0002', roles: ['dev'] }, { taskKey: 'TASK-0003', roles: ['dev'] }] });
  expect(job.payload.tasks.map((t: { taskKey: string }) => t.taskKey)).toEqual(['TASK-0002', 'TASK-0003']);
  // M2 통합: payload hash는 Task 조회 내용으로 계산한 판단 hash(M2-02 tasks/hash.ts, Planning이 돌려보낼 값)와 같다.
  const d=(await h.lead('GET','/api/tasks/TASK-0002')).body;
  expect(job.payload.tasks[0].subjectHash).toBe(subjectHash({ title:d.title, overview:d.spec.overview, spec:d.spec.spec, ac:d.spec.ac, outputs:d.outputs, designs:d.designs, conflictGroup:d.conflictGroup }));
});

test('emitChange serializes commits from two independent transactions', async () => {
  const a=await h.pool.connect(), b=await h.pool.connect();
  try {
    await a.query('begin'); await b.query('begin');
    const pid=(await b.query('select pg_backend_pid() as pid')).rows[0].pid;
    await emitChange(a,f.project,'task','review-first');
    let done=false;
    const pending=emitChange(b,f.project,'task','review-second').then(()=>{done=true;});
    await vi.waitFor(async()=>{
      expect((await h.owner.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[pid])).rowCount).toBe(1);
    },{timeout:10_000});
    expect(done).toBe(false);
    await a.query('commit'); await pending; await b.query('commit');
    const result=(await h.owner.query("select seq,ref from change_events where ref in ('\"review-first\"','\"review-second\"') order by seq")).rows;
    obs('seq commit order',result);
    expect(result.map(x=>x.ref)).toEqual(['review-first','review-second']);
  } finally { await a.query('rollback'); await b.query('rollback'); a.release();b.release(); }
});

test('지적 2: 설정 변경과 Task 재판단이 잠금 순서를 뒤집지 않는다(교착 없음)', async () => {
  await h.owner.query("update agent_models set allowed=true where model_id='claude-opus-5-5'");
  const a=await h.pool.connect(), b=await h.pool.connect();
  try {
    await a.query('begin');await a.query('select public.lock_epoch(1)');
    await b.query('begin');await b.query('select public.lock_epoch(1)');
    await a.query('select id from tasks where id=$1 for update',[f.tasks['TASK-0002']]);
    const bpid=(await b.query('select pg_backend_pid() as pid')).rows[0].pid;
    const current=await getModels(b);
    const save=putModels(b,{updatedAt:current.updatedAt,models:[{agent:'Claude',id:'claude-opus-5-5',allowed:false}]}).then(async()=>{await b.query('rollback');return 'ok';},async e=>{await b.query('rollback');return e.code;});
    await vi.waitFor(async()=>{
      const state=(await h.owner.query('select wait_event_type,query from pg_stat_activity where pid=$1',[bpid])).rows[0];
      expect(state.wait_event_type).toBe('Lock');
      expect(state.query).toContain('order by id for update');
    },{timeout:10_000});
    const regrade=applyRegrade(a,{taskKey:'TASK-0002',role:'dev',modelId:'claude-sonnet-5-5',effort:'high',reason:'concurrent review'}).then(async()=>{await a.query('rollback');return 'ok';},async e=>{await a.query('rollback');return e.code;});
    const result=await Promise.all([save,regrade]);
    obs('lock inversion outcome',result);
    expect(result).not.toContain('40P01');
  } finally {await a.query('rollback');await b.query('rollback');a.release();b.release();}
});
