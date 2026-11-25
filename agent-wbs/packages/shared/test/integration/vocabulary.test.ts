// M1 결합: API 스키마 ↔ 순수 판정의 값 철자와 오류 코드
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as shared from '@awbs/shared';
import type {
  ConcurrencyInput, CapOverrun, DomainError, ExecPolicy, GateCondition, GradeError, ImpactNote, LimitFactor, ModifyField,
  ObservationGrade, ProposalIssueCode, RemovedDependency, ReplanMove, ReplanResult, ResolvedAdjust, ResolveResult, ScheduleError,
  ScheduleWarning, SessionObservation, SimulationOp, SplitProblemCode, HoldRow, Judgement,
} from '@awbs/shared';
import { ERROR_STATUS, HOLD_ERROR, OPERATIONS, RUN_GRADE_ERROR, SCHEDULE_ERROR } from '@awbs/shared/api';
import type { ErrorCode } from '@awbs/shared/api';
import * as c from '../../src/api/common.ts';
import * as m from '../../src/api/models.ts';

interface Node {
  enum?: string[];
  anyOf?: Node[];
  properties?: Record<string, Node>;
  items?: Node;
}
const node = (schema: unknown) => schema as Node;
/** 경로의 enum. anyOf는 갈래를 모두 합친다. */
const values = (schema: unknown, ...path: string[]): string[] => {
  const at = node(schema);
  if (at.anyOf) return [...new Set(at.anyOf.flatMap((item) => values(item, ...path)))];
  const [key, ...rest] = path;
  if (key === undefined) return at.enum ?? [];
  const next = key === '[]' ? at.items : at.properties?.[key];
  return next ? values(next, ...rest) : [];
};
const body = (id: string) => OPERATIONS.find((item) => item.id === id)?.body;
const ok = (id: string) => OPERATIONS.find((item) => item.id === id)?.responses[200];
/** 도메인 union에 값이 추가·삭제되면 타입 검사가 실패한다. */
const all = <T extends string>(record: Record<T, true>) => Object.keys(record).sort();

describe('같은 개념은 정의가 하나다', () => {
  test.each<[string, unknown, readonly string[]]>([
    ['Agent', c.Agent, shared.AGENTS], ['RunRole', c.RunRole, shared.RUN_ROLES],
    ['TaskStatus', c.TaskStatus, shared.TASK_STATUSES], ['AttemptKind', c.AttemptKind, shared.ATTEMPT_KINDS],
    ['AttemptStatus', m.AttemptStatus, shared.ATTEMPT_STATUSES], ['PassFail', c.PassFail, shared.VERIFICATION_RESULTS],
    ['DepType', c.DepType, shared.DEPENDENCY_TYPES], ['WorkType', c.WorkType, shared.WORK_TYPES],
    ['Domain', c.Domain, shared.DOMAINS], ['DesignKind', c.DesignKind, shared.DESIGN_KINDS],
    ['Confidence', c.Confidence, shared.CONFIDENCES],
  ])('%s', (_name, schema, expected) => {
    expect(values(schema)).toEqual([...expected]);
  });

  test('전이표·claim 표·진행률 표가 모든 상태를 덮는다', () => {
    for (const table of [shared.TASK_TRANSITIONS, shared.CLAIM_KINDS, shared.STAGE_PCT]) {
      expect(Object.keys(table).sort()).toEqual([...shared.TASK_STATUSES].sort());
    }
    expect(Object.keys(shared.EFFORT_MAP).sort()).toEqual([...shared.AGENTS].sort());
  });
});

