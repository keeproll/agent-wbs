// 재리뷰 2 지시 (4): 이벤트 순서를 섞고 중복·지연·누락을 넣어도 「지나간 run의 어떤 이벤트도 현재 상태를 바꾸지 않는다」.
// 실제 경로(원문 JSON → createClaudeParser → SubagentObserver)로 시험한다.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { createClaudeParser } from '../../src/cli/claude.ts';
import { createCodexParser } from '../../src/cli/codex.ts';
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

// ── 재리뷰 3·4: launch 경계·배경 도구 결과·이전 launch 완료·Codex 상태까지 넣은 무작위 입력 ──
// 기대값을 구현에서 구하지 않는다. 입력열만 보고 「어느 ID가 어느 대상인지」와 「그 대상의 시작이 이번 launch에서
// 관측됐는지」를 따로 계산하는 판정기(oracle)와 비교한다. 사라진 ID마다 그 이벤트가 바로 그 대상의 끝(또는 같은 대상으로의
// 합치기)을 증명하는지 본다. 무관한 대상이 줄면 실패한다(재리뷰 4).
type Ev =
  | { k: 'call'; c: string }
  | { k: 'start'; t: string; c?: string | undefined; r?: string | undefined; bg: boolean }
  | { k: 'update'; t: string; r?: string | undefined; bg?: boolean | undefined; status?: string | undefined }
  | { k: 'notify'; t: string; c?: string | undefined; r?: string | undefined; status: string }
  | { k: 'result'; c: string }
  | { k: 'codex'; th: string; tool: string; status: string }
  | { k: 'launch' }
  | { k: 'ok' };

const C = fc.constantFrom('c1', 'c2', 'c3');
const T = fc.constantFrom('t1', 't2');
const R = fc.option(fc.constantFrom('r1', 'r2'), { nil: undefined });
const STATUS = fc.constantFrom('completed', 'failed', 'stopped', 'running', 'weird');
const CODEX_STATUS = fc.constantFrom('pending_init', 'running', 'completed', 'errored', 'shutdown', 'interrupted', 'not_found', 'hibernating');
const ev: fc.Arbitrary<Ev> = fc.oneof(
  { arbitrary: C.map((c) => ({ k: 'call' as const, c })), weight: 3 },
  { arbitrary: fc.record({ t: T, c: fc.option(C, { nil: undefined }), r: R, bg: fc.boolean() }, { requiredKeys: ['t', 'bg'] }).map((x) => ({ k: 'start' as const, ...x })), weight: 3 },
  { arbitrary: fc.record({ t: T, r: R, bg: fc.option(fc.boolean(), { nil: undefined }), status: fc.option(STATUS, { nil: undefined }) }, { requiredKeys: ['t'] }).map((x) => ({ k: 'update' as const, ...x })), weight: 2 },
  { arbitrary: fc.record({ t: T, c: fc.option(C, { nil: undefined }), r: R, status: STATUS }, { requiredKeys: ['t', 'status'] }).map((x) => ({ k: 'notify' as const, ...x })), weight: 2 },
  { arbitrary: C.map((c) => ({ k: 'result' as const, c })), weight: 3 },
  { arbitrary: fc.record({ th: fc.constantFrom('th1', 'th2'), tool: fc.constantFrom('spawn_agent', 'wait'), status: CODEX_STATUS }).map((x) => ({ k: 'codex' as const, ...x })), weight: 3 },
  { arbitrary: fc.constant({ k: 'launch' as const }), weight: 1 },
  { arbitrary: fc.constant({ k: 'ok' as const }), weight: 1 },
);

const opt = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
function toLine(e: Exclude<Ev, { k: 'launch' | 'codex' }>): Line {
  switch (e.k) {
    case 'call': return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: e.c, input: {} }] } };
    case 'start': return opt({ type: 'system', subtype: 'task_started', task_id: e.t, task_type: 'local_agent', tool_use_id: e.c, run_id: e.r, is_backgrounded: e.bg });
    case 'update': return opt({ type: 'system', subtype: 'task_updated', task_id: e.t, run_id: e.r, patch: opt({ is_backgrounded: e.bg, status: e.status }) });
    case 'notify': return opt({ type: 'system', subtype: 'task_notification', task_id: e.t, tool_use_id: e.c, run_id: e.r, status: e.status });
    case 'result': return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: e.c, content: 'ok' }] } };
    case 'ok': return OK;
  }
}
/** Codex 원문 협업 도구 항목(재리뷰 4 재현과 같은 모양) */
const codexLine = (e: Extract<Ev, { k: 'codex' }>): Line => ({
  type: 'item.completed',
  item: { id: `i-${e.th}-${e.status}`, type: 'collab_tool_call', tool: e.tool, sender_thread_id: 'parent', receiver_thread_ids: [e.th], agents_states: { [e.th]: { status: e.status, message: null } }, status: 'completed' },
});

function feed(o: SubagentObserver, parsers: { claude: ReturnType<typeof createClaudeParser>; codex: ReturnType<typeof createCodexParser> }, e: Ev) {
  if (e.k === 'launch') return o.launch();
  const out = e.k === 'codex' ? parsers.codex(codexLine(e)) : parsers.claude(toLine(e));
  for (const x of out) o.apply(x);
}

/**
 * 판정기. 구현 상태를 읽지 않는다.
 * - 대상: Claude는 task(첫 시작에 묶인 호출 ID가 대상 ID), 호출만 본 것은 그 호출 ID가 대상, Codex는 thread ID가 대상.
 * - 이번 launch의 「시작 관측」: Claude는 이번 launch에 본 호출에 묶인 task_started, Codex는 running·pending_init 보고.
 */
