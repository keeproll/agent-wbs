import { completionGate, completionReasons, verificationCurrent } from './gate.ts';
import type { CompletionInput, HeadSync } from './gate.ts';
import { attemptPolicyCounts } from './policy.ts';
import type { AttemptHistory } from './policy.ts';
import { approvalReasons } from './approval.ts';
import type { ApprovalInput } from './approval.ts';
import { DomainError } from './types.ts';
import type { AttemptKind, AttemptStatus, CodeBasis, TaskStatus, Verification, VerificationResult } from './types.ts';

// Owner Q-05 / data-model §3.1. Identity edges exist only for a new BLOCKED retry.
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  planning: ['approval', 'cancelled'],
  approval: ['ready', 'planning', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['qa', 'verifying', 'failed', 'paused'],
  paused: ['running', 'qa', 'verifying'],
  qa: ['gate', 'rework', 'paused', 'failed', 'qa'],
  rework: ['running'],
  verifying: ['gate', 'rework', 'paused', 'failed', 'verifying'],
  gate: ['verifying', 'done', 'rework'],
  failed: ['running', 'qa', 'verifying'],
  done: [],
  cancelled: [],
};

// This is only the structural table; use the event functions below for guarded decisions.
export function transitionPairAllowed(from: TaskStatus | null, to: TaskStatus): boolean {
  return from === null ? to === 'planning' || to === 'ready' : TASK_TRANSITIONS[from].includes(to);
}

export const CLAIM_KINDS: Readonly<Record<TaskStatus, readonly AttemptKind[]>> = {
  planning: [], approval: [], ready: ['dev'], running: [], paused: ['dev', 'qa', 'rework', 'reverify'],
  qa: ['qa'], rework: ['rework'], verifying: ['reverify'], gate: [],
  failed: ['dev', 'qa', 'rework', 'reverify'], done: [], cancelled: [],
};

export interface Attempt {
  kind: AttemptKind;
  status: AttemptStatus;
  modelId: string;
  effort: string;
  verificationResult: VerificationResult | null;
  verificationDisposition?: 'current' | 'stale';
}

// Only rows relevant to this Task/conflict group. M2-05 owns locking, handover and slot capacity atomically.
export interface ClaimHold {
  jobId: string;
  epoch: number;
  hostId: string | null;
  slotState: 'none' | 'reserved' | 'active' | 'unconfirmed';
  lockState: 'none' | 'held' | 'handed_over' | 'released' | 'orphaned';
  lockFromJobId: string | null;
  handedToJobId: string | null;
}

export interface ClaimInput {
  status: TaskStatus;
  kind: AttemptKind;
  previousAttempt: Attempt | null;
  hasOpenAttempt: boolean;
  jobId: string;
  epoch: number;
  hostId: string;
  holds: readonly ClaimHold[];
  cleanupPending: boolean;
  dependenciesMet: boolean;
  leaderRequested: boolean;
  autoRetryLimit: number;
  autoReworkLimit: number;
  taskCheckPassed: boolean;
  integrationFailed: boolean;
  evidenceInvalidated: boolean;
  history: readonly AttemptHistory[];
  modelId: string;
  effort: string;
  resumeGrade?: {
    previousModelAllowed: boolean;
    reassessed: boolean;
    modelId: string;
    effort: string;
    reason: string;
  };
}

function ownHold(input: ClaimInput, hold: ClaimHold): boolean {
  return hold.jobId === input.jobId && hold.epoch === input.epoch &&
    (hold.hostId === null || hold.hostId === input.hostId) && hold.lockState === 'held';
}

