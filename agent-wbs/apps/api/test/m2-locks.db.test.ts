// M2 통합 교차 리뷰(m2-integration-cross-review) F1·F4 재현 회귀 시험.
// F1: analyzeInputs(프로젝트 잠금 → Gate Task 잠금)와 Task 수정(Task 잠금 → 이력 INSERT의 프로젝트 외래 키 KEY SHARE)이 교착하지 않아야 한다.
import assert from 'node:assert/strict';
import { createPool, recreateTestDatabase, runMigrations, seedSystem, type PoolClient } from '@awbs/db';
import { beforeAll, afterAll, expect, inject, test, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { issueLoginLink } from '../src/platform/credentials.ts';
import { projectWith, attemptFor } from './m208-fixture.ts';
import { exportProject } from '../src/reset/export.ts';

const url=new URL(inject('testDatabaseUrl'));url.pathname+='_m2locks';
const owner=createPool(url.href,{max:8,onError:()=>undefined});
const appUrl=new URL(url);appUrl.searchParams.set('options','-c role=awbs_app');
const pool=createPool(appUrl.href,{max:8,onError:()=>undefined});
const origin='http://127.0.0.1:3100';
const app=buildApp(pool,false,{origin,lan:false});
let cookie='',csrf='',project='',taskId='';
let taskLocked:()=>void,releasePatch:()=>void;
let pausePatch=false;
app.addHook('preHandler',async request=>{
 if(!pausePatch || request.method!=='PATCH')return;
 pausePatch=false;
 const client=request.platform?.client;assert(client);
 const query=client.query;
 client.query=function(this:PoolClient,...args:unknown[]){
  if(typeof args[0]==='string' && args[0].includes('from tasks where task_key=$1 for update')){
   this.query=query;
   return (Reflect.apply(query,this,args) as Promise<unknown>).then(async result=>{
    taskLocked();await new Promise<void>(r=>{releasePatch=r;});return result;
   });
  }
  return Reflect.apply(query,this,args);
 } as PoolClient['query'];
});
const lead=(method:'GET'|'POST'|'PATCH',path:string,payload?:object)=>app.inject({method,url:path,headers:{cookie,origin,'x-csrf-token':csrf},...(payload&&{payload})});
beforeAll(async()=>{
 await recreateTestDatabase(url.href);await runMigrations(owner);await seedSystem(owner);
 const f=await projectWith(owner,['gate']);project=f.project;taskId=f.tasks['TASK-0001']??'';
 await owner.query("insert into task_specs(project_id,task,overview,spec,ac,revision) values($1,$2,'{}','{}','[]',1)",[project,taskId]);
 await owner.query("insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,1,$2,'[]','[]','[]','')",[project,'a'.repeat(40)]);
 const input=(await owner.query('select id from input_versions where project_id=$1',[project])).rows[0].id;
 const qa=await attemptFor(owner,project,taskId,{kind:'qa',status:'running',agent:'Codex',modelId:'gpt-6.1-sol'});
 await owner.query("update task_attempts set input_version=$2,head_sha=$3,status='completed',ended_at=now() where id=$1",[qa,input,'a'.repeat(40)]);
 await owner.query("insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual) values($1,$2,'PASS',$3,1,'check','pass','pass')",[project,qa,'a'.repeat(40)]);
 await owner.query("insert into ci_runs(project_id,run_key,stage,head_sha,pipeline_sha,ref,task,trigger,status,job,fence,spec_revision,input_version) select $1,'CI-1',1,$3,'pipeline','main',$2,'t','pass',job,1,1,$4 from task_attempts where id=$5",[project,taskId,'a'.repeat(40),input,qa]);
 await owner.query("update tasks set planning_approved_at=now(),execution_head_sha=$2,verif_state='pass' where id=$1",[taskId,'a'.repeat(40)]);
 const report={seq:1,base:'a'.repeat(40),head:'b'.repeat(40),tree:'c'.repeat(40),changes:[{status:'A',path:'prototype/docs/new.md',oldBlob:null,newBlob:'d'.repeat(40),oldMode:null,newMode:'100644',added:1,deleted:0}],commits:[],receivedAt:new Date().toISOString()};
 await owner.query("insert into input_change_commits(project_id,sha,files,state) values($1,$2,$3,'pending')",[project,report.head,report]);
 await owner.query("insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order) values($1,$2,'CL-1','확인',false,false,'테스트',1)",[project,taskId]);
 await owner.query("insert into task_outputs(project_id,task,name,kind,required,verify,delivered) values($1,$2,'API','코드',true,'테스트',true)",[project,taskId]);
 const token=await issueLoginLink(pool);
 const login=await app.inject({method:'POST',url:'/api/auth/session',headers:{origin},payload:{method:'link',token}});
 cookie=String(login.headers['set-cookie']).split(';')[0]??'';
 csrf=(await lead('GET','/api/session')).json().csrfToken;
});
afterAll(async()=>{await app.close();await pool.end();await owner.end();});

test('실제 PATCH 체크리스트와 POST 입력 분석이 교착 없이 200/202(교차 리뷰 F1)',async()=>{
 const initialGate=(await lead('GET','/api/tasks/TASK-0001/gate')).json();
 expect(initialGate.passed).toBe(true);
 const beforeTask=(await lead('GET','/api/tasks/TASK-0001')).json();
 const beforeProject=(await lead('GET','/api/project')).json();
 const entered=new Promise<void>(r=>{taskLocked=r;});pausePatch=true;
 const patch=lead('PATCH','/api/tasks/TASK-0001/checklist/CL-1',{updatedAt:beforeTask.updatedAt,note:'교차 리뷰 변경'}).then(r=>r);
 await entered;
 const analysis=lead('POST','/api/project/inputs',{updatedAt:beforeProject.updatedAt,commit:'b'.repeat(40),commits:['b'.repeat(40)]}).then(r=>r);
 try {
  await vi.waitFor(async()=>{
  const wait=(await owner.query("select query from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%from tasks where task_key=$1%for update%'")).rowCount;
   expect(wait).toBeGreaterThan(0);
  },{timeout:10_000});
 } finally { releasePatch(); }
 const result=await Promise.all([patch,analysis]);
 expect(result.map(r=>r.statusCode)).toEqual([200,202]);
},30000);

test('내보내기 전체 상한은 data.json·manifest.json에도 적용된다(교차 리뷰 F4)',async()=>{
 await expect(exportProject(pool,1,'/nonexistent-root',1)).rejects.toMatchObject({code:'UNAVAILABLE',details:{reason:'export_too_large',limitBytes:1}});
});
