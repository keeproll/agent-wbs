/**
 * 이력(UI-10) — 원본 P L1972–1991을 그대로 옮기고, 원본에 없던 기간 필터(MM-18, G L336)를 더한 화면.
 *
 * - 필터는 모두 주소(`/history?from=2026-11-01&kind=실행`)에 둔다. 새로고침·뒤로 가기·링크 공유에도 같은 조건이 열린다(MM-29).
 * - 기간은 서버(GET /api/history?from&to)가 거른다. 나머지는 받은 기간 안에서 화면이 거른다(model.ts 머리말).
 * - 「기록 없음」(조건 없이 0건)과 「조건 불일치」(조건이 있는데 0건)를 다른 문구로 보인다(UAT-HISTORY-01, UAT-EMPTY-04).
 */
import type { ChangeEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAllPages } from '../../shared/api/allPages.ts';
import { formatDateTime } from '../../shared/format.ts';
import { MenuScreen, useRefreshError, useRevisitFetching } from '../../shared/layout/MenuScreen.tsx';
import { Page } from '../../shared/layout/Page.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import { PageSkeleton, useDelayedFlag } from '../../shared/ui/loading.tsx';
import { TableScroll } from '../../shared/ui/TableScroll.tsx';
import { useTopBar } from '../../shared/ui/feedback.tsx';
import { LINK } from '../verify/labels.ts';
import '../verify/screens.css';
import {
  countLabel, diffText, EMPTY_HISTORY_FILTER, filterHistory, historyOptions, isFiltered, MAX_ROWS, rangeProblem, type HistoryFilter,
} from './model.ts';

/** 원본 열 폭(P hGrid L6453) */
const H_GRID = '148px 96px 96px 110px minmax(220px,1fr) minmax(160px,260px)';
const KEYS = Object.keys(EMPTY_HISTORY_FILTER) as (keyof HistoryFilter)[];
const TITLE = '이력';
const SUB = 'Task 생성 · 수정 · 상태 · 선행 관계 · 체크리스트 · 실행 · 검증 · 승인 · 재계획 이력 — 최신순';

export function HistoryPage() {
  return <MenuScreen menu="history">{() => <HistoryBody />}</MenuScreen>;
}

function useHistoryFilter(): [HistoryFilter, (patch: Partial<HistoryFilter>) => void, () => void] {
  const [params, setParams] = useSearchParams();
  const filter = Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? ''])) as unknown as HistoryFilter;
  const set = (patch: Partial<HistoryFilter>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
      return next;
    }, { replace: true });
  };
  return [filter, set, () => { setParams({}, { replace: true }); }];
}

