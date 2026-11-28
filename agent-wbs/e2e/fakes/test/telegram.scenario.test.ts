import { afterEach, expect, inject, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loggerOptions } from '../../../apps/api/src/log.ts';
import { scenario, type Scenario } from './scenario.ts';
import { BOT_TOKEN, connectTelegram, fakeBotApi } from '../telegram.ts';

// 각 시험은 빈 DB에 전체 마이그레이션을 적용한다. 다른 worker의 DB 검증과 겹쳐도 준비가 끝나기를 기다린다.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const token = BOT_TOKEN;
const dbEnvKey = process.env.AWBS_SECRET_KEY;
let s: Scenario | undefined;
const active = () => { if (!s) throw new Error('시나리오가 없습니다.'); return s; };
let bot: ReturnType<typeof createServer> | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await s?.close(); s = undefined;
  await new Promise<void>(resolve => bot ? bot.close(() => resolve()) : resolve()); bot = undefined;
  delete process.env.AWBS_TELEGRAM_BOT_API_URL;
  if (dbEnvKey === undefined) delete process.env.AWBS_SECRET_KEY; else process.env.AWBS_SECRET_KEY = dbEnvKey;
});

async function fake() {
  const f = await fakeBotApi();
  bot = f.server;
  return f;
}

async function connect(options: Parameters<typeof scenario>[0] = {}) {
  const f = await fake();
  s = await scenario(options);
  const project = (await s.rows('select id from projects'))[0]?.id as string;
  const saved = await connectTelegram(s);
  return { ...f, project, saved };
}

test('telegram fix1 R1·R5: 제목 수정과 경보 확인은 새 실패 보고가 아니다', async () => {
  await connect();
  await active().rows("update tasks set verif_state='fail' where task_key='TASK-0001'");
  await active().rows("update tasks set title='제목 수정 1' where task_key='TASK-0001'");
  await active().rows("update tasks set title='제목 수정 2' where task_key='TASK-0001'");
  await active().rows(`insert into alerts(project_id,key,severity,target)
    select id,'retry:TASK-0001','error','{"taskKey":"TASK-0001"}'::jsonb from projects`);
  await active().rows("update alerts set acknowledged_at=now() where key='retry:TASK-0001'");
  expect(await active().rows("select dup_count from notify_events where kind='fail' order by dedup_key")).toEqual([{ dup_count: 0 }, { dup_count: 0 }]);
});

test.each(['invalid', 'http://127.0.0.1:1', 'refused', 'https://example.invalid'])('telegram fix1 R2: 수락 전 실패 %s는 failed, 중복 경고 없음', async endpoint => {
  const f = await connect();
  if (endpoint === 'refused') { await new Promise<void>(resolve => bot?.close(() => resolve())); bot = undefined; }
  else process.env.AWBS_TELEGRAM_BOT_API_URL = endpoint;
  const sent = await active().lead('POST', '/api/notify/telegram/test', { chatId: '-4123456789', targetName: '팀장' });
  const { processNotify } = await import('../../../apps/api/src/notify/worker.ts');
  for (let n = 1; n <= 5; n++) await processNotify(active().pool, 1, new Date(Date.now() + n * 70_000));
  // 시계가 뒤로 가도 이전 연결 테스트 기록을 고르지 않도록 이번 요청 ID로 읽는다.
  const log = (await active().lead('GET', `/api/projects/${f.project}/notify/log/${String(sent.body.testId)}`)).body;
  expect(log).toMatchObject({ state: 'failed', attempts: 5 });
  expect(log.error).not.toMatch(/중복 도착 가능|^network:/);
});

