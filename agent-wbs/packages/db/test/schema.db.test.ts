import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { is, Table } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { prototypeFixture } from './prototype-fixture.ts';
import {
  createPool,
  recreateTestDatabase,
  runMigrations,
  seedDemo,
  seedSystem,
  schema,
} from '../src/index.ts';

const url = inject('testDatabaseUrl');
const pool = createPool(url, { max: 4, onError: () => undefined });
beforeAll(async () => {
  await runMigrations(pool);
  await seedSystem(pool);
});
afterAll(() => pool.end());
function required<T>(value: T | undefined | null): T {
  assert(value != null);
  return value;
}
const source = (path: string) => readFile(new URL(`../../../../${path}`, import.meta.url), 'utf8');

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
async function rejected(c: pg.PoolClient, query: string, code: string, values: unknown[] = []) {
  await c.query('savepoint expected_failure');
  await expect(c.query(query, values)).rejects.toMatchObject({ code });
  await c.query('rollback to savepoint expected_failure');
}
async function project(c: pg.PoolClient, baseCommit: string | null = 'base-sha') {
  return required(
    (
      await c.query<{ id: string }>(
        "insert into projects(name,repo_url,repo_owner,repo_name,base_commit,lead_instruction,phase) values('schema-test','','','',$1,'','active') returning id",
        [baseCommit],
      )
    ).rows[0]?.id,
  );
}
async function task(c: pg.PoolClient, p: string, key = 'TASK-0001') {
  const ph = required(
    (
      await c.query<{ id: string }>(
        "insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,$2,'phase','phase',0) returning id",
        [p, `PH-${key}`],
      )
    ).rows[0]?.id,
  );
  const wp = required(
    (
      await c.query<{ id: string }>(
        "insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,$2,'work_package',$3,'wp',0) returning id",
        [p, `WP-${key}`, ph],
      )
    ).rows[0]?.id,
  );
  return required(
    (
      await c.query<{ id: string }>(
        "insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state) values($1,$2,$3,0,'task','Implementation','BE','{API}',1,'Claude','Codex','ready','none') returning id",
        [p, key, wp],
      )
    ).rows[0]?.id,
  );
}
async function job(c: pg.PoolClient, p: string) {
  return required(
    (
      await c.query<{ id: string }>(
        "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'attempt','{}','queued',1,gen_random_uuid()::text) returning id",
        [p],
      )
    ).rows[0]?.id,
  );
}
async function hold(c: pg.PoolClient, p: string, t: string, j: string, group = 'shared') {
  return required(
    (
      await c.query<{ id: string }>(
        "insert into execution_holds(project_id,job,task,epoch,agent,slots,heavy,host_id,boot_id,fence,slot_state,lock_state,conflict_group) values($1,$2,$3,1,'Claude',1,false,'host','boot',1,'reserved','held',$4) returning id",
        [p, j, t, group],
      )
    ).rows[0]?.id,
  );
}

