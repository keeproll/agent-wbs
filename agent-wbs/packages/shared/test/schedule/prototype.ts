import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { ScheduleInput } from '../../src/schedule/index.ts';

export function prototypeCapacity(input: ScheduleInput) {
  const source = readFileSync(new URL('../../../../../prototype/uiux/Main.dc.html', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('  capacity(d, now) {'), source.indexOf('  /* 일정 산정:'));
  const cal = source.slice(source.indexOf('function pad2'), source.indexOf('function attHours'));
  const local = (value: string) => new Date(Date.parse(value) + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
  return runInNewContext(`${cal}\nconst Sel = {${method}}; Sel.capacity(d, now);`, {
    now: local(input.now), d: { sched: { policy: { assumeRate: input.assumeRate } },
      runner: { sessions: input.sessions.map(s => ({ from: local(s.from), to: s.to ? local(s.to) : '' })) } },
  }, { timeout: 2000 }) as { rate: number; rLo: number; rHi: number };
}

// Execute the actual prototype methods and demo values, rather than maintaining a copied oracle.
export function prototypeDemo() {
  const source = readFileSync(new URL('../../../../../prototype/uiux/Main.dc.html', import.meta.url), 'utf8');
  const section = (from: string, to: string) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    if (start < 0 || end < 0) throw new Error(`Prototype section missing: ${from}`);
    return source.slice(start, end);
  };
  return runInNewContext([
    section('const MOCK =', '\n\n/* 데이터 접근'),
    section('function pad2', 'function attHours'),
    section('const SCHED_MOCK =', 'const ATT_TOK ='),
    section('const RUNNER_MOCK =', '/* Runner가 보고한'),
    section('const Sel =', '\n};') + '\n};',
    section('    d.conc = {mode:', ';\n    const CG').replace('d.conc =', 'const conc =') + ';',
    section('    const CG =', '\n    Object.keys(d.tasks).forEach(id => { d.tasks[id].cg'),
    section('    d.sched = { policy:', '\n    /* 기준 v1').replace('d.sched =', 'const sched ='),
    `
      const d = {...MOCK, conc, sched, runner:RUNNER_MOCK, usage:RUNNER_MOCK.usage};
      for (const [id, t] of Object.entries(d.tasks)) Object.assign(t, SCHED_MOCK[id], {cg:CG[id] || ''});
      const now = '2026-11-03 22:10', expected = Sel.schedule(d, now), n = Sel.numbers(d).task;
      const iso = s => s ? new Date(s.replace(' ', 'T') + ':00+09:00').toISOString() : undefined;
      ({
        stage:STAGE_PCT, expected,
        input:{now:iso(now), tasks:Object.values(d.tasks).map(t => ({...t, wbs:n[t.id], actStart:iso(t.actStart), actEnd:iso(t.actEnd)})),
          deps:d.deps, sessions:d.runner.sessions.map(s => ({from:iso(s.from), to:iso(s.to), lastHeartbeatAt:iso(now)})),
          assumeRate:sched.policy.assumeRate, blackouts:sched.blackouts.map(b => b.date),
          concurrency:{total:conc.cap.total, current:conc.cur, subRatio:conc.subRatio, Claude:conc.cap.Claude, Codex:conc.cap.Codex},
          usage:Object.fromEntries(Object.entries(d.usage).map(([ag,u]) => [ag,{remain:u.remain, resetAt:iso(u.reset)}]))}
      });
    `,
  ].join('\n'), {}, { timeout: 2000 }) as {
    input: ScheduleInput;
    stage: Record<string, number>;
    expected: {
      by: Record<string, { fs: number; fe: number; le: number; he: number; pct: number; midE: { s: number; e: number } }>;
      cap: { rate: number; rLo: number; rHi: number };
      p: { total: number; remain: number; progress: number; doneN: number; n: number; doneRate: number; doneEstRate: number; fEnd: number; loEnd: number; hiEnd: number };
    };
  };
}
