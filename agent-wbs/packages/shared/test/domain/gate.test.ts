import { expect, test } from 'vitest';
import { canComplete, completionGate, verificationCurrent } from '../../src/domain/index.ts';
import type { CompletionInput } from '../../src/domain/index.ts';
import { basis, completion, pass } from './fixtures.ts';

test('Gate has exactly five independent conditions with reasons; only planning approval is required', () => {
  const gate = completionGate(completion());
  expect(gate.map(condition => condition.key)).toEqual(['checklist', 'outputs', 'verification', 'defects', 'approval']);
  expect(gate.every(condition => condition.result === 'PASS' && condition.reason.length > 0)).toBe(true);
  expect(canComplete(completion())).toBe(true);
});

test.each<Partial<CompletionInput>>([
  { checklist: [] }, { checklist: [{ required: true, done: false }] },
  { outputs: [] }, { outputs: [{ name: 'optional', required: false, delivered: true }] },
  { outputs: [{ name: 'missing', required: true, delivered: false }] },
  { verification: null }, { verification: { ...pass, result: 'FAIL' } },
  { verification: { ...pass, result: 'BLOCKED' } }, { verification: { ...pass, invalidated: true } },
  { taskCheck: null }, { taskCheck: { ...basis, result: 'FAIL' } },
  { taskCheck: { ...basis, headSha: 'stale', result: 'PASS' } },
  { taskCheck: { ...basis, specRevision: 2, result: 'PASS' } },
  { taskCheck: { ...basis, inputVersion: 2, result: 'PASS' } },
  { unresolvedBlockingDefects: 1 }, { planningApprovedAt: null },
])('incomplete Gate facts refuse completion: %j', patch => {
  const input = completion(patch);
  expect(canComplete(input)).toBe(false);
  expect(completionGate(input).some(condition => condition.result !== 'PASS')).toBe(true);
});

test('optional checklist and optional output need not be completed', () => {
  expect(canComplete(completion({
    checklist: [{ required: false, done: false }], outputs: [
      { name: 'required', required: true, delivered: true },
      { name: 'optional', required: false, delivered: false },
    ],
  }))).toBe(true);
});

test('latest verification FAIL is FAIL; missing, BLOCKED or invalidated evidence is BLOCKED', () => {
  for (const result of ['PASS', 'FAIL', 'BLOCKED'] as const) {
    const input = completion({ verification: { ...pass, result } });
    expect(completionGate(input).find(condition => condition.key === 'verification')?.result).toBe(result);
  }
  expect(completionGate(completion({ verification: null }))[2]?.result).toBe('BLOCKED');
  expect(completionGate(completion({ verification: { ...pass, invalidated: true } }))[2]?.result).toBe('BLOCKED');
});

test.each(['headSha', 'specRevision', 'inputVersion'] as const)('old PASS at changed %s is not current', field => {
  const changed = { ...basis, [field]: field === 'headSha' ? 'changed' : 2 };
  expect(verificationCurrent(changed, pass)).toBe(false);
  expect(canComplete(completion({ basis: changed }))).toBe(false);
});

test('Gate five PASS alone never completes without matching integration and actual merge', () => {
  for (const patch of [
    { integration: null }, { merge: null }, { currentBaseSha: 'moved' }, { currentPipelineSha: 'changed' },
  ]) expect(canComplete(completion(patch))).toBe(false);
  const input = completion();
  const integration = input.integration;
  const merge = input.merge;
  if (!integration || !merge) throw new Error('fixture missing integration/merge');
  for (const field of ['qaHeadSha', 'headSha', 'baseSha', 'pipelineSha'] as const) {
    expect(canComplete(completion({ integration: { ...integration, [field]: 'wrong' } }))).toBe(false);
  }
  expect(canComplete(completion({ integration: { ...integration, result: 'FAIL' } }))).toBe(false);
  for (const field of ['headSha', 'baseSha', 'treeSha'] as const) {
    expect(canComplete(completion({ merge: { ...merge, [field]: 'wrong' } }))).toBe(false);
  }
  expect(canComplete(completion({ merge: { ...merge, mergeSha: '' } }))).toBe(false);
});

test('only a mechanically verified clean H -> H\' synchronization carries QA to the integrated head', () => {
  const input = completion();
  if (!input.integration || !input.merge) throw new Error('fixture missing integration/merge');
  const synced = completion({ ...input,
    basis: { ...basis, headSha: 'synced' },
    taskCheck: { ...basis, headSha: 'synced', result: 'PASS' },
    integration: { ...input.integration, headSha: 'synced', qaBasisPreserved: true },
    merge: { ...input.merge, headSha: 'synced' },
  });
  expect(canComplete(synced)).toBe(true);
  expect(verificationCurrent(synced.basis, pass, synced.integration)).toBe(true);
  expect(canComplete({ ...synced, integration: { ...input.integration, headSha: 'synced', qaBasisPreserved: false } })).toBe(false);
  expect(canComplete({ ...synced, verification: { ...pass, specRevision: 2 } })).toBe(false);
  expect(canComplete({ ...synced, verification: { ...pass, inputVersion: 2 } })).toBe(false);
});