test.each(['disabled', 'chat', 'token'].flatMap(change => [false, true].map(retrying => [change, retrying] as const)))('telegram fix1 R3: %s 변경 뒤 쌓인 업무 알림은 보내지 않는다 (재시도 %s)', async (change, retrying) => {
  // 실제 시간이 흘러도 시험 시계는 움직이지 않는다. 속도 제한 경계는 worker의 시각 인자로 제어한다.
  vi.useFakeTimers({ toFake: ['Date'] });
  const f = await connect();
  await active().rows("insert into runner_readiness(key,status,detail,fix,at) values('cancel','fail','실패','확인',now())");
  const { processNotify } = await import('../../../apps/api/src/notify/worker.ts');
  if (retrying) {
    f.fail(429);
    const last = (await active().rows("select max(at) at from notify_log where state='sending'"))[0]?.at as Date;
    await processNotify(active().pool, 1, new Date(last.getTime() + 10_000));
    expect((await active().rows("select state from notify_outbox where kind='biz'"))[0]?.state).toBe('retry_wait');
    f.fail(0);
  }
  const chatId = change === 'chat' ? '512345678' : '-4123456789';
  const botToken = change === 'token' ? token.replace('abcd', 'zzzz') : undefined;
  if (change !== 'disabled') {
    const tested = await active().lead('POST', '/api/notify/telegram/test', { botToken, chatId, targetName: '새 대상' });
    const last = (await active().rows("select max(at) at from notify_log where state='sending'"))[0]?.at as Date;
    await processNotify(active().pool, 1, new Date(last.getTime() + 10_000), String(tested.body.testId));
    expect((await active().lead('GET', `/api/notify/telegram?testId=${String(tested.body.testId)}`)).body.test).toMatchObject({ ok: true });
  }
  const saved = await active().lead('PUT', '/api/notify/telegram', { botToken, enabled: change !== 'disabled', chatId, targetName: '새 대상', updatedAt: f.saved.updatedAt });
  expect(saved.status).toBe(200);
  const sends = f.requests.filter(r => r.method === 'sendMessage').length;
  const last = (await active().rows("select max(at) at from notify_log where state='sending'"))[0]?.at as Date;
  await processNotify(active().pool, 1, new Date(last.getTime() + 60_000));
  expect(f.requests.filter(r => r.method === 'sendMessage')).toHaveLength(sends);
  expect(await active().rows("select state,attempts from notify_outbox where kind='biz'")).toEqual([{ state: 'failed', attempts: retrying ? 1 : 0 }]);
});

test('telegram fix1 R4: 초안 토큰 실패는 저장된 연결의 경보를 열거나 해소하지 않는다', async () => {
  const f = await connect();
  const draft = token.replace('abcd', 'zzzz');
  f.fail(401);
  await active().lead('POST', '/api/notify/telegram/check-bot', { botToken: draft });
  await active().lead('POST', '/api/notify/telegram/test', { botToken: draft, chatId: '-4123456789', targetName: '초안' });
  await active().lead('POST', '/api/notify/telegram/test', { chatId: '512345678', targetName: '다른 대화 초안' });
  expect(await active().rows("select id from alerts where key='telegram-connection' and resolved_at is null")).toHaveLength(0);
  expect((await active().lead('GET', '/api/notify/telegram')).body).toMatchObject({ enabled: true, test: { ok: true } });
  await active().lead('POST', '/api/notify/telegram/test', { chatId: '-4123456789', targetName: '저장된 연결' });
  expect(await active().rows("select id from alerts where key='telegram-connection' and resolved_at is null")).toHaveLength(1);
  f.fail(0);
  await active().lead('POST', '/api/notify/telegram/test', { botToken: draft, chatId: '512345678', targetName: '초안' });
  expect(await active().rows("select id from alerts where key='telegram-connection' and resolved_at is null")).toHaveLength(1);
});

test('telegram fix1: 같은 Runner의 새 실패 보고는 같은 시각이어도 중복 생략으로 센다', async () => {
  await connect();
  const at = new Date(Date.now() + 1000).toISOString();
  const report = (idempotencyKey = randomUUID()) => active().runner.api('reportReadiness', { epoch: 1, idempotencyKey, body: { at, items: [{ key: 'codex', status: 'fail', detail: '로그인 필요' }] } });
  expect((await report()).status).toBe(204);
  const reportId = randomUUID();
  expect((await report(reportId)).status).toBe(204);
  expect((await report(reportId)).status).toBe(204);
  // 낡은 보고는 현재 상태에 적용하지 않으므로 새 보고로 세지 않는다.
  await active().runner.api('reportReadiness', { epoch: 1, idempotencyKey: randomUUID(), body: { at: '2000-01-01T00:00:00Z', items: [{ key: 'codex', status: 'fail', detail: '낡은 보고' }] } });
  await active().rows("update runner_readiness set detail='화면 문구 수정' where key='codex'");
  expect(await active().rows("select dup_count from notify_events where dedup_key='admin|ready|codex'")).toEqual([{ dup_count: 1 }]);
});

