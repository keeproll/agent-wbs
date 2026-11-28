import { readFileSync } from 'node:fs';
import { Validator } from '@seriousme/openapi-schema-validator';
import { Ajv } from 'ajv';
import type { TSchema } from 'typebox';
import { expect, test } from 'vitest';
import { errorBody } from '../../src/errors.ts';
import { ErrorResponse, OPERATIONS, operation, renderOpenApi, usesEpoch, type Operation } from '../../src/api/index.ts';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
// Fastify 기본 검증기와 같은 ajv·draft-07. 형 변환은 켜지 않는다.
const ajv = new Ajv({ strict: false });
const op = (id: string): Operation => {
  const found = OPERATIONS.find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
};
const accepts = (id: string, body: unknown) => ajv.validate(op(id).body ?? false, body);
const schemas = (item: Operation) =>
  [item.params, item.query, item.body, ...Object.values(item.responses)].filter((s): s is TSchema => Boolean(s));

const T = '2026-11-25T01:02:03.123456Z';
const SHA = 'a'.repeat(40);

test('Q-07: Workflow의 liveInject는 요청·응답 모두 false만 허용한다', () => {
  const value = { updatedAt: T, devAgent: 'Claude', qaAgent: 'Codex', liveInject: false, heartbeatSeconds: 60, missedHeartbeats: 3 };
  expect(accepts('putWorkflowSettings', value)).toBe(true);
  expect(accepts('putWorkflowSettings', { ...value, liveInject: true })).toBe(false);
  expect(ajv.validate(op('getWorkflowSettings').responses[200] ?? false, value)).toBe(true);
  expect(ajv.validate(op('getWorkflowSettings').responses[200] ?? false, { ...value, liveInject: true })).toBe(false);
});

interface Fixture {
  id: string;
  query?: unknown;
  body?: unknown;
  status: number;
  response?: unknown;
}

test('커밋된 openapi.json이 스키마와 같고 OpenAPI 3.1로 유효하다', async () => {
  const text = read('contracts/openapi.json');
  expect(text).toBe(renderOpenApi(OPERATIONS));
  const validator = new Validator();
  const result = await validator.validate(JSON.parse(text) as Record<string, unknown>);
  expect(result.errors ?? []).toEqual([]);
  expect(result.valid).toBe(true);
  expect(validator.version).toBe('3.1');
});

test('모든 스키마가 Fastify 검증기에서 컴파일된다', () => {
  for (const item of OPERATIONS) for (const schema of schemas(item)) expect(() => ajv.compile(schema), item.id).not.toThrow();
});

test('오류 본문은 기존 errorBody와 같은 형식이고 정의한 코드만 받는다', () => {
  const body = errorBody({ code: 'VERSION_CONFLICT', message: 'm', action: 'a', fix: 'f', requestId: 'r' });
  expect(ajv.validate(ErrorResponse, body)).toBe(true);
  expect(ajv.validate(ErrorResponse, { error: { ...body.error, code: 'MADE_UP' } })).toBe(false);
});

test('Runner fixture가 모든 Runner·Planning API를 덮고 스키마를 통과한다', () => {
  const fixtures = JSON.parse(read('contracts/fixtures/runner.json')) as Fixture[];
  const runnerIds = OPERATIONS.filter((item) => item.principal === 'runner').map((item) => item.id);
  expect(fixtures.map((item) => item.id).sort()).toEqual([...runnerIds].sort());
  for (const fixture of fixtures) {
    const { query, body, responses } = op(fixture.id);
    expect(fixture.status in responses, fixture.id).toBe(true);
    if (query) expect(ajv.validate(query, fixture.query), `${fixture.id} query`).toBe(true);
    expect(body === undefined, `${fixture.id} body 유무`).toBe(fixture.body === undefined);
    if (body) expect(ajv.validate(body, fixture.body), `${fixture.id} ${ajv.errorsText()}`).toBe(true);
    const response = responses[fixture.status];
    expect(!response, `${fixture.id} 응답 유무`).toBe(fixture.response === undefined);
    if (response) expect(ajv.validate(response, fixture.response), `${fixture.id} ${ajv.errorsText()}`).toBe(true);
  }
});

