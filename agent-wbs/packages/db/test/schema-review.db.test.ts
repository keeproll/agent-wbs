import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, expect, inject, test, vi } from 'vitest';
import { createPool, recreateTestDatabase, seedDemo, seedSystem } from '../src/index.ts';
import { fillProjectTables } from './project-fixture.ts';

const reviewUrl = new URL(inject('testDatabaseUrl'));
reviewUrl.pathname += '_review';
const url = reviewUrl.href;
const pool = createPool(url, { max: 6, onError: () => undefined });
const login = `m101_app_${process.pid}`;
const password = randomUUID();
beforeAll(async () => {
  await recreateTestDatabase(url);
  await migrate(drizzle(pool), {
    migrationsFolder:
      process.env.AWBS_MUTATION_MIGRATIONS ??
      fileURLToPath(new URL('../migrations', import.meta.url)),
  });
  await seedSystem(pool);
  await pool.query(`create role ${login} login password '${password}'`);
  await pool.query(`grant awbs_app to ${login}`);
});
afterAll(async () => {
  await pool.query(`drop role if exists ${login}`);
  await pool.end();
});

async function transaction(fn: (c: pg.PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await fn(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}
async function rejects(c: pg.PoolClient, sql: string, values: unknown[] = [], code = '23514') {
  await c.query('savepoint invalid');
  await expect(c.query(sql, values)).rejects.toMatchObject({ code });
  await c.query('rollback to savepoint invalid');
}
async function id(c: pg.PoolClient, sql: string, values: unknown[] = []) {
  const row = (await c.query<{ id: string }>(`${sql} returning id`, values)).rows[0];
  assert(row);
  return row.id;
}
async function fixture(c: pg.PoolClient) {
  const p = await id(
    c,
    "insert into projects(name,repo_url,repo_owner,repo_name,base_commit,lead_instruction,phase) values('review','','','','base','','active')",
  );
  const phase = await id(
    c,
    "insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH','phase','phase',0)",
    [p],
  );
  const wp = await id(
    c,
    "insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP','work_package',$2,'wp',0)",
    [p, phase],
  );
  const task = await id(
    c,
    "insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state) values($1,'TASK-1',$2,0,'task','Test','BE','{}',1,'Claude','Codex','ready','none')",
    [p, wp],
  );
  const job = await newJob(c, p);
  return { p, phase, wp, task, job };
}
async function newJob(c: pg.PoolClient, p: string) {
  return id(
    c,
    "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'attempt','{}','queued',1,gen_random_uuid()::text)",
    [p],
  );
}
async function newHold(c: pg.PoolClient, f: Awaited<ReturnType<typeof fixture>>) {
  return id(
    c,
    "insert into execution_holds(project_id,job,task,epoch,agent,slots,heavy,host_id,boot_id,fence,slot_state,lock_state) values($1,$2,$3,1,'Claude',1,false,'host','boot',5,'reserved','held')",
    [f.p, f.job, f.task],
  );
}

test('P0: real LOGIN cannot shadow definer types or execute as its owner', async () => {
  const dbName = new URL(url).pathname.slice(1);
  await pool.query(`grant temporary on database ${dbName} to ${login}`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  const app = new pg.Client({ connectionString: appUrl.href });
  await app.connect();
  try {
    await app.query('begin');
    await app.query('create temporary table calls(who text)');
    await app.query(
      "create function pg_temp.evil(v pg_catalog.text) returns boolean language plpgsql as 'begin insert into pg_temp.calls values(current_user); return true; end'",
    );
    await app.query('create domain pg_temp.text as pg_catalog.text check(pg_temp.evil(value))');
    await app.query(
      "insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('exploit','','','','','active')",
    );
    await app.query("select public.reset_project(1,'exploit',false,'lead')");
    expect((await app.query('select * from pg_temp.calls')).rows).toEqual([]);
    await app.query('rollback');
    const functions = await pool.query(
      "select p.proname,p.proconfig,r.rolsuper,r.rolcreaterole,r.rolreplication from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and p.prosecdef",
    );
    for (const f of functions.rows) {
      expect(f.proconfig).toContain('search_path=pg_catalog, pg_temp');
      expect(f.rolsuper || f.rolcreaterole || f.rolreplication).toBe(false);
    }
  } finally {
    await app.end();
    await pool.query(`revoke temporary on database ${dbName} from ${login}`);
  }
  expect(
    (
      await pool.query("select has_database_privilege($1,current_database(),'TEMP') as allowed", [
        login,
      ])
    ).rows[0]?.allowed,
  ).toBe(false);
});

test('P1-1: contractual relationship/settings/token DELETE works; event retention is bounded', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    await fillProjectTables(c,f);
    const task2=(await c.query("select id from tasks where task_key='TASK-2'")).rows[0]?.id;
    await c.query("insert into mail_recipients(email,name,active,daily,weekly,pdf,view) values('mail@example.invalid','fixture',false,false,false,false,'int')");
    await c.query("insert into blackout_days(date,note) values(current_date,'fixture')");
    await c.query("insert into lead_sessions(token_hash,expires_at,csrf) values('fixture-session',now()+interval '1 hour','csrf')");
    await c.query("insert into lead_login_tokens(token_hash,expires_at) values('fixture-link',now()+interval '1 hour')");
    await c.query("insert into runner_tokens(token_hash,runner_id,public_key) values('fixture-runner','runner','key')");
    await c.query("insert into secrets(key,ciphertext,nonce,key_version,last4) values('fixture-secret','encrypted','nonce',1,'1234')");
    await c.query("insert into file_delete_queue(epoch,path,reason) values(1,'1/fixture','test')");
    await c.query('set local role awbs_app');
    await c.query('delete from task_dependencies');
    await c.query(
      "insert into task_dependencies(project_id,pred,succ,dep_type) values($1,$2,$3,'SS')",
      [f.p, f.task, task2],
    );
    for (const t of [
      'checklist_items',
      'mail_recipients',
      'blackout_days',
      'lead_sessions',
      'lead_login_tokens',
      'runner_tokens',
      'secrets',
      'file_delete_queue',
      'task_subagents',
      'task_design_items',
    ])
      { expect((await c.query(`delete from ${t}`)).rowCount,t).toBeGreaterThan(0); }
    const existing=(await c.query('select count(*)::int n from change_events')).rows[0]?.n as number;
    await c.query(
      "insert into change_events(project_id,topic,ref,at) values($1,'settings','{}',now()-interval '8 days'),($1,'settings','{}',now())",
      [f.p],
    );
    await rejects(c, 'delete from change_events', [], '42501');
    await c.query('select public.prune_change_events()');
    expect((await c.query('select count(*)::int n from change_events')).rows[0]?.n).toBe(existing+1);
  }));

test('P1-2: pre-project writes and scoped uniqueness work without losing reset deletion', () =>
  transaction(async (c) => {
    await c.query('set local role awbs_app');
    await c.query(
      "insert into idempotency_keys(principal,key,request_hash,response,epoch) values('runner','registration','hash','{}',1)",
    );
    await rejects(
      c,
      "insert into idempotency_keys(principal,key,request_hash,response,epoch) values('runner','registration','hash','{}',1)",
      [],
      '23505',
    );
    await c.query("insert into change_events(topic,ref) values('runner','{}')");
    await c.query("insert into task_history(actor,kind,text) values('lead','settings','changed')");
    await c.query(
      "insert into notify_log(delivery_id,kind,state,at) values(gen_random_uuid(),'test','accepted',now())",
    );
    await c.query(
      "insert into notify_events(dedup_key,kind,ref) values('admin|runner','admin','{}')",
    );
    await c.query("insert into alerts(key,severity,target) values('runner','error','{}')");
    const f = await fixture(c);
    await c.query("insert into idempotency_keys(project_id,principal,key,request_hash,response,epoch) values($1,'runner','registration','hash','{}',1)", [f.p]);
    await c.query("insert into idempotency_keys(principal,key,request_hash,response,epoch) values('runner','registration','hash','{}',2)");
    await c.query("insert into notify_events(project_id,dedup_key,kind,ref) values($1,'admin|runner','admin','{}')", [f.p]);
  }));

test('P1-3/P2-10: reset restores system defaults from the same source, preserving mappings and definitions', () =>
  transaction(async (c) => {
    await fixture(c);
    await c.query('update app_settings set heartbeat_seconds=10');
    await c.query(
      "insert into subagent_defs(def_key,version,agent,role,tools,sandbox,text,hash) values('reviewed-v1',1,'Claude','dev','{}','read-only','reviewed','hash')",
    );
    await c.query("select reset_project(1,'review',false,'lead')");
    expect(
      (await c.query('select heartbeat_seconds from app_settings')).rows[0]?.heartbeat_seconds,
    ).toBe(60);
    expect((await c.query('select count(*)::int n from agent_efforts')).rows[0]?.n).toBe(74);
    expect((await c.query('select count(*)::int n from subagent_defs')).rows[0]?.n).toBe(1);
    expect((await c.query('select cp_auto from schedule_policy')).rows[0]?.cp_auto).toBe(true);
  }));

test('P1-4: reset preserves blocked authority and generation cannot fall or be deleted', () =>
  transaction(async (c) => {
    await fixture(c);
    await c.query(
      "insert into external_write_authority(host_id,generation,state,blocked_reason) values('old',7,'blocked','changed host')",
    );
    await c.query("select reset_project(1,'review',false,'lead')");
    expect((await c.query('select generation,state from external_write_authority')).rows).toEqual([
      { generation: 7, state: 'blocked' },
    ]);
    await rejects(c, 'update external_write_authority set generation=1');
    expect((await c.query('select payload from runner_commands')).rows[0]?.payload.generation).toBe(
      7,
    );
  }));

test('P1-5: cleanup collects CI and queued job refs as well as attempts', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    await fillProjectTables(c, f);
    await c.query("update merge_queue set pr=44");
    await c.query("update design_snapshots set ref='agent/design'");
    await c.query("update task_attempts set branch='agent/attempt'");
    await c.query("insert into runner_commands(kind,epoch,payload,status) values('reset-cleanup',0,'{\"prs\":[45],\"branches\":[\"agent/previous\"]}','done')");
    await c.query(
      "insert into ci_runs(project_id,run_key,stage,pipeline_sha,ref,pr,trigger,status) values($1,'CI-1',2,'sha','agent/T1',42,'manual','queued')",
      [f.p],
    );
    await c.query(
      "update runner_jobs set payload='{" + '"branch":"agent/prestart","pr":43' + "}' where id=$1",
      [f.job],
    );
    await c.query("select reset_project(1,'review',true,'lead')");
    const payload = (await c.query('select payload from runner_commands where epoch=1')).rows[0]?.payload;
    expect(payload.branches).toEqual(['agent/T1', 'agent/attempt', 'agent/design', 'agent/prestart', 'agent/previous']);
    expect(payload.prs).toEqual([42, 43, 44, 45]);
  }));

