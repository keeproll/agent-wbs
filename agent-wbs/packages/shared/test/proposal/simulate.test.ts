import { describe, expect, test } from 'vitest';
import { TASK_STATUSES } from '../../src/domain/index.ts';
import { canonicalPreview, parseAcceptanceCriterion, simulateProposal } from '../../src/proposal/index.ts';
import type { ProposalOp } from '../../src/proposal/index.ts';
import { ac, add, dep, newTask, snapshot, task } from './fixtures.ts';

const codes = (base: ReturnType<typeof snapshot>, ...ops: unknown[]) =>
  simulateProposal(base, ops as ProposalOp[]).issues.map(issue => issue.code);
const notesOf = (result: ReturnType<typeof simulateProposal>, id: string) =>
  result.impact.tasks.find(item => item.taskKey === id)?.notes;

describe('five change types', () => {
  test('add: next ID, planning state, checklist from AC, reference resolution, WBS placement, immutable input', () => {
    const base = snapshot([task('TASK-0001', 'done')]);
    const before = structuredClone(base);
    const result = simulateProposal(base, [
      add('NEW-1', {}, [{ pred: 'TASK-0001', type: 'FS' }]), add('NEW-2', { estimate: null }, [{ pred: 'NEW-1', type: 'SS' }]),
    ]);
    expect(base).toEqual(before);
    expect(result.issues).toEqual([]);
    expect(result.idMap).toEqual({ 'NEW-1': 'TASK-0021', 'NEW-2': 'TASK-0022' });
    expect(result.next.taskSequence).toBe(22);
    expect(result.next.phases[0]?.wps[0]?.tasks).toEqual(['TASK-0001', 'TASK-0021', 'TASK-0022']);
    expect(result.next.dependencies).toEqual([dep('TASK-0001', 'TASK-0021'), dep('TASK-0021', 'TASK-0022', 'SS')]);
    expect(result.next.tasks[1]).toMatchObject({ status: 'planning', hasExecutionHistory: false,
      design: [{ kind: 'API', items: [] }],
      checklist: [{ id: 'CL-0021-1', text: 'new ok', required: true, done: false, method: '자동 테스트' }] });
    expect(result.next.tasks[2]?.estimate).toBeNull();
  });

  test('add cannot forge lifecycle fields', () => {
    const forged = { ...newTask(), status: 'done', hasExecutionHistory: true, checklist: [], exceptions: [{ rule: 'size' }] };
    const result = simulateProposal(snapshot([]), [{ op: 'add', ref: 'N', workPackageId: 'WP-1', task: forged }]);
    expect(result.next.tasks[0]).toMatchObject({ status: 'planning', hasExecutionHistory: false, exceptions: [] });
    expect(result.next.tasks[0]?.checklist).toHaveLength(1);
  });

  test.each([
    ['priority', 0, { priority: 0 }, 2], ['title', '새 제목', { title: '새 제목' }, 'T'],
    ['doneCond', '조건', { doneCond: '조건' }, 'd'], ['assignee', 'Codex', { assignee: 'Codex' }, 'Claude'],
    ['verifier', 'Claude', { verifier: 'Claude' }, 'Codex'], ['scopeAdd', 'x', { scope: ['s', 'x'] }, null],
    ['acAdd', 'Given a, When b, Then c', { ac: [ac('T ok'), { given: 'a', when: 'b', then: 'c', method: '' }] }, null],
  ] as const)('modify %s', (field, after, patch, before) => {
    const result = simulateProposal(snapshot([task('T')]), [{ op: 'modify', task: 'T', field, after }]);
    expect(result.issues).toEqual([]);
    expect(result.next.tasks[0]).toEqual({ ...task('T'), ...patch });
    expect(result.diff).toEqual([{ index: 0, op: 'modify', target: 'T', field, before, after }]);
  });

  test('dep-add and dep-remove, default FS', () => {
    const base = snapshot([task('A'), task('B'), task('C')], [dep('A', 'B', 'SS')]);
    const result = simulateProposal(base, [{ op: 'dep-remove', pred: 'A', succ: 'B' }, { op: 'dep-add', pred: 'C', succ: 'B' }]);
    expect(result.next.dependencies).toEqual([dep('C', 'B')]);
    expect(result.diff.map(row => [row.before, row.after])).toEqual([
      [{ pred: 'A', type: 'SS' }, null], [null, { pred: 'C', type: 'FS' }]]);
    expect(result.impact.removedDependencies).toEqual([{ ...dep('A', 'B', 'SS'), reason: 'dep-remove' }]);
    expect(result.impact.unblockedSuccessors).toEqual([]);
  });
});

