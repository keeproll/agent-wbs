import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, recreateTestDatabase, runMigrations, seedDemo } from '@awbs/db';
import { afterAll, beforeAll, expect, inject, test, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loggerOptions } from '../src/log.ts';
import { issueLoginLink, issueRunnerToken, setPassword } from '../src/platform/credentials.ts';
import { ApiError } from '../src/changes/http.ts';
import { ProjectError } from '../src/project/errors.ts';
import { TaskError } from '../src/tasks/errors.ts';
import { tokenKey, readToken } from '../src/notify/secrets.ts';
import { readSmtpPassword } from '../src/mail/secret.ts';
import { inEpoch } from '../src/platform/transaction.ts';
import { exportProject } from '../src/reset/export.ts';
import { installRunner } from '../src/runner/routes.ts';
import { registerRunnerMessageRoutes } from '../src/messages/routes.ts';
import { bindCollect } from '../../../../agent-runner/src/jobs/collect.ts';
import { State } from '../../../../agent-runner/src/state/state.ts';
import { Outbox } from '../../../../agent-runner/src/api/outbox.ts';
import { createApiClient } from '../../../../agent-runner/src/api/client.ts';
import { Secret } from '../../../../agent-runner/src/security/secret.ts';

const db = new URL(inject('testDatabaseUrl'));
db.pathname += '_secrets';
const owner = createPool(db.href, { onError: () => undefined });
const appUrl = new URL(db);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { onError: () => undefined });
const origin = 'http://127.0.0.1:3100';
const github = `github_pat_${'m803canary'.repeat(5)}`;
const smtp = 'm803-smtp-password-한글';
const telegram = `123456789:${'m803canary'.repeat(4)}`;
const password = 'm803 lead login password';
let logs = '', cookie = '', csrf = '', runner = '', link = '';
const root = await mkdtemp(join(tmpdir(), 'awbs-m803-export-'));
const app = buildApp(pool, loggerOptions('info', { write: (line: string) => { logs += line; } }), { origin, lan: false }, { dataRoot: root });
installRunner(app, pool);
registerRunnerMessageRoutes(app);
app.addHook('preHandler', async request => {
  if (!request.headers['x-secret-error']) return;
  const details = { password: smtp, nested: { token: github } };
  const errors = [{ path: github, rule: 'format', message: `Bearer ${github}` }];
  if (request.routeOptions.url === '/api/project') throw new ProjectError('VALIDATION_FAILED', { details, errors, message: `Bearer ${github}`, fix: `Bearer ${github}` });
  if (request.routeOptions.url === '/api/tasks/:taskKey') throw new TaskError('VALIDATION_FAILED', details, errors);
  throw new ApiError('VALIDATION_FAILED', details, errors, `Bearer ${github}`, `Bearer ${github}`);
});

beforeAll(async () => {
  vi.stubEnv('AWBS_SECRET_KEY', '83'.repeat(32));
  await recreateTestDatabase(db.href);
  await runMigrations(owner);
  await seedDemo(owner, db.href);
  await setPassword(pool, password);
  runner = await issueRunnerToken(pool, 'm803-runner', 'fake-public-key');
  link = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token: link } });
  expect(login.statusCode).toBe(204);
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
});

const canary = `github_pat_${'reviewcanary'.repeat(4)}`;
const runnerHeaders = () => ({ authorization: `Bearer ${runner}`, 'x-project-epoch': '1', 'idempotency-key': randomUUID() });
async function runningAttempt(taskKey: string) {
  const task = (await owner.query<{ id: string; project_id: string }>('select id,project_id from tasks where task_key=$1', [taskKey])).rows[0];
  assert(task);
  const input = (await owner.query<{ id: string }>('select id from input_versions where project_id=$1 and v=1', [task.project_id])).rows[0];
  assert(input);
  const head = 'a'.repeat(40), branch = `agent/${taskKey}-h1`;
  await owner.query("update tasks set status='running' where id=$1", [task.id]);
  const job = (await owner.query<{ id: string }>(`insert into runner_jobs(project_id,epoch,kind,payload,dedup_key,state,lease_owner,lease_until,fence,generation)
    values($1,1,'attempt',$2,$3,'started','runner:m803-runner',now()+interval '5 minutes',1,1) returning id`,
  [task.project_id, { taskKey, kind: 'dev', agent: 'Codex', baseCommit: head, branch }, randomUUID()])).rows[0];
  assert(job);
  const attempt = (await owner.query<{ id: string }>(`insert into task_attempts(project_id,task,attempt_key,attempt_no,job,base_sha,head_sha,spec_revision,input_version,kind,agent,status,started_at,model_id,effort,branch,generation)
    values($1,$2,$3,1,$4,$5,$5,1,$6,'dev','Codex','running',now(),'codex-large','high',$7,1) returning id`,
  [task.project_id, task.id, `${taskKey}-A1`, job.id, head, input.id, branch])).rows[0];
  assert(attempt);
  await owner.query(`insert into execution_holds(project_id,job,attempt,epoch,host_id,boot_id,fence,task,agent,slots,heavy,slot_state,lock_state)
    values($1,$2,$3,1,'host-secrets','boot-secrets',1,$4,'Codex',1,false,'reserved','held')`, [task.project_id, job.id, attempt.id, task.id]);
  await owner.query("update execution_holds set slot_state='none',release_proof='no_process' where job=$1", [job.id]);
  await owner.query(`insert into ci_runs(project_id,run_key,stage,pipeline_sha,head_sha,ref,task,attempt,trigger,status,job,fence)
    values($1,$2,1,$3,$3,$4,$5,$6,'task','pass',$7,1)`, [task.project_id, randomUUID(), head, branch, task.id, attempt.id, job.id]);
  return { task, job, attempt, head, branch };
}