test.each(['runner_jobs', 'runner_commands'])(
  'P2-N1: reset preserves valid and malformed PR values from %s, including closed jobs',
  (source) => transaction(async (c) => {
    const f = await fixture(c);
    await c.query("update runner_jobs set payload='{\"pr\":44}',state='done' where id=$1", [f.job]);
    const valid = [42, '0043', 2147483647];
    const invalid = [3000000000, '99999999999', 'not-a-pr', 0, -1, null, true, { pr: 45 }, '9'.repeat(150000)];
    const expected = [];
    if (source === 'runner_jobs') {
      for (const value of [...valid, ...invalid]) {
        const job = await newJob(c, f.p);
        await c.query("update runner_jobs set payload=$2,state='done' where id=$1", [job, { pr: value }]);
        if (invalid.includes(value)) expected.push({ source, id: job, value });
      }
      await rejects(c, "update runner_jobs set payload='{}' where id=$1", [f.job]);
    } else {
      const command = await id(c, "insert into runner_commands(kind,epoch,payload,status) values('reset-cleanup',0,$1,'done')", [{ prs: [...valid, ...invalid] }]);
      expected.push(...invalid.map((value) => ({ source, id: command, value })));
    }
    await c.query('set local role awbs_app');
    await c.query("select reset_project(1,'review',true,'lead')");
    const first = (await c.query('select payload from runner_commands where epoch=1')).rows[0]?.payload;
    expect(first.prs).toEqual([42, 43, 44, 2147483647]);
    expect(first.unparsedPrs).toHaveLength(expected.length);
    expect(first.unparsedPrs).toEqual(expect.arrayContaining(expected));
    await fixture(c);
    await c.query("select reset_project(2,'review',true,'lead')");
    const second = (await c.query('select payload from runner_commands where epoch=2')).rows[0]?.payload;
    expect(second.prs).toEqual(first.prs);
    expect(second.unparsedPrs).toEqual(first.unparsedPrs);
  }),
);

