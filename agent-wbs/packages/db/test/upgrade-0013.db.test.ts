// 교차 리뷰 지적 1: 0013 전에 저장된 분할 CP·CI 실행을 업그레이드 뒤에도 닫고 결과를 저장할 수 있어야 한다.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations } from '../src/index.ts';

const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_upgrade13';
const pool = createPool(dbUrl.href, { max: 2, onError: () => undefined });
const ids: Record<string, string> = {};

/** 0012까지 적용하고 그 시점의 정상 데이터를 넣은 뒤 최신까지 올린다. */
beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  const temp = await mkdtemp(join(tmpdir(), 'awbs-upgrade13-'));
  try {
    await cp(fileURLToPath(new URL('../migrations/', import.meta.url)), temp, { recursive: true });
    const path = join(temp, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 12);
    await writeFile(path, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: temp });
  } finally {
    await rm(temp, { recursive: true });
  }
  const row = async (sql: string, values: unknown[] = []) => {
    const found = (await pool.query<{ id: string }>(`${sql} returning id`, values)).rows[0];
    assert(found);
    return found.id;
  };
  ids.p = await row("insert into projects(name,repo_url,repo_owner,repo_name,base_commit,lead_instruction,phase) values('p','https://github.com/o/r','o','r','base','','active')");
  ids.cp = await row("insert into change_proposals(project_id,cp_key,source,status,ops) values($1,'CP-legacy','split','draft','[]')", [ids.p]);
  ids.manual = await row("insert into change_proposals(project_id,cp_key,source,status,ops) values($1,'CP-manual','manual','review','[]')", [ids.p]);
  ids.ci = await row("insert into ci_runs(project_id,run_key,stage,pipeline_sha,ref,trigger,status) values($1,'CI-legacy',1,'sha','main','manual','queued')", [ids.p]);
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});

async function transaction(fn: (client: pg.PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}
async function rejects(client: pg.PoolClient, sql: string, values: unknown[], constraint: string) {
  await client.query('savepoint invalid');
  await expect(client.query(sql, values)).rejects.toMatchObject({ code: '23514', constraint });
  await client.query('rollback to savepoint invalid');
}

test('이전 행은 보존되고 제목·사유가 채워진다', async () => {
  const { rows } = await pool.query("select cp_key,title,reason,source,source_id from change_proposals order by cp_key");
  expect(rows).toEqual([
    { cp_key: 'CP-legacy', title: 'CP-legacy', reason: '이전 버전에서 저장되어 사유가 없음', source: 'split', source_id: null },
    { cp_key: 'CP-manual', title: 'CP-manual', reason: '이전 버전에서 저장되어 사유가 없음', source: 'manual', source_id: null },
  ]);
  expect((await pool.query("select job,fence,artifacts from ci_runs")).rows).toEqual([{ job: null, fence: null, artifacts: [] }]);
});

test('이전 분할 CP의 상태·보류 사유는 바꿀 수 있다', () => transaction(async (client) => {
  await client.query("update change_proposals set status='review' where id=$1", [ids.cp]);
  await client.query("update change_proposals set status='rejected',hold_reasons=$2 where id=$1",
    [ids.cp, { holdReasons: [], issues: [{ index: null, code: 'X', message: 'm' }] }]);
  await client.query("update change_proposals set title='새 제목' where id=$1", [ids.cp]);
  // 원래 Task를 나중에 알게 되면 채울 수 있다. 채운 뒤에는 다시 비울 수 없다.
  await client.query("update change_proposals set source_id='TASK-0001' where id=$1", [ids.cp]);
  await rejects(client, 'update change_proposals set source_id=null where id=$1', [ids.cp], 'cp_split_source');
}));

test('이전 행도 분할 출처 규칙을 새로 어기게 바꿀 수는 없다', () => transaction(async (client) => {
  await rejects(client, "update change_proposals set source='split' where id=$1", [ids.manual], 'cp_split_source');
  await rejects(client, "insert into change_proposals(project_id,cp_key,title,reason,source,status,ops) values($1,'CP-new','t','r','split','draft','[]')", [ids.p], 'cp_split_source');
}));

test('이전 CI 실행의 결과는 저장할 수 있지만 단계는 바꿀 수 없다', () => transaction(async (client) => {
  await client.query("update ci_runs set status='run' where id=$1", [ids.ci]);
  await client.query("update ci_runs set status='pass',artifacts='[\"r.xml\"]',url='https://ci/1' where id=$1", [ids.ci]);
  await rejects(client, 'update ci_runs set stage=2 where id=$1', [ids.ci], 'ci_job_owner');
  await rejects(client, "insert into ci_runs(project_id,run_key,stage,pipeline_sha,ref,trigger,status) values($1,'CI-new',1,'s','main','t','queued')", [ids.p], 'ci_job_owner');
}));

test('job이 있던 새 CI 실행에서 job을 지울 수 없다', () => transaction(async (client) => {
  const job = (await client.query<{ id: string }>(
    "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'integrate','{}','leased',1,'k') returning id", [ids.p])).rows[0]?.id;
  const run = (await client.query<{ id: string }>(
    "insert into ci_runs(project_id,run_key,stage,pipeline_sha,ref,trigger,status,job,fence) values($1,'CI-2',2,'s','main','t','queued',$2,1) returning id", [ids.p, job])).rows[0]?.id;
  await client.query("update ci_runs set status='pass' where id=$1", [run]);
  await rejects(client, 'update ci_runs set job=null,fence=null where id=$1', [run], 'ci_job_owner');
}));
