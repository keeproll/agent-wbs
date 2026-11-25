import assert from 'node:assert/strict';
import { describe, expect, test } from 'vitest';
import { capacity, driftCheck, replan, replanDiff, schedule, taskSlots } from '../../src/schedule/index.ts';
import type { Baseline, ScheduleInput, ScheduleTask } from '../../src/schedule/index.ts';
import { prototypeCapacity } from './prototype.ts';

const task = (id: string, patch: Partial<ScheduleTask> = {}): ScheduleTask => ({
  id, wbs: `1.1.${id}`, status: 'ready', priority: 1, assignee: 'Claude', est: 4, lo: 2, hi: 8, ...patch,
});
const input = (patch: Partial<ScheduleInput> = {}): ScheduleInput => ({
  now: '2026-11-03T03:00:00Z', tasks: [task('1')], deps: [], sessions: [], assumeRate: 0.6, blackouts: [],
  concurrency: { total: 4, current: 4, subRatio: 0, Claude: 2, Codex: 2 }, usage: {}, ...patch,
});
const meta = { trigger: 'review', actor: 'Planning', autoReplan: true };
const baseline = (i: ScheduleInput): Baseline => {
  const b = replan(i, [], meta).baseline; assert(b); return b;
};

describe('P1-1 heartbeat termination', () => {
  test('stale open interval ends at last heartbeat, not now', () => {
    const i = { ...input(), now: '2026-11-10T03:00:00Z', heartbeat: { intervalSec: 60, missLimit: 3 },
      sessions: [{ from: '2026-11-02T15:00:00Z', lastHeartbeatAt: '2026-11-02T16:00:00Z' }] };
    expect(capacity(i).rate).toBe(0.05);
    expect(capacity(i)).toEqual(capacity({ ...i, sessions: [{ ...i.sessions[0], from: '2026-11-02T15:00:00Z', to: '2026-11-02T16:00:00Z' }] }));
  });

  test.each([
    ['2026-11-10T03:02:59.999Z', false], ['2026-11-10T03:03:00.000Z', true], ['2026-11-10T03:03:00.001Z', true],
  ] as const)('three missed heartbeats at millisecond boundary %s', (now, stale) => {
    const i = { ...input(), now, heartbeat: { intervalSec: 60, missLimit: 3 },
      sessions: [{ from: '2026-11-02T15:00:00Z', lastHeartbeatAt: '2026-11-10T03:00:00Z' }] };
    const c = capacity(i);
    expect(c.todayRate).toBeCloseTo(stale ? 12 / (12 + (Date.parse(now) - Date.parse('2026-11-10T03:00:00Z')) / 3_600_000) : 1, 8);
  });

  test('honors supplied heartbeat settings, explicit closed interval and missing first heartbeat', () => {
    const i = { ...input(), heartbeat: { intervalSec: 30, missLimit: 2 },
      sessions: [{ from: '2026-11-02T15:00:00Z', lastHeartbeatAt: '2026-11-03T02:59:00Z' }] };
    expect(capacity(i).todayRate).toBeCloseTo(719 / 720, 8);
    expect(capacity({ ...i, sessions: [{ ...i.sessions[0], from: '2026-11-02T15:00:00Z', to: i.now }] }).todayRate).toBe(1);
    expect(capacity({ ...i, sessions: [{ from: '2026-11-02T15:00:00Z' }] }).todayRate).toBe(0);
  });
});

