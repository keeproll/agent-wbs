// M5-01 재리뷰 5(Codex, 8696b3a) 회귀 시험 — 리뷰어 작성본 그대로
import { expect, test } from 'vitest';
import { createCodexParser } from '../../src/cli/codex.ts';
import { SubagentObserver } from '../../src/cli/observe.ts';
test('a wait state with no status must not mint current-launch start proof', () => {
  const p = createCodexParser(), o = new SubagentObserver();
  const report = (tool: string, state: Record<string, unknown>) => ({ type: 'item.completed', item: { id: `i-${tool}`, type: 'collab_tool_call', tool, sender_thread_id: 'parent', receiver_thread_ids: ['th-a'], agents_states: { 'th-a': state }, status: 'completed' } });
  for (const e of p(report('spawn_agent', { status: 'running' }))) o.apply(e);
  o.launch();
  for (const e of p(report('wait', {}))) o.apply(e);
  for (const e of p(report('wait', { status: 'completed' }))) o.apply(e);
  o.apply({ type: 'result', ok: true, reason: 'completed' });
  o.finish();
  expect(o.snapshot()).toMatchObject({ observed: 1, state: 'unconfirmed' });
});