describe('hold conditions (G§5.6, §4.8)', () => {
  const base = snapshot([task('A'), task('B'), task('D', 'done'), task('X', 'cancelled', { hasExecutionHistory: false })],
    [dep('A', 'B'), dep('D', 'A')]);

  test.each([
    ['missing target', { op: 'modify', task: 'NO', field: 'title', after: 'x' }, 'TASK_NOT_FOUND'],
    ['missing remove target', { op: 'remove', task: 'NO' }, 'TASK_NOT_FOUND'],
    ['missing predecessor', { op: 'dep-add', pred: 'NO', succ: 'A' }, 'TASK_NOT_FOUND'],
    ['missing successor', { op: 'dep-add', pred: 'A', succ: 'NO' }, 'TASK_NOT_FOUND'],
    ['missing predecessor of a new Task', add('N', {}, [{ pred: 'NO', type: 'FS' }]), 'TASK_NOT_FOUND'],
    ['completed modify', { op: 'modify', task: 'D', field: 'title', after: 'x' }, 'COMPLETED_TASK'],
    ['completed remove', { op: 'remove', task: 'D' }, 'COMPLETED_TASK'],
    ['completed successor gets a relation', { op: 'dep-add', pred: 'B', succ: 'D' }, 'COMPLETED_TASK'],
    ['cycle', { op: 'dep-add', pred: 'B', succ: 'A' }, 'DEPENDENCY_CYCLE'],
    ['self', { op: 'dep-add', pred: 'A', succ: 'A' }, 'DEPENDENCY_SELF'],
    ['missing Work Package', { ...add('N'), workPackageId: 'WP-NO' }, 'WBS_NODE_NOT_FOUND'],
    ['relation already there', { op: 'dep-add', pred: 'A', succ: 'B' }, 'DEPENDENCY_DUPLICATE'],
    ['relation already gone', { op: 'dep-remove', pred: 'B', succ: 'A' }, 'DEPENDENCY_NOT_FOUND'],
    ['value already applied', { op: 'modify', task: 'A', field: 'priority', after: 2 }, 'ALREADY_APPLIED'],
    ['scope already applied', { op: 'modify', task: 'A', field: 'scopeAdd', after: 's' }, 'ALREADY_APPLIED'],
    ['AC already applied', { op: 'modify', task: 'A', field: 'acAdd', after: ac('A ok') }, 'ALREADY_APPLIED'],
    ['already cancelled', { op: 'remove', task: 'X' }, 'ALREADY_APPLIED'],
    ['cancelled edit', { op: 'modify', task: 'X', field: 'title', after: 'x' }, 'CANCELLED_TASK'],
    ['cancelled predecessor', { op: 'dep-add', pred: 'X', succ: 'A' }, 'CANCELLED_TASK'],
    ['cancelled predecessor of a new Task', add('N', {}, [{ pred: 'X', type: 'SS' }]), 'CANCELLED_TASK'],
    ['status write', { op: 'modify', task: 'A', field: 'status', after: 'done' }, 'VALIDATION_FAILED'],
    ['priority range', { op: 'modify', task: 'A', field: 'priority', after: 4 }, 'VALIDATION_FAILED'],
    ['unknown Agent', { op: 'modify', task: 'A', field: 'assignee', after: 'Other' }, 'VALIDATION_FAILED'],
    ['long title', { op: 'modify', task: 'A', field: 'title', after: 'x'.repeat(201) }, 'VALIDATION_FAILED'],
    ['duplicate reference', add('A'), 'VALIDATION_FAILED'],
    ['primary among related', add('N', { relatedDomains: ['BE'] }), 'VALIDATION_FAILED'],
    ['estimate order', add('N', { estimate: { est: 2, lo: 3, hi: 4, confidence: '중' } }), 'VALIDATION_FAILED'],
    ['unknown relation type', { op: 'dep-add', pred: 'D', succ: 'B', type: 'FF' }, 'VALIDATION_FAILED'],
    ['unknown op', { op: 'drop' }, 'VALIDATION_FAILED'],
  ])('%s', (_name, op, code) => {
    expect(codes(base, op)).toEqual([code]);
  });

  test('empty proposal and cycle path', () => {
    expect(codes(base)).toEqual(['EMPTY_PROPOSAL']);
    expect(simulateProposal(base, [{ op: 'dep-add', pred: 'B', succ: 'A' }]).issues[0]?.message).toContain('A → B → A');
  });

  test('relation removal from a completed successor is held', () => {
    const done = snapshot([task('A'), task('D', 'done')], [dep('A', 'D')]);
    expect(codes(done, { op: 'dep-remove', pred: 'A', succ: 'D' })).toEqual(['COMPLETED_TASK']);
  });

  test('a cycle built inside one proposal is caught', () => {
    expect(codes(snapshot([task('A'), task('B')]), { op: 'dep-add', pred: 'A', succ: 'B' },
      { op: 'dep-add', pred: 'B', succ: 'A' })).toEqual(['DEPENDENCY_CYCLE']);
  });

  test.each(TASK_STATUSES)('remove in status %s', status => {
    const expected = { planning: [], approval: [], ready: [], done: ['COMPLETED_TASK'], cancelled: ['ALREADY_APPLIED'] };
    expect(codes(snapshot([task('T', status)]), { op: 'remove', task: 'T' }))
      .toEqual((expected as Record<string, string[]>)[status] ?? ['EXECUTION_HISTORY']);
  });

  test('D-16: a ready Task with execution history is not cancelled', () => {
    const result = simulateProposal(snapshot([task('T', 'ready', { hasExecutionHistory: true })]), [{ op: 'remove', task: 'T' }]);
    expect(result.issues[0]?.code).toBe('EXECUTION_HISTORY');
    expect(result.next.tasks[0]?.status).toBe('ready');
  });
});

