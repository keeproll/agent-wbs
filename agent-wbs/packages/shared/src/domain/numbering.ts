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

const KEY_WIDTHS = { TASK: 4, CP: 3, RP: 3, CI: 4, TD: 2 } as const;

// Sequence allocation and non-reuse belong to the database transaction, not array length.
export function displayKey(kind: keyof typeof KEY_WIDTHS, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new DomainError('VALIDATION_FAILED', '표시 ID 순번은 양의 안전한 정수여야 합니다.');
  }
  return `${kind}-${String(sequence).padStart(KEY_WIDTHS[kind], '0')}`;
}

export function attemptKey(taskKey: string, sequence: number): string {
  if (!/^TASK-\d{4,}$/.test(taskKey)) {
    throw new DomainError('VALIDATION_FAILED', 'Task 표시 ID 형식이 올바르지 않습니다.');
  }
  displayKey('TASK', sequence);
  return `ATT-${taskKey.slice(5)}-${sequence}`;
}
