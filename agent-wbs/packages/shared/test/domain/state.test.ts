import { describe, expect, test } from 'vitest';
import {
  ATTEMPT_KINDS, TASK_STATUSES, claimIssue, finishAttempt, initialTaskStatus, lifecycleTransition,
  recordVerification, startAttempt, transitionPairAllowed,
} from '../../src/domain/index.ts';
import type { AttemptKind, TaskStatus } from '../../src/domain/index.ts';
import { approvalSpec, attempt, basis, claim, completion, failedHistory, pass, reworkHistory } from './fixtures.ts';

// Independently transcribed from owner Q-05 / data-model §3.1 (b258334).
const transitions: Record<TaskStatus, TaskStatus[]> = {
  planning: ['approval', 'cancelled'], approval: ['ready', 'planning', 'cancelled'],
  ready: ['running', 'cancelled'], running: ['qa', 'verifying', 'failed', 'paused'],
  failed: ['running', 'qa', 'verifying'], paused: ['running', 'qa', 'verifying'],
  qa: ['gate', 'rework', 'paused', 'failed', 'qa'],
  verifying: ['gate', 'rework', 'paused', 'failed', 'verifying'], rework: ['running'],
  gate: ['verifying', 'done', 'rework'], done: [], cancelled: [],
};

describe('owner Q-05: every transition pair', () => {
  for (const from of [null, ...TASK_STATUSES]) {
    for (const to of TASK_STATUSES) {
      test(`${from ?? 'none'} -> ${to}`, () => {
        const expected = from === null ? ['planning', 'ready'].includes(to) : transitions[from].includes(to);
        expect(transitionPairAllowed(from, to)).toBe(expected);
      });
    }
  }
});

const allowed: Record<TaskStatus, readonly AttemptKind[]> = {
  planning: [], approval: [], ready: ['dev'], running: [],
  qa: ['qa'], verifying: ['reverify'], rework: ['rework'], gate: [],
  failed: ['dev', 'qa', 'rework', 'reverify'], paused: ['dev', 'qa', 'rework', 'reverify'],
  done: [], cancelled: [],
};

describe('owner Q-05: state x attempt-kind claim table', () => {
  for (const status of TASK_STATUSES) {
    for (const kind of ATTEMPT_KINDS) {
      test(`${status} x ${kind}`, () => {
        const previous = status === 'failed' || status === 'paused' ? {
          ...attempt, kind, status: status === 'failed' ? 'failed' as const : 'interrupted' as const,
        } : { ...attempt, verificationResult: 'FAIL' as const };
        const input = claim({ status, kind, previousAttempt: previous,
          evidenceInvalidated: true, integrationFailed: true });
        expect(claimIssue(input) === null).toBe(allowed[status].includes(kind));
      });
    }
  }
});

test('creation, approval and rejection enforce actor and specification facts', () => {
  expect(initialTaskStatus('manual')).toBe('planning');
  expect(initialTaskStatus('cp')).toBe('planning');
  expect(initialTaskStatus('initial-wbs-approval')).toBe('ready');
  expect(lifecycleTransition('planning', { type: 'request-approval', leader: true, spec: approvalSpec })).toBe('approval');
  expect(() => lifecycleTransition('planning', { type: 'request-approval', leader: true, spec: { ...approvalSpec, purpose: '' } })).toThrow();
  expect(lifecycleTransition('approval', { type: 'approve', leader: true, spec: approvalSpec })).toBe('ready');
  expect(lifecycleTransition('approval', { type: 'reject', leader: true })).toBe('planning');
  expect(() => lifecycleTransition('approval', { type: 'approve', leader: false, spec: approvalSpec })).toThrow();
  expect(() => lifecycleTransition('approval', { type: 'reject', leader: false })).toThrow();
});

test.each(['hasOpenAttempt', 'cleanupPending'] as const)('claim rejects %s', field => {
  expect(claimIssue(claim({ [field]: true }))).not.toBeNull();
});

test('first dev requires leader start and predecessors; claim and install failure leave Task untouched', () => {
  for (const patch of [{ leaderRequested: false }, { dependenciesMet: false }]) {
    expect(claimIssue(claim(patch))).not.toBeNull();
  }
  const input = Object.freeze(claim());
  expect(claimIssue(input)).toBeNull();
  expect(input.status).toBe('ready');
  expect(() => startAttempt(input, false)).toThrow();
  expect(input.status).toBe('ready');
  expect(startAttempt(input, true)).toBe('running');
});