describe('cancellation impact (owner D-27)', () => {
  test.each(['planning', 'approval', 'ready'] as const)('cancelling a %s SS predecessor releases its only-blocked successor', status => {
    const result = simulateProposal(snapshot([task('P', status), task('S')], [dep('P', 'S', 'SS')]), [{ op: 'remove', task: 'P' }]);
    expect(result.next.dependencies).toEqual([]);
    expect(result.impact.removedDependencies).toEqual([{ ...dep('P', 'S', 'SS'), reason: 'pred-cancelled' }]);
    expect(result.impact.unblockedSuccessors).toEqual([{ taskKey: 'S', remainingBlockers: [] }]);
    expect(notesOf(result, 'S')).toEqual([{ kind: 'dependency-removed-by-cancel', pred: 'P' }, { kind: 'unblocked' }]);
  });

  test('released and still-blocked successors are told apart; FS and SS alike', () => {
    const base = snapshot([task('P'), task('Q', 'running'), task('U', 'planning'), task('R'), task('M')], [
      dep('P', 'R'), dep('P', 'M', 'SS'), dep('Q', 'M'), dep('U', 'M', 'SS'), dep('Q', 'R', 'SS'),
    ]);
    const result = simulateProposal(base, [{ op: 'remove', task: 'P' }]);
    expect(result.impact.unblockedSuccessors).toEqual([
      { taskKey: 'R', remainingBlockers: [] },
      { taskKey: 'M', remainingBlockers: [
        { ...dep('Q', 'M'), predStatus: 'running' }, { ...dep('U', 'M', 'SS'), predStatus: 'planning' }] },
    ]);
    expect(notesOf(result, 'M')).toEqual([{ kind: 'dependency-removed-by-cancel', pred: 'P' }]);
  });

  test('final state decides: a blocker added later in the same proposal is reported', () => {
    const base = snapshot([task('P'), task('N'), task('S')], [dep('P', 'S')]);
    const result = simulateProposal(base, [{ op: 'remove', task: 'P' }, { op: 'dep-add', pred: 'N', succ: 'S' }]);
    expect(result.impact.unblockedSuccessors).toEqual([
      { taskKey: 'S', remainingBlockers: [{ ...dep('N', 'S'), predStatus: 'ready' }] }]);
    expect(notesOf(result, 'S')?.map(note => note.kind)).not.toContain('unblocked');
  });

  test('cancelled Tasks are not reported as released, and incoming relations go too', () => {
    const base = snapshot([task('A'), task('P'), task('S')], [dep('A', 'P'), dep('P', 'S')]);
    const result = simulateProposal(base, [{ op: 'remove', task: 'P' }, { op: 'remove', task: 'S' }]);
    expect(result.impact.removedDependencies).toEqual([
      { ...dep('A', 'P'), reason: 'succ-cancelled' }, { ...dep('P', 'S'), reason: 'pred-cancelled' }]);
    expect(result.impact.unblockedSuccessors).toEqual([]);
    expect(notesOf(result, 'S')).toEqual([{ kind: 'cancelled' }]);
  });

  test('an edge born and dropped in the same proposal is not listed', () => {
    const base = snapshot([task('P'), task('S')]);
    const result = simulateProposal(base, [{ op: 'dep-add', pred: 'P', succ: 'S' }, { op: 'remove', task: 'P' }]);
    expect(result.impact.removedDependencies).toEqual([]);
  });

  test('newly blocked and transitive downstream', () => {
    const base = snapshot([task('A'), task('B'), task('C'), task('E')], [dep('B', 'C'), dep('C', 'E')]);
    const result = simulateProposal(base, [{ op: 'dep-add', pred: 'A', succ: 'B' }]);
    expect(notesOf(result, 'B')).toEqual([{ kind: 'dependency-added', pred: 'A' }, { kind: 'newly-blocked' }]);
    expect(notesOf(result, 'C')).toEqual([{ kind: 'downstream', via: 'B' }]);
    expect(notesOf(result, 'E')).toEqual([{ kind: 'downstream', via: 'C' }]);
  });
});