test('P2-N1: reset preserves prior command PR values even when prs is not an array', () =>
  transaction(async (c) => {
    await fixture(c);
    const command = await id(c, "insert into runner_commands(kind,epoch,payload,status) values('reset-cleanup',0,'{\"prs\":{\"original\":\"bad-list\"}}','done')");
    await c.query("insert into runner_commands(kind,epoch,payload,status) values('reset-cleanup',0,'{\"prs\":\"46\"}','done')");
    await c.query('set local role awbs_app');
    await c.query("select reset_project(1,'review',true,'lead')");
    const payload = (await c.query('select payload from runner_commands where epoch=1')).rows[0]?.payload;
    expect(payload.prs).toEqual([46]);
    expect(payload.unparsedPrs).toEqual([{ source: 'runner_commands', id: command, value: { original: 'bad-list' } }]);
  }));

test('P2-1: start retains reserved until process registration; duplicate process is inert', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    const h = await newHold(c, f);
    const attempt = await id(c,
      "insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,kind,agent,status,started_at,model_id,effort) values($1,$2,'ATT-start',1,$3,'base','head',1,'dev','Claude','running',now(),'model','high')",
      [f.p, f.task, f.job]);
    await c.query('update execution_holds set attempt=$2 where id=$1', [h, attempt]);
    await c.query("update runner_jobs set state='started' where id=$1", [f.job]);
    expect((await c.query('select slot_state,pgid from execution_holds where id=$1', [h])).rows[0])
      .toEqual({ slot_state: 'reserved', pgid: null });
    await c.query("update execution_holds set slot_state='active',pgid=123,cgroup='launch' where id=$1", [h]);
    await c.query("update execution_holds set slot_state='active',pgid=123,cgroup='launch' where id=$1", [h]);
    await rejects(c, 'update execution_holds set pgid=456 where id=$1', [h]);
    await c.query("update execution_holds set slot_state='unconfirmed' where id=$1", [h]);
    await rejects(c, "update execution_holds set slot_state='none',release_proof='no_process' where id=$1", [h]);
    await c.query("update execution_holds set slot_state='none',release_proof='group_empty' where id=$1", [h]);
  }));

