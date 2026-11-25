/** API 스키마와 순수 판정이 함께 쓰는 값 철자. 한 곳에서만 정의한다(contracts §1 값 철자). */
export const AGENTS = ['Claude', 'Codex'] as const;
export type Agent = typeof AGENTS[number];
export const RUN_ROLES = ['dev', 'qa'] as const;
export type RunRole = typeof RUN_ROLES[number];
export const TASK_STATUSES = [
  'planning', 'approval', 'ready', 'running', 'paused', 'qa',
  'rework', 'verifying', 'gate', 'failed', 'done', 'cancelled',
] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export const ATTEMPT_KINDS = ['dev', 'qa', 'rework', 'reverify'] as const;
export type AttemptKind = typeof ATTEMPT_KINDS[number];
export const ATTEMPT_STATUSES = ['running', 'completed', 'failed', 'interrupted'] as const;
export type AttemptStatus = typeof ATTEMPT_STATUSES[number];
export const VERIFICATION_RESULTS = ['PASS', 'FAIL', 'BLOCKED'] as const;
export type VerificationResult = typeof VERIFICATION_RESULTS[number];
export const DEPENDENCY_TYPES = ['FS', 'SS'] as const;
export type DependencyType = typeof DEPENDENCY_TYPES[number];
export const WORK_TYPES = [
  'Analysis', 'Design', 'Implementation', 'Configuration', 'Test', 'Verification', 'Documentation', 'Integration',
] as const;
export type WorkType = typeof WORK_TYPES[number];
export const DOMAINS = ['FE', 'BE', 'DB', 'DevOps', 'API', 'QA', 'Architecture', 'Common'] as const;
export type TechDomain = typeof DOMAINS[number];
export const DESIGN_KINDS = ['DB', 'API', 'FE', 'DevOps'] as const;
export type DesignKind = typeof DESIGN_KINDS[number];
export const CONFIDENCES = ['상', '중', '하'] as const;
export type Confidence = typeof CONFIDENCES[number];
