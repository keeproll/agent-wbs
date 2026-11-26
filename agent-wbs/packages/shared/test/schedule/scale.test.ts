/**
 * srv-perf: 대량 Task 일정 계산.
 * - 속도: 의존성이 거의 없는 1,000·5,000개 Task도 짧은 시간 안에 계산해야 한다(M3-02 보고 §4-1, 200개에 0.5초·1,000개에 7초).
 * - 결과 보존: 새 배치 반복은 이전 구현(reference.ts)과 같은 결과를 내야 한다. 무작위 입력 수백 개로 비교한다.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import type { TaskStatus } from '../../src/domain/index.ts';
import { schedule, ScheduleError, type ScheduleInput, type ScheduleTask } from '../../src/schedule/index.ts';
import { referenceSchedule } from './reference.ts';

/** 같은 씨앗이면 같은 수열을 내는 난수(mulberry32). 실패를 다시 만들 수 있게 한다. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = '2026-11-03T03:00:00Z';
const STATUSES: TaskStatus[] = ['planning', 'approval', 'ready', 'running', 'qa', 'verifying', 'rework', 'paused', 'failed', 'gate', 'done', 'cancelled'];

function generate(seed: number, n: number): ScheduleInput {
  const r = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(r() * items.length)] as T;
  const tasks: ScheduleTask[] = Array.from({ length: n }, (_, i) => {
    const status = pick(STATUSES);
    const lo = Math.floor(r() * 4), est = lo + Math.floor(r() * 6), hi = est + Math.floor(r() * 6);
    // WBS는 일부러 같은 값·앞자리 0(「1.01」과 「1.1」은 숫자 비교로 같다)·자리 수가 다른 값을 섞는다.
    const wbs = pick([`1.${String(1 + (i % 3))}.${String(1 + Math.floor(r() * 12))}`, `1.0${String(1 + (i % 3))}.${String(i)}`, `${String(1 + (i % 2))}.${String(1 + (i % 4))}.${String(i % 7)}`, 'T']);
    const started = ['running', 'qa', 'verifying', 'rework', 'paused', 'failed', 'gate', 'done'].includes(status) && r() < 0.8;
    const actStart = status === 'done' || started ? new Date(Date.parse(NOW) - Math.floor(r() * 200) * 3_600_000).toISOString() : undefined;
    const actEnd = status === 'done' && actStart ? new Date(Math.min(Date.parse(NOW), Date.parse(actStart) + Math.floor(r() * 30) * 3_600_000)).toISOString() : undefined;
    return {
      id: `T${String(i)}`, wbs, status, priority: Math.floor(r() * 4), assignee: r() < 0.5 ? 'Claude' : 'Codex', est, lo, hi,
      ...(r() < 0.15 ? { cg: `g${String(Math.floor(r() * 3))}` } : {}),
      ...(r() < 0.15 ? { fixStart: `2026-11-${String(3 + Math.floor(r() * 20)).padStart(2, '0')}` } : {}),
      ...(actStart ? { actStart } : {}), ...(actEnd ? { actEnd } : {}),
    };
  });
  // 의존성은 앞 번호 → 뒤 번호라 순환이 없다. 씨앗이 3의 배수면 순환 하나를 일부러 넣는다.
  const deps: { pred: string; succ: string; type: 'FS' | 'SS' }[] = [];
  const seen = new Set<string>();
  const density = r() * 2;
  for (let k = 0; k < Math.floor(n * density); k++) {
    const a = Math.floor(r() * n), b = Math.floor(r() * n);
    if (a === b) continue;
    const [pred, succ] = a < b ? [a, b] : [b, a];
    const key = `${String(pred)}>${String(succ)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deps.push({ pred: `T${String(pred)}`, succ: `T${String(succ)}`, type: r() < 0.7 ? 'FS' : 'SS' });
  }
  if (seed % 3 === 0 && n > 3) deps.push({ pred: `T${String(n - 1)}`, succ: 'T0', type: 'FS' }, { pred: 'T0', succ: `T${String(n - 1)}`, type: 'FS' });
  return {
    now: NOW, tasks, deps, sessions: [], assumeRate: 0.6,
    blackouts: r() < 0.5 ? ['2026-11-05', '2026-11-08'] : [],
    concurrency: { total: 1 + Math.floor(r() * 4), current: 1 + Math.floor(r() * 4), subRatio: pick([0, 0.5, 1]), Claude: 1 + Math.floor(r() * 2), Codex: 1 + Math.floor(r() * 2) },
    usage: r() < 0.3 ? { Claude: { remain: 0, resetAt: '2026-11-04T00:00:00Z' } } : {},
  };
}

const outcome = (fn: (input: ScheduleInput) => unknown, input: ScheduleInput) => {
  try {
    return { ok: fn(input) };
  } catch (error) {
    if (error instanceof ScheduleError) return { error: error.code, taskIds: error.taskIds };
    if (error instanceof RangeError) return { range: error.message };
    throw error;
  }
};

describe('schedule 결과 보존(이전 구현과 대조)', () => {
  test('무작위 입력 400개(Task 0~60개, 의존성 밀도·동률·고정 시작일·순환 포함)에서 결과와 오류가 같다', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const input = generate(seed, seed % 61);
      expect(outcome(schedule, input), `seed ${String(seed)}`).toEqual(outcome(referenceSchedule, input));
    }
  });

  test('의존성 없는 300개 Task(모두 대기·같은 우선순위)에서도 같다', () => {
    const input = generate(7, 300);
    input.deps = [];
    input.tasks = input.tasks.map(({ actStart, actEnd, ...rest }): ScheduleTask => {
      void actStart; void actEnd;
      return { ...rest, status: 'planning', priority: 2 };
    });
    expect(schedule(input)).toEqual(referenceSchedule(input));
  });
});

describe('schedule 대량 계산 속도', () => {
  const flat = (n: number): ScheduleInput => ({
    now: NOW, sessions: [], assumeRate: 0.6, blackouts: [], usage: {}, deps: [],
    concurrency: { total: 2, current: 2, subRatio: 0, Claude: 1, Codex: 1 },
    // M3-02 측정과 같은 모양: 추정 0, 의존성 없음, 모두 계획 중.
    tasks: Array.from({ length: n }, (_, i) => ({ id: `TASK-${String(i)}`, wbs: `1.${String(1 + (i % 5))}.${String(i)}`, status: 'planning', priority: 2, assignee: 'Claude', est: 0, lo: 0, hi: 0 })),
  });

  test('의존성 없는 1,000개 Task를 0.3초 안에 계산한다', () => {
    const input = flat(1000);
    const started = performance.now();
    const result = schedule(input);
    const ms = performance.now() - started;
    console.info(`schedule 1,000 Tasks / 의존성 없음: ${ms.toFixed(1)}ms`);
    expect(Object.keys(result.by)).toHaveLength(1000);
    expect(ms).toBeLessThan(300);
  });

  test('5,000개 Task(의존성 약 5,000개)를 1초 안에 계산한다', () => {
    const input = generate(11, 5000);
    const started = performance.now();
    schedule(input);
    const ms = performance.now() - started;
    console.info(`schedule 5,000 Tasks: ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(1000);
  });
});
