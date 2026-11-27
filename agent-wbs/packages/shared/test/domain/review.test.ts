import { expect, test } from 'vitest';
import * as domain from '../../src/domain/index.ts';
import * as consumer from '../../src/index.ts';
import { claimReasons as packageClaimReasons } from '@awbs/shared';
import { approvalSpec, attempt, basis, claim, completion, pass } from './fixtures.ts';

test.each([['qa', 'qa'], ['verifying', 'reverify']] as const)('R1 %s BLOCKED needs leader and current task check, even after invalidation', (status, kind) => {
  const previousAttempt = { ...attempt, kind, verificationResult: 'BLOCKED' as const };
  for (const evidenceInvalidated of [false, true]) {
    for (const [leaderRequested, taskCheckPassed] of [[false, true], [true, false], [false, false]] as const) {
      const input = claim({ status, kind, previousAttempt, evidenceInvalidated, leaderRequested, taskCheckPassed });
      expect(domain.claimIssue(input)).not.toBeNull();
      expect(() => domain.startAttempt(input, true)).toThrow();
    }
    expect(domain.claimIssue(claim({ status, kind, previousAttempt, evidenceInvalidated }))).toBeNull();
  }
});

test('R2 mechanical head sync preserves QA before integration, independent of integration FAIL', () => {
  const changed = { ...basis, headSha: 'synced' };
  const headSync = { qaHeadSha: 'head', headSha: 'synced', preserved: true };
  expect(domain.verificationCurrent(changed, pass, headSync)).toBe(true);
  const event = { type: 'invalidate' as const, basis: changed, verification: pass, headSync };
  expect(domain.lifecycleTransition('gate', event)).toBe('gate');
  expect(domain.lifecycleTransition('gate', { ...event, headSync: { ...headSync, preserved: false } })).toBe('verifying');
  for (const field of ['qaHeadSha', 'headSha'] as const) {
    expect(domain.verificationCurrent(changed, pass, { ...headSync, [field]: 'wrong' })).toBe(false);
  }
  const input = completion();
  if (!input.integration) throw new Error('fixture');
  const beforeIntegration = { ...input, basis: changed, headSync,
    taskCheck: { ...changed, result: 'PASS' }, integration: null,
  } as const;
  expect(domain.completionGate(beforeIntegration)[2]?.result).toBe('PASS');
  const failedIntegration = { ...beforeIntegration, integration: { ...input.integration, result: 'FAIL' } };
  expect(domain.completionGate(failedIntegration)[2]?.result).toBe('PASS');
});

test('R3 failed dev rechecks predecessors, while paused dev follows prototype resume rules', () => {
  const input = claim({ status: 'failed', previousAttempt: { ...attempt, status: 'failed' }, dependenciesMet: false });
  expect(domain.claimIssue(input)).not.toBeNull();
  expect(() => domain.startAttempt(input, true)).toThrow();
  expect(domain.claimIssue(claim({ status: 'paused', previousAttempt: { ...attempt, status: 'interrupted' }, dependenciesMet: false }))).toBeNull();
});

test.each([['qa', 'qa'], ['verifying', 'reverify']] as const)('R4 %s closes stale reports without using the verdict or charging a failure', (status, kind) => {
  for (const field of ['headSha', 'specRevision', 'inputVersion'] as const) {
    const changed = { ...basis, [field]: field === 'headSha' ? 'changed' : 2 };
    for (const result of ['PASS', 'FAIL', 'BLOCKED'] as const) {
      const verification = Object.freeze({ ...pass, result });
      const decision = domain.recordVerification(status, { kind, status: 'running' }, changed, verification);
      expect(decision).toEqual({ taskStatus: status, attemptStatus: 'completed', disposition: 'stale' });
      const previousAttempt = { ...attempt, kind, verificationResult: result, verificationDisposition: 'stale' as const };
      const input = claim({ status, kind, previousAttempt, leaderRequested: false, evidenceInvalidated: true });
      expect(domain.claimIssue(input) === null).toBe(result !== 'BLOCKED');
      expect(domain.claimIssue({ ...input, leaderRequested: true })).toBeNull();
      expect(verification).toEqual({ ...pass, result });
    }
  }
});

