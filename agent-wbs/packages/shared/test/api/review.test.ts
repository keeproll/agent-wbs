// M1-02 교차 리뷰 F1~F9와 판정표의 회귀 검사
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { expect, test } from 'vitest';
import { buildOpenApi, ERROR_STATUS, OPERATIONS, type Operation } from '../../src/api/index.ts';

const root = new URL('../../../../', import.meta.url);
const ajv = new Ajv({ strict: false });
const op = (id: string): Operation => {
  const found = OPERATIONS.find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
};
const accepts = (id: string, body: unknown) => ajv.validate(op(id).body ?? false, body);
const responds = (id: string, body: unknown, status = 200) => ajv.validate(op(id).responses[status] ?? false, body);
const fixtures = <T>(name: string) => JSON.parse(readFileSync(new URL(`contracts/fixtures/${name}.json`, root), 'utf8')) as T[];
interface Fixture {
  id: string;
  body: Record<string, unknown>;
}
const runner = (id: string) => {
  const found = fixtures<Fixture>('runner').find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found.body;
};
const T = '2026-11-25T01:02:03.123456Z';

const JOB_REPORTS = [
  'startCiRun', 'reportMergeQueue', 'reportDesignSnapshot', 'submitEstimates', 'requestReplan', 'createPlanningSession',
  'submitPlanningAnalysis', 'submitPlanningReviews', 'submitPlanningProposal', 'submitTaskPlan', 'createDecision',
];
test.each(JOB_REPORTS)('F1 %s: jobId와 fence가 없으면 거부하고 LEASE_LOST를 선언한다', (id) => {
  const body = runner(id);
  expect(accepts(id, body)).toBe(true);
  for (const key of ['jobId', 'fence']) {
    expect(accepts(id, Object.fromEntries(Object.entries(body).filter(([name]) => name !== key))), key).toBe(false);
  }
  expect(op(id).errors).toEqual(expect.arrayContaining(['LEASE_LOST', 'NOT_FOUND']));
});

test('F1 CI 갱신은 실행의 fence를 받고, job 없는 시작은 야간 점검뿐이다', () => {
  expect(accepts('updateCiRun', { status: 'pass' })).toBe(false);
  expect(accepts('updateCiRun', { fence: 3 })).toBe(false);
  expect(accepts('updateCiRun', { fence: 3, status: 'pass' })).toBe(true);
  expect(accepts('updateCiRun', { fence: null, status: 'pass' })).toBe(true);
  expect(op('updateCiRun').errors).toContain('LEASE_LOST');
  expect(accepts('startCiRun', { stage: 'night', ref: 'main' })).toBe(true);
  for (const stage of ['task', 'int', 'deploy']) expect(accepts('startCiRun', { stage, ref: 'main' })).toBe(false);
});

test('F2 취소 CP의 영향: 풀리는 후속과 아직 막힌 후속을 구분해야 한다', () => {
  const valid = fixtures<{ id: string; status: number; response: Record<string, unknown> }>('lead').filter((item) =>
    ['previewProposal', 'applyProposal'].includes(item.id));
  expect(valid.map((item) => item.id).sort()).toEqual(['applyProposal', 'previewProposal']);
  for (const { id, response } of valid) {
    expect(responds(id, response)).toBe(true);
    const impact = response.impact as { unblockedSuccessors: { remainingBlockers: unknown[] }[]; removedDependencies: object[] };
    expect(impact.unblockedSuccessors.map((s) => s.remainingBlockers.length)).toEqual([0, 1]);
    for (const broken of [
      undefined, {}, { ...impact, removedDependencies: undefined }, { ...impact, unblockedSuccessors: [{ taskKey: 'TASK-0001' }] },
    ]) {
      expect(responds(id, JSON.parse(JSON.stringify({ ...response, impact: broken })))).toBe(false);
    }
  }
  expect(responds('previewProposal', { previewHash: 'h', problems: [], result: {} })).toBe(false);
});

test('F3 모델별 Effort를 보고하고 미확인과 미매핑 값을 보존한다', () => {
  const model = (id: string, efforts: unknown) => ({ id, label: id, rank: 1, efforts });
  expect(accepts('reportModels', { agent: 'Codex', models: [model('gpt-5.5', ['low', 'xhigh']), model('gpt-6-sol', ['max', 'ultra'])] })).toBe(true);
  expect(accepts('reportModels', { agent: 'Codex', models: [model('hidden', null)] })).toBe(true);
  expect(accepts('reportModels', { agent: 'Codex', models: [{ id: 'x', label: 'x', rank: 1 }], efforts: ['low'] })).toBe(false);
});

