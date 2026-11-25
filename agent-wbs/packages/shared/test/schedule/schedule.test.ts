import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import { capacity, driftCheck, replan, replanDiff, schedule, STAGE_PCT, taskSlots } from '../../src/schedule/index.ts';
import type { Baseline, ScheduleInput, ScheduleTask } from '../../src/schedule/index.ts';
import { prototypeDemo } from './prototype.ts';

const task = (id: string, patch: Partial<ScheduleTask> = {}): ScheduleTask => ({
  id, wbs: `1.1.${id}`, status: 'ready', priority: 1, assignee: 'Claude', est: 4, lo: 2, hi: 8, ...patch,
});
const input = (patch: Partial<ScheduleInput> = {}): ScheduleInput => ({
  now: '2026-11-03T03:00:00Z', tasks: [task('1')], deps: [], sessions: [], assumeRate: 0.6, blackouts: [],
  concurrency: { total: 4, current: 4, subRatio: 0, Claude: 2, Codex: 2 }, usage: {}, ...patch,
});
const baseline = (i: ScheduleInput): Baseline => {
  const b = replan(i, [], { trigger: 'initial', actor: 'Planning', autoReplan: true }).baseline;
  assert(b);
  return b;
};

describe('prototype schedule agreement', () => {
  test('all demo values match actual Sel.schedule except the approved TASK-0010 fixed-start boundary defect', () => {
    const demo = prototypeDemo(), result = schedule(demo.input);
    const day = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
    expect(STAGE_PCT).toEqual(demo.stage);
    expect(Object.keys(result.by)).toHaveLength(12);
    const startDifferences: string[] = [];
    for (const [id, expected] of Object.entries(demo.expected.by)) {
      const actual = result.by[id]; assert(actual);
      if (actual.start !== day(expected.fs)) startDifferences.push(id);
      if (id === 'TASK-0010') {
        // Coordinator decision 2026-11-25: G §6.2 wins over P's preceding-day boundary conversion.
        expect(day(expected.fs)).toBe('2026-11-04');
        expect(demo.input.tasks.find(t => t.id === id)?.fixStart).toBe('2026-11-05');
        expect(actual.start).toBe('2026-11-05');
      } else expect(actual.start, id).toBe(day(expected.fs));
      expect(actual.end, id).toBe(day(expected.fe));
      expect(actual.lo, id).toBe(day(expected.le));
      expect(actual.hi, id).toBe(day(expected.he));
      expect(actual.pct, id).toBe(expected.pct);
      expect(actual.mid.s, id).toBeCloseTo(expected.midE.s, 8);
      expect(actual.mid.e, id).toBeCloseTo(expected.midE.e, 8);
    }
    expect(startDifferences).toEqual(['TASK-0010']);
    for (const key of ['rate', 'rLo', 'rHi'] as const) expect(result.capacity[key]).toBeCloseTo(demo.expected.cap[key], 8);
    for (const key of ['total', 'remain', 'progress', 'doneN', 'n', 'doneRate', 'doneEstRate'] as const) expect(result.project[key]).toBeCloseTo(demo.expected.p[key], 8);
    expect(result.project.end).toBe(day(demo.expected.p.fEnd));
    expect(result.project.lo).toBe(day(demo.expected.p.loEnd));
    expect(result.project.hi).toBe(day(demo.expected.p.hiEnd));
  });
});

describe('schedule uptime', () => {
  test('uses assumption before 72h and seven complete KST days at 72h', () => {
    const i = input({ now: '2026-11-04T15:00:00Z', sessions: [{ from: '2026-11-01T15:01:00Z' }] });
    expect(capacity(i)).toMatchObject({ enough: false, rate: 0.6, rLo: 0.36, rHi: 0.78 });
    const measured = capacity({ ...i, sessions: [{ from: '2026-11-01T15:00:00Z', lastHeartbeatAt: i.now }] });
    expect(measured.enough).toBe(true);
    expect(measured.days[0]?.date).toBe('2026-10-29');
    expect(measured.days[6]?.date).toBe('2026-11-04');
    expect(measured.rate).toBeCloseTo(3 / 7);
    expect(measured.rLo).toBe(0.05);
    expect(measured.rHi).toBe(1);
  });

  test('counts overlap once, clips future portions and ignores future sessions', () => {
    const c = capacity(input({ sessions: [
      { from: '2026-11-02T15:00:00Z', lastHeartbeatAt: '2026-11-03T03:00:00Z' }, { from: '2026-11-02T16:00:00Z', to: '2026-11-04T15:00:00Z' },
      { from: '2026-11-10T15:00:00Z' },
    ] }));
    expect(c.todayRate).toBe(1);
    expect(c.days.every(d => d.rate <= 1)).toBe(true);
    expect(c.logged).toBe(12);
  });

  test('uses 5% floor after sufficient history with no recent uptime', () => {
    expect(capacity(input({ sessions: [{ from: '2026-10-01T00:00:00Z', to: '2026-10-01T01:00:00Z' }] })))
      .toMatchObject({ enough: true, measured: 0, rate: 0.05, rLo: 0.05, rHi: 0.05 });
  });
});