describe('P1-2 input resilience', () => {
  test('unknown reset keeps P immediate availability and emits a structured warning through replanning', () => {
    const i = input({ usage: { Claude: { remain: 0 } } }), r = schedule(i);
    expect(r.by['1']?.mid.s).toBe(0);
    expect(r).toMatchObject({ warnings: [{ code: 'USAGE_RESET_UNKNOWN', agent: 'Claude' }] });
    expect(replan(i, [], meta)).toMatchObject({ warnings: [{ code: 'USAGE_RESET_UNKNOWN', agent: 'Claude' }] });
    expect(driftCheck(i, [], { thresholdDays: 1, autoReplan: true }, meta)).toMatchObject({ warnings: [{ code: 'USAGE_RESET_UNKNOWN', agent: 'Claude' }] });
    expect(schedule(input())).toMatchObject({ warnings: [] });
  });

  test('cancelled task values do not participate in validation or dependency constraints', () => {
    const i = input({ tasks: [task('1'), task('bad', { status: 'cancelled', est: 0, lo: NaN, hi: -1, fixStart: 'invalid', actStart: 'invalid' })],
      deps: [{ pred: 'bad', succ: '1', type: 'SS' }] });
    expect(schedule(i).project.n).toBe(1);
  });

  test('zero estimates and zero reported slots use P semantics without aborting the project', () => {
    const r = schedule(input({ tasks: [task('zero', { wbs: '1.1.1', est: 0, lo: 0, hi: 0 }), task('low-zero', { wbs: '1.1.2', lo: 0 })],
      concurrency: { total: 0, current: 0, subRatio: 0, Claude: 0, Codex: 0 } }));
    expect(taskSlots(0, 0)).toBe(1);
    expect(r.by['zero']?.mid).toEqual({ s: 0, e: 0 });
    expect(r.by['low-zero']?.optimistic.e).toBe(4);
    expect(r.project.total).toBe(4);
  });

  test('clips future actual start clock skew to now', () => {
    const r = schedule(input({ tasks: [task('skew', { status: 'running', actStart: '2026-11-03T03:00:01Z' })] }));
    expect(r.by['skew']?.start).toBe('2026-11-03');
    expect(r.by['skew']?.mid).toEqual({ s: 0, e: 2.6 });
  });

  test.each([
    { est: NaN }, { lo: -1 }, { hi: 1 }, { actStart: 'invalid' }, { status: 'done' as const },
    { actEnd: '2026-11-02T00:00:00Z' },
  ])('invalid Task is identified by structured error (%#)', patch => {
    let caught: unknown;
    try { schedule(input({ tasks: [task('broken-task', patch)] })); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RangeError);
    expect(caught).toMatchObject({ code: 'SCHEDULE_INVALID_TASK', taskIds: ['broken-task'] });
  });
});

describe('P2-1 four replan move kinds', () => {
  test.each(['start', 'lo', 'hi'] as const)('%s-only changes produce no moves', field => {
    const i = input(), b = baseline(i), item = b.items['1']; assert(item);
    item[field] = field === 'hi' ? '2026-12-01' : '2026-11-01';
    expect(replanDiff(b, schedule(i))).toEqual([]);
  });
});

