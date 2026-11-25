import { describe, expect, test } from 'vitest';
import { concurrency, memoryPressure, parallelWidth } from '../../src/capacity/index.ts';
import { loadPrototype } from '../grade/prototype.ts';

const t = (taskKey: string, conflictGroup: string | null = null) => ({ taskKey, conflictGroup });

describe('병렬 가능한 Task', () => {
  test('실행 중인 충돌 묶음의 Task는 대기로 빠진다', () => {
    expect(parallelWidth({ running: [t('A', 'db')], startable: [t('B', 'db'), t('C'), t('D', 'fe')] })).toEqual({
      width: 3, conflictWaits: [{ taskKey: 'B', conflictGroup: 'db', by: 'A' }],
    });
  });
  test('아직 실행 전이어도 같은 묶음은 하나만 센다', () => {
    expect(parallelWidth({ running: [], startable: [t('A', 'db'), t('B', 'db'), t('C'), t('D')] })).toEqual({ width: 3, conflictWaits: [] });
  });
  test('실행 중인 Task 자신은 두 번 세지 않는다', () => {
    expect(parallelWidth({ running: [t('A', 'db')], startable: [t('A', 'db')] })).toEqual({ width: 1, conflictWaits: [] });
  });
});

describe('제한 요인', () => {
  const c = (capTotal: number, runnerLimit: number, width: number, subRatio = 0.5) => concurrency({ capTotal, runnerLimit, width, subRatio });
  test.each([
    [8, 10, 20, 'cap', 8, true],
    [16, 10, 20, 'runner_limit', 10, false],
    [16, 10, 4, 'parallel_tasks', 6, false],
    [49, 40, 2, 'parallel_tasks', 3, false], // 고사양 PC에서도 일이 적으면 상한은 소용없다
    [10, 10, 20, 'cap', 10, false],
    [16, 6, 4, 'runner_limit', 6, false],
    [16, 10, 0, 'parallel_tasks', 0, false],
  ] as const)('상한 %i · Runner %i · 병렬 %i → %s, %d', (cap, lim, width, factor, expected, helps) => {
    expect(c(cap, lim, width)).toEqual({ limit: Math.min(cap, lim), expected, factor, raisingCapHelps: helps });
  });

  test('프로토타입 conc의 한도·요인과 같다', () => {
    const P = loadPrototype();
    const label = { cap: '팀장 상한', runner_limit: 'Runner 조절 한도', parallel_tasks: '병렬 가능한 Task 수' };
    for (const total of [2, 6, 16]) {
      for (const cur of [2, 6, 10]) {
        for (let n = 0; n < 14; n++) {
          const tasks = Object.fromEntries(Array.from({ length: n }, (_, i) => [`T${String(i)}`, { status: 'ready', cg: '' }]));
          const p = P.conc({ attempts: [], tasks, conc: { cap: { total, memGB: 4 }, cur, subRatio: 0.5, res: { memTotal: 23, memUsed: 9, swap: 0 } } });
          const m = c(total, cur, p.width);
          expect([m.limit, label[m.factor]]).toEqual([p.lim, p.factor]);
        }
      }
    }
  });
});

test('자원 압박: 예비 미만 또는 swap 사용', () => {
  expect(memoryPressure(4, 0, 4)).toBe(false);
  expect(memoryPressure(3.9, 0, 4)).toBe(true);
  expect(memoryPressure(10, 0.1, 4)).toBe(true);
});