test('P2-5: cleanup cannot accept a null proof for a recorded hold', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    await newHold(c, f);
    await c.query("select reset_project(1,'review',true,'lead')");
    const command = (await c.query('select id from runner_commands')).rows[0]?.id;
    await c.query('set local role awbs_app');
    const proof = { job: f.job, hostId: 'host', bootId: 'boot', proof: null };
    await rejects(c, 'select complete_cleanup($1,1,true,$2)', [command, { holds: [proof] }], 'AW002');
    await c.query('select complete_cleanup($1,1,true,$2)', [command, { holds: [{ ...proof, proof: 'no_process' }] }]);
    expect((await c.query('select cleanup_status from system_state')).rows[0]?.cleanup_status).toBe('none');
  }));

test('P2-5: cleanup payload is protected and a recorded cgroup rules out no_process', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    const hold = await newHold(c, f);
    await c.query("update execution_holds set slot_state='active',cgroup='recorded-group' where id=$1", [hold]);
    await c.query("update execution_holds set slot_state='unconfirmed' where id=$1", [hold]);
    await c.query("select reset_project(1,'review',true,'lead')");
    const command = (await c.query('select id from runner_commands')).rows[0]?.id;
    await c.query('set local role awbs_app');
    await rejects(c, "update runner_commands set payload='{\"holds\":[]}'", [], '42501');
    await rejects(c, 'select complete_cleanup($1,1,true,$2)', [command, {
      holds: [{ job: f.job, hostId: 'host', bootId: 'boot', proof: 'no_process' }],
    }], 'AW002');
  }));

test('D-34: hold reasons reject null codes and preserve nullable issue indexes', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    await c.query("insert into change_proposals(project_id,cp_key,source,status,ops) values($1,'CP-shape','manual','held','[]')", [f.p]);
    await rejects(c, 'update change_proposals set hold_reasons=$1', [{
      holdReasons: [{ code: null, message: 'reason' }], issues: [],
    }]);
    await c.query('update change_proposals set hold_reasons=$1', [{
      holdReasons: [], issues: [{ index: null, code: 'CYCLE', message: 'proposal issue' }],
    }]);
  }));

test('P2-1: holds reject invalid insertion, identity changes, stale proof, host/fence rollback and instant activation', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    const h = await newHold(c, f);
    await rejects(c, 'update execution_holds set task=null,conflict_group=null where id=$1', [h]);
    await rejects(
      c,
      "update execution_holds set slot_state='none',release_proof='group_empty',lock_state='released',closed_at=now(),host_id='other' where id=$1",
      [h],
    );
    await rejects(c, 'update execution_holds set fence=1 where id=$1', [h]);
    await rejects(c, "update execution_holds set release_proof='group_empty' where id=$1", [h]);
    await c.query("update execution_holds set slot_state='active',pgid=123 where id=$1", [h]);
    await rejects(
      c,
      "update execution_holds set slot_state='none',release_proof='no_process' where id=$1",
      [h],
    );
    await rejects(c, "update execution_holds set lock_state='orphaned' where id=$1", [h]);
    await c.query(
      "update execution_holds set slot_state='none',release_proof='group_empty' where id=$1",
      [h],
    );
    await rejects(c, "update execution_holds set slot_state='active',pgid=123 where id=$1", [h]);
  }));

