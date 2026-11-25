import { date, finite } from './calendar.ts';
import { schedule } from './schedule.ts';
import type { Baseline, ReplanMove, ReplanResult, ScheduleInput, ScheduleResult } from './types.ts';

export function replanDiff(previous: Baseline | undefined, result: ScheduleResult): ReplanMove[] {
  const moves: ReplanMove[] = [];
  for (const [task, item] of Object.entries(result.by)) {
    const before = previous?.items[task] ?? null;
    const after = { start: item.start, end: item.end, lo: item.lo, hi: item.hi };
    const delta = before ? date(after.end) - date(before.end) : null;
    if (!before || before.start !== after.start || before.end !== after.end || before.lo !== after.lo || before.hi !== after.hi) {
      moves.push({ task, before, after, delta, kind: delta === null ? 'new' : delta > 0 ? 'delayed' : delta < 0 ? 'advanced' : 'shifted' });
    }
  }
  if (previous) for (const [task, before] of Object.entries(previous.items)) {
    if (!Object.hasOwn(result.by, task)) moves.push({ task, before, after: null, delta: null, kind: 'excluded' });
  }
  return moves;
}

export function replan(input: ScheduleInput, baselines: readonly Baseline[], meta: { trigger: string; actor: string; autoReplan: boolean; manual?: boolean }): ReplanResult {
  const result = schedule(input), prev = baselines.at(-1), p = result.project;
  const applied = meta.autoReplan || meta.manual === true;
  return {
    status: applied ? 'applied' : 'pending', at: input.now, trigger: meta.trigger, actor: meta.actor,
    before: prev?.end ?? null, after: p.end, lo: p.lo, hi: p.hi, rate: result.capacity.rate,
    moves: replanDiff(prev, result),
    baseline: applied ? {
      v: (prev?.v ?? 0) + 1, at: input.now, trigger: meta.trigger, actor: meta.actor,
      rate: result.capacity.rate, rLo: result.capacity.rLo, rHi: result.capacity.rHi,
      end: p.end, lo: p.lo, hi: p.hi,
      items: Object.fromEntries(Object.entries(result.by).map(([id, item]) => [id, { start: item.start, end: item.end, lo: item.lo, hi: item.hi }])),
    } : null,
  };
}

export function driftCheck(input: ScheduleInput, baselines: readonly Baseline[], policy: { thresholdDays: number; autoReplan: boolean }, meta: { trigger: string; actor: string }): ReplanResult | null {
  finite(policy.thresholdDays, 0, 'drift threshold');
  const result = schedule(input), prev = baselines.at(-1);
  const drifted = !prev || Math.abs(date(result.project.end) - date(prev.end)) >= policy.thresholdDays ||
    Object.entries(result.by).some(([id, item]) => !item.done && prev.items[id] && Math.abs(date(item.end) - date(prev.items[id].end)) >= policy.thresholdDays + 2);
  return drifted ? replan(input, baselines, { ...meta, autoReplan: policy.autoReplan }) : null;
}
