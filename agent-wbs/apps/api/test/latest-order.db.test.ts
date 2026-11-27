/**
 * M6 통합 fix2 — Codex 리뷰 3차 P2 1~3의 재현을 「고친 뒤 동작」 시험으로 옮겼다(codex-review3-evidence/repro.ts).
 * 공통 원칙: 「최신 하나」는 벽시계(created_at·generated_at) 대신 뒤로 가지 않는 저장 순번(record_no)으로 고른다(M5·M7 원칙, M7-04 결정 7·12).
 * 왜: 이 PC처럼 시계가 뒤로 가면 나중에 저장한 행의 시각이 더 이를 수 있다.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, seedSystem, type PoolClient } from '@awbs/db';
import { asOf, settingsAt } from '../src/reports/state.ts';
import { fingerprint, tokenKey } from '../src/notify/secrets.ts';
import { getTelegram, putTelegram, testOf } from '../src/notify/service.ts';
import { testRecipient } from '../src/mail/queue.ts';

const base = new URL(inject('testDatabaseUrl'));
const url = (suffix: string) => { const u = new URL(base); u.pathname += `_latest_${suffix}`; return u.href; };
const pool = createPool(url('main'), { onError: () => undefined });
const secret = process.env.AWBS_SECRET_KEY;
beforeAll(async () => {
  process.env.AWBS_SECRET_KEY = 'a'.repeat(64);
  await recreateTestDatabase(url('main'));
  await runMigrations(pool);
  await seedSystem(pool);
});
afterAll(async () => {
  await pool.end();
  if (secret === undefined) delete process.env.AWBS_SECRET_KEY; else process.env.AWBS_SECRET_KEY = secret;
});

/** 한 트랜잭션 안에서 실행하고 되돌린다(시험끼리 자료를 섞지 않는다). */
async function rolledBack(fn: (db: PoolClient) => Promise<void>) {
  const db = await pool.connect();
  try { await db.query('begin'); await fn(db); } finally { await db.query('rollback'); db.release(); }
}

