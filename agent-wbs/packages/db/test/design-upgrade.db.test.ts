import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase } from '../src/index.ts';

test('0049를 적용한 DB에도 0053을 빠뜨리지 않고 적용한다', async () => {
  const url = new URL(inject('testDatabaseUrl'));
  url.pathname += '_design_upgrade';
  await recreateTestDatabase(url.href);
  const pool = createPool(url.href, { onError: () => undefined });
  const folder = await mkdtemp(join(tmpdir(), 'awbs-design-upgrade-'));
  try {
    await cp(fileURLToPath(new URL('../migrations/', import.meta.url)), folder, { recursive: true });
    await cp(new URL('./fixtures/0049_20261127_mail_queue.sql', import.meta.url), join(folder, '0049_20261127_mail_queue.sql'));
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string; when: number; version: string; breakpoints: boolean }[] };
    const design = journal.entries.find(entry => entry.tag.startsWith('0053_'));
    if (!design) throw new Error('0053 마이그레이션이 없습니다.');
    const entries = [...journal.entries.filter(entry => Number(entry.tag.slice(0, 4)) <= 25), { idx: 26, version: '7', tag: '0049_20261127_mail_queue', when: 1795740000049, breakpoints: true }];
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    await migrate(drizzle(pool), { migrationsFolder: folder });
    expect((await pool.query("select 1 from information_schema.columns where table_name='design_snapshots' and column_name='content'")).rowCount).toBe(0);
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: [...entries, { ...design, idx: 27 }] }));
    await migrate(drizzle(pool), { migrationsFolder: folder });
    expect((await pool.query("select 1 from information_schema.columns where table_name='design_snapshots' and column_name='content'")).rowCount).toBe(1);
    expect((await pool.query('select count(*)::int n from drizzle.__drizzle_migrations')).rows[0]?.n).toBe(28);
    const project = (await pool.query<{ id: string }>("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('legacy','https://github.com/o/r','o','r','','active') returning id")).rows[0]?.id;
    await pool.query(`insert into design_drifts(project_id,item_key,kind,compat,status,resolution,created_at) values
      ($1,'first','REST','호환','open','{"text":"이전 기록"}','2026-01-01T00:00:00Z'),
      ($1,'second','REST','호환','open',null,'2026-01-02T00:00:00Z'),
      ($1,'numbered','REST','호환','open','{"displayKey":"DR-99"}','2026-01-03T00:00:00Z')`, [project]);
    const display = journal.entries.find(entry => entry.tag.startsWith('0054_'));
    if (!display) throw new Error('0054 마이그레이션이 없습니다.');
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: [...entries, { ...design, idx: 27 }, { ...display, idx: 28 }] }));
    await migrate(drizzle(pool), { migrationsFolder: folder });
    expect((await pool.query('select item_key,resolution from design_drifts order by item_key')).rows).toEqual([
      { item_key: 'first', resolution: { displayKey: 'DR-100', text: '이전 기록' } },
      { item_key: 'numbered', resolution: { displayKey: 'DR-99' } },
      { item_key: 'second', resolution: { displayKey: 'DR-101' } },
    ]);
  } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
});
