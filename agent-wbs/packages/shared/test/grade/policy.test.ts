import { describe, expect, test } from 'vitest';
import {
  DEFAULT_EXEC_POLICY,
  belowFloor,
  escalate,
  floorOf,
  gradeError,
  lower,
  usableEfforts,
} from '../../src/grade/index.ts';
import type { Catalog, Floor } from '../../src/grade/index.ts';
import { loadPrototype } from './prototype.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const claude: Catalog = {
  agent: 'Claude',
  models: [
    { modelId: 'claude-fable-5-2', rank: 4, allowed: false, efforts: EFFORTS },
    { modelId: 'claude-opus-5-5', rank: 3, allowed: true, efforts: EFFORTS },
    { modelId: 'claude-sonnet-5-5', rank: 2, allowed: true, efforts: EFFORTS },
    { modelId: 'claude-haiku-5-5', rank: 1, allowed: false, efforts: EFFORTS },
  ],
};
const floor1: Floor = { level: 1, reasons: [] };

test('G §7.3 기본 정책', () => {
  expect(DEFAULT_EXEC_POLICY).toMatchObject({
    onUsage: 'wait', onRework: 'up1', escNotify: 2, floors: { verifyGeDev: true, dbHigh: true },
  });
});

describe('등급 유효성', () => {
  test.each([
    ['claude-opus-5-5', 'high', null],
    ['claude-fable-5-2', 'high', 'MODEL_NOT_ALLOWED'],
    ['claude-opus-9', 'high', 'MODEL_UNKNOWN'],
    ['claude-opus-5-5', 'ultra', 'EFFORT_UNMAPPED'],
  ])('%s %s → %s', (modelId, effort, want) => {
    expect(gradeError(claude, { modelId, effort })).toBe(want);
  });
  test('허용됐어도 매핑이 미확인이면 거부, 보고되지 않은 Effort도 거부', () => {
    const c: Catalog = {
      agent: 'Codex',
      models: [
        { modelId: 'gpt-new', rank: 2, allowed: true, efforts: EFFORTS },
        { modelId: 'gpt-5.5', rank: 1, allowed: true, efforts: ['low', 'medium'] },
      ],
    };
    expect(gradeError(c, { modelId: 'gpt-new', effort: 'high' })).toBe('EFFORT_UNMAPPED');
    expect(gradeError(c, { modelId: 'gpt-5.5', effort: 'high' })).toBe('EFFORT_NOT_REPORTED');
  });
  test('보고 순서·중복·ultra와 무관하게 매핑된 단계만 낮은 것부터', () => {
    const m = { modelId: 'gpt-6-sol', rank: 1, allowed: true, efforts: ['ultra', 'max', 'low', 'low', 'high'] };
    expect(usableEfforts({ agent: 'Codex', models: [m] }, m).map((e) => e.effort)).toEqual(['low', 'high', 'max']);
  });
});

describe('최저선', () => {
  const on = { verifyGeDev: true, dbHigh: true };
  const t = (primaryDomain: string, relatedDomains: string[], devLevel: 1 | 2 | 3 | 4 | 5 | null) => ({ primaryDomain, relatedDomains, devLevel });
  test('DB 작업은 개발·검증 모두 높음 이상 — 관련 영역 포함', () => {
    expect(floorOf('dev', t('DB', [], 1), on)).toEqual({ level: 3, reasons: ['DB_HIGH'] });
    expect(floorOf('qa', t('BE', ['DB'], 1), on)).toEqual({ level: 3, reasons: ['DB_HIGH'] });
  });
  test('검증 ≥ 개발은 검증에만 적용', () => {
    expect(floorOf('qa', t('FE', [], 4), on)).toEqual({ level: 4, reasons: ['VERIFY_GE_DEV'] });
    expect(floorOf('dev', t('FE', [], 4), on)).toEqual({ level: 1, reasons: [] });
  });
  test('각각 해제할 수 있다', () => {
    expect(floorOf('qa', t('DB', [], 4), { verifyGeDev: false, dbHigh: true })?.level).toBe(3);
    expect(floorOf('qa', t('DB', [], 2), { verifyGeDev: true, dbHigh: false })?.level).toBe(2);
    expect(floorOf('qa', t('DB', [], null), { verifyGeDev: false, dbHigh: false })?.level).toBe(1);
  });
  test('개발 등급이 미매핑이면 검증 최저선을 추정하지 않는다', () => {
    expect(floorOf('qa', t('FE', [], null), on)).toBeNull();
    expect(floorOf('dev', t('FE', [], null), on)?.level).toBe(1);
  });
  test('belowFloor: 고정은 제외, 미매핑은 판정 불가', () => {
    const f: Floor = { level: 3, reasons: ['DB_HIGH'] };
    const g = { modelId: 'claude-opus-5-5', effort: 'medium', locked: false };
    expect(belowFloor('Claude', g, f)).toBe(true);
    expect(belowFloor('Claude', { ...g, effort: 'high' }, f)).toBe(false);
    expect(belowFloor('Claude', { ...g, locked: true }, f)).toBe(false);
    expect(belowFloor('Claude', { ...g, effort: 'ultra' }, f)).toBeNull();
    expect(belowFloor('Claude', g, null)).toBeNull();
  });
});

