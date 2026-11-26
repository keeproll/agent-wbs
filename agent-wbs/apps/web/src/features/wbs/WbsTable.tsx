/**
 * Tree Table(UI-03B, 원본 P L842–898) + 가상 스크롤.
 * 화면에 보이는 행(과 위아래 여유 8행)만 그린다. 보이지 않는 행 높이는 위·아래 padding이 대신한다.
 * 왜: 200~1,000행을 모두 그리면 처음 그리기·스크롤이 느려진다(G§9.2-5).
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ReactNode, RefObject } from 'react';
import { SmIcon, StatusPill, WBS_ICON } from './cells.tsx';
import {
  COLS, gridColumns, minTableWidth, priorityOf, taskCells, TYPE_LABEL, verifOf,
  type ColKey, type GroupRow, type Row, type SchedTask, type TaskSummary,
} from './model.ts';

export interface TableProps {
  rows: Row[];
  cols: ReadonlySet<ColKey>;
  byKey: ReadonlyMap<string, TaskSummary>;
  sched: ReadonlyMap<string, SchedTask>;
  selected: string | null;
  onOpen: (taskKey: string) => void;
  onToggle: (nodeId: string) => void;
  empty: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
}

const GROUP_GRID = '60px minmax(0,1fr)';

export function GroupCaret({ row, onToggle }: { row: GroupRow; onToggle: (id: string) => void }) {
  return (
    <button
      type="button"
      className={row.open ? 'caret open' : 'caret'}
      aria-label={`${row.open ? '접기' : '펼치기'}: ${row.node.title}`}
      aria-expanded={row.open}
      // 캐럿은 Task 선택을 바꾸지 않는다(UAT-WBS-02).
      onClick={(event) => { event.stopPropagation(); onToggle(row.node.id); }}
    >
      <SmIcon d={WBS_ICON.caret} />
    </button>
  );
}

function GroupLine({ row, onToggle }: { row: GroupRow; onToggle: (id: string) => void }) {
  const phase = row.node.kind === 'phase';
  return (
    <>
      <span className="td mono wbsno" role="cell">{row.node.wbsPath}</span>
      <span className="td grp-t" style={{ paddingLeft: 6 + row.depth * 22 }} role="cell">
        <GroupCaret row={row} onToggle={onToggle} />
        <span className="grp-k">{phase ? 'Phase' : 'Work Package'}</span>
        <span className="grp-n">{row.node.title}</span>
        <span className="grp-agg">{row.agg}</span>
        <span className="bar"><span className="bar-f" style={{ width: `${String(row.pct)}%` }} /></span>
        {row.win && <span className={row.win.cls}>{row.win.text}</span>}
      </span>
    </>
  );
}

function TaskLine({ task, cols, byKey, sched, onOpen }: { task: TaskSummary; cols: ReadonlySet<ColKey>; byKey: TableProps['byKey']; sched: TableProps['sched']; onOpen: TableProps['onOpen'] }) {
  const c = taskCells(task, byKey, sched.get(task.taskKey));
  const v = verifOf(task.verifState);
  const p = priorityOf(task.priority);
  return (
    <>
      <span className="td mono wbsno" role="cell">{task.wbsPath}</span>
      <span className="td tcell" style={{ paddingLeft: 40 }} role="cell">
        <button type="button" className="tlink" onClick={(event) => { event.stopPropagation(); onOpen(task.taskKey); }}>{task.title}</button>
        <span className="tid mono">{task.taskKey}</span>
      </span>
      {cols.has('kind') && (
        <span className="td" role="cell"><span className="cell2">
          <span className="wt">{TYPE_LABEL[String(task.workType)] ?? String(task.workType)}</span>
          <span><span className="dm">{String(task.primaryDomain)}</span>{task.relatedDomains.length > 0 && <span className="dm-rel">+{task.relatedDomains.join(', ')}</span>}</span>
        </span></span>
      )}
      {cols.has('agent') && <span className="td" role="cell"><span className="agent"><span className={c.agent.cls} aria-hidden="true">{c.agent.init}</span>{c.agent.name}</span></span>}
      {cols.has('status') && (
        <span className="td" role="cell"><span className="cell2"><StatusPill status={task.lifecycleStatus} /><span className={`vf ${v.c}`}>검증 {v.l}</span></span></span>
      )}
      {cols.has('priority') && <span className="td" role="cell"><span className={`pri ${p.c}`}>{p.l}</span></span>}
      {cols.has('preds') && (
        <span className="td cell2" role="cell">
          {c.preds.kind === 'none' && <span className="muted">없음</span>}
          {c.preds.kind === 'blocked' && <span className="blk" title={c.preds.tip}><SmIcon d={WBS_ICON.lock} />차단 · {c.preds.label}</span>}
          {c.preds.kind === 'ok' && <span className="okt" title={c.preds.tip}><SmIcon d={WBS_ICON.check} />충족 {c.preds.count}건</span>}
        </span>
      )}
      {cols.has('pct') && (
        <span className="td" role="cell"><span className="cl">
          <span className="cl-n">{c.pctL}</span>
          <span className={c.pct === 100 ? 'bar full' : 'bar'}><span className="bar-f" style={{ width: `${String(c.pct)}%` }} /></span>
          <span className="tid">체크 {c.checklist}</span>
        </span></span>
      )}
      {cols.has('plan') && (
        <span className="td" role="cell" title={c.plan.tip}><span className="tcell">
          <span className="mono" style={{ fontWeight: 600 }}>{c.plan.planL}</span>
          <span className={c.plan.scC}>{c.plan.scL}</span>
          <span className="tid">{c.plan.rangeL}</span>
        </span></span>
      )}
      {cols.has('est') && <span className="td" role="cell"><span className="tcell"><span className="mono">{c.est.estL}</span><span className="tid">{c.est.estR}</span></span></span>}
      {cols.has('updated') && <span className="td" role="cell"><span className="upd mono">{task.updatedAt.slice(5, 16).replace('T', ' ')}</span></span>}
    </>
  );
}

export function WbsTable({ rows, cols, byKey, sched, selected, onOpen, onToggle, empty, scrollRef }: TableProps) {
  const grid = gridColumns(cols);
  // eslint-disable-next-line react-hooks/incompatible-library -- 가상 스크롤 hook은 매 렌더 새 값을 돌려준다(메모 대상 아님).
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'group' ? 43 : 75),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
    // 상세가 열려 표가 숨겨진(display:none) 동안 행 높이가 0으로 재어지면, 다시 보일 때 위치가 어긋난다. 0이면 이전 값을 쓴다.
    measureElement: (el, _entry, instance) => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) return h;
      const i = Number(el.getAttribute('data-index'));
      return instance.measurementsCache[i]?.size ?? instance.options.estimateSize(i);
    },
    // 머리 행(sticky) 높이만큼 목록이 아래에서 시작한다.
    scrollMargin: 34,
  });
  const items = virtualizer.getVirtualItems();
  const margin = virtualizer.options.scrollMargin;
  const first = items[0];
  const last = items.at(-1);
  const top = first ? first.start - margin : 0;
  // 상자가 숨겨져(상세 열림) 그릴 행이 없을 때도 전체 높이를 유지한다. 그래야 다시 보일 때 스크롤 위치를 되살릴 수 있다.
  const bottom = last ? Math.max(0, virtualizer.getTotalSize() - (last.end - margin)) : virtualizer.getTotalSize();

  return (
    <div ref={scrollRef} className="tbl" role="table" aria-label="WBS Task 목록" aria-rowcount={rows.length + 1}>
      <div className="tbl-in" style={{ minWidth: minTableWidth(cols) }}>
        <div className="trow thead" style={{ gridTemplateColumns: grid }} role="row" aria-rowindex={1}>
          <span className="th" role="columnheader">WBS</span>
          <span className="th" role="columnheader">Task</span>
          {COLS.filter((c) => cols.has(c.key)).map((c) => <span key={c.key} className="th" role="columnheader" title={c.title}>{c.head}</span>)}
        </div>
        <div className="vbody" role="rowgroup" style={{ paddingTop: top, paddingBottom: bottom }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            if (row.kind === 'group') {
              return (
                <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className={`trow grp ${row.node.kind === 'phase' ? 'ph' : 'wp'}`} style={{ gridTemplateColumns: GROUP_GRID }} role="row" aria-rowindex={item.index + 2}>
                  <GroupLine row={row} onToggle={onToggle} />
                </div>
              );
            }
            return (
              <div
                key={item.key} data-index={item.index} ref={virtualizer.measureElement}
                className={row.key === selected ? 'trow task sel' : 'trow task'} style={{ gridTemplateColumns: grid }} role="row" aria-rowindex={item.index + 2}
                onClick={() => { onOpen(row.key); }}
              >
                <TaskLine task={row.task} cols={cols} byKey={byKey} sched={sched} onOpen={onOpen} />
              </div>
            );
          })}
        </div>
        {rows.length === 0 && empty}
      </div>
    </div>
  );
}
