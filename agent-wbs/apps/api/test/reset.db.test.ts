import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, expect, inject, test, vi } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { OPERATIONS } from '@awbs/shared/api';
import { buildApp } from '../src/app.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import { inEpoch } from '../src/platform/transaction.ts';
import { exportProject } from '../src/reset/export.ts';
import { installRunner } from '../src/runner/routes.ts';
import { fillProjectTables } from '../../../packages/db/test/project-fixture.ts';

const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_reset';
const owner = createPool(dbUrl.href, { max: 5, onError: () => undefined });
const appUrl = new URL(dbUrl);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { max: 12, onError: () => undefined });
const origin = 'http://127.0.0.1:3100';
const filesRoot = await mkdtemp(join(tmpdir(), 'awbs-reset-fixture-'));
const app = buildApp(pool, false, { origin, lan: false }, { dataRoot: filesRoot });
installRunner(app, pool);
let cookie = '', csrf = '', bearer = '', project = '', wp = '', task = '', job = '';
let pause: { entered: () => void; resume: Promise<void> } | undefined;
let pauseCommand: { entered: () => void; resume: Promise<void> } | undefined;
app.addHook('preValidation', async (request) => {
  if (request.url === '/api/runner/host' && pause) { pause.entered(); await pause.resume; }
});
app.addHook('preHandler', async (request) => {
  if (request.routeOptions.url === '/api/runner/commands/:id/result' && pauseCommand) {
    const gate = pauseCommand; pauseCommand = undefined; gate.entered(); await gate.resume;
  }
});
const sha = 'a'.repeat(40);
const lead = (method: 'GET' | 'POST', url: string, payload?: object, key?: string) => app.inject({ method, url,
  headers: { cookie, origin, 'x-csrf-token': csrf, ...(key && { 'idempotency-key': key }) }, ...(payload && { payload }) });
const reset = (extra: object = {}, key?: string) => lead('POST', '/api/project/reset', { epoch: 1, confirmName: '초기화 시험', keepSettings: false, ...extra }, key);
const runner = (method: 'GET' | 'POST', path: string, epoch = 1, payload?: object, key: string = randomUUID()) => app.inject({ method, url: `/api/runner/${path}`,
  headers: { authorization: `Bearer ${bearer}`, 'x-project-epoch': String(epoch), 'idempotency-key': key }, ...(payload && { payload }) });
const state = async () => (await owner.query('select epoch,cleanup_status from system_state')).rows;
const shared = createRequire(new URL('../../../packages/shared/package.json', import.meta.url));
const { Ajv } = shared('ajv') as { Ajv: new (options: object) => { validate: (schema: unknown, data: unknown) => boolean; errorsText: () => string } };
const ajv = new Ajv({ strict: false });
function shape(id: string, body: unknown) {
  expect(ajv.validate(OPERATIONS.find((op) => op.id === id)?.responses[200], body), ajv.errorsText()).toBe(true);
}

beforeAll(async () => {
  await recreateTestDatabase(dbUrl.href);
  await runMigrations(owner);
  await seedSystem(owner);
  bearer = await issueRunnerToken(pool, 'reset-runner', 'fake');
  const response = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token: await issueLoginLink(pool) } });
  cookie = String(response.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
});
beforeEach(async () => {
  const tables = (await owner.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public' and tablename not in ('lead_sessions','lead_login_tokens','lead_credentials','runner_tokens')")).rows;
  const c = await owner.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role=replica');
    await c.query(`truncate ${tables.map((t) => c.escapeIdentifier(t.tablename)).join(',')} restart identity cascade`);
    await c.query('commit');
  } finally { c.release(); }
  await seedSystem(owner);
  project = (await owner.query<{ id: string }>("insert into projects(name,repo_url,repo_owner,repo_name,base_commit,lead_instruction,phase) values('초기화 시험','https://github.com/o/r','o','r',$1,'','active') returning id", [sha])).rows[0]?.id ?? '';
  const phase = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,kind,title,sort_order) values($1,'PH-1','phase','단계',1) returning id", [project])).rows[0]?.id;
  wp = (await owner.query<{ id: string }>("insert into wbs_nodes(project_id,node_key,parent_id,kind,title,sort_order) values($1,'WP-1',$2,'work_package','작업 묶음',1) returning id", [project, phase])).rows[0]?.id ?? '';
  task = (await owner.query<{ id: string }>("insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state) values($1,'TASK-1',$2,1,'시험 작업','Test','BE','{}',1,'Codex','Claude','ready','none') returning id", [project, wp])).rows[0]?.id ?? '';
  job = (await owner.query<{ id: string }>("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'attempt','{\"branch\":\"agent/TASK-1\",\"pr\":7}','queued',1,'fixture') returning id", [project])).rows[0]?.id ?? '';
});
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); await rm(filesRoot, { recursive: true, force: true }); });

