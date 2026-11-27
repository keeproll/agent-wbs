// 계약 보완(2026-11-26): M4-04 계약 문구, GitHub 권한 3상태(조정자 결정), 모델 순서·Claude 목록(owner 아이템 8),
// 검증된 CLI 조합을 Runner에 주는 경로(M4-02 지적 6-2).
import { Ajv } from 'ajv';
import { describe, expect, test } from 'vitest';
import { inputErrors, OPERATIONS, renderOpenApi } from '@awbs/shared/api';
import { DEFAULT_MODEL_SETTINGS, compareCodexModels, modelRanks, placeModel } from '@awbs/shared';

const ajv = new Ajv({ strict: false });
const operation = (id: string) => {
  const found = OPERATIONS.find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
};
const accepts = (id: string, body: unknown) => ajv.validate(operation(id).body ?? false, body);
const responds = (id: string, value: unknown, status = 200) =>
  ajv.validate((operation(id).responses as Record<number, unknown>)[status] ?? false, value);

describe('Runner 모델 보고: rank는 서버 설정값', () => {
  const model = { id: 'gpt-6.2-sol', label: '6.2 sol', efforts: ['low', 'max'] };
  test('rank 없이 보고한다', () => {
    expect(accepts('reportModels', { agent: 'Codex', models: [model] })).toBe(true);
  });
  test('rank를 보내면 형식 오류다(서버가 정한다)', () => {
    expect(accepts('reportModels', { agent: 'Codex', models: [{ ...model, rank: 3 }] })).toBe(false);
  });
});

describe('모델 설정: 순서·Codex 계열 순서·Claude 목록', () => {
  const read = {
    updatedAt: null,
    models: [{ agent: 'Claude', id: 'claude-opus-5-5', label: 'claude-opus-5-5', rank: 3, allowed: true, isNew: false, efforts: null }],
    rankOrder: DEFAULT_MODEL_SETTINGS.rankOrder,
    codexFamilyOrder: DEFAULT_MODEL_SETTINGS.codexFamilyOrder,
    claudeModels: DEFAULT_MODEL_SETTINGS.claudeModels,
  };
  test('조회 응답에 세 설정이 모두 있다', () => {
    expect(responds('getModelSettings', read)).toBe(true);
    const missing: Partial<typeof read> = { ...read };
    delete missing.claudeModels;
    expect(responds('getModelSettings', missing)).toBe(false);
  });
  test('저장은 허용만 바꿔도 되고, 순서·목록은 고칠 때만 보낸다', () => {
    const allow = { updatedAt: null, models: [{ agent: 'Claude', id: 'claude-opus-5-5', allowed: true }] };
    expect(accepts('putModelSettings', allow)).toBe(true);
    expect(accepts('putModelSettings', { ...allow, rankOrder: { Claude: ['a', 'b'], Codex: [] } })).toBe(true);
    expect(accepts('putModelSettings', { ...allow, rankOrder: { Claude: ['a', 'a'], Codex: [] } })).toBe(false);
    expect(accepts('putModelSettings', { ...allow, claudeModels: [] })).toBe(false);
    expect(accepts('putModelSettings', { ...allow, codexFamilyOrder: ['luna', 'sol'] })).toBe(true);
  });
});