test('Runner 원문 summary는 공통 입구에서 가려 DB·시도 조회에 저장한다', async () => {
  const f = await runningAttempt('TASK-0009');
  const response = await app.inject({ method: 'POST', url: `/api/runner/attempts/${f.attempt.id}/result`, headers: runnerHeaders(),
    payload: { fence: 1, summary: `완료 ${canary}`, changedFiles: [], evidence: [] } });
  expect(response.statusCode, response.body).toBe(201);
  const stored = (await owner.query<{ summary: string }>('select summary from task_attempts where id=$1', [f.attempt.id])).rows[0];
  expect(stored?.summary).toContain('완료');
  expect(stored?.summary).not.toContain(canary);
  const view = await app.inject({ url: '/api/tasks/TASK-0009/attempts', headers: { cookie } });
  expect(view.statusCode).toBe(200);
  expect(view.body).not.toContain(canary);
});

test('준비 점검의 중첩 detail·fix도 가리고 멱등 대조는 원문을 구별한다', async () => {
  const headers = runnerHeaders();
  const payload = { at: new Date().toISOString(), items: [{ key: 'codex', status: 'fail', detail: `로그인 ${canary}`, fix: `조치 ${canary}` }] };
  const send = (body: object) => app.inject({ method: 'POST', url: '/api/runner/readiness', headers, payload: body });
  expect((await send(payload)).statusCode).toBe(204);
  expect((await send(payload)).statusCode).toBe(204);
  const conflict = await send({ ...payload, items: [{ ...payload.items[0], detail: `로그인 ${canary}X` }] });
  expect(conflict.statusCode).toBe(409);
  expect(JSON.stringify((await owner.query('select * from runner_readiness')).rows)).not.toContain(canary);
});

test('인증한 Runner ID를 마스킹된 다른 ID로 바꿔 저장하지 않는다', async () => {
  const bearer = await issueRunnerToken(pool, canary, 'fake-public-key');
  const response = await app.inject({ method: 'POST', url: '/api/runner/sessions',
    headers: { ...runnerHeaders(), authorization: `Bearer ${bearer}` }, payload: { runnerId: canary, event: 'start', at: new Date().toISOString() } });
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json()).toMatchObject({ error: { errors: [{ rule: 'secret' }] } });
  expect((await owner.query("select id from runner_sessions where runner_id='[REDACTED]' or runner_id=$1", [canary])).rows).toEqual([]);
  await owner.query('delete from runner_tokens where runner_id=$1', [canary]);
});

test('QA의 cmd·expected·actual·결함·체크리스트 note도 DB·조회 전에 가린다', async () => {
  const f = await runningAttempt('TASK-0012');
  await owner.query("update task_attempts set kind='qa' where id=$1", [f.attempt.id]);
  await owner.query("update tasks set status='qa' where id=$1", [f.task.id]);
  const item = (await owner.query<{ item_key: string }>('select item_key from checklist_items where task=$1 order by item_key limit 1', [f.task.id])).rows[0];
  assert(item);
  const response = await app.inject({ method: 'POST', url: `/api/runner/attempts/${f.attempt.id}/result`, headers: runnerHeaders(),
    payload: { fence: 1, summary: canary, changedFiles: [], evidence: [], verification: { headSha: f.head, specRevision: 1, result: 'FAIL', cmd: canary,
      expected: canary, actual: canary, defects: [{ text: canary, blocking: true }], checklist: [{ itemKey: item.item_key, done: false, note: canary }] } } });
  expect(response.statusCode, response.body).toBe(201);
  for (const table of ['verifications', 'defects', 'checklist_items']) expect(JSON.stringify((await owner.query(`select * from ${table}`)).rows)).not.toContain(canary);
  const view = await app.inject({ url: '/api/tasks/TASK-0012/verifications', headers: { cookie } });
  expect(view.statusCode, view.body).toBe(200);
  expect(view.body).not.toContain(canary);
});

