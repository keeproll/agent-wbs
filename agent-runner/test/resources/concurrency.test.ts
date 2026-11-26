import { describe, expect, test } from 'vitest';
import { AdaptiveLimiter, LIMIT_REASON, admit, memoryPressure, reservedSlots } from '../../src/resources/concurrency.ts';

const MIN = 60_000;
const calm = { memFreeGB: 10, swapUsedGB: 0, memReserveGB: 4 };

function started(total: number, now = 0): AdaptiveLimiter {
  const l = new AdaptiveLimiter();
  l.applyCaps(total, { restart: true }, now);
  return l;
}

/** fromMin~toMin 매 분 자원을 관측하고, 생긴 조절 기록을 모은다(관측 주기 1분). */
function feed(l: AdaptiveLimiter, fromMin: number, toMin: number, s = calm) {
  const out = [];
  for (let m = fromMin; m <= toMin; m += 1) {
    const a = l.observe(m * MIN, s);
    if (a) out.push({ at: m, ...a });
  }
  return out;
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
    expect(feed(l, 0, 30)).toEqual([
      { at: 10, from: 6, to: 8, reason: LIMIT_REASON.stable },
      { at: 20, from: 8, to: 9, reason: LIMIT_REASON.stable },
    ]);
    expect(l.limit).toBe(9);
  });

  test('관측이 없던 시간은 「여유 유지」로 세지 않는다 — 첫 관측부터 센다(리뷰 8)', () => {
    const l = started(16);
    expect(l.observe(60 * MIN, calm)).toBeNull();
    expect(feed(l, 61, 69)).toEqual([]);
    expect(feed(l, 70, 70)).toEqual([{ at: 70, from: 6, to: 8, reason: LIMIT_REASON.stable }]);
  });

  test('상한을 받은 시각이 아니라 첫 관측 시각부터 센다(리뷰 8)', () => {
    const l = started(16);
    expect(feed(l, 1, 10)).toEqual([]);
    expect(feed(l, 11, 11)).toEqual([{ at: 11, from: 6, to: 8, reason: LIMIT_REASON.stable }]);
  });

  test('관측 간격이 허용 주기(2분)를 넘으면 처음부터 다시 센다(리뷰 8)', () => {
    const l = started(16);
    feed(l, 0, 5);
    // 5분 → 8분: 3분 공백
    expect(feed(l, 8, 17)).toEqual([]);
    expect(feed(l, 18, 18)).toEqual([{ at: 18, from: 6, to: 8, reason: LIMIT_REASON.stable }]);
  });

  test('관측 실패를 알리면 처음부터 다시 센다(리뷰 8)', () => {
    const l = started(16);
    feed(l, 0, 8);
    // 9분 관측이 실패했고 10분에 다시 관측 — 10분부터 센다.
    l.sampleFailed(9 * MIN);
    expect(feed(l, 10, 19)).toEqual([]);
    expect(feed(l, 20, 20)).toHaveLength(1);
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
    feed(l, 0, 8);
    l.observe(9 * MIN, { ...calm, memFreeGB: 1 });
    expect(l.observe(10 * MIN, calm)).toBeNull();
    expect(l.holdNew).toBe(false);
    expect(feed(l, 11, 19)).toEqual([]);
    expect(feed(l, 20, 20)).toEqual([{ at: 20, from: 4, to: 6, reason: LIMIT_REASON.stable }]);
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

  test('429 사이에 다른 오류(429가 아닌 응답)가 끼면 연속이 끊긴다(리뷰 9)', () => {
    const l = started(16);
    expect(l.rateLimited(MIN)).toBeNull();
    l.error(2 * MIN);
    expect(l.rateLimited(3 * MIN)).toBeNull();
    expect(l.limit).toBe(6);
  });

  test('429·오류가 나면 10분 유지를 처음부터 다시 센다', () => {
    const l = started(16);
    feed(l, 0, 7);
    l.rateLimited(7.5 * MIN);
    expect(feed(l, 8, 17)).toEqual([]);
    l.error(17.5 * MIN);
    expect(feed(l, 18, 27)).toEqual([]);
    expect(feed(l, 28, 28)).toHaveLength(1);
  });

  test('상한이 한도보다 낮아지면 상한까지 내리고, 올라가면 그대로 둔다', () => {
    const l = started(16);
    expect(l.applyCaps(4, { restart: false }, MIN)).toEqual({ from: 6, to: 4, reason: LIMIT_REASON.cap });
    expect(l.applyCaps(30, { restart: false }, 2 * MIN)).toBeNull();
    expect(l.limit).toBe(4);
  });

  test('상한이 한도보다 1만 낮아도 내린다(경계)', () => {
    const l = started(16);
    expect(l.applyCaps(5, { restart: false }, MIN)).toEqual({ from: 6, to: 5, reason: LIMIT_REASON.cap });
    expect(l.applyCaps(5, { restart: false }, 2 * MIN)).toBeNull();
  });

  test('PC가 바뀌면 시작값부터 다시(조절 기록 남김)', () => {
    const l = started(16);
    feed(l, 0, 10);
    expect(l.limit).toBe(8);
    expect(l.applyCaps(49, { restart: true }, 10.5 * MIN)).toEqual({ from: 8, to: 6, reason: LIMIT_REASON.hostChanged });
    expect(feed(l, 11, 20)).toEqual([]);
    expect(feed(l, 21, 21)).toEqual([{ at: 21, from: 6, to: 8, reason: LIMIT_REASON.stable }]);
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