// 이 테스트들은 경로 누락, 트랜잭션 분리, 권한 우회, 정리 증거 누락을 각각 잡는다.
test('reset-preview는 실제 삭제 건수와 기록된 브랜치만 보여 준다', async () => {
  const response = await lead('GET', '/api/project/reset-preview');
  expect(response.statusCode, response.body).toBe(200);
  shape('previewReset', response.json());
  expect(response.json()).toMatchObject({ epoch: 1, projectName: '초기화 시험', sending: { mail: 0, notify: 0 }, counts: { tasks: 1, running: 0, attempts: 0, inputs: 0 }, runner: { branches: ['agent/TASK-1'], mergedTasks: 0, worktreesEstimated: true } });
});

test('reset은 모든 프로젝트 관계를 삭제하고 명령·감사·파일 큐를 같은 트랜잭션으로 남긴다', async () => {
  const c = await owner.connect();
  let tables: string[];
  try { tables = await fillProjectTables(c, { p: project, task, wp, job }); } finally { c.release(); }
  await owner.query("update mail_outbox set state='sending'");
  await owner.query("update notify_outbox set state='sending'");
  const preview = await lead('GET', '/api/project/reset-preview');
  expect(preview.json()).toMatchObject({ sending: { mail: 1, notify: 1 } });
  const response = await reset({ keepSettings: true });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ epoch: 2 });
  for (const table of tables) expect((await owner.query(`select count(*)::int n from "${table}"`)).rows, table).toEqual([{ n: 0 }]);
  expect(await state()).toEqual([{ epoch: 2, cleanup_status: 'pending' }]);
  expect((await owner.query('select epoch,path from file_delete_queue')).rows).toEqual([{ epoch: 1, path: '1/' }]);
  const commands = await runner('GET', 'commands', 0);
  expect(commands.statusCode, commands.body).toBe(200);
  shape('getCommands', commands.json());
  expect(commands.json()).toMatchObject({ currentEpoch: 2, commands: [{ kind: 'reset-cleanup', epoch: 1, payload: { baseCommit: sha, repoUrl: 'https://github.com/o/r', branches: ['agent/TASK-1'], prs: [1, 7] } }] });
  const claim = await runner('POST', 'jobs/claim', 2, { kinds: ['attempt'], capacity: 1 });
  expect(claim.statusCode).toBe(409);
  expect(claim.json()).toMatchObject({ error: { code: 'CLEANUP_PENDING' } });
});

test('reset 중간 실패는 삭제·명령·epoch·파일 큐를 전부 되돌린다', async () => {
  await owner.query("create function reset_fail_test() returns trigger language plpgsql as $$ begin raise exception '중간 실패'; end $$");
  await owner.query('create trigger reset_fail_test before delete on projects for each row execute function reset_fail_test()');
  try {
    expect((await reset()).statusCode).toBe(500);
    expect(await state()).toEqual([{ epoch: 1, cleanup_status: 'none' }]);
    expect((await owner.query('select count(*)::int n from tasks')).rows).toEqual([{ n: 1 }]);
    for (const table of ['reset_log', 'runner_commands', 'file_delete_queue']) expect((await owner.query(`select count(*)::int n from ${table}`)).rows).toEqual([{ n: 0 }]);
  } finally { await owner.query('drop trigger reset_fail_test on projects'); await owner.query('drop function reset_fail_test()'); }
});

