/**
 * 로딩 표시 5종(G§0.3 「로딩 표시 규칙」).
 *
 * 1. PageSkeleton — 처음 여는 메뉴. 실제 배치와 같은 회색 모양(SYS-01).
 * 2. 상단 진행 막대 — 이미 본 메뉴·필터 변경. 이전 화면을 유지한다(feedback.tsx의 useTopBar).
 * 3. 흐림 + 「일정 다시 계산 중」 — 재계산 중 클릭 차단(feedback.tsx의 useDim).
 * 4. AreaLoading — 화면 안 일부 영역만 다시 불러올 때 작은 스피너.
 * 5. BusyButton — 저장·승인 버튼 안 진행 표시(BusyButton.tsx).
 * 화면 전체를 가리는 스피너는 쓰지 않는다.
 */
import { useEffect, useRef, useState } from 'react';
import { skeletonVisibility } from '../state/loading.ts';
import type { MenuKey } from '../layout/menu.ts';
import { menuLabel } from '../layout/menu.ts';
import { SKELETON } from './skeletons.ts';

export function PageSkeleton({ menu }: { menu: MenuKey }) {
  const label = `${menuLabel(menu)} 불러오는 중`;
  return (
    <div className="skp" role="status" aria-busy="true" aria-label={label}>
      {SKELETON[menu].map((row, r) => (
        <div key={r} className="sk-r" style={{ gridTemplateColumns: row.columns }}>
          {row.cells.map((cell, c) => (
            <div key={c} className={cell.card ? 'sk-c card' : 'sk-c'}>
              {cell.blocks.map((block, b) => <div key={b} className="sk" style={block.style} />)}
            </div>
          ))}
        </div>
      ))}
      <span className="sr">{label}</span>
    </div>
  );
}

/** 영역 로딩(원본 .area-load: 큰 스피너 + 문구, 높이 220px) */
export function AreaLoading({ label }: { label: string }) {
  return (
    <div className="area-load" role="status">
      <span className="bspin lg" aria-hidden="true" />
      {label}
    </div>
  );
}

/**
 * 0.2초 생략·최소 0.3초 유지 규칙을 적용한 표시 여부.
 * `active`가 true인 동안 기다리다가 0.2초가 지나면 true가 되고, 한 번 true가 되면 최소 0.3초 유지한다.
 */
export function useDelayedFlag(active: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const since = useRef<{ pending: number | null; shown: number | null }>({ pending: null, shown: null });
  useEffect(() => {
    const s = since.current;
    s.pending = active ? (s.pending ?? Date.now()) : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const evaluate = () => {
      const now = Date.now();
      const result = skeletonVisibility({ pendingSince: s.pending, shownSince: s.shown, now });
      if (result.visible && s.shown === null) s.shown = now;
      if (!result.visible) s.shown = null;
      setVisible(result.visible);
      if (result.recheckAt !== null) timer = setTimeout(evaluate, Math.max(0, result.recheckAt - now));
    };
    // 상태 갱신은 다음 틱에 한다(렌더 중 연쇄 갱신 방지).
    timer = setTimeout(evaluate, 0);
    return () => { clearTimeout(timer); };
  }, [active]);
  return visible;
}