class Oracle {
  calls = new Set<string>(); // 이번 launch에서 본 호출
  bound = new Map<string, string>(); // 호출 → task (전 launch 포함)
  owner = new Map<string, string>(); // task → 대상 ID(첫 묶인 호출)
  startedTasks = new Set<string>(); // 이번 launch에서 시작이 관측된 task
  startedCalls = new Set<string>(); // 이번 launch에서 시작에 묶인 호출
  codexRunning = new Set<string>(); // 이번 launch에서 실행 중으로 보고된 thread
  okSeen = false;

  /** 이 이벤트로 ID `lost`가 빠져도 되는가 */
  allows(e: Ev, lost: string): boolean {
    switch (e.k) {
      case 'start': {
        // 같은 task로 이어지는 재개 호출의 임시 ID 합치기: 빠지는 것은 그 호출 자신이고, task에는 이미 다른 대상이 있다.
        if (e.c === undefined || !this.calls.has(e.c) || lost !== e.c) return false;
        const target = this.owner.get(e.t);
        return target !== undefined && target !== e.c;
      }
      case 'result': {
        const t = this.bound.get(e.c);
        return this.startedCalls.has(e.c) && t !== undefined && this.owner.get(t) === lost;
      }
      case 'update':
      case 'notify':
        return this.startedTasks.has(e.t) && this.owner.get(e.t) === lost;
      case 'codex':
        return lost === e.th && this.codexRunning.has(e.th);
      default:
        return false;
    }
  }

  after(e: Ev): void {
    switch (e.k) {
      case 'launch':
        this.calls = new Set();
        this.startedTasks = new Set();
        this.startedCalls = new Set();
        this.codexRunning = new Set();
        this.okSeen = false;
        return;
      case 'call':
        this.calls.add(e.c);
        return;
      case 'start': {
        if (e.c === undefined || !this.calls.has(e.c)) return;
        // 한 호출은 task 하나에만 묶인다. 다른 task가 이미 차지한 호출을 주장하는 시작은 이 task의 시작이 아니다.
        const b = this.bound.get(e.c);
        if (b !== undefined && b !== e.t) return;
        this.bound.set(e.c, e.t);
        if (!this.owner.has(e.t)) this.owner.set(e.t, e.c);
        this.startedTasks.add(e.t);
        this.startedCalls.add(e.c);
        return;
      }
      case 'codex':
        if (e.status === 'running' || e.status === 'pending_init') this.codexRunning.add(e.th);
        return;
      case 'ok':
        this.okSeen = true;
        return;
      default:
        return;
    }
  }
}

function checkRun(events: Ev[]) {
  const parsers = { claude: createClaudeParser(), codex: createCodexParser() };
  const o = new SubagentObserver();
  const oracle = new Oracle();
  for (const e of events) {
    const before = o.snapshot();
    feed(o, parsers, e);
    const after = o.snapshot();
    for (const lost of before.active.filter((id) => !after.active.includes(id))) {
      expect(oracle.allows(e, lost), `근거 없이 ${lost}가 빠짐: ${JSON.stringify(e)} ${JSON.stringify(before.active)} → ${JSON.stringify(after.active)}`).toBe(true);
    }
    // 한 이벤트는 많아야 대상 하나를 끝낸다(합치기는 수를 유지한다).
    expect(before.observed - after.observed, `한 이벤트로 여러 대상이 줄어듦: ${JSON.stringify(e)}`).toBeLessThanOrEqual(1);
    oracle.after(e);
    expect(after.ended).toBe(oracle.okSeen);
  }
  const before = o.snapshot();
  o.finish();
  const end = o.snapshot();
  expect(end.observed).toBe(before.observed);
  if (!oracle.okSeen) expect(end.state).toBe('unconfirmed');
}

describe('property: 증명되지 않은 이벤트는 어떤 수도 줄이지 않는다(launch 경계·Codex 포함)', () => {
  test('사라진 ID마다 바로 그 대상의 이번 launch 시작 관측이 있다, ended는 이번 launch의 result만 본다', () => {
    fc.assert(fc.property(fc.array(ev, { maxLength: 30 }), checkRun), { numRuns: Number(process.env.AWBS_PROPERTY_RUNS ?? 3000) });
  });

  test('판정기 자체 확인: 재리뷰 4의 「무관한 Agent 삭제」 입력에서 원본은 c1·c2를 모두 유지한다', () => {
    checkRun([{ k: 'call', c: 'c1' }, { k: 'start', t: 't1', c: 'c1', bg: true }, { k: 'call', c: 'c2' }, { k: 'start', t: 't2', c: 'c2', bg: true }]);
  });

  test('판정기 자체 확인: 다른 task가 차지한 호출을 주장한 task는 그 호출의 대상이 아니다(seed -1731524055 반례)', () => {
    checkRun([
      { k: 'call', c: 'c2' }, { k: 'start', t: 't1', c: 'c2', bg: false }, { k: 'start', t: 't2', c: 'c2', bg: false },
      { k: 'call', c: 'c1' }, { k: 'start', t: 't2', c: 'c1', bg: false }, { k: 'result', c: 'c1' },
    ]);
  });

  test('launch는 수를 줄이지 않고, 이전 launch의 Agent가 남아 있으면 미확인이다', () => {
    fc.assert(fc.property(fc.array(ev, { maxLength: 20 }), (events) => {
      const parsers = { claude: createClaudeParser(), codex: createCodexParser() };
      const o = new SubagentObserver();
      for (const e of events) if (e.k !== 'launch') feed(o, parsers, e);
      const before = o.snapshot();
      o.launch();
      const after = o.snapshot();
      expect(after.active).toEqual(before.active);
      if (before.observed > 0) expect(after.state).toBe('unconfirmed');
      expect(after.ended).toBe(false);
    }), { numRuns: 1000 });
  });
});
