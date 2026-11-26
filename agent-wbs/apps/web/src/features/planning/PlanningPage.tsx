/**
 * Planning 화면(UI-05). 원본 P L1614–1685, 로직 P L5949–5987.
 *
 * - 탭 두 개: Planning 세션(UI-05-01) · 일정 재조정 이력(UI-05-02). 탭과 고른 세션은 주소(`?tab=replans`, `?session=<id>`)에 둔다.
 *   왜: 새로고침·뒤로 가기·링크(변경 제안의 「출처」 버튼)로 같은 화면을 다시 열기 위해서.
 * - 이견 조정 메모는 저장 전 초안이다. 편집 보호(useEditGuard)는 이 화면에 하나만 두고, 메모 초안은 검토 id로 모은다(배열 위치 아님).
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { useApiQuery } from '../../shared/api/queries.ts';
import { MenuScreen, useRefreshError } from '../../shared/layout/MenuScreen.tsx';
import { Page } from '../../shared/layout/Page.tsx';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { AreaLoading } from '../../shared/ui/loading.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import { useTaskInfo } from '../change/ChangePage.tsx';
import { findInPages, findProposal, PAGE_LIMIT } from '../change/find.ts';
import type { Proposal } from '../change/types.ts';
import { planStep, type Planning } from './model.ts';
import { ReplanTab } from './ReplanTab.tsx';
import { SessionView } from './SessionView.tsx';
import '../change/change.css';
import { LINK } from '../../shared/links.ts';

const SUB = 'Codex · Claude 독립 분석 → 교차 검토 → 이견 조정 → Change Proposal → (정책) 자동 승인 · WBS 반영 → 일정 자동 재조정';

/** 세션에 연결된 CP 상태. found 외에는 조정·CP 작성을 잠근다(missing은 서버가 연결을 기록했지만 CP를 찾지 못한 경우). */
export type LinkedCp =
  | { kind: 'none' }
  | { kind: 'found'; cp: Proposal }
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; retry: () => void };

const useProposalList = () => useApiQuery('listProposals', { query: { limit: PAGE_LIMIT } }, { topics: ['proposal'] });

/**
 * 세션에 연결된 CP의 상태. 최근 목록에 없으면 끝까지 찾는다. 읽는 중·실패는 「CP 없음」과 구별한다.
 * 왜: 「없음」으로 보면 완료된 세션의 조정·작성이 다시 열려 같은 변경의 CP가 또 만들어진다(독립 리뷰 ca3902d #2).
 */
function useLinkedProposal(proposalId: string | null, proposals: ReturnType<typeof useProposalList>): LinkedCp {
  const { client } = useApi();
  const listed = proposalId ? proposals.data?.items.find((cp) => cp.id === proposalId) : undefined;
  const found = useQuery({
    queryKey: ['findProposal', proposalId ?? ''],
    queryFn: ({ signal }) => findProposal((query) => client.call('listProposals', { query, signal }), proposalId ?? ''),
    enabled: proposalId !== null && proposals.data !== undefined && !listed,
    meta: { topics: ['proposal'] },
  });
  if (proposalId === null) return { kind: 'none' };
  if (listed) return { kind: 'found', cp: listed };
  if (found.data) return { kind: 'found', cp: found.data };
  if (proposals.isError && proposals.data === undefined) return { kind: 'error', retry: () => { void proposals.refetch(); } };
  if (found.isError) return { kind: 'error', retry: () => { void found.refetch(); } };
  if (found.data === null) return { kind: 'missing' };
  return { kind: 'loading' };
}

export function PlanningPage() {
  return <MenuScreen menu="planning">{(project) => <PlanningBody projectId={'id' in project ? String(project.id) : ''} />}</MenuScreen>;
}