test('preview text: independent of jsonb key order, changes with any reviewed content', () => {
  const ops: ProposalOp[] = [{ op: 'modify', task: 'A', field: 'acAdd', after: { given: 'g', when: 'w', then: 'n', method: '' } }];
  const reordered: ProposalOp[] = [{ after: { method: '', then: 'n', when: 'w', given: 'g' }, field: 'acAdd', task: 'A', op: 'modify' }];
  const base = snapshot([task('A'), task('B')], [dep('B', 'A')]);
  const text = canonicalPreview(simulateProposal(base, ops));
  expect(canonicalPreview(simulateProposal(base, reordered))).toBe(text);
  const title: ProposalOp[] = [{ op: 'modify', task: 'A', field: 'title', after: 'n' }];
  const edited = snapshot([task('A', 'ready', { title: 'other' })]);
  expect(canonicalPreview(simulateProposal(edited, title)))
    .not.toBe(canonicalPreview(simulateProposal(snapshot([task('A')]), title)));
});

test('AC text parsing', () => {
  expect(parseAcceptanceCriterion('given a, when b, then c, d')).toEqual({ given: 'a', when: 'b', then: 'c, d', method: '' });
  expect(parseAcceptanceCriterion('free')).toEqual({ given: '', when: '', then: 'free', method: '' });
});