test.each(['active', 'unconfirmed'])('P2-1: INSERT cannot bypass hold lifecycle with %s', (state) =>
  transaction(async (c) => {
    const f = await fixture(c);
    await rejects(
      c,
      "insert into execution_holds(project_id,job,task,epoch,agent,slots,heavy,host_id,boot_id,fence,slot_state,lock_state) values($1,$2,$3,1,'Claude',1,false,'host','boot',1,$4,'held')",
      [f.p, f.job, f.task, state],
    );
  }),
);

test('P2-1: deferred handover requires the reciprocal receiving row', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    const h = await newHold(c, f);
    const b = await newJob(c, f.p);
    await c.query(
      "update execution_holds set slot_state='none',release_proof='no_process' where id=$1",
      [h],
    );
    await c.query(
      "update execution_holds set lock_state='handed_over',handed_to_job=$2,closed_at=now() where id=$1",
      [h, b],
    );
    await rejects(c, 'set constraints all immediate');
  }));

test('P2-2: followup dedup, terminal jobs and monotone fencing', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    await c.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'attempt','{}','queued',1,'retry:attempt:1')",[f.p]);
    await rejects(c,"update runner_jobs set dedup_key='changed' where id=$1",[f.job]);
    await rejects(
      c,
      "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'attempt','{}','queued',1,'retry:attempt:1')",
      [f.p],
      '23505',
    );
    await c.query('update runner_jobs set fence=5 where id=$1', [f.job]);
    await rejects(c, 'update runner_jobs set fence=1 where id=$1', [f.job]);
    await c.query("update runner_jobs set state='done' where id=$1", [f.job]);
    await rejects(c, "update runner_jobs set state='queued' where id=$1", [f.job]);
  }));

test.each(['accepted', 'failed'])('P2-3: %s delivery still owns its event outbox', (state) =>
  transaction(async (c) => {
    const f = await fixture(c);
    const event = await id(
      c,
      "insert into notify_events(project_id,dedup_key,kind,ref) values($1,'done|task','done','{}')",
      [f.p],
    );
    await c.query(
      "insert into notify_outbox(project_id,event,delivery_id,epoch,state,payload,kind) values($1,$2,gen_random_uuid(),1,$3,'{}','biz')",
      [f.p, event, state],
    );
    await rejects(
      c,
      "insert into notify_outbox(project_id,event,delivery_id,epoch,state,payload,kind) values($1,$2,gen_random_uuid(),1,'queued','{}','biz')",
      [f.p, event],
      '23505',
    );
  }),
);

test('P2-4: input analysis result is appended separately and pending replan can finish exactly once', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    const input = await id(
      c,
      "insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,1,'sha','[]','[]','[]','')",
      [f.p],
    );
    await c.query(
      "insert into input_version_results(project_id,input_version,result) values($1,$2,'{}')",
      [f.p, input],
    );
    await rejects(c, "update input_version_results set result='[]'", [], '42501');
    const rp = await id(
      c,
      "insert into replans(project_id,rp_key,trigger,actor,status,before,after) values($1,'RP-1','manual','lead','pending','{}','{}')",
      [f.p],
    );
    await c.query(
      "update replans set status='applied',baseline_v=1,after='{" +
        '"date":"2026-11-25"' +
        "}' where id=$1",
      [rp],
    );
    await rejects(c, "update replans set after='[]' where id=$1", [rp]);
    await rejects(c, "update replans set status='pending' where id=$1", [rp]);
    await rejects(c, 'truncate task_history', [], '42501');
  }));

test('P2-5: cleanup completion is guarded, bounded and callable by the app', () =>
  transaction(async (c) => {
    await fixture(c);
    await c.query("select reset_project(1,'review',true,'lead')");
    const command = (await c.query('select id from runner_commands')).rows[0]?.id;
    await c.query('set local role awbs_app');
    await rejects(c, 'select complete_cleanup($1,9,true,$2)', [command, {}], 'AW001');
    await c.query('select complete_cleanup($1,1,true,$2)', [command, { holds: [] }]);
    expect((await c.query('select cleanup_status from system_state')).rows[0]?.cleanup_status).toBe(
      'none',
    );
    expect(
      (await c.query('select finished_at from reset_log')).rows[0]?.finished_at,
    ).not.toBeNull();
  }));

