// M5-01 독립 리뷰(Codex) 지적 1~5 재현. 각 시험은 리뷰 재현 입력(probes.json)을 그대로 옮겼다.
import { describe, expect, test } from 'vitest';
import type { Agent } from '../../src/api/generated/client.ts';
import { parseStream } from '../../src/cli/adapters.ts';
import { buildLaunch, sessionOptions } from '../../src/cli/args.ts';
import type { IsolationLayer } from '../../src/cli/isolation.ts';
import { SubagentObserver, sessionSlots } from '../../src/cli/observe.ts';
import { JsonlDecoder, type StreamRecord } from '../../src/cli/stream.ts';

const records = (lines: object[]): StreamRecord[] => lines.map((value, i) => ({ kind: 'json', line: i + 1, raw: JSON.stringify(value), value: value as Record<string, unknown> }));
const observe = (agent: Agent, lines: object[]) => {
  const events = parseStream(agent, records(lines));
  const o = new SubagentObserver();
  for (const e of events) o.apply(e);
  o.finish();
  return { events, o, s: o.snapshot() };
};
const agentCall = (id: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] } });
const toolResult = (id: string) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const started = (extra: object) => ({ type: 'system', subtype: 'task_started', task_id: 'task-A', task_type: 'local_agent', description: 'x', ...extra });
const ok = { type: 'result', subtype: 'success', is_error: false, session_id: 's' };

describe('리뷰 1 [P1] Claude 전경 → 배경 전환(task_updated)', () => {
  test('배경으로 바뀐 뒤의 도구 결과로는 빼지 않는다', () => {
    const { s } = observe('Claude', [
      agentCall('tool-A'), started({ tool_use_id: 'tool-A', is_backgrounded: false }),
      { type: 'system', subtype: 'task_updated', task_id: 'task-A', patch: { is_backgrounded: true } },
      toolResult('tool-A'), ok,
    ]);
    expect(s).toMatchObject({ observed: 1, active: ['tool-A'], state: 'ok' });
  });

  test('배경 전환 뒤 완료 알림이 오면 뺀다', () => {
    const { s } = observe('Claude', [
      agentCall('tool-A'), started({ tool_use_id: 'tool-A', is_backgrounded: false }),
      { type: 'system', subtype: 'task_updated', task_id: 'task-A', patch: { is_backgrounded: true } },
      toolResult('tool-A'), { type: 'system', subtype: 'task_notification', task_id: 'task-A', tool_use_id: 'tool-A', status: 'completed' }, ok,
    ]);
    expect(s).toMatchObject({ observed: 0, state: 'ok' });
  });

  test('연결할 수 없는 task_updated는 정상으로 두지 않는다(미확인)', () => {
    const { s } = observe('Claude', [{ type: 'system', subtype: 'task_updated', task_id: 'task-Z', patch: { is_backgrounded: true } }, ok]);
    expect(s.state).toBe('unconfirmed');
  });

  test('하위 Agent가 아닌 배경 명령의 task_updated는 무시한다', () => {
    const { s } = observe('Claude', [
      { type: 'system', subtype: 'task_started', task_id: 'bash-1', task_type: 'local_bash', description: 'x' },
      { type: 'system', subtype: 'task_updated', task_id: 'bash-1', patch: { is_backgrounded: true } }, ok,
    ]);
    expect(s).toMatchObject({ observed: 0, state: 'ok' });
  });
});

describe('리뷰 2 [P1] 복구 불가능한 스트림 오류', () => {
  test('Codex error 뒤 turn.failed가 와도 관측은 미확인으로 고정', () => {
    const { s, o } = observe('Codex', [
      { type: 'thread.started', thread_id: 'parent' },
      { type: 'item.completed', item: { id: 'i', type: 'collab_tool_call', tool: 'spawn_agent', sender_thread_id: 'parent', receiver_thread_ids: ['a'], agents_states: { a: { status: 'running' } }, status: 'completed' } },
      { type: 'error', message: 'stream disconnected before completion' },
      { type: 'turn.failed', error: { message: 'stream disconnected before completion' } },
    ]);
    expect(s).toMatchObject({ observed: 1, state: 'unconfirmed', ended: true });
    expect(sessionSlots(o, { verified: true, budget: 2, previousHeld: 2 })).toBe(3);
  });

  test('오류 이벤트 없는 일반 작업 실패(turn.failed)는 관측 정상 유지', () => {
    const { s } = observe('Codex', [{ type: 'thread.started', thread_id: 'p' }, { type: 'turn.failed', error: { message: '테스트 실패' } }]);
    expect(s).toMatchObject({ state: 'ok', ended: true });
  });

  test('Codex 항목 오류(시작 경고, fatal 아님)는 관측을 흔들지 않는다', () => {
    const { s } = observe('Codex', [{ type: 'item.completed', item: { id: 'w', type: 'error', message: '경고' } }, { type: 'turn.completed', usage: {} }]);
    expect(s.state).toBe('ok');
  });
});

