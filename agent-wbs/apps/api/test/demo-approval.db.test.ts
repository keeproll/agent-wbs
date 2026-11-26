import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, seedDemo } from '@awbs/db';
import { subjectHash } from '@awbs/shared/judgement';
import { buildApp } from '../src/app.ts';
import { installRunner } from '../src/runner/routes.ts';
import { issueLoginLink, issueRunnerToken } from '../src/platform/credentials.ts';
import type { TaskDetail } from '../src/tasks/read.ts';

const url = new URL(inject('testDatabaseUrl'));
url.pathname += '_demo_approval';
const owner = createPool(url.href, { onError: () => undefined });
const roleUrl = new URL(url);
roleUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(roleUrl.href, { onError: () => undefined });
const origin = 'http://127.0.0.1:3100';
const app = buildApp(pool, false, { origin, lan: false });
installRunner(app, pool);
let cookie = '', csrf = '';
beforeAll(async () => {
  await recreateTestDatabase(url.href);
  await runMigrations(owner);
  await seedDemo(owner, url.href);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token: await issueLoginLink(pool) } });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
});
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });

test('demo 판단은 저장된 내용의 지문과 같고 실제 승인 API로 ready가 된다', async () => {
  const d = (await app.inject({ url: '/api/tasks/TASK-0010', headers: { cookie } })).json<TaskDetail>();
  const hash = subjectHash({ title: d.title, overview: d.spec.overview, spec: d.spec.spec, ac: d.spec.ac, outputs: d.outputs, designs: d.designs, conflictGroup: d.conflictGroup });
  expect(d.split?.judgedRules).toMatchObject({ items: [
    { rule: 'revert', subjectHash: hash }, { rule: 'contract', subjectHash: hash }, { rule: 'refactor', subjectHash: hash },
  ] });
  const approved = await app.inject({ method: 'POST', url: '/api/tasks/TASK-0010/approve', headers: { cookie, origin, 'x-csrf-token': csrf }, payload: { updatedAt: d.updatedAt } });
  expect(approved.statusCode, approved.body).toBe(200);
  expect(approved.json()).toMatchObject({ task: { lifecycleStatus: 'ready' } });
});


test('보고 거부 경고를 서버에 저장하고 Runner 상태로 다시 읽는다', async () => {
  const token = await issueRunnerToken(pool, 'reports-runner', 'fake');
  const sent = await app.inject({ method: 'POST', url: '/api/runner/readiness',
    headers: { authorization: `Bearer ${token}`, 'x-project-epoch': '1', 'idempotency-key': crypto.randomUUID() },
    payload: { at: '2026-11-27T00:00:00Z', items: [{ key: 'reports', status: 'warn', detail: '보고 거부 1건', fix: '거부 기록 확인' }] } });
  expect(sent.statusCode, sent.body).toBe(204);
  const state = await app.inject({ url: '/api/runner-state', headers: { cookie } });
  expect(state.statusCode, state.body).toBe(200);
  expect(state.json()).toMatchObject({ readiness: { items: [{ key: 'reports', status: 'warn', detail: '보고 거부 1건' }] } });
});
