// M5-01 재리뷰(Codex, edb8867) 회귀 시험 — 리뷰어 작성본 그대로
import { expect, test } from 'vitest';
import { createClaudeParser } from '../../src/cli/claude.ts';
import { SubagentObserver } from '../../src/cli/observe.ts';
const call = (id: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id, input: {} }] } });
const start = (tool: string, run: string) => ({ type: 'system', subtype: 'task_started', task_id: 'task-A', task_type: 'local_agent', tool_use_id: tool, run_id: run, is_backgrounded: true });
const done = (tool: string, run: string) => ({ type: 'system', subtype: 'task_notification', task_id: 'task-A', tool_use_id: tool, run_id: run, status: 'completed' });
const ok = { type: 'result', subtype: 'success', is_error: false };
function observe(lines: object[]) {
  const p = createClaudeParser(), o = new SubagentObserver();
  for (const line of lines) for (const e of p(line as Record<string, unknown>)) o.apply(e);
  o.finish();
  return o.snapshot();
}
test('a late task_updated from run 001 must not clear active run 002', () => {
  expect(observe([
    call('tool-A'), start('tool-A', '001'), start('tool-A', '002'),
    { type: 'system', subtype: 'task_updated', task_id: 'task-A', run_id: '001', patch: { status: 'completed' } }, ok,
  // 재리뷰 2 결정 B로 state 기대만 'ok' → 'unconfirmed'로 바꿈: 같은 tool-A에 run 002가 또 오면 어느 run이 현재인지
  // 증명할 수 없다(run_id 순서로 추측하지 않음). observed 1 유지 기대는 그대로다.
  ])).toMatchObject({ observed: 1, state: 'unconfirmed' });
});
test('a resumed task with a new tool call must leave no phantom agent after completion', () => {
  expect(observe([
    call('tool-A'), start('tool-A', '001'), done('tool-A', '001'),
    call('tool-B'), start('tool-B', '002'), done('tool-B', '002'), ok,
  ])).toMatchObject({ observed: 0, peak: 1, state: 'ok' });
});

// 같은 부류: 지나간 run의 메시지가 현재 run을 덮는 경우, 재개 때 같은 Agent가 둘로 남는 경우.
// fix3부터는 reduce.ts의 순수 reducer가 막는다: 현재 run은 이 launch의 도구 호출 순서로만 정하고, 지나간 run은 버리고,
// 연결을 증명할 수 없으면 미확인. 재개가 새 도구 ID로 오면 그 호출을 기존 Agent의 별칭으로 합친다.
const updated = (run: string | undefined, patch: object) => ({ type: 'system', subtype: 'task_updated', task_id: 'task-A', ...(run ? { run_id: run } : {}), patch });
const startFg = (tool: string, run: string) => ({ ...start(tool, run), is_backgrounded: false });
const result = (tool: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tool, content: 'ok' }] } });

test('늦게 다시 온 이전 run의 task_started가 끝난 Agent를 되살리지 않는다', () => {
  expect(observe([
    call('tool-A'), start('tool-A', '001'), call('tool-B'), start('tool-B', '002'), done('tool-B', '002'), start('tool-A', '001'), ok,
  ])).toMatchObject({ observed: 0, state: 'ok' });
});

test('이전 run의 배경 전환 patch는 현재 run의 배경 여부를 바꾸지 않는다', () => {
  expect(observe([
    call('tool-A'), startFg('tool-A', '001'), call('tool-B'), startFg('tool-B', '002'), updated('001', { is_backgrounded: true }), result('tool-B'), ok,
  ])).toMatchObject({ observed: 0, state: 'ok' });
});

test('현재 run의 patch는 적용한다', () => {
  expect(observe([
    call('tool-A'), startFg('tool-A', '001'), call('tool-B'), startFg('tool-B', '002'), updated('002', { is_backgrounded: true }), result('tool-B'), ok,
  ])).toMatchObject({ observed: 1, state: 'ok' });
});

test('run을 쓰는 task에 run_id 없는 update·알림이 오면 어느 run인지 모르므로 미확인', () => {
  for (const msg of [updated(undefined, { status: 'completed' }), { type: 'system', subtype: 'task_notification', task_id: 'task-A', status: 'completed' }]) {
    expect(observe([call('tool-A'), start('tool-A', '001'), msg, ok])).toMatchObject({ observed: 1, state: 'unconfirmed' });
  }
});

test('시작을 못 본 run의 update·알림은 적용하지 않고 미확인', () => {
  expect(observe([call('tool-A'), start('tool-A', '001'), done('tool-A', '009'), ok])).toMatchObject({ observed: 1, state: 'unconfirmed' });
});

test('재개 중(이전 run 실행 중)에 새 도구 ID가 와도 합친 뒤에는 하나로 센다', () => {
  expect(observe([call('tool-A'), start('tool-A', '001'), call('tool-B'), start('tool-B', '002'), ok]))
    .toMatchObject({ observed: 1, active: ['tool-A'], state: 'ok' });
});

test('이전 run이 배경이었어도 전경으로 재개된 현재 run은 도구 결과로 끝난다', () => {
  expect(observe([
    call('tool-A'), start('tool-A', '001'), done('tool-A', '001'), call('tool-B'), startFg('tool-B', '002'), result('tool-B'), ok,
  ])).toMatchObject({ observed: 0, peak: 1, state: 'ok' });
});