test('R5 claim/start return contract codes and all reasons, closed attempts and Gate have distinct errors', () => {
  const input = claim({ hasOpenAttempt: true, dependenciesMet: false, leaderRequested: false });
  expect(domain.claimReasons(input)).toHaveLength(3);
  expect(() => domain.startAttempt(input, true)).toThrow(expect.objectContaining({
    code: 'CLAIM_REJECTED', details: { reasons: domain.claimReasons(input) },
  }));
  expect(() => domain.startAttempt(claim({ cleanupPending: true }), true)).toThrow(expect.objectContaining({ code: 'CLEANUP_PENDING' }));
  expect(() => domain.startAttempt(claim(), false)).toThrow(expect.objectContaining({ code: 'SUBAGENT_INSTALL_FAILED' }));
  expect(() => domain.finishAttempt('running', { ...attempt, status: 'completed' }, 'failed', false)).toThrow(expect.objectContaining({ code: 'ATTEMPT_CLOSED' }));
  expect(() => domain.recordVerification('qa', { kind: 'qa', status: 'completed' }, basis, pass)).toThrow(expect.objectContaining({ code: 'ATTEMPT_CLOSED' }));
  const evidence = completion({ merge: null, planningApprovedAt: null });
  expect(() => domain.lifecycleTransition('gate', { type: 'complete', evidence })).toThrow(expect.objectContaining({
    code: 'GATE_NOT_PASSED', details: expect.objectContaining({
      conditions: domain.completionGate(evidence), reasons: expect.arrayContaining([expect.stringMatching(/승인/), expect.stringMatching(/병합/)]),
    }),
  }));
});

test('R6 counters use ordered attempt history, preserving independent kinds and interruptions', () => {
  const history = [
    { ...attempt, id: 'd1', status: 'failed' as const },
    { ...attempt, id: 'q1', kind: 'qa' as const, status: 'failed' as const },
    { ...attempt, id: 'd2', status: 'interrupted' as const },
    { ...attempt, id: 'd3', status: 'failed' as const },
    { ...attempt, id: 'q2', kind: 'qa' as const, status: 'completed' as const },
    { ...attempt, id: 'q3', kind: 'qa' as const, status: 'failed' as const },
    { ...attempt, id: 'q4', kind: 'qa' as const, status: 'completed' as const, verificationDisposition: 'stale' as const },
  ];
  expect(domain.attemptPolicyCounts(history)).toEqual({
    consecutiveFailures: { dev: 2, qa: 1, rework: 0, reverify: 0 }, automaticReworks: 0,
  });
  const first = history[0];
  if (!first) throw new Error('fixture');
  expect(domain.attemptPolicyCounts([...history, first])).toEqual(domain.attemptPolicyCounts(history));
  const reworks = [
    { ...attempt, id: 'r1', kind: 'rework' as const, status: 'failed' as const, automaticReworkCause: 'qa-fail-1' },
    { ...attempt, id: 'r2', kind: 'rework' as const, status: 'completed' as const, automaticReworkCause: 'qa-fail-1' },
    { ...attempt, id: 'r3', kind: 'rework' as const, status: 'running' as const, automaticReworkCause: 'integration-fail-1' },
    { ...attempt, id: 'manual', kind: 'rework' as const, automaticReworkCause: null },
  ];
  expect(domain.attemptPolicyCounts(reworks).automaticReworks).toBe(2);
  expect(domain.claimIssue(claim({ status: 'failed', previousAttempt: { ...attempt, status: 'failed' }, history: [] }))).not.toBeNull();
});

// M5·M7 통합 조정자 결정(M5-05 리뷰 P3-2): 재작업 중 ① 실패도 자동 재시도 횟수에 센다.
test('재작업 중 ① 실패는 재작업 원인과 자동 재시도 연속 실패를 함께 쓴다', () => {
  const history = [
    { ...attempt, id: 'r1', kind: 'rework' as const, status: 'failed' as const, automaticReworkCause: 'qa-fail-1' }, // ① Task 실패
    { ...attempt, id: 'r2', kind: 'rework' as const, status: 'failed' as const, automaticReworkCause: 'task-check-r1' }, // 프로세스 실패
  ];
  expect(domain.attemptPolicyCounts(history)).toEqual({ consecutiveFailures: { dev: 0, qa: 0, rework: 2, reverify: 0 }, automaticReworks: 2 });
});

