// 0028·0029 상태 이력(M6-01 기간 말 재구성, 재리뷰 2 원칙).
// - 행 변경은 SECURITY DEFINER 트리거만 기록한다. 커밋 순서대로 단조 증가하는 커밋 시계 값을 트랜잭션마다 매긴다.
// - 앱 로그인(관리자 아님, awbs_app 권한)은 이력을 직접 쓰거나 고치거나 지울 수 없고, 기록을 건너뛸 수도 없다.
// - 초기화가 끝나면 프로젝트 이력은 지우고 전역 이력(설정·실행 PC·전역 알림)은 남긴다.
import { randomBytes } from 'node:crypto';
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
/** 관리자가 아닌 로그인 계정(awbs_app 권한만 상속). 운영 앱 계정과 같은 조건이다. */
let plain: Pool;
const plainRole = `m601_plain_${randomBytes(3).toString('hex')}`;

async function project(pool: Pool) {
  const p = (await pool.query<{ id: string }>("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('기록 시험','https://github.com/o/r','o','r','','active') returning id")).rows[0]?.id ?? '';
  const ph = (await pool.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH','phase','단계',1) returning id", [p])).rows[0]?.id;
  const wp = (await pool.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP','work_package',$2,'묶음',1) returning id", [p, ph])).rows[0]?.id;
  const t = (await pool.query<{ id: string }>(`insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state)
    values($1,'TASK-0001',$2,1,'기록','Test','BE','{}',1,'Codex','Claude','ready','none') returning id`, [p, wp])).rows[0]?.id ?? '';
  return { p, t };
}
/** 그 Task 행의 기록: 커밋 시계 순서대로 [op, 제목, 커밋 시계] */
const history = async (t: string) => (await owner.query<{ op: string; title: string | null; at: string }>(
  `select l.op,l.data->>'title' title,c.committed_at::text at from state_log l join commit_log c on c.xid=l.xid where l.tbl='tasks' and l.row_id=$1 order by l.seq`, [t])).rows;

beforeAll(async () => {
  await recreateTestDatabase(url.href);
  owner = createPool(url.href, { max: 4, onError: () => undefined });
  await runMigrations(owner);
  await seedSystem(owner);
  const appUrl = new URL(url);
  appUrl.searchParams.set('options', '-c role=awbs_app');
  app = createPool(appUrl.href, { max: 3, onError: () => undefined });
  const password = randomBytes(12).toString('hex');
  await owner.query(`create role ${plainRole} login inherit password '${password}'`);
  await owner.query(`grant awbs_app to ${plainRole}`);
  const plainUrl = new URL(url);
  plainUrl.username = plainRole;
  plainUrl.password = password;
  plain = createPool(plainUrl.href, { max: 2, onError: () => undefined });
  // 새 DB + 마이그레이션 전체 + 로그인 역할 준비. 전체 DB 시험 중 부하가 높으면 기본 60초를 넘을 수 있다(upgrade-stages와 같은 120초).
}, 120_000);
afterAll(async () => {
  // 준비가 중간에 실패해도 남은 연결·역할을 정리한다.
  await plain?.end(); await app?.end();
  await owner.query(`drop owned by ${plainRole}`).catch(() => undefined);
  await owner.query(`drop role if exists ${plainRole}`).catch(() => undefined);
  await owner.end();
});

test('행을 만들고·고치고·지우면 그 행 전체가 커밋 순서대로 남고, 트랜잭션마다 커밋 시계가 하나씩 매겨진다', async () => {
  const { t } = await project(app);
  await app.query("update tasks set title='둘째' where id=$1", [t]);
  await app.query("update tasks set title='셋째',deleted_at=now() where id=$1", [t]);
  const rows = await history(t);
  expect(rows.map((r) => [r.op, r.title])).toEqual([['insert', '기록'], ['update', '둘째'], ['update', '셋째']]);
  expect(rows.map((r) => r.at)).toEqual([...rows.map((r) => r.at)].sort());
  expect(new Set(rows.map((r) => r.at)).size).toBe(3);
  // 되살리기: 원래 표 모양의 행으로 돌아간다
  const back = (await owner.query<{ title: string; task_key: string }>(
    "select r.title,r.task_key from state_log l cross join lateral jsonb_populate_record(null::public.tasks,l.data) r where l.tbl='tasks' and l.row_id=$1 order by l.seq limit 1", [t])).rows[0];
  expect(back).toEqual({ title: '기록', task_key: 'TASK-0001' });
});

test('늦은 커밋: 먼저 고쳤지만 늦게 커밋한 트랜잭션이 더 큰 커밋 시계 값을 받는다', async () => {
  const t = (await owner.query<{ id: string }>("select id from tasks where task_key='TASK-0001'")).rows[0]?.id ?? '';
  const slow = await owner.connect();
  try {
    await slow.query('begin');
    await slow.query("update wbs_nodes set title='늦은 커밋' where node_key='PH'");
    await app.query("update tasks set title='먼저 커밋' where id=$1", [t]);
    await slow.query('commit');
  } finally { slow.release(); }
  const at = (await owner.query<{ tbl: string; at: string }>(
    `select l.tbl,c.committed_at::text at from state_log l join commit_log c on c.xid=l.xid where (l.tbl='wbs_nodes' and l.data->>'title'='늦은 커밋') or (l.tbl='tasks' and l.data->>'title'='먼저 커밋')`)).rows;
  const of = (tbl: string) => at.find((r) => r.tbl === tbl)?.at ?? '';
  expect(of('wbs_nodes') > of('tasks')).toBe(true);
});

test('시계 역행: 지금 시각이 뒤로 가도 커밋 시계는 줄지 않는다(시험 전용 시계 이동은 관리자 로그인만)', async () => {
  const t = (await owner.query<{ id: string }>("select id from tasks where task_key='TASK-0001'")).rows[0]?.id ?? '';
  await owner.query("update tasks set title='역행 전' where id=$1", [t]);
  const c = await owner.connect();
  try {
    await c.query("select set_config('awbs.test_clock_offset','-10 seconds',false)");
    await c.query("update tasks set title='역행 뒤' where id=$1", [t]);
    await c.query("select set_config('awbs.test_clock_offset','',false)");
  } finally { c.release(); }
  const rows = (await history(t)).slice(-2);
  expect(rows.map((r) => r.title)).toEqual(['역행 전', '역행 뒤']);
  expect((rows[1]?.at ?? '') > (rows[0]?.at ?? '')).toBe(true);
});

test('기준점(awbs_report_anchor): 그 뒤의 모든 커밋은 기준점보다 큰 값을 받는다(앱 권한으로 부를 수 있다)', async () => {
  const anchor = (await plain.query<{ at: string }>('select awbs_report_anchor()::text at')).rows[0]?.at ?? '';
  await app.query("update tasks set title='기준점 뒤' where task_key='TASK-0001'");
  const after = (await owner.query<{ at: string }>(
    "select c.committed_at::text at from state_log l join commit_log c on c.xid=l.xid where l.data->>'title'='기준점 뒤'")).rows[0]?.at ?? '';
  expect(after > anchor).toBe(true);
});

test('앱 로그인(관리자 아님): 이력 직접 쓰기·고치기·지우기·비우기, 트리거 끄기, 복제 모드, 시계 이동이 모두 거부된다', async () => {
  const p = (await owner.query<{ id: string }>('select id from projects')).rows[0]?.id;
  const denied = async (sql: string, args: unknown[] = []) => { await expect(plain.query(sql, args)).rejects.toMatchObject({ code: '42501' }); };
  await denied("insert into state_log(project_id,tbl,row_id,op,data) values($1,'tasks',gen_random_uuid(),'update','{\"title\":\"forged-history\"}')", [p]);
  await denied("insert into global_log(tbl,row_id,op,data) values('schedule_policy',gen_random_uuid(),'update','{}')");
  await denied("insert into commit_log(xid,committed_at) values(pg_current_xact_id(),'2020-01-01')");
  await denied("update state_log set op='x'");
  await denied('delete from state_log');
  await denied('truncate global_log');
  await denied("update log_clock set t='2020-01-01'");
  await denied('alter table tasks disable trigger state_log');
  await denied('set session_replication_role = replica');
  const c = await plain.connect();
  try {
    await c.query("select set_config('awbs.test_clock_offset','-1 day',false)");
    await expect(c.query("update tasks set title='시계 위조' where task_key='TASK-0001'")).rejects.toMatchObject({ code: '42501' });
  } finally { await c.query("select set_config('awbs.test_clock_offset','',false)"); c.release(); }
});

test('앱 로그인이 초기화 표시(awbs.reset=on)를 켜도 기록은 생략되지 않는다', async () => {
  const before = (await owner.query<{ n: number }>("select count(*)::int n from state_log where tbl='tasks'")).rows[0]?.n ?? 0;
  const c = await plain.connect();
  try {
    await c.query("select set_config('awbs.reset','on',false)");
    await c.query("update tasks set title='초기화 흉내' where task_key='TASK-0001'");
  } finally { await c.query("select set_config('awbs.reset','',false)"); c.release(); }
  expect((await owner.query<{ n: number }>("select count(*)::int n from state_log where tbl='tasks'")).rows[0]?.n).toBe(before + 1);
});

test('전역 행(설정·실행 PC·전역 알림)은 global_log, 프로젝트 행은 state_log에 남는다', async () => {
  const p = (await owner.query<{ id: string }>('select id from projects')).rows[0]?.id;
  await app.query('update schedule_policy set assume_rate=0.7');
  await app.query("insert into runner_sessions(runner_id,started_at,last_heartbeat_at) values('pc',now(),now())");
  await app.query("insert into alerts(project_id,key,severity,target) values(null,'global:test','warn','{}'),($1,'project:test','warn','{}')", [p]);
  const g = (await owner.query<{ tbl: string }>("select distinct tbl from global_log where op<>'seed' order by tbl")).rows.map((r) => r.tbl);
  expect(g).toEqual(expect.arrayContaining(['alerts', 'runner_sessions', 'schedule_policy']));
  expect((await owner.query("select count(*)::int n from state_log where tbl='alerts' and data->>'key'='project:test'")).rows[0]?.n).toBe(1);
  expect((await owner.query("select count(*)::int n from global_log where tbl='alerts' and data->>'key'='project:test'")).rows[0]?.n).toBe(0);
});

test('초기화: 프로젝트 이력은 지우고, 전역 이력은 남기며 초기화의 삭제도 기록한다', async () => {
  const name = (await owner.query<{ name: string }>('select name from projects')).rows[0]?.name;
  await app.query("select reset_project(1,$1,true,'팀장')", [name]);
  expect((await owner.query('select count(*)::int n from state_log')).rows[0]?.n).toBe(0);
  expect((await owner.query("select count(*)::int n from global_log where tbl='schedule_policy'")).rows[0]?.n).toBeGreaterThan(0);
  // 초기화가 지운 전역 알림도 「삭제」로 남는다 → 초기화 뒤 시점에서 되살리면 없다
  expect((await owner.query("select op from global_log where tbl='alerts' and row_id=(select row_id from global_log where data->>'key'='global:test' limit 1) order by seq desc limit 1")).rows[0]?.op).toBe('delete');
});

test('0028 전부터 있던 행은 seed로 한 번 남고 커밋 시계가 매겨진다', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'awbs-0028-'));
  const old = new URL(url);
  old.pathname += '_old';
  const pool = createPool(old.href, { max: 2, onError: () => undefined });
  try {
    await cp(fileURLToPath(new URL('../migrations', import.meta.url)), folder, { recursive: true });
    const path = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8')) as { entries: { tag: string }[] };
    // M6 통합: 0028(상태 이력, 옛 0036) 이후 전부를 뺀다. 0030(옛 0047) 이름 채움이 0028 상태 이력을 읽으므로, 실제 업그레이드 순서(0028 → 0029 → 0030 …)와 같게 둔다.
    journal.entries = journal.entries.filter((e) => e.tag < '0028');
    await writeFile(path, JSON.stringify(journal));
    await recreateTestDatabase(old.href);
    await migrate(drizzle(pool), { migrationsFolder: folder });
    await pool.query('select public.seed_system()');
    const { t } = await project(pool);
    await runMigrations(pool);
    expect((await pool.query("select l.op,l.data->>'status' status,c.committed_at is not null stamped from state_log l join commit_log c on c.xid=l.xid where tbl='tasks' and row_id=$1", [t])).rows)
      .toEqual([{ op: 'seed', status: 'ready', stamped: true }]);
    expect((await pool.query("select count(*)::int n from global_log where op='seed' and tbl='schedule_policy'")).rows[0]?.n).toBe(1);
  } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
});
