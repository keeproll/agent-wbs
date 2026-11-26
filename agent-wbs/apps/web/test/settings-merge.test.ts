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
    expect(changedPaths({ a: 1, f: { x: true, y: true }, l: [1] }, { a: 2, f: { x: true, y: false }, l: [1, 2] })).toEqual(['a', 'f.y', 'l']);
  });
  it('서버 값 위에 편집된 칸만 내 값으로 덮는다(되돌린 값도 유지)', () => {
    const server = { lowPct: 30, notifyAt: 2, floors: { a: true, b: true } };
    const mine = { lowPct: 20, notifyAt: 3, floors: { a: true, b: false } };
    expect(overlay(server, mine, ['lowPct', 'floors.b'])).toEqual({ lowPct: 20, notifyAt: 2, floors: { a: true, b: false } });
  });
});