describe('상향·하향', () => {
  test('Effort +1, 최상위면 허용 모델 중 한 단계 위(미허용은 건너뜀), 그 위는 없음', () => {
    expect(escalate(claude, { modelId: 'claude-sonnet-5-5', effort: 'xhigh' })?.grade).toEqual({ modelId: 'claude-sonnet-5-5', effort: 'max' });
    expect(escalate(claude, { modelId: 'claude-sonnet-5-5', effort: 'max' })).toEqual({
      grade: { modelId: 'claude-opus-5-5', effort: 'max' },
      step: { kind: 'model', from: { modelId: 'claude-sonnet-5-5', effort: 'max' }, to: { modelId: 'claude-opus-5-5', effort: 'max' } },
    });
    expect(escalate(claude, { modelId: 'claude-opus-5-5', effort: 'max' })).toBeNull();
  });
  const codex = (...rows: [string, string[], boolean?][]): Catalog => ({
    agent: 'Codex',
    models: rows.map(([modelId, efforts, allowed = true], i) => ({ modelId, rank: i + 1, allowed, efforts })),
  });
  test('ultra로는 올리지 않고, 최대를 지원하지 않거나 미매핑인 모델은 건너뛴다', () => {
    const c = codex(['gpt-6-luna', [...EFFORTS, 'ultra']], ['gpt-5.5', EFFORTS], ['gpt-new', EFFORTS], ['gpt-6.2-sol', [...EFFORTS, 'ultra']]);
    expect(escalate(c, { modelId: 'gpt-6-luna', effort: 'max' })?.grade).toEqual({ modelId: 'gpt-6.2-sol', effort: 'max' });
    expect(escalate(c, { modelId: 'gpt-6.2-sol', effort: 'max' })).toBeNull();
  });
  describe('owner 아이템 3: 바로 다음 단계가 그 모델에 없으면 그 단계를 지원하는 다음 허용 모델', () => {
    test('gpt-5.5 매우 높음 → 최대를 지원하는 다음 모델의 최대 (같은 단계로만 옮기지 않음)', () => {
      const c = codex(['gpt-5.5', EFFORTS], ['gpt-6-luna', EFFORTS], ['gpt-6.2-sol', EFFORTS]);
      expect(escalate(c, { modelId: 'gpt-5.5', effort: 'xhigh' })).toEqual({
        grade: { modelId: 'gpt-6-luna', effort: 'max' },
        step: { kind: 'model', from: { modelId: 'gpt-5.5', effort: 'xhigh' }, to: { modelId: 'gpt-6-luna', effort: 'max' } },
      });
    });
    test('같은 모델의 더 높은 단계로 건너뛰기 전에 다음 단계를 가진 모델을 찾는다', () => {
      const c = codex(['gpt-6-luna', ['low', 'medium', 'max']], ['gpt-6-sol', EFFORTS]);
      expect(escalate(c, { modelId: 'gpt-6-luna', effort: 'medium' })?.grade).toEqual({ modelId: 'gpt-6-sol', effort: 'high' });
    });
    test('그 단계가 없는 모델·미허용 모델은 순위가 가까워도 건너뛴다', () => {
      const c = codex(['gpt-6-luna', ['low', 'medium']], ['gpt-6-terra', EFFORTS], ['gpt-5.5', ['low', 'medium', 'xhigh']], ['gpt-6-sol', EFFORTS, false], ['gpt-6.2-sol', EFFORTS]);
      expect(escalate(c, { modelId: 'gpt-6-luna', effort: 'medium' })?.grade).toEqual({ modelId: 'gpt-6.2-sol', effort: 'high' });
    });
    test.each([
      ['같은 모델에 더 높은 단계가 있어도 점프하지 않음', codex(['gpt-6-luna', ['low', 'medium', 'max']], ['gpt-5.5', ['low', 'medium']])],
      ['위 모델의 같은 단계로 옮기지 않음', codex(['gpt-6-luna', ['low', 'medium']], ['gpt-5.5', ['low', 'medium', 'xhigh']])],
      ['낮은 순위 모델이 다음 단계를 지원해도 옮기지 않음', codex(['gpt-6-sol', EFFORTS], ['gpt-6-luna', ['low', 'medium']])],
    ])('D-30 다음 단계가 없으면 상향 없음: %s', (_l, c) => {
      expect(escalate(c, { modelId: 'gpt-6-luna', effort: 'medium' })).toBeNull();
    });
    test('그 모델에 다음 단계가 있으면 모델을 바꾸지 않는다', () => {
      const c = codex(['gpt-6-luna', EFFORTS], ['gpt-6-sol', EFFORTS]);
      expect(escalate(c, { modelId: 'gpt-6-luna', effort: 'medium' })?.grade).toEqual({ modelId: 'gpt-6-luna', effort: 'high' });
    });
  });
  test('얼린 catalog로 모델을 올려도 입력을 바꾸지 않는다', () => {
    const models = claude.models.map((m) => Object.freeze({ ...m, efforts: Object.freeze([...m.efforts]) }));
    const frozen = Object.freeze({ agent: 'Claude' as const, models: Object.freeze(models) });
    const g = Object.freeze({ modelId: 'claude-sonnet-5-5', effort: 'max' });
    expect(escalate(frozen, g)?.grade).toEqual({ modelId: 'claude-opus-5-5', effort: 'max' });
    expect(models.map((m) => m.rank)).toEqual([4, 3, 2, 1]);
  });
  test('하향은 최저선까지만, 가장 낮으면 없음', () => {
    const g = { modelId: 'claude-opus-5-5', effort: 'high' };
    expect(lower(claude, g, floor1)?.grade.effort).toBe('medium');
    expect(lower(claude, g, { level: 2, reasons: [] })?.grade.effort).toBe('medium');
    expect(lower(claude, g, { level: 3, reasons: [] })).toBeNull();
    expect(lower(claude, { ...g, effort: 'low' }, floor1)).toBeNull();
  });
});

