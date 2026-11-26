// 재리뷰 2 결정 B의 보고 요구 (2): 미확인이 실제로 어디로 이어지는가.
// 잘못된 완료나 0이 되지 않고 「보유 유지(보수 계산) + 새 세션 시작 보류」로 간다. 실제 해제는 exec의 프로세스 그룹 확인(M5-02)뿐이다.
import { describe, expect, test } from 'vitest';
import { createClaudeParser } from '../../src/cli/claude.ts';
import { SubagentObserver, sessionSlots } from '../../src/cli/observe.ts';
import { admit } from '../../src/resources/concurrency.ts';

const call = (id: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id, input: {} }] } });
const start = (tool: string, run: string) => ({ type: 'system', subtype: 'task_started', task_id: 'task-A', task_type: 'local_agent', tool_use_id: tool, run_id: run, is_backgrounded: true });
const done = (tool: string, run: string) => ({ type: 'system', subtype: 'task_notification', task_id: 'task-A', tool_use_id: tool, run_id: run, status: 'completed' });
const updated = (run: string) => ({ type: 'system', subtype: 'task_updated', task_id: 'task-A', run_id: run, patch: { status: 'completed' } });
const ok = { type: 'result', subtype: 'success', is_error: false };

function observe(lines: object[]) {
  const p = createClaudeParser();
  const o = new SubagentObserver();
  for (const line of lines) for (const e of p(line as Record<string, unknown>)) o.apply(e);
  o.finish();
  return o;
}

/** 바꾼 두 시험의 입력(같은 tool-A에 run 두 개) */
const CASES = {
  'review2 시험 2: 002 → 늦은 001 시작·완료': [call('tool-A'), start('tool-A', '002'), start('tool-A', '001'), done('tool-A', '001'), ok],
  'fix2 리뷰어 시험 1: 001 → 002 → 늦은 001 update': [call('tool-A'), start('tool-A', '001'), start('tool-A', '002'), updated('001'), ok],
  // 「진짜 끝」처럼 보이는 알림이 와도 모호한 task의 수는 줄지 않는다
  '모호해진 뒤 두 run 모두의 완료 알림': [call('tool-A'), start('tool-A', '001'), start('tool-A', '002'), done('tool-A', '001'), done('tool-A', '002'), ok],
};

const caps = { total: 10, Claude: 10, Codex: 10, heavy: 2 };

describe.each(Object.entries(CASES))('%s', (_name, lines) => {
  test('완료로 처리하지 않는다: 관측 수 1 유지, 미확인, 이유가 남는다', () => {
    const o = observe(lines);
    expect(o.snapshot()).toMatchObject({ observed: 1, active: ['tool-A'], state: 'unconfirmed', ended: true });
    expect(o.state.reasons.some((r) => r.includes('현재 run을 증명할 수 없음'))).toBe(true);
  });

  test('검증된 조합이어도 보유는 보수 계산(1 + max(예산, 관측, 직전 보유)) — 1+관측이나 1로 줄지 않는다', () => {
    const o = observe(lines);
    expect(sessionSlots(o, { verified: true, budget: 2 })).toBe(3);
    expect(sessionSlots(o, { verified: true, budget: 0 })).toBe(2);
  });

  test('새 세션 시작을 보류한다(unconfirmed_session) — 자리가 남아도', () => {
    const o = observe(lines);
    const s = o.snapshot();
    const reserved = sessionSlots(o, { verified: true, budget: 2 });
    const result = admit({ limit: 10, holdNew: false, caps, held: { total: reserved, Claude: reserved, Codex: 0 }, unconfirmed: s.state === 'unconfirmed' ? 1 : 0, agent: 'Claude', slots: 3 });
    expect(result).toEqual({ ok: false, reason: 'unconfirmed_session' });
  });
});

test('대조: 증명된 재개(새 도구 호출)면 같은 완료가 정상 완료로 이어지고 시작도 막지 않는다', () => {
  const o = observe([call('tool-A'), start('tool-A', '001'), done('tool-A', '001'), call('tool-B'), start('tool-B', '002'), done('tool-B', '002'), ok]);
  expect(o.snapshot()).toMatchObject({ observed: 0, state: 'ok' });
  expect(admit({ limit: 10, holdNew: false, caps, held: { total: 1, Claude: 1, Codex: 0 }, unconfirmed: 0, agent: 'Claude', slots: 3 })).toEqual({ ok: true });
});