describe('P2-2 policy inputs', () => {
  test('window and history threshold are supplied while defaults retain P values', () => {
    const i = { ...input(), now: '2026-11-05T15:00:00Z', sessions: [{ from: '2026-11-03T15:00:00Z', to: '2026-11-05T15:00:00Z' }] };
    expect(capacity(i)).toMatchObject({ enough: false, rate: 0.6 });
    expect(capacity({ ...i, policy: { windowDays: 2, minHours: 24 } })).toMatchObject({ enough: true, measured: 1, rate: 1 });
    expect(capacity({ ...i, policy: { windowDays: 2, minHours: 24 } }).days).toHaveLength(2);
  });

  test('floor and assumed low/high factors are configurable', () => {
    const floor = capacity({ ...input(), assumeRate: 0, policy: { minRate: 0.2, lowRateFactor: 0.5, highRateFactor: 1.5 } });
    expect(floor).toMatchObject({ rate: 0.2, rLo: 0.2 }); expect(floor.rHi).toBeCloseTo(0.3);
    const factors = capacity({ ...input(), policy: { lowRateFactor: 0.5, highRateFactor: 1.5 } });
    expect(factors).toMatchObject({ rate: 0.6, rLo: 0.3 }); expect(factors.rHi).toBeCloseTo(0.9);
  });

  test('observation quantiles are configurable and scale with the window', () => {
    const i = input({ now: '2026-11-09T15:00:00Z', sessions: Array.from({ length: 6 }, (_, n) => ({
      from: new Date(Date.parse('2026-11-03T15:00:00Z') + n * 86_400_000).toISOString(),
      to: new Date(Date.parse('2026-11-03T15:00:00Z') + n * 86_400_000 + (n + 1) / 10 * 86_400_000).toISOString(),
    })) });
    expect(capacity(i).rLo).toBeCloseTo(0.1); expect(capacity(i).rHi).toBeCloseTo(0.5);
    const extremes = capacity({ ...i, policy: { lowQuantile: 0, highQuantile: 1 } });
    expect(extremes.rLo).toBe(0.05); expect(extremes.rHi).toBeCloseTo(0.6);
  });

  test.each([
    { windowDays: 0 }, { windowDays: 1.5 }, { minHours: -1 }, { minRate: 0 }, { minRate: 2 },
    { lowRateFactor: -1 }, { highRateFactor: 0.5 }, { lowQuantile: -1 }, { highQuantile: 2 },
    { lowQuantile: 1, highQuantile: 0 },
  ])('rejects invalid capacity policy (%#)', policy => expect(() => capacity({ ...input(), policy })).toThrow(RangeError));

  test.each([{ intervalSec: 0, missLimit: 3 }, { intervalSec: 60, missLimit: 0 }, { intervalSec: 60, missLimit: 1.5 }])('rejects invalid heartbeat settings (%#)', heartbeat => {
    expect(() => capacity({ ...input(), heartbeat })).toThrow(RangeError);
  });

  test('per-task drift threshold padding is configurable', () => {
    const i = input(), b = baseline(i), item = b.items['1']; assert(item);
    item.end = '2026-11-02';
    expect(driftCheck(i, [b], { thresholdDays: 1, autoReplan: true }, meta)).toBeNull();
    expect(driftCheck(i, [b], { thresholdDays: 1, autoReplan: true, taskThresholdPaddingDays: 0 }, meta)?.status).toBe('applied');
  });
});

describe('P2-3 lower uptime cannot exceed middle uptime', () => {
  test('documents original P defect on one offline day and six 90% days', () => {
    const i = input({ now: '2026-11-09T15:00:00Z', sessions: Array.from({ length: 6 }, (_, n) => ({
      from: new Date(Date.parse('2026-11-03T15:00:00Z') + n * 86_400_000).toISOString(),
      to: new Date(Date.parse('2026-11-03T15:00:00Z') + n * 86_400_000 + 0.9 * 86_400_000).toISOString(),
    })) });
    const original = prototypeCapacity(i), actual = capacity(i);
    expect(original.rate).toBeCloseTo(5.4 / 7);
    expect(original.rLo).toBeCloseTo(0.9);
    expect(original.rLo).toBeGreaterThan(original.rate);
    expect(actual.rate).toBeCloseTo(original.rate);
    expect(actual.rLo).toBe(actual.rate);
    const r = schedule({ ...i, tasks: [task('1', { est: 100, lo: 100, hi: 100 })] });
    expect(r.project.hi >= r.project.end).toBe(true);
  });
});