test.each(domain.ATTEMPT_KINDS)('R6 %s completion resets only its own failure streak, interruptions leave it unchanged', kind => {
  const other = domain.ATTEMPT_KINDS.find(value => value !== kind);
  if (!other) throw new Error('fixture');
  const history = [
    { ...attempt, id: 'other', kind: other, status: 'failed' as const },
    { ...attempt, id: 'failed', kind, status: 'failed' as const },
    { ...attempt, id: 'interrupted', kind, status: 'interrupted' as const },
    { ...attempt, id: 'running', kind, status: 'running' as const },
  ];
  expect(domain.attemptPolicyCounts(history).consecutiveFailures[kind]).toBe(1);
  const completed = [...history, { ...attempt, id: 'completed', kind, status: 'completed' as const, verificationResult: 'BLOCKED' as const }];
  const counts = domain.attemptPolicyCounts(completed);
  expect(counts.consecutiveFailures[kind]).toBe(0);
  expect(counts.consecutiveFailures[other]).toBe(1);
  expect(counts.automaticReworks).toBe(0);
});

test('R6 own reservation and inherited own lock are distinguished from another job and old host', () => {
  const input = claim();
  const own = { jobId: input.jobId, epoch: input.epoch, hostId: input.hostId,
    slotState: 'reserved' as const, lockState: 'held' as const, lockFromJobId: null, handedToJobId: null };
  expect(domain.claimIssue({ ...input, holds: [own] })).toBeNull();
  expect(domain.startAttempt({ ...input, holds: [own] }, true)).toBe('running');
  const inherited = { ...own, hostId: null, slotState: 'none' as const, lockFromJobId: 'old-job' };
  expect(domain.claimIssue({ ...input, holds: [inherited] })).toBeNull();
  expect(() => domain.startAttempt({ ...input, holds: [inherited] }, true)).toThrow();
  expect(domain.claimIssue({ ...input, holds: [{ ...own, jobId: 'other' }] })).not.toBeNull();
  expect(domain.claimIssue({ ...input, holds: [{ ...own, epoch: input.epoch - 1 }] })).not.toBeNull();
  expect(domain.claimIssue({ ...input, holds: [{ ...own, hostId: 'other-host' }] })).not.toBeNull();
  for (const slotState of ['active', 'unconfirmed'] as const) {
    expect(domain.claimIssue({ ...input, holds: [{ ...own, slotState }] })).not.toBeNull();
    expect(() => domain.startAttempt({ ...input, holds: [{ ...own, slotState }] }, true)).toThrow();
  }
  const old = { ...own, jobId: 'old-job', slotState: 'none' as const, lockState: 'handed_over' as const, handedToJobId: input.jobId };
  expect(domain.claimIssue({ ...input, holds: [old, inherited] })).toBeNull();
  expect(domain.claimIssue({ ...input, jobId: 'old-job', holds: [old, inherited] })).not.toBeNull();
  expect(domain.claimIssue({ ...input, holds: [{ ...old, hostId: 'old-host', slotState: 'unconfirmed', lockState: 'orphaned' }] })).toBeNull();
  expect(domain.claimIssue({ ...input, holds: [{ ...old, slotState: 'unconfirmed', lockState: 'released' }] })).not.toBeNull();
});

test('R7 post-merge completion uses tested merge evidence, not the now-moved main or pipeline', () => {
  const afterMerge = { ...completion(), currentBaseSha: 'merged', currentPipelineSha: 'new-main-pipeline' };
  expect(domain.canComplete(afterMerge)).toBe(true);
});

test('mutation regression: invalidated verification is never current, even without a SHA change', () => {
  const invalidated = { ...pass, invalidated: true };
  expect(domain.verificationCurrent(basis, invalidated)).toBe(false);
  expect(domain.lifecycleTransition('gate', { type: 'invalidate', basis, verification: invalidated })).toBe('verifying');
  expect(domain.recordVerification('qa', { kind: 'qa', status: 'running' }, basis, invalidated).disposition).toBe('stale');
});