test('F4 기술 결정 제안은 원본 경로에서 Runner가 하고 승인은 팀장이 한다', () => {
  expect(op('createDecision')).toMatchObject({
    path: '/api/projects/:projectId/design/decisions', principal: 'runner', idempotency: 'required',
  });
  expect(op('createDecision').errors).toEqual(expect.arrayContaining(['RUNNER_UNAUTHORIZED', 'EPOCH_MISMATCH', 'PROJECT_NOT_FOUND']));
  for (const id of ['listDecisions', 'approveDecision', 'rejectDecision', 'changeDecision']) expect(op(id).principal).toBe('lead');
  const doc = buildOpenApi(OPERATIONS) as { paths: Record<string, Record<string, { security: object[]; tags: string[]; parameters: { $ref?: string }[] }>> };
  const post = doc.paths['/api/projects/{projectId}/design/decisions']?.post;
  expect(post?.security).toEqual([{ runnerToken: [] }]);
  expect(post?.tags).toEqual(['runner']);
  expect(post?.parameters.map((p) => p.$ref)).toEqual(expect.arrayContaining(['#/components/parameters/ProjectEpoch', '#/components/parameters/IdempotencyKey']));
  // 팀장 지정 결정은 Agent가 만들 수 없다(G§4.12)
  expect(accepts('createDecision', { ...runner('createDecision'), authority: 'lead' })).toBe(false);
});

test('F5 bootstrap 재시도는 초안 revision을 비교하고, 초안 전이면 분석 회차를 비교한다', () => {
  expect(accepts('retryBootstrap', { revision: 2 })).toBe(true);
  expect(accepts('retryBootstrap', { revision: null, runNo: 1 })).toBe(true);
  expect(accepts('retryBootstrap', { revision: null })).toBe(false);
  expect(accepts('retryBootstrap', { updatedAt: T })).toBe(false);
  expect(op('retryBootstrap').errors).toContain('VERSION_CONFLICT');
});

test('F6 팀장은 모델 허용만 쓴다', () => {
  const entry = { agent: 'Codex', id: 'gpt-5.5', allowed: true };
  expect(accepts('putModelSettings', { updatedAt: T, models: [entry] })).toBe(true);
  for (const extra of [{ efforts: [{ key: 'ultra', level: 5 }] }, { rank: 9 }, { label: 'x' }, { isNew: false }]) {
    expect(accepts('putModelSettings', { updatedAt: T, models: [{ ...entry, ...extra }] }), JSON.stringify(extra)).toBe(false);
  }
  const read = { ...entry, label: '5.5', rank: 1, isNew: false, efforts: [{ key: 'ultra', level: null }] };
  expect(responds('getModelSettings', { updatedAt: T, models: [read] })).toBe(true);
});

test('F7 원본이 정한 거부 사례의 오류를 선언한다', () => {
  expect(ERROR_STATUS).toMatchObject({ RECIPIENT_DUPLICATE: 409, NOT_FOUND: 404 });
  expect(op('addRecipient').errors).toContain('RECIPIENT_DUPLICATE');
  expect(op('createProject').errors).toContain('INVALID_TRANSITION');
  expect(op('reportSession').errors).toContain('INVALID_TRANSITION');
  expect(op('stopAttempt').errors).toContain('CLAIM_REJECTED');
  // D1: 경로로 자원을 가리키는 API는 모두 404를 선언한다.
  for (const item of OPERATIONS.filter((o) => /:(?!kind\b)\w+/.test(o.path))) {
    expect(item.errors.some((code) => ERROR_STATUS[code] === 404), item.id).toBe(true);
  }
  expect(op('getReport').errors).toContain('NOT_FOUND');
  expect(op('getReport').errors).not.toContain('PROJECT_NOT_FOUND');
});

test('F8 보유 해제는 원래 boot·group과 관측한 boot를 증거로 보낸다', () => {
  const base = { fence: 2, hostId: 'h', at: T };
  const good = [
    { kind: 'no_process', bootId: 'b1' },
    { kind: 'group_empty', bootId: 'b1', processGroup: 4321 },
    { kind: 'boot_changed', bootId: 'b1', processGroup: 4321, currentBootId: 'b2' },
    { kind: 'boot_changed', bootId: 'b1', processGroup: null, currentBootId: 'b2' },
  ];
  const bad = [
    'boot_changed', { kind: 'boot_changed' }, { kind: 'boot_changed', bootId: 'b1', processGroup: 1 },
    { kind: 'group_empty', bootId: 'b1' }, { kind: 'no_process' }, { kind: 'lease_expired', bootId: 'b1' },
  ];
  for (const id of ['releaseJob', 'releaseJobSlots']) {
    for (const proof of good) expect(accepts(id, { ...base, proof }), JSON.stringify(proof)).toBe(true);
    for (const proof of bad) expect(accepts(id, { ...base, proof }), JSON.stringify(proof)).toBe(false);
  }
  const { bootId, ...host } = runner('reportHost');
  expect(bootId).toBeTypeOf('string');
  expect(accepts('reportHost', host)).toBe(false);
});