describe('schedule placement', () => {
  test('calculates independent estimate/rate combinations for all three scenarios', () => {
    const r = schedule(input()).by['1']; assert(r);
    expect(r).toMatchObject({ mid: { s: 0, e: 4 }, optimistic: { s: 0, e: 2 }, pessimistic: { s: 0, e: 8 }, end: '2026-11-03', lo: '2026-11-03', hi: '2026-11-04' });
  });

  test('respects global pool, agent cap, Runner limit and subagent ratio', () => {
    expect(taskSlots(10, 0.5)).toBe(6);
    expect(taskSlots(1, 2)).toBe(1);
    const tasks = [task('1'), task('2'), task('3', { assignee: 'Codex' })];
    const i = input({ tasks, concurrency: { total: 4, current: 2, subRatio: 0, Claude: 1, Codex: 2 } });
    expect(schedule(i).by['2']?.mid.s).toBe(4);
    expect(schedule(i).by['3']?.mid.s).toBe(4);
    const serial = schedule({ ...i, concurrency: { ...i.concurrency, subRatio: 1 } });
    expect(serial.by['3']?.mid.s).toBe(8);
    const capped = schedule({ ...i, concurrency: { ...i.concurrency, total: 1 } });
    expect(capped.by['3']?.mid.s).toBe(8);
  });

  test('preserves prototype candidate order even when an agent wait leaves a global slot idle', () => {
    const r = schedule(input({ tasks: [task('1'), task('2'), task('3', { assignee: 'Codex' })],
      concurrency: { total: 2, current: 2, subRatio: 0, Claude: 1, Codex: 1 } }));
    expect(r.by['1']?.mid).toEqual({ s: 0, e: 4 });
    expect(r.by['2']?.mid).toEqual({ s: 4, e: 8 });
    // P reserves the second pool slot for task 2 before considering task 3.
    expect(r.by['3']?.mid).toEqual({ s: 4, e: 8 });
  });

  test('serializes conflict groups across agents while independent work overlaps', () => {
    const r = schedule(input({ tasks: [task('1', { cg: 'db' }), task('2', { cg: 'db', assignee: 'Codex' }), task('3')] }));
    expect(r.by['2']?.mid.s).toBe(4);
    expect(r.by['3']?.mid.s).toBe(0);
  });

  test('places actual starts first, in timestamp order, using stage weighted remaining work', () => {
    const r = schedule(input({ tasks: [task('1'), task('2', { status: 'qa', actStart: '2026-11-03T01:00:00Z' }), task('3', { status: 'running', actStart: '2026-11-02T23:00:00Z' })],
      concurrency: { total: 1, current: 1, subRatio: 0, Claude: 1, Codex: 1 } }));
    expect(r.by['3']?.mid).toEqual({ s: 0, e: 2.6 });
    expect(r.by['2']?.mid.s).toBeCloseTo(2.6);
    expect(r.by['2']?.mid.e).toBeCloseTo(4);
    expect(r.by['1']?.mid.s).toBeCloseTo(4);
  });

  test('uses real completed dates, excludes cancellations and computes both completion rates', () => {
    const i = input({ tasks: [task('1', { status: 'done', actStart: '2026-11-01T15:00:00Z', actEnd: '2026-11-02T16:00:00Z' }), task('2', { est: 8, lo: 4, hi: 10 }), task('3', { status: 'cancelled' })] });
    const r = schedule(i);
    expect(r.by['1']).toMatchObject({ start: '2026-11-02', end: '2026-11-03', lo: '2026-11-03', hi: '2026-11-03', pct: 100, mid: { s: 0, e: 0 } });
    expect(r.by['3']).toBeUndefined();
    expect(r.project).toMatchObject({ total: 12, remain: 8, doneN: 1, n: 2, doneRate: 50 });
    expect(r.project.progress).toBeCloseTo(100 / 3);
    expect(r.project.doneEstRate).toBeCloseTo(100 / 3);
  });

  test.each(['FS', 'SS'] as const)('satisfies %s predecessor release', type => {
    const r = schedule(input({ tasks: [task('1'), task('2', { assignee: 'Codex' })], deps: [{ pred: '1', succ: '2', type }] }));
    expect(r.by['2']?.mid.s).toBe(type === 'FS' ? 4 : 0);
  });

  test('uses release time, then priority, then numeric WBS ordering', () => {
    const r = schedule(input({ tasks: [task('10'), task('2'), task('3', { priority: 0 }), task('4', { priority: 0, fixStart: '2026-11-05' })],
      concurrency: { total: 1, current: 1, subRatio: 0, Claude: 1, Codex: 1 } }));
    expect(r.by['3']?.mid.s).toBe(0);
    expect(r.by['2']?.mid.s).toBe(4);
    expect(r.by['10']?.mid.s).toBe(8);
    expect(r.by['4']?.start).toBe('2026-11-05');
  });

  test.each(['FS', 'SS'] as const)('owner decision removes cancelled predecessor %s constraints', type => {
    const r = schedule(input({ tasks: [task('1', { status: 'cancelled' }), task('2')], deps: [{ pred: '1', succ: '2', type }] }));
    expect(r.by['2']?.mid.s).toBe(0);
  });

  test('holds only exhausted agent slots until reset and releases past resets', () => {
    const i = input({ tasks: [task('1'), task('2', { assignee: 'Codex' })], usage: { Claude: { remain: 0, resetAt: '2026-11-04T03:00:00Z' } } });
    const r = schedule(i);
    expect(r.by['1']?.start).toBe('2026-11-04');
    expect(r.by['1']?.mid.s).toBeCloseTo(14.4);
    expect(r.by['2']?.mid.s).toBe(0);
    expect(schedule({ ...i, usage: { Claude: { remain: 0, resetAt: '2026-11-03T02:59:00Z' } } }).by['1']?.mid.s).toBe(0);
  });

  test('skips blackout capacity, includes weekends, and starts on the next day at exact boundaries', () => {
    const i = input({ assumeRate: 1, blackouts: ['2026-11-04'], tasks: [task('1', { est: 36, lo: 36, hi: 36 }), task('2', { fixStart: '2026-11-04' })] });
    const r = schedule(i);
    expect(r.by['1']?.end).toBe('2026-11-05');
    expect(r.by['2']?.start).toBe('2026-11-05');
    expect(schedule(input({ now: '2026-11-06T15:00:00Z', tasks: [task('1')] })).by['1']?.start).toBe('2026-11-07');
    expect(schedule(input({ blackouts: ['2026-11-03'] })).by['1']?.start).toBe('2026-11-04');
  });

  test('converts UTC and offset instants to the same Asia/Seoul date at midnight', () => {
    const a = schedule(input({ now: '2026-11-03T15:00:00Z' }));
    expect(a.by['1']?.start).toBe('2026-11-04');
    expect(schedule(input({ now: '2026-11-04T00:00:00+09:00' }))).toEqual(a);
  });

  test('is deterministic, preserves inputs, and handles an empty project', () => {
    const i = input(), copy = structuredClone(i), a = schedule(i);
    expect(schedule(i)).toEqual(a); expect(i).toEqual(copy);
    expect(schedule(input({ tasks: [] })).project).toMatchObject({ total: 0, progress: 0, n: 0, doneRate: 0, doneEstRate: 0 });
  });
});

