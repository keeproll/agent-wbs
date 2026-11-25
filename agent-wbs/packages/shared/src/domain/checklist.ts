import { DomainError } from './types.ts';
import type { ChecklistItem, VerificationResult } from './types.ts';

export function checklistSummary(items: readonly Pick<ChecklistItem, 'required' | 'done'>[]) {
  const total = items.length;
  const done = items.filter(item => item.done).length;
  const requiredLeft = items.filter(item => item.required && !item.done).length;
  return { total, done, requiredLeft, percent: total ? Math.round(done / total * 100) : 0 };
}

export function applyChecklistVerification(
  items: readonly ChecklistItem[], selectedIds: readonly string[], result: VerificationResult,
  verificationId: string, evidence: readonly string[],
): readonly ChecklistItem[] {
  if (result === 'BLOCKED') return items;
  if (selectedIds.some(id => !items.some(item => item.id === id))) {
    throw new DomainError('VALIDATION_FAILED', '알 수 없는 체크리스트 항목입니다.');
  }
  return items.map(item => selectedIds.includes(item.id) ? {
    ...item,
    done: result === 'PASS',
    note: `${result === 'PASS' ? '통과' : 'FAIL'} ${verificationId}`,
    evidence: evidence[0] || item.evidence,
  } : item);
}
