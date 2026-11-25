// API(계약) 값과 순수 판정 값의 최소 변환. 이름·구조가 다른 것만 둔다. 같은 철자는 vocabulary.ts를 함께 쓴다.
import type { DomainError } from '../domain/index.ts';
import type { Grade, ResolvedAdjust, ResolveResult } from '../grade/index.ts';
import type { AcceptanceCriterion, JudgedRules, NewTask, SimulationOp } from '../proposal/index.ts';
import type { ScheduleError, ScheduleWarning as DomainScheduleWarning } from '../schedule/index.ts';
import type { JudgementHold } from '../split/index.ts';
import type { Agent, Confidence, DependencyType, TechDomain, WorkType } from '../vocabulary.ts';
import type { ErrorCode } from './errors.ts';

/* ---- 변경 제안 ops. 스키마(models.ts ProposalOp·LeadProposalOp)와의 일치는 test/integration이 검사한다. ---- */
interface WireTask {
  title: string;
  type: WorkType;
  domain: TechDomain;
  rel?: readonly TechDomain[];
  wp: string;
  priority: number;
  assignee: Agent;
  verifier: Agent;
  purpose: string;
  doneCond: string;
  est?: number;
  lo?: number;
  hi?: number;
  tok?: number;
  conf?: Confidence;
  basis?: string;
  ac?: readonly (Omit<AcceptanceCriterion, 'method'> & { method?: string })[];
  srcV?: number;
  splitBasis?: string;
  judgedRules?: JudgedRules;
}
export type WireProposalOp =
  | { op: 'add'; ref: string; t: WireTask; preds: readonly { pred: string; type: DependencyType }[] }
  | { op: 'modify'; task: string; field: string; before?: unknown; after: string | number }
  | { op: 'remove'; task: string }
  | { op: 'dep-add'; pred: string; succ: string; type: DependencyType }
  | { op: 'dep-remove'; pred: string; succ: string };

/**
 * 저장·요청의 op(P 키)를 시뮬레이션 입력으로 바꾼다. 스키마를 통과한 값만 받는다.
 * 추정이 없으면 null로 둔다(P의 4h는 Mock). 추정만 있고 신뢰도가 없으면 P newTask와 같이 「하」다.
 */
export function simulationOp(op: WireProposalOp): SimulationOp {
  if (op.op === 'modify') {
    const { task, field, after } = op;
    // 값 검증은 simulateProposal이 한다.
    return { op: 'modify', task, field, after } as SimulationOp;
  }
  if (op.op !== 'add') return { ...op };
  const { t } = op;
  const task: NewTask = {
    title: t.title, workType: t.type, primaryDomain: t.domain, relatedDomains: t.rel ?? [],
    priority: t.priority, assignee: t.assignee, verifier: t.verifier, purpose: t.purpose, doneCond: t.doneCond,
    ac: (t.ac ?? []).map((item) => ({ ...item, method: item.method ?? '' })),
    estimate: t.est === undefined ? null : { est: t.est, lo: t.lo ?? null, hi: t.hi ?? null, confidence: t.conf ?? '하' },
    splitBasis: t.splitBasis ?? '', judgedRules: t.judgedRules ?? null,
  };
  return { op: 'add', ref: op.ref, workPackageId: t.wp, task, preds: op.preds.map((item) => ({ ...item })) };
}

/* ---- 보류 사유 · 반영 불가 사유(contracts §2.1, D-33~35) ---- */
type HoldCode = 'JUDGEMENT_MISSING' | 'JUDGEMENT_NOT_MET' | 'ORDER_NOT_PRESERVED' | 'ACTIVE_TASK_BLOCKED';
export interface WireHoldReason extends Omit<JudgementHold, 'code'> {
  code: HoldCode;
}
/** 보류 사유가 있을 때 수동 승인·반영의 409 코드. 이 목록에 없는 판정 코드는 `issues`로 간다. */
export const HOLD_ERROR = {
  JUDGEMENT_MISSING: 'SPLIT_JUDGEMENT_REQUIRED',
  JUDGEMENT_NOT_MET: 'SPLIT_JUDGEMENT_REQUIRED',
  ORDER_NOT_PRESERVED: 'ORDER_NOT_PRESERVED',
  ACTIVE_TASK_BLOCKED: 'ACTIVE_TASK_BLOCKED',
} as const satisfies Record<HoldCode, ErrorCode>;
const isHold = (code: string): code is HoldCode => Object.hasOwn(HOLD_ERROR, code);

/** ProposalIssue·JudgementHold·SplitProblem의 공통 모양 */
interface Problem {
  code: string;
  index?: number | null;
  taskKey?: string;
  rule?: JudgementHold['rule'];
  message: string;
}

export function proposalReasons(problems: readonly Problem[]) {
  const holdReasons: WireHoldReason[] = [];
  const issues: { index: number | null; code: string; message: string }[] = [];
  for (const { code, index = null, taskKey, rule, message } of problems) {
    if (isHold(code)) holdReasons.push({ code, ...(taskKey !== undefined && { taskKey }), ...(rule && { rule }), message });
    else issues.push({ index, code, message });
  }
  return { holdReasons, issues };
}

/* ---- 등급 조정 ---- */
type AdjustKind = 'up' | 'down' | 'keep' | 'regrade';
const wireGrade = ({ modelId, effort }: Grade) => ({ model: modelId, effort });
const RESOLVED_KIND = {
  none: null, resume: null, up: 'up', down: 'down', keep: 'keep', regrade: 'regrade',
} as const satisfies Record<ResolvedAdjust['kind'], AdjustKind | null>;

/** 조정이 없으면 null(같은 등급 재개 포함). 사유 문장은 기록하는 서버가 정한다. */
export function gradeAdjust({ adjust, grade }: Extract<ResolveResult, { ok: true }>, reason: string) {
  const kind = RESOLVED_KIND[adjust.kind];
  if (kind === null) return null;
  // 재판단 재개의 이전 등급은 허용이 해제된 직전 시도의 등급이다(D-29).
  const from = kind === 'regrade' && adjust.replaced ? adjust.replaced.grade : adjust.from;
  return { kind, from: wireGrade(from), to: wireGrade(grade), reason };
}

/* ---- 일정 경고 ---- */
export function scheduleWarning(warning: DomainScheduleWarning) {
  if (!('taskId' in warning)) return warning;
  const { taskId, ...rest } = warning;
  return { ...rest, taskKey: taskId };
}

/* ---- 오류 코드 ---- */
/** 계약에 없는 SCHEDULE_INVALID_TASK는 저장된 Task가 불변식을 어긴 것이라 요청 오류가 아니다. */
export const SCHEDULE_ERROR = {
  SCHEDULE_CYCLE: 'SCHEDULE_CYCLE',
  SCHEDULE_INVALID_TASK: 'INTERNAL',
} as const satisfies Record<ScheduleError['code'], ErrorCode>;

/** 등급을 정하지 못한 사유는 오류 코드가 아니라 이 코드의 `reasons`다(contracts §3.1). */
export const RUN_GRADE_ERROR = 'CLAIM_REJECTED' satisfies ErrorCode & DomainError['code'];
