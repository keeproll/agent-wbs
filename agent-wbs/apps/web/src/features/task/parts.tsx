/** Task 상세 여러 탭이 함께 쓰는 읽기 부품(원본 마크업 그대로). */
import { cellText, readGrid, segs, type Col } from './labels.ts';

/** `백틱` 부분을 <code>로(P L1095 등) */
export function Segs({ text }: { text: string }) {
  return <>{segs(text).map((s, i) => (s.code ? <code key={i}>{s.t}</code> : <span key={i}>{s.t}</span>))}</>;
}

/** 줄 목록. 비면 「미작성」(P L5212 lst) */
export function Lines({ items, mono = false, ordered = false }: { items: string[]; mono?: boolean; ordered?: boolean }) {
  if (!items.length) return <ul className="lst"><li className="empty">미작성</li></ul>;
  const lis = items.map((x, i) => <li key={i}><Segs text={x} /></li>);
  return ordered ? <ol className="lst">{lis}</ol> : <ul className={mono ? 'lst mono-list' : 'lst'}>{lis}</ul>;
}

/** 원본 읽기 표 `.gt-wrap > .gt`(P L5432 readTable) */
export function ReadTable({ cols, rows, label }: { cols: Col[]; rows: Record<string, unknown>[]; label?: string }) {
  return (
    <div className="gt-wrap" role="region" aria-label={label} tabIndex={0}>
      <div className="gt" role="table" aria-label={label} style={{ gridTemplateColumns: readGrid(cols) }}>
        {cols.map((c) => <span key={c.k} className="gth" role="columnheader">{c.l}</span>)}
        {rows.map((r, ri) => cols.map((c) => <span key={`${String(ri)}-${c.k}`} className={`gtd ${c.b ? 'b' : c.mono ? 'm' : ''}`} role="cell">{cellText(c, r)}</span>))}
      </div>
    </div>
  );
}

/** 짧은 값 표시(P L5367 short): 줄바꿈은 「 / 」, 40자 넘으면 줄임 */
export const short = (v: unknown) => {
  const x = (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)).replace(/\n/g, ' / ');
  return x.length > 40 ? `${x.slice(0, 40)}…` : x || '없음';
};
