import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPool, recreateTestDatabase } from '../src/index.ts';
import { assertTestDatabaseUrl } from '../src/test-database.ts';

const url=process.env.TEST_DATABASE_URL;
assertTestDatabaseUrl(url);
const folder=fileURLToPath(new URL('../migrations',import.meta.url));
const previous=await mkdtemp(join(tmpdir(),'awbs-m101-benchmark-'));
try {
  await cp(folder,previous,{recursive:true});
  const path=join(previous,'meta/_journal.json');
  const journal=JSON.parse(await readFile(path,'utf8')) as {entries:{idx:number}[]};
  journal.entries=journal.entries.filter(e=>e.idx<=3);
  await writeFile(path,JSON.stringify(journal));
  for(const [name,migrationsFolder] of [['before',previous],['after',folder]] as const) {
    const dbUrl=new URL(url as string); dbUrl.pathname+=`_bench_${name}`;
    await recreateTestDatabase(dbUrl.href);
    const pool=createPool(dbUrl.href,{max:1,onError:()=>undefined});
    try {
      await migrate(drizzle(pool),{migrationsFolder});
      await pool.query('insert into system_state(id) values(1) on conflict do nothing');
      const p=(await pool.query("insert into projects(name,repo_url,repo_owner,repo_name,base_commit,lead_instruction,phase) values('benchmark','','','','base','','active') returning id")).rows[0]?.id as string;
      const phase=(await pool.query("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH','phase','phase',0) returning id",[p])).rows[0]?.id as string;
      const wp=(await pool.query("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP','work_package',$2,'wp',0) returning id",[p,phase])).rows[0]?.id as string;
      await pool.query("insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state) select $1,'TASK-'||n,$2,n,'benchmark','Test','BE','{}',1,'Claude','Codex','ready','none' from generate_series(1,200) n",[p,wp]);
      await pool.query(`insert into runner_jobs(project_id,kind,payload,state,epoch${name==='after'?',dedup_key':''}) select $1,'attempt',jsonb_build_object('task',t.id,'n',n),'done',1${name==='after'?',gen_random_uuid()::text':''} from tasks t cross join generate_series(1,10) n`,[p]);
      await pool.query("insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,kind,agent,status,started_at,ended_at,model_id,effort) select $1,(payload->>'task')::uuid,'ATT-'||id,(payload->>'n')::int,id,'base','head',1,'qa','Codex','completed',now(),now(),'model','high' from runner_jobs",[p]);
      await pool.query("insert into attempt_observations(project_id,attempt,cli,version,grade,reserved,state,process_state,at) select $1,a.id,'Codex','fixture','unver',1,'ok','{}',now() from task_attempts a cross join generate_series(1,50) n",[p]);
      await pool.query("insert into task_history(project_id,task,actor,kind,text) select $1,t.id,'Runner','실행','benchmark' from tasks t cross join generate_series(1,250) n",[p]);
      const before=(await pool.query('select (select count(*)::int from tasks) tasks,(select count(*)::int from task_attempts) attempts,(select count(*)::int from attempt_observations) observations,(select count(*)::int from task_history) history')).rows[0];
      assert.deepEqual(before,{tasks:200,attempts:2000,observations:100000,history:50000});
      const start=performance.now();
      const result=await pool.query("select reset_project(1,'benchmark',false,'benchmark') epoch");
      const resetMs=Math.round(performance.now()-start);
      assert.equal(result.rows[0]?.epoch,2);
      assert.equal((await pool.query('select count(*)::int n from tasks')).rows[0]?.n,0);
      console.log(JSON.stringify({name,...before,resetMs}));
    } finally { await pool.end(); }
  }
} finally { await rm(previous,{recursive:true,force:true}); }
