import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ApiError, createApiClient } from '../src/api/client.ts';
import { Secret } from '../src/security/secret.ts';
import { createRedactor } from '../src/security/redact.ts';
import { State } from '../src/state/state.ts';
import { Outbox } from '../src/api/outbox.ts';
import { Evidence } from '../src/ci/night/steps.ts';

const token = 'm803-runner-token-0123456789abcdefghijk';
const password = 'm803 password with spaces';

test('서버 계약이 허용하는 최소 길이의 Telegram 토큰도 자유 글에서 가린다', () => {
  const telegram = `123456789:${'a'.repeat(20)}`;
  expect(createRedactor()(`결과 ${telegram}`)).not.toContain(telegram);
});

test.each(['API /bottleneck 해결', 'sort_key=asc 도입', 'monkey=value', 'primary_key: id', '--sort-key asc', 'public_key=ssh-rsa', `${'normal_'.repeat(100)}sort_key=asc`])('평범한 경로·정렬 키를 보존한다: %s', input => {
  expect(createRedactor()(input)).toBe(input);
});

test('YAML의 password 객체 정의는 다음 줄의 type을 비밀번호로 가리지 않는다', () => {
  const schema = 'properties:\n  password:\n    type: string\n  sort_key: asc';
  expect(createRedactor()(schema)).toBe(schema);
});

test.each(['password: hunter2xyz', `SMTP_PASSWORD: "${password}"`, `--password "${password}"`, '--password hunter2xyz',
  'X-Api-Key: hunter2xyz', "{'password': 'hunter2xyz'}", 'OPENAI_API_KEY=hunter2xyz'])('콜론·명령 인자의 비밀을 가린다: %s', input => {
  const output = createRedactor()(input);
  expect(output).not.toContain('hunter2xyz');
  expect(output).not.toContain(password);
  expect(output).toContain('[REDACTED]');
  expect(createRedactor()(output)).toBe(output);
});

test.each([201, 302, 400])('선언되지 않은 HTTP %s의 오류도 인증 정보를 보관하지 않는다', async status => {
  const api = createApiClient({ baseUrl: 'http://127.0.0.1:1', token: new Secret(token),
    fetch: async () => Response.json({ error: { code: 'BAD_PROXY', message: token } }, { status }) });
  const caught: unknown = await api('reportUsage', { epoch: 1, idempotencyKey: 'test', body: { agent: 'Codex', remainPct: 1 } }).catch((e: unknown) => e);
  expect(caught).toBeInstanceOf(ApiError);
  expect(JSON.stringify(caught)).not.toContain(token);
});

test.each([`SMTP_PASSWORD="${password}"`, `SMTP_PASSWORD='${password}'`, `password="${password}"`, 'AWBS_SECRET_KEY=m803-key-canary'])('따옴표 안의 환경 변수도 가린다: %s', input => {
  const output = createRedactor()(input);
  expect(output).not.toContain(password);
  expect(output).not.toContain('m803-key-canary');
  expect(output).toContain('[REDACTED]');
});

test('서버 오류가 인증 토큰을 되비춰도 응답·오류·거부 기록 파일에 남지 않는다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awbs-m803-'));
  const state = await State.open(home);
  try {
    const detail = { code: 'VALIDATION_FAILED', message: `거절 ${token}`, fix: `SMTP_PASSWORD="${password}"`, details: { nested: token },
      requestId: 'secret-test', action: '시험', errors: [] };
    const api = createApiClient({ baseUrl: 'http://127.0.0.1:1', token: new Secret(token),
      fetch: async () => Response.json({ error: detail }, { status: 400, headers: { 'retry-after': token } }) });
    const error: unknown = await api('reportUsage', { epoch: 1, idempotencyKey: 'secret-test', body: { agent: 'Codex', remainPct: 1 } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(JSON.stringify(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(password);
    await state.update(s => { s.epoch = 1; });
    const outbox = new Outbox(state, api);
    await outbox.enqueue('reportUsage', { epoch: 1, body: { agent: 'Codex', remainPct: 1 } });
    await outbox.flush();
    expect(outbox.rejected).toHaveLength(1);
    for (const path of await readdir(home, { recursive: true })) {
      const bytes = await readFile(join(home, path)).catch(e => { if (e.code === 'EISDIR') return Buffer.alloc(0); throw e; });
      expect(bytes.toString()).not.toContain(token);
      expect(bytes.toString()).not.toContain(password);
    }
  } finally { await state.close(); await rm(home, { recursive: true, force: true }); }
});

test('CI 로그 파일은 명령 인자·표준 출력·오류 출력을 모두 가린다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awbs-m803-ci-'));
  try {
    const evidence = await Evidence.open(home, crypto.randomUUID(), createRedactor([token]));
    await evidence.run(async () => ({ code: 0, stdout: token, stderr: `SMTP_PASSWORD="${password}"` }), ['tool', token], home, 'secrets', {});
    expect(evidence.artifacts).toHaveLength(1);
    const log = await readFile(join(home, evidence.artifacts[0] ?? ''), 'utf8');
    expect(log).toContain('$ tool');
    expect(log).not.toContain(token);
    expect(log).not.toContain(password);
    await evidence.finish({ note: token, password });
    const meta = await readFile(join(evidence.runnerDir, 'run.json'), 'utf8');
    expect(meta).not.toContain(token);
    expect(meta).not.toContain(password);
  } finally { await rm(home, { recursive: true, force: true }); }
});