describe('schedule validation', () => {
  test.each([
    input({ now: '2026-11-03 12:00' }),
    input({ blackouts: ['2026-02-30'] }),
    input({ assumeRate: NaN }),
    input({ tasks: [task('1', { lo: 10 })] }),
    input({ tasks: [task('1', { hi: Infinity })] }),
    input({ tasks: [task('1'), task('1')] }),
    input({ tasks: [task('1', { status: 'done' })] }),
    input({ deps: [{ pred: 'missing', succ: '1', type: 'FS' }] }),
    input({ deps: [{ pred: '1', succ: '1', type: 'FS' }] }),
    input({ tasks: [task('1'), task('2')], deps: [{ pred: '1', succ: '2', type: 'FS' }, { pred: '2', succ: '1', type: 'SS' }] }),
    input({ usage: { Claude: { remain: 101 } } }),
    input({ sessions: [{ from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }] }),
  ])('rejects malformed input without inventing a forecast (%#)', i => expect(() => schedule(i)).toThrow(RangeError));
});

describe('schedule replanning', () => {
  const meta = { trigger: 'estimate changed', actor: 'Planning', autoReplan: true };

  test('records delayed, advanced, new and excluded tasks with full before/after dates', () => {
    const i = input({ tasks: [task('1'), task('2'), task('3')] }), b = baseline(i);
    const previous = structuredClone(b);
    previous.items['1'] = { start: '2026-11-02', end: '2026-11-02', lo: '2026-11-02', hi: '2026-11-02' };
    previous.items['2'] = { start: '2026-11-06', end: '2026-11-06', lo: '2026-11-06', hi: '2026-11-06' };
    const r = replan({ ...i, tasks: [task('1'), task('2'), task('4')] }, [previous], meta);
    expect(r.moves.map(m => [m.task, m.kind])).toEqual([['1', 'delayed'], ['2', 'advanced'], ['4', 'new'], ['3', 'excluded']]);
    expect(r.moves[0]).toMatchObject({ before: { end: '2026-11-02' }, after: { end: '2026-11-03' }, delta: 1 });
    expect(r.baseline?.v).toBe(2);
    expect(b.v).toBe(1);
    expect(r.baseline?.items['1']).toHaveProperty('lo');
  });

  test('omits unchanged tasks and start-only/range-only changes from moves', () => {
    const i = input(), b = baseline(i);
    expect(replanDiff(b, schedule(i))).toEqual([]);
    b.items['1'] = { start: '2026-11-02', end: '2026-11-03', lo: '2026-11-02', hi: '2026-11-04' };
    expect(replanDiff(b, schedule(i))).toEqual([]);
  });

  test('D-10 auto off returns pending without a baseline; manual creates a fresh version without mutation', () => {
    const i = input(), history = [baseline(i)], copy = structuredClone(history);
    expect(replan(i, history, { ...meta, autoReplan: false })).toMatchObject({ status: 'pending', baseline: null });
    expect(replan(i, history, { ...meta, autoReplan: false, manual: true })).toMatchObject({ status: 'applied', baseline: { v: 2 } });
    expect(history).toEqual(copy);
  });

  test('driftCheck triggers at project threshold in either direction and creates the initial version', () => {
    const i = input(), b = baseline(i), policy = { thresholdDays: 1, autoReplan: true };
    expect(driftCheck(i, [], policy, meta)?.baseline?.v).toBe(1);
    expect(driftCheck(i, [b], policy, meta)).toBeNull();
    for (const end of ['2026-11-02', '2026-11-04']) expect(driftCheck(i, [{ ...b, end }], policy, meta)?.status).toBe('applied');
    expect(driftCheck(i, [{ ...b, end: '2026-11-02' }], { ...policy, autoReplan: false }, meta)).toMatchObject({ status: 'pending', baseline: null });
    expect(() => driftCheck(i, [b], { ...policy, thresholdDays: NaN }, meta)).toThrow(RangeError);
  });

  test('driftCheck uses prototype task threshold +2 even when project end stays stable, excluding done tasks', () => {
    const i = input(), b = baseline(i);
    b.items['1'] = { start: '2026-10-31', end: '2026-10-31', lo: '2026-10-31', hi: '2026-10-31' };
    expect(driftCheck(i, [b], { thresholdDays: 1, autoReplan: true }, meta)?.status).toBe('applied');
    b.items['1'].end = '2026-11-01';
    expect(driftCheck(i, [b], { thresholdDays: 1, autoReplan: true }, meta)).toBeNull();
    const done = input({ tasks: [task('1', { status: 'done', actStart: '2026-11-02T00:00:00Z', actEnd: '2026-11-02T02:00:00Z' })] });
    b.items['1'].end = '2026-10-20';
    expect(driftCheck(done, [b], { thresholdDays: 1, autoReplan: true }, meta)).toBeNull();
  });
});