test('Runner가 마스킹을 생략해도 비밀이 든 selfCheck 증거 파일을 저장하지 않는다', async () => {
  const { attempt } = await runningAttempt('TASK-0008');
  const file = Buffer.from(JSON.stringify({ selfCheck: [canary], followups: [canary] }));
  const form = new FormData();
  for (const [key, value] of Object.entries({ kind: 'dev-report', sha256: createHash('sha256').update(file).digest('hex'), size: file.length, fence: 1 })) form.append(key, String(value));
  form.append('file', new Blob([file], { type: 'application/json' }));
  const multipart = new Response(form);
  const response = await app.inject({ method: 'POST', url: `/api/runner/attempts/${attempt.id}/evidence`,
    headers: { ...runnerHeaders(), 'content-type': multipart.headers.get('content-type') ?? '' }, payload: Buffer.from(await multipart.arrayBuffer()) });
  expect(response.statusCode, response.body).toBe(400);
  expect((await owner.query('select id from evidence where attempt=$1', [attempt.id])).rows).toEqual([]);
  expect(response.body).not.toContain(canary);
});

test('커밋에 묶인 설계 원문은 마스킹으로 바꾸지 않고 비밀이 있으면 거부한다', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/runner/design/snapshot', headers: runnerHeaders(),
    payload: { jobId: randomUUID(), fence: 1, commit: 'a'.repeat(40), ref: 'main', files: [{ path: 'contracts/api/openapi.yaml', kind: 'REST', format: 'OpenAPI 3.1', status: 'ok', raw: canary }],
      items: [{ itemKey: 'GET /api/tasks', kind: 'REST', path: 'contracts/api/openapi.yaml', content: {} }], drifts: [] } });
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json()).toMatchObject({ error: { errors: [{ path: 'body', rule: 'secret' }] } });
  expect((await owner.query('select id from design_snapshots')).rows).toEqual([]);
});

test('Agent summary·응답·selfCheck·followups는 DB·조회·증거·outbox에 비밀을 남기지 않는다', async () => {
  const f = await runningAttempt('TASK-0006');
  const message = (await owner.query<{ id: string }>(`insert into messages(project_id,task,msg_key,attempt,dir,type,to_agent,body,delivery,pending_next,work_state,draft)
    values($1,$2,'MSG-900',$3,'out','질문','Codex','결과를 알려 주세요','Acknowledged',false,'',false) returning id`, [f.task.project_id, f.task.id, f.attempt.id])).rows[0];
  assert(message);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const api = createApiClient({ baseUrl, token: new Secret(runner) });
  const home = join(root, 'runner-outbox');
  const state = await State.open(home);
  try {
    await state.update(s => { s.epoch = 1; });
    const outbox = new Outbox(state, api);
    const collect = bindCollect({ api, runner: { outbox }, repo: async () => ({ resultHead: async () => f.head, changedPaths: async () => ['src/result.ts'] }),
      workspace: { worktree: () => ({ id: 'test', branch: f.branch }) } } as unknown as Parameters<typeof bindCollect>[0]);
    const text = JSON.stringify({ summary: `완료 ${canary}`, selfCheck: [`확인 ${canary}`], followups: [`후속 ${canary}`], designItems: [],
      responses: [{ messageId: message.id, text: `응답 ${canary}`, workState: `상태 ${canary}` }] });
    const result = await collect({ epoch: 1, signal: new AbortController().signal, messages: [{ id: message.id }],
      job: { id: f.job.id, kind: 'attempt', fence: 1, payload: { kind: 'dev', baseCommit: f.head } },
      output: { attemptId: f.attempt.id, text } } as unknown as Parameters<typeof collect>[0]);
    expect(JSON.stringify(result)).not.toContain(canary);
    await outbox.enqueue('reportAttemptResult', { epoch: 1, params: { attemptId: f.attempt.id }, body: { ...result.report, fence: 1 } });
    for (const response of result.responses ?? []) await outbox.enqueue('respondMessage', { epoch: 1, params: { messageId: response.messageId }, body: { text: response.text, workState: response.workState } });
    for (const name of await readdir(home, { recursive: true })) {
      const bytes = await readFile(join(home, name)).catch(e => { if (e.code === 'EISDIR') return Buffer.alloc(0); throw e; });
      expect(bytes.toString()).not.toContain(canary);
    }
    // Runner의 마스킹을 우회한 보고도 서버 공통 입구가 보호한다.
    const report = await app.inject({ method: 'POST', url: `/api/runner/attempts/${f.attempt.id}/result`, headers: runnerHeaders(),
      payload: { ...result.report, summary: `완료 ${canary}`, fence: 1 } });
    expect(report.statusCode, report.body).toBe(201);
    const response = await app.inject({ method: 'POST', url: `/api/runner/messages/${message.id}/response`, headers: runnerHeaders(), payload: { text: `응답 ${canary}`, workState: `상태 ${canary}` } });
    expect(response.statusCode, response.body).toBe(204);
    for (const table of ['task_attempts', 'messages', 'state_log', 'task_history', 'evidence', 'idempotency_keys']) {
      expect(JSON.stringify((await owner.query(`select * from ${table}`)).rows)).not.toContain(canary);
    }
    for (const url of ['/api/tasks/TASK-0006/attempts', '/api/tasks/TASK-0006/messages']) {
      const view = await app.inject({ url, headers: { cookie } });
      expect(view.statusCode, view.body).toBe(200);
      expect(view.body).not.toContain(canary);
    }
    for (const row of (await owner.query<{ storage_path: string }>('select storage_path from evidence where attempt=$1', [f.attempt.id])).rows) {
      expect(await readFile(join(root, row.storage_path), 'utf8')).not.toContain(canary);
    }
  } finally { await state.close(); }
});
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