test.each([true, false])('설정 유지=%s: 연결·인증·검토 정의는 보존하고 사용자 설정은 선택대로 처리한다', async (keepSettings) => {
  await owner.query("update app_settings set heartbeat_seconds=91");
  await owner.query("insert into secrets(key,ciphertext,nonce,key_version,last4) values('github-secret','github-value','nonce',1,'lue'),('smtp-secret','smtp-value','nonce',1,'lue')");
  await owner.query("insert into github_settings(mode,status,scopes,secret_key) values('token','ok',null,'github-secret')");
  await owner.query("insert into mail_settings(host,secret_key) values('smtp.example.test','smtp-secret')");
  await owner.query("insert into mail_recipients(email,name,active,daily,weekly,pdf,view) values('person@example.test','팀장',true,true,false,true,'int')");
  await owner.query("insert into runner_hosts(host_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at) values('old-host','cpu',4,16,0,100,'Linux',0,now())");
  await owner.query("insert into external_write_authority(host_id,generation,state) values('old-host',9,'blocked')");
  await owner.query("insert into subagent_defs(def_key,version,agent,role,tools,sandbox,text,hash,is_demo) values('reviewed',1,'Codex','qa','{}','read-only','검토 완료','h',false),('demo',1,'Codex','qa','{}','read-only','예시','d',true)");
  expect((await reset({ keepSettings })).statusCode).toBe(200);
  expect((await owner.query('select heartbeat_seconds from app_settings')).rows).toEqual([{ heartbeat_seconds: keepSettings ? 91 : 60 }]);
  expect((await owner.query('select cp_auto,auto_replan from schedule_policy')).rows).toEqual([{ cp_auto: true, auto_replan: null }]);
  expect((await owner.query('select generation,state from external_write_authority')).rows).toEqual([{ generation: 9, state: 'blocked' }]);
  for (const table of ['github_settings', 'runner_tokens', 'lead_sessions']) expect((await owner.query(`select count(*)::int n from ${table}`)).rows[0]?.n, table).toBeGreaterThan(0);
  for (const table of ['mail_recipients', 'runner_hosts']) expect((await owner.query(`select count(*)::int n from ${table}`)).rows).toEqual([{ n: keepSettings ? 1 : 0 }]);
  expect((await owner.query("select key from secrets order by key")).rows).toEqual(keepSettings ? [{ key: 'github-secret' }, { key: 'smtp-secret' }] : [{ key: 'github-secret' }]);
  // system seed의 실제 하위 Agent v1(M5-06)은 따로 남는다. 여기서는 이 시험이 넣은 두 정의만 본다.
  expect((await owner.query("select def_key from subagent_defs where def_key in ('demo','reviewed') order by def_key")).rows).toEqual(keepSettings ? [{ def_key: 'demo' }, { def_key: 'reviewed' }] : [{ def_key: 'reviewed' }]);
});

test('이름 불일치·낡은 화면·Runner의 초기화는 데이터를 지우지 못한다', async () => {
  expect((await reset({ confirmName: '다른 이름' })).statusCode).toBe(400);
  expect((await reset({ epoch: 0 })).statusCode).toBe(409);
  const forbidden = await app.inject({ method: 'POST', url: '/api/project/reset', headers: { authorization: `Bearer ${bearer}`, 'x-project-epoch': '1' }, payload: { epoch: 1, confirmName: '초기화 시험', keepSettings: false } });
  expect(forbidden.statusCode).toBe(403);
  expect(await state()).toEqual([{ epoch: 1, cleanup_status: 'none' }]);
});

test('같은 초기화 키를 재전송하면 삭제 뒤에도 처음 응답을 재생한다', async () => {
  const key = randomUUID();
  const first = await reset({}, key);
  expect(first.statusCode).toBe(200);
  const second = await reset({}, key);
  expect(second.body).toBe(first.body);
  expect(second.headers['idempotency-replayed']).toBe('true');
  expect((await owner.query('select count(*)::int n from reset_log')).rows).toEqual([{ n: 1 }]);
});

test('외부 쓰기가 blocked면 원격 정리 명령을 보내지 않고 원장에 보관하여 복구 뒤 보낸다', async () => {
  await owner.query("insert into external_write_authority(host_id,generation,state) values('host',4,'blocked')");
  expect((await reset()).statusCode).toBe(200);
  const blocked = await runner('GET', 'commands');
  expect(blocked.json()).toEqual({ currentEpoch: 2, commands: [] });
  expect(await state()).toEqual([{ epoch: 2, cleanup_status: 'pending' }]);
  expect((await lead('GET', '/api/system/resets')).json()).toMatchObject({ items: [{ cleanupWaitReason: 'external_write_blocked' }] });
  await owner.query("update external_write_authority set state='granted',generation=5,reconciled_at=clock_timestamp()");
  expect((await lead('GET', '/api/system/resets')).json()).toMatchObject({ items: [{ cleanupWaitReason: 'runner' }] });
  expect((await runner('GET', 'commands')).json()).toMatchObject({ commands: [{ payload: { generation: 4, baseCommit: sha } }] });
});