test('mutation regression: matching integration and merge at an unrelated head cannot complete current QA', () => {
  const input = completion();
  if (!input.integration || !input.merge) throw new Error('fixture');
  expect(domain.canComplete({ ...input,
    integration: { ...input.integration, headSha: 'unrelated' },
    merge: { ...input.merge, headSha: 'unrelated' },
  })).toBe(false);
});

test('R8 start rechecks every claim guard', () => {
  for (const patch of [{ hasOpenAttempt: true }, { cleanupPending: true }, { dependenciesMet: false },
    { leaderRequested: false }, { status: 'done' as const }]) {
    expect(() => domain.startAttempt(claim(patch), true)).toThrow();
  }
});

test('R8 every lifecycle state x event is checked through the actual event function', () => {
  const cases = [
    { event: { type: 'request-approval' as const, leader: true, spec: approvalSpec }, from: 'planning', to: 'approval' },
    { event: { type: 'approve' as const, leader: true, spec: approvalSpec }, from: 'approval', to: 'ready' },
    { event: { type: 'reject' as const, leader: true }, from: 'approval', to: 'planning' },
    { event: { type: 'invalidate' as const, basis: { ...basis, headSha: 'changed' }, verification: pass }, from: 'gate', to: 'verifying' },
    { event: { type: 'integration-failed' as const }, from: 'gate', to: 'rework' },
    { event: { type: 'complete' as const, evidence: completion() }, from: 'gate', to: 'done' },
  ];
  for (const status of domain.TASK_STATUSES) for (const { event, from, to } of cases) {
    if (status === from) expect(domain.lifecycleTransition(status, event)).toBe(to);
    else expect(() => domain.lifecycleTransition(status, event)).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  }
});

test('R8 claim predecessor completion and verdict guards reject each individual wrong fact', () => {
  for (const [status, kind, predecessor] of [['qa', 'qa', 'dev'], ['verifying', 'reverify', 'rework']] as const) {
    const valid = claim({ status, kind, previousAttempt: { ...attempt, kind: predecessor } });
    expect(domain.claimIssue(valid)).toBeNull();
    for (const terminal of ['running', 'failed', 'interrupted'] as const) {
      expect(domain.claimIssue({ ...valid, previousAttempt: { ...attempt, kind: predecessor, status: terminal } })).not.toBeNull();
    }
    expect(domain.claimIssue({ ...valid, taskCheckPassed: false })).not.toBeNull();
  }
  for (const [status, kind] of [['qa', 'qa'], ['verifying', 'reverify']] as const) {
    for (const result of ['PASS', 'FAIL', null] as const) {
      expect(domain.claimIssue(claim({ status, kind, previousAttempt: { ...attempt, kind, verificationResult: result } }))).not.toBeNull();
    }
  }
  for (const status of ['running', 'completed', 'interrupted'] as const) {
    const history = [{ ...attempt, id: 'failed', status: 'failed' as const }];
    expect(domain.claimIssue(claim({ status: 'failed', previousAttempt: { ...attempt, status }, history }))).not.toBeNull();
  }
  for (const result of ['PASS', 'BLOCKED', null] as const) {
    expect(domain.claimIssue(claim({ status: 'rework', kind: 'rework', previousAttempt: { ...attempt, kind: 'qa', verificationResult: result } }))).not.toBeNull();
  }
});

test('R8 every Task state x verification attempt kind rejects mismatched pairs', () => {
  for (const status of domain.TASK_STATUSES) for (const kind of domain.ATTEMPT_KINDS) {
    for (const result of ['PASS', 'FAIL', 'BLOCKED'] as const) {
      const report = () => domain.recordVerification(status, { kind, status: 'running' }, basis, { ...pass, result });
      if (status === 'qa' && kind === 'qa' || status === 'verifying' && kind === 'reverify') {
        expect(report().taskStatus).toBe(result === 'PASS' ? 'gate' : result === 'FAIL' ? 'rework' : status);
      } else expect(report).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    }
  }
});

test('R8 checklist rounds upward where necessary, and empty evidence preserves previous evidence', () => {
  expect(domain.checklistSummary([{ required: true, done: true }, { required: false, done: true }, { required: true, done: false }]).percent).toBe(67);
  const item = { id: 'CL', required: true, done: false, evidence: 'old', note: '' };
  expect(domain.applyChecklistVerification([item], ['CL'], 'PASS', 'V', [''])[0]?.evidence).toBe('old');
});

