// Domain-local contracts; API/DB adapters translate their rows at the boundary.
export const TASK_STATUSES = [
  'planning', 'approval', 'ready', 'running', 'paused', 'qa',
  'rework', 'verifying', 'gate', 'failed', 'done', 'cancelled',
] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export const ATTEMPT_KINDS = ['dev', 'qa', 'rework', 'reverify'] as const;
export type AttemptKind = typeof ATTEMPT_KINDS[number];
export type AttemptStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export type VerificationResult = 'PASS' | 'FAIL' | 'BLOCKED';

export interface Task {
  id: string;
  status: TaskStatus;
}

export interface Dependency {
  pred: string;
  succ: string;
  type: 'FS' | 'SS';
}

export interface ChecklistItem {
  id: string;
  required: boolean;
  done: boolean;
  evidence: string;
  note: string;
}

export interface CodeBasis {
  headSha: string;
  specRevision: number;
  inputVersion: number;
}

export interface Verification extends CodeBasis {
  result: VerificationResult;
  invalidated: boolean;
}

type DomainErrorCode = 'INVALID_TRANSITION' | 'VALIDATION_FAILED' | 'TASK_NOT_FOUND' |
  'GATE_NOT_PASSED' | 'CLAIM_REJECTED' | 'ATTEMPT_CLOSED' | 'CLEANUP_PENDING' | 'SUBAGENT_INSTALL_FAILED' |
  'DEPENDENCY_SELF' | 'DEPENDENCY_DUPLICATE' | 'DEPENDENCY_CYCLE' | 'TASK_HAS_SUCCESSORS';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}