test.each(ATTEMPT_KINDS)('%s process failure retries only the same kind (two automatic retries)', kind => {
  const taskStatus = kind === 'qa' ? 'qa' : kind === 'reverify' ? 'verifying' : 'running';
  const previous = { ...attempt, kind, status: 'running' as const };
  expect(finishAttempt(taskStatus, previous, 'failed', false)).toEqual({
    taskStatus: 'failed', attemptStatus: 'failed',
  });
  const input = claim({ status: 'failed', kind, previousAttempt: { ...previous, status: 'failed' }, leaderRequested: false });
  for (const consecutiveFailures of [1, 2]) {
    expect(startAttempt({ ...input, history: failedHistory(kind, consecutiveFailures) }, true)).toBe(taskStatus);
  }
  expect(claimIssue({ ...input, history: failedHistory(kind, 3) })).not.toBeNull();
  expect(startAttempt({ ...input, history: failedHistory(kind, 3), leaderRequested: true }, true)).toBe(taskStatus);
  for (const other of ATTEMPT_KINDS.filter(other => other !== kind)) {
    expect(claimIssue({ ...input, kind: other })).not.toBeNull();
  }
});

test.each(ATTEMPT_KINDS)('%s pause needs a new same-grade attempt and leader resume', kind => {
  const taskStatus = kind === 'qa' ? 'qa' : kind === 'reverify' ? 'verifying' : 'running';
  const previous = { ...attempt, kind, status: 'running' as const };
  expect(finishAttempt(taskStatus, previous, 'interrupted', false)).toEqual({
    taskStatus: 'paused', attemptStatus: 'interrupted',
  });
  const input = claim({ status: 'paused', kind, previousAttempt: { ...previous, status: 'interrupted' } });
  expect(startAttempt(input, true)).toBe(taskStatus);
  for (const patch of [{ leaderRequested: false }, { modelId: 'different' }, { effort: 'low' },
    { previousAttempt: { ...previous, status: 'failed' as const } }]) {
    expect(claimIssue({ ...input, ...patch })).not.toBeNull();
  }
  for (const other of ATTEMPT_KINDS.filter(other => other !== kind)) {
    expect(claimIssue({ ...input, kind: other })).not.toBeNull();
  }
});

test('dev/rework completion stays running until task check passes', () => {
  for (const kind of ['dev', 'rework'] as const) {
    const open = { kind, status: 'running' as const };
    expect(() => finishAttempt('running', open, 'completed', false)).toThrow();
    expect(finishAttempt('running', open, 'completed', true)).toEqual({
      taskStatus: kind === 'dev' ? 'qa' : 'verifying', attemptStatus: 'completed',
    });
  }
  expect(() => finishAttempt('running', attempt, 'failed', true)).toThrow();
  expect(() => finishAttempt('qa', { kind: 'dev', status: 'running' }, 'failed', true)).toThrow();
  expect(() => finishAttempt('qa', { kind: 'qa', status: 'running' }, 'completed', true)).toThrow();
});

test('every terminal attempt status rejects further results for all four kinds', () => {
  for (const kind of ATTEMPT_KINDS) {
    const taskStatus = kind === 'qa' ? 'qa' : kind === 'reverify' ? 'verifying' : 'running';
    for (const status of ['completed', 'failed', 'interrupted'] as const) {
      for (const result of ['completed', 'failed', 'interrupted'] as const) {
        expect(() => finishAttempt(taskStatus, { kind, status }, result, true)).toThrow();
      }
      expect(() => recordVerification(taskStatus, { kind, status }, basis, pass)).toThrow();
    }
  }
});

