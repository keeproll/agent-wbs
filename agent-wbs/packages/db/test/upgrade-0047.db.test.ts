/**
 * 0047: 이름 없는 옛 보고서 스냅샷(M6-01 형식)의 프로젝트 이름(Codex 리뷰 P2, 재리뷰 3차 P2-2). 추측하지 않는다.
 *
 * - 이름 변경 기록이 전혀 없는 프로젝트: 지금 이름을 넣는다(이름이 한 번도 바뀌지 않았으니 그때 이름과 같다). 표시 current.
 * - 이름 변경 기록이 하나라도 있는 프로젝트: 그때 이름이 확실하지 않으므로 이름을 넣지 않고 표시 unknown만 남긴다.
 *   (DB에 커밋 시각이 없어, 변경이 보고서 앞인지 뒤인지 확정할 수 없다. 트랜잭션 번호 등으로 추정하지 않는다.)
 * - 리뷰어 재현(편집과 보고서가 겹치는 세 순서)이 모두 unknown이 되는지 본다. 시나리오마다 DB를 따로 만든다(프로젝트는 DB마다 하나).
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
const snap = async (db: Db, id: string | undefined) => (await db.query<{ snapshot: Record<string, unknown> }>('select snapshot from reports where id=$1', [id])).rows[0]?.snapshot;
const current = (name: string) => ({ summary: { taskCount: 1 }, projectName: name, projectNameFilled: { source: 'current' } });
const unknown = { summary: { taskCount: 1 }, projectNameFilled: { source: 'unknown' } };

const pools: Pool[] = [];
afterAll(async () => { await Promise.all(pools.map((p) => p.end())); });
const ids: Record<string, string> = {};
let dated: Pool;

beforeAll(async () => {
  // 이름을 바꾼 프로젝트(11-02): 변경 전·후 보고서, 이미 이름이 있는 보고서
  dated = await legacyDb('dated');
  pools.push(dated);
  const p = await project(dated, '옛 이름');
  ids.before = await report(dated, p, 'RPT-C-001', '2026-11-01T00:00:00Z');
  await rename(dated, p, '옛 이름', '지금 이름', '2026-11-02T00:00:00Z');
  ids.after = await report(dated, p, 'RPT-C-002', '2026-11-03T00:00:00Z');
  ids.named = await report(dated, p, 'RPT-C-003', '2026-10-30T00:00:00Z', { projectName: '스냅샷 이름', summary: { taskCount: 3 } });
}, 60_000);

test('이름을 바꾼 적이 있는 프로젝트의 옛 보고서는 변경 앞뒤와 관계없이 이름 미상(unknown)이다. 이미 이름이 있으면 그대로. 두 번 올려도 같다', async () => {
  await runMigrations(dated);
  await runMigrations(dated);
  expect(await snap(dated, ids.before)).toEqual(unknown);
  expect(await snap(dated, ids.after)).toEqual(unknown);
  expect(await snap(dated, ids.named)).toEqual({ projectName: '스냅샷 이름', summary: { taskCount: 3 } });
});

test('이름을 바꾼 적 없는 프로젝트는 지금 이름(current)이다', async () => {
  const db = await legacyDb('same');
  pools.push(db);
  const p = await project(db, '그대로');
  const id = await report(db, p, 'RPT-C-040', '2026-11-01T00:00:00Z');
  // 이름이 그대로인 「프로젝트 수정」(설명만 바꿈)은 이름 변경이 아니다.
  await rename(db, p, '그대로', '그대로', '2026-11-02T00:00:00Z');
  await runMigrations(db);
  expect(await snap(db, id)).toEqual(current('그대로'));
}, 60_000);

test('리뷰어 재현 1: 편집이 먼저 시작하고, 그사이 보고서를 저장한 뒤 이름을 바꿔 커밋 → unknown(옛 이름·새 이름 어느 쪽으로도 채우지 않는다)', async () => {
  const db = await legacyDb('race1');
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
  await runMigrations(db);
  expect(await snap(db, id)).toEqual(unknown);
}, 60_000);

test('리뷰어 재현 2(3차 2-a): 보고서 트랜잭션이 세대 잠금을 잡은 뒤 이름 변경이 커밋되고, 보고서가 새 이름을 읽어 저장 → unknown', async () => {
  const db = await legacyDb('race2');
  pools.push(db);
  await db.query("insert into system_state(id,epoch) values(1,1) on conflict (id) do nothing");
  const p = await project(db, 'A');
  const rep = await db.connect();
  let id: string;
  try {
    await rep.query('begin');
    await rep.query('select public.lock_epoch(1)');
    await rename(db, p, 'A', 'B');
    const seen = (await rep.query<{ name: string }>('select name from projects where id=$1', [p])).rows[0]?.name;
    expect(seen).toBe('B');
    id = await report(rep, p, 'RPT-C-011', null);
    await rep.query('commit');
  } finally { rep.release(); }
  await runMigrations(db);
  expect(await snap(db, id)).toEqual(unknown);
}, 60_000);

test('리뷰어 재현 3(3차 2-b): 이름 변경을 쓰고 커밋하기 전에 보고서를 저장(옛 이름을 읽음)한 뒤 커밋 → unknown(지금 이름으로 확정하지 않는다)', async () => {
  const db = await legacyDb('race3');
  pools.push(db);
  const p = await project(db, 'A');
  const edit = await db.connect();
  let id: string;
  try {
    await edit.query('begin');
    await rename(edit, p, 'A', 'B');
    const seen = (await db.query<{ name: string }>('select name from projects where id=$1', [p])).rows[0]?.name;
    expect(seen).toBe('A');
    id = await report(db, p, 'RPT-C-012', null);
    await edit.query('commit');
  } finally { edit.release(); }
  await runMigrations(db);
  expect(await snap(db, id)).toEqual(unknown);
}, 60_000);

test('채운 뒤에도 보고서는 수정할 수 없다(append_only 트리거가 켜져 있다)', async () => {
  await expect(dated.query("update reports set reason='x' where id=$1", [ids.before])).rejects.toThrow();
  expect((await dated.query("select tgenabled from pg_trigger where tgname='append_only' and tgrelid='public.reports'::regclass")).rows).toEqual([{ tgenabled: 'O' }]);
});
