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

test('fix3(리뷰 4차 P2 재현): 0037 전에 한 트랜잭션으로 함께 만든 정기 보고서는 업그레이드 뒤에도 기간 끝이 늦은 보고서가 최신이다', async () => {
  const old = createPool(url('reports'), { onError: () => undefined });
  const folder = await mkdtemp(join(tmpdir(), 'awbs-latest-reports-'));
  try {
    await recreateTestDatabase(url('reports'));
    // 0036까지만 적용한 DB(0037 전).
    const source = fileURLToPath(new URL('../../../packages/db/migrations/', import.meta.url));
    await cp(source, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(source, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number }[] };
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.filter(e => e.idx <= 36) }));
    await runMigrations(old, folder);
    await seedSystem(old);
    const project = (await old.query<{ id: string }>("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('fix3','','','','','active') returning id")).rows[0]?.id;
    const recipient = (await old.query<{ id: string }>("insert into mail_recipients(name,email,view,pdf,active,daily,weekly) values('fix3','fix3@example.com','int',false,true,true,true) returning id")).rows[0]?.id ?? '';
    const snapshot = { done: [], summary: { forecast: null } };
    // 서버가 꺼진 동안의 일간 보고서 보충처럼 한 트랜잭션에서 같은 생성 시각으로 만든다. id는 기간 끝과 반대 순서로 준다.
    const db = await old.connect();
    try {
      await db.query('begin');
      for (const [id, key, day] of [['ffffffff-0000-4000-8000-000000000001', 'RPT-D-261125', '2026-11-25'], ['10000000-0000-4000-8000-000000000002', 'RPT-D-261126', '2026-11-26']] as const) {
        await db.query(`insert into reports(id,project_id,report_key,kind,"from","to",snapshot,generated_at,reason) values($1,$2,$3,'daily',$4,$4,$5,'2026-11-27T10:00:00Z','test')`, [id, project, key, day, snapshot]);
      }
      await db.query('commit');
    } finally { db.release(); }
    await runMigrations(old);
    expect((await old.query('select report_key from reports order by record_no')).rows).toEqual([{ report_key: 'RPT-D-261125' }, { report_key: 'RPT-D-261126' }]);
    const client = await old.connect();
    try {
      await client.query('begin');
      const queued = await testRecipient(client, recipient);
      expect((await client.query('select r.report_key from mail_outbox m join reports r on r.id=m.report where m.id=$1', [queued.ids[0]])).rows).toEqual([{ report_key: 'RPT-D-261126' }]);
      await client.query('rollback');
    } finally { client.release(); }
  } finally { await old.end(); await rm(folder, { recursive: true, force: true }); }
}, 120_000);

test('M8 선행(0046): 0041 DB의 기존 검증은 업그레이드 뒤 시도 순서대로 순번을 받고, 새 검증은 그 뒤 번호를 받는다', async () => {
  const old = createPool(url('verif'), { onError: () => undefined });
  const folder = await mkdtemp(join(tmpdir(), 'awbs-latest-verif-'));
  try {
    await recreateTestDatabase(url('verif'));
    // 0041까지만 적용한 DB(0046 전).
    const source = fileURLToPath(new URL('../../../packages/db/migrations/', import.meta.url));
    await cp(source, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(source, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.filter(e => Number(e.tag.slice(0, 4)) <= 41) }));
    await runMigrations(old, folder);
    await seedSystem(old);
    const sha = 'a'.repeat(40);
    const one = async <T>(sql: string, args: unknown[]) => (await old.query<{ id: T }>(sql, args)).rows[0]?.id as T;
    const project = await one<string>("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('0046','','','','','active') returning id", []);
    const input = await one<string>("insert into input_versions(project_id,v,commit_sha,files,md_list,changes,instruction) values($1,1,$2,'[]','[]','[]','') returning id", [project, sha]);
    const phase = await one<string>("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH','phase','단계',1) returning id", [project]);
    const wp = await one<string>("insert into wbs_nodes(project_id,node_key,kind,parent_id,title,sort_order) values($1,'WP','work_package',$2,'묶음',1) returning id", [project, phase]);
    const task = await one<string>(`insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state,src_input_version)
      values($1,'TASK-0001',$2,1,'순번','Implementation','BE','{}',1,'Codex','Codex','rework','none',$3) returning id`, [project, wp, input]);
    // 시도 1(QA)·시도 2(재검증)와 각 검증. 나중 검증의 시각이 2.3초 이르고(시계 역행), id(UUID)도 거꾸로 준다.
    for (const [no, kind, vid, at] of [[1, 'qa', 'ffffffff-0000-4000-8000-000000000001', '2026-11-27T10:00:02.300Z'], [2, 'reverify', '10000000-0000-4000-8000-000000000002', '2026-11-27T10:00:00.000Z']] as const) {
      const job = await one<string>("insert into runner_jobs(project_id,epoch,kind,payload,dedup_key,state,fence,generation) values($1,1,'attempt',$2,$3,'done',1,1) returning id",
        [project, { taskKey: 'TASK-0001', kind, agent: 'Codex', baseCommit: sha, branch: 'agent/TASK-0001-h1' }, `0046-${String(no)}`]);
      const attempt = await one<string>(`insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,input_version,kind,agent,status,started_at,ended_at,model_id,effort,branch,generation)
        values($1,$2,$3,$4,$5,$6,$6,1,$7,$8,'Codex','completed',$9,$9,'gpt-6.1-sol','high','agent/TASK-0001-h1',1) returning id`, [project, task, `ATT-0001-${String(no)}`, no, job, sha, input, kind, at]);
      await old.query("insert into verifications(id,project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual,created_at) values($1,$2,$3,'FAIL',$4,1,'t','e','a',$5)", [vid, project, attempt, sha, at]);
    }
    await runMigrations(old);
    expect((await old.query('select a.attempt_no no,v.record_no::int seq from verifications v join task_attempts a on a.id=v.attempt order by v.record_no')).rows)
      .toEqual([{ no: 1, seq: 1 }, { no: 2, seq: 2 }]);
    // 업그레이드 뒤 새 검증은 기존 번호 다음 번호를 받는다(번호 겹침 없음). 앱 역할도 순번을 쓸 수 있다.
    expect((await old.query("select nextval('verifications_record_no_seq')::int n")).rows[0]?.n).toBe(3);
    expect((await old.query("select has_sequence_privilege('awbs_app','verifications_record_no_seq','USAGE') ok")).rows[0]?.ok).toBe(true);
  } finally { await old.end(); await rm(folder, { recursive: true, force: true }); }
}, 120_000);
