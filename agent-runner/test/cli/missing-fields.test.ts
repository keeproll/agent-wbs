// 재리뷰 5 규칙을 해석기 전체에 적용: 빠진 필드·모르는 값은 긍정 상태(실행 중·시작됨·끝남·전경·주 Agent)로 채우지 않는다.
import { describe, expect, test } from 'vitest';
import { createClaudeParser } from '../../src/cli/claude.ts';
import { createCodexParser } from '../../src/cli/codex.ts';
import { SubagentObserver } from '../../src/cli/observe.ts';

const ok = { type: 'result', subtype: 'success', is_error: false };
function claude(lines: object[]) {
  const p = createClaudeParser();
  const o = new SubagentObserver();
  const events = lines.flatMap((l) => p(l as Record<string, unknown>));
  for (const e of events) o.apply(e);
  o.finish();
  return { events, s: o.snapshot() };
}

describe('Codex', () => {
  const collab = (tool: string, states: Record<string, unknown> | undefined) => ({
    type: 'item.completed',
    item: { id: `i-${tool}`, type: 'collab_tool_call', tool, sender_thread_id: 'p', receiver_thread_ids: ['th-a'], ...(states === undefined ? {} : { agents_states: states }), status: 'completed' },
  });

  test.each([
    ['상태 객체에 status 없음', { 'th-a': {} }],
    ['상태가 객체가 아님', { 'th-a': 'running' }],
    ['status가 문자열이 아님', { 'th-a': { status: 1 } }],
    ['spawn 완료에 agents_states 자체가 없음', undefined],
  ])('%s → phase unknown(실행 중으로 채우지 않음)', (_n, states) => {
    expect(createCodexParser()(collab('spawn_agent', states))).toEqual([{ type: 'subagent', id: 'th-a', phase: 'unknown', parentId: 'p' }]);
  });

  test('sender_thread_id가 없으면 부모를 주 Agent(null)로 채우지 않는다', () => {
    const line = collab('spawn_agent', { 'th-a': { status: 'running' } });
    Reflect.deleteProperty(line.item, 'sender_thread_id');
    expect(createCodexParser()(line)).toEqual([{ type: 'subagent', id: 'th-a', phase: 'running', status: 'running' }]);
  });

  test('turn.completed에 usage가 없으면 토큰 0을 지어내지 않는다', () => {
    expect(createCodexParser()({ type: 'turn.completed' })).toEqual([{ type: 'result', ok: true, reason: 'completed' }]);
  });

  test('상태 없는 spawn은 시작 증명이 아니므로 뒤의 완료가 수를 줄이지 않는다', () => {
    const p = createCodexParser();
    const o = new SubagentObserver();
    for (const e of [...p(collab('spawn_agent', undefined)), ...p(collab('wait', { 'th-a': { status: 'completed' } }))]) o.apply(e);
    o.apply({ type: 'result', ok: true, reason: 'completed' });
    o.finish();
    expect(o.snapshot()).toMatchObject({ observed: 1, state: 'unconfirmed' });
  });
});

describe('Claude', () => {
  const call = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Agent', id: 'a', input: {} }] } };
  const result = { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } };
  const start = (extra: object) => ({ type: 'system', subtype: 'task_started', task_id: 't', task_type: 'local_agent', tool_use_id: 'a', ...extra });

  test('is_backgrounded가 없는 시작은 전경으로 채우지 않는다: 도구 결과로 줄이지 않고 미확인', () => {
    const { events, s } = claude([call, start({}), result, ok]);
    expect(events.find((e) => e.type === 'task')).not.toHaveProperty('background');
    expect(s).toMatchObject({ observed: 1, state: 'unconfirmed' });
  });

  test.each([['문자열', 'false'], ['숫자', 0]])('is_backgrounded가 %s이면 모름으로 본다', (_n, value) => {
    expect(claude([call, start({ is_backgrounded: value }), result, ok]).s).toMatchObject({ observed: 1, state: 'unconfirmed' });
  });

  test('명시적 전경(false)이면 도구 결과로 끝난다(대조)', () => {
    expect(claude([call, start({ is_backgrounded: false }), result, ok]).s).toMatchObject({ observed: 0, state: 'ok' });
  });

  test('parent_tool_use_id가 없는 글은 주 Agent 글로 보지 않고 원문을 보존한다', () => {
    const { events } = claude([{ type: 'assistant', message: { content: [{ type: 'text', text: '누구의 글인지 모름' }] } }, ok]);
    expect(events.filter((e) => e.type === 'message')).toEqual([]);
    expect(events).toContainEqual({ type: 'unknown', raw: { type: 'text', text: '누구의 글인지 모름' }, path: 'message.content[0](parent_tool_use_id 없음)' });
  });

  test('parent_tool_use_id가 없는 Agent 호출은 부모를 주 Agent(null)로 채우지 않는다', () => {
    const { events } = claude([{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'x', input: {} }] } }]);
    expect(events).toContainEqual({ type: 'agent_call', id: 'x' });
  });

  test('알림 status가 없으면 끝으로 보지 않는다', () => {
    const { s } = claude([call, start({ is_backgrounded: true, run_id: 'r' }), { type: 'system', subtype: 'task_notification', task_id: 't', run_id: 'r' }, ok]);
    expect(s).toMatchObject({ observed: 1, state: 'unconfirmed' });
  });
});