describe('초기 모델 순서(owner 2026-11-26 아이템 8)', () => {
  test('Claude: Haiku 5.5 < Sonnet 5.5 < Opus 5.5 < Fable 5.2', () => {
    expect(DEFAULT_MODEL_SETTINGS.rankOrder.Claude).toEqual([
      'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2',
    ]);
  });
  test('Claude 목록 = Q-06 승인표의 Claude 모델', () => {
    expect([...DEFAULT_MODEL_SETTINGS.claudeModels].sort()).toEqual(
      ['claude-fable-5-2', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'],
    );
  });
  test('Codex: 세대가 높을수록 위, 같은 세대는 luna < terra < astra < sol', () => {
    expect(DEFAULT_MODEL_SETTINGS.codexFamilyOrder).toEqual(['luna', 'terra', 'astra', 'sol']);
    expect(DEFAULT_MODEL_SETTINGS.rankOrder.Codex).toEqual([
      'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-6-sol',
      'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6.2-astra', 'gpt-6.2-sol',
    ]);
  });
  test('세대 비교는 숫자로 한다(5.6 < 6 < 6.1 < 6.2, 6.10 > 6.2)', () => {
    const sorted = ['gpt-6.2-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-6.10-sol', 'gpt-6.1-sol'].sort(compareCodexModels);
    expect(sorted).toEqual(['gpt-5.6-sol', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6.10-sol']);
  });
  test('CLI 목록 순서는 쓰지 않는다: 6.1-sol은 6.1-terra보다 위', () => {
    expect(['gpt-6.1-sol', 'gpt-6.1-terra'].sort(compareCodexModels)).toEqual(['gpt-6.1-terra', 'gpt-6.1-sol']);
  });
});

describe('새 모델의 자리(설정에 없는 모델)', () => {
  const codex = DEFAULT_MODEL_SETTINGS.rankOrder.Codex;
  const family = DEFAULT_MODEL_SETTINGS.codexFamilyOrder;
  test('Codex 새 모델은 규칙대로 끼워 넣는다', () => {
    expect(placeModel(codex, 'gpt-6.3-sol', 'Codex', family).at(-1)).toBe('gpt-6.3-sol');
    const next = placeModel(codex, 'gpt-6.1-astra', 'Codex', family);
    expect(next.slice(next.indexOf('gpt-6.1-terra'), next.indexOf('gpt-6.1-terra') + 3)).toEqual([
      'gpt-6.1-terra', 'gpt-6.1-astra', 'gpt-6.1-sol',
    ]);
  });
  test('팀장이 바꾼 순서는 그대로 두고 새 모델만 끼운다', () => {
    const custom = ['gpt-6.2-sol', 'gpt-6-sol'];
    expect(placeModel(custom, 'gpt-6.1-sol', 'Codex', family)).toEqual(['gpt-6.2-sol', 'gpt-6-sol', 'gpt-6.1-sol']);
  });
  test('읽을 수 없는 이름과 Claude 새 모델은 맨 아래', () => {
    expect(placeModel(codex, 'codex-mini', 'Codex', family)[0]).toBe('codex-mini');
    expect(placeModel(DEFAULT_MODEL_SETTINGS.rankOrder.Claude, 'claude-new-6', 'Claude', family)[0]).toBe('claude-new-6');
  });
  test('이미 있는 모델은 자리를 바꾸지 않는다', () => {
    expect(placeModel(codex, 'gpt-6-sol', 'Codex', family)).toEqual(codex);
  });
  test('rank는 아래부터 1, 2, …(클수록 위 등급)', () => {
    expect(modelRanks(['a', 'b', 'c'])).toEqual(new Map([['a', 1], ['b', 2], ['c', 3]]));
  });
});

describe('GitHub 연결 상태: 권한 3상태(조정자 결정 2026-11-26)', () => {
  const scopes = { contents: 'unverified', pulls: 'unverified', statuses: 'unverified', metadata: 'verified' };
  const status = { mode: 'token', ok: true, account: 'bot', scopes, expiresAt: null, warning: '쓰기 권한 미확인' };
  test('각 권한은 verified·unverified·missing 중 하나다', () => {
    expect(accepts('reportGithubStatus', status)).toBe(true);
    expect(accepts('reportGithubStatus', { ...status, scopes: { ...scopes, pulls: true } })).toBe(false);
    expect(accepts('reportGithubStatus', { ...status, scopes: { ...scopes, pulls: 'unknown' } })).toBe(false);
    expect(accepts('reportGithubStatus', { ...status, ok: false, scopes: null, warning: undefined, error: '인증 실패' })).toBe(true);
  });
  test('ok는 인증되고 missing이 없을 때만 true다', () => {
    const op = operation('reportGithubStatus');
    expect(inputErrors(op, status)).toEqual([]);
    expect(inputErrors(op, { ...status, scopes: { ...scopes, pulls: 'missing' } })).toEqual([
      { path: 'ok', rule: 'githubStatusConsistent', message: 'missing 권한이 있으면 ok는 false여야 합니다.' },
    ]);
    expect(inputErrors(op, { ...status, scopes: null, warning: undefined })).toEqual([
      { path: 'ok', rule: 'githubStatusConsistent', message: '권한을 확인하지 못했으면(scopes null) ok는 false여야 합니다.' },
    ]);
  });
  test('unverified가 있으면 warning이 필요하다', () => {
    const noWarning: Partial<typeof status> = { ...status };
    delete noWarning.warning;
    expect(inputErrors(operation('reportGithubStatus'), noWarning)).toEqual([
      { path: 'warning', rule: 'githubStatusConsistent', message: '확인하지 못한 권한(unverified)이 있으면 warning이 필요합니다.' },
    ]);
    expect(operation('reportGithubStatus').errors).toContain('VALIDATION_FAILED');
  });
  test('팀장 화면의 GitHub 설정도 같은 3상태와 경고를 보인다', () => {
    const read = { mode: 'token', tokenSet: true, status: 'ok', account: 'bot', scopes, warning: '쓰기 권한 미확인', expiresAt: null, updatedAt: null };
    expect(responds('getGithubSettings', read)).toBe(true);
    expect(responds('getGithubSettings', { ...read, scopes: { ...scopes, contents: true } })).toBe(false);
    expect(responds('getGithubSettings', { ...read, warning: null })).toBe(true);
  });
});

describe('봉인 자격 증명: 공개키 등록과 keyId 조회(M4-04 문구 1)', () => {
  const key = {
    runnerId: 'runner-1', hostId: 'host-1', bootId: 'boot-1',
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAB6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=\n-----END PUBLIC KEY-----\n',
    sealedVersion: 1,
  };
  test('POST /api/runner/github/key는 Runner가 부르고 keyId를 돌려준다', () => {
    const op = operation('registerGithubKey');
    expect([op.method, op.path, op.principal]).toEqual(['POST', '/api/runner/github/key', 'runner']);
    expect(accepts('registerGithubKey', key)).toBe(true);
    expect(accepts('registerGithubKey', { ...key, sealedVersion: 2 })).toBe(false);
    expect(responds('registerGithubKey', { keyId: 'abc' })).toBe(true);
  });
  test('credential은 등록된 keyId로만 조회하고, 모르는 키는 404 NOT_FOUND다', () => {
    const op = operation('getGithubCredential');
    expect(ajv.validate(op.query ?? false, { keyId: 'abc' })).toBe(true);
    expect(ajv.validate(op.query ?? false, {})).toBe(false);
    expect(op.errors).toContain('NOT_FOUND');
  });
});

describe('Runner 정책 묶음: Claude 목록과 CLI 관측 등급', () => {
  const policy = {
    caps: { total: 16, Claude: 12, Codex: 12, heavy: 6, memReserveGB: 4 },
    subagentBudget: { dev: 2, qa: 3 },
    heartbeatSeconds: 60,
    inputCheckMinutes: 5,
    ci: { taskCmds: [], intCmds: [], nightAt: '02:00', retry: 1, deployUrl: null, quarantined: [] },
    claudeModels: ['claude-haiku-5-5'],
    cliGrades: [{ agent: 'Codex', version: '0.172.0', model: 'gpt-6.1-sol', options: 'exec --json', grade: 'partial' }],
  };
  test('claudeModels와 cliGrades가 필수다', () => {
    const op = operation('getRunnerPolicy');
    const schema = op.responses[200] as { required?: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(['claudeModels', 'cliGrades']));
    const grade = (operation('getRunnerPolicy').responses[200] as { properties: Record<string, unknown> }).properties.cliGrades;
    expect(ajv.validate(grade as object, policy.cliGrades)).toBe(true);
    expect(ajv.validate(grade as object, [{ ...policy.cliGrades[0], grade: 'ok' }])).toBe(false);
  });
});

test('OpenAPI에 새 경로와 규칙이 보인다', () => {
  const doc = JSON.parse(renderOpenApi(OPERATIONS)) as { paths: Record<string, Record<string, { 'x-input-rules'?: string[] }>> };
  expect(doc.paths['/api/runner/github/key']?.post).toBeDefined();
  expect(doc.paths['/api/runner/github/status']?.post?.['x-input-rules']).toEqual(['githubStatusConsistent']);
});

test('키 등록 복구는 새 Idempotency-Key로 보낸다고 계약에 적혀 있다(리뷰 지적 4)', async () => {
  const { readFileSync } = await import('node:fs');
  const contracts = readFileSync(new URL('../../../../../docs/plan/contracts.md', import.meta.url), 'utf8');
  const section = contracts.slice(contracts.indexOf('- POST `/runner/github/key`'), contracts.indexOf('- GET `/runner/github/credential'));
  expect(section).toContain('404 뒤 다시 등록할 때는 새 `Idempotency-Key`를 만든 새 요청으로 보낸다.');
  expect(section).toContain('같은 키를 유지한다');
});