test('Runner 규칙: epoch는 전부, 이전 epoch 허용은 3개, 멱등 키는 heartbeat만 예외', () => {
  const runner = OPERATIONS.filter((item) => item.principal === 'runner');
  expect(runner.every(usesEpoch)).toBe(true);
  expect(OPERATIONS.filter(usesEpoch)).toEqual(runner);
  expect(runner.filter((item) => item.staleEpoch).map((item) => item.id).sort()).toEqual([
    'getCommands', 'heartbeat', 'reportCommandResult',
  ]);
  for (const item of runner) {
    expect(item.errors, item.id).toContain('RUNNER_UNAUTHORIZED');
    if (!item.staleEpoch) expect(item.errors, item.id).toContain('EPOCH_MISMATCH');
    const write = item.method !== 'GET' && item.id !== 'heartbeat';
    expect(item.idempotency, item.id).toBe(write ? 'required' : 'none');
    expect(item.errors.includes('IDEMPOTENCY_KEY_REQUIRED'), item.id).toBe(write);
  }
  // 시도·job 경로의 보고는 fence를 포함한다(contracts §3.2-4).
  for (const item of runner.filter((o) => /:(attemptId|jobId)|\/jobs\/:id|repo-checks|\/planning\//.test(o.path) && o.body)) {
    const body = item.body as { anyOf?: { required: string[] }[]; required?: string[] };
    for (const branch of body.anyOf ?? [body]) expect(branch.required, item.id).toContain('fence');
    expect(item.errors, item.id).toContain('LEASE_LOST');
  }
});

test('팀장 수정은 §1.3 표대로 expected version을 요구한다', () => {
  const lead = OPERATIONS.filter((item) => item.principal === 'lead' && item.method !== 'GET');
  const none = lead.filter((item) => item.version === 'none').map((item) => item.id).sort();
  // 생성·확인·테스트 발송·job 생성, 수동 발송·재발송, 로그아웃, 읽음 표시
  expect(none).toEqual(
    [
      'ackAlert', 'addRecipient', 'addVerificationEvidence', 'checkGithub', 'checkReadiness', 'checkSmtp', 'checkTelegramBot', 'createMessage',
      'createPlanning', 'createPlanningProposal', 'createProject', 'createProposal', 'createRepoCheck',
      'createReport', 'createTask', 'findTelegramChats', 'logout', 'readMessage', 'requestDeployCheck',
      'resendFailedMail', 'resendMail', 'retryCiRun', 'runReplan', 'sendReportMail', 'testRecipient', 'testTelegram',
    ].sort(),
  );
  const required = (schema: TSchema | undefined): string[] => {
    const object = schema as { required?: string[]; anyOf?: TSchema[] } | undefined;
    return object?.required ?? object?.anyOf?.map(required).reduce((common, branch) => common.filter((field) => branch.includes(field))) ?? [];
  };
  for (const item of lead) {
    if (item.version === 'body') expect(required(item.body), item.id).toContain('updatedAt');
    if (item.version === 'query') expect(required(item.query), item.id).toContain('updatedAt');
    if (item.version !== 'none') expect(item.errors, item.id).toContain('VERSION_CONFLICT');
    if (item.method === 'DELETE' && item.id !== 'logout') expect(item.version, item.id).toBe('query');
  }
  expect(required(op('approveBootstrap').body)).toEqual(['revision']);
  expect(required(op('rerunBootstrap').body)).toContain('revision');
  expect(required(op('resetProject').body)).toEqual(['confirmName', 'keepSettings', 'epoch']);
  expect(required(op('applyProposal').body)).toEqual(['updatedAt', 'previewHash']);
  expect(required(op('stopAttempt').body)).toEqual(['updatedAt', 'attemptUpdatedAt']);
  expect(required(op('analyzeInputs').body)).toEqual(['updatedAt', 'commit', 'commits']);
  expect(accepts('confirmTech', { decisions: [{ id: 'd', choice: 'approve' }] })).toBe(false);
});

test('정의 시점에 계약 위반 라우트를 거부한다', () => {
  const base = { id: 'x', summary: '', responses: { 204: null } } as const;
  expect(() => operation({ ...base, method: 'PUT', path: '/api/x', principal: 'lead' })).toThrow('version 규칙');
  expect(() => operation({ ...base, method: 'PUT', path: '/api/x', principal: 'lead', version: 'body' })).toThrow('필드가 없다');
  expect(() => operation({ ...base, method: 'GET', path: '/api/runner/x', principal: 'lead' })).toThrow('Runner 토큰');
});

test.each<[string, unknown, boolean]>([
  // 상태는 API로 바꿀 수 없다(§5.5)
  ['updateTask', { updatedAt: T, status: 'done' }, false],
  ['updateTask', { updatedAt: T }, false],
  ['updateTask', { title: 'x' }, false],
  ['updateTask', { updatedAt: T, priority: 0 }, true],
  ['updateTask', { updatedAt: T, priority: 4 }, false],
  ['updateTask', { updatedAt: '2026-11-25T10:02:03+09:00', priority: 0 }, false],
  ['updateTask', { updatedAt: T, title: 'x'.repeat(201) }, false],
  ['addDependency', { updatedAt: T, predTaskKey: 'TASK-0005', depType: 'FF' }, false],
  // QA 결과: 검사한 SHA가 없으면 근거가 아니다
  ['reportAttemptResult', { fence: 1, summary: '', changedFiles: ['src/a.ts'], evidence: [] }, true],
  ['reportAttemptResult', { fence: 1, summary: '', changedFiles: [], evidence: [], verification: { result: 'PASS' } }, false],
  ['reportAttemptResult', { summary: '', changedFiles: [], evidence: [] }, false],
  ...['/etc/passwd', '../x', 'a/../../x', 'a/./b', 'C:/x', 'a\\b', 'a//b', 'x\n/../y', ''].map(
    (path): [string, unknown, boolean] => [
      'reportAttemptResult', { fence: 1, summary: '', changedFiles: [path], evidence: [] }, false,
    ],
  ),
  ['reportAttemptResult', { fence: 1, summary: '', changedFiles: ['.env.example', 'a/..b/c'], evidence: [] }, true],
  // 실제 사용 여부는 사후 확정(D-12)
  ['reportAttemptStatus', { fence: 1, status: 'running', at: T, model: 'm', effort: 'e', subagents: [{ id: 'a', version: 1, installed: true, used: true }] }, false],
  ['reportSession', { runnerId: 'r', event: 'stop', at: T, reason: 'unknown' }, false],
  ['reportUsage', { agent: 'Claude', remainPct: 101 }, false],
  ['reportHost', { hostId: 'h', bootId: 'b', cpu: '', swapGB: 0, diskFreeGB: 0, os: '' }, false],
  ['reportModels', { agent: 'Codex', models: [] }, false],
  ['updateCiRun', { fence: 1 }, false],
  ['releaseJob', { fence: 1, hostId: 'h', proof: { kind: 'lease_expired', bootId: 'b' }, at: T }, false],
  ['claimJob', { kinds: ['reset-cleanup'], capacity: 1 }, false],
  ['createRepoCheck', { url: 'https://github.com/o/r' }, true],
  ['createRepoCheck', { url: 'https://github.com/o/r/' }, true],
  ['createRepoCheck', { url: 'https://github.com/o/r.git' }, true],
  ['createRepoCheck', { url: 'https://github.com/o/r/tree/main' }, false],
  ['createRepoCheck', { url: 'https://user:pw@github.com/o/r' }, false],
  ['createProject', { name: 'n', url: 'https://github.com/o/r', constraints: [{ name: 'QuestDB', level: 'cond' }], instruction: '', repoCheckId: 'c' }, false],
  ['putTelegram', { updatedAt: T, enabled: true, targetName: '', chatId: '-1001234567890' }, true],
  ['putTelegram', { updatedAt: T, enabled: true, targetName: '', chatId: '@user' }, false],
  ['putTelegram', { updatedAt: T, enabled: true, targetName: '', chatId: '12345', botToken: '●●●● 등록됨 (끝 4자리)' }, false],
  ['putTelegram', { updatedAt: T, enabled: true, targetName: '', chatId: '12345', botToken: '' }, false],
  ['login', { method: 'link', token: 't', password: 'p' }, false],
  ['login', { method: 'pin', pin: '261128' }, true],
  ['login', { method: 'pin', pin: '12345' }, false],
  ['login', { method: 'pin', pin: '1234567' }, false],
  ['login', { method: 'pin', pin: '12345x' }, false],
  ['login', { method: 'password', password: 'p' }, false],
  ['createProposal', { title: 't', reason: 'r', source: { kind: 'manual' }, ops: [{ op: 'modify', task: 'TASK-0001', field: 'status', after: 'done' }] }, false],
  ['createProposal', { title: 't', reason: 'r', source: { kind: 'manual' }, ops: [{ op: 'modify', task: 'TASK-0001', field: 'priority', after: '긴급' }] }, false],
  ['reportInputChanges', { commits: [{ sha: 'e7d41b0', at: T, author: '', message: '' }], files: [{ commitSha: SHA, path: 'prototype/docs/a.md', change: 'added', added: 1, deleted: 0 }] }, false],
])('%s %j → %s', (id, body, expected) => {
  expect(accepts(id, body)).toBe(expected);
});

test('응답에 비밀값 필드가 없고 입력 비밀값은 쓰기 전용이다', () => {
  const visit = (value: unknown, found: string[]): string[] => {
    if (typeof value !== 'object' || value === null) return found;
    for (const [key, item] of Object.entries(value)) {
      if (/^(botToken|token|pin|password|secret|credential)$/i.test(key)) found.push(key);
      if (key === 'writeOnly') found.push(key);
      visit(item, found);
    }
    return found;
  };
  for (const item of OPERATIONS) {
    for (const response of Object.values(item.responses)) expect(visit(response, []), item.id).toEqual([]);
  }
  const inputs = OPERATIONS.flatMap((item) =>
    Object.entries((item.body as { properties?: Record<string, { writeOnly?: boolean }> } | undefined)?.properties ?? {})
      .filter(([key]) => /token$|password/i.test(key))
      .map(([key, schema]) => `${item.id}.${key}:${String(schema.writeOnly)}`),
  );
  expect(inputs.sort()).toEqual([
    'checkTelegramBot.botToken:true', 'findTelegramChats.botToken:true', 'putGithubSettings.token:true',
    'putSmtp.password:true', 'putTelegram.botToken:true', 'testTelegram.botToken:true',
  ]);
  const env = JSON.stringify(op('getTaskSubagents').responses[200]);
  expect(env).not.toMatch(/"(model|effort)"/);
  expect(env).toContain('"key"');
});

/** 프로토타입의 JSON 예시에서 최상위 필드와 선택 여부를 읽는다. */
function topFields(code: string): Map<string, boolean> {
  const fields = new Map<string, boolean>();
  const query = code.startsWith('Query');
  let depth = 0;
  for (const token of code.matchAll(/\/\/[^\n]*|[[{]|[\]}]|"(\w+)"(\?)?:|^ {2}(\w+)(\?)?:/gm)) {
    const text = token[0];
    if (text.startsWith('//')) continue;
    if (/^[[{]$/.test(text)) depth += 1;
    else if (/^[\]}]$/.test(text)) depth -= 1;
    else if (token[1] && depth === 1) fields.set(token[1], token[2] === '?');
    else if (token[3] && query) fields.set(token[3], token[4] === '?');
  }
  return fields;
}

const REPLACED = new Set(['reportModels.efforts', 'reportAttemptStatus.escalation']);

test('프로토타입 요청·응답 필드가 같은 이름과 필수 여부로 있다', () => {
  const html = readFileSync(new URL('../prototype/uiux/Main.dc.html', root), 'utf8');
  const unescape = (code: string) => code.replaceAll('\\n', '\n').replaceAll("\\'", "'");
  let compared = 0;
  for (const [, method, path, request = '', response = ''] of html.matchAll(
    /E\(\{method:'(\w+)', path:'([^']+)'.*?\}, \{request:'([^']*)', response:'([^']*)'/g,
  )) {
    const item = OPERATIONS.find((o) => o.method === method && o.path === path);
    if (!item) throw new Error(`${method ?? ''} ${path ?? ''}`);
    const input = (item.query && method === 'GET' ? item.query : item.body) as
      | { properties?: Record<string, unknown>; required?: string[]; anyOf?: { properties: Record<string, unknown>; required: string[] }[] }
      | undefined;
    const object = input?.anyOf?.[0] ?? input;
    for (const [name, optional] of topFields(unescape(request))) {
      // 모델별 efforts(owner Q-06)와 adjust(contracts §3.1)가 대신한다.
      if (REPLACED.has(`${item.id}.${name}`)) continue;
      compared += 1;
      expect(object?.properties, `${item.id} 요청`).toHaveProperty(name);
      // cursor를 우선 쓰므로 since는 선택(contracts §3.1)
      if (item.id !== 'pollMessages') {
        expect(object?.required?.includes(name) ?? false, `${item.id}.${name} 필수`).toBe(!optional);
      }
    }
    const status = Number(/^\d+/.exec(response)?.[0]);
    if (!response.includes('{')) {
      expect(status in item.responses, `${item.id} ${String(status)}`).toBe(true);
      continue;
    }
    const output = item.responses[status] as { properties?: Record<string, unknown> } | null | undefined;
    for (const name of topFields(unescape(response)).keys()) {
      compared += 1;
      expect(output?.properties, `${item.id} 응답`).toHaveProperty(name);
    }
  }
  expect(compared).toBe(99);
});