test('telegram fix1: GitHub·재시도 한도의 새 실패 보고는 세고 알림 권한 오류도 보고를 막지 않는다', async () => {
  const f = await connect();
  const github = () => active().runner.api('reportGithubStatus', { epoch: 1, idempotencyKey: randomUUID(), body: { mode: 'gh', ok: false, account: null, scopes: null, expiresAt: null } });
  expect((await github()).status).toBe(204);
  expect((await github()).status).toBe(204);
  const { RunnerRepository } = await import('../../../apps/api/src/runner/repository.ts');
  const { inEpoch } = await import('../../../apps/api/src/platform/transaction.ts');
  for (let n = 0; n < 2; n++) await inEpoch(active().pool, 1, async db => {
    const repo = new RunnerRepository(db); await repo.lock();
    await repo.alert(f.project, 'retry:TASK-0001', '한도 초과', { taskKey: 'TASK-0001' });
  });
  expect(await active().rows("select dup_count from notify_events where dedup_key in ('admin|github','fail|retry|TASK-0001') order by dedup_key")).toEqual([{ dup_count: 1 }, { dup_count: 1 }]);
  await active().rows('revoke update on notify_events from awbs_app');
  try {
    expect((await github()).status).toBe(204);
    expect((await active().rows('select status from github_settings'))[0]?.status).toBe('failed');
  } finally { await active().rows('grant update on notify_events to awbs_app'); }
});

test('telegram fix1: 보낸 뒤 응답 유실은 unknown과 중복 가능 이력을 유지한다', async () => {
  const f = await connect(); f.invalidResponse();
  await active().lead('POST', '/api/notify/telegram/test', { chatId: '-4123456789', targetName: '팀장' });
  const { processNotify } = await import('../../../apps/api/src/notify/worker.ts');
  for (let n = 1; n <= 5; n++) await processNotify(active().pool, 1, new Date(Date.now() + n * 70_000));
  const log = (await active().lead('GET', `/api/projects/${f.project}/notify/log?kind=test`)).body.items[0];
  expect(log).toMatchObject({ state: 'unknown', attempts: 5 });
  expect(log.error).toContain('중복 도착 가능');
  expect(log.error).not.toMatch(/^network:/);
});

test('telegram fix1: 응답 시간 초과 뒤 연결 전 실패가 이어져도 수락 불명 이력을 유지한다', async () => {
  const f = await connect(); f.delay(5200);
  await active().lead('POST', '/api/notify/telegram/test', { chatId: '-4123456789', targetName: '팀장' });
  process.env.AWBS_TELEGRAM_BOT_API_URL = 'invalid';
  const { processNotify } = await import('../../../apps/api/src/notify/worker.ts');
  for (let n = 1; n <= 5; n++) await processNotify(active().pool, 1, new Date(Date.now() + n * 70_000));
  const log = (await active().lead('GET', `/api/projects/${f.project}/notify/log?kind=test`)).body.items[0];
  expect(log).toMatchObject({ state: 'unknown', attempts: 5 });
  expect(log.error).toContain('중복 도착 가능');
});

test('telegram: 테스트 전 켜기 거부, 쓰기 전용 토큰, 음수 대화와 저장 버전', async () => {
  process.env.AWBS_SECRET_KEY = 'a'.repeat(64);
  s = await scenario();
  const initial = await s.lead('GET', '/api/notify/telegram');
  expect(initial.status).toBe(200);
  expect(initial.body).toMatchObject({ enabled: false, tokenSet: false, test: null });
  expect((await s.lead('GET', '/api/notify/telegram?testId=invalid')).status).toBe(400);
  const rejected = await s.lead('PUT', '/api/notify/telegram', {
    enabled: true, botToken: token, chatId: '-4123456789', targetName: '팀장', updatedAt: initial.body.updatedAt,
  });
  expect(rejected.status).toBe(400);
  for (const botToken of ['', '●●●● 등록됨 abcd']) {
    expect((await s.lead('PUT', '/api/notify/telegram', {
      enabled: false, botToken, chatId: '-4123456789', targetName: '팀장', updatedAt: initial.body.updatedAt,
    })).status).toBe(400);
  }
  for (const chatId of ['+821012345678', '@manager']) {
    expect((await s.lead('POST', '/api/notify/telegram/test', { botToken: token, chatId, targetName: '팀장' })).status).toBe(400);
  }
});