export function claimReasons(input: ClaimInput): string[] {
  const { status, kind, previousAttempt: previous } = input;
  const reasons: string[] = [];
  const counts = attemptPolicyCounts(input.history);
  if (input.hasOpenAttempt) reasons.push('열린 시도가 있습니다.');
  if (input.holds.some(hold => !ownHold(input, hold) &&
    (hold.lockState === 'held' || hold.hostId === input.hostId && hold.slotState !== 'none'))) {
    reasons.push('다른 job 또는 낡은 epoch/host의 보유가 남아 있습니다.');
  }
  if (input.holds.some(hold => ownHold(input, hold) && (hold.slotState === 'active' || hold.slotState === 'unconfirmed'))) {
    reasons.push('자기 보유의 실행·정리 확인이 끝나지 않았습니다.');
  }
  if (input.cleanupPending) reasons.push('정리 대기 중입니다.');
  if (kind === 'dev' && (status === 'ready' || status === 'failed') && !input.dependenciesMet) {
    reasons.push('선행 조건이 충족되어야 개발을 실행할 수 있습니다.');
  }
  if (!CLAIM_KINDS[status].includes(kind)) {
    reasons.push('현재 상태에서 허용되지 않는 시도 종류입니다.');
    return reasons;
  }
  switch (status) {
    case 'ready':
      if (!input.leaderRequested) reasons.push('팀장 시작 버튼이 필요합니다.');
      break;
    case 'rework':
      if (!input.integrationFailed && !(previous?.status === 'completed' &&
        previous.verificationDisposition !== 'stale' && (previous.kind === 'qa' || previous.kind === 'reverify') && previous.verificationResult === 'FAIL')) {
        reasons.push('QA 또는 통합 실패가 필요합니다.');
      }
      if (counts.automaticReworks >= input.autoReworkLimit && !input.leaderRequested) reasons.push('자동 재작업 한도 초과입니다.');
      break;
    case 'qa':
    case 'verifying':
      if (!input.taskCheckPassed) reasons.push('현재 head의 ① Task 검사 통과가 필요합니다.');
      if (previous?.verificationResult === 'BLOCKED' && !input.leaderRequested) reasons.push('BLOCKED 원인 해결 후 팀장 검증 요청이 필요합니다.');
      if (!(previous?.status === 'completed' && (
        previous.kind === (status === 'qa' ? 'dev' : 'rework') ||
        previous.kind === kind && (previous.verificationResult === 'BLOCKED' || previous.verificationDisposition === 'stale')
      ) || status === 'verifying' && input.evidenceInvalidated)) {
        reasons.push('① 통과 후 최초 검증, BLOCKED·낡은 결과 뒤 새 검증 또는 근거 무효화가 필요합니다.');
      }
      break;
    case 'paused': {
      if (previous?.status !== 'interrupted' || previous.kind !== kind || !input.leaderRequested) {
        reasons.push('중단된 종류로 팀장이 재개해야 합니다.');
      }
      const grade = input.resumeGrade;
      const reassessed = grade && !grade.previousModelAllowed && grade.reassessed && grade.reason.trim().length > 0 &&
        grade.modelId === input.modelId && grade.effort === input.effort;
      const sameGrade = previous?.modelId === input.modelId && previous.effort === input.effort;
      if (grade?.previousModelAllowed === false ? !reassessed : !sameGrade) {
        reasons.push('같은 등급 또는 모델 허용 해제 후 재판단한 유효 등급이 필요합니다.');
      }
      break;
    }
    case 'failed':
      if (previous?.status !== 'failed' || previous.kind !== kind) reasons.push('실패한 종류로 재시도해야 합니다.');
      if (counts.consecutiveFailures[kind] < 1) reasons.push('시도 이력에 연속 실패가 없습니다.');
      if (counts.consecutiveFailures[kind] > input.autoRetryLimit && !input.leaderRequested) reasons.push('자동 재시도 한도 초과입니다.');
      break;
    default:
      reasons.push('현재 상태에서 시도할 수 없습니다.');
  }
  return reasons;
}

export function claimIssue(input: ClaimInput): string | null {
  return claimReasons(input)[0] ?? null;
}

const ATTEMPT_TASK_STATE: Readonly<Record<AttemptKind, TaskStatus>> = {
  dev: 'running', rework: 'running', qa: 'qa', reverify: 'verifying',
};

export function startAttempt(input: ClaimInput, installed: boolean): TaskStatus {
  const reasons = claimReasons(input);
  if (!input.holds.some(hold => ownHold(input, hold) && hold.hostId === input.hostId && hold.slotState === 'reserved')) {
    reasons.push('현재 job·epoch·host의 자기 예약이 필요합니다.');
  }
  if (reasons.length) throw new DomainError(input.cleanupPending ? 'CLEANUP_PENDING' : 'CLAIM_REJECTED', reasons[0] ?? '', { reasons });
  if (!installed) throw new DomainError('SUBAGENT_INSTALL_FAILED', '하위 Agent 설치가 필요합니다.');
  return ATTEMPT_TASK_STATE[input.kind];
}