test('P2-2 재현: 같은 연결의 성공 뒤 시계가 역행한 실패 테스트가 오면 최신(실패)을 고르고 켜기를 거부한다', async () => {
  await rolledBack(async db => {
    const token = '123456789:' + 'fake_only_'.repeat(4);
    const key = await tokenKey(db, token);
    const fp = fingerprint(key, '-4123456789');
    const payload = { secretKey: key, chatId: '-4123456789', targetName: 'fix2', fingerprint: fp, bot: null };
    await db.query("insert into notify_outbox(id,delivery_id,epoch,state,payload,kind,created_at) values($1,$1,1,'accepted',$2,'test','2026-11-27T10:00:00Z')", ['10000000-0000-4000-8000-000000000001', payload]);
    // 나중에 저장한 실패. 시각은 2초 이르다(시계 역행).
    await db.query("insert into notify_outbox(id,delivery_id,epoch,state,payload,kind,created_at,error) values($1,$1,1,'failed',$2,'test','2026-11-27T09:59:58Z','forbidden:denied')", ['20000000-0000-4000-8000-000000000002', payload]);
    expect((await testOf(db, fp))?.state).toBe('failed');
    const before = await getTelegram(db);
    await expect(putTelegram(db, { enabled: true, botToken: token, chatId: '-4123456789', targetName: 'fix2', updatedAt: before.updatedAt })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

test('P2-3 재현: 시계 역행 뒤 만든 보고서가 있으면 메일 테스트 발송은 그 새 보고서를 고른다', async () => {
  await rolledBack(async db => {
    const project = (await db.query<{ id: string }>("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('fix2','','','','','active') returning id")).rows[0]?.id;
    const recipient = (await db.query<{ id: string }>("insert into mail_recipients(name,email,view,pdf,active,daily,weekly) values('fix2','fix2@example.com','int',false,true,true,true) returning id")).rows[0]?.id ?? '';
    const snapshot = { done: [], summary: { forecast: null } };
    await db.query(`insert into reports(project_id,report_key,kind,"from","to",snapshot,generated_at,reason) values($1,'RPT-C-0001','custom','2026-11-26','2026-11-26',$2,'2026-11-27T10:00:00Z','test')`, [project, snapshot]);
    const newer = (await db.query<{ id: string }>(`insert into reports(project_id,report_key,kind,"from","to",snapshot,generated_at,reason) values($1,'RPT-C-0002','custom','2026-11-27','2026-11-27',$2,'2026-11-27T09:59:58Z','test') returning id`, [project, snapshot])).rows[0]?.id;
    const queued = await testRecipient(db, recipient);
    expect((await db.query('select report from mail_outbox where id=$1', [queued.ids[0]])).rows[0]?.report).toBe(newer);
  });
});

test('P2-1 재현: M6 통합 1차 번호 DB의 이력에도 순번이 채워져, 보고서가 최신 PC 사양으로 한도를 계산한다', async () => {
  const old = createPool(url('old'), { onError: () => undefined });
  const folder = await mkdtemp(join(tmpdir(), 'awbs-latest-old-'));
  try {
    await recreateTestDatabase(url('old'));
    // M6 통합 1차 DB(8ff0cee): 0025까지 + M6 마이그레이션을 1차 번호(0036~0043)로. SQL 내용은 지금 0028~0035와 바이트 단위로 같다.
    const source = fileURLToPath(new URL('../../../packages/db/migrations/', import.meta.url));
    await cp(source, folder, { recursive: true });
    interface Entry { idx: number; tag: string; when: number; version: string; breakpoints: boolean }
    const journal = JSON.parse(await readFile(join(source, 'meta/_journal.json'), 'utf8')) as { entries: Entry[] };
    const entries = journal.entries.filter(e => e.idx <= 25);
    for (const e of journal.entries.filter(x => x.idx >= 28 && x.idx <= 35)) {
      const tag = String(e.idx + 8).padStart(4, '0') + e.tag.slice(4);
      await writeFile(join(folder, `${tag}.sql`), await readFile(join(source, `${e.tag}.sql`), 'utf8'));
      entries.push({ ...e, idx: entries.length, tag, when: 1795740000000 + e.idx + 8 });
    }
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    await runMigrations(old, folder); // 빈 DB라 보충 없이 그 폴더의 목록 그대로 적용된다
    await old.query("insert into runner_hosts(id,host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at,created_at) values('10000000-0000-4000-8000-000000000001','old-host','boot1','old',4,16,0,100,'Linux',1,clock_timestamp()-interval '10 seconds',clock_timestamp()-interval '10 seconds')");
    await old.query("insert into runner_hosts(id,host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at,created_at) values('20000000-0000-4000-8000-000000000002','new-host','boot2','new',32,128,0,1000,'Linux',1,clock_timestamp(),clock_timestamp())");
    // 이 이력 JSON에는 아직 순번 열이 없다(0026이 뒤에 온다).
    expect((await old.query("select count(*)::int n from global_log where tbl='runner_hosts' and data ? 'record_no'")).rows[0]?.n).toBe(0);
    await runMigrations(old);
    expect((await old.query("select data->>'host_id' host,(data->>'record_no')::int no from global_log where tbl='runner_hosts' order by seq")).rows)
      .toEqual([{ host: 'old-host', no: 1 }, { host: 'new-host', no: 2 }]);
    const anchor = (await old.query<{ at: string }>(`select to_char(awbs_report_anchor() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`)).rows[0]?.at ?? '';
    const a = asOf('00000000-0000-4000-8000-000000000000', anchor, 'log');
    expect((await old.query(`select host_id from ${a.rel('runner_hosts')} h order by record_no desc limit 1`)).rows[0]?.host_id).toBe('new-host');
    const db = await old.connect();
    try {
      const reconstructed = await settingsAt(db, a);
      const current = await settingsAt(db, asOf('00000000-0000-4000-8000-000000000000', anchor, 'live'));
      expect(reconstructed.cap).toEqual(current.cap);
    } finally { db.release(); }
  } finally { await old.end(); await rm(folder, { recursive: true, force: true }); }
}, 120_000);

test('P2-1 채울 수 없는 행: 순번이 생기기 전에 지워진 행의 이력은 0(모든 번호보다 오래됨)으로 채운다', async () => {
  // 지금 표에도, 같은 행의 다른 이력에도 순번이 없는 경우다. 0037의 세 번째 단계가 명시적으로 0을 넣는다.
  const db = await pool.connect();
  try {
    await db.query('begin');
    await db.query("set local session_replication_role='replica'");
    await db.query("insert into global_log(tbl,row_id,op,data) values('agent_usage','30000000-0000-4000-8000-000000000003','insert','{\"agent\":\"Codex\"}')");
    const sql = (await readFile(fileURLToPath(new URL('../../../packages/db/migrations/0037_20261127_record_order.sql', import.meta.url)), 'utf8')).split('--> statement-breakpoint')[0] ?? '';
    await db.query(sql);
    expect((await db.query("select data->'record_no' no from global_log where row_id='30000000-0000-4000-8000-000000000003'")).rows).toEqual([{ no: 0 }]);
  } finally { await db.query('rollback'); db.release(); }
});