test('telegram: 테스트한 조합만 활성화하고 이름 변경은 성공 유지, 토큰은 응답/이력에 없다', async () => {
  let serverLog = '';
  const stream = new Writable({ write(chunk, _encoding, done) { serverLog += String(chunk); done(); } });
  const { project, saved } = await connect({ logger: loggerOptions('info', stream) });
  const changed = await active().lead('PUT', '/api/notify/telegram', { enabled: true, chatId: '-4123456789', targetName: '새 이름', updatedAt: saved.updatedAt });
  expect(changed.body.test.ok).toBe(true);
  expect((await active().lead('PUT', '/api/notify/telegram', { enabled: true, chatId: '512345678', targetName: '다른 대화', updatedAt: changed.body.updatedAt })).status).toBe(400);
  expect((await active().lead('PUT', '/api/notify/telegram', { enabled: false, chatId: '-4123456789', targetName: '옛 버전', updatedAt: saved.updatedAt })).status).toBe(409);
  const logs = await active().lead('GET', `/api/projects/${project}/notify/log`);
  expect(logs.body.items).toHaveLength(1);
  const detail = await active().lead('GET', `/api/projects/${project}/notify/log/${logs.body.items[0].id}`);
  expect(detail.body.message).toContain('테스트');
  const policy = (await active().runner.api('getRunnerPolicy', { epoch: 1 })).body;
  const publicData = JSON.stringify([changed.body, logs.body, detail.body, policy]);
  expect(publicData).not.toContain(token);
  expect(serverLog).not.toContain(token);
  if (process.env.AWBS_TEST_ARTIFACT_DIR) {
    await writeFile(join(process.env.AWBS_TEST_ARTIFACT_DIR, 'telegram-public.json'), publicData);
    await writeFile(join(process.env.AWBS_TEST_ARTIFACT_DIR, 'telegram-server.log'), serverLog);
  }
  const encrypted = await active().rows("select ciphertext from secrets where key like 'telegram:%'");
  expect(encrypted.length).toBeGreaterThan(0);
  expect(JSON.stringify(encrypted)).not.toContain(token);
  const disabled = await active().lead('PUT', '/api/notify/telegram', { enabled: false, chatId: '512345678', targetName: '다른 대화', updatedAt: changed.body.updatedAt });
  expect(disabled.body.test).toBeNull();
});

test('telegram: 대화 후보는 자동 선택하지 않고 빈 결과와 webhook은 설정을 바꾸지 않는다', async () => {
  const f = await fake(); s = await scenario();
  const candidates = await s.lead('POST', '/api/notify/telegram/find-chats', { botToken: token });
  expect(candidates.status).toBe(200);
  expect(candidates.body.candidates.map((c: { chatId: string }) => c.chatId)).toEqual(['512345678', '-4123456789']);
  expect((await s.lead('GET', '/api/notify/telegram')).body.chatId).toBeNull();
  f.empty();
  expect((await s.lead('POST', '/api/notify/telegram/find-chats', { botToken: token })).body.candidates).toEqual([]);
  f.fail(409);
  expect((await s.lead('POST', '/api/notify/telegram/find-chats', { botToken: token })).body.error).toBe('webhook_in_use');
  expect(f.requests.some(r => r.method === 'deleteWebhook')).toBe(false);
});

test('telegram: 규칙/접속 주소의 저장과 버전 충돌, 미리보기와 빈 이력', async () => {
  s = await scenario();
  const project = (await s.rows('select id from projects'))[0]?.id as string;
  const rules = await s.lead('GET', `/api/projects/${project}/notify/rules`);
  expect(rules.body).toMatchObject({ done: false, fail: true, admin: true, approve: true, buildOk: false, buildFail: true });
  expect((await s.lead('GET', `/api/projects/${project}/notify/log?kind=biz`)).body).toMatchObject({ items: [], nextCursor: null });
  const invalidCursor = Buffer.from(JSON.stringify({ at: '2026-99-99T00:00:00Z', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })).toString('base64url');
  expect((await s.lead('GET', `/api/projects/${project}/notify/log?cursor=${invalidCursor}`)).status).toBe(400);
  const url = (await s.lead('GET', '/api/settings/app-url')).body;
  expect((await s.lead('PUT', '/api/settings/app-url', { appUrl: 'javascript:alert(1)', updatedAt: url.updatedAt })).status).toBe(400);
  const saved = await s.lead('PUT', '/api/settings/app-url', { appUrl: 'http://192.168.0.10:3100', updatedAt: url.updatedAt });
  expect(saved.status).toBe(200);
  expect((await s.lead('GET', `/api/projects/${project}/notify/preview?event=buildFail`)).body.text).toContain('WBS에서 확인: http://192.168.0.10:3100/ci/');
  const reset = await s.lead('PUT', '/api/settings/app-url', { appUrl: null, updatedAt: saved.body.updatedAt });
  expect(reset.status).toBe(200);
  expect((await s.lead('GET', `/api/projects/${project}/notify/preview?event=done`)).body.text).not.toContain('WBS에서 확인:');
  expect((await s.lead('PUT', `/api/projects/${project}/notify/rules`, { ...rules.body, done: true })).status).toBe(200);
  expect((await s.lead('PUT', `/api/projects/${project}/notify/rules`, rules.body)).status).toBe(409);
});