const FORMERLY_PENDING = [
  'getDashboard', 'getDataItem', 'getDesign', 'getIntegrity', 'getInterface', 'getPipeline', 'getProject', 'getReport',
  'getRunnerState', 'getSchedule', 'getSession', 'previewProposal', 'previewReset',
];
test.each(FORMERLY_PENDING)('F9 %s: 예시는 통과하고 빈 객체와 필드가 빠진 응답은 거부한다', (id) => {
  const examples = fixtures<{ id: string; response: Record<string, unknown> }>('lead').filter((item) => item.id === id);
  expect(examples.length).toBeGreaterThan(0);
  expect(responds(id, {})).toBe(false);
  for (const { response } of examples) {
    expect(responds(id, response), ajv.errorsText()).toBe(true);
    for (const key of Object.keys(response)) {
      const rest = Object.fromEntries(Object.entries(response).filter(([name]) => name !== key));
      expect(responds(id, rest), key).toBe(false);
    }
  }
});

test('F9 미정 응답이 없고 내보내기는 zip이다', () => {
  expect(JSON.stringify(buildOpenApi(OPERATIONS))).not.toContain('x-awbs-pending');
  expect(op('exportProject').binary).toBe('application/zip');
});

test('F9 보고서 snapshot이 가이드 12개 구성 항목을 모두 가진다', () => {
  const report = fixtures<{ id: string; response: Record<string, unknown> }>('lead').find((item) => item.id === 'getReport');
  const snapshot = report?.response.snapshot as Record<string, unknown>;
  expect(Object.keys(snapshot)).toEqual([
    'summary', 'issues', 'series', 'done', 'active', 'failures', 'attempts', 'replans', 'gaps', 'messages', 'next', 'all',
  ]);
  for (const key of Object.keys(snapshot)) {
    const partial = Object.fromEntries(Object.entries(snapshot).filter(([name]) => name !== key));
    expect(responds('getReport', { ...report?.response, snapshot: partial }), key).toBe(false);
  }
});

test('D6·D-29·D-30 등급 조정은 adjust 하나이고 이전·이후·사유를 담는다', () => {
  const body = runner('reportAttemptStatus');
  expect(accepts('reportAttemptStatus', { ...body, escalation: '상향' })).toBe(false);
  expect(accepts('reportAttemptStatus', { ...body, adjust: { kind: 'up', reason: 'x' } })).toBe(false);
  const grade = { model: 'm', effort: 'high' };
  for (const kind of ['up', 'down', 'keep', 'regrade']) {
    expect(accepts('reportAttemptStatus', { ...body, adjust: { kind, from: grade, to: grade, reason: 'x' } })).toBe(true);
  }
});

test('D7·D10·D11·D16·D17 나머지 기술 결정', () => {
  for (const id of ['getCiDefaults', 'getCiSettings']) {
    expect(responds(id, { nightAt: '02:00', retry: 1, deployUrl: null, updatedAt: null }), id).toBe(true);
  }
  expect(responds('addDependency', { dependency: { pred: 'TASK-0001', succ: 'TASK-0002', type: 'FS' }, blocked: false }, 201)).toBe(false);
  expect(accepts('retryInputs', { updatedAt: T })).toBe(false);
  expect(accepts('retryInputs', { updatedAt: T, version: 2 })).toBe(true);
  expect(op('getEvidenceContent').responseHeaders).toEqual(['Content-Disposition', 'X-Content-Type-Options']);
  expect(accepts('reportReadiness', { at: T, items: [], cli: [{ agent: 'Codex', version: '0.172.0', model: 'm', options: 'exec --json' }] })).toBe(true);
  expect(accepts('reportReadiness', { at: T, items: [], cli: [{ agent: 'Codex', version: '0.172.0' }] })).toBe(false);
});

test('착수 승인 요청·승인·반려(contracts §2.1)', () => {
  for (const id of ['requestTaskApproval', 'approveTask', 'rejectTask']) {
    expect(accepts(id, { updatedAt: T, comment: '확인' }), id).toBe(true);
    expect(accepts(id, {}), id).toBe(false);
    expect(Object.keys(op(id).responses), id).toEqual(['200']);
    expect(op(id).errors, id).toEqual(expect.arrayContaining(['VALIDATION_FAILED', 'INVALID_TRANSITION', 'VERSION_CONFLICT', 'TASK_NOT_FOUND']));
  }
  expect(op('requestTaskApproval').path).toBe('/api/tasks/:taskKey/request-approval');
});

