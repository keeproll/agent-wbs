/**
 * 로딩 표시 규칙(G§0.3 보조 규칙, architecture §8 「로딩·오류 규칙」).
 *
 * - 응답이 0.2초 안에 오면 표시하지 않는다. 왜: 아주 짧은 표시는 깜빡임으로만 보인다.
 * - 한 번 보인 skeleton은 최소 0.3초 유지한다. 왜: 바로 사라지면 화면이 튄다.
 * - 10초 안에 응답이 없으면 실패로 바꾼다(api/client.ts의 timeout).
 * 원본의 Mock 지연(0.8초·0.45초·6초)은 제품 규칙이 아니다(MM-17).
 */
export const LOADING_RULES = { showAfterMs: 200, minVisibleMs: 300, timeoutMs: 10_000 } as const;

export interface VisibilityInput {
  /** 요청을 기다리기 시작한 시각(ms). 끝났으면 null */
  pendingSince: number | null;
  /** skeleton을 처음 보인 시각(ms). 아직 안 보였으면 null */
  shownSince: number | null;
  now: number;
}

/** 지금 skeleton을 보일지, 언제 다시 계산할지(ms 시각, 없으면 null)를 정한다. */
export function skeletonVisibility({ pendingSince, shownSince, now }: VisibilityInput): { visible: boolean; recheckAt: number | null } {
  if (shownSince !== null) {
    if (pendingSince !== null) return { visible: true, recheckAt: null };
    const until = shownSince + LOADING_RULES.minVisibleMs;
    return now < until ? { visible: true, recheckAt: until } : { visible: false, recheckAt: null };
  }
  if (pendingSince === null) return { visible: false, recheckAt: null };
  const at = pendingSince + LOADING_RULES.showAfterMs;
  return now >= at ? { visible: true, recheckAt: null } : { visible: false, recheckAt: at };
}