export function finishAttempt(
  status: TaskStatus, attempt: Pick<Attempt, 'kind' | 'status'>,
  result: Exclude<AttemptStatus, 'running'>, taskCheckPassed: boolean,
): { taskStatus: TaskStatus; attemptStatus: Exclude<AttemptStatus, 'running'> } {
  if (attempt.status !== 'running') throw new DomainError('ATTEMPT_CLOSED', '이미 종료된 시도입니다.');
  if (status !== ATTEMPT_TASK_STATE[attempt.kind]) {
    throw new DomainError('INVALID_TRANSITION', '열린 현재 단계의 시도만 종료할 수 있습니다.');
  }
  if (result === 'failed' || result === 'interrupted') {
    return { taskStatus: result === 'failed' ? 'failed' : 'paused', attemptStatus: result };
  }
  if ((attempt.kind !== 'dev' && attempt.kind !== 'rework') || !taskCheckPassed) {
    throw new DomainError('INVALID_TRANSITION', '개발·재작업 완료에는 ① 통과, QA 완료에는 검증 보고가 필요합니다.');
  }
  return { taskStatus: attempt.kind === 'dev' ? 'qa' : 'verifying', attemptStatus: 'completed' };
}

export function recordVerification(
  status: TaskStatus, attempt: Pick<Attempt, 'kind' | 'status'>, basis: CodeBasis, verification: Verification,
): { taskStatus: TaskStatus; attemptStatus: 'completed'; disposition: 'current' | 'stale' } {
  if (attempt.status !== 'running') throw new DomainError('ATTEMPT_CLOSED', '이미 종료된 시도입니다.');
  if (!(status === 'qa' && attempt.kind === 'qa' || status === 'verifying' && attempt.kind === 'reverify')) {
    throw new DomainError('INVALID_TRANSITION', '현재 QA·재검증 시도와 유효한 근거가 필요합니다.');
  }
  if (!verificationCurrent(basis, verification)) {
    return { taskStatus: status, attemptStatus: 'completed', disposition: 'stale' };
  }
  return { taskStatus: verification.result === 'PASS' ? 'gate' :
    verification.result === 'FAIL' ? 'rework' : status, attemptStatus: 'completed', disposition: 'current' };
}

export type LifecycleEvent =
  | { type: 'request-approval'; leader: boolean; spec: ApprovalInput }
  | { type: 'approve'; leader: boolean; spec: ApprovalInput }
  | { type: 'reject'; leader: boolean }
  | { type: 'invalidate'; basis: CodeBasis; verification: Verification; headSync?: HeadSync | null }
  | { type: 'integration-failed' }
  | { type: 'complete'; evidence: CompletionInput };

export function lifecycleTransition(status: TaskStatus, event: LifecycleEvent): TaskStatus {
  if ((status === 'planning' && event.type === 'request-approval' || status === 'approval' && event.type === 'approve') && event.leader) {
    const reasons = approvalReasons(event.spec);
    if (reasons.length) throw new DomainError('VALIDATION_FAILED', '착수 승인의 명세 필수 항목이 부족합니다.', { reasons });
    return event.type === 'request-approval' ? 'approval' : 'ready';
  }
  if (status === 'approval' && event.type === 'reject' && event.leader) return 'planning';
  if (status === 'gate') {
    if (event.type === 'invalidate') return verificationCurrent(event.basis, event.verification, event.headSync) ? 'gate' : 'verifying';
    if (event.type === 'integration-failed') return 'rework';
    if (event.type === 'complete') {
      const reasons = completionReasons(event.evidence);
      if (reasons.length) throw new DomainError('GATE_NOT_PASSED', '완료 조건을 충족하지 못했습니다.', {
        conditions: completionGate(event.evidence), reasons,
      });
      return 'done';
    }
  }
  throw new DomainError('INVALID_TRANSITION', '현재 상태 또는 조건에서 허용되지 않는 사건입니다.');
}

export function initialTaskStatus(source: 'manual' | 'cp' | 'initial-wbs-approval'): TaskStatus {
  return source === 'initial-wbs-approval' ? 'ready' : 'planning';
}
