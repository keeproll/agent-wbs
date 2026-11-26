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
    await pool.query('insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)',[createHash('sha256').update(oldCi).digest('hex'),1795740000040]);
    journal.entries.push({ ...ci,tag:'0026_20261127_late_worker',when:1795740000005 });
    journal.entries.push({ ...ci,idx:ci.idx+1 });
    await writeFile(join(folder,'0026_20261127_late_worker.sql'),'CREATE TABLE public.review_late_worker(id integer);');
    await writeFile(path,JSON.stringify(journal));
    await expect(runMigrations(pool,folder)).rejects.toThrow('적용되지 않은 마이그레이션');
    expect((await pool.query("select to_regclass('public.review_late_worker') name")).rows).toEqual([{ name:null }]);
    await runMigrations(fresh,folder);
    expect((await fresh.query("select to_regclass('public.review_late_worker') name")).rows).toEqual([{ name:'review_late_worker' }]);
  } finally { await pool.end(); await fresh.end(); await rm(folder,{ recursive:true,force:true }); }
},30_000);
