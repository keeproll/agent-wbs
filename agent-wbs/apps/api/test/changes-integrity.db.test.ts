// M2-08 무결성 점검 GET /api/system/integrity — 실제 PostgreSQL.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { attemptFor, harness, projectWith, type Harness, type ProjectFixture } from './m208-fixture.ts';

let h: Harness;
let f: ProjectFixture;
beforeAll(async () => {
  h = await harness('m208_integrity');
  f = await projectWith(h.owner, ['ready', 'ready']);
  await h.owner.query("insert into agent_models(agent,model_id,allowed,is_new,report) values('Claude','claude-opus-5-5',true,false,$1),('Codex','gpt-6.2-sol',true,false,$1)",
    [{ efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }]);
  await h.owner.query("insert into task_grades(project_id,task,role,model_id,effort,reason,locked,effective_from) values($1,$2,'dev','claude-opus-5-5','high','근거',false,now())", [f.project, f.tasks['TASK-0001']]);
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