describe('리뷰 3 [P2] Claude 연결 정보 누락·재개 run', () => {
  test('A: task_type 없는 task_started → 미확인(버리지 않음)', () => {
    const { s, events } = observe('Claude', [started({ tool_use_id: 'tool-A', task_type: undefined }), ok]);
    expect(events.some((e) => e.type === 'subagent_unlinked')).toBe(true);
    expect(s.state).toBe('unconfirmed');
  });

  test('B: 도구 호출 뒤 tool_use_id 없는 task_started → 추측해 새 ID로 세지 않고 미확인', () => {
    const { s } = observe('Claude', [
      agentCall('tool-A'), started({ is_backgrounded: true }),
      { type: 'system', subtype: 'task_notification', task_id: 'task-A', status: 'completed' }, ok,
    ]);
    expect(s.peak).toBe(1);
    expect(s.active).not.toContain('task:task-A');
    expect(s.state).toBe('unconfirmed');
  });

  test('C: 재개 run(run_id 002)은 늦게 온 001 완료 알림으로 지우지 않는다', () => {
    const { s } = observe('Claude', [
      agentCall('tool-A'),
      started({ tool_use_id: 'tool-A', run_id: '001', is_backgrounded: true }),
      started({ tool_use_id: 'tool-A', run_id: '002', is_backgrounded: true }),
      { type: 'system', subtype: 'task_notification', task_id: 'task-A', tool_use_id: 'tool-A', run_id: '001', status: 'completed' },
      ok,
    ]);
    expect(s).toMatchObject({ observed: 1, active: ['tool-A'] });
  });

  test('C: 현재 run의 완료 알림은 뺀다', () => {
    const { s } = observe('Claude', [
      agentCall('tool-A'),
      started({ tool_use_id: 'tool-A', run_id: '001', is_backgrounded: true }),
      started({ tool_use_id: 'tool-A', run_id: '002', is_backgrounded: true }),
      { type: 'system', subtype: 'task_notification', task_id: 'task-A', tool_use_id: 'tool-A', run_id: '002', status: 'completed' },
      ok,
    ]);
    expect(s).toMatchObject({ observed: 0, state: 'ok' });
  });

  test('ID 없는 Agent 도구 호출 → 미확인', () => {
    const { s } = observe('Claude', [{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Agent', input: {} }] } }, ok]);
    expect(s.state).toBe('unconfirmed');
  });
});

describe('리뷰 4 [P2] 관측 등급 키: 새 실행과 재개 구분', () => {
  const iso: IsolationLayer = { name: 't', flags: () => [], wrap: (l) => l };
  test.each(['Codex', 'Claude'] as const)('%s: 새 실행과 재개의 옵션 문자열이 다르다', (agent) => {
    expect(sessionOptions(agent, iso, 'resume')).not.toBe(sessionOptions(agent, iso, 'new'));
  });

  test.each(['Codex', 'Claude'] as const)('%s: 재개 옵션의 낱말은 모두 재개 argv에 있고 세션 ID는 키에 없다', (agent) => {
    const resume = 'sess-1234';
    const l = buildLaunch(agent, '/bin/x', { model: 'm-1', effort: 'high', cwd: '/w', prompt: 'p', resume }, { env: {}, isolation: iso });
    const key = sessionOptions(agent, iso, 'resume');
    for (const word of key.split(' ')) expect(l.args).toContain(word);
    expect(key).not.toContain(resume);
    const fresh = buildLaunch(agent, '/bin/x', { model: 'm-1', effort: 'high', cwd: '/w', prompt: 'p' }, { env: {}, isolation: iso });
    expect(fresh.args.some((a) => a === 'resume' || a === '--resume')).toBe(false);
  });
});

describe('리뷰 5 [P2] 큰 줄·큰 조각을 메모리에 붙잡지 않는다', () => {
  test('한도를 넘은 줄은 앞부분만 복사해 둔다', () => {
    const d = new JsonlDecoder({ maxLineBytes: 1024, keepBytes: 16 });
    d.push(Buffer.alloc(4 * 1024 * 1024, 0x61));
    expect(d.retainedBytes).toBeLessThanOrEqual(16);
    expect(d.end()[0]).toMatchObject({ reason: 'too_long', bytes: 4 * 1024 * 1024, raw: 'a'.repeat(16) });
  });

  test('큰 조각 끝의 작은 미완성 줄은 조각 전체를 붙잡지 않는다', () => {
    const d = new JsonlDecoder();
    const big = Buffer.concat([Buffer.from(`{"a":"${'x'.repeat(2 * 1024 * 1024)}"}\n`), Buffer.from('{"b":')]);
    expect(d.push(big)).toHaveLength(1);
    expect(d.retainedBytes).toBeLessThanOrEqual(64);
    expect(d.push('1}\n')).toEqual([expect.objectContaining({ kind: 'json', value: { b: 1 } })]);
  });
});
