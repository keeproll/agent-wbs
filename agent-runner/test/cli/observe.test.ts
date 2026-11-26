import { describe, expect, test } from 'vitest';
import { SubagentObserver, sessionSlots } from '../../src/cli/observe.ts';
import type { CliEvent } from '../../src/cli/events.ts';

const run = (events: CliEvent[], finish = true) => {
  const o = new SubagentObserver();
  for (const e of events) o.apply(e);
  if (finish) o.finish();
  return o;
};
const result: CliEvent = { type: 'result', ok: true, reason: 'completed' };
/** Codex 상태 보고 */
const sub = (id: string, phase: 'running' | 'done' | 'unknown', extra: object = {}): CliEvent => ({ type: 'subagent', id, phase, ...extra });
/** Claude 도구 호출·결과·task 시작·알림 */
const call = (id: string): CliEvent => ({ type: 'agent_call', id, parentId: null });
const toolResult = (id: string): CliEvent => ({ type: 'tool_result', toolUseId: id });
const started = (id: string, background: boolean): CliEvent => ({ type: 'task', op: 'started', taskId: `t-${id}`, taskType: 'local_agent', toolUseId: id, background });
const notified = (id: string): CliEvent => ({ type: 'task', op: 'notification', taskId: `t-${id}`, toolUseId: id, status: 'completed' });

describe('SubagentObserver — 관측만, 추정·반환 근거 아님(G §6.7)', () => {
  test('같은 ID를 여러 번 봐도 한 번만 센다', () => {
    expect(run([call('a'), call('a'), sub('b', 'running'), sub('b', 'running'), result]).snapshot()).toMatchObject({ observed: 2, peak: 2 });
  });

  test('결과 없이 끝난 스트림(출력 없음·단절)은 실행 수 0이 아니라 미확인', () => {
    const o = run([sub('a', 'running')]);
    expect(o.snapshot()).toMatchObject({ observed: 1, state: 'unconfirmed', ended: false });
  });

  test('아무 이벤트 없이 끝나도 미확인', () => {
    expect(run([]).snapshot().state).toBe('unconfirmed');
  });

  test('모르는 하위 Agent 상태는 빼지 않고 미확인', () => {
    const o = run([sub('a', 'running'), sub('a', 'unknown', { status: 'hibernating' }), result]);
    expect(o.snapshot()).toMatchObject({ observed: 1, state: 'unconfirmed' });
  });

  test('해석하지 못한 줄(깨진 JSON)이 있으면 관측이 불완전하므로 미확인', () => {
    const o = run([{ type: 'unparsed', line: 3, raw: '{x', reason: 'invalid_json', bytes: 2 }, result]);
    expect(o.snapshot().state).toBe('unconfirmed');
  });

  test('CLI가 섞어 낸 일반 문구 한 줄이 아니라 JSON 깨짐만 문제 삼는다: 모르는 이벤트는 상태를 바꾸지 않는다', () => {
    const o = run([{ type: 'unknown', raw: { type: 'new' } }, result]);
    expect(o.snapshot().state).toBe('ok');
  });

  test('배경 하위 Agent는 도구 결과로 빼지 않는다', () => {
    const o = run([call('a'), started('a', true), toolResult('a'), result], false);
    expect(o.snapshot().observed).toBe(1);
    o.apply(notified('a'));
    expect(o.snapshot().observed).toBe(0);
  });

  test('전경 하위 Agent는 도구 결과로 끝난 것으로 본다', () => {
    expect(run([call('a'), toolResult('a'), result]).snapshot().observed).toBe(0);
  });

  test('ID 없는 생성은 미확인', () => {
    expect(run([{ type: 'subagent_unlinked', reason: 'x' }, result]).snapshot().state).toBe('unconfirmed');
  });

  test('한 번 미확인이면 뒤의 정상 결과로 되돌아가지 않는다', () => {
    const o = run([{ type: 'subagent_unlinked', reason: 'x' }, result, result]);
    expect(o.snapshot().state).toBe('unconfirmed');
  });
});

describe('sessionSlots — 보유 계산(미검증 CLI는 보수 계산 1+예산, owner Q-12: 항상 최신)', () => {
  test('미검증: 관측이 0이어도 1+예산', () => {
    const o = run([result]);
    expect(sessionSlots(o, { verified: false, budget: 3 })).toBe(4);
  });
  test('미검증: 관측이 예산을 넘으면 관측값', () => {
    const o = run(['a', 'b', 'c', 'd', 'e'].map((id) => sub(id, 'running')).concat(result));
    expect(sessionSlots(o, { verified: false, budget: 3 })).toBe(6);
  });
  test('검증됨 + 정상 관측: 1+관측', () => {
    const o = run([sub('a', 'running'), result]);
    expect(sessionSlots(o, { verified: true, budget: 3 })).toBe(2);
  });
  test('검증됨이라도 미확인이면 보수 계산, 직전 보유 수 아래로 내려가지 않는다', () => {
    const o = run([sub('a', 'running')]);
    expect(sessionSlots(o, { verified: true, budget: 2, previousHeld: 5 })).toBe(6);
  });
});
