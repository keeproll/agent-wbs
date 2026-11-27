import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations } from '../src/index.ts';

test('리뷰 R skip: 0040 적용 뒤 더 작은 when의 마이그레이션을 병합하면 hash 대조가 누락을 거부한다', async () => {
  const url = new URL(inject('testDatabaseUrl')); url.pathname += '_ci_migration';
  await recreateTestDatabase(url.href);
  const pool = createPool(url.href,{ onError:() => undefined });
  const freshUrl = new URL(url); freshUrl.pathname += '_fresh';
  await recreateTestDatabase(freshUrl.href);
  const fresh = createPool(freshUrl.href,{ onError:() => undefined });
  const folder = await mkdtemp(join(tmpdir(),'awbs-ci-migrations-'));
  try {
    await cp(fileURLToPath(new URL('../migrations',import.meta.url)),folder,{ recursive:true });
    const path = join(folder,'meta/_journal.json');
    const journal = JSON.parse(await readFile(path,'utf8')) as { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
    const ci = journal.entries.pop(); expect(ci).toBeDefined(); if (!ci) return;
    await writeFile(path,JSON.stringify(journal));
    await runMigrations(pool,folder);
    const oldCi = `alter table ci_runs add column reporter text;
      alter table ci_steps add column duration_ms bigint not null default 0;
      alter table ci_steps add constraint ci_step_duration check(duration_ms>=0 and duration_ms<=9007199254740991);
      alter table merge_queue add column head_sync jsonb;
      alter table merge_queue add column merge_parents jsonb;`;
    await pool.query(oldCi);
    const project = ((await pool.query("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('이전 CI','','','','','active') returning id")).rows[0] as { id: string }).id;
    const phase = (await pool.query("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH','phase','이전 단계',1) returning id",[project])).rows[0]?.id as string;
    const wp = (await pool.query("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP','work_package',$2,'이전 묶음',1) returning id",[project,phase])).rows[0]?.id as string;
    const task = (await pool.query("insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state) values($1,'TASK-0040',$2,1,'이전 병합','Test','BE','{}',1,'Codex','Codex','gate','none') returning id",[project,wp])).rows[0]?.id as string;
    const job = (await pool.query("insert into runner_jobs(project_id,epoch,kind,payload,state,dedup_key) values($1,1,'attempt','{}','done','old-qa') returning id",[project])).rows[0]?.id as string;
    const attempt = (await pool.query("insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,kind,agent,status,started_at,ended_at,model_id,effort) values($1,$2,'ATT-0040-1',1,$3,'base','head',1,'qa','Codex','completed',now(),now(),'model','high') returning id",[project,task,job])).rows[0]?.id as string;
    const verification = (await pool.query("insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual) values($1,$2,'PASS','head',1,'test','pass','pass') returning id",[project,attempt])).rows[0]?.id as string;
    await pool.query("insert into merge_queue(project_id,task,pr,position,status,qa_head_sha,synced_head_sha,base_sha,verification,actual_merge_sha,actual_tree_sha,merge_parents) values($1,$2,40,1,'checking','head','head','base',$3,'old-merge','old-tree','[\"head\",\"base\"]')",[project,task,verification]);
    await pool.query(`insert into ci_runs(project_id,run_key,stage,pipeline_sha,ref,trigger,status,created_at)
      values($1,'a-old',3,$2,'main','night','pass','2026-01-01'),($1,'z-new',3,$2,'main','night','fail','2026-02-01')`,[project,'a'.repeat(40)]);
    await pool.query("insert into agent_usage(agent,remain_pct,reset_at,created_at) values('Codex',20,now(),'2026-01-01'),('Codex',10,now(),'2026-02-01')");
    // 물리 저장 순서가 달라도 마이그레이션 전의 시간 순서를 보존해야 한다.
    await pool.query('create index review_ci_physical on ci_runs(run_key desc)');
    await pool.query('cluster ci_runs using review_ci_physical');
    await pool.query('drop index review_ci_physical');
    await pool.query('insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)',[createHash('sha256').update(oldCi).digest('hex'),1795740000040]);
    journal.entries.push({ ...ci,tag:'0026_20261127_late_worker',when:1795740000005 });
    journal.entries.push({ ...ci,idx:ci.idx+1 });
    await writeFile(join(folder,'0026_20261127_late_worker.sql'),'CREATE TABLE public.review_late_worker(id integer);');
    await writeFile(path,JSON.stringify(journal));
    await expect(runMigrations(pool,folder)).rejects.toThrow('적용되지 않은 마이그레이션');
    expect((await pool.query('select run_key from ci_runs order by run_no')).rows).toEqual([{ run_key:'a-old' },{ run_key:'z-new' }]);
    expect((await pool.query("select merge_sha,tree_sha,parents from ci_merge_facts where project_id=$1",[project])).rows).toEqual([{ merge_sha:'old-merge',tree_sha:'old-tree',parents:['head','base'] }]);
    expect((await pool.query('select remain_pct from agent_usage order by record_no')).rows).toEqual([{ remain_pct:'20' },{ remain_pct:'10' }]);
    expect((await pool.query("select current_setting('session_replication_role') role")).rows).toEqual([{ role:'origin' }]);
    await pool.query("insert into agent_usage(agent,remain_pct,reset_at,created_at) values('Codex',33,now(),'2000-01-01')");
    expect((await pool.query('select remain_pct from agent_usage order by record_no desc limit 1')).rows).toEqual([{ remain_pct:'33' }]);
    expect((await pool.query("select to_regclass('public.review_late_worker') name")).rows).toEqual([{ name:null }]);
    await runMigrations(fresh,folder);
    expect((await fresh.query("select to_regclass('public.review_late_worker') name")).rows).toEqual([{ name:'review_late_worker' }]);
  } finally { await pool.end(); await fresh.end(); await rm(folder,{ recursive:true,force:true }); }
},30_000);