describe('P2-4 regression sensitivity', () => {
  test('latest sparse baseline v3 is compared, and middle values/metadata are preserved', () => {
    const i = input({ tasks: [task('1', { est: 24, lo: 1, hi: 48 })] }), v3 = { ...baseline(i), v: 3 }, v1 = structuredClone(v3);
    v1.v = 1; v1.end = '2026-10-01';
    const item = v1.items['1']; assert(item); item.end = '2026-10-01';
    const r = replan(i, [v1, v3], meta), expected = schedule(i);
    expect(r).toMatchObject({ before: v3.end, after: expected.project.end, lo: expected.project.lo, hi: expected.project.hi,
      rate: expected.capacity.rate, moves: [], baseline: { v: 4, end: expected.project.end, rate: expected.capacity.rate, at: i.now, actor: meta.actor, trigger: meta.trigger } });
    expect(driftCheck(i, [v1, v3], { thresholdDays: 1, autoReplan: true }, meta)).toBeNull();
  });

  test('detects individual advancement at threshold+2 while project end is unchanged', () => {
    const i = input(), b = baseline(i), item = b.items['1']; assert(item); item.end = '2026-11-06';
    expect(driftCheck(i, [b], { thresholdDays: 1, autoReplan: true }, meta)?.moves[0]).toMatchObject({ kind: 'advanced', delta: -3 });
  });

  test('fixed start and reset crossing a partial blackout accumulate only actual working capacity', () => {
    const i = input({ blackouts: ['2026-11-03', '2026-11-04'], tasks: [task('fixed', { fixStart: '2026-11-06' }), task('reset', { assignee: 'Codex' })],
      usage: { Codex: { remain: 0, resetAt: '2026-11-05T03:00:00Z' } } });
    const r = schedule(i);
    expect(r.by['fixed']?.mid.s).toBeCloseTo(14.4);
    expect(r.by['reset']?.mid.s).toBeCloseTo(7.2);
    expect(r.by['fixed']?.start).toBe('2026-11-06');
    expect(r.by['reset']?.start).toBe('2026-11-05');
  });

  test('sorts sessions, excludes future records and clips closed intervals at now', () => {
    const i = input({ sessions: [{ from: '2026-11-02T15:00:00Z', to: '2026-11-04T15:00:00Z' },
      { from: '2026-10-20T15:00:00Z', to: '2026-10-21T15:00:00Z' }, { from: '2026-11-10T00:00:00Z' }] });
    const c = capacity(i);
    expect(c.logged).toBe(13 * 24 + 12);
    expect(c.enough).toBe(true); expect(c.todayRate).toBe(1); expect(c.measured).toBe(0);
    expect(capacity(input({ now: '2026-11-10T03:00:00Z', sessions: [{ from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' }] })).logged).toBe(0);
  });

  test('project range does not end before today when every Task already finished', () => {
    const r = schedule(input({ tasks: [task('1', { status: 'done', actStart: '2026-11-01T00:00:00Z', actEnd: '2026-11-01T01:00:00Z' })] }));
    expect(r.project).toMatchObject({ end: '2026-11-03', lo: '2026-11-03', hi: '2026-11-03' });
  });
});

describe('P2-5 cycle errors', () => {
  test('cycle reports code and involved Task IDs for contract mapping', () => {
    let caught: unknown;
    try { schedule(input({ tasks: [task('1'), task('2')], deps: [{ pred: '1', succ: '2', type: 'SS' }, { pred: '2', succ: '1', type: 'FS' }] })); }
    catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'SCHEDULE_CYCLE', taskIds: ['1', '2'] });
  });
});

describe('general zero-capacity start boundary', () => {
  test('slot/FS/SS releases at midnight and consecutive blackouts start on the next available day', () => {
    const i = input({ assumeRate: 1, tasks: [task('1', { est: 12, lo: 12, hi: 12 }), task('2'), task('3', { assignee: 'Codex' })],
      deps: [{ pred: '1', succ: '2', type: 'FS' }, { pred: '2', succ: '3', type: 'SS' }], blackouts: ['2026-11-04', '2026-11-05'] });
    const r = schedule(i);
    expect(r.by['1']?.end).toBe('2026-11-03');
    expect(r.by['2']?.start).toBe('2026-11-06'); expect(r.by['3']?.start).toBe('2026-11-06');
    expect(schedule(input({ usage: { Claude: { remain: 0, resetAt: '2026-11-03T15:00:00Z' } } })).by['1']?.start).toBe('2026-11-04');
  });
});
