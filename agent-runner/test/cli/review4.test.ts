// M5-01 재리뷰 4(Codex, d62d32c) 회귀 시험 — 리뷰어 작성본 그대로
import { expect, test } from 'vitest';
import { createCodexParser } from '../../src/cli/codex.ts';
import { SubagentObserver } from '../../src/cli/observe.ts';
test('an unknown Codex state must not prove a new launch start and enable stale completion', () => {
  const p = createCodexParser(), o = new SubagentObserver();
  const report = (tool: string, status: string) => ({ type: 'item.completed', item: { id: `${tool}-${status}`, type: 'collab_tool_call', tool, sender_thread_id: 'parent', receiver_thread_ids: ['th-a'], agents_states: { 'th-a': { status, message: null } }, status: 'completed' } });
  for (const e of p(report('spawn_agent', 'running'))) o.apply(e);
  o.launch();
  for (const e of p(report('wait', 'not_found'))) o.apply(e);
  for (const e of p(report('wait', 'completed'))) o.apply(e);
  o.apply({ type: 'result', ok: true, reason: 'completed' });
  o.finish();
  expect(o.snapshot()).toMatchObject({ observed: 1, state: 'unconfirmed' });
});
