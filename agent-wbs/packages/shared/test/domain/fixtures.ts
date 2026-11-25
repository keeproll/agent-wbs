import type { Attempt, ClaimInput, CompletionInput, Verification } from '../../src/domain/index.ts';

// Synthetic execution evidence; policy values are checked against the owner tables in state.test.ts.
export const basis = { headSha: 'head', specRevision: 1, inputVersion: 1 };
export const pass: Verification = { ...basis, result: 'PASS', invalidated: false };
export const attempt: Attempt = {
  kind: 'dev', status: 'completed', modelId: 'model', effort: 'high', verificationResult: null,
};

export function claim(patch: Partial<ClaimInput> = {}): ClaimInput {
  return {
    status: 'ready', kind: 'dev', previousAttempt: null, hasOpenAttempt: false,
    hasOtherJobHold: false, cleanupPending: false, dependenciesMet: true, leaderRequested: true,
    taskCheckPassed: true, integrationFailed: false, evidenceInvalidated: false,
    consecutiveFailures: 1, automaticReworks: 0, modelId: 'model', effort: 'high', ...patch,
  };
}

export function completion(patch: Partial<CompletionInput> = {}): CompletionInput {
  return {
    checklist: [{ required: true, done: true }],
    outputs: [{ name: 'artifact', required: true, delivered: true }],
    basis, verification: pass, taskCheck: { ...basis, result: 'PASS' }, unresolvedBlockingDefects: 0,
    planningApprovedAt: '2026-11-25T00:00:00Z', currentBaseSha: 'base', currentPipelineSha: 'pipeline',
    integration: { result: 'PASS', qaHeadSha: 'head', headSha: 'head', baseSha: 'base',
      pipelineSha: 'pipeline', treeSha: 'tree', qaBasisPreserved: false },
    merge: { mergeSha: 'merged', headSha: 'head', baseSha: 'base', treeSha: 'tree' }, ...patch,
  };
}
