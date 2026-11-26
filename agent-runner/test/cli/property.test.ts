// 재리뷰 2 지시 (4): 이벤트 순서를 섞고 중복·지연·누락을 넣어도 「지나간 run의 어떤 이벤트도 현재 상태를 바꾸지 않는다」.
// 실제 경로(원문 JSON → createClaudeParser → SubagentObserver)로 시험한다.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { createClaudeParser } from '../../src/cli/claude.ts';
import { SubagentObserver } from '../../src/cli/observe.ts';

type Line = Record<string, unknown>;
const call = (k: number): Line => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Agent', id: `call-${String(k)}`, input: {} }] } });
const start = (k: number, bg: boolean): Line => ({ type: 'system', subtype: 'task_started', task_id: 'task-A', task_type: 'local_agent', tool_use_id: `call-${String(k)}`, run_id: `r-${String(k)}`, is_backgrounded: bg });
const done = (k: number, status = 'completed'): Line => ({ type: 'system', subtype: 'task_notification', task_id: 'task-A', tool_use_id: `call-${String(k)}`, run_id: `r-${String(k)}`, status });
const updated = (k: number, patch: object): Line => ({ type: 'system', subtype: 'task_updated', task_id: 'task-A', run_id: `r-${String(k)}`, patch });
const result = (k: number): Line => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: `call-${String(k)}`, content: 'ok' }] } });
const OK: Line = { type: 'result', subtype: 'success', is_error: false };

function run(lines: Line[]) {
  const p = createClaudeParser();
  const o = new SubagentObserver();
  for (const line of lines) for (const e of p(line)) o.apply(e);
  o.finish();
  const { observed, active, state, ended } = o.snapshot();
  return { observed, active, state, ended };
}

