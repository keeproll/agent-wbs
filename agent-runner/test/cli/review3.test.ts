// M5-01 재리뷰 3(Codex, 62ff696) 회귀 시험 — 리뷰어 작성본 그대로
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { createClaudeParser } from '../../src/cli/claude.ts';
import { SubagentObserver } from '../../src/cli/observe.ts';
const call = (id: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id, input: { run_in_background: true } }] } });
const start = (id: string | undefined) => ({ type: 'system', subtype: 'task_started', task_id: 'task-A', task_type: 'local_agent', ...(id ? { tool_use_id: id } : {}), run_id: 'r1', is_backgrounded: true });
const done = (id: string) => ({ type: 'system', subtype: 'task_notification', task_id: 'task-A', tool_use_id: id, run_id: 'r1', status: 'completed' });
const returned = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Agent launched in background' }] } });
const ok = { type: 'result', subtype: 'success', is_error: false };
function add(o: SubagentObserver, lines: object[]) {
  const p = createClaudeParser();
  for (const line of lines) for (const e of p(line as Record<string, unknown>)) o.apply(e);
}
test('a background tool result must not clear a call whose task start was unlinked', () => {
  const o = new SubagentObserver();
  add(o, [call('a'), start(undefined), returned('a'), ok]);
  o.finish();
  expect(o.snapshot()).toMatchObject({ observed: 1, state: 'unconfirmed' });
});
test('a new launch must not apply the prior launch task completion', () => {
  const o = new SubagentObserver();
  add(o, [call('a'), start('a')]);
  o.launch();
  add(o, [done('a'), ok]);
  o.finish();
  expect(o.snapshot()).toMatchObject({ observed: 1, state: 'unconfirmed' });
});
test('a prior launch result must not mask a missing result in the next launch', () => {
  const o = new SubagentObserver();
  add(o, [ok]);
  o.launch();
  o.finish();
  expect(o.snapshot()).toMatchObject({ state: 'unconfirmed', ended: false });
});
test('property: dropping a background start while retaining its tool result must not yield a normal zero', () => {
  fc.assert(fc.property(fc.uuid(), fc.boolean(), (id, dropStart) => {
    const o = new SubagentObserver();
    add(o, [call(id), ...(dropStart ? [] : [start(id)]), returned(id), ok]);
    o.finish();
    const s = o.snapshot();
    // This task is still running: only its launch acknowledgement was emitted, never completion.
    if (s.state === 'ok') expect(s.observed).toBeGreaterThanOrEqual(1);
  }), { seed: 20261127, numRuns: 100 });
});
