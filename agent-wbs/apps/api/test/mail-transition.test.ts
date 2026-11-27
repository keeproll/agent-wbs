/**
 * 메일 발송 결과 전이표(M6-03 fix3, Codex 재리뷰 review2-codex.md P1).
 * 현재 상태 × 들어온 결과 × 그 시도가 현재인지 — 모든 칸을 시험한다.
 *
 * 원칙(coordinator 지시):
 * (1) 결과 기록은 그 시도(attempt ID)가 아직 현재 시도일 때만 상태를 바꾼다.
 * (2) unknown에서 허용되는 늦은 전이는 accepted뿐이다. 늦은 실패는 이력에만 남기고 재시도를 다시 켜지 않는다(자동 재발송 0).
 */
import { describe, expect, test } from 'vitest';
import { INCOMING, MAIL_STATES, mailTransition, type Incoming, type MailState } from '../src/mail/transition.ts';

/** 기대표: [현재 상태][들어온 결과] → 바뀔 상태(— = 그대로) · 이력 기록 여부. 현재 시도일 때 */
const CURRENT: Record<MailState, Record<Incoming, [MailState | '—', boolean]>> = {
  //            accepted              rejected(첫 실패 / 재시도 뒤)   unknown               record_lost
  sending:    { accepted: ['accepted', true], rejected: ['retry_wait', true], unknown: ['unknown', true], record_lost: ['unknown', true] },
  unknown:    { accepted: ['accepted', true], rejected: ['—', true],          unknown: ['—', true],       record_lost: ['—', false] },
  queued:     { accepted: ['—', false],       rejected: ['—', false],         unknown: ['—', false],      record_lost: ['—', false] },
  accepted:   { accepted: ['—', false],       rejected: ['—', false],         unknown: ['—', false],      record_lost: ['—', false] },
  retry_wait: { accepted: ['—', false],       rejected: ['—', false],         unknown: ['—', false],      record_lost: ['—', false] },
  failed:     { accepted: ['—', false],       rejected: ['—', false],         unknown: ['—', false],      record_lost: ['—', false] },
};

describe('현재 시도의 결과', () => {
  for (const state of MAIL_STATES) {
    for (const incoming of INCOMING) {
      test(`${state} × ${incoming}`, () => {
        const [to, log] = CURRENT[state][incoming];
        expect(mailTransition(state, incoming, { current: true, retried: false })).toEqual({ to: to === '—' ? null : to, log });
      });
    }
  }
  test('sending × rejected: 자동 재시도를 이미 했으면 failed', () => {
    expect(mailTransition('sending', 'rejected', { current: true, retried: true })).toEqual({ to: 'failed', log: true });
  });
  test('unknown × rejected: 자동 재시도 전이어도 retry_wait로 되살리지 않는다', () => {
    expect(mailTransition('unknown', 'rejected', { current: true, retried: false }).to).toBeNull();
    expect(mailTransition('unknown', 'rejected', { current: true, retried: true }).to).toBeNull();
  });
});

describe('현재 시도가 아닌(낡은) 결과는 어떤 상태도 바꾸지 않는다', () => {
  for (const state of MAIL_STATES) {
    for (const incoming of INCOMING) {
      for (const retried of [false, true]) {
        test(`${state} × ${incoming} (retried=${String(retried)})`, () => {
          // 실제로 받은 응답은 이력에 남긴다. 기록 실패(record_lost)는 남길 응답이 없다.
          expect(mailTransition(state, incoming, { current: false, retried })).toEqual({ to: null, log: incoming !== 'record_lost' });
        });
      }
    }
  }
});

describe('표 전체 불변식', () => {
  const all = MAIL_STATES.flatMap((s) => INCOMING.flatMap((i) => [true, false].flatMap((current) => [true, false].map((retried) => ({ s, i, current, retried, r: mailTransition(s, i, { current, retried }) })))));
  test('retry_wait로 가는 칸은 「현재 시도 · sending · 명시적 거부 · 자동 재시도 전」 하나뿐이다', () => {
    expect(all.filter((x) => x.r.to === 'retry_wait').map((x) => [x.s, x.i, x.current, x.retried])).toEqual([['sending', 'rejected', true, false]]);
  });
  test('unknown에서 바뀌는 칸은 accepted뿐이다', () => {
    expect([...new Set(all.filter((x) => x.s === 'unknown' && x.r.to !== null).map((x) => x.r.to))]).toEqual(['accepted']);
  });
  test('보낼 차례 상태(queued · retry_wait)로 되돌아가는 칸은 retry_wait 하나뿐이다(queued로는 없음)', () => {
    expect(all.some((x) => x.r.to === 'queued')).toBe(false);
  });
});