test('P2-6: every FK has a supporting leading index and tenant constraints remain present', async () => {
  const missing = await pool.query(
    "select c.conname from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where c.contype='f' and n.nspname='public' and not exists(select from pg_index i where i.indrelid=c.conrelid and i.indisvalid and i.indpred is null and (i.indkey::smallint[])[0:cardinality(c.conkey)-1]=c.conkey)",
  );
  expect(missing.rows).toEqual([]);
  expect(
    Number(
      (
        await pool.query(
          "select count(*) n from pg_constraint where conname like 'scope_%' and contype='f'",
        )
      ).rows[0]?.n,
    ),
  ).toBeGreaterThan(60);
});

test('P2-7/8/9: known fixed values, tree structure, unique current rows, terminal times and counters', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    await rejects(c, "update tasks set verif_state='banana' where id=$1", [f.task]);
    await rejects(c, 'update tasks set wbs_node_id=$2 where id=$1', [f.task, f.phase]);
    await rejects(
      c,
      "insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP2','work_package',$2,'nested',0)",
      [f.p, f.wp],
    );
    await rejects(c, 'update tasks set related_domains=array[null]::domain[] where id=$1', [
      f.task,
    ]);
    await c.query("insert into counters(project_id,kind,value) values($1,'task',5)", [f.p]);
    await rejects(c, 'update counters set value=1');
    for (const table of ['secrets', 'system_state'])
      expect(
        (
          await c.query('select column_name from information_schema.columns where table_name=$1', [
            table,
          ])
        ).rows.map((r) => r.column_name),
      ).toEqual(expect.arrayContaining(['created_at', 'updated_at']));
  }));

test.each([
  ['tasks', 'verif_state', "'banana'"],
  ['runner_readiness', 'status', "'banana'"],
  ['notify_rules', 'key', "'banana'"],
  ['task_estimates', 'confidence', "'banana'"],
] as const)('P2-7: fixed %s.%s has an actual value constraint', (table, column, bad) =>
  transaction(async (c) => {
    const f = await fixture(c);
    if (table === 'runner_readiness')
      await c.query(
        "insert into runner_readiness(key,status,detail,fix,at) values('git','ok','','',now())",
      );
    if (table === 'task_estimates') {
      await rejects(
        c,
        "insert into task_estimates(project_id,task,est,lo,hi,confidence,basis,agreed_by) values($1,$2,1,1,1,'banana','','')",
        [f.p, f.task],
      );
      return;
    }
    await rejects(c, `update ${table} set ${column}=${bad}`);
  }),
);

test('P2-8: current grades, readiness keys and output names are unique', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    const grade =
      "insert into task_grades(project_id,task,role,model_id,effort,reason,locked,effective_from) values($1,$2,'dev','model','high','source',false,now())";
    await c.query(grade, [f.p, f.task]);
    await rejects(c, grade, [f.p, f.task], '23505');
    const readiness =
      "insert into runner_readiness(key,status,detail,fix,at) values('git','ok','','',now())";
    await c.query(readiness);
    await rejects(c, readiness, [], '23505');
    const output =
      "insert into task_outputs(project_id,task,name,kind,required,verify,delivered) values($1,$2,'file','코드',true,'cmd',false)";
    await c.query(output, [f.p, f.task]);
    await rejects(c, output, [f.p, f.task], '23505');
  }));

test('P2-8: terminal attempts require their end time and counter allocation cannot rewind', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    await rejects(
      c,
      "insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,kind,agent,status,started_at,model_id,effort) values($1,$2,'ATT-1',1,$3,'base','head',1,'dev','Claude','completed',now(),'model','high')",
      [f.p, f.task, f.job],
    );
    await c.query("insert into counters(project_id,kind,value) values($1,'task',8)", [f.p]);
    await rejects(c, 'update counters set value=1');
  }));

test('P2-9: secrets and singleton state carry monotonically updated edit tokens', () =>
  transaction(async (c) => {
    await c.query(
      "insert into secrets(key,ciphertext,nonce,key_version,last4) values('edit-token','encrypted','nonce',1,'1234')",
    );
    const before = (await c.query("select updated_at::text at from secrets where key='edit-token'"))
      .rows[0]?.at;
    const after = (
      await c.query(
        "update secrets set ciphertext='updated' where key='edit-token' returning updated_at::text at",
      )
    ).rows[0]?.at;
    expect(after > before).toBe(true);
    expect((await c.query('select updated_at from system_state')).rows[0]?.updated_at).toBeTruthy();
  }));

