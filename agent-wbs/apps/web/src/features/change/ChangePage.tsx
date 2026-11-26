/**
 * 변경 제안 화면(UI-09 목록 + UI-09A 상세·승인·반영). 원본 P L1687–1745, 로직 P L5988–6018.
 *
 * - 주소: `/change`(가장 최근 CP) · `/change/:cpRef`(CP 키 `CP-007` 또는 id). 알림 링크는 뒤의 주소로 연다.
 * - 목록은 최근 200건을 읽는다. 주소의 CP가 그 안에 없으면 목록을 cursor로 끝까지 넘겨 찾는다(find.ts).
 * - 판정(문제·보류 사유·영향)은 모두 서버 미리보기(GET /api/proposals/:id/preview)를 그대로 보인다. 화면이 따로 계산하지 않는다.
 * - 편집 중인 입력(승인 의견·새 변경 제안)이 있으면 다른 CP·메뉴로 가기 전에 묻는다(useEditGuard는 이 화면에 하나).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { useApiQuery } from '../../shared/api/queries.ts';
import { MenuScreen, useRefreshError } from '../../shared/layout/MenuScreen.tsx';
import { Page } from '../../shared/layout/Page.tsx';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { AreaLoading } from '../../shared/ui/loading.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import { findProposal, PAGE_LIMIT } from './find.ts';
import { cpStatus, sourceLabel, type TaskInfo } from './model.ts';
import { ProposalDetail } from './ProposalDetail.tsx';
import { ProposalModal } from './ProposalModal.tsx';
import type { Proposal } from './types.ts';
import './change.css';

const SUB = 'Change Proposal · 영향 분석 · 승인 · Replanning — 승인 후 「WBS 반영」을 실행해야 WBS가 바뀝니다';

export function ChangePage() {
  return <MenuScreen menu="change">{(project) => <ChangeBody projectId={'id' in project ? String(project.id) : ''} />}</MenuScreen>;
}

/** Task 키 → 제목·상태. 영향·Diff 표의 제목과 「현재 상태」에 쓴다. */
export function useTaskInfo(projectId: string): ReadonlyMap<string, TaskInfo> | null {
  const tasks = useApiQuery('listTasks', { params: { projectId } }, { topics: ['task', 'dependency'], enabled: projectId !== '' });
  return useMemo(() => (tasks.data
    ? new Map(tasks.data.tasks.map((t) => [t.taskKey, { title: t.title, status: String(t.lifecycleStatus) }]))
    : null), [tasks.data]);
}

