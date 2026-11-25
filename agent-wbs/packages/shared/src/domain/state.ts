import { canComplete, verificationCurrent } from './gate.ts';
import type { CompletionInput } from './gate.ts';
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
}

export interface ClaimInput {
  status: TaskStatus;
  kind: AttemptKind;
  previousAttempt: Attempt | null;
  hasOpenAttempt: boolean;
  hasOtherJobHold: boolean;
  cleanupPending: boolean;
  dependenciesMet: boolean;
  leaderRequested: boolean;
  taskCheckPassed: boolean;
  integrationFailed: boolean;
  evidenceInvalidated: boolean;
  consecutiveFailures: number;
  automaticReworks: number;
  modelId: string;
  effort: string;
}

export function claimIssue(input: ClaimInput): string | null {
  const { status, kind, previousAttempt: previous } = input;
  if (input.hasOpenAttempt) return '열린 시도가 있습니다.';
  if (input.hasOtherJobHold) return '다른 job이 Task 또는 충돌 묶음을 보유하고 있습니다.';
  if (input.cleanupPending) return '정리 대기 중입니다.';
  if (!CLAIM_KINDS[status].includes(kind)) return '현재 상태에서 허용되지 않는 시도 종류입니다.';
  switch (status) {
    case 'ready':
      return input.dependenciesMet && input.leaderRequested ? null : '선행 충족과 팀장 시작 버튼이 필요합니다.';
    case 'rework':
      if (!input.integrationFailed && !(previous?.status === 'completed' &&
        (previous.kind === 'qa' || previous.kind === 'reverify') && previous.verificationResult === 'FAIL')) {
        return 'QA 또는 통합 실패가 필요합니다.';
      }
      return input.automaticReworks < 3 || input.leaderRequested ? null : '자동 재작업 한도 초과입니다.';
    case 'qa':
      return input.taskCheckPassed && (
        previous?.kind === 'dev' && previous.status === 'completed' ||
        previous?.kind === 'qa' && previous.status === 'completed' && previous.verificationResult === 'BLOCKED'
      ) ? null : '① 통과 후 최초 QA 또는 BLOCKED 뒤 새 QA만 가능합니다.';
    case 'verifying':
      return input.evidenceInvalidated ||
        input.taskCheckPassed && previous?.kind === 'rework' && previous.status === 'completed' ||
        previous?.kind === 'reverify' && previous.status === 'completed' && previous.verificationResult === 'BLOCKED'
        ? null : '재작업 ① 통과, BLOCKED 또는 근거 무효화가 필요합니다.';
    case 'paused':
      return previous?.status === 'interrupted' && previous.kind === kind && input.leaderRequested &&
        previous.modelId === input.modelId && previous.effort === input.effort
        ? null : '중단된 종류·등급으로 팀장이 재개해야 합니다.';
    case 'failed':
      if (previous?.status !== 'failed' || previous.kind !== kind) return '실패한 종류로 재시도해야 합니다.';
      return input.consecutiveFailures <= 2 || input.leaderRequested ? null : '자동 재시도 한도 초과입니다.';
    default:
      return '현재 상태에서 시도할 수 없습니다.';
  }
}

const ATTEMPT_TASK_STATE: Readonly<Record<AttemptKind, TaskStatus>> = {
  dev: 'running', rework: 'running', qa: 'qa', reverify: 'verifying',
};

export function startAttempt(input: ClaimInput, installed: boolean): TaskStatus {
  const issue = claimIssue(input);
  if (issue || !installed) throw new DomainError('INVALID_TRANSITION', issue ?? '하위 Agent 설치가 필요합니다.');
  return ATTEMPT_TASK_STATE[input.kind];
}

export function finishAttempt(
  status: TaskStatus, attempt: Pick<Attempt, 'kind' | 'status'>,
  result: Exclude<AttemptStatus, 'running'>, taskCheckPassed: boolean,
): { taskStatus: TaskStatus; attemptStatus: Exclude<AttemptStatus, 'running'> } {
  if (attempt.status !== 'running' || status !== ATTEMPT_TASK_STATE[attempt.kind]) {
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
): { taskStatus: TaskStatus; attemptStatus: 'completed' } {
  if (attempt.status !== 'running' ||
    !(status === 'qa' && attempt.kind === 'qa' || status === 'verifying' && attempt.kind === 'reverify') ||
    !verificationCurrent(basis, verification)) {
    throw new DomainError('INVALID_TRANSITION', '현재 QA·재검증 시도와 유효한 근거가 필요합니다.');
  }
  return { taskStatus: verification.result === 'PASS' ? 'gate' :
    verification.result === 'FAIL' ? 'rework' : status, attemptStatus: 'completed' };
}

export type LifecycleEvent =
  | { type: 'request-approval'; specComplete: boolean }
  | { type: 'approve'; leader: boolean }
  | { type: 'reject'; leader: boolean }
  | { type: 'invalidate'; basis: CodeBasis; verification: Verification }
  | { type: 'integration-failed' }
  | { type: 'complete'; evidence: CompletionInput };

export function lifecycleTransition(status: TaskStatus, event: LifecycleEvent): TaskStatus {
  if (status === 'planning' && event.type === 'request-approval' && event.specComplete) return 'approval';
  if (status === 'approval' && event.type === 'approve' && event.leader) return 'ready';
  if (status === 'approval' && event.type === 'reject' && event.leader) return 'planning';
  if (status === 'gate') {
    if (event.type === 'invalidate' && !verificationCurrent(event.basis, event.verification)) return 'verifying';
    if (event.type === 'integration-failed') return 'rework';
    if (event.type === 'complete' && canComplete(event.evidence)) return 'done';
  }
  throw new DomainError('INVALID_TRANSITION', '현재 상태 또는 조건에서 허용되지 않는 사건입니다.');
}

export function initialTaskStatus(source: 'manual' | 'cp' | 'initial-wbs-approval'): TaskStatus {
  return source === 'initial-wbs-approval' ? 'ready' : 'planning';
}
