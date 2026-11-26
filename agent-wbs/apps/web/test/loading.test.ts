import { describe, expect, it } from 'vitest';
import { LOADING_RULES, skeletonVisibility } from '../src/shared/state/loading.ts';

describe('로딩 표시 규칙(G§0.3 보조 규칙)', () => {
  it('규칙 값: 0.2초 생략, 최소 0.3초 유지, 10초 실패 전환', () => {
    expect(LOADING_RULES).toEqual({ showAfterMs: 200, minVisibleMs: 300, timeoutMs: 10_000 });
  });

  it('0.2초 안에 끝나면 skeleton을 한 번도 보이지 않는다', () => {
    expect(skeletonVisibility({ pendingSince: 0, shownSince: null, now: 150 })).toEqual({ visible: false, recheckAt: 200 });
    expect(skeletonVisibility({ pendingSince: null, shownSince: null, now: 190 })).toEqual({ visible: false, recheckAt: null });
  });

  it('0.2초가 지나면 보인다', () => {
    expect(skeletonVisibility({ pendingSince: 0, shownSince: null, now: 200 }).visible).toBe(true);
  });

  it('한 번 보인 skeleton은 응답이 와도 0.3초는 유지한다', () => {
    expect(skeletonVisibility({ pendingSince: null, shownSince: 200, now: 260 })).toEqual({ visible: true, recheckAt: 500 });
    expect(skeletonVisibility({ pendingSince: null, shownSince: 200, now: 500 })).toEqual({ visible: false, recheckAt: null });
  });

  it('응답을 기다리는 동안에는 계속 보인다', () => {
    expect(skeletonVisibility({ pendingSince: 0, shownSince: 200, now: 9_000 })).toEqual({ visible: true, recheckAt: null });
  });
});
