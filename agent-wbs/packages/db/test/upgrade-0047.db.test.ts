/**
 * 0047: 이름 없는 옛 보고서 스냅샷에 생성 시점 프로젝트 이름을 채운다(Codex 리뷰 M6-02 P2, 재리뷰 P2-2).
 *
 * 기준 시각은 보고서 생성 시각(reports.generated_at)이다. 이름 변경 기록(task_history 「프로젝트 수정」)마다
 * 「보고서 생성 뒤의 변경인가」를 아래 근거로 판정하고, 생성 뒤 첫 변경의 바꾸기 전 이름을 넣는다. 없으면 지금 이름이다.
 * - 변경 트랜잭션이 생성 시각보다 늦게 시작했다(created_at > generated_at).
 * - 변경 알림(change_events)의 순번이 보고서 알림보다 크다(나중에 커밋했다).
 * - 변경을 쓴 트랜잭션이 보고서 행을 쓴 트랜잭션보다 새것이다(보고서를 저장한 뒤에 이름을 썼다. 리뷰어 재현).
 * 같은 트랜잭션 안의 여러 변경은 시각이 같으므로, 이름 사슬(before → after) 순서로 첫 변경을 정한다.
 * 이 시험은 시나리오마다 프로젝트를 따로 둔다.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations } from '../src/index.ts';

type Pool = ReturnType<typeof createPool>;
interface Db { query: Pool['query'] }

/** 시나리오마다 따로 만드는 0047 앞 단계 DB(프로젝트는 DB마다 하나뿐이다). */
async function legacyDb(name: string): Promise<Pool> {
  const url = new URL(inject('testDatabaseUrl'));
  url.pathname += `_legacy47_${name}`;
  await recreateTestDatabase(url.href);
  const pool = createPool(url.href, { onError: () => undefined });
  const folder = await mkdtemp(join(tmpdir(), 'awbs-upgrade-'));
  try {
    await cp(fileURLToPath(new URL('../migrations/', import.meta.url)), folder, { recursive: true });
    const path = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8')) as { entries: { tag: string }[] };
    // 0047 바로 앞까지만 올린다(M6-01 형식 DB).
    journal.entries = journal.entries.filter((e) => e.tag < '0047');
    await writeFile(path, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally { await rm(folder, { recursive: true }); }
  return pool;
}
const project = async (db: Db, name: string) => (await db.query<{ id: string }>(
  "insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values($1,'https://github.com/fake/p','fake','p','','active') returning id", [name])).rows[0]?.id ?? '';
/** 옛 형식 보고서(이름 없음). at이 없으면 지금 시계(clock_timestamp)로 만든다. */
const report = async (db: Db, projectId: string, key: string, at: string | null, snapshot: object = { summary: { taskCount: 1 } }) =>
  (await db.query<{ id: string }>(
    `insert into reports(project_id,report_key,kind,"from","to",view,snapshot,generated_at,reason) values($1,$2,'custom','2026-10-27','2026-10-27','int',$3::jsonb,coalesce($4::timestamptz,clock_timestamp()),'팀장 지정') returning id`,
    [projectId, key, JSON.stringify(snapshot), at])).rows[0]?.id ?? '';
/** 프로젝트 수정 화면(apps/api/src/project/edit.ts)과 같은 순서: 이름을 바꾸고 기록을 남긴다. at이 없으면 기본값(now = 트랜잭션 시작 시각). */
const rename = async (db: Db, projectId: string, from: string, to: string, at: string | null = null) => {
  await db.query('update projects set name=$2 where id=$1', [projectId, to]);
  await db.query(`insert into task_history(project_id,actor,kind,text,before,after,ref,created_at,at) values
    ($1,'팀장','프로젝트 수정','프로젝트 정보를 수정했습니다.',$2::jsonb,$3::jsonb,'{"kind":"project"}',coalesce($4::timestamptz,now()),coalesce($4::timestamptz,now()))`,
  [projectId, JSON.stringify({ name: from, description: '' }), JSON.stringify({ name: to, description: '' }), at]);
};
const event = (db: Db, projectId: string, topic: 'report' | 'project', ref: object, at: string) =>
  db.query('insert into change_events(project_id,topic,ref,at) values($1,$2,$3::jsonb,$4)', [projectId, topic, JSON.stringify(ref), at]);
const snap = async (db: Db, id: string | undefined) => (await db.query<{ snapshot: Record<string, unknown> }>('select snapshot from reports where id=$1', [id])).rows[0]?.snapshot;
const filled = (name: string, source: 'history' | 'current') => ({ summary: { taskCount: 1 }, projectName: name, projectNameFilled: { source } });

const pools: Pool[] = [];
afterAll(async () => { await Promise.all(pools.map((p) => p.end())); });
const ids: Record<string, string> = {};
let dated: Pool;

beforeAll(async () => {
  // 1. 날짜가 분명한 이름 변경(11-02) 앞뒤의 보고서, 이미 이름이 있는 보고서
  dated = await legacyDb('dated');
  pools.push(dated);
  const p = await project(dated, '옛 이름');
  ids.before = await report(dated, p, 'RPT-C-001', '2026-11-01T00:00:00Z');
  await rename(dated, p, '옛 이름', '지금 이름', '2026-11-02T00:00:00Z');
  ids.after = await report(dated, p, 'RPT-C-002', '2026-11-03T00:00:00Z');
  ids.named = await report(dated, p, 'RPT-C-003', '2026-10-30T00:00:00Z', { projectName: '스냅샷 이름', summary: { taskCount: 3 } });
}, 60_000);

test('날짜가 분명한 변경: 변경 전 보고서는 바꾸기 전 이름, 변경 뒤 보고서는 지금 이름, 이미 이름이 있으면 그대로. 두 번 올려도 같다', async () => {
  await runMigrations(dated);
  await runMigrations(dated);
  expect(await snap(dated, ids.before)).toEqual(filled('옛 이름', 'history'));
  expect(await snap(dated, ids.after)).toEqual(filled('지금 이름', 'current'));
  expect(await snap(dated, ids.named)).toEqual({ projectName: '스냅샷 이름', summary: { taskCount: 3 } });
});

test('리뷰어 재현: 편집 트랜잭션이 먼저 시작해(기록 시각이 더 이르다) 보고서 저장 뒤에 이름을 바꿨으면, 그때 이름은 옛 이름이다', async () => {
  const db = await legacyDb('race');
  pools.push(db);
  const p = await project(db, '경합 옛 이름');
  const edit = await db.connect();
  let id: string;
  try {
    await edit.query('begin');
    await edit.query('select now()');
    await new Promise((r) => setTimeout(r, 30));
    id = await report(db, p, 'RPT-C-010', null);
    await rename(edit, p, '경합 옛 이름', '경합 새 이름');
    await edit.query('commit');
  } finally { edit.release(); }
  // 전제 확인: 변경 기록 시각이 보고서 생성 시각보다 이르다(시각만 보면 「변경 뒤 보고서」로 잘못 판정된다).
  const t = (await db.query<{ early: boolean }>("select h.created_at < r.generated_at early from task_history h, reports r where h.kind='프로젝트 수정' and r.id=$1", [id])).rows[0];
  expect(t?.early).toBe(true);
  await runMigrations(db);
  expect(await snap(db, id)).toEqual(filled('경합 옛 이름', 'history'));
}, 60_000);

test('한 트랜잭션 안의 두 변경(A→B→C)은 이름 사슬 순서로 판정한다(기록을 거꾸로 넣어도 첫 변경 A→B의 바꾸기 전 이름 A)', async () => {
  const db = await legacyDb('chain');
  pools.push(db);
  const p = await project(db, 'A');
  const id = await report(db, p, 'RPT-C-020', '2026-11-10T00:00:00Z');
  const tx = await db.connect();
  try {
    await tx.query('begin');
    await tx.query("update projects set name='C' where id=$1", [p]);
    for (const [from, to] of [['B', 'C'], ['A', 'B']]) {
      await tx.query(`insert into task_history(project_id,actor,kind,text,before,after,ref) values($1,'팀장','프로젝트 수정','프로젝트 정보를 수정했습니다.',$2::jsonb,$3::jsonb,'{"kind":"project"}')`,
        [p, JSON.stringify({ name: from, description: '' }), JSON.stringify({ name: to, description: '' })]);
    }
    await tx.query('commit');
  } finally { tx.release(); }
  await runMigrations(db);
  expect(await snap(db, id)).toEqual(filled('A', 'history'));
}, 60_000);

test('변경 알림 순서로만 판정되는 경우: 기록 시각이 이르고 기록도 먼저 썼지만, 변경 알림이 보고서 알림보다 뒤면 옛 이름이다', async () => {
  const db = await legacyDb('event');
  pools.push(db);
  const p = await project(db, '알림 옛 이름');
  await rename(db, p, '알림 옛 이름', '알림 새 이름', '2026-11-09T00:00:00Z');
  const id = await report(db, p, 'RPT-C-030', '2026-11-10T00:00:00Z');
  await event(db, p, 'report', { id }, '2026-11-10T00:00:00Z');
  await event(db, p, 'project', { kind: 'project' }, '2026-11-09T00:00:00Z');
  await runMigrations(db);
  expect(await snap(db, id)).toEqual(filled('알림 옛 이름', 'history'));
}, 60_000);

test('시작 시각으로만 판정되는 경우: 보고서 생성(11-01)을 시작한 뒤 변경 트랜잭션이 시작(11-02)해 먼저 기록했고, 보고서 행은 그 뒤에 저장했다 → 옛 이름', async () => {
  const db = await legacyDb('start');
  pools.push(db);
  const p = await project(db, '시작 옛 이름');
  await rename(db, p, '시작 옛 이름', '시작 새 이름', '2026-11-02T00:00:00Z');
  // 보고서 행은 변경 기록보다 나중에 썼다(트랜잭션 순서로는 「변경 전」처럼 보인다). 알림도 없다.
  const id = await report(db, p, 'RPT-C-050', '2026-11-01T00:00:00Z');
  await runMigrations(db);
  expect(await snap(db, id)).toEqual(filled('시작 옛 이름', 'history'));
}, 60_000);

test('이름을 바꾼 적 없는 프로젝트는 지금 이름이다', async () => {
  const db = await legacyDb('same');
  pools.push(db);
  const p = await project(db, '그대로');
  const id = await report(db, p, 'RPT-C-040', '2026-11-01T00:00:00Z');
  await runMigrations(db);
  expect(await snap(db, id)).toEqual(filled('그대로', 'current'));
}, 60_000);

test('채운 뒤에도 보고서는 수정할 수 없다(append_only 트리거가 켜져 있다)', async () => {
  await expect(dated.query("update reports set reason='x' where id=$1", [ids.before])).rejects.toThrow();
  expect((await dated.query("select tgenabled from pg_trigger where tgname='append_only' and tgrelid='public.reports'::regclass")).rows).toEqual([{ tgenabled: 'O' }]);
});
