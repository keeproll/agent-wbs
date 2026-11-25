import { calendar, date, finite, instant, ymd } from './calendar.ts';
import { STAGE_PCT } from './types.ts';
import type { Agent, EffectivePeriod, ScheduleInput, ScheduleItem, ScheduleResult, ScheduleTask } from './types.ts';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new RangeError('Missing schedule value');
  return value;
}

export function taskSlots(limit: number, subRatio: number): number {
  finite(limit, 1, 'session limit');
  finite(subRatio, 0, 'subagent ratio');
  return Math.max(1, Math.floor(limit / (1 + subRatio)));
}

export function capacity(input: Pick<ScheduleInput, 'now' | 'sessions' | 'assumeRate'>): ScheduleResult['capacity'] {
  const now = instant(input.now), today = Math.floor(now);
  finite(input.assumeRate, 0, 'assumed uptime', 1);
  const sessions = input.sessions.map(s => {
    const from = instant(s.from), to = s.to ? instant(s.to) : now;
    if (s.to && to < from) throw new RangeError('Runner session ends before it starts');
    return { from, to: Math.min(to, now) };
  }).filter(s => s.from <= now).sort((a, b) => a.from - b.from);
  const merged: typeof sessions = [];
  for (const s of sessions) {
    const prev = merged.at(-1);
    if (prev && s.from <= prev.to) prev.to = Math.max(prev.to, s.to);
    else merged.push({ ...s });
  }
  const onIn = (from: number, to: number) => merged.reduce((sum, s) => sum + Math.max(0, Math.min(to, s.to) - Math.max(from, s.from)), 0);
  const days = Array.from({ length: 7 }, (_, i) => ({ date: ymd(today - 7 + i), rate: onIn(today - 7 + i, today - 6 + i) }));
  const logged = sessions.length ? (now - required(sessions[0]).from) * 24 : 0;
  const enough = logged >= 72 - 1e-9;
  const measured = days.reduce((sum, d) => sum + d.rate, 0) / 7;
  const sorted = days.map(d => d.rate).sort((a, b) => a - b);
  const rate = Math.max(0.05, enough ? measured : input.assumeRate);
  return {
    days, logged, enough, measured, rate,
    rLo: Math.max(0.05, enough ? required(sorted[1]) : rate * 0.6),
    rHi: Math.max(rate, enough ? required(sorted[5]) : Math.min(1, rate * 1.3)),
    todayRate: onIn(today, now) / Math.max(1 / 1440, now - today),
  };
}