test('프로토타입 escalate·lower·floorN과 모든 모델·Effort·영역 조합에서 같다', () => {
  const P = loadPrototype();
  const d = {
    exec: {
      models: { Claude: claude.models.map((m) => ({ id: m.modelId, l: m.modelId, rank: m.rank, allowed: m.allowed })) },
      efforts: { Claude: EFFORTS },
      policy: DEFAULT_EXEC_POLICY,
    },
  };
  let compared = 0;
  for (const m of claude.models) {
    for (const [i, effort] of EFFORTS.entries()) {
      const g = { modelId: m.modelId, effort };
      const p = P.escalate(d, 'Claude', { model: m.modelId, effort });
      const mine = escalate(claude, g);
      expect(mine === null).toBe(p.top);
      expect(mine?.grade ?? g).toEqual({ modelId: p.model, effort: p.effort });
      for (const domain of ['DB', 'FE']) {
        for (const role of ['dev', 'qa'] as const) {
          for (const [k, dev] of EFFORTS.entries()) {
            const t = { domain, rel: [], run: { effort: dev } };
            const f = floorOf(role, { primaryDomain: domain, relatedDomains: [], devLevel: (k + 1) as 1 }, DEFAULT_EXEC_POLICY.floors);
            expect(f?.level).toBe(P.floorN(d, t, role).n);
            if (!f) throw new Error('floor');
            const pl = P.lower(d, t, role, 'Claude', { model: m.modelId, effort });
            expect(lower(claude, g, f)?.grade.effort ?? null, `${String(i)} ${role}`).toBe(pl?.effort ?? null);
            compared += 1;
          }
        }
      }
    }
  }
  expect(compared).toBe(400);
});
