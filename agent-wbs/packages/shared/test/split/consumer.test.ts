import { expect, test } from 'vitest';
import { canonicalPreview, checkSplit, simulateProposal, SPLIT_RULES, validateSplitProposal } from '@awbs/shared';
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
