/**
 * Task 레일(UI-03D, 원본 P L804–810): 상세를 열면 표 대신 260px 목록이 된다.
 * 표와 같은 필터·검색·정렬을 따르고, Phase/WP 접힘은 무시하고 모두 보인다.
 */
import { useEffect, useRef } from 'react';
import { SmIcon, StatusPill, WBS_ICON } from './cells.tsx';
import type { RailItem } from './model.ts';

export function TaskRail({ items, count, search, onSearch, filterN, selected, onPick, onExpand }: {
  items: RailItem[];
  count: number;
  search: string;
  onSearch: (q: string) => void;
  filterN: number;
  selected: string;
  onPick: (taskKey: string) => void;
  onExpand: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  // 선택한 Task가 레일 안에서 보이도록 스크롤한다(이전·다음·키보드 이동).
  useEffect(() => {
    const el = ref.current?.querySelector('[aria-current="true"]');
    if (el && 'scrollIntoView' in el) el.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <aside ref={ref} className="side wrail scrollc" aria-label="Task 목록">
      <div className="rail-h">
        <span className="rail-ttl">Task <span className="mono muted">{count}</span></span>
        <button type="button" className="btn sm rail-exp" onClick={onExpand} title="상세를 닫고 원래 목록으로 펼칩니다"><SmIcon d={WBS_ICON.expand} />펼치기</button>
      </div>
      <label className="search wr-search">
        <span className="sr">Task ID 또는 제목 검색</span>
        <input type="search" placeholder="ID · 제목 검색" value={search} onChange={(e) => { onSearch(e.target.value); }} />
      </label>
      {filterN > 0 && <p className="fhint wr-f">목록 필터 {filterN}개 적용 중 — 「펼치기」로 목록에서 변경</p>}
      {items.map((w) => (w.kind === 'wp'
        ? <div key={w.key} className="wr-wp">{w.label}</div>
        : (
          <button key={w.key} type="button" className={w.key === selected ? 'side-i on' : 'side-i'} onClick={() => { onPick(w.key); }} aria-current={w.key === selected ? 'true' : 'false'}>
            <span className="side-r"><span className="mono muted">{w.key}</span><StatusPill status={w.task.lifecycleStatus} /></span>
            <span className="side-t">{w.task.title}</span>
          </button>
        )))}
      {count === 0 && <p className="empty" style={{ margin: '8px 4px' }}>조건에 맞는 Task가 없습니다.</p>}
    </aside>
  );
}