/* ---- D-33~35 (data-model §2.3-1) ---- */
const HASH = 'd'.repeat(64);
const judgement = (rule: string, extra: object = {}) => ({
  rule, result: 'met', agreedBy: ['Claude', 'Codex'], basis: '근거', judgedAt: T, sourceRef: 'job-1', ...extra,
});
const judged = (...items: object[]) => ({ schemaVersion: 1, items });

test('D-33 초안·CP의 새 Task 판단은 hash 없이 받고, 기존 Task 재판단은 받은 hash를 돌려보낸다', () => {
  const draft = (judgedRules: unknown) => {
    const body = structuredClone(runner('submitDraft')) as { tasks: Record<string, unknown>[] };
    Object.assign(body.tasks[0] ?? {}, { judgedRules });
    return accepts('submitDraft', JSON.parse(JSON.stringify(body)));
  };
  const plan = (item: object) => accepts('submitTaskPlan', { ...runner('submitTaskPlan'), judgedRules: judged(item) });
  for (const rule of ['revert', 'contract', 'refactor']) {
    expect(draft(judged(judgement(rule)))).toBe(true);
    expect(draft(judged(judgement(rule, { subjectHash: HASH })))).toBe(false);
    expect(plan(judgement(rule, { subjectHash: HASH }))).toBe(true);
    expect(plan(judgement(rule))).toBe(false);
  }
  // 미기록·불충족도 저장한다. 보류는 승인에서 한다.
  expect(draft(undefined)).toBe(true);
  expect(draft(judged(judgement('revert', { result: 'not_met' })))).toBe(true);
  for (const bad of [
    judgement('size'), judgement('revert', { agreedBy: ['Codex'] }), judgement('revert', { agreedBy: ['Codex', 'Codex'] }),
    judgement('revert', { basis: '  ' }), judgement('revert', { result: 'ok' }),
  ]) expect(draft(judged(bad)), JSON.stringify(bad)).toBe(false);
  expect(draft({ schemaVersion: 2, items: [] })).toBe(false);
  expect(op('submitTaskPlan').errors).toContain('VERSION_CONFLICT');
});

test('D-33·D-34 판단 기록은 Planning API만 쓴다', () => {
  const body = runner('submitPlanningProposal') as { ops: { op: string; t: object }[] };
  const ops = body.ops.map((item) => (item.op === 'add' ? { ...item, t: { ...item.t, judgedRules: judged(judgement('contract')) } } : item));
  expect(accepts('submitPlanningProposal', { ...body, ops })).toBe(true);
  for (const rule of ['ac_meaning', 'layer_order', 'test_included']) {
    expect(accepts('submitPlanningProposal', { ...body, splitJudgements: judged(judgement(rule)) })).toBe(true);
  }
  expect(accepts('submitPlanningProposal', { ...body, splitJudgements: judged(judgement('revert')) })).toBe(false);
  const lead = { title: 't', reason: 'r', source: { kind: 'manual' }, ops: body.ops };
  expect(accepts('createProposal', lead)).toBe(true);
  expect(accepts('createProposal', { ...lead, ops })).toBe(false);
  expect(accepts('createProposal', { ...lead, splitJudgements: judged(judgement('ac_meaning')) })).toBe(false);
});

test('D-33~35 보류 사유와 오류 코드', () => {
  expect(ERROR_STATUS).toMatchObject({ SPLIT_JUDGEMENT_REQUIRED: 409, ORDER_NOT_PRESERVED: 409, ACTIVE_TASK_BLOCKED: 409 });
  for (const id of ['approveProposal', 'applyProposal']) {
    expect(op(id).errors).toEqual(expect.arrayContaining(['SPLIT_JUDGEMENT_REQUIRED', 'ORDER_NOT_PRESERVED', 'ACTIVE_TASK_BLOCKED']));
  }
  expect(op('addDependency').errors).toContain('ACTIVE_TASK_BLOCKED');
  expect(op('approveTask').errors).toContain('SPLIT_JUDGEMENT_REQUIRED');
  expect(op('rejectTask').errors).not.toContain('SPLIT_JUDGEMENT_REQUIRED');
  expect(op('approveBootstrap').errors).toContain('SPLIT_JUDGEMENT_REQUIRED');
  const preview = fixtures<{ id: string; response: Record<string, unknown> }>('lead').find((item) => item.id === 'previewProposal')?.response;
  for (const code of ['JUDGEMENT_MISSING', 'JUDGEMENT_NOT_MET', 'ORDER_NOT_PRESERVED', 'ACTIVE_TASK_BLOCKED']) {
    expect(responds('previewProposal', { ...preview, holdReasons: [{ code, taskKey: 'TASK-0001', message: 'm' }] }), code).toBe(true);
  }
  expect(responds('previewProposal', { ...preview, holdReasons: ['문자열'] })).toBe(false);
});