test('명령 epoch와 정리 증거를 검사하고 실패 재시도·수동 대조 경고·완료 기록을 한 번 반영한다', async () => {
  await owner.query("insert into execution_holds(project_id,job,epoch,agent,slots,heavy,slot_state,lock_state,host_id,boot_id,fence) values($1,$2,1,'Codex',1,false,'reserved','none','host','boot',1)", [project, job]);
  await owner.query("update execution_holds set slot_state='active',pgid=4242 where job=$1", [job]);
  expect((await reset()).statusCode).toBe(200);
  const command = (await owner.query<{ id: string }>('select id from runner_commands')).rows[0];
  assert(command);
  const result = (epoch: number, payload: object, key?: string) => runner('POST', `commands/${command.id}/result`, epoch, payload, key);
  expect((await result(2, { status: 'done', items: [], holds: [] })).statusCode).toBe(409);
  expect((await result(1, { status: 'done', items: [], holds: [] })).statusCode).toBe(400);
  expect((await result(1, { status: 'failed', items: [{ name: 'hold', ok: false, detail: '아직 실행 중' }] })).statusCode).toBe(204);
  expect(await state()).toEqual([{ epoch: 2, cleanup_status: 'failed' }]);
  const key = randomUUID();
  const payload = { status: 'done', items: [{ name: 'warn:manual-reconcile', ok: false, detail: '수동 대조 필요: PR 참조 1건' }], holds: [{ job, hostId: 'host', bootId: 'boot', proof: 'group_empty', processGroup: 4242 }] };
  expect((await result(1, payload, key)).statusCode).toBe(204);
  expect((await result(1, payload, key)).statusCode).toBe(204);
  expect((await result(1, payload)).statusCode).toBe(204);
  expect(await state()).toEqual([{ epoch: 2, cleanup_status: 'none' }]);
  expect((await owner.query('select attempts,status from runner_commands')).rows).toEqual([{ attempts: 2, status: 'done' }]);
  expect((await owner.query('select severity,target from alerts')).rows).toEqual([{ severity: 'warn', target: expect.objectContaining({ commandId: command.id, message: '수동 대조 필요: PR 참조 1건' }) }]);
  const history = await lead('GET', '/api/system/resets');
  expect(history.statusCode, history.body).toBe(200);
  shape('listResets', history.json());
  expect(history.json()).toMatchObject({ items: [{ epoch: 2, runnerCleanupStatus: 'done', deletedTaskCount: 1, keepSettings: false, finishedAt: expect.any(String) }] });
});

test('조정자 결정 3(0041): cgroup이 기록된 보유의 정리 증거는 같은 경로·그룹의 cgroup_empty만 받는다', async () => {
  const cgroup = '/user.slice/user-1000.slice/user@1000.service/app.slice/awbs-0b6f3c2e-6a1d-4f7e-8a9b-0123456789ab.scope';
  await owner.query("insert into execution_holds(project_id,job,epoch,agent,slots,heavy,slot_state,lock_state,host_id,boot_id,fence) values($1,$2,1,'Codex',1,false,'reserved','none','host','boot',1)", [project, job]);
  await owner.query("update execution_holds set slot_state='active',pgid=4242,cgroup=$2 where job=$1", [job, cgroup]);
  expect((await reset()).statusCode).toBe(200);
  const command = (await owner.query<{ id: string }>('select id from runner_commands')).rows[0];
  assert(command);
  const done = (proof: object) => runner('POST', `commands/${command.id}/result`, 1, { status: 'done', items: [], holds: [{ job, hostId: 'host', bootId: 'boot', ...proof }] });
  expect((await done({ proof: 'group_empty', processGroup: 4242 })).statusCode).not.toBe(204);
  expect((await done({ proof: 'cgroup_empty', processGroup: 4242, cgroup: cgroup.replace('0b6f', '1b6f') })).statusCode).not.toBe(204);
  expect((await done({ proof: 'cgroup_empty', processGroup: 4243, cgroup })).statusCode).not.toBe(204);
  expect((await owner.query('select status from runner_commands')).rows).toEqual([{ status: 'pending' }]);
  expect((await done({ proof: 'cgroup_empty', processGroup: 4242, cgroup })).statusCode).toBe(204);
  expect((await owner.query('select status from runner_commands')).rows).toEqual([{ status: 'done' }]);
});