test.each([[401, 'token_invalid'], [400, 'chat_not_found'], [403, 'forbidden'], [429, 'rate_limited']] as const)(
  'telegram: 오류 %i의 이력/테스트/배지, Task 상태 불변', async (code, error) => {
    const f = await fake(); s = await scenario(); f.fail(code);
    if (code === 401) {
      expect((await s.lead('POST', '/api/notify/telegram/check-bot', { botToken: token })).body.error).toBe('token_invalid');
      expect((await s.lead('GET', '/api/alerts')).body.items.some((a: { text: string }) => a.text.includes('Telegram'))).toBe(false);
    }
    const tasks = await s.rows('select task_key,status,verif_state from tasks order by task_key');
    const project = (await s.rows('select id from projects'))[0]?.id as string;
    const response = await s.lead('POST', '/api/notify/telegram/test', { botToken: token, chatId: '-4123456789', targetName: '팀장' });
    expect(response.body).toMatchObject({ ok: false, error, retryAfter: code === 429 ? 15 : null });
    const log = (await s.lead('GET', `/api/projects/${project}/notify/log`)).body.items[0];
    expect(log).toMatchObject({ state: code === 429 ? 'retry_wait' : 'failed', attempts: 1 });
    expect((await s.lead('GET', '/api/alerts')).body.items.some((a: { text: string }) => a.text.includes('Telegram'))).toBe(false);
    expect(await s.rows('select task_key,status,verif_state from tasks order by task_key')).toEqual(tasks);
    expect(JSON.stringify(log)).not.toContain(token);
  });

test('telegram: 429는 retry_after 전 보내지 않고 나중에 성공하면 테스트와 연결 알림도 복구', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { fail, requests, project, delay, responseAt } = await connect();
  const { processNotify } = await import('../../../apps/api/src/notify/worker.ts');
  fail(429);
  delay(100);
  const tested = await active().lead('POST', '/api/notify/telegram/test', { chatId: '-4123456789', targetName: '팀장' });
  const last = (await active().rows("select max(at) at from notify_log where state='sending'"))[0]?.at as Date;
  const sendAt = new Date(last.getTime() + 10_000);
  await processNotify(active().pool, 1, sendAt, String(tested.body.testId));
  const retryAt = (await active().rows('select next_at from notify_outbox order by created_at desc limit 1'))[0]?.next_at as Date;
  expect(retryAt.getTime()).toBe(sendAt.getTime() + 15_000);
  expect(retryAt.getTime()).toBeGreaterThanOrEqual(responseAt() + 15_000);
  expect((await active().lead('GET', '/api/notify/telegram')).body.test).toMatchObject({ ok: false, error: 'rate_limited' });
  const sends = requests.filter(r => r.method === 'sendMessage').length;
  await processNotify(active().pool, 1, new Date(retryAt.getTime() - 1));
  expect(requests.filter(r => r.method === 'sendMessage')).toHaveLength(sends);
  fail(0);
  await processNotify(active().pool, 1, retryAt);
  expect((await active().lead('GET', '/api/notify/telegram')).body.test).toMatchObject({ ok: true, error: null });
  expect((await active().lead('GET', `/api/projects/${project}/notify/log`)).body.items[0]).toMatchObject({ state: 'accepted', attempts: 2 });
  expect((await active().lead('GET', '/api/alerts')).body.items.some((a: { text: string }) => a.text.includes('Telegram'))).toBe(false);
});

