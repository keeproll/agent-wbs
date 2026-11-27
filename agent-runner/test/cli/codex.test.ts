import { describe, expect, test } from 'vitest';
import { SubagentObserver } from '../../src/cli/observe.ts';
import { parseFixture } from './helpers.ts';

const observe = (name: string) => {
  const { events } = parseFixture('Codex', name);
  const o = new SubagentObserver();
  for (const e of events) o.apply(e);
  o.finish();
  return { events, o };
};

describe('Codex exec --json 어댑터(fixture)', () => {
  test('성공: thread·활동·주 Agent 글·토큰·결과', () => {
    const { events } = parseFixture('Codex', 'success');
    expect(events.filter((e) => e.type !== 'activity')).toEqual([
      { type: 'session', sessionId: '019a7c1e-3b2f-7d40-9c6e-5f1a2b3c4d5e' },
      { type: 'message', text: '완료했습니다.' },
      { type: 'usage', inputTokens: 2400, cachedInputTokens: 1200, outputTokens: 310 },
      { type: 'result', ok: true, reason: 'completed' },
    ]);
    expect(events.filter((e) => e.type === 'activity').map((e) => `${e.kind}:${e.status ?? ''}`)).toEqual([
      'reasoning:', 'command_execution:in_progress', 'command_execution:completed', 'file_change:completed', 'todo_list:', 'todo_list:',
    ]);
  });

  test('spawn_agent 완료 = 생성 호출 완료일 뿐, agents_states로만 끝을 본다(G §6.7)', () => {
    const { events, o } = observe('subagents');
    const subs = events.filter((e) => e.type === 'subagent');
    expect(subs.filter((e) => e.phase !== 'done').map((e) => `${e.id}:${e.status ?? ''}:${e.parentId ?? ''}`)).toEqual([
      'th-a:pending_init:th-parent', 'th-b:running:th-parent', 'th-c:running:th-a',
    ]);
    // th-a 완료, th-c 오류 종료 → th-b만 남는다. turn.completed(부모 종료) ≠ 자손 정리 완료
    expect(o.snapshot()).toMatchObject({ observed: 1, peak: 3, active: ['th-b'], state: 'ok', ended: true });
  });

  test('생성됐는데 ID가 없으면 집계 근거 부족 → 미확인', () => {
    const { events, o } = observe('missing-id');
    expect(events).toContainEqual({ type: 'subagent_unlinked', reason: 'spawn_agent 완료에 receiver_thread_ids 없음' });
    expect(o.snapshot().state).toBe('unconfirmed');
  });

  test('모르는 이벤트·항목·협업 도구·상태는 원문 보존, 추정하지 않음', () => {
    const { events, o } = observe('unknown');
    const unknown = events.filter((e) => e.type === 'unknown');
    expect(unknown.map((e) => e.path ?? '')).toEqual(['', 'item', 'item']);
    expect(unknown[0]?.raw).toEqual({ type: 'thread.compacted', before_tokens: 9000 });
    expect(unknown[2]?.raw).toMatchObject({ tool: 'future_collab' });
    expect(events).toContainEqual({ type: 'error', message: 'startup warning: 설정 키를 모릅니다', fatal: false });
    // 알려진 도구의 모르는 상태: 끝났다고 추정하지 않고 실행 중으로 남긴 채 미확인
    expect(events).toContainEqual({ type: 'subagent', id: 'th-y', phase: 'unknown', status: 'hibernating', parentId: 'th-unk' });
    expect(o.snapshot()).toMatchObject({ observed: 1, active: ['th-y'], state: 'unconfirmed' });
  });

  test('turn.failed·error: 실패 결과', () => {
    const { events, o } = observe('failed');
    expect(events.slice(-2)).toEqual([
      { type: 'error', message: 'stream disconnected before completion', fatal: true },
      { type: 'result', ok: false, reason: 'turn_failed', text: 'stream disconnected before completion' },
    ]);
    expect(o.snapshot().ended).toBe(true);
  });
});
