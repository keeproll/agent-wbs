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
  'submitPlanningAnalysis', 'submitPlanningReviews', 'submitPlanningProposal', 'submitTaskPlan', 'submitProposalJudgements', 'createDecision',
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
  // M1-01 통합: 시작 때 pipelineSha·trigger 필수(ci_runs NOT NULL)
  const start = { ref: 'main', pipelineSha: 'a'.repeat(40), trigger: 'schedule' };
  expect(accepts('startCiRun', { stage: 'night', ...start })).toBe(true);
  expect(accepts('startCiRun', { stage: 'night', ref: 'main' })).toBe(false);
  for (const stage of ['task', 'int', 'deploy']) expect(accepts('startCiRun', { stage, ...start })).toBe(false);
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
  // rank는 서버 설정값이라 보고하지 않는다(owner 2026-11-26 아이템 8).
  const model = (id: string, efforts: unknown) => ({ id, label: id, efforts });
  expect(accepts('reportModels', { agent: 'Codex', models: [model('gpt-5.5', ['low', 'xhigh']), model('gpt-6-sol', ['max', 'ultra'])] })).toBe(true);
  expect(accepts('reportModels', { agent: 'Codex', models: [model('hidden', null)] })).toBe(true);
  expect(accepts('reportModels', { agent: 'Codex', models: [{ id: 'x', label: 'x', efforts: null }], efforts: ['low'] })).toBe(false);
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

