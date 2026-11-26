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
    // 배경 실행은 시작 직후 「시작됨」 도구 결과가 온다(완료가 아님, fixtures/claude/background.jsonl). 끝은 완료 알림뿐이다.
    if (r.bg) base.push(call(k), start(k, true), result(k), done(k));
    else base.push(call(k), start(k, false), r.byResult ? result(k) : done(k));
  });
  const n = s.past.length + 1;
  base.push(call(n));
  const currentStartAt = base.push(start(n, s.current.bg)) - 1;
  if (s.current.bg) base.push(result(n)); // 배경 「시작됨」 결과
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

// ── 재리뷰 3: launch 경계·배경 도구 결과·이전 launch 완료까지 넣은 무작위 입력 ──
// 기대값을 구현에서 구하지 않는다. 입력열만 보고 「줄여도 되는 근거」를 따로 계산하는 판정기(oracle)와 비교한다.
type Ev =
  | { k: 'call'; c: string }
  | { k: 'start'; t: string; c?: string | undefined; r?: string | undefined; bg: boolean }
  | { k: 'update'; t: string; r?: string | undefined; bg?: boolean | undefined; status?: string | undefined }
  | { k: 'notify'; t: string; c?: string | undefined; r?: string | undefined; status: string }
  | { k: 'result'; c: string }
  | { k: 'launch' }
  | { k: 'ok' };

const C = fc.constantFrom('c1', 'c2', 'c3');
const T = fc.constantFrom('t1', 't2');
const R = fc.option(fc.constantFrom('r1', 'r2'), { nil: undefined });
const STATUS = fc.constantFrom('completed', 'failed', 'stopped', 'running', 'weird');
const ev: fc.Arbitrary<Ev> = fc.oneof(
  { arbitrary: C.map((c) => ({ k: 'call' as const, c })), weight: 3 },
  { arbitrary: fc.record({ t: T, c: fc.option(C, { nil: undefined }), r: R, bg: fc.boolean() }, { requiredKeys: ['t', 'bg'] }).map((x) => ({ k: 'start' as const, ...x })), weight: 3 },
  { arbitrary: fc.record({ t: T, r: R, bg: fc.option(fc.boolean(), { nil: undefined }), status: fc.option(STATUS, { nil: undefined }) }, { requiredKeys: ['t'] }).map((x) => ({ k: 'update' as const, ...x })), weight: 2 },
  { arbitrary: fc.record({ t: T, c: fc.option(C, { nil: undefined }), r: R, status: STATUS }, { requiredKeys: ['t', 'status'] }).map((x) => ({ k: 'notify' as const, ...x })), weight: 2 },
  { arbitrary: C.map((c) => ({ k: 'result' as const, c })), weight: 3 },
  { arbitrary: fc.constant({ k: 'launch' as const }), weight: 1 },
  { arbitrary: fc.constant({ k: 'ok' as const }), weight: 1 },
);

const opt = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
function toLine(e: Exclude<Ev, { k: 'launch' }>): Line {
  switch (e.k) {
    case 'call': return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: e.c, input: {} }] } };
    case 'start': return opt({ type: 'system', subtype: 'task_started', task_id: e.t, task_type: 'local_agent', tool_use_id: e.c, run_id: e.r, is_backgrounded: e.bg });
    case 'update': return opt({ type: 'system', subtype: 'task_updated', task_id: e.t, run_id: e.r, patch: opt({ is_backgrounded: e.bg, status: e.status }) });
    case 'notify': return opt({ type: 'system', subtype: 'task_notification', task_id: e.t, tool_use_id: e.c, run_id: e.r, status: e.status });
    case 'result': return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: e.c, content: 'ok' }] } };
    case 'ok': return OK;
  }
}

describe('property: 증명되지 않은 이벤트는 어떤 수도 줄이지 않는다(launch 경계 포함)', () => {
  test('수가 줄거나 Agent가 빠지는 단계에는 현재 launch 안의 시작 증명이 있다, ended는 이번 launch의 result만 본다', () => {
    fc.assert(fc.property(fc.array(ev, { maxLength: 30 }), (events) => {
      const p = createClaudeParser();
      const o = new SubagentObserver();
      // 판정기 상태: 이번 launch에서 본 호출, 그 호출에 묶인 시작이 있었던 task·호출
      let calls = new Set<string>();
      let provenTasks = new Set<string>();
      let provenCalls = new Set<string>();
      let okSeen = false;
      for (const e of events) {
        const before = o.snapshot();
        if (e.k === 'launch') o.launch();
        else for (const x of p(toLine(e))) o.apply(x);
        const after = o.snapshot();
        const lost = before.active.filter((id) => !after.active.includes(id));
        if (after.observed < before.observed || lost.length > 0) {
          const justified =
            (e.k === 'start' && e.c !== undefined && calls.has(e.c)) ||
            (e.k === 'result' && provenCalls.has(e.c)) ||
            ((e.k === 'update' || e.k === 'notify') && provenTasks.has(e.t));
          expect(justified, `근거 없이 줄어듦: ${JSON.stringify(e)} ${JSON.stringify(before)} → ${JSON.stringify(after)}`).toBe(true);
        }
        if (e.k === 'launch') {
          calls = new Set();
          provenTasks = new Set();
          provenCalls = new Set();
          okSeen = false;
        }
        if (e.k === 'call') calls.add(e.c);
        if (e.k === 'start' && e.c !== undefined && calls.has(e.c)) {
          provenTasks.add(e.t);
          provenCalls.add(e.c);
        }
        if (e.k === 'ok') okSeen = true;
        expect(after.ended).toBe(okSeen);
      }
      const before = o.snapshot();
      o.finish();
      const end = o.snapshot();
      expect(end.observed).toBe(before.observed);
      if (!okSeen) expect(end.state).toBe('unconfirmed');
    }), { numRuns: 3000 });
  });

  test('launch는 수를 줄이지 않고, 이전 launch의 Agent가 남아 있으면 미확인이다', () => {
    fc.assert(fc.property(fc.array(ev, { maxLength: 20 }), (events) => {
      const p = createClaudeParser();
      const o = new SubagentObserver();
      for (const e of events) {
        if (e.k === 'launch') continue;
        for (const x of p(toLine(e))) o.apply(x);
      }
      const before = o.snapshot();
      o.launch();
      const after = o.snapshot();
      expect(after.active).toEqual(before.active);
      if (before.observed > 0) expect(after.state).toBe('unconfirmed');
      expect(after.ended).toBe(false);
    }), { numRuns: 1000 });
  });
});