test('telegram: 상태 전이와 outbox는 함께 커밋, 같은 원인만 중복 생략하고 해소 뒤 재발은 새 발송', async () => {
  const { requests, project } = await connect();
  const rules = (await active().lead('GET', `/api/projects/${project}/notify/rules`)).body;
  await active().lead('PUT', `/api/projects/${project}/notify/rules`, { ...rules, done: true });
  const { processNotify } = await import('../../../apps/api/src/notify/worker.ts');
  await active().rows("insert into runner_readiness(key,status,detail,fix,at) values('codex-login','fail','로그인 실패','다시 로그인',now())");
  await active().rows("update runner_readiness set detail='계속 실패' where key='codex-login'");
  let events = await active().rows("select kind,dup_count,resolved_at from notify_events where kind='admin'");
  expect(events).toHaveLength(1);
  expect(events[0]?.dup_count).toBe(0);
  await processNotify(active().pool, 1, new Date(Date.now() + 5000));
  const log = (await active().lead('GET', `/api/projects/${project}/notify/log?kind=biz`)).body.items;
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({ duplicates: 0, state: 'accepted', event: 'admin' });
  await active().rows("update runner_readiness set status='ok' where key='codex-login'");
  await active().rows("update runner_readiness set status='fail' where key='codex-login'");
  events = await active().rows("select kind,dup_count,resolved_at from notify_events where kind='admin'");
  expect(events).toHaveLength(2);
  const tx = await active().pool.connect();
  try {
    await tx.query('begin');
    await tx.query("update tasks set verif_state='fail' where task_key='TASK-0001'");
    await tx.query('rollback');
  } finally { tx.release(); }
  expect(await active().rows("select id from notify_events where kind='fail'")).toEqual([]);
  await active().rows("update tasks set verif_state='fail' where task_key='TASK-0001'");
  expect(await active().rows("select id from notify_events where kind='fail'")).toHaveLength(1);
  expect(requests.filter(r => r.method === 'sendMessage').every(r => !('parse_mode' in r.body))).toBe(true);
});

test('telegram: 꺼진 전이는 밀어 보내지 않고 긴 비밀 문자열도 메시지에 노출하지 않는다', async () => {
  const { project } = await connect();
  let rules = (await active().lead('GET', `/api/projects/${project}/notify/rules`)).body;
  await active().lead('PUT', `/api/projects/${project}/notify/rules`, { ...rules, admin: false });
  await active().rows("insert into runner_readiness(key,status,detail,fix,at) values('hidden','fail','오류','확인',now())");
  rules = (await active().lead('GET', `/api/projects/${project}/notify/rules`)).body;
  await active().lead('PUT', `/api/projects/${project}/notify/rules`, { ...rules, admin: true });
  expect(await active().rows("select id from notify_events where kind='admin'")).toEqual([]);
  const { message } = await import('../../../apps/api/src/notify/message.ts');
  const text = message({ event: 'buildFail', project: '시험', target: token + '긴제목'.repeat(5000), state: '실패 — 실패 단계: E2E', reason: '원인 조사 중', path: '/ci/CI-001', at: '2026-11-27' }, null);
  expect(text.length).toBeLessThanOrEqual(4096);
  expect(text).not.toContain(token);
  expect(text).toContain('(미확정)');
});

// M6·M7 통합: 「PR-A의 성공이 PR-B의 실패 키를 해소하지 않는다」는 실제 CI 보고 API로 옮겼다(apps/api/test/ci.db.test.ts 「M6·M7 통합(telegram)」).
// 왜: CI 빌드 알림은 이제 ci_runs 트리거가 아니라 M7 CI 코드(notifyResult)가 공통 함수(0036 awbs_notify_emit)로 만든다.

test('telegram: 실제 실행 실패는 자동 재시도 소진 후에만, QA FAIL은 확정 즉시 알린다', async () => {
  await connect();
  expect((await active().run('TASK-0001')).status).toBe(202);
  for (let count = 0; count < 3; count++) {
    const attempt = await active().runner.startNext();
    expect(attempt).toBeTruthy();
    if (!attempt) throw new Error('시도 없음');
    await active().runner.api('releaseJobSlots', { epoch: 1, idempotencyKey: randomUUID(), params: { id: attempt.job.id }, body: {
      fence: attempt.job.fence, hostId: active().runner.hostId, proof: { kind: 'group_empty', bootId: attempt.bootId, processGroup: attempt.processGroup }, at: new Date().toISOString(),
    } });
    await active().runner.api('reportAttemptResult', { epoch: 1, idempotencyKey: randomUUID(), params: { attemptId: attempt.attemptId }, body: {
      fence: attempt.job.fence, summary: '무료 가짜 실행 실패', changedFiles: [], evidence: [], failure: 'process-exit',
    } });
    expect(await active().rows("select id from notify_events where kind='fail'")).toHaveLength(count < 2 ? 0 : 1);
    expect(await active().rows("select id from notify_outbox where kind='biz' and payload->>'event'='fail'")).toHaveLength(count < 2 ? 0 : 1);
  }
});

