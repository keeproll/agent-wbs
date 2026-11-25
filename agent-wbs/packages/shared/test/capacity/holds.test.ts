import { describe, expect, test } from 'vitest';
import { heldSlots, heldSubagents, observationGrade, sumHolds } from '../../src/capacity/index.ts';
import type { HoldRow, SessionObservation } from '../../src/capacity/index.ts';
import { loadPrototype } from '../grade/prototype.ts';

const s = (o: Partial<SessionObservation>): SessionObservation => ({
  grade: 'partial', state: 'ok', observed: 0, budget: 2, previousHeld: 0, ...o,
});

describe('보유 계산', () => {
  test.each(['partial', 'unverified'] as const)('%s는 1 + 예산 k, 관측이 넘으면 관측값', (grade) => {
    expect(heldSlots(s({ grade }))).toBe(3);
    expect(heldSlots(s({ grade, observed: 5 }))).toBe(6);
  });
  test('검증되지 않은 CLI는 관측이 줄어도 슬롯을 반환하지 않는다', () => {
    expect(heldSubagents(s({ observed: 1, previousHeld: 5 }))).toBe(5);
  });
  test('검증된 CLI의 정상 관측만 관측값을 쓰고 줄어들 수 있다', () => {
    expect(heldSubagents(s({ grade: 'verified', observed: 1, previousHeld: 5 }))).toBe(1);
    expect(heldSlots(s({ grade: 'verified' }))).toBe(1);
  });
  test('미확인은 검증된 CLI라도 줄이지 않는다', () => {
    expect(heldSubagents(s({ grade: 'verified', state: 'unconfirmed', observed: 0, previousHeld: 4 }))).toBe(4);
    expect(heldSubagents(s({ grade: 'verified', state: 'unconfirmed', observed: 0 }))).toBe(2);
  });
  test('음수·소수 보고는 거부', () => {
    expect(() => heldSubagents(s({ observed: -1 }))).toThrow(RangeError);
    expect(() => heldSubagents(s({ budget: 1.5 }))).toThrow(RangeError);
  });
  test('프로토타입 subHold와 같다 (직전 보유가 없을 때)', () => {
    const P = loadPrototype();
    const pg = { verified: 'ok', partial: 'partial', unverified: 'unver' } as const;
    for (const grade of ['verified', 'partial', 'unverified'] as const) {
      for (const state of ['ok', 'unconfirmed'] as const) {
        for (const [kind, budget] of [['개발', 2], ['재작업', 2], ['QA', 3], ['재검증', 3]] as const) {
          for (let observed = 0; observed < 6; observed++) {
            const d = { obs: { budget: { dev: 2, qa: 3 }, cli: { Codex: { grade: pg[grade] } } } };
            const p = P.subHold(d, { agent: 'Codex', kind, sub: observed, obsSt: state === 'ok' ? 'ok' : 'unconf' });
            expect(heldSubagents(s({ grade, state, observed, budget }))).toBe(p);
          }
        }
      }
    }
  });
});

test('관측 등급은 CLI·버전·모델·옵션이 모두 같을 때만, 아니면 미검증', () => {
  const k = { cli: 'codex', version: '0.167.0', model: 'gpt-6.1-sol', options: 'exec --json --skip-git-repo-check' };
  const reg = [{ ...k, grade: 'partial' as const }];
  expect(observationGrade(k, reg)).toBe('partial');
  for (const diff of [{ cli: 'claude' }, { version: '0.172.0' }, { model: 'gpt-6.2-sol' }, { options: 'exec --json' }]) {
    expect(observationGrade({ ...k, ...diff }, reg)).toBe('unverified');
  }
});

test('슬롯 합계: 현재 host의 reserved·active·unconfirmed만, 자기 job은 제외', () => {
  const r = (jobId: string, o: Partial<HoldRow> = {}): HoldRow => ({
    jobId, hostId: 'h1', agent: 'Codex', slots: 3, heavy: false, slotState: 'active', ...o,
  });
  const rows = [
    r('a'),
    r('b', { slotState: 'reserved', agent: 'Claude', slots: 4, heavy: true }),
    r('c', { slotState: 'unconfirmed', slots: 2 }),
    r('d', { slotState: 'none', slots: 9 }),
    r('e', { hostId: 'h0', slotState: 'unconfirmed', slots: 9 }),
    r('f', { hostId: null, slotState: 'none', slots: 9 }),
  ];
  expect(sumHolds(rows, 'h1')).toEqual({
    total: 9, perAgent: { Claude: 4, Codex: 5 }, heavy: 1, unconfirmedJobs: ['c'],
  });
  expect(sumHolds(rows, 'h1', 'b')).toEqual({
    total: 5, perAgent: { Claude: 0, Codex: 5 }, heavy: 0, unconfirmedJobs: ['c'],
  });
});