test('R9 missing predecessor remains unmet for both relationship types', () => {
  for (const type of ['SS', 'FS'] as const) expect(domain.dependencyMet([], { pred: 'missing', succ: 'B', type })).toBe(false);
});

test('R10 cannot add a cancelled predecessor of either relationship type', () => {
  for (const type of ['SS', 'FS'] as const) {
    expect(() => domain.assertDependency([{ id: 'A', status: 'cancelled' }, { id: 'B', status: 'ready' }], [], { pred: 'A', succ: 'B', type })).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  }
});

test('R11 Gate explains each verification/output cause separately', () => {
  const reason = (patch: Parameters<typeof completion>[0]) => domain.completionGate(completion(patch))[2]?.reason;
  const reasons = [
    reason({ verification: null, verificationState: 'none' }),
    reason({ verification: null, verificationState: 'running' }),
    reason({ verification: { ...pass, result: 'BLOCKED' } }),
    reason({ taskCheck: null }), reason({ taskCheck: { ...basis, result: 'FAIL' } }),
    reason({ verification: { ...pass, invalidated: true } }),
    reason({ verification: { ...pass, headSha: 'stale' } }),
    reason({ verification: { ...pass, specRevision: 2 } }),
    reason({ verification: { ...pass, inputVersion: 2 } }),
    reason({ taskCheck: { ...basis, headSha: 'old', result: 'PASS' } }),
  ];
  expect(new Set(reasons).size).toBe(reasons.length);
  expect(reasons.every(value => typeof value === 'string' && value.length > 0)).toBe(true);
  expect(domain.completionGate(completion({ outputs: [] }))[1]?.reason).toBe('예상 산출물 미정의');
  expect(domain.completionGate(completion({ outputs: [{ name: 'optional', required: false, delivered: false }] }))[1]?.reason).toBe('필수 산출물 미지정');
});

test('R12 integration entry checks predecessors and current main/pipeline; post-merge completion ignores new blockers', () => {
  const entry = { ...completion(), dependenciesMet: true, baseSha: 'base', pipelineSha: 'pipeline', currentBaseSha: 'base', currentPipelineSha: 'pipeline' };
  expect(domain.canIntegrate(entry)).toBe(true);
  for (const patch of [{ dependenciesMet: false }, { currentBaseSha: 'moved' }, { currentPipelineSha: 'changed' }]) {
    expect(domain.canIntegrate({ ...entry, ...patch })).toBe(false);
  }
  const merged = { ...completion(), dependenciesMet: false };
  expect(domain.canComplete(merged)).toBe(true);
});

test('R13 BLOCKED ignores checklist selections before validating IDs, as original registerQa', () => {
  const items = [{ id: 'CL', required: true, done: false, note: '', evidence: '' }];
  expect(domain.applyChecklistVerification(items, ['missing'], 'BLOCKED', 'V', [])).toBe(items);
});

test('R14 shared root barrel exposes the actual domain functions to consumers', () => {
  expect(consumer.claimIssue).toBe(domain.claimIssue);
  expect(consumer.assertDependency).toBe(domain.assertDependency);
  expect(consumer.canComplete).toBe(domain.canComplete);
  expect(packageClaimReasons).toBe(domain.claimReasons);
});

test('latest D-29 permits only a completed reassessment of a now-disallowed resume model', () => {
  const input = claim({ status: 'paused', previousAttempt: { ...attempt, status: 'interrupted' }, modelId: 'new-model' });
  expect(domain.claimIssue({ ...input, resumeGrade: {
    previousModelAllowed: false, reassessed: true, modelId: 'new-model', effort: 'high', reason: '모델 허용 해제',
  } })).toBeNull();
  for (const patch of [{ previousModelAllowed: true }, { reassessed: false }, { reason: '' }, { modelId: 'wrong' }, { effort: 'low' }]) {
    expect(domain.claimIssue({ ...input, resumeGrade: {
      previousModelAllowed: false, reassessed: true, modelId: 'new-model', effort: 'high', reason: '모델 허용 해제', ...patch,
    } })).not.toBeNull();
  }
});