function HistoryBody() {
  const [f, set, reset] = useHistoryFilter();
  const problem = rangeProblem(f.from, f.to);
  const query = { ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}) };
  const hist = useAllPages('listHistory', { query }, {
    topics: ['task', 'dependency', 'attempt', 'verification', 'message', 'proposal', 'planning', 'schedule'],
    enabled: problem === null,
  });
  const skeleton = useDelayedFlag(hist.isPending && hist.fetchStatus === 'fetching');
  useTopBar(useRevisitFetching(hist));
  useRefreshError(hist, '이력 최신 내용 불러오기');

  if (hist.data === undefined && hist.isError) {
    return <LoadError title={TITLE} error={hist.error} retrying={hist.isFetching} onRetry={() => { void hist.refetch(); }} />;
  }
  if (hist.data === undefined && problem === null) return <div className="page scroll">{skeleton && <PageSkeleton menu="history" />}</div>;

  const all = hist.data?.items ?? [];
  const rows = filterHistory(all, f);
  const opts = historyOptions(all);
  const withSelected = (list: string[], v: string) => (v && !list.includes(v) ? [...list, v] : list);
  const filtered = isFiltered(f);
  const seg = (key: 'kind' | 'actor', list: string[]) => ['', ...withSelected(list, f[key])].map((k) => (
    <button key={k || '전체'} type="button" aria-pressed={f[key] === k} onClick={() => { set({ [key]: k }); }}>{k || '전체'}</button>
  ));
  const text = (key: keyof HistoryFilter) => (e: ChangeEvent<HTMLInputElement>) => { set({ [key]: e.target.value }); };

  return (
    <Page title={TITLE} sub={SUB}>
      <div className="toolbar" style={{ borderRadius: '8px 8px 0 0' }} role="search" aria-label="이력 필터">
        <label className="search">
          <svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" /></svg>
          <span className="sr">변경 내용 검색</span>
          <input type="search" placeholder="변경 내용 · 값 검색" value={f.q} onChange={text('q')} />
        </label>
        <label className="fsel"><span className="fsel-l">Task ID</span>
          <input className="inp mono-in" style={{ width: 140 }} placeholder="TASK-0007" value={f.task} onChange={text('task')} />
        </label>
        <label className="fsel"><span className="fsel-l">기간 시작</span>
          <input className="inp hist-date" type="date" value={f.from} onChange={text('from')} aria-invalid={problem !== null || undefined} />
        </label>
        <label className="fsel"><span className="fsel-l">기간 끝</span>
          <input className="inp hist-date" type="date" value={f.to} onChange={text('to')} aria-invalid={problem !== null || undefined} />
        </label>
        <button type="button" className="btn ghost sm" onClick={reset} disabled={!filtered}>필터 초기화</button>
        {problem && <span className="fhint" role="alert" style={{ color: 'var(--dg)' }}>{problem} 기간을 고치면 다시 불러옵니다.</span>}
        <div className="fbar" style={{ width: '100%', margin: 0 }}><span className="muted">유형</span><div className="seg" role="group" aria-label="유형">{seg('kind', opts.kinds)}</div></div>
        <div className="fbar" style={{ width: '100%', margin: 0 }}><span className="muted">주체</span><div className="seg" role="group" aria-label="주체">{seg('actor', opts.actors)}</div></div>
      </div>
      <div className="resbar" role="status">{countLabel(rows.length, all.length)}{hist.data?.truncated ? ' · 너무 많아 일부만 불러옴' : ''}</div>
      <TableScroll minWidth={880} label="이력 표">
        <div className="gtb" style={{ borderTop: 0, borderRadius: '0 0 8px 8px' }} role="table" aria-label="이력">
          <div className="gtr h" role="row" style={{ gridTemplateColumns: H_GRID }}>
            {['시각', '주체', '유형', 'Task', '변경 내용', '이전 → 이후'].map((h) => <span key={h} className="gc" role="columnheader">{h}</span>)}
          </div>
          {rows.slice(0, MAX_ROWS).map((h) => (
            <div key={h.id} className="gtr" role="row" style={{ gridTemplateColumns: H_GRID }}>
              <span className="gc mono" role="cell">{formatDateTime(h.at)}</span>
              <span className="gc" role="cell">{h.actor}</span>
              <span className="gc" role="cell"><span className="tag">{h.kind}</span></span>
              <span className="gc" role="cell">{h.taskKey ? <Link className="reflink" to={LINK.task(h.taskKey, 'hist')} title={`${h.taskKey} 이력 탭 열기`}>{h.taskKey}</Link> : <span className="muted">—</span>}</span>
              <span className="gc" role="cell">{h.text}</span>
              <span className="gc mono" role="cell">{diffText(h)}</span>
            </div>
          ))}
          {rows.length === 0 && (filtered || problem) ? (
            <div className="gtr" role="row" data-empty="filtered">
              <span className="gc muted" role="cell">조건에 맞는 이력이 없습니다. 필터를 바꿔 보세요. <button type="button" className="btn sm" onClick={reset}>필터 초기화</button></span>
            </div>
          ) : rows.length === 0 && (
            <div className="gtr" role="row" data-empty="none">
              <span className="gc muted" role="cell">아직 이력이 없습니다. Task를 만들거나 상태 · 실행 · 검증 · 승인이 바뀌면 여기에 최신순으로 기록됩니다.</span>
            </div>
          )}
        </div>
      </TableScroll>
    </Page>
  );
}
