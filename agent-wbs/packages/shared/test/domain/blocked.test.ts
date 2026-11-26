import { expect, test } from 'vitest';
import { blockedTasks, isBlocked, type Dependency, type Task, type TaskStatus } from '../../src/domain/index.ts';

const STATUSES: TaskStatus[] = ['planning', 'approval', 'ready', 'running', 'qa', 'verifying', 'rework', 'paused', 'failed', 'gate', 'done', 'cancelled'];

/** srv-perf: blockedTasks는 Task마다 isBlocked를 부른 결과와 같아야 한다(없는 선행·중복 ID·SS/FS·완료 후행 포함). */
test('blockedTasks는 모든 Task에 isBlocked를 부른 것과 같다', () => {
  let seed = 42;
  const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 300; round++) {
    const n = 1 + Math.floor(r() * 25);
    // ID 범위를 Task 수보다 조금 넓혀 중복 ID와 없는 선행 Task가 생기게 한다.
    const tasks: Task[] = Array.from({ length: n }, () => ({ id: `T${String(Math.floor(r() * (n + 3)))}`, status: STATUSES[Math.floor(r() * STATUSES.length)] as TaskStatus }));
    const deps: Dependency[] = Array.from({ length: Math.floor(r() * n * 2) }, () => ({
      pred: `T${String(Math.floor(r() * (n + 3)))}`, succ: `T${String(Math.floor(r() * (n + 3)))}`, type: r() < 0.5 ? 'FS' : 'SS',
    }));
    const ids = [...new Set([...tasks.map((t) => t.id), ...deps.map((d) => d.succ)])];
    const expected = ids.filter((id) => isBlocked(tasks, deps, id)).sort();
    expect([...blockedTasks(tasks, deps)].sort(), `round ${String(round)}`).toEqual(expected);
  }
});
