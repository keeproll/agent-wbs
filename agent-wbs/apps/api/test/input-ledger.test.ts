import { describe, expect, test } from 'vitest';
import { analyze, latestOpen, openCommits, receive, skip, type Ledger } from '../src/project/ledger.ts';
import { runSeed, type InputModel } from './input-ledger-property.ts';

/** 서비스가 쓰는 원장 규칙을 그대로 감싼 검사 모델 */
function ledgerModel(base: string): InputModel {
  let ledger: Ledger = { versions: [{ v: 1, sha: base, depth: null }], commits: [] };
  return {
    report(batch) { const result = receive(ledger, batch); if ('ledger' in result) ledger = result.ledger; },
    skipAllPending() { ledger = skip(ledger, ledger.commits.map((c) => c.sha)); },
    latest: () => latestOpen(ledger)?.sha,
    analyze(sha) { const result = analyze(ledger, sha); if ('error' in result) return false; ledger = result.ledger; return true; },
    versions: () => ledger.versions.map((v) => v.sha),
    open: () => openCommits(ledger).map((c) => c.sha),
    known: () => ledger.commits.map((c) => c.sha),
  };
}

describe('입력 커밋 원장 불변식(FIX2 리뷰 F1)', () => {
  test('보고가 임의 순서·중복·지연으로 도착해도 500개 시드 모두 불변식을 지킨다', () => {
    const failures = Array.from({ length: 500 }, (_, i) => runSeed(i + 1, ledgerModel)).filter((f) => f !== null);
    expect(failures.slice(0, 1)).toEqual([]);
  });

  test('리뷰 재현: C 확정 뒤 B가 따로 들어오고 [B,C]가 다시 와도 B는 분석 대상이 아니며 버전은 거꾸로 가지 않는다', () => {
    const m = ledgerModel('A');
    m.report([{ sha: 'C', depth: 3, hasInput: true }]);
    expect(m.analyze('C')).toBe(true);
    m.report([{ sha: 'B', depth: 2, hasInput: true }]);
    m.report([{ sha: 'B', depth: 2, hasInput: true }, { sha: 'C', depth: 3, hasInput: true }]);
    expect(m.open()).toEqual([]);
    expect(m.analyze('B')).toBe(false);
    expect(m.versions()).toEqual(['A', 'C']);
  });

  test('형식이 어긋난 보고는 거부하고 아무것도 바꾸지 않는다', () => {
    const ledger: Ledger = { versions: [{ v: 1, sha: 'A', depth: null }], commits: [{ sha: 'B', depth: 2, state: 'pending', version: null }] };
    expect(receive(ledger, [{ sha: 'C', depth: 3, hasInput: true }, { sha: 'D', depth: 1, hasInput: true }])).toMatchObject({ error: { rule: 'order' } });
    expect(receive(ledger, [{ sha: 'B', depth: 5, hasInput: true }])).toMatchObject({ error: { rule: 'depth' } });
    expect(receive(ledger, [{ sha: 'X', depth: 2, hasInput: true }])).toMatchObject({ error: { rule: 'depth' } });
  });

  test('등록 커밋의 깊이를 늦게 알게 되면 그보다 앞의 커밋은 v1에 포함된 것으로 넘긴다', () => {
    const m = ledgerModel('A');
    m.report([{ sha: 'P', depth: 4, hasInput: true }]);
    m.report([{ sha: 'A', depth: 5, hasInput: false }, { sha: 'Q', depth: 6, hasInput: true }]);
    expect(m.open()).toEqual(['Q']);
  });
});
