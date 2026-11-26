// M5-01 재리뷰 2(Codex, 82849cf) 회귀 시험 — 리뷰어 작성본 그대로
import { expect, test } from 'vitest';
import { createClaudeParser } from '../../src/cli/claude.ts';
import { SubagentObserver } from '../../src/cli/observe.ts';
const call = (id: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id, input: {} }] } });
const start = (tool: string, run: string | undefined, bg = true) => ({ type: 'system', subtype: 'task_started', task_id: 'task-A', task_type: 'local_agent', tool_use_id: tool, ...(run === undefined ? {} : { run_id: run }), is_backgrounded: bg });
const done = (tool: string, run: string) => ({ type: 'system', subtype: 'task_notification', task_id: 'task-A', tool_use_id: tool, run_id: run, status: 'completed' });
const returned = (tool: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tool, content: 'ok' }] } });
const ok = { type: 'result', subtype: 'success', is_error: false };
function observe(lines: object[]) {
  const p = createClaudeParser(), o = new SubagentObserver();
  for (const line of lines) for (const e of p(line as Record<string, unknown>)) o.apply(e);
  o.finish();
  return o.snapshot();
}
test('a start without run_id on a versioned task must be unconfirmed', () => {
  expect(observe([call('tool-A'), start('tool-A', '002'), start('tool-A', undefined, false), ok]))
    .toMatchObject({ observed: 1, state: 'unconfirmed' });
});
test('an unseen late older start must not replace the current newer run', () => {
  // 재리뷰 2 결정 B로 state 기대만 'ok' → 'unconfirmed'로 바꿈: 같은 tool-A에 run 001이 또 오면 001이 더 오래됐는지
  // run_id 순서로 추측하지 않는다. 현재 run을 증명할 수 없으므로 미확인. observed 1 유지 기대는 그대로다.
  expect(observe([call('tool-A'), start('tool-A', '002'), start('tool-A', '001'), done('tool-A', '001'), ok]))
    .toMatchObject({ observed: 1, state: 'unconfirmed' });
});
test('an old call result must not clear the foreground run after merging a new call', () => {
  expect(observe([call('tool-A'), start('tool-A', '001'), call('tool-B'), start('tool-B', '002', false), returned('tool-A'), ok]))
    .toMatchObject({ observed: 1, state: 'ok' });
});

// ── fix3 보강(변이 확인에서 살아남은 경로) ──
const startFg = (tool: string, run: string) => start(tool, run, false);
test('run_id를 쓰는 task에 새 호출로 run_id 없는 시작이 오면 현재로 바꾸지 않고 미확인', () => {
  expect(observe([call('tool-A'), start('tool-A', '001'), call('tool-B'), start('tool-B', undefined), ok]))
    .toMatchObject({ observed: 2, state: 'unconfirmed' });
});
test('현재 run이 모호해진 task의 도구 결과는 수를 줄이지 않는다', () => {
  expect(observe([call('tool-A'), startFg('tool-A', '001'), startFg('tool-A', '002'), returned('tool-A'), ok]))
    .toMatchObject({ observed: 1, state: 'unconfirmed' });
});
test('launch 기록: Runner가 프로세스를 다시 시작하면 이전 launch의 하위 Agent는 수를 유지한 채 미확인', () => {
  const p = createClaudeParser();
  const o = new SubagentObserver();
  for (const line of [call('tool-A'), start('tool-A', '001')]) for (const e of p(line)) o.apply(e);
  o.launch();
  for (const e of p(ok)) o.apply(e);
  o.finish();
  expect(o.snapshot()).toMatchObject({ observed: 1, state: 'unconfirmed' });
});
test('launch 기록: 이전 launch의 도구 호출에는 새 launch의 시작을 묶지 않는다', () => {
  const p = createClaudeParser();
  const o = new SubagentObserver();
  for (const e of p(call('tool-A'))) o.apply(e);
  for (const e of p(returned('tool-A'))) o.apply(e);
  o.launch();
  expect(o.snapshot().state).toBe('ok');
  for (const line of [{ ...start('tool-A', '001'), task_id: 'task-B' }, ok]) for (const e of p(line)) o.apply(e);
  o.finish();
  expect(o.snapshot()).toMatchObject({ observed: 0, state: 'unconfirmed' });
});
