// Codex 재리뷰(review-fix/INDEPENDENT-REVIEW.md)의 R1·R2 재현 검사를 옮긴 회귀 테스트.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { harness, projectWith, attemptFor, type Harness, type ProjectFixture } from './m208-fixture.ts';
import { encodeCursor } from '../src/changes/history.ts';

let h: Harness;
let f: ProjectFixture;
beforeAll(async () => {
  h=await harness('m208_rereview');
  f=await projectWith(h.owner,['done']);
  const task=f.tasks['TASK-0001'] ?? '';
  await h.owner.query("update tasks set planning_approved_at=now(),verif_state='pass' where id=$1",[task]);
  await h.owner.query("insert into task_specs(project_id,task,overview,spec,ac,revision) values($1,$2,'{}','{}','[]',1)",[f.project,task]);
  await h.owner.query("insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order) values($1,$2,'CL-1','verified',true,true,'test',0)",[f.project,task]);
  await h.owner.query("insert into task_outputs(project_id,task,name,kind,required,verify,delivered) values($1,$2,'API','code',true,'test',true)",[f.project,task]);
  const qa=await attemptFor(h.owner,f.project,task,{kind:'qa',status:'completed',agent:'Codex',modelId:'gpt-6.2-sol'});
  await h.owner.query("insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual) values($1,$2,'PASS','head',1,'test','pass','pass')",[f.project,qa]);
  const job=(await h.owner.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'integrate','{}','done',1,gen_random_uuid()::text) returning id",[f.project])).rows[0].id;
  await h.owner.query("insert into ci_runs(project_id,run_key,stage,head_sha,pipeline_sha,ref,task,attempt,trigger,status,job,fence) values($1,'CI-BOUNDARY',1,'head','sha','main',$2,$3,'test','pass',$4,1)",[f.project,task,qa,job]);
});
afterAll(async()=>h.close());

test('known complete gate has all stored evidence and passes',async()=>{
  const res=await h.lead('GET','/api/system/integrity');
  const gate=res.body.items.find((i:{key:string})=>i.key==='done_gate');
  console.log('OBS healthy done gate',JSON.stringify(gate));
  expect(gate.ok).toBe(true);
});

test('R1: 결과가 아직 없는 새 QA·재검증이 있으면 예전 PASS로 완료 무결성을 통과하지 않는다',async()=>{
  const latest=await attemptFor(h.owner,f.project,f.tasks['TASK-0001'] ?? '',{kind:'reverify',status:'running',no:2,agent:'Codex',modelId:'gpt-6.2-sol'});
  const res=await h.lead('GET','/api/system/integrity');
  const gate=res.body.items.find((i:{key:string})=>i.key==='done_gate');
  console.log('OBS done plus running reverify',JSON.stringify({latest,gate}));
  expect(gate.ok).toBe(false);
  expect(gate.detail).toContain('검증 진행 중');
});

test('R1: 새 재검증이 끝났지만 결과(검증 행)가 없으면 「검증 미실시」로 실패', async () => {
  await h.owner.query("update task_attempts set status='completed',ended_at=now() where kind='reverify' and status='running'");
  const gate=(await h.lead('GET','/api/system/integrity')).body.items.find((i:{key:string})=>i.key==='done_gate');
  expect(gate).toMatchObject({ ok: false });
  expect(gate.detail).toContain('검증 미실시');
});

test('R2: 연도 0 시각이 든 커서는 세 경로 모두 400',async()=>{
  const cursor=encodeCursor(['0000-01-01T00:00:00Z','00000000-0000-4000-8000-000000000000']);
  const results=[
    await h.lead('GET',`/api/history?cursor=${cursor}`),
    await h.lead('GET',`/api/messages?cursor=${cursor}`),
    await h.runner('GET',`/api/runner/messages?cursor=${cursor}`),
  ];
  console.log('OBS year zero cursor',JSON.stringify(results.map(r=>({status:r.status,body:r.body}))));
  expect(results.map(r=>r.status)).toEqual([400,400,400]);
});
