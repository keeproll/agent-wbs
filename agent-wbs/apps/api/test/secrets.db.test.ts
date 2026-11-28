import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
let logs = '', cookie = '', csrf = '', runner = '', link = '', root = '';
const app = buildApp(pool, loggerOptions('info', { write: (line: string) => { logs += line; } }), { origin, lan: false });
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
  root = await mkdtemp(join(tmpdir(), 'awbs-m803-export-'));
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
