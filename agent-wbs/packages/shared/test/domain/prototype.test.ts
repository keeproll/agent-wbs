import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import { blockers, checklistSummary, completionGate, cyclePath, wbsNumbers } from '../../src/domain/index.ts';
import type { ChecklistItem, Dependency, Phase, Task, VerificationResult } from '../../src/domain/index.ts';
import { completion, pass } from './fixtures.ts';

interface PrototypeTask extends Task {
  checklist: ChecklistItem[];
  outputs: { name: string; required?: boolean; delivered: boolean }[];
  verif: 'pass' | 'fail' | 'blocked' | 'running' | 'none';
  approved: boolean;
  defects: number;
}
interface PrototypeData {
  phases: Phase[];
  tasks: Record<string, PrototypeTask>;
  deps: Dependency[];
}
interface PrototypeSelectors {
  numbers(data: PrototypeData): { task: Record<string, string>; wp: Record<string, string>; phNo: Record<string, string> };
  blockers(data: PrototypeData, id: string): Dependency[];
  cl(task: PrototypeTask): { tot: number; done: number; reqLeft: number; pct: number };
  gate(data: PrototypeData, task: PrototypeTask): { s: VerificationResult }[];
  cyclePath(data: PrototypeData, successor: string, predecessor: string): string[] | null;
}

// Execute only the original literal demo data and pure selectors, without the UI or Api side effects.
const source = readFileSync(new URL('../../../../../prototype/uiux/Main.dc.html', import.meta.url), 'utf8');
const mock = source.slice(source.indexOf('const MOCK = {'), source.indexOf('/* 데이터 접근 지점'));
const selectors = source.slice(source.indexOf('  numbers(d) {'), source.indexOf('  recKinds(domain, rel)'));
const { data, original } = runInNewContext(`${mock}\nconst Sel = {${selectors}}; ({ data: MOCK, original: Sel });`) as {
  data: PrototypeData;
  original: PrototypeSelectors;
};

test('all twelve original demo Tasks: numbering, blockers, checklist and Gate statuses match Sel', () => {
  const tasks = Object.values(data.tasks);
  expect(tasks).toHaveLength(12);
  const numbers = wbsNumbers(data.phases);
  const expectedNumbers = original.numbers(data);
  expect(Object.fromEntries(numbers.task)).toEqual(expectedNumbers.task);
  expect(Object.fromEntries(numbers.wp)).toEqual(expectedNumbers.wp);
  expect(Object.fromEntries(numbers.phase)).toEqual(expectedNumbers.phNo);
  for (const task of tasks) {
    expect(blockers(tasks, data.deps, task.id)).toEqual(original.blockers(data, task.id));
    const oldChecklist = original.cl(task);
    expect(checklistSummary(task.checklist)).toEqual({
      total: oldChecklist.tot, done: oldChecklist.done, requiredLeft: oldChecklist.reqLeft, percent: oldChecklist.pct,
    });
    // Api.loadProject applies required:true to every demo output unless explicitly specified.
    const normalized = { ...task, outputs: task.outputs.map(output => ({ required: true, ...output })) };
    const result = task.verif === 'pass' ? 'PASS' : task.verif === 'fail' ? 'FAIL' : 'BLOCKED';
    const gate = completionGate(completion({ checklist: task.checklist, outputs: normalized.outputs,
      verification: task.verif === 'none' || task.verif === 'running' ? null : { ...pass, result },
      unresolvedBlockingDefects: task.defects, planningApprovedAt: task.approved ? 'approved' : null,
    }));
    expect(gate.map(condition => condition.result)).toEqual(original.gate(data, normalized).map(condition => condition.s));
  }
});

test('all candidate dependency pairs in the demo produce the same DFS cycle path as Sel', () => {
  for (const pred of Object.keys(data.tasks)) {
    for (const succ of Object.keys(data.tasks)) {
      expect(cyclePath(data.deps, { pred, succ, type: 'FS' })).toEqual(original.cyclePath(data, succ, pred));
    }
  }
});
