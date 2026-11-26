/**
 * Planning 화면(UI-05). 원본 P L1614–1685, 로직 P L5949–5987.
 *
 * - 탭 두 개: Planning 세션(UI-05-01) · 일정 재조정 이력(UI-05-02). 탭과 고른 세션은 주소(`?tab=replans`, `?session=<id>`)에 둔다.
 *   왜: 새로고침·뒤로 가기·링크(변경 제안의 「출처」 버튼)로 같은 화면을 다시 열기 위해서.
 * - 이견 조정 메모는 저장 전 초안이다. 편집 보호(useEditGuard)는 이 화면에 하나만 두고, 메모 초안은 검토 id로 모은다(배열 위치 아님).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useApiQuery } from '../../shared/api/queries.ts';
import { MenuScreen, useRefreshError } from '../../shared/layout/MenuScreen.tsx';
import { Page } from '../../shared/layout/Page.tsx';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { AreaLoading } from '../../shared/ui/loading.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import { useTaskInfo } from '../change/ChangePage.tsx';
import { PAGE_LIMIT } from '../change/find.ts';
import { planStep } from './model.ts';
import { ReplanTab } from './ReplanTab.tsx';
import { SessionView } from './SessionView.tsx';
import '../change/change.css';

const SUB = 'Codex · Claude 독립 분석 → 교차 검토 → 이견 조정 → Change Proposal → (정책) 자동 승인 · WBS 반영 → 일정 자동 재조정';

export function PlanningPage() {
  return <MenuScreen menu="planning">{(project) => <PlanningBody projectId={'id' in project ? String(project.id) : ''} />}</MenuScreen>;
}

function PlanningBody({ projectId }: { projectId: string }) {
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const tab = search.get('tab') === 'replans' ? 'replans' : 'sessions';
  const plannings = useApiQuery('listPlannings', { query: { limit: PAGE_LIMIT } }, { topics: ['planning', 'proposal'] });
  useRefreshError(plannings, 'Planning 최신 내용 불러오기');
  const proposals = useApiQuery('listProposals', { query: { limit: PAGE_LIMIT } }, { topics: ['proposal'] });
  const tasks = useTaskInfo(projectId);
  /** 검토 id → 저장하지 않은 조정 메모 */
  const [memos, setMemos] = useState<Record<string, string>>({});
  const dirty = Object.keys(memos).length > 0;
  const { guard } = useEditGuard(dirty);

  const items = plannings.data?.items ?? [];
  const selected = items.find((p) => p.id === search.get('session')) ?? items[0];
  const { restoreOffer } = useSessionDraft({
    id: `planning:${selected?.id ?? 'none'}:memos`,
    label: `Planning ${selected?.title ?? ''} 조정 메모`,
    value: dirty ? memos : null,
    onRestore: (data: Record<string, string>) => { setMemos(data); },
  });

  const cpOf = (proposalId: string | null) => proposals.data?.items.find((cp) => cp.id === proposalId) ?? null;
  // 메모 초안을 버린 화면이 그려진 다음에 주소를 바꾼다. 같은 처리에서 바꾸면 편집 보호가 옛 dirty로 다시 묻는다.
  const nextSearch = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    if (nextSearch.current === null || dirty) return;
    const next = nextSearch.current;
    nextSearch.current = null;
    setSearch(next);
  }, [dirty, setSearch]);
  const go = (next: Record<string, string>) => {
    void guard(() => {
      if (!dirty) { setSearch(next); return; }
      nextSearch.current = next;
      setMemos({});
    });
  };

  if (plannings.data === undefined && plannings.isError) {
    return <LoadError title="Planning" error={plannings.error} retrying={plannings.isFetching} onRetry={() => { void plannings.refetch(); }} />;
  }
  return (
    <Page title="Planning" sub={SUB}>
      <div className="seg pgtabs" role="group" aria-label="Planning 보기">
        <button type="button" aria-pressed={tab === 'sessions'} onClick={() => { go(selected ? { session: selected.id } : {}); }}>Planning 세션</button>
        <button type="button" aria-pressed={tab === 'replans'} onClick={() => { go({ tab: 'replans' }); }}>일정 재조정 이력</button>
      </div>
      {tab === 'replans' && <ReplanTab tasks={tasks} />}
      {tab === 'sessions' && plannings.data === undefined && <AreaLoading label="Planning 세션 불러오는 중" />}
      {tab === 'sessions' && plannings.data !== undefined && items.length === 0 && (
        <section className="card"><p className="empty" style={{ margin: 0 }}>Planning 세션이 없습니다. 입력 자료를 갱신하거나 팀장 지시가 있으면 Planning Agent가 세션을 만듭니다.</p></section>
      )}
      {tab === 'sessions' && selected && (
        <div className="two">
          <aside className="side" aria-label="Planning 목록">
            {items.map((p) => {
              const cp = cpOf(p.proposalId);
              return (
                <button key={p.id} type="button" className={p.id === selected.id ? 'side-i on' : 'side-i'} aria-current={p.id === selected.id ? 'true' : undefined}
                  onClick={() => { go({ session: p.id }); }}>
                  <span className="side-t">{p.title}</span>
                  <span className="muted">{planStep(p.reviews, cp ? String(cp.status) : null).label}</span>
                </button>
              );
            })}
          </aside>
          <div className="mainc">
            {restoreOffer}
            <SessionView
              key={selected.id}
              planning={selected}
              cp={cpOf(selected.proposalId)}
              tasks={tasks}
              memos={memos}
              setMemo={(rid, memo) => { setMemos((m) => (memo === null ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== rid)) : { ...m, [rid]: memo })); }}
              openCp={(cpKey) => { void navigate(`/change/${cpKey}`); }}
            />
          </div>
        </div>
      )}
    </Page>
  );
}