test.each([['qa', 'qa'], ['verifying', 'reverify']] as const)('%s BLOCKED -> fresh attempt -> PASS', (status, kind) => {
  const blocked = Object.freeze({ ...pass, result: 'BLOCKED' as const });
  const open = { kind, status: 'running' as const };
  expect(recordVerification(status, open, basis, blocked)).toEqual({ taskStatus: status, attemptStatus: 'completed', disposition: 'current' });
  const input = claim({ status, kind, previousAttempt: {
    ...attempt, kind, status: 'completed', verificationResult: 'BLOCKED',
  } });
  expect(startAttempt(input, true)).toBe(status);
  expect(recordVerification(status, open, basis, pass)).toEqual({ taskStatus: 'gate', attemptStatus: 'completed', disposition: 'current' });
  expect(blocked.result).toBe('BLOCKED');
  expect(recordVerification(status, open, basis, { ...pass, result: 'FAIL' }).taskStatus).toBe('rework');
  expect(() => recordVerification(status, { ...open, status: 'completed' }, basis, pass)).toThrow();
  expect(recordVerification(status, open, { ...basis, headSha: 'changed' }, pass).disposition).toBe('stale');
});

test('QA and reverify claim conditions do not accept unrelated completed attempts', () => {
  expect(claimIssue(claim({ status: 'qa', kind: 'qa', previousAttempt: attempt }))).toBeNull();
  expect(claimIssue(claim({ status: 'qa', kind: 'qa', previousAttempt: attempt, taskCheckPassed: false }))).not.toBeNull();
  expect(claimIssue(claim({ status: 'qa', kind: 'qa', previousAttempt: null }))).not.toBeNull();
  expect(claimIssue(claim({ status: 'qa', kind: 'qa', previousAttempt: { ...attempt, kind: 'qa', verificationResult: 'PASS' } }))).not.toBeNull();
  expect(claimIssue(claim({ status: 'verifying', kind: 'reverify', previousAttempt: { ...attempt, kind: 'rework' } }))).toBeNull();
  expect(claimIssue(claim({ status: 'verifying', kind: 'reverify', previousAttempt: attempt }))).not.toBeNull();
  expect(claimIssue(claim({ status: 'verifying', kind: 'reverify', evidenceInvalidated: true }))).toBeNull();
});

test('automatic rework boundary is three; a leader button allows one additional run', () => {
  const input = claim({ status: 'rework', kind: 'rework', leaderRequested: false, previousAttempt: {
    ...attempt, kind: 'qa', verificationResult: 'FAIL',
  } });
  for (const count of [0, 1, 2]) expect(claimIssue({ ...input, history: reworkHistory(count) })).toBeNull();
  expect(claimIssue({ ...input, history: reworkHistory(3) })).not.toBeNull();
  expect(claimIssue({ ...input, history: reworkHistory(3), leaderRequested: true })).toBeNull();
  expect(claimIssue({ ...input, previousAttempt: null })).not.toBeNull();
  expect(claimIssue({ ...input, previousAttempt: null, integrationFailed: true })).toBeNull();
  expect(claimIssue({ ...input, previousAttempt: { ...attempt, verificationResult: 'FAIL' } })).not.toBeNull();
  expect(claimIssue({ ...input, previousAttempt: { ...attempt, kind: 'qa', status: 'failed', verificationResult: 'FAIL' } })).not.toBeNull();
});

test.each(['headSha', 'specRevision', 'inputVersion'] as const)('%s change invalidates Gate and requires reverify', field => {
  const changed = { ...basis, [field]: field === 'headSha' ? 'changed' : 2 };
  expect(lifecycleTransition('gate', { type: 'invalidate', basis: changed, verification: pass })).toBe('verifying');
  expect(recordVerification('verifying', { kind: 'reverify', status: 'running' }, changed, pass).disposition).toBe('stale');
  const fresh = { ...pass, ...changed };
  expect(recordVerification('verifying', { kind: 'reverify', status: 'running' }, changed, fresh).taskStatus).toBe('gate');
  expect(lifecycleTransition('gate', { type: 'invalidate', basis, verification: pass })).toBe('gate');
});

test('Gate completes only with five conditions, integration and matching merge', () => {
  expect(lifecycleTransition('gate', { type: 'complete', evidence: completion() })).toBe('done');
  expect(() => lifecycleTransition('gate', { type: 'complete', evidence: completion({ merge: null }) })).toThrow();
  expect(lifecycleTransition('gate', { type: 'integration-failed' })).toBe('rework');
  for (const status of ['done', 'cancelled', 'ready'] as const) {
    expect(() => lifecycleTransition(status, { type: 'complete', evidence: completion() })).toThrow();
    expect(() => recordVerification(status, { kind: 'qa', status: 'running' }, basis, pass)).toThrow();
  }
});
