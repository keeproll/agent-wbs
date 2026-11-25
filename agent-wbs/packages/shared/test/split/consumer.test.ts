import { expect, test } from 'vitest';
import { assertDependency, canonicalPreview, checkSplit, DomainError, simulateProposal, SPLIT_RULES, validateSplitProposal } from '@awbs/shared';
import type { ProposalOp, ProposalSnapshot, SplitCheck, SplitProposalResult } from '@awbs/shared';
import { HASH, snapshot, task } from '../proposal/fixtures.ts';

test('a package consumer reaches proposal and split through the root entry', () => {
  const base: ProposalSnapshot = snapshot([task('P'), task('S')], [{ pred: 'P', succ: 'S', type: 'SS' }]);
  const ops: ProposalOp[] = [{ op: 'remove', task: 'P' }];
  const result = simulateProposal(base, ops);
  expect(result.impact.unblockedSuccessors).toEqual([{ taskKey: 'S', remainingBlockers: [] }]);
  expect(canonicalPreview(result)).toContain('unblockedSuccessors');
  const check: SplitCheck = checkSplit(task('S'), [], HASH);
  expect(check.items).toHaveLength(SPLIT_RULES.length);
  const split: SplitProposalResult = validateSplitProposal(base, 'P', ops,
    { splitJudgements: null, splitSubjectHash: null, taskHashes: { before: {}, after: {} } });
  expect(split.problems.map(problem => problem.code)).toContain('NOTHING_TO_SPLIT');
});

test('domain and proposal agree through the root entry: cancelled predecessor is refused, live one accepted (D-27)', () => {
  for (const type of ['FS', 'SS'] as const) {
    for (const status of ['cancelled', 'ready'] as const) {
      const base = snapshot([task('P', status, { hasExecutionHistory: false }), task('S')]);
      const edge = { pred: 'P', succ: 'S', type };
      const refused = status === 'cancelled';
      const direct = () => { assertDependency(base.tasks, base.dependencies, edge); };
      if (refused) expect(direct).toThrow(DomainError);
      else expect(direct).not.toThrow();
      const codes = simulateProposal(base, [{ op: 'dep-add', ...edge }]).issues.map(issue => issue.code);
      expect(codes).toEqual(refused ? ['CANCELLED_TASK'] : []);
    }
  }
});
