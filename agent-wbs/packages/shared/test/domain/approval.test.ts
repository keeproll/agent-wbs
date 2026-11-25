import { expect, test } from 'vitest';
import * as domain from '../../src/domain/index.ts';

const completeSpec = {
  purpose: '작업 목적', doneCond: '완료 조건', ac: [{}], checklist: [{}],
  outputs: [{ required: true }], assignee: 'Claude', verifier: 'Codex',
} as const;

test('a24e692 request and approve share the same minimal specification predicate', () => {
  expect(domain.approvalReasons(completeSpec)).toEqual([]);
  expect(domain.lifecycleTransition('planning', { type: 'request-approval', leader: true, spec: completeSpec })).toBe('approval');
  expect(domain.lifecycleTransition('approval', { type: 'approve', leader: true, spec: completeSpec })).toBe('ready');
});

test('each missing approval field blocks request and approval, including changes while waiting', () => {
  for (const patch of [
    { purpose: '  ' }, { doneCond: '\n' }, { ac: [] }, { checklist: [] }, { outputs: [] },
    { outputs: [{ required: false }] }, { assignee: null }, { verifier: null },
  ]) {
    const spec = { ...completeSpec, ...patch };
    expect(domain.approvalReasons(spec)).toHaveLength(1);
    for (const [status, type] of [['planning', 'request-approval'], ['approval', 'approve']] as const) {
      expect(() => domain.lifecycleTransition(status, { type, leader: true, spec })).toThrow(expect.objectContaining({
        code: 'VALIDATION_FAILED', details: { reasons: domain.approvalReasons(spec) },
      }));
    }
  }
});

test('approval is explicit leader action; rejection never validates specification', () => {
  expect(() => domain.lifecycleTransition('planning', { type: 'request-approval', leader: false, spec: completeSpec })).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  expect(() => domain.lifecycleTransition('approval', { type: 'approve', leader: false, spec: completeSpec })).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  const reject = { type: 'reject' as const, leader: true, spec: null };
  expect(domain.lifecycleTransition('approval', reject)).toBe('planning');
  expect(domain.approvalReasons({ purpose: '', doneCond: '', ac: [], checklist: [], outputs: [], assignee: null, verifier: null })).toHaveLength(7);
});