test('middleware 통과 후 멈춘 host 보고는 초기화 뒤 환경 행을 되살리지 못한다', async () => {
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>();
  pause = { entered: () => entered.resolve(undefined), resume: resume.promise };
  const pending = runner('POST', 'host', 1, { hostId: 'late', bootId: 'boot', cpu: 'cpu', cores: 4, memGB: 16, swapGB: 0, diskFreeGB: 100, os: 'Linux' });
  try { await entered.promise; expect((await reset()).statusCode).toBe(200); } finally { pause = undefined; resume.resolve(undefined); }
  const response = await pending;
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ error: { code: 'EPOCH_MISMATCH' } });
  expect((await owner.query('select count(*)::int n from runner_hosts')).rows).toEqual([{ n: 0 }]);
});

test('worker의 epoch 잠금은 초기화와 직렬화되고 낡은 결과 반영을 차단한다', async () => {
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>();
  const pending = inEpoch(pool, 1, async (client) => { entered.resolve(undefined); await resume.promise; await client.query("update app_settings set heartbeat_seconds=77"); });
  await entered.promise;
  const c = await owner.connect();
  try {
    await c.query('begin'); await c.query("set local lock_timeout='50ms'");
    await expect(c.query('select reset_project(1,$1,false,$2)', ['초기화 시험', 'lead'])).rejects.toMatchObject({ code: '55P03' });
  } finally { await c.query('rollback'); c.release(); resume.resolve(undefined); await pending; }
  expect((await reset()).statusCode).toBe(200);
  await expect(inEpoch(pool, 1, async (client) => client.query("update app_settings set heartbeat_seconds=99"))).rejects.toMatchObject({ code: 'AW001' });
  expect((await owner.query('select heartbeat_seconds from app_settings')).rows).toEqual([{ heartbeat_seconds: 60 }]);
});

async function exportFiles() {
  const c = await owner.connect();
  try { await fillProjectTables(c, { p: project, task, wp, job }); } finally { c.release(); }
  await mkdir(join(filesRoot, '1/evidence'), { recursive: true });
  await mkdir(join(filesRoot, '1/pdf'), { recursive: true });
  await writeFile(join(filesRoot, '1/evidence/proof.bin'), Buffer.from([0, 1, 255]));
  await writeFile(join(filesRoot, '1/pdf/report.pdf'), '%PDF-1.7 시험');
  await fixtureUpdate("update evidence set storage_path='1/evidence/proof.bin',size=3,sha256=$1", [createHash('sha256').update(Buffer.from([0, 1, 255])).digest('hex')]);
  await owner.query("update report_pdfs set path='1/pdf/report.pdf',sha256=$1", [createHash('sha256').update('%PDF-1.7 시험').digest('hex')]);
}

async function fixtureUpdate(sql: string, values: unknown[] = []) {
  const c = await owner.connect();
  try {
    await c.query('begin'); await c.query('set local session_replication_role=replica');
    await c.query(sql, values); await c.query('commit');
  } catch (error) { await c.query('rollback'); throw error; } finally { c.release(); }
}

