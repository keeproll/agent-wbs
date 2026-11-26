/**
 * 표 가로 스크롤 상자(D-28).
 * - 1280px 이상: 표가 화면 폭에 맞으면 스크롤이 생기지 않는다.
 * - 1280px 미만: 페이지는 가로로 넘치지 않고, 이 상자 안에서만 표를 가로로 밀어 모든 열을 읽는다.
 * - overflow:hidden으로 열을 자르지 않는다(원본 `.tbl{overflow-x:hidden}` 결함, MM-29).
 * minWidth에는 모든 열이 잘리지 않는 최소 폭(px)을 준다.
 */
import type { ReactNode } from 'react';

export function TableScroll({ minWidth, label, children }: { minWidth: number; label: string; children: ReactNode }) {
  return (
    // 키보드로도 가로 스크롤할 수 있게 tabIndex를 준다.
    <div className="tbl-x" role="region" aria-label={label} tabIndex={0}>
      <div className="tbl-x-in" style={{ minWidth }}>{children}</div>
    </div>
  );
}
