import { expect, test } from 'vitest';
import { isBlocked } from '../../src/domain/index.ts';
import { simulateProposal } from '../../src/proposal/index.ts';
import type { SimulationOp } from '../../src/proposal/index.ts';
import { original, toSnapshot } from './original.ts';

const data = original.load();
const base = toSnapshot(data);
const ids = Object.keys(data.tasks);
const edges = (list: readonly { pred: string; succ: string; type: string }[]) => list.map(d => `${d.pred} ${d.type} ${d.succ}`);

let intended = 0;
function same(ops: SimulationOp[], originalOps: unknown[] = ops) {
  const old = original.simulate(data, originalOps);
  const now = simulateProposal(base, ops);
  const label = JSON.stringify(ops);
  // Intended difference (owner): the original lets a proposal newly block a Task in execution.
  const activeBlocked = now.issues.length > 0 && now.issues.every(issue => issue.code === 'ACTIVE_TASK_BLOCKED');
  if (activeBlocked) intended += 1;
  expect(activeBlocked || now.issues.length === 0, label).toBe(old.issues.length === 0);
  expect(now.idMap).toEqual(old.idMap);
  expect(now.next.tasks.map(t => [t.id, t.status])).toEqual(Object.values(old.x.tasks).map(t => [t.id, t.status]));
  expect(edges(now.next.dependencies), label).toEqual(edges(old.x.deps));
  if (old.issues.length) return;
  const rows = original.impactRows(data, old.x, originalOps, old.idMap);
  for (const id of ids) {
    const notes = rows.find(row => row.id === id)?.notes ?? '';
    const kinds = now.impact.tasks.find(row => row.taskKey === id)?.notes.map(note => note.kind) ?? [];
    // The original also calls a Task it just cancelled 「차단 해제 → 실행 가능」; that is not a release.
    const cancelled = kinds.includes('cancelled');
    expect(kinds.includes('unblocked'), `${label} ${id}`).toBe(notes.includes('차단 해제') && !cancelled);
    expect(kinds.includes('newly-blocked'), `${label} ${id}`).toBe(notes.includes('새로 실행 차단'));
    if (notes.includes('후속 영향')) expect(kinds.length, `${label} ${id}`).toBeGreaterThan(0);
  }
}

test('original demo has twelve Tasks and a blocked one to compare', () => {
  expect(ids).toHaveLength(12);
  expect(ids.some(id => isBlocked(base.tasks, base.dependencies, id))).toBe(true);
});

test('every remove matches Sel.simulate and impactRows', () => {
  for (const task of ids) same([{ op: 'remove', task }]);
});

test('every dep-add on an unfinished successor and every dep-remove match', () => {
  for (const pred of ids) {
    for (const succ of ids) {
      // Adding to a done successor is held here by G§5.6; the original accepts it.
      if (data.tasks[succ]?.status !== 'done') {
        for (const type of ['FS', 'SS'] as const) same([{ op: 'dep-add', pred, succ, type }]);
        same([{ op: 'dep-remove', pred, succ }]);
      }
    }
  }
});

test('the intended difference really occurs in the demo', () => {
  expect(intended).toBeGreaterThan(0);
});

test('modify on every Task and a chained add match', () => {
  for (const task of ids) same([{ op: 'modify', task, field: 'title', after: '새 제목' }]);
  const t = { title: 'N', workType: 'Analysis', primaryDomain: 'BE', priority: 1, assignee: 'Claude', verifier: 'Codex' } as const;
  const old = { title: 'N', type: 'Analysis', domain: 'BE', wp: 'WP-03', priority: 1, assignee: 'Claude', verifier: 'Codex' };
  same([{ op: 'add', ref: 'NEW-1', workPackageId: 'WP-03', task: t, preds: [{ pred: 'TASK-0003', type: 'FS' }] },
    { op: 'dep-add', pred: 'NEW-1', succ: 'TASK-0006', type: 'SS' }, { op: 'remove', task: 'TASK-0008' }],
  [{ op: 'add', ref: 'NEW-1', t: old, preds: [{ pred: 'TASK-0003', type: 'FS' }] },
    { op: 'dep-add', pred: 'NEW-1', succ: 'TASK-0006', type: 'SS' }, { op: 'remove', task: 'TASK-0008' }]);
  same([{ op: 'add', ref: 'NEW-1', workPackageId: 'WP-NO', task: t }], [{ op: 'add', ref: 'NEW-1', t: { ...old, wp: 'WP-NO' } }]);
});
