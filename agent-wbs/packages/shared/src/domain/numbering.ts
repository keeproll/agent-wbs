import { DomainError } from './types.ts';

export interface Phase {
  id: string;
  wps: readonly { id: string; tasks: readonly string[] }[];
}

export function wbsNumbers(phases: readonly Phase[]) {
  const task = new Map<string, string>();
  const wp = new Map<string, string>();
  const phase = new Map<string, string>();
  phases.forEach((ph, i) => {
    phase.set(ph.id, String(i + 1));
    ph.wps.forEach((workPackage, j) => {
      wp.set(workPackage.id, `${i + 1}.${j + 1}`);
      workPackage.tasks.forEach((id, k) => task.set(id, `${i + 1}.${j + 1}.${k + 1}`));
    });
  });
  return { task, wp, phase };
}

const KEY_WIDTHS = { TASK: 4, CP: 3, RP: 3, CI: 4, TD: 2, DR: 2 } as const;
export const TASK_KEY_PATTERN = '^TASK-[0-9]{4,}$';
export const TASK_BRANCH_PATTERN = `^agent/${TASK_KEY_PATTERN.slice(1, -1)}(?:-h[0-9]+)?$`;
export const DESIGN_REF_PATTERN = `^(?:main|${TASK_BRANCH_PATTERN.slice(1, -1)})$`;

/** 생성과 검증이 같은 이름 규칙을 쓴다. -hN은 외부 쓰기 권한 세대 번호다. */
export function taskBranch(taskKey: string, generation?: number): string {
  if (!new RegExp(TASK_KEY_PATTERN).test(taskKey) || generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) {
    throw new DomainError('VALIDATION_FAILED', 'Task 브랜치 이름을 만들 수 없습니다.');
  }
  return `agent/${taskKey}${generation === undefined ? '' : `-h${String(generation)}`}`;
}

// Sequence allocation and non-reuse belong to the database transaction, not array length.
export function displayKey(kind: keyof typeof KEY_WIDTHS, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new DomainError('VALIDATION_FAILED', '표시 ID 순번은 양의 안전한 정수여야 합니다.');
  }
  return `${kind}-${String(sequence).padStart(KEY_WIDTHS[kind], '0')}`;
}

export function attemptKey(taskKey: string, sequence: number): string {
  if (!new RegExp(TASK_KEY_PATTERN).test(taskKey)) {
    throw new DomainError('VALIDATION_FAILED', 'Task 표시 ID 형식이 올바르지 않습니다.');
  }
  displayKey('TASK', sequence);
  return `ATT-${taskKey.slice(5)}-${sequence}`;
}
