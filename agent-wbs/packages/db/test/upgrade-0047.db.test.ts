/**
 * 0047: 이름 없는 옛 보고서 스냅샷에 생성 시점 프로젝트 이름을 채운다(Codex 리뷰 M6-02 P2).
 *
 * - M6-01 형식 스냅샷에는 projectName이 없다. 보고서는 생성 시점 기록이므로 「그때 이름」을 넣는다.
 * - 그때 이름은 이름 변경 기록(task_history 「프로젝트 수정」의 before.name)에서 찾는다.
 *   보고서 생성 뒤 첫 변경의 before.name이 그때 이름이다. 생성 뒤 변경 기록이 없으면 지금 이름이 그때 이름이다.
 * - 채운 보고서에는 projectNameFilled.source(history|current)를 남긴다. 이미 이름이 있는 보고서는 바꾸지 않는다.
 * - 채운 뒤에도 보고서는 수정할 수 없다(append_only 트리거가 다시 켜져 있다).
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations } from '../src/index.ts';

const url = new URL(inject('testDatabaseUrl'));
url.pathname += '_legacy47';
const pool = createPool(url.href, { onError: () => undefined });
const ids: Record<string, string> = {};

beforeAll(async () => {
  await recreateTestDatabase(url.href);
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
  const project = (await pool.query<{ id: string }>(
    "insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('지금 이름','https://github.com/fake/p','fake','p','','active') returning id")).rows[0]?.id ?? '';
  // 11-02에 「옛 이름」→「지금 이름」으로 바꿨다.
  await pool.query(`insert into task_history(project_id,actor,kind,text,before,after,ref,created_at,at) values
    ($1,'팀장','프로젝트 수정','프로젝트 정보를 수정했습니다.','{"name":"옛 이름","description":""}','{"name":"지금 이름","description":""}','{"kind":"project"}','2026-11-02T00:00:00Z','2026-11-02T00:00:00Z')`, [project]);
  const report = async (key: string, at: string, snapshot: object) => (await pool.query<{ id: string }>(
    `insert into reports(project_id,report_key,kind,"from","to",view,snapshot,generated_at,reason) values($1,$2,'custom','2026-10-27','2026-10-27','int',$3::jsonb,$4,'팀장 지정') returning id`,
    [project, key, JSON.stringify(snapshot), at])).rows[0]?.id ?? '';
  ids.before = await report('RPT-C-001', '2026-11-01T00:00:00Z', { summary: { taskCount: 1 } });
  ids.after = await report('RPT-C-002', '2026-11-03T00:00:00Z', { summary: { taskCount: 2 } });
  ids.named = await report('RPT-C-003', '2026-10-30T00:00:00Z', { projectName: '스냅샷 이름', summary: { taskCount: 3 } });
});
afterAll(() => pool.end());

test('이름 없는 옛 보고서에 그때 이름을 채우고 표시를 남긴다. 이미 이름이 있으면 그대로 둔다', async () => {
  await runMigrations(pool);
  await runMigrations(pool);
  const snap = async (id: string) => (await pool.query<{ snapshot: Record<string, unknown> }>('select snapshot from reports where id=$1', [id])).rows[0]?.snapshot;
  // 이름 변경 전에 만든 보고서: 변경 기록의 before.name
  expect(await snap(ids.before ?? '')).toEqual({ summary: { taskCount: 1 }, projectName: '옛 이름', projectNameFilled: { source: 'history' } });
  // 이름 변경 뒤에 만든 보고서: 그 뒤 변경이 없으니 지금 이름이 그때 이름이다.
  expect(await snap(ids.after ?? '')).toEqual({ summary: { taskCount: 2 }, projectName: '지금 이름', projectNameFilled: { source: 'current' } });
  // 이미 이름이 있는 보고서는 바꾸지 않는다.
  expect(await snap(ids.named ?? '')).toEqual({ projectName: '스냅샷 이름', summary: { taskCount: 3 } });
});

test('채운 뒤에도 보고서는 수정할 수 없다(append_only 트리거가 켜져 있다)', async () => {
  await expect(pool.query("update reports set reason='x' where id=$1", [ids.before])).rejects.toThrow();
  expect((await pool.query("select tgenabled from pg_trigger where tgname='append_only' and tgrelid='public.reports'::regclass")).rows).toEqual([{ tgenabled: 'O' }]);
});
