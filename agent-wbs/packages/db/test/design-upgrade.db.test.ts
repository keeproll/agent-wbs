import { copyFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations } from '../src/index.ts';

/*
 * M6-05: 메일 큐를 먼저 적용한 DB에도 설계 원장(0034, 옛 0053·M6 통합 0042)과 표시 번호(0035, 옛 0054·M6 통합 0043)를 빠뜨리지 않는다.
 * M6 통합 재번호 뒤 상황: 옛 번호 0049(when …049)로 메일 큐를 적용한 DB에 새 번호 0034(when …034)가 오면
 * Drizzle만으로는 건너뛴다. runMigrations의 보충(fillSkipped)이 적용해야 한다.
 */
test('옛 번호 0049(메일 큐)를 적용한 DB에도 0034·0035를 빠뜨리지 않고 적용한다', async () => {
  const url = new URL(inject('testDatabaseUrl'));
  url.pathname += '_design_upgrade';
  await recreateTestDatabase(url.href);
  const pool = createPool(url.href, { onError: () => undefined });
  const folder = await mkdtemp(join(tmpdir(), 'awbs-design-upgrade-'));
  try {
    await cp(fileURLToPath(new URL('../migrations/', import.meta.url)), folder, { recursive: true });
    // 옛 번호 이름으로 같은 내용(hash가 같다)
    await copyFile(join(folder, '0031_20261127_mail_queue.sql'), join(folder, '0049_20261127_mail_queue.sql'));
    interface Entry { idx: number; tag: string; when: number; version: string; breakpoints: boolean }
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: Entry[] };
    const byTag = (prefix: string) => {
      const entry = journal.entries.find(e => e.tag.startsWith(prefix));
      if (!entry) throw new Error(`${prefix} 마이그레이션이 없습니다.`);
      return entry;
    };
    const design = byTag('0034_'), display = byTag('0035_');
    const entries: Entry[] = [...journal.entries.filter(e => Number(e.tag.slice(0, 4)) <= 25), { idx: 26, version: '7', tag: '0049_20261127_mail_queue', when: 1795740000049, breakpoints: true }];
    const write = (list: Entry[]) => writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: list }));
    await write(entries);
    await migrate(drizzle(pool), { migrationsFolder: folder });
    expect((await pool.query("select 1 from information_schema.columns where table_name='design_snapshots' and column_name='content'")).rowCount).toBe(0);
    // 1) Drizzle만 쓰면 0034를 건너뛴다(통합 전 문제 재현)
    await write([...entries, { ...design, idx: 27 }]);
    await migrate(drizzle(pool), { migrationsFolder: folder });
    expect((await pool.query("select 1 from information_schema.columns where table_name='design_snapshots' and column_name='content'")).rowCount).toBe(0);
    // 2) runMigrations는 보충한다
    await runMigrations(pool, folder);
    expect((await pool.query("select 1 from information_schema.columns where table_name='design_snapshots' and column_name='content'")).rowCount).toBe(1);
    expect((await pool.query('select count(*)::int n from drizzle.__drizzle_migrations')).rows[0]?.n).toBe(28);
    const project = (await pool.query<{ id: string }>("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('legacy','https://github.com/o/r','o','r','','active') returning id")).rows[0]?.id;
    await pool.query(`insert into design_drifts(project_id,item_key,kind,compat,status,resolution,created_at) values
      ($1,'first','REST','호환','open','{"text":"이전 기록"}','2026-01-01T00:00:00Z'),
      ($1,'second','REST','호환','open',null,'2026-01-02T00:00:00Z'),
      ($1,'numbered','REST','호환','open','{"displayKey":"DR-99"}','2026-01-03T00:00:00Z')`, [project]);
    await write([...entries, { ...design, idx: 27 }, { ...display, idx: 28 }]);
    await runMigrations(pool, folder);
    expect((await pool.query('select item_key,resolution from design_drifts order by item_key')).rows).toEqual([
      { item_key: 'first', resolution: { displayKey: 'DR-100', text: '이전 기록' } },
      { item_key: 'numbered', resolution: { displayKey: 'DR-99' } },
      { item_key: 'second', resolution: { displayKey: 'DR-101' } },
    ]);
  } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
});
