import { describe, expect, test } from 'vitest';
import {
  TASK_STATUSES, assertDependency, assertTaskDeletable, blockers, cancelBeforeStart,
  cyclePath, dependencyMet, isBlocked,
} from '../../src/domain/index.ts';
import type { Dependency, Task } from '../../src/domain/index.ts';

const edge: Dependency = { pred: 'A', succ: 'B', type: 'SS' };

describe('FS/SS for all representative states', () => {
  for (const status of TASK_STATUSES) {
    test(status, () => {
      const tasks = [{ id: 'A', status }];
      expect(dependencyMet(tasks, { ...edge, type: 'FS' })).toBe(status === 'done');
      expect(dependencyMet(tasks, edge)).toBe(
        ['running', 'qa', 'verifying', 'rework', 'gate', 'failed', 'paused', 'done'].includes(status),
      );
    });
  }
});

test('blockers are calculated; done is never blocked and missing predecessor fails closed', () => {
  const tasks: Task[] = [{ id: 'A', status: 'running' }, { id: 'B', status: 'ready' }];
  expect(blockers(tasks, [edge], 'B')).toEqual([]);
  expect(isBlocked(tasks, [{ ...edge, type: 'FS' }], 'B')).toBe(true);
  expect(isBlocked([{ id: 'B', status: 'done' }], [edge], 'B')).toBe(false);
  expect(dependencyMet([], edge)).toBe(false);
  expect(isBlocked(tasks, [edge], 'missing')).toBe(false);
});

test('dependency validation rejects self, duplicates regardless of kind, missing references and cycles with path', () => {
  const tasks: Task[] = ['A', 'B', 'C', 'D'].map(id => ({ id, status: 'ready' }));
  const dependencies: Dependency[] = [edge, { pred: 'B', succ: 'C', type: 'FS' }];
  expect(() => assertDependency(tasks, dependencies, { ...edge, pred: 'B' })).toThrow(expect.objectContaining({ code: 'DEPENDENCY_SELF' }));
  expect(() => assertDependency(tasks, dependencies, { ...edge, type: 'FS' })).toThrow(expect.objectContaining({ code: 'DEPENDENCY_DUPLICATE' }));
  expect(() => assertDependency(tasks, dependencies, { ...edge, pred: 'missing' })).toThrow(expect.objectContaining({ code: 'TASK_NOT_FOUND' }));
  expect(() => assertDependency(tasks, dependencies, { ...edge, succ: 'missing' })).toThrow(expect.objectContaining({ code: 'TASK_NOT_FOUND' }));
  const candidate: Dependency = { pred: 'C', succ: 'A', type: 'SS' };
  expect(cyclePath(dependencies, candidate)).toEqual(['A', 'B', 'C', 'A']);
  expect(() => assertDependency(tasks, dependencies, candidate)).toThrow(expect.objectContaining({
    code: 'DEPENDENCY_CYCLE', details: { path: ['A', 'B', 'C', 'A'] },
  }));
  expect(() => assertDependency(tasks, dependencies, { pred: 'A', succ: 'D', type: 'FS' })).not.toThrow();
  expect(() => assertDependency(tasks, dependencies, { pred: 'C', succ: 'D', type: 'SS' })).not.toThrow();
  expect(dependencies).toHaveLength(2);
});

test('DFS terminates with a pre-existing cycle and finds a path across converging branches', () => {
  const deps: Dependency[] = [
    { pred: 'A', succ: 'B', type: 'FS' }, { pred: 'B', succ: 'A', type: 'FS' },
    { pred: 'C', succ: 'B', type: 'SS' }, { pred: 'D', succ: 'C', type: 'FS' },
  ];
  expect(cyclePath(deps, { pred: 'A', succ: 'missing', type: 'FS' })).toBeNull();
  expect(cyclePath(deps, { pred: 'A', succ: 'D', type: 'SS' })).toEqual(['D', 'C', 'B', 'A', 'D']);
});

test('D-08: outgoing successors prevent deletion; incoming predecessors do not', () => {
  expect(() => assertTaskDeletable([edge], 'A')).toThrow(expect.objectContaining({ code: 'TASK_HAS_SUCCESSORS' }));
  expect(() => assertTaskDeletable([edge], 'B')).not.toThrow();
});

test.each(['planning', 'approval', 'ready'] as const)('D-27: cancelling %s removes SS and FS, frees successors and retains other blockers', status => {
  const tasks: readonly Task[] = Object.freeze([
    { id: 'A', status }, { id: 'B', status: 'ready' }, { id: 'C', status: 'ready' },
    { id: 'D', status: 'ready' }, { id: 'E', status: 'ready' },
  ]);
  const dependencies: readonly Dependency[] = Object.freeze([
    edge, { pred: 'A', succ: 'C', type: 'SS' }, { pred: 'D', succ: 'C', type: 'FS' },
    { pred: 'A', succ: 'E', type: 'FS' }, { pred: 'D', succ: 'A', type: 'FS' },
  ]);
  const result = cancelBeforeStart(tasks, dependencies, 'A', false);
  expect(result.tasks.find(task => task.id === 'A')?.status).toBe('cancelled');
  expect(result.removedDependencies).toHaveLength(4);
  expect(result.dependencies).toEqual([{ pred: 'D', succ: 'C', type: 'FS' }]);
  expect(result.successors).toEqual([
    { id: 'B', wasBlocked: true, isBlocked: false, blockers: [] },
    { id: 'C', wasBlocked: true, isBlocked: true, blockers: [{ pred: 'D', succ: 'C', type: 'FS' }] },
    { id: 'E', wasBlocked: true, isBlocked: false, blockers: [] },
  ]);
  expect(dependencyMet(result.tasks, edge)).toBe(false);
  expect(tasks.find(task => task.id === 'A')?.status).toBe(status);
  expect(dependencies).toHaveLength(5);
});

test('cancellation rejects history, missing Task and every other state', () => {
  expect(() => cancelBeforeStart([{ id: 'A', status: 'ready' }], [], 'A', true)).toThrow();
  expect(() => cancelBeforeStart([], [], 'missing', false)).toThrow(expect.objectContaining({ code: 'TASK_NOT_FOUND' }));
  for (const status of TASK_STATUSES.filter(status => !['planning', 'approval', 'ready'].includes(status))) {
    expect(() => cancelBeforeStart([{ id: 'A', status }], [], 'A', false)).toThrow();
  }
});
