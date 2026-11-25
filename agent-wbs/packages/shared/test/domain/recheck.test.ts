import { expect, test } from 'vitest';
import { canComplete, canIntegrate, claimIssue, completionReasons, startAttempt } from '../../src/domain/index.ts';
import type { CompletionInput } from '../../src/domain/index.ts';
import { attempt, claim, completion } from './fixtures.ts';

test('N1 completion binds the tested pipeline to the frozen merge-base definition', () => {
  const input = completion();
  if (!input.integration) throw new Error('fixture missing integration');
  const wrongPipeline = { ...input, basePipelineSha: 'pipeline', integration: { ...input.integration, pipelineSha: 'branch-own' } };
  expect(canComplete(wrongPipeline)).toBe(false);
  expect(completionReasons(wrongPipeline)).toContain('② 통합 확인의 pipeline SHA가 병합 기준 main 정의와 다릅니다.');
  expect(canComplete({ ...input, basePipelineSha: 'another-base-definition' })).toBe(false);
});

test('N1 completion uses the frozen base pipeline after main and its pipeline advance', () => {
  const input = { ...completion(), basePipelineSha: 'pipeline', currentBaseSha: 'merged-main', currentPipelineSha: 'new-main-pipeline' };
  expect(canComplete(input)).toBe(true);
});

test.each<Partial<CompletionInput>>([
  { checklist: [] }, { outputs: [] }, { verification: null },
  { unresolvedBlockingDefects: 1 }, { planningApprovedAt: null },
])('survivor: integration entry rejects each failed Gate condition: %j', patch => {
  expect(canIntegrate({ ...completion(patch), dependenciesMet: true,
    baseSha: 'base', pipelineSha: 'pipeline', currentBaseSha: 'base', currentPipelineSha: 'pipeline',
  })).toBe(false);
});

test('survivor: reverify FAIL permits the following rework', () => {
  expect(claimIssue(claim({ status: 'rework', kind: 'rework', leaderRequested: false,
    previousAttempt: { ...attempt, kind: 'reverify', verificationResult: 'FAIL' },
  }))).toBeNull();
});

test('survivor: start rejects same-host own held lock without a reserved slot', () => {
  const input = claim();
  const holds = input.holds.map(hold => ({ ...hold, slotState: 'none' as const }));
  expect(claimIssue({ ...input, holds })).toBeNull();
  expect(() => startAttempt({ ...input, holds }, true)).toThrow(expect.objectContaining({ code: 'CLAIM_REJECTED' }));
});

test.each(['qa', 'rework', 'reverify'] as const)('survivor: failed %s retry does not recheck development predecessors', kind => {
  const input = claim({ status: 'failed', kind, dependenciesMet: false, leaderRequested: false,
    previousAttempt: { ...attempt, kind, status: 'failed' },
  });
  expect(claimIssue(input)).toBeNull();
  expect(startAttempt(input, true)).toBe(kind === 'qa' ? 'qa' : kind === 'reverify' ? 'verifying' : 'running');
});

test('survivor: QA cannot use only evidenceInvalidated as a predecessor', () => {
  expect(claimIssue(claim({ status: 'qa', kind: 'qa', evidenceInvalidated: true, previousAttempt: null }))).not.toBeNull();
});
