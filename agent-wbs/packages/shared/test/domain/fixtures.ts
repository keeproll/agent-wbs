import type { ApprovalInput, Attempt, AttemptHistory, ClaimInput, CompletionInput, Verification } from '../../src/domain/index.ts';

// Synthetic execution evidence; policy values are checked against the owner tables in state.test.ts.
export const basis = { headSha: 'head', specRevision: 1, inputVersion: 1 };
export const pass: Verification = { ...basis, result: 'PASS', invalidated: false };
export const attempt: Attempt = {
  kind: 'dev', status: 'completed', modelId: 'model', effort: 'high', verificationResult: null,
};

export const approvalSpec: ApprovalInput = {
  purpose: '작업 목적', doneCond: '완료 조건', ac: [{}], checklist: [{}],
  outputs: [{ required: true }], assignee: 'Claude', verifier: 'Codex',
};

export function claim(patch: Partial<ClaimInput> = {}): ClaimInput {
  return {
    status: 'ready', kind: 'dev', previousAttempt: null, hasOpenAttempt: false,
    jobId: 'job', epoch: 1, hostId: 'host', holds: [{ jobId: 'job', epoch: 1, hostId: 'host',
      slotState: 'reserved', lockState: 'held', lockFromJobId: null, handedToJobId: null }],
    cleanupPending: false, dependenciesMet: true, leaderRequested: true,
    taskCheckPassed: true, integrationFailed: false, evidenceInvalidated: false,
    history: patch.previousAttempt ? [{ ...patch.previousAttempt, id: 'previous' }] : [],
    modelId: 'model', effort: 'high', ...patch,
  };
}

export function completion(patch: Partial<CompletionInput> = {}): CompletionInput {
  return {
    checklist: [{ required: true, done: true }],
    outputs: [{ name: 'artifact', required: true, delivered: true }],
    basis, verification: pass, taskCheck: { ...basis, result: 'PASS' }, unresolvedBlockingDefects: 0,
    planningApprovedAt: '2026-11-25T00:00:00Z', headSync: null,
    integration: { result: 'PASS', qaHeadSha: 'head', headSha: 'head', baseSha: 'base',
      pipelineSha: 'pipeline', treeSha: 'tree' },
    merge: { mergeSha: 'merged', headSha: 'head', baseSha: 'base', treeSha: 'tree' }, ...patch,
  };
}

export function failedHistory(kind: Attempt['kind'], count: number): AttemptHistory[] {
  return Array.from({ length: count }, (_, i) => ({ ...attempt, kind, id: `failed-${i}`, status: 'failed' }));
}

export function reworkHistory(count: number): AttemptHistory[] {
  return Array.from({ length: count }, (_, i) => ({ ...attempt, kind: 'rework', id: `rework-${i}`, automaticReworkCause: `cause-${i}` }));
}
