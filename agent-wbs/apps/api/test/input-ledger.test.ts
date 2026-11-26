import { describe, expect, test } from 'vitest';
import { analyzable, analyze, chainHead, netChanges, receive, skip, type Ledger } from '../src/project/ledger.ts';
import { Graph, observe, random, runSeed, treeHash, type InputModel } from './input-ledger-property.ts';

/** 서비스가 쓰는 원장 규칙을 그대로 감싼 검사 모델 */
function treeModel(registration: string): InputModel {
  let ledger: Ledger = { versions: [{ v: 1, sha: registration, tree: null }], reports: [] };
  return {
    report(o) {
      const result = receive(ledger, o);
      if (result.kind === 'ok') ledger = result.ledger;
      return result.kind === 'invalid' ? { kind: 'invalid' } : result.kind === 'rewritten' ? { kind: 'rewritten' } : { kind: result.kind, head: result.head };
    },
    skipAll() { ledger = skip(ledger, ledger.reports.map((r) => r.head)); },
    analyze(sha) { const result = analyze(ledger, sha); if ('error' in result) return false; ledger = result.ledger; return true; },
    analyzable: () => analyzable(ledger),
    head: () => chainHead(ledger),
    versions: () => ledger.versions.map((v) => v.sha),
    net: () => netChanges(ledger),
  };
}

describe('입력 원장 — 트리 차이가 정답(FIX4 리뷰 N1·N2)', () => {
  test('merge·fast-forward·이력 재작성·응답 유실·중복·지연이 섞인 무작위 DAG 500 시드에서 서버 입력 상태가 파일 트리 정답과 같다', () => {
    const failures = Array.from({ length: 500 }, (_, i) => runSeed(i + 1, treeModel)).filter((f) => f !== null);
    expect(failures.slice(0, 1)).toEqual([]);
  });

  test('N1 재현: feature에 main을 -s ours로 합친 뒤 fast-forward하면 커밋 목록은 비어도 삭제를 잡는다', () => {
    const g = new Graph();
    const a = g.commit([], new Map([['prototype/docs/keep.md', 'k']]));
    const b = g.commit([a], new Map([['prototype/docs/keep.md', 'k'], ['prototype/docs/deleted-by-merge.md', 'd']])); // main B
    const feature = g.commit([a], new Map([['prototype/docs/keep.md', 'k']])); // src만 바꾼 feature
    const f = g.commit([feature, b], g.tree(feature)); // -s ours, main을 F로 fast-forward
    const o = observe(g, b, f, random(1));
    expect(o.commits).toEqual([]);
    expect(o.changes).toEqual([{ status: 'D', path: 'prototype/docs/deleted-by-merge.md', oldBlob: 'd', newBlob: null }]);
    const m = treeModel(b);
    expect(m.report(o)).toMatchObject({ kind: 'ok', head: f });
    expect([...m.net()]).toEqual([['prototype/docs/deleted-by-merge.md', 'deleted']]);
    expect(m.analyze(f)).toBe(true);
  });

  test('N2: 빈 차이 보고도 head를 옮기고, 그 head로 분석할 수 있다', () => {
    const m = treeModel('A');
    m.report({ base: 'A', head: 'B', baseIsAncestor: true, treeHash: 't1', changes: [{ status: 'A', path: 'prototype/docs/b.md', oldBlob: null, newBlob: 'b' }], commits: [] });
    expect(m.report({ base: 'B', head: 'C', baseIsAncestor: true, treeHash: 't1', changes: [], commits: [] })).toEqual({ kind: 'ok', head: 'C' });
    expect(m.head()).toBe('C');
    expect(m.analyzable()).toBe('C');
    expect(m.analyze('B')).toBe(false);
    expect(m.analyze('C')).toBe(true);
  });

  test('되돌아간 파일(A→B→A)은 순 변경에 없고, 순 변경이 없으면 입력 버전을 만들지 않는다', () => {
    const m = treeModel('A');
    m.report({ base: 'A', head: 'B', baseIsAncestor: true, treeHash: 't2', changes: [{ status: 'M', path: 'prototype/x.md', oldBlob: 'x1', newBlob: 'x2' }], commits: [] });
    m.report({ base: 'B', head: 'C', baseIsAncestor: true, treeHash: 't1', changes: [{ status: 'M', path: 'prototype/x.md', oldBlob: 'x2', newBlob: 'x1' }], commits: [] });
    expect(m.net().size).toBe(0);
    expect(m.analyzable()).toBeUndefined();
    expect(m.analyze('C')).toBe(false);
  });

  test('모순된 관측은 거부하고 아무것도 바꾸지 않는다: 빈 차이인데 트리 해시가 바뀜, 지난 보고와 다른 이전 blob, 경로 중복', () => {
    const base: Ledger = { versions: [{ v: 1, sha: 'A', tree: null }], reports: [] };
    const first = receive(base, { base: 'A', head: 'B', baseIsAncestor: true, treeHash: 't1', changes: [{ status: 'A', path: 'p/x', oldBlob: null, newBlob: 'x1' }] });
    if (first.kind !== 'ok') throw new Error(first.kind);
    expect(receive(first.ledger, { base: 'B', head: 'C', baseIsAncestor: true, treeHash: 't9', changes: [] })).toMatchObject({ kind: 'invalid', error: { rule: 'tree' } });
    expect(receive(first.ledger, { base: 'B', head: 'C', baseIsAncestor: true, treeHash: 't2', changes: [{ status: 'M', path: 'p/x', oldBlob: 'zz', newBlob: 'x2' }] })).toMatchObject({ kind: 'invalid', error: { rule: 'blob' } });
    expect(receive(first.ledger, { base: 'B', head: 'C', baseIsAncestor: true, treeHash: 't2', changes: [{ status: 'A', path: 'p/y', oldBlob: null, newBlob: 'y' }, { status: 'D', path: 'p/y', oldBlob: 'y', newBlob: null }] })).toMatchObject({ kind: 'invalid', error: { rule: 'unique' } });
  });

  test('base가 head와 다르면 stale, 이력 재작성은 rewritten이며 둘 다 원장을 바꾸지 않는다', () => {
    const ledger: Ledger = { versions: [{ v: 1, sha: 'A', tree: null }], reports: [] };
    expect(receive(ledger, { base: 'X', head: 'B', baseIsAncestor: true, treeHash: treeHash(new Map()), changes: [] })).toEqual({ kind: 'stale', head: 'A' });
    expect(receive(ledger, { base: 'A', head: 'Z', baseIsAncestor: false, treeHash: 't', changes: [] })).toEqual({ kind: 'rewritten', head: 'A' });
  });
});