test('telegram: 수락 직후 실제 worker 프로세스 종료 후 같은 대기열 재시도와 중복 가능 이력', async () => {
  const f = await connect();
  await active().rows("insert into runner_readiness(key,status,detail,fix,at) values('crash','fail','실패','확인',now())");
  const url = new URL(inject('testDatabaseUrl'));
  url.pathname += '_runner_scenario'; url.searchParams.set('options', '-c role=awbs_app');
  const child = spawn(process.execPath, ['--conditions=awbs-source', '--input-type=module', '-e',
    "import {createPool} from './packages/db/src/index.ts'; import {processNotify} from './apps/api/src/notify/worker.ts'; const pool=createPool(process.env.TELEGRAM_WORKER_DB,{onError:()=>{}}); await processNotify(pool,1,new Date(Date.now()+5000)); await pool.end();"],
  { env: { ...process.env, TELEGRAM_WORKER_DB: url.href }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += String(data); });
  f.onAccept(() => { child.kill('SIGKILL'); });
  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => { resolve({ code, signal }); });
    });
    expect(exit, stderr).toEqual({ code: null, signal: 'SIGKILL' });
  } finally { child.kill('SIGKILL'); f.onAccept(); }
  expect(await active().rows("select state,attempts from notify_outbox where kind='biz'")).toEqual([{ state: 'sending', attempts: 1 }]);
  const { processNotify } = await import('../../../apps/api/src/notify/worker.ts');
  await processNotify(active().pool, 1, new Date(Date.now() + 40_000));
  const logs = (await active().lead('GET', `/api/projects/${f.project}/notify/log?kind=biz`)).body.items;
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ state: 'accepted', attempts: 2 });
  expect(logs[0].error).toContain('중복 도착 가능');
  expect(logs[0].error).not.toMatch(/^network:|^\s*—/);
  expect(f.requests.filter(r => r.method === 'sendMessage')).toHaveLength(3);
});

test('telegram: 수락 전 실패는 횟수 제한 뒤 failed, 수신 대상 이동은 자동 변경하지 않는다', async () => {
  const f = await connect();
  f.fail(400, true);
  const migrated = await active().lead('POST', '/api/notify/telegram/test', { chatId: '-4123456789', targetName: '팀장' });
  expect(migrated.body.error).toBe('chat_migrated');
  expect((await active().lead('GET', '/api/notify/telegram')).body.chatId).toBe('-4123456789');
  process.env.AWBS_TELEGRAM_BOT_API_URL = 'invalid';
  const result = await active().lead('POST', '/api/notify/telegram/test', { chatId: '-4123456789', targetName: '팀장' });
  expect(result.body.error).toBe('network');
  const { processNotify } = await import('../../../apps/api/src/notify/worker.ts');
  for (let attempt = 1; attempt <= 5; attempt++) await processNotify(active().pool, 1, new Date(Date.now() + attempt * 70_000));
  const logs = (await active().lead('GET', `/api/projects/${f.project}/notify/log?kind=test`)).body.items;
  expect(logs[0]).toMatchObject({ state: 'failed', attempts: 5 });
  expect(logs[0].error).not.toContain('중복 도착 가능');
});

test('telegram: 외부 수락 뒤 DB 교착 오류는 외부 호출을 숨겨서 다시 실행하지 않는다', async () => {
  const { requests } = await connect();
  await active().rows("insert into runner_readiness(key,status,detail,fix,at) values('db-fault','fail','실패','확인',now())");
  await active().rows(`create sequence telegram_test_fault; grant usage on sequence telegram_test_fault to awbs_app;
    create function telegram_test_fail() returns trigger language plpgsql as $$ begin
      if nextval('telegram_test_fault')=1 then raise exception '시험용 교착 오류' using errcode='40P01'; end if; return new; end $$;
    create trigger telegram_test_commit before update on notify_outbox for each row when(new.state='accepted') execute function telegram_test_fail()`);
  const { processNotify } = await import('../../../apps/api/src/notify/worker.ts');
  const before = requests.filter(r => r.method === 'sendMessage').length;
  await expect(processNotify(active().pool, 1, new Date(Date.now() + 5000))).rejects.toMatchObject({ code: '40P01' });
  expect(requests.filter(r => r.method === 'sendMessage')).toHaveLength(before + 1);
  expect(await active().rows("select state,attempts from notify_outbox where kind='biz'")).toEqual([{ state: 'sending', attempts: 1 }]);
});

