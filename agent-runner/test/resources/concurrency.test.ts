import { describe, expect, test } from 'vitest';
import { AdaptiveLimiter, LIMIT_REASON, admit, memoryPressure, reservedSlots } from '../../src/resources/concurrency.ts';

const MIN = 60_000;
const calm = { memFreeGB: 10, swapUsedGB: 0, memReserveGB: 4 };

function started(total: number, now = 0): AdaptiveLimiter {
  const l = new AdaptiveLimiter();
  l.applyCaps(total, { restart: true }, now);
  return l;
}

describe('AdaptiveLimiter — G §6.6 Runner 조절 규칙', () => {
  test('상한을 받기 전에는 한도가 없다(새 실행 불가)', () => {
    expect(new AdaptiveLimiter().limit).toBeNull();
  });

  test('시작값은 6과 상한 중 작은 값이고 첫 시작은 조절 기록이 아니다', () => {
    const big = new AdaptiveLimiter();
    expect(big.applyCaps(16, { restart: true }, 0)).toBeNull();
    expect(big.limit).toBe(6);
    expect(started(2).limit).toBe(2);
  });

  test('자원 여유·오류 없음이 10분 유지되면 +2, 상한을 넘지 않는다', () => {
    const l = started(9);
    expect(l.observe(10 * MIN - 1, calm)).toBeNull();
    expect(l.observe(10 * MIN, calm)).toEqual({ from: 6, to: 8, reason: LIMIT_REASON.stable });
    expect(l.observe(15 * MIN, calm)).toBeNull();
    expect(l.observe(20 * MIN, calm)).toEqual({ from: 8, to: 9, reason: LIMIT_REASON.stable });
    expect(l.observe(30 * MIN, calm)).toBeNull();
    expect(l.limit).toBe(9);
  });

  test('메모리 여유 < 예비면 25% 감소·새 실행 보류, 압박이 이어지는 동안 거듭 줄이지 않는다', () => {
    const l = started(16);
    const tight = { ...calm, memFreeGB: 3.9 };
    expect(l.observe(MIN, tight)).toEqual({ from: 6, to: 4, reason: LIMIT_REASON.memory });
    expect(l.holdNew).toBe(true);
    expect(l.observe(2 * MIN, tight)).toBeNull();
    expect(l.limit).toBe(4);
  });

  test('swap 사용도 압박이다', () => {
    const l = started(16);
    expect(l.observe(MIN, { ...calm, swapUsedGB: 0.1 })?.reason).toBe(LIMIT_REASON.memory);
    expect(l.holdNew).toBe(true);
  });

  test('압박이 풀리면 보류를 풀고, 그때부터 10분을 다시 센다', () => {
    const l = started(16);
    l.observe(9 * MIN, { ...calm, memFreeGB: 1 });
    expect(l.observe(11 * MIN, calm)).toBeNull();
    expect(l.holdNew).toBe(false);
    expect(l.observe(20 * MIN, calm)).toBeNull();
    expect(l.observe(21 * MIN, calm)).toEqual({ from: 4, to: 6, reason: LIMIT_REASON.stable });
  });

  test('감소해도 한도는 1 아래로 내려가지 않는다', () => {
    const l = started(1);
    expect(l.observe(MIN, { ...calm, memFreeGB: 0 })).toBeNull();
    expect(l.limit).toBe(1);
    expect(l.holdNew).toBe(true);
  });

  test('429가 연속 2회면 50% 감소, 사이에 성공하면 연속이 끊긴다', () => {
    const l = started(16);
    expect(l.rateLimited(MIN)).toBeNull();
    l.succeeded();
    expect(l.rateLimited(2 * MIN)).toBeNull();
    expect(l.rateLimited(3 * MIN)).toEqual({ from: 6, to: 3, reason: LIMIT_REASON.rateLimit });
    expect(l.rateLimited(4 * MIN)).toBeNull();
    expect(l.rateLimited(5 * MIN)).toEqual({ from: 3, to: 1, reason: LIMIT_REASON.rateLimit });
  });

  test('429·오류가 나면 10분 유지를 처음부터 다시 센다', () => {
    const l = started(16);
    l.rateLimited(8 * MIN);
    expect(l.observe(10 * MIN, calm)).toBeNull();
    l.error(12 * MIN);
    expect(l.observe(18 * MIN, calm)).toBeNull();
    expect(l.observe(22 * MIN, calm)?.to).toBe(8);
  });

  test('상한이 한도보다 낮아지면 상한까지 내리고, 올라가면 그대로 둔다', () => {
    const l = started(16);
    expect(l.applyCaps(4, { restart: false }, MIN)).toEqual({ from: 6, to: 4, reason: LIMIT_REASON.cap });
    expect(l.applyCaps(30, { restart: false }, 2 * MIN)).toBeNull();
    expect(l.limit).toBe(4);
  });

  test('PC가 바뀌면 시작값부터 다시(조절 기록 남김)', () => {
    const l = started(16);
    l.observe(10 * MIN, calm);
    expect(l.limit).toBe(8);
    expect(l.applyCaps(49, { restart: true }, 11 * MIN)).toEqual({ from: 8, to: 6, reason: LIMIT_REASON.hostChanged });
    expect(l.observe(20 * MIN, calm)).toBeNull();
    expect(l.observe(21 * MIN, calm)?.to).toBe(8);
  });

  test('상한은 1 이상의 정수여야 한다', () => {
    expect(() => new AdaptiveLimiter().applyCaps(0, { restart: true }, 0)).toThrow(RangeError);
    expect(() => new AdaptiveLimiter().applyCaps(2.5, { restart: true }, 0)).toThrow(RangeError);
  });
});