test('MUTATION: actual connected demo guard is asserted before any write without connecting to a development DB', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ name: 'awbs_dev' }] });
  await expect(seedDemo({ query } as unknown as pg.Pool, url)).rejects.toThrow(
    '연결된 DB가 awbs_test_',
  );
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[0]).toContain('current_database');
});

test.each([true, false])(
  'MUTATION/P2-11: reset keep=%s deletes populated rows in every project relation',
  (keep) =>
    transaction(async (c) => {
      const f = await fixture(c);
      const tables = await fillProjectTables(c, f);
      for (const table of tables)
        expect(
          Number(
            (
              await c.query(
                `select count(*) n from ${c.escapeIdentifier(table)} where project_id=$1`,
                [f.p],
              )
            ).rows[0]?.n,
          ),
          table,
        ).toBeGreaterThan(0);
      await c.query("select reset_project(1,'review',$1,'lead')", [keep]);
      for (const table of tables)
        expect(
          Number((await c.query(`select count(*) n from ${c.escapeIdentifier(table)}`)).rows[0]?.n),
          table,
        ).toBe(0);
      await c.query(
        "insert into idempotency_keys(principal,key,request_hash,response,epoch) values('lead','reset','request','{\"epoch\":2}',2)",
      );
      expect(
        (
          await c.query(
            "select response from idempotency_keys where project_id is null and epoch=2 and key='reset'",
          )
        ).rows[0]?.response,
      ).toEqual({ epoch: 2 });
    }),
);

test('P2-11: committed epoch change rejects a separate delayed writer', async () => {
  const raceUrl = new URL(url);
  raceUrl.pathname += '_race';
  await recreateTestDatabase(raceUrl.href);
  const race = createPool(raceUrl.href, { max: 2, onError: () => undefined });
  await migrate(drizzle(race), {
    migrationsFolder:
      process.env.AWBS_MUTATION_MIGRATIONS ??
      fileURLToPath(new URL('../migrations', import.meta.url)),
  });
  await seedSystem(race);
  const writer = await race.connect();
  const resetter = await race.connect();
  try {
    await fixture(resetter);
    await writer.query('begin');
    await writer.query('select lock_epoch(1)');
    const resetting = resetter.query("select reset_project(1,'review',true,'lead')");
    await writer.query('commit');
    await resetting;
    await writer.query('begin');
    await expect(writer.query('select lock_epoch(1)')).rejects.toMatchObject({ code: 'AW001' });
  } finally {
    await writer.query('rollback');
    writer.release();
    resetter.release();
    await race.end();
  }
});

test('P3: every table and SECURITY DEFINER function has the declared policy', async () => {
  const tables = (
    await pool.query("select tablename,tableowner from pg_tables where schemaname='public'")
  ).rows;
  for (const table of tables) {
    expect(table.tableowner, table.tablename).toBe('awbs_data_owner');
    const triggers = (
      await pool.query(
        'select tgname from pg_trigger where tgrelid=$1::regclass and not tgisinternal',
        [table.tablename],
      )
    ).rows.map((r) => r.tgname);
    expect(triggers, table.tablename).toContain('guard_truncate');
    const privileges = (await pool.query(
      "select has_table_privilege('awbs_app',$1,'SELECT') readable,has_table_privilege('awbs_app',$1,'INSERT') insertable,has_table_privilege('awbs_app',$1,'DELETE') deletable,has_table_privilege('awbs_app',$1,'TRUNCATE') truncatable,has_any_column_privilege('awbs_app',$1,'UPDATE') updatable",
      [table.tablename],
    )).rows[0];
    expect(privileges?.readable, table.tablename).toBe(true);
    expect(privileges?.insertable, table.tablename).toBe(!['system_state', 'reset_log', 'runner_commands'].includes(table.tablename));
    expect(privileges?.truncatable, table.tablename).toBe(false);
    expect(privileges?.updatable, table.tablename).toBe(!triggers.includes('append_only') && !['system_state', 'reset_log', 'runner_commands'].includes(table.tablename));
    if (!privileges?.deletable) expect(triggers.some((t) => ['guard_delete', 'authority_no_delete'].includes(t)), table.tablename).toBe(true);
    const cols = (
      await pool.query(
        "select column_name from information_schema.columns where table_schema='public' and table_name=$1",
        [table.tablename],
      )
    ).rows.map((r) => r.column_name);
    if (cols.includes('updated_at')) expect(triggers, table.tablename).toContain('touch_updated');
  }
  const functions = (
    await pool.query(
      "select p.oid::regprocedure::text as name,p.proconfig,r.rolsuper,coalesce((select bool_or(x.grantee=0 and x.privilege_type='EXECUTE') from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),false) as public_exec from pg_proc p join pg_roles r on r.oid=p.proowner where pronamespace='public'::regnamespace and p.prosecdef",
    )
  ).rows;
  expect(functions.length).toBeGreaterThanOrEqual(5);
  for (const f of functions) {
    expect(f.proconfig, f.name).toContain('search_path=pg_catalog, pg_temp');
    expect(f.rolsuper, f.name).toBe(false);
    expect(f.public_exec, f.name).toBe(false);
  }
  const roles = (await pool.query("select rolname from pg_roles where rolname in ('awbs_app','awbs_data_owner') and (rolcanlogin or rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls or exists(select from pg_auth_members where member=pg_roles.oid))")).rows;
  expect(roles).toEqual([]);
});