test.each<[string, string[], string[]]>([
  ['Gate 조건', values(m.GateKey),
    all<GateCondition['key']>({ checklist: true, outputs: true, verification: true, defects: true, approval: true })],
  ['Gate 결과', values(m.Gate, 'conditions', '[]', 'result'), all<GateCondition['result']>({ PASS: true, FAIL: true, BLOCKED: true })],
  ['재조정 이동', values(m.MoveKind), all<ReplanMove['kind']>({ delayed: true, advanced: true, new: true, excluded: true })],
  ['재조정 상태', values(ok('listReplans'), 'items', '[]', 'status'), all<ReplanResult['status']>({ applied: true, pending: true })],
  ['일정 경고', values(m.Schedule, 'warnings', '[]', 'code'),
    all<ScheduleWarning['code']>({ USAGE_RESET_UNKNOWN: true, CLOCK_SKEW_CLAMPED: true })],
  ['일정 경고 필드', values(m.ScheduleWarning, 'field'),
    all<Extract<ScheduleWarning, { field: string }>['field']>({ actStart: true, actEnd: true, lastHeartbeatAt: true, to: true })],
  ['CP op', values(m.ProposalOp, 'op'),
    all<SimulationOp['op']>({ add: true, modify: true, remove: true, 'dep-add': true, 'dep-remove': true })],
  ['CP 수정 항목', values(m.ProposalOp, 'field'),
    all<ModifyField>({ priority: true, title: true, doneCond: true, assignee: true, verifier: true, scopeAdd: true, acAdd: true })],
  ['제거된 관계', values(m.Impact, 'removedDependencies', '[]', 'reason'),
    all<RemovedDependency['reason']>({ 'pred-cancelled': true, 'succ-cancelled': true, 'dep-remove': true })],
  ['보류 사유', values(m.HoldReason, 'code'), Object.keys(HOLD_ERROR)],
  ['보류 규칙', values(m.HoldReason, 'rule'), [...shared.JUDGED_RULES, ...shared.SPLIT_JUDGEMENT_RULES]],
  ['Task 판단 규칙', values(m.JudgedRules, 'items', '[]', 'rule'), [...shared.JUDGED_RULES]],
  ['분할 판단 규칙', values(m.SplitJudgements, 'items', '[]', 'rule'), [...shared.SPLIT_JUDGEMENT_RULES]],
  ['판단 결과', values(m.JudgedRules, 'items', '[]', 'result'), all<Judgement<string>['result']>({ met: true, not_met: true })],
  ['분할 기준', Object.keys(node(body('putSplitSettings')).properties?.on?.properties ?? {}), shared.SPLIT_RULES.map((rule) => rule.key)],
  ['분할 예외', values(body('addSplitException'), 'rule'), shared.SPLIT_RULES.map((rule) => rule.key)],
  ['사용량 정책', values(body('putExecPolicy'), 'onUsage'), all<ExecPolicy['onUsage']>({ wait: true, down: true })],
  ['재작업 정책', values(body('putExecPolicy'), 'onRework'), all<ExecPolicy['onRework']>({ same: true, up1: true, top: true })],
  ['등급 조정(none·resume은 null)', values(m.GradeAdjust, 'kind'),
    all<Exclude<ResolvedAdjust['kind'], 'none' | 'resume'>>({ up: true, down: true, keep: true, regrade: true })],
  ['상한 모드', values(body('putConcurrency'), 'mode'), all<Parameters<typeof shared.effectiveCaps>[0]>({ auto: true, manual: true })],
  ['상한 항목', Object.keys(m.Caps), all<CapOverrun['key']>({ total: true, Claude: true, Codex: true, heavy: true })],
  ['제한 요인', values(m.RunnerState, 'concurrency', 'factor'), all<LimitFactor>({ cap: true, runner_limit: true, parallel_tasks: true })],
  ['관측 등급', values(m.RunnerState, 'sessions', '[]', 'grade'),
    all<ObservationGrade>({ verified: true, partial: true, unverified: true })],
  ['관측 상태', values(c.ObservationState), all<SessionObservation['state']>({ ok: true, unconfirmed: true })],
])('%s 값이 API와 도메인에서 같다', (_name, api, domain) => {
  expect([...api].sort()).toEqual([...domain].sort());
  expect(api.length).toBeGreaterThan(0);
});

test('슬롯 상태는 시도 판정과 용량 계산이 같은 값을 쓴다', () => {
  const slot: shared.ClaimHold['slotState'] = 'unconfirmed';
  const row: HoldRow['slotState'] = slot;
  const back: shared.ClaimHold['slotState'] = row;
  expect(back).toBe('unconfirmed');
});

test('drift compat는 계약의 영문 값이다(DB의 한글 값은 M1-01 통합 때 경계에서 변환)', () => {
  const contracts = readFileSync(new URL('../../../../../docs/plan/contracts.md', import.meta.url), 'utf8');
  expect(values(m.Drift, 'compat')).toEqual(['compatible', 'breaking', 'unchecked']);
  expect(contracts).toContain('drift compat `compatible/breaking/unchecked`');
  expect(values(m.Drift, 'status')).toEqual(['open', 'done']);
});

