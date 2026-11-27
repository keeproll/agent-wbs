// 0036 상태 기록(state_log, M6-01 기간 말 재구성 — owner 2026-11-27 아이템 13).
// - 보고서가 읽는 바뀌는 표의 행이 바뀔 때마다 행 전체를 추가 전용으로 남긴다.
// - 앱 권한은 고치기·지우기·비우기를 못 한다. 초기화(reset_project)가 끝나면 기록이 모두 지워진다.
// - 0036 전부터 있던 행은 「seed」로 한 번 남는다(그보다 이른 시점은 되살릴 수 없다).
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, seedSystem, type Pool } from '../src/index.ts';

const url = new URL(inject('testDatabaseUrl'));
url.pathname += '_state_log';
let owner: Pool;
let app: Pool;

async function project(pool: Pool) {
  const p = (await pool.query<{ id: string }>("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('기록 시험','https://github.com/o/r','o','r','','active') returning id")).rows[0]?.id ?? '';
  const ph = (await pool.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH','phase','단계',1) returning id", [p])).rows[0]?.id;
  const wp = (await pool.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP','work_package',$2,'묶음',1) returning id", [p, ph])).rows[0]?.id;
  const t = (await pool.query<{ id: string }>(`insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state)
    values($1,'TASK-0001',$2,1,'기록','Test','BE','{}',1,'Codex','Claude','ready','none') returning id`, [p, wp])).rows[0]?.id ?? '';
  return { p, t };
}

beforeAll(async () => {
  await recreateTestDatabase(url.href);
  owner = createPool(url.href, { max: 3, onError: () => undefined });
  await runMigrations(owner);
  await seedSystem(owner);
  const appUrl = new URL(url);
  appUrl.searchParams.set('options', '-c role=awbs_app');
  app = createPool(appUrl.href, { max: 3, onError: () => undefined });
});
afterAll(async () => { await app.end(); await owner.end(); });

test('행을 만들고·고치고·지우면 그때의 행 전체가 차례로 남는다', async () => {
  const { p, t } = await project(app);
  await app.query("update tasks set status='running' where id=$1", [t]);
  await app.query("update tasks set status='qa',deleted_at=now() where id=$1", [t]);
  const rows = (await owner.query<{ op: string; status: string | null; deleted: string | null; project_id: string }>(
    "select op,data->>'status' status,data->>'deleted_at' deleted,project_id from state_log where tbl='tasks' and row_id=$1 order by created_at,seq", [t])).rows;
  expect(rows.map((r) => [r.op, r.status, r.deleted !== null])).toEqual([['insert', 'ready', false], ['update', 'running', false], ['update', 'qa', true]]);
  expect(new Set(rows.map((r) => r.project_id))).toEqual(new Set([p]));
  // 되살리기: 원래 표 모양의 행으로 돌아간다.
  const back = (await owner.query<{ status: string; task_key: string }>(
    "select (jsonb_populate_record(null::public.tasks,data)).status::text status,(jsonb_populate_record(null::public.tasks,data)).task_key from state_log where tbl='tasks' and row_id=$1 order by seq limit 1", [t])).rows[0];
  expect(back).toEqual({ status: 'ready', task_key: 'TASK-0001' });
  expect((await owner.query("select count(*)::int n from state_log where tbl='projects' and row_id=$1 and project_id=$1", [p])).rows[0]?.n).toBe(1);
});

test('awbs.state_at으로 과거 시점 기록을 넣을 수 있다(시험·데모 자료 전용)', async () => {
  const c = await owner.connect();
  try {
    await c.query("select set_config('awbs.state_at','2026-10-20T00:00:00+09:00',false)");
    await c.query("update tasks set title='과거' where task_key='TASK-0001'");
    await c.query("select set_config('awbs.state_at','',false)");
  } finally { c.release(); }
  const at = (await owner.query<{ at: string }>("select created_at::text at from state_log where tbl='tasks' and data->>'title'='과거'")).rows[0]?.at;
  expect(at).toBe('2026-10-19 15:00:00+00');
});

test('0037: 앱 역할은 기록 시각(awbs.state_at)을 지정할 수 없다(이력 시각 위조 차단)', async () => {
  const c = await app.connect();
  try {
    await c.query("select set_config('awbs.state_at','2020-01-01T00:00:00Z',false)");
    await expect(c.query("update tasks set title='위조 시도' where task_key='TASK-0001'")).rejects.toMatchObject({ code: '42501' });
    await c.query("select set_config('awbs.state_at','',false)");
    await c.query("update tasks set title='정상' where task_key='TASK-0001'");
  } finally { c.release(); }
  expect((await owner.query("select count(*)::int n from state_log where created_at<'2021-01-01'")).rows[0]?.n).toBe(0);
});

test('0037: 재조정 상태(pending→applied)는 상태 기록, 설정 표 변경은 설정 기록(setting_log)에 남긴다', async () => {
  const p = (await owner.query<{ id: string }>('select id from projects')).rows[0]?.id;
  const r = (await app.query<{ id: string }>("insert into replans(project_id,rp_key,trigger,actor,status,before,after) values($1,'RP-901','시험','팀장','pending','{}','{}') returning id", [p])).rows[0]?.id;
  await app.query("update replans set status='applied' where id=$1", [r]);
  expect((await owner.query("select op,data->>'status' st from state_log where tbl='replans' and row_id=$1 order by seq", [r])).rows)
    .toEqual([{ op: 'insert', st: 'pending' }, { op: 'update', st: 'applied' }]);
  await app.query('update schedule_policy set assume_rate=0.7');
  await app.query("insert into blackout_days(date,note) values('2026-12-25','성탄절')");
  await app.query('update app_settings set heartbeat_seconds=heartbeat_seconds+1');
  await app.query("insert into concurrency_settings(mode) values('manual') on conflict (singleton) do update set mode='manual'");
  const rows = (await owner.query<{ tbl: string }>("select distinct tbl from setting_log where op<>'seed' order by tbl")).rows;
  expect(rows).toEqual(['app_settings', 'blackout_days', 'concurrency_settings', 'schedule_policy'].map((tbl) => ({ tbl })));
  expect((await owner.query("select count(*)::int n from state_log where tbl in ('schedule_policy','blackout_days','app_settings','concurrency_settings')")).rows[0]?.n).toBe(0);
  await expect(app.query("update setting_log set op='x'")).rejects.toMatchObject({ code: '42501' });
});

test('앱 권한은 기록을 고치거나 지우거나 비울 수 없다', async () => {
  await expect(app.query("update state_log set op='x'")).rejects.toMatchObject({ code: '42501' });
  await expect(app.query('delete from state_log')).rejects.toMatchObject({ code: '42501' });
  await expect(app.query('truncate state_log')).rejects.toMatchObject({ code: '42501' });
  await expect(owner.query("update state_log set op='x'")).rejects.toMatchObject({ code: '42501' });
});

test('초기화: 설정 유지면 프로젝트 기록만 지우고 설정 기록은 남긴다. 설정까지 지우면 모두 지운다', async () => {
  expect((await owner.query('select count(*)::int n from state_log where project_id is not null')).rows[0]?.n).toBeGreaterThan(0);
  const name = (await owner.query<{ name: string }>('select name from projects')).rows[0]?.name;
  await app.query("select reset_project(1,$1,true,'팀장')", [name]);
  expect((await owner.query('select count(*)::int n from state_log')).rows[0]?.n).toBe(0);
  expect((await owner.query("select count(*)::int n from setting_log where tbl='schedule_policy'")).rows[0]?.n).toBeGreaterThan(0);
  const { p } = await project(app);
  const again = (await owner.query<{ name: string }>('select name from projects where id=$1', [p])).rows[0]?.name;
  await app.query("select reset_project(2,$1,false,'팀장')", [again]);
  expect((await owner.query('select (select count(*) from state_log)+(select count(*) from setting_log) n')).rows[0]?.n).toBe('0');
});

test('0036 전부터 있던 행은 seed로 한 번 남는다', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'awbs-0036-'));
  const old = new URL(url);
  old.pathname += '_old';
  const pool = createPool(old.href, { max: 2, onError: () => undefined });
  try {
    await cp(fileURLToPath(new URL('../migrations', import.meta.url)), folder, { recursive: true });
    const path = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => !e.tag.startsWith('0036_') && !e.tag.startsWith('0037_'));
    await writeFile(path, JSON.stringify(journal));
    await recreateTestDatabase(old.href);
    await migrate(drizzle(pool), { migrationsFolder: folder });
    await pool.query('select public.seed_system()');
    const { t } = await project(pool);
    await runMigrations(pool);
    expect((await pool.query("select op,data->>'status' status from state_log where tbl='tasks' and row_id=$1", [t])).rows).toEqual([{ op: 'seed', status: 'ready' }]);
  } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
});
