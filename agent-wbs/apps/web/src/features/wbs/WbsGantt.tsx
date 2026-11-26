/**
 * Gantt 보기(UI-03C, 원본 P L899–921). 전체 기간을 화면 폭에 맞춰 그린다(가로 스크롤·일/주 확대 없음, G§4.3).
 * 위 막대 = 기준 일정, 아래 막대 = 완료 예상(진행 중이면 진행률 채움), 가는 선 = 낙관~비관, 빨간 선 = 현재, 보라 점선 = 목표일.
 * 표와 같은 가상 스크롤을 쓴다.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { GroupCaret } from './WbsTable.tsx';
import { fmtH, ganttGeometry, planCell, type Row, type ScheduleData, type SchedTask, type Span } from './model.ts';

const ROW_GRID = 'minmax(200px,300px) minmax(0,1fr)';
const spanStyle = (s: Span | null): CSSProperties => (s ? { left: s.left, width: s.width } : { display: 'none' });

export function WbsGantt({ rows, schedule, now, selected, onOpen, onToggle, empty, scrollRef }: {
  rows: Row[];
  schedule: ScheduleData;
  now: number;
  selected: string | null;
  onOpen: (taskKey: string) => void;
  onToggle: (nodeId: string) => void;
  empty: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const g = ganttGeometry(schedule, now);
  const sched = new Map<string, SchedTask>(schedule.tasks.map((t) => [t.taskKey, t]));
  // eslint-disable-next-line react-hooks/incompatible-library -- 가상 스크롤 hook은 매 렌더 새 값을 돌려준다(메모 대상 아님).
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'group' ? 40 : 53),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
    // 상세가 열려 표가 숨겨진(display:none) 동안 행 높이가 0으로 재어지면, 다시 보일 때 위치가 어긋난다. 0이면 이전 값을 쓴다.
    measureElement: (el, _entry, instance) => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) return h;
      const i = Number(el.getAttribute('data-index'));
      return instance.measurementsCache[i]?.size ?? instance.options.estimateSize(i);
    },
    scrollMargin: 31,
  });
  const items = virtualizer.getVirtualItems();
  const margin = virtualizer.options.scrollMargin;
  const first = items[0];
  const last = items.at(-1);
  const top = first ? first.start - margin : 0;
  // 상자가 숨겨져(상세 열림) 그릴 행이 없을 때도 전체 높이를 유지한다. 그래야 다시 보일 때 스크롤 위치를 되살릴 수 있다.
  const bottom = last ? Math.max(0, virtualizer.getTotalSize() - (last.end - margin)) : virtualizer.getTotalSize();
  const track: CSSProperties = { backgroundSize: g.trackSize };
  const lines = (
    <>
      <span className="g-today" style={{ left: `${g.today.toFixed(3)}%` }} />
      <span className="g-tgt" style={g.target === null ? { display: 'none' } : { left: `${g.target.toFixed(3)}%` }} />
    </>
  );

  return (
    <>
      <div ref={scrollRef} className="tbl gantt" role="table" aria-label="WBS 일정 (Gantt)" aria-rowcount={rows.length + 1}>
        <div className="g-row g-head" style={{ gridTemplateColumns: ROW_GRID }} role="row" aria-rowindex={1}>
          <span className="g-lab th" role="columnheader">Task <span className="muted" style={{ fontWeight: 400 }}>— 위: 기준 · 아래: 실제 / 예상</span></span>
          <span className="g-days" style={{ gridTemplateColumns: `repeat(${String(g.D)}, minmax(0,1fr))` }} role="columnheader" aria-label="날짜">
            {g.days.map((d) => <span key={d.date} className={d.cls} title={d.tip}>{d.label}</span>)}
          </span>
        </div>
        <div className="vbody" role="rowgroup" style={{ paddingTop: top, paddingBottom: bottom }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            if (row.kind === 'group') {
              const sum = g.group(row.taskKeys);
              return (
                <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className={`g-row grp ${row.node.kind === 'phase' ? 'ph' : 'wp'}`} style={{ gridTemplateColumns: ROW_GRID }} role="row" aria-rowindex={item.index + 2}>
                  <span className="g-lab" style={{ paddingLeft: 6 + row.depth * 22 }} role="cell">
                    <GroupCaret row={row} onToggle={onToggle} />
                    <span className="mono muted">{row.node.wbsPath}</span><span className="grp-n">{row.node.title}</span><span className="muted">{row.pct}%</span>
                  </span>
                  <span className="g-track" style={track} role="cell">{lines}{sum && <span className="g-sum" style={spanStyle(sum)} />}</span>
                </div>
              );
            }
            const t = row.task;
            const bar = g.task(t.taskKey);
            const sc = sched.get(t.taskKey);
            const plan = planCell(t, sc);
            const pct = sc?.progressPct ?? 0;
            return (
              <div
                key={item.key} data-index={item.index} ref={virtualizer.measureElement}
                className={row.key === selected ? 'g-row task sel' : 'g-row task'} style={{ gridTemplateColumns: ROW_GRID }} role="row" aria-rowindex={item.index + 2}
                onClick={() => { onOpen(row.key); }}
              >
                <span className="g-lab" style={{ paddingLeft: 40 }} role="cell">
                  <button type="button" className="tlink" onClick={(event) => { event.stopPropagation(); onOpen(t.taskKey); }}>{t.title}</button>
                  <span className="tid mono">{t.taskKey} · {sc ? fmtH(sc.estHours) : '—'} · {t.assigneeAgent ?? '—'} · <span className={plan.scC}>{plan.scL}</span></span>
                </span>
                <span className="g-track" style={track} role="cell">
                  {lines}
                  <span className="g-plan" style={spanStyle(bar.plan)} title={bar.planTip} />
                  <span className="g-range" style={spanStyle(bar.range)} title={bar.fcTip} />
                  <span className={bar.cls} style={sc ? spanStyle(bar.fc) : { display: 'none' }} title={bar.fcTip}><span className="g-fill" style={{ width: `${String(pct)}%` }} /></span>
                </span>
              </div>
            );
          })}
        </div>
        {rows.length === 0 && empty}
      </div>
      <div className="g-legend">
        <span className="muted">전체 기간을 화면 폭에 맞춰 표시</span>
        <span><i className="lg lg-plan" />기준 일정 (최신 버전)</span>
        <span><i className="lg lg-done" />실제 — 완료</span>
        <span><i className="lg lg-run" />진행 중 · 완료 예상 (진행률 채움)</span>
        <span><i className="lg lg-fc" />완료 예상 — 미착수</span>
        <span><i className="lg lg-range" />낙관 ~ 비관 범위</span>
        <span><i className="lg lg-bk" />작업 불가일</span>
        <span><i className="lg lg-today" />현재</span>
        <span><i className="lg lg-tgt" />목표일</span>
        <span className="muted">관측 가동률 · 동시 실행 슬롯 · 사용량 리셋 · 작업 불가일로 자동 환산 — 상단 「위: 기준 / 아래: 예상」</span>
      </div>
    </>
  );
}