test('F6 팀장은 모델별로는 허용만 쓴다(순서는 rankOrder 설정으로)', () => {
  const entry = { agent: 'Codex', id: 'gpt-5.5', allowed: true };
  expect(accepts('putModelSettings', { updatedAt: T, models: [entry] })).toBe(true);
  for (const extra of [{ efforts: [{ key: 'ultra', level: 5 }] }, { rank: 9 }, { label: 'x' }, { isNew: false }]) {
    expect(accepts('putModelSettings', { updatedAt: T, models: [{ ...entry, ...extra }] }), JSON.stringify(extra)).toBe(false);
  }
  const read = { ...entry, label: '5.5', rank: 1, isNew: false, efforts: [{ key: 'ultra', level: null }] };
  const order = { rankOrder: { Claude: [], Codex: ['gpt-5.5'] }, codexFamilyOrder: ['luna'], claudeModels: ['claude-haiku-5-5'] };
  expect(responds('getModelSettings', { updatedAt: T, models: [read], ...order })).toBe(true);
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

test('F9 보고서 snapshot이 생성 시점 프로젝트 이름(M6-02)과 가이드 12개 구성 항목을 모두 가진다', () => {
  const report = fixtures<{ id: string; response: Record<string, unknown> }>('lead').find((item) => item.id === 'getReport');
  const snapshot = report?.response.snapshot as Record<string, unknown>;
  expect(Object.keys(snapshot)).toEqual([
    'projectName', 'projectNameStatus', 'summary', 'issues', 'series', 'done', 'active', 'failures', 'attempts', 'replans', 'gaps', 'messages', 'next', 'all',
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
  rule, result: 'met', agreedBy: ['Claude', 'Codex'], basis: '근거', judgedAt: T, sourceRef: `sha256:${HASH}`, ...extra,
});
const judged = (...items: object[]) => ({ schemaVersion: 1, items });

test('D-33 초안·CP 판단은 sourceRef를 받고, 기존 Task 재판단은 subjectHash도 받는다', () => {
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
    ...['job-1', `job-1#input-sha256:${HASH}`, `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, `sha256:${'g'.repeat(64)}`]
      .map((sourceRef) => judgement('revert', { sourceRef })),
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

test('contracts §3.2·§3.4(7ad2e04) 프로세스 그룹은 생성 뒤 /process로만 등록한다', () => {
  const start = { fence: 1, hostId: 'h', bootId: 'b', installedSubagents: [] };
  // headSha 필요 여부는 job kind를 아는 서버가 판정한다.
  expect(accepts('startJob', start)).toBe(true);
  expect(accepts('startJob', { ...start, headSha: 'a'.repeat(40) })).toBe(true);
  expect(accepts('startJob', { ...start, headSha: 'main' })).toBe(false);
  expect(accepts('startJob', { ...start, processGroup: 1 })).toBe(false);
  expect(op('startJob').errors).toContain('VALIDATION_FAILED');
  expect(accepts('acquireJobSlots', { fence: 1, hostId: 'h' })).toBe(true);
  expect(accepts('acquireJobSlots', { fence: 1, hostId: 'h', processGroup: 1 })).toBe(false);
  for (const id of ['reportJobProcess', 'releaseJob', 'releaseJobSlots']) expect(op(id).errors, id).toContain('INVALID_TRANSITION');
});

test('contracts §1(47c8c8e) 작업을 만드는 팀장 요청은 202 {jobId}다', () => {
  const creates = OPERATIONS.filter((o) => o.principal === 'lead' && o.method === 'POST' && JSON.stringify(o.responses).includes('"jobId"'));
  const not202 = creates.filter((o) => !(202 in o.responses)).map((o) => o.id);
  expect(not202).toEqual(['createProject']); // §2.2가 201 {project,jobId}로 정함
  expect(responds('analyzeInputs', { jobId: 'j' }, 202)).toBe(true);
});

test('R1 기존 Task를 수정하는 Planning CP는 변경 후 판단을 함께 제출한다', () => {
  const ops = [{ op: 'modify', task: 'TASK-0005', field: 'title', after: '새 제목' }];
  const body = { ...runner('submitPlanningProposal'), ops };
  const entry = (extra: object = {}) => ({ taskKey: 'TASK-0005', judgedRules: judged(judgement('revert')), ...extra });
  expect(accepts('submitPlanningProposal', { ...body, taskJudgements: [entry()] })).toBe(true);
  // 우선순위만 바꾸는 CP는 판단이 필요 없다.
  expect(accepts('submitPlanningProposal', body)).toBe(true);
  for (const bad of [
    entry({ taskKey: 'NEW-1' }), // 새 Task는 add.t.judgedRules 한 곳에만 쓴다.
    entry({ judgedRules: judged(judgement('revert', { subjectHash: HASH })) }), // CP 제출은 sourceRef에 입력 지문을 담는다.
    entry({ judgedRules: judged(judgement('ac_meaning')) }),
    { taskKey: 'TASK-0005' },
  ]) expect(accepts('submitPlanningProposal', { ...body, taskJudgements: [bad] }), JSON.stringify(bad)).toBe(false);
});

test('R1 팀장이 만든 CP는 Planning이 판단만 덧붙이고 팀장은 쓸 수 없다', () => {
  expect(op('submitProposalJudgements')).toMatchObject({
    method: 'POST', path: '/api/planning/proposals/:id/judgements', principal: 'runner', idempotency: 'required',
  });
  expect(op('submitProposalJudgements').errors).toEqual(
    expect.arrayContaining(['LEASE_LOST', 'EPOCH_MISMATCH', 'NOT_FOUND', 'VERSION_CONFLICT', 'INVALID_TRANSITION']));
  const rules = judged(judgement('contract', { subjectHash: HASH }));
  const body = { jobId: 'j', fence: 1, judgements: [{ target: 'TASK-0005', judgedRules: rules }, { target: 'NEW-1', judgedRules: rules }] };
  expect(accepts('submitProposalJudgements', body)).toBe(true);
  const split = judged(judgement('ac_meaning', { subjectHash: HASH }));
  expect(accepts('submitProposalJudgements', { ...body, splitJudgements: split })).toBe(true);
  expect(accepts('submitProposalJudgements', { jobId: 'j', judgements: body.judgements })).toBe(false);
  expect(accepts('submitProposalJudgements', { ...body, ops: [] })).toBe(false);
  // 낡은 내용의 판단을 걸러야 하므로 hash가 필수다.
  expect(accepts('submitProposalJudgements', { ...body, judgements: [{ target: 'NEW-1', judgedRules: judged(judgement('revert')) }] })).toBe(false);
  const lead = { title: 't', reason: 'r', source: { kind: 'manual' }, ops: [{ op: 'remove', task: 'TASK-0005' }] };
  expect(accepts('createProposal', lead)).toBe(true);
  expect(accepts('createProposal', { ...lead, taskJudgements: [] })).toBe(false);
});

const claims = () => fixtures<{ kind: string; response: { job: { payload: Record<string, unknown> } } }>('judgement-jobs');
const claim = (name: string) => {
  const found = claims().find((item) => item.kind === name);
  if (!found) throw new Error(name);
  return structuredClone(found.response);
};

test('N1 판단 job은 판단 대상의 변경 전·후 내용과 hash를 함께 준다', () => {
  expect(claims().map((item) => item.kind)).toEqual(['lead-proposal', 'split-proposal', 'rejudge']);
  for (const item of claims()) expect(responds('claimJob', item.response), `${item.kind} ${ajv.errorsText()}`).toBe(true);
  expect(responds('claimJob', { job: { ...claim('rejudge').job, payload: { tasks: [], policy: {}, proposal: null, planning: null } } })).toBe(false);

  // ID·hash만 있는 job은 판단할 수 없다.
  const broken = (name: string, change: (proposal: Record<string, never> & { targets: Record<string, unknown>[] }) => void) => {
    const response = claim(name);
    change(response.job.payload.proposal as never);
    return responds('claimJob', JSON.parse(JSON.stringify(response)));
  };
  expect(broken('lead-proposal', () => undefined)).toBe(true);
  for (const key of ['ops', 'targets', 'splitSubjectHash', 'splitTasks']) {
    expect(broken('lead-proposal', (p) => Reflect.deleteProperty(p, key)), key).toBe(false);
  }
  for (const key of ['before', 'after', 'subjectHash']) {
    expect(broken('lead-proposal', (p) => Reflect.deleteProperty(p.targets[0] ?? {}, key)), key).toBe(false);
  }
  // 기존 Task는 변경 전 내용이 있어야 하고, 새 Task는 없어야 한다.
  expect(broken('lead-proposal', (p) => Object.assign(p.targets[0] ?? {}, { before: null }))).toBe(false);
  expect(broken('lead-proposal', (p) => Object.assign(p.targets[1] ?? {}, { before: p.targets[0]?.before }))).toBe(false);
  // 분할 대상과 hash는 함께 있거나 함께 없다.
  expect(broken('split-proposal', (p) => Object.assign(p, { splitTasks: null }))).toBe(false);
  expect(broken('split-proposal', (p) => Object.assign(p, { splitTasks: [] }))).toBe(false);
  expect(broken('lead-proposal', (p) => Object.assign(p, { splitSubjectHash: HASH }))).toBe(false);
});

test('N1 snapshot은 hash 계산 대상과 같은 범위다(data-model §2.3-1)', () => {
  const proposal = claim('lead-proposal').job.payload.proposal as { ops: object[]; targets: { after: object }[] };
  expect(Object.keys(proposal.targets[0]?.after ?? {})).toEqual([
    'title', 'scope', 'out', 'doneCond', 'spec', 'ac', 'outputs', 'designs', 'conflictGroup',
  ]);
  const reject = (extra: object) => {
    const response = claim('lead-proposal');
    Object.assign((response.job.payload.proposal as typeof proposal).targets[0]?.after ?? {}, extra);
    return responds('claimJob', response);
  };
  for (const extra of [{ priority: 1 }, { assigneeAgent: 'Codex' }, { lifecycleStatus: 'ready' }, { judgedRules: null }, { taskKey: 'TASK-0005' }]) {
    expect(reject(extra), JSON.stringify(extra)).toBe(false);
  }
  const after = proposal.targets[0]?.after as Record<string, unknown>;
  for (const key of Object.keys(after)) expect(reject({ [key]: undefined }), key).toBe(false);
  // 판단 기록은 ops에서도 뺀다.
  const response = claim('lead-proposal');
  const ops = (response.job.payload.proposal as { ops: { op: string; t?: object }[] }).ops;
  const add = ops.find((item) => item.op === 'add');
  Object.assign(add?.t ?? {}, { judgedRules: judged(judgement('revert', { subjectHash: HASH })) });
  expect(responds('claimJob', response)).toBe(false);
});

test('N1 기존 Task 재판단 job도 현재 내용과 workType을 준다', () => {
  for (const field of ['content', 'workType']) {
    const response = claim('rejudge');
    const [task] = response.job.payload.tasks as Record<string, unknown>[];
    Reflect.deleteProperty(task ?? {}, field);
    expect(responds('claimJob', response)).toBe(false);
  }
});

test.each(['split', 'input_diff'])('%s claim의 Task 작업 유형은 필수이며 Analysis를 그대로 전달한다', (kind) => {
  const [base] = claim('rejudge').job.payload.tasks as Record<string, unknown>[];
  if (!base) throw new Error('Task fixture 없음');
  const task: Record<string, unknown> = { ...base, workType: 'Analysis' };
  const snapshotTask: Record<string, unknown> = {
    taskKey: task.taskKey, workType: task.workType, subjectHash: task.subjectHash, content: task.content, wp: 'WP-1', status: 'ready',
  };
  const wbs = { phases: [{ id: 'PH-1', wps: [{ id: 'WP-1', tasks: [task.taskKey] }] }], tasks: [snapshotTask], dependencies: [] };
  const payload = kind === 'split' ? { tasks: [task], policy: {}, wbs }
    : { planningJobId: 'planning-1', runNo: 1, version: 2, commit: 'a'.repeat(40), previousCommit: 'b'.repeat(40), instruction: '', resumeStep: null, wbs };
  const response = { job: { ...claim('rejudge').job, kind, payload } };
  expect(responds('claimJob', response), ajv.errorsText()).toBe(true);
  for (const invalid of [undefined, 'Unknown']) {
    snapshotTask.workType = invalid;
    expect(responds('claimJob', response)).toBe(false);
    snapshotTask.workType = 'Analysis';
    if (kind === 'split') {
      task.workType = invalid;
      expect(responds('claimJob', response)).toBe(false);
      task.workType = 'Analysis';
    }
  }
});

test('N1 팀장 CP → claim → 판단 제출이 같은 대상과 hash로 이어진다', () => {
  const proposal = claim('split-proposal').job.payload.proposal as {
    targets: { target: string; subjectHash: string }[]; splitSubjectHash: string;
  };
  expect(accepts('submitProposalJudgements', {
    jobId: 'job-1',
    fence: 1,
    judgements: proposal.targets.map(({ target, subjectHash }) => ({ target, judgedRules: judged(judgement('revert', { subjectHash })) })),
    splitJudgements: judged(judgement('ac_meaning', { subjectHash: proposal.splitSubjectHash })),
  })).toBe(true);
});

test('R1 저장된 CP는 판단을 돌려준다', () => {
  const applied = fixtures<{ id: string; response: { proposal: Record<string, unknown> } }>('lead').find((f) => f.id === 'applyProposal')?.response;
  const stored = (taskJudgements: unknown) => responds('applyProposal', { ...applied, proposal: { ...applied?.proposal, taskJudgements } });
  expect(stored([{ taskKey: 'TASK-0005', judgedRules: judged(judgement('revert', { subjectHash: HASH })) }])).toBe(true);
  expect(stored(undefined)).toBe(false);
});

test('R2 Runner 상태가 최근 중단 구간과 사유를 준다(P L6684)', () => {
  const state = fixtures<{ id: string; response: Record<string, unknown> }>('lead').find((f) => f.id === 'getRunnerState')?.response;
  const gaps = [{ from: T, to: T, reason: 'reboot' }, { from: T, to: null, reason: 'unknown' }];
  expect(state?.gaps).toHaveLength(2);
  expect(responds('getRunnerState', { ...state, gaps })).toBe(true);
  for (const bad of [{ from: T, to: T }, { to: T, reason: 'reboot' }, { from: T, to: T, reason: '재부팅' }]) {
    expect(responds('getRunnerState', { ...state, gaps: [bad] })).toBe(false);
  }
});

test('완료 조건은 판단 대상이라 변경 전·후가 구분되고 빠질 수 없다', () => {
  const targets = () => claim('lead-proposal').job.payload.proposal as { targets: { before: { doneCond: string }; after: { doneCond: string } }[] };
  const [target] = targets().targets;
  expect(target?.before.doneCond).not.toBe(target?.after.doneCond);
  for (const name of ['lead-proposal', 'split-proposal', 'rejudge']) {
    const text = JSON.stringify(claim(name));
    expect(responds('claimJob', JSON.parse(text))).toBe(true);
    const one = text.replace(/"doneCond":"[^"]*","spec"/, '"spec"');
    expect(one).not.toBe(text);
    expect(responds('claimJob', JSON.parse(one)), name).toBe(false);
  }
});
