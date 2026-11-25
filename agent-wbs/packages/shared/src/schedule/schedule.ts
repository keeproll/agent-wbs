import { calendar, date, finite, instant, ymd } from './calendar.ts';
import { ScheduleError } from './errors.ts';
import { DEFAULT_SCHEDULE_CAPACITY_POLICY, STAGE_PCT } from './types.ts';
import type { Agent, EffectivePeriod, ScheduleInput, ScheduleItem, ScheduleResult, ScheduleTask, ScheduleWarning } from './types.ts';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new RangeError('Missing schedule value');
  return value;
}

export function taskSlots(limit: number, subRatio: number): number {
  finite(limit, 0, 'session limit');
  finite(subRatio, 0, 'subagent ratio');
  return Math.max(1, Math.floor(limit / (1 + subRatio)));
}

export function capacity(input: Pick<ScheduleInput, 'now' | 'sessions' | 'assumeRate' | 'policy' | 'heartbeat'>): ScheduleResult['capacity'] {
  const now = instant(input.now), today = Math.floor(now);
  const p = { ...DEFAULT_SCHEDULE_CAPACITY_POLICY, ...input.policy };
  finite(p.windowDays, 1, 'observation window');
  if (!Number.isSafeInteger(p.windowDays)) throw new RangeError('Observation window must be an integer');
  finite(p.minHours, 0, 'minimum history'); finite(p.minRate, Number.MIN_VALUE, 'minimum rate', 1);
  finite(p.lowRateFactor, 0, 'low rate factor', 1); finite(p.highRateFactor, 1, 'high rate factor');
  finite(p.lowQuantile, 0, 'low quantile', 1); finite(p.highQuantile, p.lowQuantile, 'high quantile', 1);
  const heartbeat = input.heartbeat ?? { intervalSec: 60, missLimit: 3 };
  finite(heartbeat.intervalSec, Number.MIN_VALUE, 'heartbeat interval');
  finite(heartbeat.missLimit, 1, 'missed heartbeat limit');
  if (!Number.isSafeInteger(heartbeat.missLimit)) throw new RangeError('Missed heartbeat limit must be an integer');
  finite(input.assumeRate, 0, 'assumed uptime', 1);
  const warnings: ScheduleWarning[] = [];
  const sessions = input.sessions.map(s => {
    const from = instant(s.from);
    let to = s.to ? instant(s.to) : now;
    if (from > now) return { from, to };
    if (!s.to) {
      const reported = s.lastHeartbeatAt ?? s.from, lastDay = instant(reported);
      const last = lastDay < from ? s.from : lastDay > now ? input.now : reported;
      if (last !== reported) warnings.push({ code: 'CLOCK_SKEW_CLAMPED', sessionFrom: s.from, field: 'lastHeartbeatAt', before: reported, after: last });
      if (Date.parse(input.now) - Date.parse(last) >= heartbeat.intervalSec * heartbeat.missLimit * 1000) to = instant(last);
    }
    const end = Math.max(from, Math.min(to, now));
    if (end !== to) warnings.push({ code: 'CLOCK_SKEW_CLAMPED', sessionFrom: s.from, field: 'to', before: s.to ?? input.now, after: end === from ? s.from : input.now });
    return { from, to: end };
  }).filter(s => s.from <= now).sort((a, b) => a.from - b.from);
  const merged: typeof sessions = [];
  for (const s of sessions) {
    const prev = merged.at(-1);
    if (prev && s.from <= prev.to) prev.to = Math.max(prev.to, s.to);
    else merged.push({ ...s });
  }
  const onIn = (from: number, to: number) => merged.reduce((sum, s) => sum + Math.max(0, Math.min(to, s.to) - Math.max(from, s.from)), 0);
  const days = Array.from({ length: p.windowDays }, (_, i) => ({ date: ymd(today - p.windowDays + i), rate: onIn(today - p.windowDays + i, today - p.windowDays + i + 1) }));
  const logged = sessions.length ? (now - required(sessions[0]).from) * 24 : 0;
  const enough = logged >= p.minHours - 1e-9;
  const measured = days.reduce((sum, d) => sum + d.rate, 0) / p.windowDays;
  const sorted = days.map(d => d.rate).sort((a, b) => a - b);
  const rate = Math.max(p.minRate, enough ? measured : input.assumeRate);
  return {
    days, logged, enough, measured, rate, warnings,
    rLo: Math.min(rate, Math.max(p.minRate, enough ? required(sorted[Math.floor((sorted.length - 1) * p.lowQuantile)]) : rate * p.lowRateFactor)),
    rHi: Math.max(rate, enough ? required(sorted[Math.floor((sorted.length - 1) * p.highQuantile)]) : Math.min(1, rate * p.highRateFactor)),
    todayRate: onIn(today, now) / Math.max(1 / 1440, now - today),
  };
}