test('schema: all planned tables and Drizzle columns match the migrated database', async () => {
  const tables = Object.values(schema)
    .filter((value) => is(value, Table))
    .map((value) => getTableConfig(value));
  const model = await source('docs/plan/data-model.md');
  const section = model.slice(model.indexOf('## 2.'), model.indexOf('## 3.'))
    .replace(/####[^\n]*\n[\s\S]*?(?=\n### |$)/g, '');
  const planned = section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) =>
      [...required(line.split('|')[1]).matchAll(/`([^`]+)`/g)].map((m) => required(m[1])),
    )
    .filter((name) => name !== 'slot_state' && name !== 'lock_state');
  for (const name of planned) expect(tables.map((t) => t.name)).toContain(name);
  for (const table of tables) {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      "select column_name,is_nullable from information_schema.columns where table_schema='public' and table_name=$1 order by column_name",
      [table.name],
    );
    expect(rows.map((r) => r.column_name)).toEqual(table.columns.map((c) => c.name).sort());
    for (const col of table.columns)
      expect(rows.find((r) => r.column_name === col.name)?.is_nullable).toBe(
        col.notNull ? 'NO' : 'YES',
      );
    const types = (
      await pool.query<{ name: string; type: string }>(
        'select attname as name,format_type(atttypid,atttypmod) as type from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped',
        [table.name],
      )
    ).rows;
    for (const col of table.columns)
      expect(types.find((r) => r.name === col.name)?.type).toBe(
        col.getSQLType().replace('bigserial', 'bigint'),
      );
  }
  expect(tables).toHaveLength(100);
});

test('schema: previous migration upgrades with data preserved and repeated migrate is inert', async () => {
  const upgradeUrl = new URL(url);
  upgradeUrl.pathname += '_upgrade';
  await recreateTestDatabase(upgradeUrl.href);
  const previous = createPool(upgradeUrl.href, { max: 2, onError: () => undefined });
  const temp = await mkdtemp(join(tmpdir(), 'awbs-m101-upgrade-'));
  try {
    await cp(new URL('../migrations/', import.meta.url), temp, { recursive: true });
    const journalPath = join(temp, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((e) => e.idx <= 3);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(drizzle(previous), { migrationsFolder: temp });
    const c = await previous.connect();
    try {
      const p = await project(c);
      const t = await task(c, p);
      await c.query(
        "insert into task_specs(project_id,task,overview,spec,ac,revision) values($1,$2,'{}','{}','[]',1)",
        [p, t],
      );
      const input = required((await c.query<{ id: string }>(
        "insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction,result) values($1,1,'legacy-sha','[]','[]','[]','legacy','{\"source\":\"legacy\"}') returning id",
        [p],
      )).rows[0]?.id);
      const legacyJob = required((await c.query<{ id: string }>(
        "insert into runner_jobs(project_id,kind,payload,state,epoch) values($1,'attempt','{}','queued',1) returning id", [p],
      )).rows[0]?.id);
      await runMigrations(previous);
      await runMigrations(previous);
      expect((await c.query('select input_version,result from input_version_results')).rows)
        .toEqual([{ input_version: input, result: { source: 'legacy' } }]);
      expect((await c.query('select dedup_key from runner_jobs where id=$1', [legacyJob])).rows[0]?.dedup_key)
        .toBe(`legacy:${legacyJob}`);
      expect((await c.query('select id,epoch from system_state')).rows).toEqual([{ id: 1, epoch: 1 }]);
      expect((await c.query('select task,revision from task_specs')).rows).toEqual([
        { task: t, revision: 1 },
      ]);
      expect(
        (
          await c.query(
            "select count(*)::int as n from information_schema.columns where table_name='task_specs' and column_name='id'",
          )
        ).rows[0]?.n,
      ).toBe(0);
    } finally {
      c.release();
    }
  } finally {
    await previous.end();
    await rm(temp, { recursive: true, force: true });
  }
});

test('schema: system seed is repeatable, owner Q-03/Q-04 values match, no Mock or unapproved defaults', async () => {
  const before = (await pool.query('select * from app_settings')).rows;
  await seedSystem(pool);
  expect((await pool.query('select * from app_settings')).rows).toEqual(before);
  const prototype = await source('prototype/uiux/Main.dc.html');
  const literal = required(required(/const STAGE_PCT = (\{[^;]+\});/.exec(prototype))[1]);
  const pct = JSON.parse(literal.replace(/([a-z]+):/g, '"$1":')) as unknown;
  expect(before[0]?.stage_pct).toEqual(pct);
  const notifyLiteral = required(required(/const TG_RULES0 = (\{[^;]+\});/.exec(prototype))[1]);
  const notify = JSON.parse(notifyLiteral.replace(/([a-zA-Z]+):/g, '"$1":')) as unknown;
  expect(
    Object.fromEntries(
      (await pool.query('select key,enabled from notify_rules')).rows.map((r) => [
        r.key,
        r.enabled,
      ]),
    ),
  ).toEqual(notify);
  expect(
    (await pool.query('select enabled,secret_key,chat_id from notify_settings')).rows[0],
  ).toEqual({ enabled: false, secret_key: null, chat_id: null });
  expect((await pool.query('select night_at,retry,deploy_url from ci_settings')).rows[0]).toEqual({
    night_at: '02:00',
    retry: 1,
    deploy_url: null,
  });
  expect(before[0]?.split).toEqual({
    maxH: 4,
    minH: 0.5,
    maxFiles: 8,
    testIn: true,
    dir: 'layer',
    on: {
      one: true,
      domain: true,
      size: true,
      verify: true,
      revert: true,
      cg: true,
      contract: true,
      irrev: true,
      refactor: true,
      unknown: true,
    },
  });
  expect(
    (
      await pool.query(
        'select auto_retry_limit,auto_rework_limit,on_usage,on_rework,esc_notify,low_pct,live_inject from exec_policy',
      )
    ).rows[0],
  ).toEqual({
    auto_retry_limit: 2,
    auto_rework_limit: 3,
    on_usage: 'wait',
    on_rework: 'up1',
    esc_notify: 2,
    low_pct: null,
    live_inject: false,
  });
  expect(
    (
      await pool.query(
        'select assume_rate,threshold_days,window_days,min_hours from schedule_policy',
      )
    ).rows[0],
  ).toEqual({ assume_rate: null, threshold_days: null, window_days: 7, min_hours: 72 });
  for (const t of [
    'subagent_defs',
    'agent_models',
    'cli_observation_grades',
    'runner_hosts',
    'concurrency_settings',
    'projects',
  ])
    expect((await pool.query(`select count(*)::int as n from ${t}`)).rows[0]?.n).toBe(0);
});

test('schema: Q-06 CLI × model mapping, unknown availability and ultra remain unmapped', async () => {
  const { rows } = await pool.query<{
    agent: string;
    model_id: string;
    value: string;
    common_level: number;
    supported: boolean | null;
  }>('select * from agent_efforts');
  expect(rows).toHaveLength(74);
  const owner = await source('docs/plan/open-questions.md');
  const codexModels = owner
    .split('\n')
    .filter((line) => line.startsWith('| Codex |') && !line.includes('숨김'))
    .flatMap((line) =>
      required(line.split('|')[2])
        .trim()
        .split(' · ')
        .map((model) => model.trim().replace(/^gpt-/, ''))
        .map((model) => `gpt-${model}`),
    );
  expect(
    [...new Set(rows.filter((r) => r.agent === 'Codex').map((r) => r.model_id))].sort(),
  ).toEqual([...new Set(codexModels)].sort());
  for (const r of rows) {
    expect(r.common_level).toBe(['low', 'medium', 'high', 'xhigh', 'max'].indexOf(r.value) + 1);
    if (r.agent === 'Claude' || r.model_id === 'gpt-5.5') expect(r.supported).toBeNull();
  }
  expect(
    rows.some(
      (r) =>
        r.value === 'ultra' ||
        r.value === '미확인' ||
        (r.model_id === 'gpt-5.5' && r.value === 'max'),
    ),
  ).toBe(false);
});

test('schema: singleton, title, priority, enums, domains, FK and dependency constraints reject invalid writes', () =>
  transaction(async (c) => {
    const p = await project(c);
    const t = await task(c, p);
    await rejected(c, 'insert into system_state(id,epoch) values(2,1)', '23514');
    await rejected(
      c,
      "insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('other','','','','','boot')",
      '23505',
    );
    await rejected(c, 'update tasks set title=$1 where id=$2', '23514', ['', t]);
    await rejected(c, 'update tasks set title=$1 where id=$2', '23514', ['x'.repeat(201), t]);
    await rejected(c, 'update tasks set priority=4 where id=$1', '23514', [t]);
    await rejected(c, "update tasks set related_domains='{BE}' where id=$1", '23514', [t]);
    await rejected(c, "update tasks set status='imaginary' where id=$1", '22P02', [t]);
    await rejected(c, 'update tasks set wbs_node_id=gen_random_uuid() where id=$1', '23503', [t]);
    await rejected(
      c,
      "insert into task_dependencies(project_id,pred,succ,dep_type) values($1,$2,$2,'FS')",
      '23514',
      [p, t],
    );
    const other = await task(c, p, 'TASK-0002');
    await c.query(
      "insert into task_dependencies(project_id,pred,succ,dep_type) values($1,$2,$3,'FS')",
      [p, t, other],
    );
    await rejected(
      c,
      "insert into task_dependencies(project_id,pred,succ,dep_type) values($1,$2,$3,'SS')",
      '23505',
      [p, t, other],
    );
    await rejected(
      c,
      "insert into task_estimates(project_id,task,est,lo,hi,confidence,basis,agreed_by) values($1,$2,4,5,6,'중','','')",
      '23514',
      [p, t],
    );
  }));

test('schema: unique bootstrap, input version, notify event, report period and idempotency keys', () =>
  transaction(async (c) => {
    const p = await project(c);
    const queries: [string, unknown[]][] = [
      [
        "insert into planning_jobs(project_id,kind,run_no,status,instruction) values($1,'bootstrap',1,'queued','')",
        [p],
      ],
      [
        "insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,1,'sha','[]','[]','[]','')",
        [p],
      ],
      [
        "insert into notify_events(project_id,dedup_key,kind,ref) values($1,'same','event','{}')",
        [p],
      ],
      [
        "insert into reports(project_id,report_key,kind,\"from\",\"to\",snapshot,generated_at,reason) values($1,gen_random_uuid()::text,'daily','2026-11-01','2026-11-01','{}',now(),'scheduled')",
        [p],
      ],
      [
        "insert into idempotency_keys(project_id,principal,key,request_hash,response,epoch) values($1,'runner','key','hash','{}',1)",
        [p],
      ],
    ];
    for (const [q, values] of queries) {
      await c.query(q, values);
      await rejected(c, q, '23505', values);
    }
    await c.query("update notify_events set resolved_at=now() where dedup_key='same'");
    await c.query(required(queries[2])[0], [p]);
    await rejected(
      c,
      "insert into mail_recipients(email,name,active,daily,weekly,pdf,view) values('a@example.com','',true,false,false,false,'int')",
      '23514',
    );
    await c.query(
      "insert into mail_recipients(email,name,active,daily,weekly,pdf,view) values('a@example.com','',true,true,false,false,'int')",
    );
    await rejected(
      c,
      "insert into mail_recipients(email,name,active,daily,weekly,pdf,view) values('A@example.com','',true,true,false,false,'int')",
      '23505',
    );
  }));

test('schema: open attempt unique and terminal attempt immutable', () =>
  transaction(async (c) => {
    const p = await project(c);
    const t = await task(c, p);
    const j = await job(c, p);
    const j2 = await job(c, p);
    const q =
      "insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,kind,agent,status,started_at,model_id,effort) values($1,$2,$3,$4,$5,'base','head',1,'dev','Claude','running',now(),'model','high')";
    await c.query(q, [p, t, 'ATT-0001-1', 1, j]);
    await rejected(c, q, '23505', [p, t, 'ATT-0001-2', 2, j2]);
    await c.query("update task_attempts set status='completed',ended_at=now()");
    await rejected(c, "update task_attempts set summary='rewrite'", '23514');
    await c.query(q, [p, t, 'ATT-0001-2', 2, j2]);
    await rejected(
      c,
      "insert into attempt_files(project_id,attempt,path) select $1,id,'../escape' from task_attempts limit 1",
      '23514',
      [p],
    );
  }));

test('schema: holds keep task/conflict locks with unconfirmed slots, require release proof and never reopen', () =>
  transaction(async (c) => {
    const p = await project(c);
    const t = await task(c, p);
    const t2 = await task(c, p, 'TASK-0002');
    const j = await job(c, p);
    const j2 = await job(c, p);
    const h = await hold(c, p, t, j);
    await c.query("update execution_holds set slot_state='unconfirmed' where id=$1", [h]);
    await rejected(
      c,
      "insert into execution_holds(project_id,job,task,epoch,agent,slots,heavy,host_id,boot_id,fence,slot_state,lock_state) values($1,$2,$3,1,'Codex',1,false,'host','boot',1,'reserved','held')",
      '23505',
      [p, j2, t],
    );
    await rejected(
      c,
      "insert into execution_holds(project_id,job,task,conflict_group,epoch,agent,slots,heavy,host_id,boot_id,fence,slot_state,lock_state) values($1,$2,$3,'shared',1,'Codex',1,false,'host','boot',1,'reserved','held')",
      '23505',
      [p, j2, t2],
    );
    await rejected(c, "update execution_holds set slot_state='none' where id=$1", '23514', [h]);
    await rejected(c, "update execution_holds set lock_state='released' where id=$1", '23514', [h]);
    await c.query(
      "update execution_holds set slot_state='none',release_proof='group_empty' where id=$1",
      [h],
    );
    await c.query("update execution_holds set lock_state='released',closed_at=now() where id=$1", [
      h,
    ]);
    await rejected(
      c,
      "update execution_holds set closed_at=null,slot_state='reserved',lock_state='held' where id=$1",
      '23514',
      [h],
    );
    await rejected(c, 'delete from execution_holds where id=$1', '42501', [h]);
  }));

test('schema: hold handover uses the receiving job row and host change preserves unconfirmed slots', () =>
  transaction(async (c) => {
    const p = await project(c);
    const t = await task(c, p);
    const a = await job(c, p);
    const b = await job(c, p);
    const h = await hold(c, p, t, a);
    await c.query(
      "update execution_holds set slot_state='none',release_proof='no_process' where id=$1",
      [h],
    );
    await c.query(
      "update execution_holds set lock_state='handed_over',handed_to_job=$2,closed_at=now() where id=$1",
      [h, b],
    );
    await c.query(
      "insert into execution_holds(project_id,job,task,epoch,agent,slots,heavy,slot_state,lock_state,lock_from_job) values($1,$2,$3,1,'Codex',1,false,'none','held',$4)",
      [p, b, t, a],
    );
    await c.query(
      "update execution_holds set host_id='new-host',boot_id='new-boot',fence=2,slot_state='reserved' where job=$1",
      [b],
    );
    expect(
      (await c.query('select count(*)::int as n from execution_holds where job=$1', [b])).rows[0]
        ?.n,
    ).toBe(1);
    await c.query("update execution_holds set slot_state='active',pgid=123 where job=$1", [b]);
    await c.query(
      "update execution_holds set lock_state='orphaned',slot_state='unconfirmed' where job=$1",
      [b],
    );
    expect(
      (await c.query('select closed_at from execution_holds where job=$1', [b])).rows[0]?.closed_at,
    ).toBeNull();
  }));

test('schema: app role cannot UPDATE append-only tables, DELETE, TRUNCATE or spoof reset', () =>
  transaction(async (c) => {
    const p = await project(c);
    const t = await task(c, p);
    await c.query(
      "insert into task_history(project_id,task,actor,kind,text) values($1,$2,'lead','test','original')",
      [p, t],
    );
    await c.query('set local role awbs_app');
    const append = [
      'input_versions',
      'planning_job_logs',
      'task_estimates',
      'change_proposal_events',
      'runner_job_events',
      'attempt_files',
      'attempt_observations',
      'verifications',
      'verification_invalidations',
      'defects',
      'defect_events',
      'evidence',
      'runner_hosts',
      'runner_concurrency_log',
      'schedule_baselines',
      'baseline_items',
      'replans',
      'replan_moves',
      'reports',
      'mail_log',
      'notify_log',
      'tech_decision_events',
      'design_versions',
      'task_history',
      'change_events',
    ];
    for (const table of append)
      await rejected(
        c,
        `update ${table} set ${table === 'change_events' ? 'topic=topic' : 'id=id'}`,
        '42501',
      );
    await rejected(c, 'delete from task_history', '42501');
    await rejected(c, 'truncate task_history cascade', '42501');
    await c.query("select set_config('awbs.reset','on',true)");
    await rejected(c, 'delete from task_history', '42501');
    await rejected(c, 'update system_state set epoch=900', '42501');
    expect((await c.query('select lock_epoch(1) as epoch')).rows[0]?.epoch).toBe(1);
    await rejected(c, 'select lock_epoch(9)', 'AW001');
  }));

test('schema: even the owner cannot overwrite immutable evidence/history, and updated_at increases monotonically', () =>
  transaction(async (c) => {
    const p = await project(c);
    const t = await task(c, p);
    await c.query(
      "insert into task_history(project_id,actor,kind,text) values($1,'lead','test','original')",
      [p],
    );
    await rejected(c, "update task_history set text='rewrite'", '42501');
    const before = (await c.query('select updated_at::text as at from tasks where id=$1', [t]))
      .rows[0]?.at as string;
    const after = (
      await c.query(
        "update tasks set title='changed',updated_at='2000-01-01' where id=$1 returning updated_at::text as at",
        [t],
      )
    ).rows[0]?.at as string;
    expect(after > before).toBe(true);
  }));

test('schema: subagent versions and closed Runner sessions cannot be overwritten', () =>
  transaction(async (c) => {
    await c.query(
      "insert into subagent_defs(def_key,version,agent,role,tools,sandbox,text,hash) values('test-definition',1,'Codex','qa','{}','read-only','original','hash')",
    );
    await rejected(c, "update subagent_defs set text='changed'", '23514');
    await c.query('update subagent_defs set allowed=true');
    await c.query(
      "insert into runner_sessions(runner_id,started_at,last_heartbeat_at) values('runner',now(),now())",
    );
    await rejected(c, "update runner_sessions set runner_id='different'", '23514');
    await c.query("update runner_sessions set ended_at=now(),end_reason='manual'");
    await rejected(c, 'update runner_sessions set ended_at=null,end_reason=null', '23514');
  }));

test.each([true, false])(
  'schema: reset keepSettings=%s deletes project data, queues cleanup and preserves GitHub/auth',
  (keep) =>
    transaction(async (c) => {
      const p = await project(c);
      const t = await task(c, p);
      const j = await job(c, p);
      await hold(c, p, t, j);
      await c.query(
        "insert into task_history(project_id,actor,kind,text) values($1,'lead','test','history')",
        [p],
      );
      await c.query(
        "insert into secrets(key,ciphertext,nonce,key_version,last4) values('github','encrypted','nonce',1,'1234'),('smtp','encrypted','nonce',1,'5678')",
      );
      await c.query(
        "insert into github_settings(mode,status,scopes,secret_key) values('token','ok','{}','github')",
      );
      await c.query(
        "insert into lead_sessions(token_hash,expires_at,csrf) values('hash',now()+interval '1 hour','csrf')",
      );
      await c.query("insert into mail_settings(secret_key) values('smtp')");
      await c.query('set local role awbs_app');
      await rejected(c, "select reset_project(9,'schema-test',$1,'lead')", 'AW001', [keep]);
      await rejected(c, "select reset_project(1,'wrong',$1,'lead')", '22023', [keep]);
      expect(
        (await c.query("select reset_project(1,'schema-test',$1,'lead') as epoch", [keep])).rows[0]
          ?.epoch,
      ).toBe(2);
      await rejected(c, 'select lock_epoch(1)', 'AW001');
      for (const table of [
        'tasks',
        'task_history',
        'execution_holds',
        'runner_jobs',
        'projects',
        'reports',
        'mail_log',
        'notify_log',
      ])
        expect((await c.query(`select count(*)::int as n from ${table}`)).rows[0]?.n).toBe(0);
      expect((await c.query('select * from system_state')).rows[0]).toMatchObject({
        epoch: 2,
        cleanup_status: 'pending',
      });
      expect((await c.query('select * from reset_log')).rows[0]).toMatchObject({
        epoch: 2,
        deleted_task_count: 1,
        keep_settings: keep,
      });
      expect((await c.query('select path from file_delete_queue')).rows[0]?.path).toBe('1/');
      const cmd = required((await c.query('select * from runner_commands')).rows[0]);
      expect(cmd.epoch).toBe(1);
      expect(cmd.payload.holds).toHaveLength(1);
      expect(cmd.payload.baseCommit).toBe('base-sha');
      expect((await c.query('select count(*)::int as n from app_settings')).rows[0]?.n).toBe(1);
      expect((await c.query('select count(*)::int as n from mail_settings')).rows[0]?.n).toBe(
        keep ? 1 : 0,
      );
      expect((await c.query('select count(*)::int as n from github_settings')).rows[0]?.n).toBe(1);
      expect((await c.query('select count(*)::int as n from lead_sessions')).rows[0]?.n).toBe(1);
      expect(
        (await c.query('select key from secrets order by key')).rows.map((r) => r.key),
      ).toEqual(keep ? ['github', 'smtp'] : ['github']);
    }),
);

test('schema: reset rollback is atomic and omits repository cleanup without a base commit', () =>
  transaction(async (c) => {
    await project(c, null);
    await c.query(
      "create function pg_temp.fail_reset() returns trigger language plpgsql as 'begin raise exception ''injected failure''; end'",
    );
    await c.query(
      'create trigger injected_failure before insert on reset_log for each row execute function pg_temp.fail_reset()',
    );
    await rejected(c, "select reset_project(1,'schema-test',false,'lead')", 'P0001');
    expect((await c.query('select epoch from system_state')).rows[0]?.epoch).toBe(1);
    expect((await c.query('select count(*)::int as n from projects')).rows[0]?.n).toBe(1);
    expect((await c.query('select count(*)::int as n from runner_commands')).rows[0]?.n).toBe(0);
    await c.query('drop trigger injected_failure on reset_log');
    await c.query("select reset_project(1,'schema-test',true,'lead')");
    expect(
      (await c.query('select payload from runner_commands')).rows[0]?.payload,
    ).not.toHaveProperty('repoUrl');
  }));

test('schema: reset waits for epoch SHARE lock and refuses stale epoch after reset', async () => {
  const writer = await pool.connect();
  const resetter = await pool.connect();
  try {
    await writer.query('begin');
    await writer.query('select lock_epoch(1)');
    await resetter.query('begin');
    await resetter.query("set local lock_timeout='100ms'");
    await expect(
      resetter.query("select reset_project(1,'schema-test',true,'lead')"),
    ).rejects.toMatchObject({ code: '55P03' });
  } finally {
    await resetter.query('rollback');
    await writer.query('rollback');
    writer.release();
    resetter.release();
  }
});

test('schema: demo is refused for production before connecting', async () => {
  await expect(seedDemo(pool, 'postgres://owner:secret@127.0.0.1:1/awbs_dev')).rejects.toThrow(
    'awbs_test_',
  );
  expect((await pool.query('select count(*)::int as n from projects')).rows[0]?.n).toBe(0);
});

test('schema: demo loads exactly P twelve tasks, dependencies, checklists and ten SUB_MOCK definitions', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('../seed/demo.json', import.meta.url), 'utf8'),
  ) as {
    mock: {
      tasks: Record<string, {
        title: string; status: string; spec?: { ac?: unknown[] };
        approved: boolean; fixStart: string; actStart: string; actEnd: string; outputs: unknown[]; design: unknown[];
      }>;
      phases: { id: string; title: string; wps: { id: string; title: string }[] }[];
      deps: unknown[];
      attempts: unknown[];
      verifs: { defects: unknown[] }[];
      msgs: unknown[];
      plannings: unknown[];
      proposals: unknown[];
      hist: unknown[];
    };
    sched: Record<string, { est: number; lo: number; hi: number; tok: number; conf: string; basis: string }>;
    sub: { defs: unknown[] };
  };
  const prototype = await source('prototype/uiux/Main.dc.html');
  expect(fixture).toEqual(prototypeFixture(prototype));
  await seedDemo(pool, url);
  {
    const { rows } = await pool.query('select task_key,title,status from tasks order by task_key');
    expect(rows).toEqual(
      Object.entries(fixture.mock.tasks)
        .map(([key, t]) => ({ task_key: key, title: t.title, status: t.status }))
        .sort((a, b) => a.task_key.localeCompare(b.task_key)),
    );
    expect((await pool.query('select count(*)::int as n from subagent_defs')).rows[0]?.n).toBe(
      fixture.sub.defs.length,
    );
    expect((await pool.query('select count(*)::int as n from task_dependencies')).rows[0]?.n).toBe(
      fixture.mock.deps.length,
    );
    expect((await pool.query('select node_key,title from wbs_nodes order by node_key')).rows)
      .toEqual(fixture.mock.phases.flatMap((p) => [p, ...p.wps])
        .map((p) => ({ node_key: p.id, title: p.title }))
        .sort((a, b) => a.node_key.localeCompare(b.node_key)));
    expect((await pool.query("select task_key,planning_approved_at is not null approved,fix_start::text fixed,to_char(act_start at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI') started,to_char(act_end at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI') ended from tasks order by task_key")).rows)
      .toEqual(Object.entries(fixture.mock.tasks).map(([task_key, t]) => ({ task_key,
        approved: t.approved, fixed: t.fixStart || null, started: t.actStart || null, ended: t.actEnd || null,
      })).sort((a, b) => a.task_key.localeCompare(b.task_key)));
    expect((await pool.query('select task_key,est::float8,lo::float8,hi::float8,tokens_k::float8 tok,confidence conf,basis from task_estimates join tasks on tasks.id=task_estimates.task order by task_key')).rows)
      .toEqual(Object.entries(fixture.sched).map(([task_key, e]) => ({ task_key,
        est: e.est, lo: e.lo, hi: e.hi, tok: e.tok, conf: e.conf, basis: e.basis,
      }))
        .sort((a, b) => a.task_key.localeCompare(b.task_key)));
    for (const [table, count] of Object.entries({
      task_attempts: fixture.mock.attempts.length, verifications: fixture.mock.verifs.length,
      messages: fixture.mock.msgs.length, plannings: fixture.mock.plannings.length,
      change_proposals: fixture.mock.proposals.length, task_history: fixture.mock.hist.length,
      defects: fixture.mock.verifs.reduce((n, v) => n + v.defects.length, 0),
      task_outputs: Object.values(fixture.mock.tasks).reduce((n, t) => n + t.outputs.length, 0),
      task_designs: Object.values(fixture.mock.tasks).reduce((n, t) => n + t.design.length, 0),
    })) expect((await pool.query(`select count(*)::int n from ${table}`)).rows[0]?.n, table).toBe(count);
    const ac = (
      await pool.query(
        "select ac from task_specs join tasks on tasks.id=task_specs.task where task_key='TASK-0001'",
      )
    ).rows[0]?.ac as unknown;
    expect(ac).toEqual(fixture.mock.tasks['TASK-0001']?.spec?.ac);
    await expect(seedDemo(pool, url)).rejects.toThrow('empty project');
    await pool.query("select reset_project(1,$1,false,'test')", [
      (await pool.query('select name from projects')).rows[0]?.name,
    ]);
    expect((await pool.query('select count(*)::int as n from subagent_defs')).rows[0]?.n).toBe(0);
  }
});