describe('memoryPressure — shared capacity/limits와 같은 식', () => {
  test.each([
    [4, 0, 4, false],
    [3.99, 0, 4, true],
    [10, 0.01, 4, true],
  ])('여유 %s · swap %s · 예비 %s → %s', (free, swap, reserve, want) => {
    expect(memoryPressure(free, swap, reserve)).toBe(want);
  });
});

describe('reservedSlots — G §6.7 규칙 2·3 (fail-closed)', () => {
  const base = { verified: false, state: 'ok' as const, observed: 0, budget: 2, previousHeld: 0 };
  test('미검증 CLI는 1 + max(예산, 관측, 직전 보유)', () => {
    expect(reservedSlots(base)).toBe(3);
    expect(reservedSlots({ ...base, observed: 5 })).toBe(6);
    expect(reservedSlots({ ...base, observed: 1, previousHeld: 4 })).toBe(5);
  });
  test('검증된 CLI의 정상 관측만 관측 수로 줄어든다', () => {
    expect(reservedSlots({ ...base, verified: true, observed: 1, previousHeld: 4 })).toBe(2);
    expect(reservedSlots({ ...base, verified: true, state: 'unconfirmed', observed: 1, previousHeld: 4 })).toBe(5);
  });
  test('음수·소수는 거부한다', () => {
    expect(() => reservedSlots({ ...base, observed: -1 })).toThrow(RangeError);
    expect(() => reservedSlots({ ...base, budget: 1.5 })).toThrow(RangeError);
  });
});

describe('admit — 새 세션 시작 판단', () => {
  const caps = { total: 16, Claude: 12, Codex: 12, heavy: 6 };
  const ok = { limit: 6, holdNew: false, caps, held: { total: 0, Claude: 0, Codex: 0 }, unconfirmed: 0, agent: 'Claude' as const, slots: 3 };

  test('여유가 있으면 시작한다', () => {
    expect(admit(ok)).toEqual({ ok: true });
    expect(admit({ ...ok, held: { total: 3, Claude: 3, Codex: 0 } })).toEqual({ ok: true });
  });
  test('상한을 아직 받지 못했으면 보류', () => {
    expect(admit({ ...ok, limit: null })).toEqual({ ok: false, reason: 'no_caps' });
  });
  test('자원 압박이면 보류', () => {
    expect(admit({ ...ok, holdNew: true })).toEqual({ ok: false, reason: 'memory_pressure' });
  });
  test('미확인 세션이 있으면 보류(G §6.7-3)', () => {
    expect(admit({ ...ok, unconfirmed: 1 })).toEqual({ ok: false, reason: 'unconfirmed_session' });
  });
  test('보유 계산 합계가 한도를 넘으면 보류', () => {
    expect(admit({ ...ok, held: { total: 4, Claude: 0, Codex: 4 } })).toEqual({ ok: false, reason: 'limit' });
  });
  test('Agent별 상한을 넘으면 보류', () => {
    const c = { ...caps, Claude: 4 };
    expect(admit({ ...ok, limit: 16, caps: c, held: { total: 2, Claude: 2, Codex: 0 } })).toEqual({ ok: false, reason: 'agent_cap' });
    expect(admit({ ...ok, limit: 16, caps: c, held: { total: 1, Claude: 1, Codex: 0 } })).toEqual({ ok: true });
  });
});