test('GitHub·SMTP 설정 응답과 모든 DB 표에 평문이 없고 암호문은 실제로 복호된다', async () => {
  const headers = { cookie, origin, 'x-csrf-token': csrf };
  const githubBefore = (await app.inject({ url: '/api/settings/github', headers })).json<{ updatedAt: string | null }>();
  const githubReply = await app.inject({ method: 'PUT', url: '/api/settings/github', headers,
    payload: { updatedAt: githubBefore.updatedAt, mode: 'token', token: github } });
  expect(githubReply.statusCode, githubReply.body).toBe(200);
  expect(githubReply.json()).toMatchObject({ tokenSet: true });
  const smtpReply = await app.inject({ method: 'PUT', url: '/api/settings/mail/smtp', headers,
    payload: { updatedAt: null, host: '127.0.0.1', port: 1, sec: '없음', from: 'a@example.com', user: 'a', password: smtp } });
  expect(smtpReply.statusCode, smtpReply.body).toBe(200);
  expect(smtpReply.json()).toMatchObject({ pwSet: true });
  await inEpoch(pool, 1, async client => {
    const key = await tokenKey(client, telegram);
    expect(await readToken(client, key)).toBe(telegram);
    expect(await readSmtpPassword(client)).toBe(smtp);
  });
  const tables = (await owner.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
  let dump = '';
  for (const { tablename } of tables) dump += JSON.stringify((await owner.query(`select * from "${tablename.replaceAll('"', '""')}"`)).rows);
  const outputs = [dump, logs, githubReply.body, smtpReply.body, (await app.inject({ url: '/api/settings/github', headers })).body,
    (await app.inject({ url: '/api/settings/mail/smtp', headers })).body];
  for (const output of outputs) for (const secret of [github, smtp, telegram, password, runner, link, cookie.split('=')[1] ?? 'missing-cookie']) expect(output).not.toContain(secret);
  const zip = await exportProject(pool, 1, root);
  const decoded = spawnSync('python3', ['-c', 'import sys,zipfile,io; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(z.read("data.json").decode())'], { input: zip, encoding: 'utf8' });
  expect(decoded.status, decoded.stderr).toBe(0);
  for (const secret of [github, smtp, telegram, password, runner, link]) expect(decoded.stdout).not.toContain(secret);
});

test.each(['/api/settings/mail/smtp', '/api/project', '/api/tasks/TASK-0001'])('%s 오류의 문장·조치·필드 경로까지 가린다', async url => {
  const response = await app.inject({ url, headers: { cookie, 'x-secret-error': '1' } });
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  expect(response.body).not.toContain(github);
  expect(response.body).not.toContain(smtp);
});

test('새 보고서의 DB 스냅샷과 조회 응답에도 자유 입력의 토큰이 없다', async () => {
  const project = (await owner.query<{ id: string }>('select id from projects')).rows[0];
  assert(project);
  await owner.query('update projects set name=$1', [`보안 검사 ${github}`]);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const created = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/reports`,
    headers: { cookie, origin, 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() }, payload: { from: today, to: today, view: 'int' } });
  expect(created.statusCode, created.body).toBe(201);
  const { id } = created.json<{ id: string }>();
  const stored = (await owner.query('select snapshot from reports where id=$1', [id])).rows;
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(stored)).not.toContain(github);
  const response = await app.inject({ url: `/api/reports/${id}`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  expect(response.body).not.toContain(github);
});