test('MUTATION: orphan observation FK and open merge queue unique reject actual conflicting rows', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    await rejects(
      c,
      "insert into attempt_observations(project_id,attempt,cli,version,grade,reserved,state,process_state,at) values($1,gen_random_uuid(),'Codex','test','unver',1,'ok','{}',now())",
      [f.p],
      '23503',
    );
    const attempt = await id(
      c,
      "insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,kind,agent,status,started_at,ended_at,model_id,effort) values($1,$2,'ATT-1',1,$3,'base','head',1,'qa','Codex','completed',now(),now(),'model','high')",
      [f.p, f.task, f.job],
    );
    const v = await id(
      c,
      "insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual) values($1,$2,'PASS','head',1,'cmd','pass','pass')",
      [f.p, attempt],
    );
    const q =
      "insert into merge_queue(project_id,task,pr,position,status,qa_head_sha,verification) values($1,$2,42,1,'queued','head',$3)";
    await c.query(q, [f.p, f.task, v]);
    await rejects(c, q, [f.p, f.task, v], '23505');
  }));

test('D-33/D-34: judgements retain the approved names and reject malformed or duplicate records', () =>
  transaction(async (c) => {
    const f = await fixture(c);
    const item = {
      rule: 'revert',
      result: 'met',
      agreedBy: ['Claude', 'Codex'],
      basis: '독립 되돌림',
      subjectHash: 'a'.repeat(64),
      judgedAt: '2026-11-25T00:00:00Z',
      sourceRef: 'PLN-1',
    };
    const good = { schemaVersion: 1, items: [item] };
    await c.query(
      'insert into task_splits(project_id,task,basis,judged_rules,exceptions) values($1,$2,$3,$4,$5)',
      [f.p, f.task, 'source', good, '[]'],
    );
    for (const bad of [
      { ...good, schemaVersion: 2 },
      { schemaVersion: 1, items: [item, item] },
      { schemaVersion: 1, items: [{ ...item, agreedBy: ['Claude'] }] },
      { schemaVersion: 1, items: [{ ...item, basis: ' ' }] },
      { schemaVersion: 1, items: [{ ...item, basis: '\u00a0\u3000' }] },
      { schemaVersion: 1, items: [{ ...item, result: null }] },
      { schemaVersion: 1, items: [{ ...item, judgedAt: '2026-02-30T00:00:00Z' }] },
      { schemaVersion: 1, items: [{ ...item, subjectHash: 'bad' }] },
    ])
      await rejects(c, 'update task_splits set judged_rules=$2 where task=$1', [f.task, bad]);
    await c.query(
      "insert into change_proposals(project_id,cp_key,source,status,ops,split_judgements,hold_reasons) values($1,'CP-1','split','held','[]',$2,$3)",
      [
        f.p,
        { schemaVersion: 1, items: [{ ...item, rule: 'ac_meaning' }] },
        { holdReasons: [], issues: [] },
      ],
    );
    await rejects(c, 'update change_proposals set split_judgements=$1', [good]);
    await rejects(c, "update change_proposals set hold_reasons='[]'");
    await rejects(c, "update change_proposals set task_judgements='{}'");
    await rejects(c, 'update change_proposals set task_judgements=null', [], '23502');
    expect((await c.query('select task_judgements from change_proposals')).rows[0]?.task_judgements).toEqual([]);
    expect((await c.query("select column_name from information_schema.columns where table_schema='public' and table_name='tasks' and column_name='judged_rules'")).rows).toEqual([]);
  }));
