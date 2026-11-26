/**
 * 도구 막대(UI-03·UI-03A, 원본 P L812–840): 검색 + 선택 필터 8개 + 필터 초기화, 보기·정렬·모두 펼치기/접기·컬럼 설정.
 */
import { useEffect, useRef, useState } from 'react';
import { SmIcon, WBS_ICON } from './cells.tsx';
import { COLS, DOMAIN_LABEL, PRIORITY, STATUS, TYPE_LABEL, VERIF, type ColKey, type Filters, type SortKey, type WbsNode } from './model.ts';

type Opt = readonly [value: string, label: string];
const STATUS_OPTS: Opt[] = [['active', '진행 중 (실행~Gate 대기)'], ...['planning', 'approval', 'ready', 'running', 'paused', 'qa', 'rework', 'verifying', 'gate', 'done', 'failed', 'cancelled'].map((k): Opt => [k, STATUS[k]?.l ?? k])];
const FILTERS: { key: keyof Filters; label: string; options: (nodes: readonly WbsNode[]) => Opt[] }[] = [
  { key: 'type', label: '작업 유형', options: () => Object.entries(TYPE_LABEL) },
  { key: 'domain', label: '기술 영역', options: () => Object.keys(DOMAIN_LABEL).map((k): Opt => [k, k]) },
  { key: 'status', label: '상태', options: () => STATUS_OPTS },
  { key: 'agent', label: '담당 Agent', options: () => [['Claude', 'Claude'], ['Codex', 'Codex']] },
  { key: 'priority', label: '우선순위', options: () => PRIORITY.map((p, i): Opt => [String(i), p.l]) },
  // Phase 목록은 서버의 실제 노드에서 만든다(원본은 고정 3개).
  { key: 'phase', label: 'Phase', options: (nodes) => nodes.filter((n) => n.kind === 'phase').map((n): Opt => [n.id, `${n.wbsPath} ${n.title}`]) },
  { key: 'blocked', label: '선행 차단', options: () => [['y', '차단됨'], ['n', '실행 가능']] },
  { key: 'verif', label: '검증 상태', options: () => Object.entries(VERIF).map(([k, v]): Opt => [k, v.l]) },
];
const SORTS: Opt[] = [['wbs', 'WBS 번호'], ['priority', '우선순위'], ['status', '상태'], ['updated', '최근 변경']];

export interface ToolbarProps {
  nodes: readonly WbsNode[];
  search: string;
  onSearch: (q: string) => void;
  filters: Filters;
  onFilter: (key: keyof Filters, value: string) => void;
  onReset: () => void;
  noFilter: boolean;
  view: 'table' | 'gantt';
  onView: (v: 'table' | 'gantt') => void;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  cols: ReadonlySet<ColKey>;
  onToggleCol: (k: ColKey) => void;
}

export function WbsToolbar(p: ToolbarProps) {
  const [colMenu, setColMenu] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  // 컬럼 메뉴 바깥을 누르거나 Esc를 누르면 닫는다(원본은 버튼으로만 닫음 — 키보드 사용 보완).
  useEffect(() => {
    if (!colMenu) return;
    const onDown = (e: MouseEvent) => { if (!group.current?.contains(e.target as Node)) setColMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setColMenu(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [colMenu]);

  return (
    <div className="toolbar">
      <label className="search">
        <SmIcon d={WBS_ICON.search} />
        <span className="sr">Task ID 또는 제목 검색</span>
        <input type="search" placeholder="Task ID 또는 제목 검색" value={p.search} onChange={(e) => { p.onSearch(e.target.value); }} />
      </label>
      {FILTERS.map((f) => (
        <label key={f.key} className={p.filters[f.key] !== '' ? 'fsel on' : 'fsel'}>
          <span className="fsel-l">{f.label}</span>
          <select value={p.filters[f.key]} onChange={(e) => { p.onFilter(f.key, e.target.value); }}>
            <option value="">전체</option>
            {f.options(p.nodes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      ))}
      <button type="button" className="btn ghost sm" onClick={p.onReset} disabled={p.noFilter}>필터 초기화</button>
      <span className="tb-sp" />
      <div className="tb-group" ref={group}>
        <div className="fsel">
          <span className="fsel-l" id="wbs-view-l">보기</span>
          <div className="seg" role="group" aria-labelledby="wbs-view-l">
            {([['table', '표'], ['gantt', '일정 (Gantt)']] as const).map(([k, l]) => (
              <button key={k} type="button" aria-pressed={p.view === k} onClick={() => { p.onView(k); }}>{l}</button>
            ))}
          </div>
        </div>
        <label className="fsel">
          <span className="fsel-l">정렬 (Work Package 내)</span>
          <select value={p.sort} onChange={(e) => { p.onSort(e.target.value as SortKey); }}>
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <button type="button" className="btn sm" onClick={p.onExpandAll}>모두 펼치기</button>
        <button type="button" className="btn sm" onClick={p.onCollapseAll}>모두 접기</button>
        <button type="button" className="btn sm" onClick={() => { setColMenu((x) => !x); }} aria-expanded={colMenu}>컬럼</button>
        {colMenu && (
          <div className="colmenu" role="group" aria-label="표시할 컬럼">
            <div className="colmenu-n">표시할 컬럼 · WBS 번호와 Task 제목은 항상 표시</div>
            {COLS.map((c) => (
              <label key={c.key}><input type="checkbox" className="chk" checked={p.cols.has(c.key)} onChange={() => { p.onToggleCol(c.key); }} />{c.label}</label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