test('schedule 200 Task timing and resource/dependency invariants', () => {
  const tasks = Array.from({ length: 200 }, (_, n) => task(String(n + 1), { assignee: n % 2 ? 'Codex' : 'Claude', cg: `group-${n % 10}` }));
  const deps = tasks.slice(10).map((t, n) => ({ pred: String(n + 1), succ: t.id, type: 'FS' as const }));
  const i = input({ tasks, deps, blackouts: ['2026-11-08', '2026-11-15'] }), before = performance.now(), result = schedule(i), ms = performance.now() - before;
  console.info(`schedule 200 Tasks / 190 FS / 10 conflict groups / three scenarios: ${ms.toFixed(2)}ms`);
  expect(Object.keys(result.by)).toHaveLength(200);
  for (const dep of deps) {
    const pred = result.by[dep.pred], succ = result.by[dep.succ]; assert(pred && succ);
    for (const scenario of ['mid', 'optimistic', 'pessimistic'] as const) expect(succ[scenario].s).toBeGreaterThanOrEqual(pred[scenario].e);
  }
  for (const scenario of ['mid', 'optimistic', 'pessimistic'] as const) {
    const periods = tasks.map(t => ({ ...t, ...result.by[t.id]?.[scenario] }));
    for (const t of periods) {
      const start = t.s; assert(start !== undefined);
      const active = periods.filter(p => p.s !== undefined && p.e !== undefined && p.s <= start && p.e > start);
      expect(active.length).toBeLessThanOrEqual(4);
      expect(active.filter(p => p.assignee === t.assignee).length).toBeLessThanOrEqual(2);
      expect(active.filter(p => p.cg === t.cg)).toHaveLength(1);
    }
  }
});
