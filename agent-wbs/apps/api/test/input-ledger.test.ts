import { describe, expect, test } from 'vitest';
import { analyzable, analyze, chainHead, openCommits, receive, skip, type Ledger } from '../src/project/ledger.ts';
import { Graph, runSeed, type InputModel } from './input-ledger-property.ts';

/** 서비스가 쓰는 원장 규칙을 그대로 감싼 검사 모델 */
function chainModel(registration: string): InputModel {
  let ledger: Ledger = { versions: [{ v: 1, sha: registration }], commits: [] };
  return {
    report(report) {
      const result = receive(ledger, report);
      if (result.kind === 'ok') ledger = result.ledger;
      return result.kind === 'invalid' ? { kind: 'invalid' } : result.kind === 'rewritten' ? { kind: 'rewritten' } : { kind: result.kind, head: result.head };
    },
    skipAllPending() { ledger = skip(ledger, ledger.commits.map((c) => c.sha)); },
    latest: () => analyzable(ledger),
    analyze(sha) { const result = analyze(ledger, sha); if ('error' in result) return false; ledger = result.ledger; return true; },
    versions: () => ledger.versions.map((v) => v.sha),
    open: () => openCommits(ledger).map((c) => c.sha),
    known: () => ledger.commits.map((c) => c.sha),
  };
}

describe('입력 커밋 원장 — git이 정한 순서(FIX3 리뷰 D1~D3)', () => {
  test('merge·fast-forward·이력 재작성·응답 유실·중복·지연 보고가 섞인 무작위 Git 이력 500 시드 모두 불변식을 지킨다', () => {
    const failures = Array.from({ length: 500 }, (_, i) => runSeed(i + 1, chainModel)).filter((f) => f !== null);
    expect(failures.slice(0, 1)).toEqual([]);
  });

  test('D2 재현: feature에 main을 합친 뒤 main을 fast-forward해도 새 입력을 잃지 않는다', () => {
    const g = new Graph();
    const root = g.commit([], true);
    const o = g.commit([g.commit([g.commit([root], true)], true)], true); // 옛 main O
    const q2 = g.commit([g.commit([root], true)], true); // root에서 갈라진 feature Q1·Q2
    const f = g.commit([q2, o], true); // 새 main F: 첫 부모 Q2, 옛 main O는 둘째 부모
    expect(g.firstParentDepth(f)).toBeLessThanOrEqual(g.firstParentDepth(o)); // 첫 부모 깊이로는 F가 O보다 앞처럼 보인다
    const m = chainModel(o);
    const result = m.report({ base: o, head: f, baseIsAncestor: g.isAncestor(o, f), commits: g.revList(o, f).map((sha) => ({ sha, hasInput: true, depth: 0 })) });
    expect(result).toMatchObject({ kind: 'ok', head: f });
    expect(m.open()).toEqual(g.revList(o, f));
    expect(m.analyze(f)).toBe(true);
  });

  test('base가 head와 다르면 붙이지 않고 지금 head를 돌려준다(늦은 중복 보고 포함)', () => {
    const ledger: Ledger = { versions: [{ v: 1, sha: 'A' }], commits: [] };
    const first = receive(ledger, { base: 'A', head: 'B', baseIsAncestor: true, commits: [{ sha: 'B', hasInput: true }] });
    if (first.kind !== 'ok') throw new Error(first.kind);
    expect(chainHead(first.ledger)).toBe('B');
    expect(receive(first.ledger, { base: 'A', head: 'B', baseIsAncestor: true, commits: [{ sha: 'B', hasInput: true }] })).toEqual({ kind: 'stale', head: 'B' });
  });

  test('이력 재작성(base가 main의 조상이 아님)은 붙이지 않는다', () => {
    const ledger: Ledger = { versions: [{ v: 1, sha: 'A' }], commits: [] };
    expect(receive(ledger, { base: 'A', head: 'Z', baseIsAncestor: false, commits: [] })).toEqual({ kind: 'rewritten', head: 'A' });
  });

  test('D3: 한 보고 안의 같은 SHA, 이미 받은 SHA, 입력 파일 없는 커밋은 거부하고 아무것도 바꾸지 않는다', () => {
    const ledger: Ledger = { versions: [{ v: 1, sha: 'A' }], commits: [{ sha: 'B', pos: 1, head: 'B', state: 'pending', version: null }] };
    for (const commits of [[{ sha: 'C', hasInput: true }, { sha: 'C', hasInput: true }], [{ sha: 'A', hasInput: true }], [{ sha: 'D', hasInput: false }]]) {
      expect(receive(ledger, { base: 'B', head: 'H', baseIsAncestor: true, commits })).toMatchObject({ kind: 'invalid' });
    }
  });
});