describe('오류 코드', () => {
  const domainCodes: Record<DomainError['code'], true> = {
    INVALID_TRANSITION: true, VALIDATION_FAILED: true, TASK_NOT_FOUND: true, GATE_NOT_PASSED: true, CLAIM_REJECTED: true,
    ATTEMPT_CLOSED: true, CLEANUP_PENDING: true, SUBAGENT_INSTALL_FAILED: true, DEPENDENCY_SELF: true,
    DEPENDENCY_DUPLICATE: true, DEPENDENCY_CYCLE: true, TASK_HAS_SUCCESSORS: true,
  };

  test('DomainError 코드는 모두 계약 코드다', () => {
    const codes: ErrorCode[] = Object.keys(domainCodes) as DomainError['code'][];
    for (const code of codes) expect(ERROR_STATUS, code).toHaveProperty(code);
  });

  test.each<[string, readonly DomainError['code'][]]>([
    ['addDependency', ['TASK_NOT_FOUND', 'DEPENDENCY_SELF', 'DEPENDENCY_DUPLICATE', 'DEPENDENCY_CYCLE', 'INVALID_TRANSITION']],
    ['deleteTask', ['TASK_HAS_SUCCESSORS', 'TASK_NOT_FOUND']],
    ['requestTaskApproval', ['VALIDATION_FAILED', 'INVALID_TRANSITION']],
    ['approveTask', ['VALIDATION_FAILED', 'INVALID_TRANSITION']],
    ['rejectTask', ['INVALID_TRANSITION']],
    ['completeTask', ['GATE_NOT_PASSED', 'INVALID_TRANSITION']],
    ['requestRun', ['CLAIM_REJECTED', 'CLEANUP_PENDING']],
    ['startJob', ['CLAIM_REJECTED', 'INVALID_TRANSITION']],
    ['reportAttemptResult', ['ATTEMPT_CLOSED', 'INVALID_TRANSITION', 'VALIDATION_FAILED']],
    ['interruptAttempt', ['ATTEMPT_CLOSED']],
  ])('%s가 판정 함수의 오류를 선언한다', (id, codes) => {
    expect(OPERATIONS.find((item) => item.id === id)?.errors).toEqual(expect.arrayContaining([...codes]));
  });

  test('일정 오류: 순환은 계약 코드, 저장 데이터 오류는 INTERNAL', () => {
    const codes: Record<ScheduleError['code'], true> = { SCHEDULE_CYCLE: true, SCHEDULE_INVALID_TASK: true };
    expect(Object.keys(SCHEDULE_ERROR).sort()).toEqual(Object.keys(codes).sort());
    for (const id of ['runReplan', 'requestReplan']) {
      expect(OPERATIONS.find((item) => item.id === id)?.errors).toEqual(expect.arrayContaining(Object.values(SCHEDULE_ERROR)));
    }
  });

  test('보류 사유의 409 코드를 승인·반영이 선언한다', () => {
    for (const id of ['approveProposal', 'applyProposal']) {
      expect(OPERATIONS.find((item) => item.id === id)?.errors).toEqual(expect.arrayContaining(Object.values(HOLD_ERROR)));
    }
  });

  test('등급을 정하지 못한 사유는 오류 코드와 겹치지 않고 CLAIM_REJECTED의 사유다', () => {
    const reasons: Record<Extract<ResolveResult, { ok: false }>['code'] | GradeError, true> = {
      USAGE_EXHAUSTED: true, BELOW_FLOOR: true, FLOOR_UNDETERMINED: true, PREVIOUS_DEV_MISSING: true, MODEL_UNKNOWN: true,
      MODEL_NOT_ALLOWED: true, EFFORT_UNMAPPED: true, EFFORT_NOT_REPORTED: true,
    };
    for (const reason of Object.keys(reasons)) expect(ERROR_STATUS).not.toHaveProperty(reason);
    expect(OPERATIONS.find((item) => item.id === 'getRunGrade')?.errors).toContain(RUN_GRADE_ERROR);
  });

  test('CP 판정 코드 중 계약 오류 코드와 같은 철자는 같은 뜻이다', () => {
    const issues: Record<ProposalIssueCode, boolean> = {
      EMPTY_PROPOSAL: false, VALIDATION_FAILED: true, TASK_NOT_FOUND: true, WBS_NODE_NOT_FOUND: true, COMPLETED_TASK: false,
      CANCELLED_TASK: false, EXECUTION_HISTORY: false, ACTIVE_TASK_BLOCKED: true, ALREADY_APPLIED: false, DEPENDENCY_SELF: true,
      DEPENDENCY_DUPLICATE: true, DEPENDENCY_CYCLE: true, DEPENDENCY_NOT_FOUND: true,
    };
    const split: Record<Exclude<SplitProblemCode, ProposalIssueCode>, boolean> = {
      ALREADY_STARTED: false, NOTHING_TO_SPLIT: false, OUT_OF_SCOPE: false, ORIGINAL_NOT_CANCELLED: false, TOO_FEW_PARTS: false,
      ANALYSIS_REQUIRED: false, RULE_VIOLATION: false, ESTIMATE_MISSING: false, SPLIT_BASIS_MISSING: false, AC_MISSING: false,
      AC_NOT_PARTITIONED: false, JUDGEMENT_MISSING: false, JUDGEMENT_NOT_MET: false, ORDER_NOT_PRESERVED: true,
    };
    for (const [code, inContract] of Object.entries({ ...issues, ...split })) {
      expect(Object.hasOwn(ERROR_STATUS, code), code).toBe(inContract);
    }
  });
});

test('루트 공개 타입을 이름 충돌 없이 쓴다', () => {
  const agent: shared.Agent = 'Claude';
  const kind: shared.AttemptKind = 'rework';
  const dep: shared.Dependency = { pred: 'A', succ: 'B', type: 'SS' };
  const note: ImpactNote = { kind: 'created' };
  const input: ConcurrencyInput = { capTotal: 4, runnerLimit: 4, width: 1, subRatio: 0 };
  const scheduleDep: shared.ScheduleInput['deps'][number] = dep;
  expect([agent, kind, scheduleDep.type, note.kind, input.width]).toEqual(['Claude', 'rework', 'SS', 'created', 1]);
});