test('export zip은 JSON·PDF·Evidence를 포함하고 인증·비밀·수신자를 제외한다', async () => {
  await exportFiles();
  await owner.query("insert into secrets(key,ciphertext,nonce,key_version,last4) values('smtp','절대노출금지','n',1,'금지')");
  await owner.query("insert into mail_recipients(email,name,active,daily,weekly,pdf,view) values('private@example.test','수신자',true,true,false,true,'int')");
  await fixtureUpdate("update reports set snapshot='{\"title\":\"보고서\",\"password\":\"절대노출금지\",\"recipients\":[\"private@example.test\"]}'");
  const response = await lead('GET', '/api/project/export');
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['content-type']).toBe('application/zip');
  expect(response.headers['content-disposition']).toMatch(/^attachment;/);
  const decoded = spawnSync('python3', ['-c', 'import sys,zipfile,io,json,base64; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in z.namelist()}))'], { input: response.rawPayload, encoding: 'utf8' });
  expect(decoded.status, decoded.stderr).toBe(0);
  const entries = JSON.parse(decoded.stdout) as Record<string, string>;
  expect(Object.keys(entries)).toEqual(['data.json', 'manifest.json', '1/evidence/proof.bin', '1/pdf/report.pdf']);
  expect(JSON.parse(Buffer.from(entries['manifest.json'] ?? '', 'base64').toString())).toMatchObject({ schemaVersion: 1, epoch: 1, files: [{ path: '1/evidence/proof.bin', kind: 'evidence', size: 3 }, { path: '1/pdf/report.pdf', kind: 'pdf' }] });
  expect(Buffer.from(entries['1/evidence/proof.bin'] ?? '', 'base64')).toEqual(Buffer.from([0, 1, 255]));
  expect(Buffer.from(entries['1/pdf/report.pdf'] ?? '', 'base64').toString()).toBe('%PDF-1.7 시험');
  const data = Buffer.from(entries['data.json'] ?? '', 'base64').toString();
  expect(JSON.parse(data)).toMatchObject({ epoch: 1, tables: { projects: [{ name: '초기화 시험', created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }], tasks: expect.any(Array) } });
  expect(data).not.toMatch(/절대노출금지|private@example|lead_sessions|runner_tokens|ciphertext|recipients/);
});

test.each(['../outside', '2/evidence/other', '1/evidence/link'])('export는 세대 경로 이탈·심볼릭 링크 %s를 거부한다', async (path) => {
  await exportFiles();
  await writeFile(join(filesRoot, 'outside'), '노출하면 안 되는 파일');
  await rm(join(filesRoot, '1/evidence/link'), { force: true });
  await symlink(join(filesRoot, 'outside'), join(filesRoot, '1/evidence/link'));
  await fixtureUpdate('update evidence set storage_path=$1', [path]);
  const response = await lead('GET', '/api/project/export');
  expect(response.statusCode).toBe(503);
  expect(response.body).not.toContain('노출하면 안 되는 파일');
});

test('export 실패는 이유를 알려 준다: 없는 파일·무결성 불일치 목록, 전체 크기 상한(M2-04 리뷰 P3-2)', async () => {
  await exportFiles();
  await rm(join(filesRoot, '1/pdf/report.pdf'));
  const missing = await lead('GET', '/api/project/export');
  expect(missing.statusCode).toBe(503);
  expect(missing.json()).toMatchObject({ error: { code: 'UNAVAILABLE', details: { reason: 'files_unreadable', failedCount: 1, failures: [{ path: '1/pdf/report.pdf', reason: 'missing' }] } } });
  await writeFile(join(filesRoot, '1/pdf/report.pdf'), '%PDF-1.7 시험');
  await writeFile(join(filesRoot, '1/evidence/proof.bin'), Buffer.from([9, 9, 9]));
  expect((await lead('GET', '/api/project/export')).json()).toMatchObject({ error: { details: { reason: 'files_unreadable', failures: [{ path: '1/evidence/proof.bin', reason: 'integrity' }] } } });
  await writeFile(join(filesRoot, '1/evidence/proof.bin'), Buffer.from([0, 1, 255]));
  // data.json과 크기를 아는 Evidence의 합이 상한을 넘으면 파일을 읽기 전에 거절한다(교차 리뷰 F4: 표 데이터도 합계에 넣음).
  const tooLarge = await exportProject(pool, 1, filesRoot, 2).then(() => undefined, (error: unknown) => error as { code: string; details: { reason: string; totalBytes: number; limitBytes: number } });
  expect(tooLarge).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'export_too_large', limitBytes: 2 } });
  expect(tooLarge?.details.totalBytes).toBeGreaterThan(3);
  expect((await lead('GET', '/api/project/export')).statusCode).toBe(200);
});

test('미해결 수동 대조 경고는 다음 초기화 뒤에도 남고, 처리한 경고는 지운다(M2-04 리뷰 P3-7)', async () => {
  await owner.query(`insert into alerts(key,severity,target) values('reset:open:manual-reconcile','warn','{"message":"PR 참조 대조 필요"}'),
    ('reset:done:manual-reconcile','warn','{"message":"처리함"}'),('other','warn','{}')`);
  await owner.query("update alerts set resolved_at=now() where key='reset:done:manual-reconcile'");
  expect((await reset()).statusCode).toBe(200);
  expect((await owner.query('select key,target from alerts order by key')).rows).toEqual([{ key: 'reset:open:manual-reconcile', target: { message: 'PR 참조 대조 필요' } }]);
});

