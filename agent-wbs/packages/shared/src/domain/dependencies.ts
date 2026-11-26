import { DomainError } from './types.ts';
import type { Dependency, Task } from './types.ts';

export function dependencyMet(tasks: readonly Task[], dependency: Dependency): boolean {
  return predMet(tasks.find(task => task.id === dependency.pred), dependency);
}

function predMet(pred: Task | undefined, dependency: Dependency): boolean {
  if (!pred) return false; // Coordinator R9: a missing reference never satisfies a dependency.
  if (dependency.type === 'FS') return pred.status === 'done';
  // Owner D-27: cancellation removes the edge; cancellation itself is not a start.
  return !['planning', 'approval', 'ready', 'cancelled'].includes(pred.status);
}

export function blockers(tasks: readonly Task[], dependencies: readonly Dependency[], taskId: string) {
  return dependencies.filter(dep => dep.succ === taskId && !dependencyMet(tasks, dep));
}

export function isBlocked(tasks: readonly Task[], dependencies: readonly Dependency[], taskId: string) {
  return tasks.some(task => task.id === taskId && task.status !== 'done') &&
    blockers(tasks, dependencies, taskId).length > 0;
}

/**
 * 차단된 Task 전체를 한 번에 구한다. 결과는 Task마다 `isBlocked`를 부른 것과 같다.
 * 목록 조회처럼 모든 Task의 차단 여부가 필요할 때 쓴다. Task마다 `isBlocked`를 부르면 Task 수의 제곱만큼 시간이 든다(srv-perf).
 */
export function blockedTasks(tasks: readonly Task[], dependencies: readonly Dependency[]): Set<string> {
  // `dependencyMet`의 `tasks.find`처럼 같은 ID가 여럿이면 첫 Task를 본다.
  const first = new Map<string, Task>();
  // `isBlocked`의 첫 조건: 그 ID로 완료되지 않은 Task가 하나라도 있다.
  const open = new Set<string>();
  for (const task of tasks) {
    if (!first.has(task.id)) first.set(task.id, task);
    if (task.status !== 'done') open.add(task.id);
  }
  const blocked = new Set<string>();
  for (const dep of dependencies) {
    if (open.has(dep.succ) && !predMet(first.get(dep.pred), dep)) blocked.add(dep.succ);
  }
  return blocked;
}

export function cyclePath(dependencies: readonly Dependency[], candidate: Dependency): string[] | null {
  const seen = new Set<string>();
  const visit = (id: string, path: string[]): string[] | null => {
    if (id === candidate.succ) return [...path].reverse().concat(candidate.succ);
    if (seen.has(id)) return null;
    seen.add(id);
    for (const dep of dependencies.filter(dep => dep.succ === id)) {
      const cycle = visit(dep.pred, [...path, dep.pred]);
      if (cycle) return cycle;
    }
    return null;
  };
  return visit(candidate.pred, [candidate.pred]);
}

export function assertDependency(
  tasks: readonly Task[], dependencies: readonly Dependency[], candidate: Dependency,
): void {
  if (!tasks.some(task => task.id === candidate.pred) || !tasks.some(task => task.id === candidate.succ)) {
    throw new DomainError('TASK_NOT_FOUND', '의존성의 대상 Task가 없습니다.');
  }
  if (candidate.pred === candidate.succ) {
    throw new DomainError('DEPENDENCY_SELF', '자기 자신을 선행으로 지정할 수 없습니다.');
  }
  if (tasks.some(task => task.id === candidate.pred && task.status === 'cancelled')) {
    throw new DomainError('INVALID_TRANSITION', '취소된 Task를 선행으로 추가할 수 없습니다.');
  }
  if (dependencies.some(dep => dep.pred === candidate.pred && dep.succ === candidate.succ)) {
    throw new DomainError('DEPENDENCY_DUPLICATE', '이미 있는 선행 관계입니다.');
  }
  const path = cyclePath(dependencies, candidate);
  if (path) throw new DomainError('DEPENDENCY_CYCLE', '순환 의존성이 발생합니다.', { path });
}

export function assertTaskDeletable(dependencies: readonly Dependency[], taskId: string): void {
  if (dependencies.some(dep => dep.pred === taskId)) {
    throw new DomainError('TASK_HAS_SUCCESSORS', '후속 Task가 있어 삭제할 수 없습니다.');
  }
}

// The caller persists cancellation, removed edges, history and replanning in one transaction.
export function cancelBeforeStart(
  tasks: readonly Task[], dependencies: readonly Dependency[], taskId: string, hasExecutionHistory: boolean,
) {
  const target = tasks.find(task => task.id === taskId);
  if (!target) throw new DomainError('TASK_NOT_FOUND', '취소할 Task가 없습니다.');
  if (hasExecutionHistory || !['planning', 'approval', 'ready'].includes(target.status)) {
    throw new DomainError('INVALID_TRANSITION', '시작 전 Task만 취소할 수 있습니다.');
  }
  const nextTasks = tasks.map(task => task.id === taskId ? { ...task, status: 'cancelled' as const } : task);
  const removedDependencies = dependencies.filter(dep => dep.pred === taskId || dep.succ === taskId);
  const nextDependencies = dependencies.filter(dep => dep.pred !== taskId && dep.succ !== taskId);
  const successorIds = [...new Set(removedDependencies.filter(dep => dep.pred === taskId).map(dep => dep.succ))];
  const successors = successorIds.map(id => ({
    id,
    wasBlocked: isBlocked(tasks, dependencies, id),
    isBlocked: isBlocked(nextTasks, nextDependencies, id),
    blockers: blockers(nextTasks, nextDependencies, id),
  }));
  return { tasks: nextTasks, dependencies: nextDependencies, removedDependencies, successors };
}
