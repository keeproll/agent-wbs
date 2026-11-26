/** 설정 「최신 위에 다시 적용」 합치기 규칙(리뷰 624c334 지적 2). */
import { describe, expect, it } from 'vitest';
import { changedPaths, mergeChanges, overlay } from '../src/features/settings/useSettingForm.tsx';

describe('mergeChanges', () => {
  it('내가 바꾼 칸만 최신 값에 얹고, 다른 곳에서 바꾼 칸은 지킨다', () => {
    const base = { lowPct: 20, notifyAt: 2, floors: { verifyGeDev: true, dbHigh: true } };
    const mine = { lowPct: 30, notifyAt: 2, floors: { verifyGeDev: true, dbHigh: false } };
    const latest = { lowPct: 20, notifyAt: 3, floors: { verifyGeDev: false, dbHigh: true } };
    expect(mergeChanges(base, mine, latest)).toEqual({ lowPct: 30, notifyAt: 3, floors: { verifyGeDev: false, dbHigh: false } });
  });
  it('같은 칸을 둘 다 바꿨으면 내 값이 남는다', () => {
    expect(mergeChanges({ a: 1 }, { a: 2 }, { a: 3 })).toEqual({ a: 2 });
  });
  it('목록은 한 덩어리로 본다(바꿨으면 내 목록, 아니면 최신 목록)', () => {
    expect(mergeChanges({ days: ['x'] }, { days: ['x', 'y'] }, { days: ['z'] })).toEqual({ days: ['x', 'y'] });
    expect(mergeChanges({ days: ['x'] }, { days: ['x'] }, { days: ['z'] })).toEqual({ days: ['z'] });
  });
  it('최신에만 새로 생긴 칸도 남긴다', () => {
    expect(mergeChanges<Record<string, number>>({ a: 1 }, { a: 2 }, { a: 1, b: 5 })).toEqual({ a: 2, b: 5 });
  });
});

describe('편집됨 칸 덮기(overlay·changedPaths)', () => {
  it('바뀐 칸의 경로를 객체 안쪽까지 찾는다', () => {
    expect(changedPaths({ a: 1, f: { x: true, y: true }, l: [1] }, { a: 2, f: { x: true, y: false }, l: [1, 2] })).toEqual([['a'], ['f', 'y'], ['l']]);
  });
  it('서버 값 위에 편집된 칸만 내 값으로 덮는다(되돌린 값도 유지)', () => {
    const server = { lowPct: 30, notifyAt: 2, floors: { a: true, b: true } };
    const mine = { lowPct: 20, notifyAt: 3, floors: { a: true, b: false } };
    expect(overlay(server, mine, [['lowPct'], ['floors', 'b']])).toEqual({ lowPct: 20, notifyAt: 2, floors: { a: true, b: false } });
  });
});

describe('키에 점·슬래시·공백이 있어도 한 칸으로 다룬다(재리뷰 8fa1953)', () => {
  const KEYS = ['Codex:gpt-6.1-sol', 'a/b', 'with space', 'x.y/z w', ''];
  it('바뀐 칸의 경로가 키를 쪼개지 않는다', () => {
    for (const key of KEYS) {
      const a = { allowed: { [key]: true, other: true } };
      const b = { allowed: { [key]: false, other: true } };
      expect(changedPaths(a, b)).toEqual([['allowed', key]]);
    }
  });
  it('편집한 칸을 서버 값 위에 정확히 덮는다(다른 키는 서버 값)', () => {
    for (const key of KEYS) {
      const server = { allowed: { [key]: true, 'Codex:gpt-6.1': true } };
      const mine = { allowed: { [key]: false, 'Codex:gpt-6.1': false } };
      expect(overlay(server, mine, [['allowed', key]])).toEqual({ allowed: { [key]: false, 'Codex:gpt-6.1': true } });
    }
  });
  it('점이 든 키가 다른 키의 「상위 칸」으로 오인되지 않는다', () => {
    const base = { allowed: { 'Codex:gpt-6': true, 'Codex:gpt-6.1': true } };
    const mine = { allowed: { 'Codex:gpt-6': true, 'Codex:gpt-6.1': false } };
    const latest = { allowed: { 'Codex:gpt-6': false, 'Codex:gpt-6.1': true } };
    expect(mergeChanges(base, mine, latest)).toEqual({ allowed: { 'Codex:gpt-6': false, 'Codex:gpt-6.1': false } });
  });
});
