import { describe, expect, test } from 'vitest';
import { UsageTracker } from '../../src/resources/usage.ts';

describe('UsageTracker — POST /runner/usage(G §8.2: 남은 사용량 %·리셋 시각·사용 토큰)', () => {
  test('바뀐 Agent만 한 번 보고한다', () => {
    const u = new UsageTracker();
    u.update('Codex', { remainPct: 42, resetAt: new Date('2026-11-26T12:00:00Z') });
    expect(u.drain()).toEqual([{ agent: 'Codex', remainPct: 42, resetAt: '2026-11-26T12:00:00.000Z' }]);
    expect(u.drain()).toEqual([]);
    u.update('Codex', { remainPct: 42, resetAt: new Date('2026-11-26T12:00:00Z') });
    expect(u.drain()).toEqual([]);
    u.update('Codex', { remainPct: 41 });
    expect(u.drain()).toEqual([{ agent: 'Codex', remainPct: 41 }]);
  });

  test('사용 토큰은 누적해서 함께 보낸다', () => {
    const u = new UsageTracker();
    u.update('Claude', { remainPct: 90 });
    u.addTokens('Claude', 1000);
    u.addTokens('Claude', 500);
    expect(u.drain()).toEqual([{ agent: 'Claude', remainPct: 90, tokensUsed: 1500 }]);
    u.addTokens('Claude', 1);
    expect(u.drain()).toEqual([{ agent: 'Claude', remainPct: 90, tokensUsed: 1501 }]);
  });

  test('남은 사용량을 모르면 토큰만으로는 보내지 않는다(remainPct 필수) — 알게 되면 함께 보낸다', () => {
    const u = new UsageTracker();
    u.addTokens('Codex', 10);
    expect(u.drain()).toEqual([]);
    u.update('Codex', { remainPct: 5 });
    expect(u.drain()).toEqual([{ agent: 'Codex', remainPct: 5, tokensUsed: 10 }]);
  });

  test('소수는 반올림, 0~100 밖은 거부', () => {
    const u = new UsageTracker();
    u.update('Codex', { remainPct: 19.6 });
    expect(u.drain()[0]?.remainPct).toBe(20);
    expect(() => u.update('Codex', { remainPct: 101 })).toThrow(RangeError);
    expect(() => u.update('Codex', { remainPct: -1 })).toThrow(RangeError);
    expect(() => u.update('Codex', { remainPct: Number.NaN })).toThrow(RangeError);
  });

  test('잘못된 리셋 시각·토큰은 거부', () => {
    const u = new UsageTracker();
    expect(() => u.update('Codex', { remainPct: 1, resetAt: new Date('x') })).toThrow(RangeError);
    expect(() => u.addTokens('Codex', -1)).toThrow(RangeError);
    expect(() => u.addTokens('Codex', 1.5)).toThrow(RangeError);
  });

  test('보고 실패 시 되돌려 다음에 다시 보낸다', () => {
    const u = new UsageTracker();
    u.update('Codex', { remainPct: 3 });
    const sent = u.drain();
    u.restore(sent);
    expect(u.drain()).toEqual(sent);
  });

  test('되돌리는 사이 새 값이 왔으면 새 값을 지킨다', () => {
    const u = new UsageTracker();
    u.update('Codex', { remainPct: 3 });
    const sent = u.drain();
    u.update('Codex', { remainPct: 2 });
    u.restore(sent);
    expect(u.drain()).toEqual([{ agent: 'Codex', remainPct: 2 }]);
  });
});
