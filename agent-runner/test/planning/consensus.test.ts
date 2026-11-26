import { describe, expect, test } from 'vitest';
import { agreeEstimates, agreeJudgements, agreeSplitJudgements } from '../../src/planning/consensus.ts';
const NOW = '2026-11-27T01:02:03.000Z';

const meta = { judgedAt: NOW, sourceRef: 'job-1' };
const verdict = (target: string, rule: 'revert' | 'contract' | 'refactor', result: 'met' | 'not_met', basis = `${rule} 근거`) => ({ target, rule, result, basis });

describe('규칙 5·7·9 판단 합의(D-33)', () => {
  test('두 Agent가 같은 결론이면 합의 주체 둘과 두 근거를 함께 남긴다', () => {
    const { records, disagreements } = agreeJudgements(['T1'], ['revert', 'contract'], {
      Claude: [verdict('T1', 'revert', 'met', 'C-revert'), verdict('T1', 'contract', 'not_met', 'C-contract')],
      Codex: [verdict('T1', 'revert', 'met', 'X-revert'), verdict('T1', 'contract', 'not_met', 'X-contract')],
    }, meta);
    expect(disagreements).toEqual([]);
    expect(records.get('T1')).toEqual({
      schemaVersion: 1,
      items: [
        { rule: 'revert', result: 'met', agreedBy: ['Claude', 'Codex'], basis: 'Claude: C-revert\nCodex: X-revert', ...meta },
        { rule: 'contract', result: 'not_met', agreedBy: ['Claude', 'Codex'], basis: 'Claude: C-contract\nCodex: X-contract', ...meta },
      ],
    });
  });

  test('결론이 다르면 기록하지 않는다(기록 없음 = 승인 보류). 한쪽 결론으로 합의를 꾸미지 않는다', () => {
    const { records, disagreements } = agreeJudgements(['T1'], ['revert', 'contract'], {
      Claude: [verdict('T1', 'revert', 'met'), verdict('T1', 'contract', 'met')],
      Codex: [verdict('T1', 'revert', 'met'), verdict('T1', 'contract', 'not_met')],
    }, meta);
    expect(records.get('T1')?.items.map((i) => i.rule)).toEqual(['revert']);
    expect(disagreements).toEqual([{ target: 'T1', rule: 'contract', reason: 'disagree', results: { Claude: 'met', Codex: 'not_met' } }]);
  });

  test('한 Agent만 판단했거나 근거가 비었거나 같은 규칙을 두 번 답하면 기록하지 않는다', () => {
    const { records, disagreements } = agreeJudgements(['T1', 'T2'], ['revert', 'contract', 'refactor'], {
      Claude: [verdict('T1', 'revert', 'met'), verdict('T1', 'contract', 'met', '   '), verdict('T1', 'refactor', 'met'), verdict('T1', 'refactor', 'not_met'),
        verdict('T2', 'revert', 'met'), verdict('X9', 'revert', 'met')],
      Codex: [verdict('T1', 'contract', 'met'), verdict('T1', 'refactor', 'met'), verdict('T2', 'revert', 'met')],
    }, meta);
    expect(records.get('T1')?.items).toEqual([]);
    expect(records.get('T2')?.items.map((i) => i.rule)).toEqual(['revert']);
    expect(records.has('X9')).toBe(false);
    expect(disagreements.map((d) => `${d.target}:${d.rule}:${d.reason}`)).toEqual([
      'T1:revert:missing', 'T1:contract:blank_basis', 'T1:refactor:ambiguous', 'T2:contract:missing', 'T2:refactor:missing',
    ]);
  });

  test('저장된 대상의 재판단은 작업 payload의 hash를 그대로 붙인다', () => {
    const { records } = agreeJudgements(['TASK-0001'], ['revert'], {
      Claude: [verdict('TASK-0001', 'revert', 'met')], Codex: [verdict('TASK-0001', 'revert', 'met')],
    }, { ...meta, subjectHash: () => 'f'.repeat(64) });
    expect(records.get('TASK-0001')?.items[0]?.subjectHash).toBe('f'.repeat(64));
  });

  test('분할 CP 판단(D-34)도 같은 합의 규칙이다', () => {
    const { record, disagreements } = agreeSplitJudgements(['ac_meaning', 'layer_order', 'test_included'], {
      Claude: [{ rule: 'ac_meaning', result: 'met', basis: 'a' }, { rule: 'layer_order', result: 'met', basis: 'b' }, { rule: 'test_included', result: 'met', basis: 'c' }],
      Codex: [{ rule: 'ac_meaning', result: 'met', basis: 'a2' }, { rule: 'layer_order', result: 'not_met', basis: 'b2' }],
    }, { ...meta, subjectHash: () => 'e'.repeat(64) });
    expect(record.items).toEqual([{ rule: 'ac_meaning', result: 'met', agreedBy: ['Claude', 'Codex'], basis: 'Claude: a\nCodex: a2', ...meta, subjectHash: 'e'.repeat(64) }]);
    expect(disagreements.map((d) => `${d.rule}:${d.reason}`)).toEqual(['layer_order:disagree', 'test_included:missing']);
  });
});

describe('추정 합의', () => {
  test('범위는 넓은 쪽, 예상은 평균, 신뢰도는 낮은 쪽, 합의 주체는 둘이다', () => {
    const [merged] = agreeEstimates(['T1'], {
      Claude: [{ ref: 'T1', estHours: 2, loHours: 1.5, hiHours: 3, tokensK: 100, confidence: '상', basis: '화면 2개' }],
      Codex: [{ ref: 'T1', estHours: 3, loHours: 1, hiHours: 5, confidence: '중', basis: 'API 1개' }],
    });
    expect(merged).toEqual({ ref: 'T1', estHours: 2.5, loHours: 1, hiHours: 5, tokensK: 100, confidence: '중', basis: 'Claude: 화면 2개\nCodex: API 1개', agreedBy: ['Claude', 'Codex'] });
  });

  test('한쪽 추정이 없거나 범위가 뒤집혔으면 합의할 수 없어 오류다', () => {
    expect(() => agreeEstimates(['T1'], { Claude: [], Codex: [{ ref: 'T1', estHours: 1, loHours: 1, hiHours: 1, confidence: '중', basis: 'x' }] })).toThrow(/Claude.*T1/);
    expect(() => agreeEstimates(['T1'], {
      Claude: [{ ref: 'T1', estHours: 5, loHours: 1, hiHours: 2, confidence: '중', basis: 'x' }],
      Codex: [{ ref: 'T1', estHours: 1, loHours: 1, hiHours: 1, confidence: '중', basis: 'x' }],
    })).toThrow(/낙관 ≤ 예상 ≤ 비관/);
  });
});
