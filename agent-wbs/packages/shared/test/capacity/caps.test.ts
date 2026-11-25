import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DEFAULT_MEM_RESERVE_GB, effectiveCaps, recommendedCaps } from '../../src/capacity/index.ts';
import type { HostSpec } from '../../src/capacity/index.ts';
import { loadPrototype } from '../grade/prototype.ts';

const G = readFileSync(
  new URL('../../../../../prototype/docs/Agent-WBS-설계의도-및-구현가이드.md', import.meta.url),
  'utf8',
);
const host = (o: Partial<HostSpec> = {}): HostSpec => ({ cores: 20, memGb: 23, diskGb: 952, perSessionGb: null, ...o });
const caps = (o: Partial<HostSpec>, reserve = DEFAULT_MEM_RESERVE_GB) => recommendedCaps(host(o), reserve).caps;

/** §6.6 예시 표를 원본에서 읽는다. */
const examples = G.split('\n').flatMap((l) => {
  const m = /^\| [^|]+ \| [^|]*?(\d+)코어 · (?:WSL 메모리 )?(\d+)GB \| (\d+) · (\d+) · (\d+)/.exec(l);
  return m ? [m.slice(1).map(Number) as [number, number, number, number, number]] : [];
});

test('원본 §6.6 예시는 3개이고 값이 이 작업의 기준과 같다', () => {
  expect(examples).toEqual([[20, 23, 16, 12, 6], [12, 8, 2, 2, 2], [32, 56, 49, 37, 10]]);
});
test.each(examples)('%i코어 %iGB → %i · %i · %i', (cores, memGb, total, agent, heavy) => {
  expect(caps({ cores, memGb })).toEqual({ total, perAgent: { Claude: agent, Codex: agent }, heavy });
});

describe('공식 경계', () => {
  test('전체는 2 ~ 64', () => {
    expect(caps({ memGb: 4 }).total).toBe(2);
    expect(caps({ memGb: 71 }).total).toBe(64);
    expect(caps({ memGb: 512 }).total).toBe(64);
  });
  test('예비·관측 세션 메모리를 반영한다', () => {
    expect(caps({}, 6).total).toBe(14);
    expect(caps({ perSessionGb: 2 }).total).toBe(8);
    expect(caps({ memGb: 7.6, perSessionGb: 0.2 }).total).toBe(3); // 0.6/0.2 부동소수
  });
  test('Agent별은 올림, 무거운 작업은 전체 이하', () => {
    expect(caps({ memGb: 12 }).perAgent.Claude).toBe(4); // ceil(5 × 0.75)
    expect(caps({ memGb: 12, cores: 64 }).heavy).toBe(5);
    expect(caps({ memGb: 200, cores: 96 }).heavy).toBe(32); // G 공식에는 P의 16 상한이 없다
  });
  test('경고', () => {
    const w = (o: Partial<HostSpec>) => recommendedCaps(host(o), 4).warnings;
    expect(w({})).toEqual([]);
    expect(w({ memGb: 8, diskGb: 49 })).toEqual(['DISK_LOW', 'MEMORY_TIGHT']);
    expect(w({ memGb: 9, diskGb: 50 })).toEqual([]);
    expect(w({ cores: 2 })).toEqual(['HEAVY_ZERO']);
  });
  test.each([{ perSessionGb: 0 }, { memGb: NaN }, { cores: 0 }, { memGb: -1 }])('잘못된 보고 %o는 거부', (o) => {
    expect(() => caps(o)).toThrow(RangeError);
  });
});

test('프로토타입 recCap과 같다 (P만의 보정이 걸리지 않는 범위: 3~50코어·전체 무거운 작업 16 이하)', () => {
  const P = loadPrototype();
  for (let cores = 3; cores <= 50; cores++) {
    for (let memGb = 4; memGb <= 96; memGb += 4) {
      for (const perSessionGb of [0.5, 1, 1.4]) {
        const h = host({ cores, memGb, perSessionGb, diskGb: 40 });
        const p = P.recCap({ host: { memGB: memGb, cores, diskGB: 40, perSessGB: perSessionGb }, conc: { cap: { memGB: 4 } } });
        const m = recommendedCaps(h, 4);
        expect(m.caps).toEqual({ total: p.total, perAgent: { Claude: p.Claude, Codex: p.Codex }, heavy: p.heavy });
        expect(m.warnings).toHaveLength(p.warn.length);
      }
    }
  }
});

test('자동은 권장값, 직접 지정은 팀장 값을 유지하고 초과 항목만 경고', () => {
  const rec = caps({});
  const manual = { total: 20, perAgent: { Claude: 12, Codex: 13 }, heavy: 2 };
  expect(effectiveCaps('auto', manual, rec)).toEqual({ caps: rec, overruns: [] });
  expect(effectiveCaps('manual', manual, rec)).toEqual({
    caps: manual,
    overruns: [{ key: 'total', set: 20, recommended: 16 }, { key: 'Codex', set: 13, recommended: 12 }],
  });
});
