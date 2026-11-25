import { expect, test } from 'vitest';
import { applyChecklistVerification, attemptKey, checklistSummary, displayKey, wbsNumbers } from '../../src/domain/index.ts';
import type { ChecklistItem, Phase } from '../../src/domain/index.ts';

test('checklist counts required and optional items and rounds total progress as the prototype', () => {
  expect(checklistSummary([])).toEqual({ total: 0, done: 0, requiredLeft: 0, percent: 0 });
  expect(checklistSummary([
    { required: true, done: false }, { required: true, done: true }, { required: false, done: false },
  ])).toEqual({ total: 3, done: 1, requiredLeft: 1, percent: 33 });
});

test('PASS completes selected items, FAIL reopens them, BLOCKED preserves checklist and evidence', () => {
  const items: readonly ChecklistItem[] = Object.freeze([
    Object.freeze({ id: 'CL-0007-1', required: true, done: false, evidence: 'old', note: 'old' }),
    Object.freeze({ id: 'CL-0007-2', required: false, done: false, evidence: '', note: '' }),
  ]);
  const completed = applyChecklistVerification(items, ['CL-0007-1'], 'PASS', 'V-0007-2', ['new', 'second']);
  expect(completed[0]).toEqual({ ...items[0], done: true, evidence: 'new', note: '통과 V-0007-2' });
  expect(completed[1]).toBe(items[1]);
  expect(items[0]?.done).toBe(false);
  const failed = applyChecklistVerification(completed, ['CL-0007-1'], 'FAIL', 'V-0007-3', []);
  expect(failed[0]).toEqual({ ...completed[0], done: false, note: 'FAIL V-0007-3' });
  expect(applyChecklistVerification(completed, ['CL-0007-1'], 'BLOCKED', 'V-0007-4', ['ignored'])).toBe(completed);
  expect(() => applyChecklistVerification(items, ['missing'], 'PASS', 'V', [])).toThrow();
});

test('WBS numbering follows position while Task IDs remain stable on task/WP/phase moves', () => {
  const phases: Phase[] = [
    { id: 'PH-1', wps: [{ id: 'WP-01', tasks: ['TASK-0001', 'TASK-0002'] }] },
    { id: 'PH-2', wps: [{ id: 'WP-02', tasks: [] }, { id: 'WP-03', tasks: ['TASK-0007'] }] },
  ];
  const before = wbsNumbers(phases);
  expect(Object.fromEntries(before.task)).toEqual({ 'TASK-0001': '1.1.1', 'TASK-0002': '1.1.2', 'TASK-0007': '2.2.1' });
  const after = wbsNumbers([
    { id: 'PH-2', wps: [{ id: 'WP-03', tasks: ['TASK-0002', 'TASK-0007'] }, { id: 'WP-02', tasks: [] }] },
    { id: 'PH-1', wps: [{ id: 'WP-01', tasks: ['TASK-0001'] }] },
  ]);
  expect(after.task.get('TASK-0001')).toBe('2.1.1');
  expect(after.task.get('TASK-0002')).toBe('1.1.1');
  expect(after.task.get('TASK-0007')).toBe('1.1.2');
  expect(after.wp.get('WP-03')).toBe('1.1');
  expect(after.phase.get('PH-1')).toBe('2');
  expect(wbsNumbers([]).task.size).toBe(0);
});

test('display IDs use documented minimum widths; attempts are numbered per Task', () => {
  expect(displayKey('TASK', 7)).toBe('TASK-0007');
  expect(attemptKey('TASK-0007', 2)).toBe('ATT-0007-2');
  expect(attemptKey('TASK-0008', 1)).toBe('ATT-0008-1');
  expect(displayKey('CP', 1)).toBe('CP-001');
  expect(displayKey('RP', 4)).toBe('RP-004');
  expect(displayKey('CI', 118)).toBe('CI-0118');
  expect(displayKey('TD', 3)).toBe('TD-03');
  expect(displayKey('TASK', 10000)).toBe('TASK-10000');
  expect(attemptKey('TASK-10000', 12)).toBe('ATT-10000-12');
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => displayKey('TASK', invalid)).toThrow();
    expect(() => attemptKey('TASK-0007', invalid)).toThrow();
  }
  expect(() => attemptKey('1.2.3', 1)).toThrow();
});
