import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTestDatabaseUrl } from '../src/test-database.ts';

const url = process.env.TEST_DATABASE_URL;
assertTestDatabaseUrl(url);
const migrations = fileURLToPath(new URL('../migrations', import.meta.url));
const seed = fileURLToPath(new URL('../src/seed.ts', import.meta.url));
const original = await readFile(seed, 'utf8');
assert(process.argv[2], 'usage: node test/mutations.ts <report-directory>');
const outDir = resolve(process.argv[2]);
await mkdir(outDir, { recursive: true });
const root = resolve(import.meta.dirname, '../../..');
const variants = [
  { name: 'demo connection guard', pattern: 'MUTATION: actual connected demo guard', sql: '' },
  {
    name: 'scope FK loop',
    pattern: 'P2-6: every FK',
    sql: `DO $$ DECLARE r record; BEGIN FOR r IN SELECT conrelid::regclass t,conname FROM pg_constraint WHERE contype='f' AND conname LIKE 'scope_%' LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.t,r.conname); END LOOP; END $$;`,
  },
  {
    name: 'notify_events reset deletion',
    pattern: 'MUTATION/P2-11: reset keep=true',
    sql: `DO $$ BEGIN EXECUTE replace(pg_get_functiondef('public.reset_project(integer,text,boolean,text)'::regprocedure),'DELETE FROM public.notify_events;','-- mutation: deletion omitted'); END $$;`,
  },
  {
    name: 'merge task unique',
    pattern: 'MUTATION: orphan observation FK',
    sql: 'DROP INDEX public.one_open_merge_task;',
  },
  {
    name: 'observation attempt FK',
    pattern: 'MUTATION: orphan observation FK',
    sql: `DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.conname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) WHERE c.contype='f' AND c.conrelid='public.attempt_observations'::regclass AND a.attname='attempt' LOOP EXECUTE format('ALTER TABLE public.attempt_observations DROP CONSTRAINT %I',r.conname); END LOOP; END $$;`,
  },
  {
    name: 'none to active',
    pattern: 'P2-1: holds reject invalid',
    sql: `DO $$ BEGIN EXECUTE replace(pg_get_functiondef('public.awbs_hold_transition()'::regprocedure),$old$(OLD.slot_state='none' AND NEW.slot_state='reserved') OR$old$,$new$(OLD.slot_state='none' AND NEW.slot_state IN ('reserved','active')) OR$new$); END $$;`,
  },
  {
    name: 'null cleanup proof',
    pattern: 'cleanup cannot accept a null proof',
    sql: `DO $$ BEGIN EXECUTE replace(pg_get_functiondef('public.complete_cleanup(uuid,integer,boolean,jsonb)'::regprocedure),$old$jsonb_typeof(proof->'proof') IS DISTINCT FROM 'string' OR $old$,''); END $$;`,
  },
  {
    name: 'mutable cleanup payload',
    pattern: 'cleanup payload is protected',
    sql: 'GRANT UPDATE ON public.runner_commands TO awbs_app;',
  },
  {
    name: 'cgroup no_process bypass',
    pattern: 'cleanup payload is protected',
    sql: `DO $$ BEGIN EXECUTE replace(pg_get_functiondef('public.complete_cleanup(uuid,integer,boolean,jsonb)'::regprocedure),$old$ OR h->>'cgroup' IS NOT NULL$old$,''); END $$;`,
  },
  {
    name: 'null hold reason code',
    pattern: 'hold reasons reject null codes',
    sql: `DO $$ BEGIN EXECUTE replace(pg_get_functiondef('public.awbs_valid_hold_reasons(jsonb)'::regprocedure),$old$jsonb_typeof(item->'code') IS DISTINCT FROM 'string' OR $old$,''); END $$;`,
  },
];
function run(pattern: string, folder?: string, index = 0) {
  const database = new URL(url as string);
  database.pathname += `_mut${index}`;
  const env = { ...process.env, TEST_DATABASE_URL: database.href, NO_COLOR: '1' };
  if (folder) Object.assign(env, { AWBS_MUTATION_MIGRATIONS: folder });
  const result = spawnSync('pnpm', ['-C', root, 'test:db', '--', 'schema-review', '-t', pattern], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2_000_000,
  });
  return { code: result.status, output: result.stdout + result.stderr, error: result.error };
}
const results: { name: string; code: number | null; killed: boolean }[] = [];
try {
  const baseline = run('.');
  await writeFile(join(outDir, 'baseline.log'), baseline.output);
  assert.equal(baseline.code, 0, baseline.output);
  for (const [index, variant] of variants.entries()) {
    const folder = join(outDir, `migration-${index}`);
    await cp(migrations, folder, { recursive: true });
    const journalFile = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    if (variant.sql) {
      const previous = journal.entries.at(-1);
      assert(previous);
      journal.entries.push({
        idx: previous.idx + 1,
        version: '7',
        when: previous.when + 1,
        tag: '9999_mutation',
        breakpoints: true,
      });
      await writeFile(join(folder, '9999_mutation.sql'), variant.sql);
      await writeFile(journalFile, JSON.stringify(journal));
    } else {
      assert(original.includes('await assertConnectedToTestDatabase(pool);'));
      await writeFile(
        seed,
        original.replace(
          'await assertConnectedToTestDatabase(pool);',
          '// mutation: actual connection guard omitted',
        ),
      );
    }
    let result;
    try {
      result = run(variant.pattern, folder, index + 1);
    } finally {
      await writeFile(seed, original);
    }
    await writeFile(join(outDir, `mutation-${index + 1}.log`), result.output);
    const killed =
      result.code === 1 &&
      /FAIL\s+packages\/db\/test\/schema-review.db.test.ts\s+>/.test(result.output) &&
      !result.error;
    results.push({ name: variant.name, code: result.code, killed });
    assert(killed, `${variant.name} survived or failed outside a test:\n${result.output}`);
  }
} finally {
  await writeFile(seed, original);
  await writeFile(join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  for (const index of variants.keys())
    await rm(join(outDir, `migration-${index}`), { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      baseline: 0,
      killed: results.filter((r) => r.killed).length,
      total: variants.length,
      results,
      report: outDir,
    },
    null,
    2,
  ),
);