export function schedule(input: ScheduleInput): ScheduleResult {
  const now = instant(input.now), today = ymd(now), cap = capacity(input);
  const blackouts = new Set(input.blackouts.map(date));
  const tasks = new Map(input.tasks.map(t => [t.id, t]));
  if (tasks.size !== input.tasks.length) throw new RangeError('Duplicate task ID');
  for (const t of tasks.values()) {
    if (!t.id || !t.wbs || !Object.hasOwn(STAGE_PCT, t.status) || !['Claude', 'Codex'].includes(t.assignee)) throw new RangeError('Invalid task identity or state');
    finite(t.priority, 0, 'priority');
    finite(t.est, Number.MIN_VALUE, 'estimate'); finite(t.lo, Number.MIN_VALUE, 'optimistic estimate'); finite(t.hi, t.lo, 'pessimistic estimate');
    if (t.lo > t.est || t.est > t.hi) throw new RangeError('Expected lo <= est <= hi');
    if (t.fixStart) date(t.fixStart);
    if (t.actStart && instant(t.actStart) > now) throw new RangeError('Actual start is in the future');
    if (t.actEnd && (!t.actStart || instant(t.actEnd) < instant(t.actStart) || instant(t.actEnd) > now)) throw new RangeError('Invalid actual end');
    if (t.status === 'done' && (!t.actStart || !t.actEnd)) throw new RangeError('Completed task needs actual start and end');
  }
  const ids = input.tasks.filter(t => t.status !== 'cancelled').map(t => t.id);
  const preds = new Map(ids.map(id => [id, [] as ScheduleInput['deps'][number][]]));
  for (const dep of input.deps) {
    if (!tasks.has(dep.pred) || !tasks.has(dep.succ) || !['SS', 'FS'].includes(dep.type)) throw new RangeError('Invalid dependency');
    if (dep.pred === dep.succ) throw new RangeError('Self dependency');
    // Owner decision: cancelled predecessors no longer constrain the schedule.
    if (required(tasks.get(dep.pred)).status !== 'cancelled') preds.get(dep.succ)?.push(dep);
  }
  const c = input.concurrency;
  const poolN = taskSlots(Math.min(c.total, c.current), c.subRatio);
  const agentN = { Claude: taskSlots(c.Claude, c.subRatio), Codex: taskSlots(c.Codex, c.subRatio) };
  for (const u of Object.values(input.usage)) {
    finite(u.remain, 0, 'remaining usage', 100);
    if (u.resetAt) instant(u.resetAt);
    if (u.remain === 0 && !u.resetAt) throw new RangeError('Exhausted agent needs a reset timestamp');
  }
  const sim = (estimate: 'est' | 'lo' | 'hi', rate: number) => {
    const cal = calendar(now, rate, blackouts), pool = Array<number>(poolN).fill(0);
    const slots = new Map<Agent, number[]>(['Claude', 'Codex'].map(name => {
      const ag = name as Agent, u = input.usage[ag];
      return [ag, Array<number>(agentN[ag]).fill(u?.remain === 0 ? cal.effectiveAt(instant(required(u.resetAt))) : 0)];
    }));
    const groupEnd = new Map<string, number>(), out = new Map<string, EffectivePeriod>();
    const minI = (a: number[]) => a.indexOf(Math.min(...a));
    const place = (t: ScheduleTask, from: number, duration: number) => {
      const a = required(slots.get(t.assignee)), i = minI(a), pi = minI(pool);
      const s = Math.max(from, required(a[i]), required(pool[pi]), t.cg ? groupEnd.get(t.cg) ?? 0 : 0), e = s + duration;
      a[i] = e; pool[pi] = e;
      if (t.cg) groupEnd.set(t.cg, e);
      out.set(t.id, { s, e });
    };
    for (const id of ids) if (required(tasks.get(id)).status === 'done') out.set(id, { s: 0, e: 0 });
    for (const t of input.tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled' && t.actStart).sort((a, b) => instant(required(a.actStart)) - instant(required(b.actStart)))) {
      place(t, 0, t[estimate] * (1 - STAGE_PCT[t.status] / 100));
    }
    const left = ids.filter(id => !out.has(id));
    const release = (id: string) => {
      const t = required(tasks.get(id));
      let h = t.fixStart ? cal.effectiveAt(date(t.fixStart)) : 0;
      for (const dep of required(preds.get(id))) {
        const p = required(out.get(dep.pred));
        h = Math.max(h, dep.type === 'SS' ? p.s : p.e);
      }
      return h;
    };
    while (left.length) {
      const ready = left.filter(id => required(preds.get(id)).every(dep => out.has(dep.pred)));
      if (!ready.length) throw new RangeError('Dependency cycle prevents scheduling');
      // Same release-time, priority, numeric WBS ordering as prototype Sel.schedule.
      ready.sort((a, b) => release(a) - release(b) || required(tasks.get(a)).priority - required(tasks.get(b)).priority || required(tasks.get(a)).wbs.localeCompare(required(tasks.get(b)).wbs, 'en', { numeric: true }));
      const id = required(ready[0]), t = required(tasks.get(id));
      place(t, release(id), t[estimate]);
      left.splice(left.indexOf(id), 1);
    }
    return { out, cal };
  };
  const mid = sim('est', cap.rate), lo = sim('lo', cap.rHi), hi = sim('hi', cap.rLo);
  const entries: [string, ScheduleItem][] = [];
  let total = 0, weighted = 0, remain = 0, doneEst = 0, doneN = 0;
  let end = today, loEnd = today, hiEnd = today;
  for (const id of ids) {
    const t = required(tasks.get(id)), done = t.status === 'done', pct = STAGE_PCT[t.status];
    const m = required(mid.out.get(id)), l = required(lo.out.get(id)), h = required(hi.out.get(id));
    const start = t.actStart ? ymd(instant(t.actStart)) : mid.cal.dayAt(m.s, true);
    const finish = done ? ymd(instant(required(t.actEnd))) : mid.cal.dayAt(m.e);
    const le = done ? finish : lo.cal.dayAt(l.e), he = done ? finish : hi.cal.dayAt(h.e);
    entries.push([id, { start, end: finish, lo: le, hi: he, pct, done, mid: m, optimistic: l, pessimistic: h }]);
    total += t.est; weighted += t.est * pct / 100; remain += t.est * (1 - pct / 100);
    if (done) { doneEst += t.est; doneN++; }
    if (finish > end) end = finish;
    if (le > loEnd) loEnd = le;
    if (he > hiEnd) hiEnd = he;
  }
  return {
    by: Object.fromEntries(entries), capacity: cap,
    project: { end, lo: loEnd, hi: hiEnd, total, remain, progress: total ? weighted / total * 100 : 0,
      doneN, n: ids.length, doneRate: ids.length ? doneN / ids.length * 100 : 0, doneEstRate: total ? doneEst / total * 100 : 0 },
  };
}
