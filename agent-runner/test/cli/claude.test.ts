import { describe, expect, test } from 'vitest';
import { SubagentObserver } from '../../src/cli/observe.ts';
import { parseFixture } from './helpers.ts';

const observe = (name: string) => {
  const { events } = parseFixture('Claude', name);
  const o = new SubagentObserver();
  for (const e of events) o.apply(e);
  return { events, o };
};

describe('Claude stream-json 어댑터(fixture)', () => {
  test('성공: 세션·주 Agent 글·토큰·결과', () => {
    const { events } = parseFixture('Claude', 'success');
    expect(events.filter((e) => e.type !== 'activity')).toEqual([
      { type: 'session', sessionId: '0b6f3c2e-6a1d-4f7e-9a51-2d4b8e7c1a90', model: 'claude-opus-5-5' },
      { type: 'message', text: '작업을 시작합니다.' },
      { type: 'message', text: '완료했습니다.' },
      { type: 'usage', inputTokens: 120, cachedInputTokens: 30, outputTokens: 45 },
      { type: 'result', ok: true, reason: 'success', text: '완료했습니다.' },
    ]);
  });

  test('하위 Agent: 복수·중첩 생성의 ID와 부모 연결, 끝난 것만 뺀다', () => {
    const { events, o } = observe('subagents');
    const subs = events.filter((e) => e.type === 'subagent');
    expect(subs.filter((e) => e.phase === 'requested')).toEqual([
      { type: 'subagent', id: 'toolu_A', phase: 'requested', parentId: null },
      { type: 'subagent', id: 'toolu_B', phase: 'requested', parentId: null },
      { type: 'subagent', id: 'toolu_C', phase: 'requested', parentId: 'toolu_A' },
    ]);
    // local_bash(배경 명령)는 하위 Agent가 아니다
    expect(subs.some((e) => e.id === 'toolu_bg')).toBe(false);
    expect(o.snapshot()).toMatchObject({ observed: 1, peak: 3, active: ['toolu_B'] });
  });

  test('하위 Agent 메시지의 글은 주 Agent 글로 섞지 않는다', () => {
    const { events } = parseFixture('Claude', 'subagents');
    expect(events.filter((e) => e.type === 'message')).toEqual([{ type: 'message', text: '검사를 기다립니다.' }]);
  });

  test('배경 하위 Agent: 「시작됨」 도구 결과로는 끝나지 않고 task_notification으로 끝난다', () => {
    const { events } = parseFixture('Claude', 'background');
    const o = new SubagentObserver();
    const counts: number[] = [];
    for (const e of events) {
      o.apply(e);
      counts.push(o.snapshot().observed);
    }
    const launchedAt = events.findIndex((e) => e.type === 'subagent' && e.phase === 'returned');
    expect(launchedAt).toBeGreaterThan(0);
    expect(counts[launchedAt]).toBe(1);
    expect(o.snapshot().observed).toBe(0);
  });

  test('모르는 이벤트·블록은 원문 그대로 보존하고 아무것도 추정하지 않는다', () => {
    const { events, o } = observe('unknown');
    const unknown = events.filter((e) => e.type === 'unknown');
    expect(unknown.map((e) => e.raw.type)).toEqual(['rate_limit_event', 'system', 'future_block', 'stream_event']);
    expect(unknown[1]?.raw).toMatchObject({ subtype: 'brand_new_subtype', payload: { x: 1 } });
    expect(unknown[2]).toMatchObject({ path: 'message.content[0]', raw: { type: 'future_block', data: '?' } });
    expect(events.filter((e) => e.type === 'message')).toEqual([{ type: 'message', text: '계속' }]);
    o.finish();
    expect(o.snapshot()).toMatchObject({ observed: 0, state: 'ok' });
  });

  test('오류 결과: subtype과 오류 문구', () => {
    const { events } = parseFixture('Claude', 'error');
    expect(events.at(-1)).toEqual({ type: 'result', ok: false, reason: 'error_max_turns', text: 'Reached maximum number of turns (30)' });
  });

  test('subtype=success라도 is_error면 실패(terminal_reason)', () => {
    const { events } = parseFixture('Claude', 'api-error');
    expect(events.at(-1)).toEqual({ type: 'result', ok: false, reason: 'api_error', text: 'API Error: 529 overloaded' });
  });

  test('스트림 단절: 마지막 조각은 보존, 실행 중 하위 Agent를 0으로 보지 않고 미확인', () => {
    const { events, o } = observe('truncated');
    expect(events.at(-1)).toMatchObject({ type: 'unparsed', reason: 'truncated' });
    o.finish();
    expect(o.snapshot()).toMatchObject({ observed: 1, state: 'unconfirmed', ended: false });
  });
});