function ChangeBody({ projectId }: { projectId: string }) {
  const { cpRef } = useParams();
  const navigate = useNavigate();
  const { client } = useApi();
  const list = useApiQuery('listProposals', { query: { limit: PAGE_LIMIT } }, { topics: ['proposal'] });
  useRefreshError(list, '변경 제안 목록 최신 내용 불러오기');
  const plannings = useApiQuery('listPlannings', { query: { limit: PAGE_LIMIT } }, { topics: ['planning'] });
  const tasks = useTaskInfo(projectId);
  const [comment, setComment] = useState('');
  const [modalDirty, setModalDirty] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const { guard } = useEditGuard(comment.trim() !== '' || modalDirty);
  const refresh = useProposalRefresh();
  // 제출 뒤 새 CP로 이동: 창 입력(dirty)이 지워진 화면이 그려진 다음에 이동한다.
  // 같은 처리에서 바로 이동하면 편집 보호가 아직 옛 dirty로 「버리기」 확인을 띄운다.
  const goTo = useRef<string | null>(null);
  useEffect(() => {
    if (goTo.current === null || modalDirty) return;
    const to = goTo.current;
    goTo.current = null;
    void navigate(to);
  }, [modalDirty, navigate]);

  const items = list.data?.items ?? [];
  const inList = cpRef ? items.find((p) => p.id === cpRef || p.cpKey.toUpperCase() === cpRef.toUpperCase()) : items[0];
  // 주소의 CP가 최근 목록에 없으면 끝까지 넘겨 찾는다(첫 쪽에 없다고 「없음」으로 처리하지 않는다).
  const deep = useQuery({
    queryKey: ['findProposal', cpRef ?? ''],
    queryFn: () => findProposal((query) => client.call('listProposals', { query }), cpRef ?? ''),
    // 최근 목록(캐시)에 없으면 언제나 서버에서 새로 넘겨 본다. 방금 만든 CP처럼 캐시가 낡았을 수도 있기 때문이다.
    enabled: cpRef !== undefined && list.data !== undefined && !inList,
    meta: { topics: ['proposal'] },
  });
  const selected: Proposal | undefined = inList ?? deep.data ?? undefined;
  const planningTitle = (id: string | null) => plannings.data?.items.find((p) => p.id === id)?.title;

  const pick = (cp: Proposal) => { void guard(() => { setComment(''); void navigate(`/change/${cp.cpKey}`); }); };

  if (list.data === undefined && list.isError) {
    return <LoadError title="변경 제안" error={list.error} retrying={list.isFetching} onRetry={() => { void list.refetch(); }} />;
  }

  const notFound = cpRef !== undefined && !inList && deep.data === null;
  return (
    <Page
      title="변경 제안"
      sub={SUB}
      actions={<button type="button" className="btn primary" onClick={() => { setModalOpen(true); }}>새 변경 제안</button>}
    >
      <div className="two cp-two">
        <aside className="side" aria-label="변경 제안 목록">
          {list.data === undefined && <AreaLoading label="변경 제안 목록 불러오는 중" />}
          {list.data !== undefined && items.length === 0 && <p className="empty" style={{ margin: 0 }}>Change Proposal이 없습니다.</p>}
          {items.map((p) => {
            const st = cpStatus(p.status);
            return (
              <button key={p.id} type="button" className={selected?.id === p.id ? 'side-i on' : 'side-i'} aria-current={selected?.id === p.id ? 'true' : undefined} onClick={() => { pick(p); }}>
                <span className="side-r"><span className="mono muted">{p.cpKey}</span><span className={st.c}>{st.l}</span></span>
                <span className="side-t">{p.title}</span>
                <span className="muted">출처 {String(p.source.kind) === 'manual' ? '직접 작성' : sourceLabel(p.source, planningTitle(p.source.id))} · 변경 {p.ops.length}건</span>
              </button>
            );
          })}
          {list.data?.nextCursor && <p className="fhint" style={{ margin: '6px 4px 0' }}>최근 {PAGE_LIMIT}건만 보입니다. 오래된 변경 제안은 알림 링크(주소)로 엽니다.</p>}
        </aside>
        <div className="mainc">
          {list.data !== undefined && items.length === 0 && !cpRef && (
            <div className="card">
              <p className="empty" style={{ margin: '0 0 6px' }}>아직 Change Proposal이 없습니다.</p>
              <p className="fhint" style={{ margin: 0 }}>Planning 세션에서 Codex · Claude가 합의한 변경, 입력 자료 새 버전의 차이 분석, 팀장 메시지의 범위 변경 요청이 여기에 Change Proposal로 올라옵니다. 자동 반영 정책이 켜져 있으면 문제가 없는 제안은 바로 WBS와 일정에 반영됩니다.</p>
            </div>
          )}
          {deep.isFetching && !selected && <AreaLoading label={`${cpRef ?? ''} 찾는 중`} />}
          {deep.isError && <LoadError title="변경 제안" error={deep.error as never} retrying={deep.isFetching} onRetry={() => { void deep.refetch(); }} />}
          {notFound && (
            <div className="card" role="status">
              <p className="empty" style={{ margin: '0 0 6px' }}>변경 제안 {cpRef}을(를) 찾지 못했습니다.</p>
              <p className="fhint" style={{ margin: 0 }}>전체 목록을 끝까지 확인했습니다. 주소가 맞는지, 프로젝트가 초기화되지 않았는지 확인하세요. <Link to="/change">최근 변경 제안 보기</Link></p>
            </div>
          )}
          {selected && (
            <ProposalDetail
              key={selected.id}
              cp={selected}
              tasks={tasks}
              planningTitle={planningTitle(selected.source.id)}
              comment={comment}
              setComment={setComment}
            />
          )}
        </div>
      </div>
      {modalOpen && (
        <ProposalModal
          tasks={tasks}
          onDirty={setModalDirty}
          onClose={() => { setModalOpen(false); setModalDirty(false); }}
          onSubmitted={(cp) => { setModalOpen(false); setModalDirty(false); goTo.current = `/change/${cp.cpKey}`; void refresh(); }}
        />
      )}
    </Page>
  );
}

/** 목록·찾기·미리보기를 모두 다시 읽는다(처리 뒤 또는 상태가 맞지 않을 때). */
export function useProposalRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all(['listProposals', 'findProposal', 'previewProposal', 'listPlannings'].map((id) => queryClient.invalidateQueries({ queryKey: [id] })));
  };
}