export function schedule(input: ScheduleInput): ScheduleResult {
  const now = instant(input.now), today = ymd(now), cap = capacity(input);
  const warnings = [...cap.warnings];
  const blackouts = new Set(input.blackouts.map(date));
  const tasks = new Map<string, ScheduleTask>();
  const cancelled = new Set(input.tasks.filter(t => t.status === 'cancelled').map(t => t.id));
  for (const original of input.tasks) {
    if (original.status === 'cancelled') continue;
    let t = original;
    try {
      if (!t.id || !t.wbs || !Object.hasOwn(STAGE_PCT, t.status) || !['Claude', 'Codex'].includes(t.assignee)) throw new RangeError('Invalid task identity or state');
      if (tasks.has(t.id)) throw new RangeError('Duplicate task ID');
      finite(t.priority, 0, 'priority');
      finite(t.est, 0, 'estimate'); finite(t.lo, 0, 'optimistic estimate'); finite(t.hi, t.lo, 'pessimistic estimate');
      if (t.lo > t.est || t.est > t.hi) throw new RangeError('Expected lo <= est <= hi');
      if (t.fixStart) date(t.fixStart);
      if (t.actStart && instant(t.actStart) > now) {
        warnings.push({ code: 'CLOCK_SKEW_CLAMPED', taskId: t.id, field: 'actStart', before: t.actStart, after: input.now });
        t = { ...t, actStart: input.now };
      }
      if (t.actEnd && instant(t.actEnd) > now) {
        warnings.push({ code: 'CLOCK_SKEW_CLAMPED', taskId: t.id, field: 'actEnd', before: t.actEnd, after: input.now });
        t = { ...t, actEnd: input.now };
      }
      if (t.actEnd && (!t.actStart || instant(t.actEnd) < instant(t.actStart))) throw new RangeError('Invalid actual end');
      if (t.status === 'done' && (!t.actStart || !t.actEnd)) throw new RangeError('Completed task needs actual start and end');
    } catch (error) {
      if (error instanceof RangeError) throw new ScheduleError('SCHEDULE_INVALID_TASK', error.message, [t.id]);
      throw error;
    }
    tasks.set(t.id, t);
  }
  const ids = [...tasks.keys()];
  const preds = new Map(ids.map(id => [id, [] as ScheduleInput['deps'][number][]]));
  for (const dep of input.deps) {
    // Owner decision: cancelled predecessors no longer constrain the schedule.
    if (cancelled.has(dep.pred) || cancelled.has(dep.succ)) continue;
    if (!tasks.has(dep.pred) || !tasks.has(dep.succ) || !['SS', 'FS'].includes(dep.type)) throw new RangeError('Invalid dependency');
    if (dep.pred === dep.succ) throw new ScheduleError('SCHEDULE_CYCLE', 'Self dependency', [dep.pred]);
    preds.get(dep.succ)?.push(dep);
  }
  const c = input.concurrency;
  finite(c.total, 0, 'total concurrency'); finite(c.current, 0, 'current concurrency');
  const poolN = taskSlots(Math.min(c.total, c.current), c.subRatio);
  const agentN = { Claude: taskSlots(c.Claude, c.subRatio), Codex: taskSlots(c.Codex, c.subRatio) };
  for (const ag of ['Claude', 'Codex'] as const) {
    const u = input.usage[ag];
    if (!u) continue;
    finite(u.remain, 0, 'remaining usage', 100);
    if (u.resetAt) instant(u.resetAt);
    if (u.remain === 0 && !u.resetAt) warnings.push({ code: 'USAGE_RESET_UNKNOWN', agent: ag });
  }
  const sim = (estimate: 'est' | 'lo' | 'hi', rate: number) => {
    const cal = calendar(now, rate, blackouts), pool = Array<number>(poolN).fill(0);
    const slots = new Map<Agent, number[]>(['Claude', 'Codex'].map(name => {
      const ag = name as Agent, u = input.usage[ag];
      return [ag, Array<number>(agentN[ag]).fill(u?.remain === 0 && u.resetAt ? cal.effectiveAt(instant(u.resetAt)) : 0)];
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
    for (const t of [...tasks.values()].filter(t => t.status !== 'done' && t.actStart).sort((a, b) => instant(required(a.actStart)) - instant(required(b.actStart)))) {
      place(t, 0, (t[estimate] || t.est) * (1 - STAGE_PCT[t.status] / 100));
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
      if (!ready.length) throw new ScheduleError('SCHEDULE_CYCLE', 'Dependency cycle prevents scheduling', left);
      // Same release-time, priority, numeric WBS ordering as prototype Sel.schedule.
      ready.sort((a, b) => release(a) - release(b) || required(tasks.get(a)).priority - required(tasks.get(b)).priority || required(tasks.get(a)).wbs.localeCompare(required(tasks.get(b)).wbs, 'en', { numeric: true }));
      const id = required(ready[0]), t = required(tasks.get(id));
      place(t, release(id), t[estimate] || t.est);
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
    const finish = done ? ymd(instant(required(t.actEnd))) : mid.cal.dayAt(m.e, m.s === m.e);
    const le = done ? finish : lo.cal.dayAt(l.e, l.s === l.e), he = done ? finish : hi.cal.dayAt(h.e, h.s === h.e);
    entries.push([id, { start, end: finish, lo: le, hi: he, pct, done, mid: m, optimistic: l, pessimistic: h }]);
    total += t.est; weighted += t.est * pct / 100; remain += t.est * (1 - pct / 100);
    if (done) { doneEst += t.est; doneN++; }
    if (finish > end) end = finish;
    if (le > loEnd) loEnd = le;
    if (he > hiEnd) hiEnd = he;
  }
  return {
    by: Object.fromEntries(entries), capacity: cap, warnings,
    project: { end, lo: loEnd, hi: hiEnd, total, remain, progress: total ? weighted / total * 100 : 0,
      doneN, n: ids.length, doneRate: ids.length ? doneN / ids.length * 100 : 0, doneEstRate: total ? doneEst / total * 100 : 0 },
  };
}
