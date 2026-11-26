/** Task 상세 여러 탭이 함께 쓰는 읽기 부품(원본 마크업 그대로). */
import { Component, type ReactNode } from 'react';
import type { ApiError } from '../../shared/api/client.ts';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { causeMessage, codeLabel } from '../../shared/ui/errors.ts';
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
    // 가로 스크롤 상자는 키보드로도 밀 수 있게 tabIndex만 둔다(같은 이름의 region이 반복되지 않게, 리뷰 R7).
    <div className="gt-wrap" tabIndex={0}>
      <div className="gt" role="table" aria-label={label} style={{ gridTemplateColumns: readGrid(cols) }}>
        {/* 원본 .gt는 칸이 grid의 바로 아래 자식이다. 행 묶음은 display:contents로 모양을 바꾸지 않고 row 역할만 준다(리뷰 R7). */}
        <div role="row" style={{ display: 'contents' }}>{cols.map((c) => <span key={c.k} className="gth" role="columnheader">{c.l}</span>)}</div>
        {rows.map((r, ri) => <div role="row" key={ri} style={{ display: 'contents' }}>{cols.map((c) => <span key={c.k} className={`gtd ${c.b ? 'b' : c.mono ? 'm' : ''}`} role="cell">{cellText(c, r)}</span>)}</div>)}
      </div>
    </div>
  );
}

/** 짧은 값 표시(P L5367 short): 줄바꿈은 「 / 」, 40자 넘으면 줄임 */
export const short = (v: unknown) => {
  const x = (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)).replace(/\n/g, ' / ');
  return x.length > 40 ? `${x.slice(0, 40)}…` : x || '없음';
};

/**
 * 탭 안 목록 읽기 실패(리뷰 R6) — 「불러오는 중」에 머물지 않고 원인과 「다시 시도」를 보인다.
 * 원본 불러오기 실패 카드(SYS-01, `.card.load-err`)와 같은 모양이다. 다른 탭·머리는 계속 쓸 수 있다.
 */
export function ListError({ label, error, retrying, onRetry }: { label: string; error: ApiError; retrying: boolean; onRetry: () => void }) {
  return (
    <section className="card load-err" role="alert" aria-label={`${label} 불러오기 실패`}>
      <h4 style={{ margin: '0 0 6px' }}>{label}을(를) 불러오지 못했습니다</h4>
      <p style={{ margin: 0 }}>{causeMessage(error, false)} ({codeLabel(error)})</p>
      <div className="form-acts" style={{ justifyContent: 'flex-start' }}>
        <BusyButton small busy={retrying} busyLabel="다시 불러오는 중…" onClick={onRetry}>다시 시도</BusyButton>
      </div>
    </section>
  );
}

/**
 * 탭 하나를 그리다 예외가 나도 앱 전체가 아니라 그 탭에만 안내를 보인다(리뷰 R4).
 * 왜: 서버가 검사하지 않은 잘못된 데이터 하나로 메뉴까지 「Unexpected Application Error」가 되면 다른 일을 할 수 없다.
 * resetKey(탭·Task)가 바뀌면 다시 그려 본다.
 */
export class TabBoundary extends Component<{ resetKey: string; onRetry: () => void; children: ReactNode }, { failed: boolean; key: string }> {
  override state = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { failed: boolean; key: string }) {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="card load-err" role="alert" aria-label="탭 표시 실패">
        <h4 style={{ margin: '0 0 6px' }}>이 탭을 표시하지 못했습니다</h4>
        <p style={{ margin: 0 }}>서버에서 받은 데이터가 예상한 모양이 아닙니다. 다른 탭과 메뉴는 계속 쓸 수 있습니다. 다시 시도해도 같으면 관리자에게 알려 주세요.</p>
        <div className="form-acts" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="btn primary sm" onClick={() => { this.setState({ failed: false }); this.props.onRetry(); }}>다시 시도</button>
        </div>
      </section>
    );
  }
}