/** 한 Agent를 n번 실행(앞 n-1번은 끝난 지나간 run, 마지막이 현재 run). 각 run은 자기 도구 호출로 시작한다. */
const scenario = fc.record({
  past: fc.array(fc.record({ bg: fc.boolean(), byResult: fc.boolean() }), { minLength: 1, maxLength: 4 }),
  current: fc.record({ bg: fc.boolean(), end: fc.constantFrom('running', 'done', 'result') }),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

function build(s: Scenario): { base: Line[]; currentStartAt: number; n: number } {
  const base: Line[] = [];
  s.past.forEach((r, i) => {
    const k = i + 1;
    base.push(call(k), start(k, r.bg), !r.bg && r.byResult ? result(k) : done(k));
  });
  const n = s.past.length + 1;
  base.push(call(n));
  const currentStartAt = base.push(start(n, s.current.bg)) - 1;
  if (s.current.end === 'done') base.push(done(n));
  if (s.current.end === 'result' && !s.current.bg) base.push(result(n));
  base.push(OK);
  return { base, currentStartAt, n };
}

/** 지나간 run k의 늦은·중복 메시지 후보 */
const pastNoise = (k: number): Line[] => [
  start(k, true), start(k, false), done(k), done(k, 'failed'), result(k), call(k),
  updated(k, { is_backgrounded: true }), updated(k, { is_backgrounded: false }), updated(k, { status: 'completed' }),
];

const insertAll = (lines: Line[], inserts: { at: number; line: Line }[]) => {
  const out = [...lines];
  for (const { at, line } of [...inserts].sort((a, b) => b.at - a.at)) out.splice(at, 0, line);
  return out;
};

describe('property: 지나간 run의 메시지는 현재 상태를 바꾸지 않는다', () => {
  test('기준 시나리오 자체: 현재 run이 실행 중이면 1, 끝났으면 0, 정상', () => {
    fc.assert(fc.property(scenario, (s) => {
      const { base } = build(s);
      const expected = s.current.end === 'running' || (s.current.end === 'result' && s.current.bg) ? 1 : 0;
      expect(run(base)).toMatchObject({ observed: expected, state: 'ok', ended: true });
    }), { numRuns: 300 });
  });

  test('현재 run 시작 뒤 아무 곳에 지나간 run 메시지를 섞고 중복으로 넣어도 최종 상태가 같다', () => {
    fc.assert(fc.property(scenario, fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat()), { maxLength: 30 }), (s, picks) => {
      const { base, currentStartAt, n } = build(s);
      const room = base.length - 1 - currentStartAt; // 시작 바로 뒤 ~ 마지막 result 앞
      const inserts = picks.map(([run, kind, pos]) => {
        const k = (run % (n - 1)) + 1;
        const noise = pastNoise(k);
        return { at: currentStartAt + 1 + (pos % room), line: noise[kind % noise.length] as Line };
      });
      expect(run(insertAll(base, inserts))).toEqual(run(base));
    }), { numRuns: 500 });
  });

  test('지연: 지나간 run의 끝 메시지를 현재 run 시작 뒤로 미뤄도 최종 상태가 같다', () => {
    fc.assert(fc.property(scenario, fc.array(fc.nat(), { maxLength: 8 }), (s, delays) => {
      const { base, currentStartAt } = build(s);
      const pastEnds = base.slice(0, currentStartAt).map((l, i) => ({ l, i })).filter(({ l }) => l.subtype === 'task_notification' || l.type === 'user');
      const moved = new Set(delays.map((d) => pastEnds[d % Math.max(1, pastEnds.length)]?.i).filter((i): i is number => i !== undefined));
      const kept = base.filter((_, i) => !moved.has(i));
      const startAt = kept.indexOf(base[currentStartAt] as Line);
      const late = [...moved].map((i, j) => ({ at: startAt + 1 + (j % (kept.length - 1 - startAt)), line: base[i] as Line }));
      expect(run(insertAll(kept, late))).toEqual(run(base));
    }), { numRuns: 500 });
  });

  test('중복: 어떤 메시지를 뒤에 한 번 더 넣어도 최종 상태가 같다', () => {
    fc.assert(fc.property(scenario, fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 10 }), (s, dups) => {
      const { base } = build(s);
      const inserts = dups.map(([from, gap]) => {
        const i = from % (base.length - 1);
        return { at: i + 1 + (gap % (base.length - 1 - i)), line: base[i] as Line };
      });
      expect(run(insertAll(base, inserts))).toEqual(run(base));
    }), { numRuns: 500 });
  });

  test('섞기·누락: 도구 호출 순서만 지키고 나머지를 섞거나 빼도 「정상인데 실제보다 적게」는 없다', () => {
    fc.assert(fc.property(scenario, fc.array(fc.nat()), fc.array(fc.boolean()), (s, keys, drops) => {
      const { base } = build(s);
      const truth = run(base).observed;
      // 누락은 task·도구 결과 메시지에만 넣는다. 모델의 도구 호출 줄 자체가 조용히 사라지면 어떤 설계로도 알 수 없다
      // (그런 단절은 깨진 줄·결과 없는 종료로 따로 미확인이 된다).
      const body = base.slice(0, -1).filter((l, i) => l.type === 'assistant' || !drops[i]);
      // 모델이 낸 도구 호출(assistant)은 한 스트림에서 순서가 바뀌지 않는다. 그 밖의 메시지는 아무 순서로 온다.
      const calls = body.filter((l) => l.type === 'assistant');
      const others = body.filter((l) => l.type !== 'assistant').map((l, i) => ({ l, key: keys[i] ?? i })).sort((a, b) => a.key - b.key).map((x) => x.l);
      const mixed: Line[] = [];
      let c = 0;
      others.forEach((l, i) => {
        while (c < calls.length && (keys[i + 7] ?? 0) % 3 === 0) mixed.push(calls[c++] as Line);
        mixed.push(l);
      });
      mixed.push(...calls.slice(c), OK);
      const got = run(mixed);
      if (got.state === 'ok') expect(got.observed).toBeGreaterThanOrEqual(truth);
    }), { numRuns: 1000 });
  });
});