function PlanningBody({ projectId }: { projectId: string }) {
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const { client } = useApi();
  const tab = search.get('tab') === 'replans' ? 'replans' : 'sessions';
  const plannings = useApiQuery('listPlannings', { query: { limit: PAGE_LIMIT } }, { topics: ['planning', 'proposal'] });
  useRefreshError(plannings, 'Planning 최신 내용 불러오기');
  const proposals = useProposalList();
  const tasks = useTaskInfo(projectId);
  /** 검토 id → 저장하지 않은 조정 메모 */
  const [memos, setMemos] = useState<Record<string, string>>({});
  const dirty = Object.keys(memos).length > 0;
  const { guard } = useEditGuard(dirty);

  const items = plannings.data?.items ?? [];
  const sessionParam = search.get('session');
  // 주소에 세션 id가 있으면 그 세션만 연다. 최근 200건에 없으면 cursor로 끝까지 찾고, 끝까지 없을 때만 「찾지 못함」.
  // 왜: 다른 세션으로 조용히 바꾸면 팀장이 잘못된 분석·판단 근거를 보고 조정·승인한다(독립 리뷰 ca3902d #1).
  const inList = sessionParam ? items.find((p) => p.id === sessionParam) : items[0];
  const deep = useQuery({
    queryKey: ['findPlanning', sessionParam ?? ''],
    queryFn: ({ signal }) => findInPages((query) => client.call('listPlannings', { query, signal }), (p) => p.id === sessionParam),
    enabled: sessionParam !== null && plannings.data !== undefined && !inList,
    meta: { topics: ['planning', 'proposal'] },
  });
  const selected = inList ?? deep.data ?? undefined;
  const sessionMissing = sessionParam !== null && !inList && deep.data === null;
  const cpState = useLinkedProposal(selected?.proposalId ?? null, proposals);
  const { restoreOffer } = useSessionDraft({
    id: `planning:${selected?.id ?? 'none'}:memos`,
    label: `Planning ${selected?.title ?? ''} 조정 메모`,
    value: dirty ? memos : null,
    onRestore: (data: Record<string, string>) => { setMemos(data); },
  });

  const cpOf = (proposalId: string | null) => proposals.data?.items.find((cp) => cp.id === proposalId) ?? null;
  /** 목록 왼쪽의 단계 문구. 연결 CP가 최근 목록 밖이면 상태를 모르니 단계로 추측하지 않는다. */
  const stepLabel = (p: Planning) => {
    const cp = cpOf(p.proposalId);
    if (p.proposalId && !cp) return p.id === selected?.id && cpState.kind === 'found' ? planStep(p.reviews, String(cpState.cp.status)).label : '변경 제안 연결됨';
    return planStep(p.reviews, cp ? String(cp.status) : null).label;
  };
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
      {tab === 'sessions' && sessionParam !== null && !selected && deep.isFetching && <AreaLoading label="Planning 세션 찾는 중" />}
      {tab === 'sessions' && deep.isError && !selected && (
        <LoadError title="Planning" error={deep.error as never} retrying={deep.isFetching} onRetry={() => { void deep.refetch(); }} />
      )}
      {tab === 'sessions' && sessionMissing && (
        <section className="card" role="status">
          <p className="empty" style={{ margin: '0 0 6px' }}>Planning 세션을 찾지 못했습니다.</p>
          <p className="fhint" style={{ margin: 0 }}>전체 목록을 끝까지 확인했습니다. 주소가 맞는지, 프로젝트가 초기화되지 않았는지 확인하세요. <Link to="/planning">최근 Planning 세션 보기</Link></p>
        </section>
      )}
      {tab === 'sessions' && plannings.data !== undefined && items.length === 0 && sessionParam === null && (
        <section className="card"><p className="empty" style={{ margin: 0 }}>Planning 세션이 없습니다. 입력 자료를 갱신하거나 팀장 지시가 있으면 Planning Agent가 세션을 만듭니다.</p></section>
      )}
      {tab === 'sessions' && selected && (
        <div className="two">
          <aside className="side" aria-label="Planning 목록">
            {items.map((p) => {
              return (
                <button key={p.id} type="button" className={p.id === selected.id ? 'side-i on' : 'side-i'} aria-current={p.id === selected.id ? 'true' : undefined}
                  onClick={() => { go({ session: p.id }); }}>
                  <span className="side-t">{p.title}</span>
                  <span className="muted">{stepLabel(p)}</span>
                </button>
              );
            })}
          </aside>
          <div className="mainc">
            {restoreOffer}
            <SessionView
              key={selected.id}
              planning={selected}
              cpState={cpState}
              tasks={tasks}
              memos={memos}
              setMemo={(rid, memo) => { setMemos((m) => (memo === null ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== rid)) : { ...m, [rid]: memo })); }}
              openCp={(cpKey) => { void navigate(LINK.change(cpKey)); }}
            />
          </div>
        </div>
      )}
    </Page>
  );
}