test('telegram: 알림 테이블 쓰기 실패도 Task 상태 저장을 막지 않는다', async () => {
  await connect();
  await active().rows('revoke insert on notify_outbox from awbs_app');
  try {
    await active().pool.query("update tasks set verif_state='fail' where task_key='TASK-0001'");
    expect((await active().rows("select verif_state from tasks where task_key='TASK-0001'"))[0]?.verif_state).toBe('fail');
    expect(await active().rows("select id from notify_events where kind='fail'")).toHaveLength(0);
  } finally { await active().rows('grant insert on notify_outbox to awbs_app'); }
});

test('telegram: 설정 유지 초기화는 이력만 지우고 검증한 연결을 유지한다', async () => {
  await connect();
  await active().rows("select public.reset_project(1,'시나리오',true,'lead')");
  const settings = await active().lead('GET', '/api/notify/telegram');
  expect(settings.body).toMatchObject({ enabled: true, tokenSet: true, bot: { username: 'fake_bot' }, test: { ok: true } });
  expect(await active().rows('select id from notify_outbox')).toEqual([]);
  expect(await active().rows('select id from notify_log')).toEqual([]);
});

test('telegram: 실제 QA FAIL은 한 번 알리고 근거 없는 done 상태는 완료 메시지를 만들지 않는다', async () => {
  const { project } = await connect();
  const rules = (await active().lead('GET', `/api/projects/${project}/notify/rules`)).body;
  await active().lead('PUT', `/api/projects/${project}/notify/rules`, { ...rules, done: true });
  await active().run('TASK-0001');
  const dev = await active().runner.startNext();
  if (!dev) throw new Error('개발 시도 없음');
  await active().runner.result(dev);
  const qa = await active().runner.startNext();
  if (!qa) throw new Error('QA 시도 없음');
  await active().runner.result(qa, 'FAIL');
  const failed = await active().rows("select payload from notify_outbox where kind='biz' and payload->>'event'='fail'");
  expect(failed).toHaveLength(1);
  expect(JSON.stringify(failed)).toContain('QA FAIL 확정');
  expect(failed[0]?.payload).toMatchObject({ path: '/wbs/TASK-0001' });
  await active().rows("update tasks set status='done' where task_key='TASK-0002'");
  expect(await active().rows("select id from notify_outbox where payload->>'event'='done'")).toEqual([]);
});

test('telegram: 변경 제안/기술 결정/입력 변경은 해당 화면을 가리키며 여섯 미리보기는 일반 텍스트다', async () => {
  const { project } = await connect();
  await active().rows(`insert into change_proposals(project_id,cp_key,title,reason,source,status,ops) values('${project}','CP-0001','변경','이유','manual','review','[]')`);
  await active().rows(`insert into tech_decisions(project_id,td_key,title,authority,status,content) values('${project}','TD-01','기술 결정','lead','pending','{}')`);
  await active().rows(`insert into input_change_commits(project_id,sha,files,state) values('${project}','${'b'.repeat(40)}','[]','pending')`);
  const pending = await active().rows("select payload->>'event' event,payload->>'path' path from notify_outbox where kind='biz' order by created_at");
  expect(pending).toEqual([{ event: 'approve', path: '/change/CP-0001' }, { event: 'approve', path: '/design' }, { event: 'admin', path: '/project' }]);
  for (const event of ['done', 'fail', 'admin', 'approve', 'buildOk', 'buildFail']) {
    const response = await active().lead('GET', `/api/projects/${project}/notify/preview?event=${event}`);
    expect(response.status).toBe(200); expect(response.body.text.length).toBeLessThanOrEqual(4096);
    expect(response.body.text).not.toContain(token);
  }
});

// M6·M7 통합: 「서로 다른 CI 행의 같은 원인 동시 실패」도 ci.db.test.ts로 옮겼다(위와 같은 이유).

test('telegram: 업무 전송 성공은 연결 오류 배지를 지우지 않고 테스트 성공을 기다린다', async () => {
  const f = await connect();
  const { processNotify } = await import('../../../apps/api/src/notify/worker.ts');
  f.fail(403);
  await active().rows("insert into runner_readiness(key,status,detail,fix,at) values('badge-fail','fail','실패','확인',now())");
  await processNotify(active().pool, 1, new Date(Date.now() + 5000));
  f.fail(0);
  await active().rows("insert into runner_readiness(key,status,detail,fix,at) values('badge-ok','fail','실패','확인',now())");
  await processNotify(active().pool, 1, new Date(Date.now() + 10000));
  expect((await active().lead('GET', '/api/alerts')).body.items.some((a: { key: string }) => a.key === 'telegram-connection')).toBe(true);
});
