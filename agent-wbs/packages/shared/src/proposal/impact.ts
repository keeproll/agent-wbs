import { blockers, isBlocked } from '../domain/index.ts';
import type {
  ImpactNote, ModifyField, ProposalDiff, ProposalImpact, ProposalSnapshot, RemovedDependency,
} from './types.ts';

export function proposalImpact(
  base: ProposalSnapshot, next: ProposalSnapshot, diff: readonly ProposalDiff[], removed: RemovedDependency[],
): ProposalImpact {
  const notes = new Map<string, ImpactNote[]>();
  const note = (id: string, value: ImpactNote) => {
    const list = notes.get(id) ?? [];
    if (!list.some(item => JSON.stringify(item) === JSON.stringify(value))) list.push(value);
    notes.set(id, list);
  };
  for (const { op, target, field, before, after } of diff) {
    if (op === 'add') note(target, { kind: 'created' });
    else if (op === 'modify') note(target, { kind: 'modified', field: field as ModifyField });
    else if (op === 'remove') note(target, { kind: 'cancelled' });
    else if (op === 'dep-add') note(target, { kind: 'dependency-added', pred: (after as { pred: string }).pred });
    else note(target, { kind: 'dependency-removed', pred: (before as { pred: string }).pred });
  }

  const open = new Map(next.tasks.filter(task => task.status !== 'done' && task.status !== 'cancelled')
    .map(task => [task.id, task]));
  const byCancel = removed.filter(dep => dep.reason === 'pred-cancelled' && open.has(dep.succ));
  byCancel.forEach(dep => note(dep.succ, { kind: 'dependency-removed-by-cancel', pred: dep.pred }));

  for (const { id } of base.tasks) {
    if (!open.has(id)) continue;
    const before = isBlocked(base.tasks, base.dependencies, id);
    const after = isBlocked(next.tasks, next.dependencies, id);
    if (before !== after) note(id, { kind: after ? 'newly-blocked' : 'unblocked' });
  }

  const queue = [...notes.keys()];
  const seen = new Set(queue);
  for (const via of queue) {
    for (const { succ } of next.dependencies.filter(dep => dep.pred === via)) {
      if (seen.has(succ)) continue;
      seen.add(succ);
      queue.push(succ);
      note(succ, { kind: 'downstream', via });
    }
  }

  const statuses = new Map(next.tasks.map(task => [task.id, task.status]));
  return {
    tasks: [...notes].map(([taskKey, list]) => ({ taskKey, notes: list })),
    removedDependencies: removed,
    unblockedSuccessors: [...new Set(byCancel.map(dep => dep.succ))].map(taskKey => ({
      taskKey,
      remainingBlockers: blockers(next.tasks, next.dependencies, taskKey)
        .map(dep => ({ ...dep, predStatus: statuses.get(dep.pred) ?? null })),
    })),
  };
}
