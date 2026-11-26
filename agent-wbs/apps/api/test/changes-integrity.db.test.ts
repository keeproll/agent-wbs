// M2-08 무결성 점검 GET /api/system/integrity — 실제 PostgreSQL.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { attemptFor, harness, projectWith, type Harness, type ProjectFixture } from './m208-fixture.ts';

let h: Harness;
let f: ProjectFixture;
beforeAll(async () => {
  h = await harness('m208_integrity');
  // TASK-0002는 추정 전(planning)이라 등급이 없어도 된다. TASK-0003은 완료 Task(근거는 아래 테스트에서 채움).
  f = await projectWith(h.owner, ['ready', 'planning']);
  await h.owner.query("insert into agent_models(agent,model_id,allowed,is_new,report) values('Claude','claude-opus-5-5',true,false,$1),('Codex','gpt-6.2-sol',true,false,$1)",
    [{ efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }]);
  await h.owner.query("insert into task_grades(project_id,task,role,model_id,effort,reason,locked,effective_from) values($1,$2,'dev','claude-opus-5-5','high','근거',false,now())", [f.project, f.tasks['TASK-0001']]);
  await h.owner.query("insert into task_grades(project_id,task,role,model_id,effort,reason,locked,effective_from) values($1,$2,'qa','gpt-6.2-sol','high','근거',false,now())", [f.project, f.tasks['TASK-0001']]);
});
afterAll(async () => { await h.close(); });

const integrity = async () => {
  const res = await h.lead('GET', '/api/system/integrity');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { checkedAt: string; items: { key: string; ok: boolean; detail: string }[] };
};

test('모순 없는 데이터는 모두 통과하고 점검 시각을 준다', async () => {
  const body = await integrity();
  expect(body.checkedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(body.items.filter((i) => !i.ok)).toEqual([]);
  expect(body.items.length).toBe(12);
});

test('완료 Task: 저장된 근거가 Gate 5조건을 채우면 통과, 검증 PASS가 무효화되면 실패(리뷰 지적 4)', async () => {
  const p = f.project;
  const done = (await h.owner.query<{ id: string }>(
    "insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state,planning_approved_at) values($1,'TASK-0003',$2,9,'완료','Implementation','BE','{}',1,'Claude','Codex','done','pass',now()) returning id",
    [p, f.wp])).rows[0]?.id ?? '';
  await h.owner.query("insert into task_specs(project_id,task,overview,spec,ac,revision) values($1,$2,'{}','{}','[]',1)", [p, done]);
  await h.owner.query("insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order) values($1,$2,'CL-3-1','확인',true,true,'명령',0)", [p, done]);
  await h.owner.query("insert into task_outputs(project_id,task,name,kind,required,verify,delivered) values($1,$2,'API','코드',true,'테스트',true)", [p, done]);
  const qa = await attemptFor(h.owner, p, done, { kind: 'qa', status: 'completed', agent: 'Codex', modelId: 'gpt-6.2-sol' });
  const verification = (await h.owner.query<{ id: string }>("insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual) values($1,$2,'PASS','head',1,'cmd','pass','pass') returning id", [p, qa])).rows[0]?.id;
  const job = (await h.owner.query<{ id: string }>("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'integrate','{}','done',1,gen_random_uuid()::text) returning id", [p])).rows[0]?.id;
  await h.owner.query("insert into ci_runs(project_id,run_key,stage,head_sha,pipeline_sha,ref,task,trigger,status,job,fence) values($1,'CI-1',1,'head','sha','main',$2,'t','pass',$3,1)", [p, done, job]);
  const gate = async () => (await integrity()).items.find((i) => i.key === 'done_gate');
  expect(await gate()).toMatchObject({ ok: true, detail: '완료 1건' });
  await h.owner.query("insert into verification_invalidations(project_id,verification,reason) values($1,$2,'명세 변경')", [p, verification]);
  expect(await gate()).toMatchObject({ ok: false, detail: 'TASK-0003(검증 근거 무효화 — 재검증 필요)' });
  // 다음 테스트가 완료 Task 없이 보도록 무효화를 다른 PASS 검증으로 대체한다.
  const qa2 = await attemptFor(h.owner, p, done, { kind: 'reverify', status: 'completed', agent: 'Codex', modelId: 'gpt-6.2-sol', no: 2 });
  await h.owner.query("insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual) values($1,$2,'PASS','head',1,'cmd','pass','pass')", [p, qa2]);
  expect(await gate()).toMatchObject({ ok: true });
});

test('DB 제약으로는 막지 못하는 모순을 찾아 보인다(고치지는 않는다)', async () => {
  // Task가 Work Package 아래에 있는지는 DB 트리거가 이미 막는다. 삭제(soft delete)된 Task를 가리키는 의존성은 DB가 막지 않는다.
  await h.owner.query("insert into task_dependencies(project_id,pred,succ,dep_type) values($1,$2,$3,'FS')", [f.project, f.tasks['TASK-0002'], f.tasks['TASK-0001']]);
  await h.owner.query("update tasks set deleted_at=now() where task_key='TASK-0002'");
  await h.owner.query("update agent_models set allowed=false where model_id='claude-opus-5-5'");
  const other = await attemptFor(h.owner, f.project, f.tasks['TASK-0002'] ?? '', { status: 'completed' });
  await h.owner.query("insert into messages(project_id,task,msg_key,attempt,dir,type,to_agent,body,delivery,pending_next,work_state,draft) values($1,$2,'MSG-900',$3,'out','질문','Claude','b','Queued',false,'',false)",
    [f.project, f.tasks['TASK-0001'], other]);
  const failed = Object.fromEntries((await integrity()).items.filter((i) => !i.ok).map((i) => [i.key, i.detail]));
  expect(failed).toEqual({ dependency_refs: 'TASK-0002 → TASK-0001', allowed_per_agent: 'Claude', grade_allowed: 'TASK-0001 dev', message_attempt: 'MSG-900' });
  expect((await h.owner.query("select allowed from agent_models where model_id='claude-opus-5-5'")).rows[0]).toEqual({ allowed: false });
});

test('팀장 로그인이 필요하다', async () => {
  expect((await h.app.inject({ url: '/api/system/integrity' })).statusCode).toBe(401);
});