test('파일 삭제 큐는 실패를 보관하고 재시도하며 뒤늦게 생긴 옛 세대 파일도 다시 지운다', async () => {
  const { deleteFiles } = await import('../src/reset/files.ts');
  await mkdir(join(filesRoot, '1/evidence'), { recursive: true });
  await writeFile(join(filesRoot, '1/evidence/old'), '옛 세대');
  expect((await reset()).statusCode).toBe(200);
  await owner.query("update file_delete_queue set path='../outside'");
  await writeFile(join(filesRoot, 'outside'), '보존');
  await deleteFiles(pool, 2, filesRoot);
  expect((await owner.query('select attempts,last_error from file_delete_queue where path=$1', ['../outside'])).rows).toEqual([{ attempts: 1, last_error: expect.any(String) }]);
  expect(await readFile(join(filesRoot, 'outside'), 'utf8')).toBe('보존');
  await owner.query("update file_delete_queue set path='1/' where path='../outside'");
  await mkdir(join(filesRoot, '2'), { recursive: true });
  await writeFile(join(filesRoot, '2/current'), '새 세대');
  await deleteFiles(pool, 2, filesRoot);
  await expect(readFile(join(filesRoot, '1/evidence/old'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await owner.query('select count(*)::int n from file_delete_queue')).rows).toEqual([{ n: 0 }]);
  await mkdir(join(filesRoot, '1'), { recursive: true });
  await writeFile(join(filesRoot, '1/late'), '만료된 worker가 늦게 기록');
  await deleteFiles(pool, 2, filesRoot);
  await expect(readFile(join(filesRoot, '1/late'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(filesRoot, '2/current'), 'utf8')).toBe('새 세대');
  await expect(deleteFiles(pool, 1, filesRoot)).rejects.toMatchObject({ code: 'AW001' });
});

test('없는 명령의 불투명 ID는 DB 형식 오류 대신 404로 답한다', async () => {
  const response = await runner('POST', 'commands/not-a-uuid/result', 1, { status: 'done', items: [], holds: [] });
  expect(response.statusCode).toBe(404);
});

test('초기화 잠금을 기다리던 export는 스냅샷 충돌도 세대 불일치로 답한다', async () => {
  const c = await owner.connect();
  await c.query('begin'); await c.query('select public.lock_epoch_exclusive()');
  const pending = lead('GET', '/api/project/export');
  try {
    await vi.waitFor(async () => {
      const waiting = (await owner.query<{ n: number }>("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query='select public.lock_epoch($1)'")).rows[0]?.n;
      expect(waiting).toBeGreaterThan(0);
    }, { timeout: 10_000 });
    await c.query("select reset_project(1,'초기화 시험',false,'lead')");
    await c.query('commit');
  } finally { await c.query('rollback'); c.release(); }
  const response = await pending;
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json()).toMatchObject({ error: { code: 'EPOCH_MISMATCH', details: { currentEpoch: 2 } } });
});

test('정리 결과 동시 보고는 처음부터 배타 잠금을 잡아 잠금 승격 교착을 막는다', async () => {
  expect((await reset()).statusCode).toBe(200);
  const id = (await owner.query<{ id: string }>('select id from runner_commands')).rows[0]?.id;
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>();
  pauseCommand = { entered: () => entered.resolve(undefined), resume: resume.promise };
  const payload = { status: 'done', items: [], holds: [] };
  const first = runner('POST', `commands/${String(id)}/result`, 1, payload);
  await entered.promise;
  const second = runner('POST', `commands/${String(id)}/result`, 1, payload);
  const c = await owner.connect();
  try {
    await c.query('begin');
    await expect(c.query('select epoch from system_state where id=1 for share nowait')).rejects.toMatchObject({ code: '55P03' });
  } finally { await c.query('rollback'); c.release(); resume.resolve(undefined); }
  const responses = await Promise.all([first, second]);
  expect(responses.map((response) => response.statusCode)).toEqual([204, 204]);
});
