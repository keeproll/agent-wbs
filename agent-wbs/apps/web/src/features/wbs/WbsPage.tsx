/**
 * WBS 화면(UI-03, 원본 P L791–977). 주소: `/wbs`(표), `/wbs/:taskKey`(레일 + 상세).
 *
 * 흐름(G§4.3 「목록 ↔ 상세 전환」):
 * 1. 처음에는 표(또는 Gantt)를 전체 폭으로 보인다.
 * 2. Task를 누르면 주소가 `/wbs/TASK-xxxx`가 되고, 표 대신 260px 레일 + 상세가 보인다.
 * 3. 레일의 「펼치기」(또는 Esc)를 누르면 `/wbs`로 돌아가며 필터·정렬·스크롤 위치를 그대로 둔다.
 * 키보드: ↑/↓ 또는 K/J = 이전/다음 Task, Esc = 펼치기(입력 칸에 있을 때는 동작하지 않음).
 *
 * 데이터: listTasks(트리·요약) + getSchedule(일정) + getRunnerState(동시 실행 한도) + 상세 열린 Task의 getTask.
 * 상태 필터 하나와 검색어는 서버로 보내고, 새 응답이 올 때까지 이전 목록과 상단 진행 막대를 보인다(UAT-STATE-02-UI).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router';
import { useApiQuery, invalidateTopics } from '../../shared/api/queries.ts';
import { MenuScreen, useRefreshError, useRevisitFetching } from '../../shared/layout/MenuScreen.tsx';
import { useDocumentTitle } from '../../shared/layout/Page.tsx';
import { EmptyState } from '../../shared/ui/EmptyState.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import { PageSkeleton, useDelayedFlag } from '../../shared/ui/loading.tsx';
import { useNotice, useTopBar } from '../../shared/ui/feedback.tsx';
import { SmIcon, WBS_ICON } from './cells.tsx';
import {
  buildRows, DEFAULT_COLS, EMPTY_FILTERS, filterCount, railItems, scheduleLine, serverQuery, wbsSubtitle,
  type ColKey, type Filters, type SchedTask, type SortKey, type TaskSummary,
} from './model.ts';
import { WbsTaskDetail } from './detail-slot.tsx';
import { TaskRail } from './TaskRail.tsx';
import { TaskWizard, type Draft as WizardDraft } from './TaskWizard.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { EditGuardHost, useEditGuard } from '../../shared/state/useEditGuard.ts';
import { codeLabel } from '../../shared/ui/errors.ts';
import { WbsGantt } from './WbsGantt.tsx';
import { WbsTable } from './WbsTable.tsx';
import { WbsToolbar } from './WbsToolbar.tsx';
import './wbs.css';

export function WbsPage() {
  return <MenuScreen menu="wbs">{(project) => ('id' in project ? <WbsBody projectId={String(project.id)} /> : null)}</MenuScreen>;
}

/** 검색어를 서버에 보내기 전 기다리는 시간. 글자마다 요청하지 않는다. */
const SEARCH_DEBOUNCE_MS = 250;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => { setV(value); }, ms);
    return () => { clearTimeout(t); };
  }, [value, ms]);
  return v;
}

/** 주소의 필터(`?status=done&blocked=y`). 이름은 Filters 필드 이름과 같고, 모르는 이름은 무시한다. */
function filtersFromSearch(search: string): Filters {
  const params = new URLSearchParams(search);
  const out: Filters = { ...EMPTY_FILTERS };
  for (const key of Object.keys(EMPTY_FILTERS) as (keyof Filters)[]) out[key] = params.get(key) ?? '';
  return out;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

function WbsBody({ projectId }: { projectId: string }) {
  useDocumentTitle('WBS');
  // `/wbs/:taskKey`는 router에서 WBS 메뉴 줄의 자식 경로다. 어느 줄이 받든 주소로 판단한다.
  const selKey = useMatch('/wbs/:taskKey')?.params.taskKey ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const notify = useNotice();

  const [search, setSearch] = useState('');
  // 다른 화면의 링크(대시보드 「완료」·「선행 차단」 등, shared/links.ts LINK.wbs)가 실은 필터·보기는 처음 그릴 때 한 번 읽는다(M3 통합).
  const [filters, setFilters] = useState<Filters>(() => filtersFromSearch(location.search));
  const [sort, setSort] = useState<SortKey>('wbs');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [cols, setCols] = useState<ReadonlySet<ColKey>>(DEFAULT_COLS);
  const [view, setView] = useState<'table' | 'gantt'>(() => (new URLSearchParams(location.search).get('view') === 'gantt' ? 'gantt' : 'table'));
  const [wizard, setWizard] = useState(false);
  /** Wizard에 입력한 초안. 로그인이 끊기면(401) 이 탭에 보관했다가 다시 로그인하면 복원을 제안한다(M3-01 useSessionDraft). */
  const [wizDraft, setWizDraft] = useState<WizardDraft | null>(null);
  const [restored, setRestored] = useState<WizardDraft | null>(null);
  const { restoreOffer } = useSessionDraft<WizardDraft>({
    id: 'wbs:task-create',
    label: `Task 생성${wizDraft?.title ? ` 「${wizDraft.title}」` : ''}`,
    value: wizard && wizDraft && (wizDraft.title.trim() || wizDraft.purpose.trim()) ? wizDraft : null,
    onRestore: (data) => { setRestored(data); setWizDraft(data); setWizard(true); },
  });
  // Wizard 입력 중 주소 이동(뒤로 가기·메뉴)·새로고침은 확인을 거친다(독립 리뷰 #2). Task를 만든 뒤에는 버릴 초안이 없다.
  const wizardDirty = wizard && wizDraft !== null && (wizDraft.title.trim() !== '' || wizDraft.purpose.trim() !== '');
  // 편집 보호는 이 화면에 하나만 건다. Task 상세(레일 옆)의 「입력 중」도 EditGuardHost로 받아 합친다(교차 리뷰 지적 1).
  const [detailDirty, setDetailDirty] = useState(false);
  useEditGuard(wizardDirty || detailDirty);
  /** 생성이 끝나 이동할 주소. Wizard를 닫은 뒤(편집 보호가 풀린 뒤) 이동한다. */
  const [go, setGo] = useState<string | null>(null);
  useEffect(() => { if (go) void navigate(go); }, [go, navigate]);
  const [exp, setExp] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const listScroll = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);

  const debouncedSearch = useDebounced(search, SEARCH_DEBOUNCE_MS);
  const query = serverQuery({ filters, search: debouncedSearch });
  const tasksQ = useApiQuery('listTasks', { params: { projectId }, query }, { topics: ['task', 'dependency', 'schedule'] });
  const scheduleQ = useApiQuery('getSchedule', {}, { topics: ['schedule', 'task', 'dependency', 'settings'] });
  const runnerQ = useApiQuery('getRunnerState', {}, { topics: ['runner'] });
  // Wizard의 선행 선택지는 표의 검색·상태 필터와 상관없이 프로젝트의 모든 Task다(독립 리뷰 #5). 필터가 없을 때의 목록과 같은 query다.
  const allQ = useApiQuery('listTasks', { params: { projectId }, query: serverQuery({ filters: EMPTY_FILTERS, search: '' }) }, { enabled: wizard, topics: ['task', 'dependency', 'schedule'] });
  const detailQ = useApiQuery('getTask', { params: { taskKey: selKey ?? '' } }, { enabled: selKey !== null, topics: ['task', 'dependency', 'attempt', 'verification'], keepPrevious: false });
  useTopBar(useRevisitFetching(tasksQ));
  // 이미 보여 준 목록의 갱신이 실패하면 화면은 그대로 두고 오류 막대로 알린다(M3-01 공통 규칙).
  useRefreshError(tasksQ, 'WBS 최신 내용 불러오기');
  useRefreshError(scheduleQ, '일정 최신 내용 불러오기');
  const skeleton = useDelayedFlag(tasksQ.isPending && tasksQ.fetchStatus === 'fetching');

  // 화면에서 거르는 조건은 바로 적용하되, 큰 목록에서도 입력이 끊기지 않게 낮은 우선순위로 다시 그린다.
  const viewState = useDeferredValue(useMemo(() => ({ search: debouncedSearch, filters, sort, collapsed }), [debouncedSearch, filters, sort, collapsed]));
  const data = tasksQ.data;
  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const byKey = useMemo(() => new Map(tasks.map((t) => [t.taskKey, t])), [tasks]);
  const sched = useMemo(() => new Map<string, SchedTask>((scheduleQ.data?.tasks ?? []).map((t) => [t.taskKey, t])), [scheduleQ.data]);
  const built = useMemo(() => buildRows(nodes, tasks, viewState), [nodes, tasks, viewState]);
  const rail = useMemo(() => (selKey ? railItems(nodes, tasks, viewState) : []), [selKey, nodes, tasks, viewState]);
  const railKeys = useMemo(() => rail.flatMap((r) => (r.kind === 'task' ? [r.key] : [])), [rail]);

  // 없는 Task 주소(404 TASK_NOT_FOUND): 상단 안내 + 닫기, 메뉴와 표는 그대로 둔다(UAT-WBS-05).
  const notFound = detailQ.isError && detailQ.error.code === 'TASK_NOT_FOUND';
  const missing = notFound ? selKey : null;
  // Gantt의 「현재」 선은 1분마다 옮긴다.
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); }, 60_000);
    return () => { clearInterval(t); };
  }, []);
  // 표의 스크롤 위치를 기억한다. 상세가 열리면 표가 display:none이 되어 위치를 잃기 때문이다.
  useEffect(() => {
    const el = listScroll.current;
    if (!el || selKey) return;
    // 숨겨질 때(display:none) 브라우저가 0으로 되돌리며 보내는 scroll은 무시한다.
    const onScroll = () => { if (el.clientHeight > 0) savedScroll.current = el.scrollTop; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); };
  });

  const selTask: TaskSummary | undefined = selKey ? (byKey.get(selKey) ?? (detailQ.data as TaskSummary | undefined)) : undefined;
  const pos = selKey ? railKeys.indexOf(selKey) : -1;
  /**
   * 참조 복귀 스택(G§4.4, M3-03 승인 동작). 선행·후속 같은 참조 링크로 옮길 때 지금 Task를 쌓는다.
   * 「← 원래 Task로 돌아가기」는 브라우저 뒤로 가기가 아니라 그 Task 주소로 직접 가고 스택을 하나 꺼낸다.
   * 왜: 탭 전환도 브라우저 이력에 들어가므로 뒤로 가기는 버튼에 적힌 Task가 아닌 곳으로 갈 수 있다(교차 리뷰 지적 3).
   */
  const backStack = (location.state as { back?: string[] } | null)?.back ?? [];
  const backTo = backStack.at(-1) ?? null;

  const open = (key: string, opts: { replace?: boolean; push?: string; back?: string[] } = {}) => {
    // M3 통합: 상세의 탭(`?tab=`)은 다른 Task로 옮겨도 유지한다(M3-03 TaskDetailPage와 같은 규칙).
    const tab = new URLSearchParams(window.location.search).get('tab');
    void navigate({ pathname: `/wbs/${key}`, search: tab ? `?tab=${tab}` : '' }, { replace: opts.replace ?? false, state: opts.back ? { back: opts.back } : opts.push ? { back: [...backStack, opts.push] } : null });
  };
  const close = () => {
    void navigate('/wbs');
    setExp(true);
  };
  useEffect(() => {
    if (!exp) return;
    const t = setTimeout(() => { setExp(false); }, 320);
    return () => { clearTimeout(t); };
  }, [exp]);
  // 표로 돌아오면 열기 전 스크롤 위치를 되살린다(표는 상세가 열린 동안 display:none이라 위치를 잃는다).
  useEffect(() => {
    if (!selKey && listScroll.current) listScroll.current.scrollTop = savedScroll.current;
  }, [selKey, view]);

  // 키를 빠르게 누르면 화면이 다시 그려지기 전에 다음 키가 올 수 있어, 위치는 누른 순간의 주소로 다시 계산한다.
  const step = (delta: number) => {
    const current = decodeURIComponent(window.location.pathname.split('/')[2] ?? '');
    const at = railKeys.indexOf(current);
    const key = railKeys[at + delta];
    if (at >= 0 && key) open(key, { replace: true });
  };
  const prev = pos > 0 ? () => { step(-1); } : null;
  const next = pos >= 0 && pos < railKeys.length - 1 ? () => { step(1); } : null;
  useEffect(() => {
    if (!selKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target) || document.querySelector('.overlay')) return;
      if ((e.key === 'ArrowUp' || e.key === 'k') && prev) { e.preventDefault(); prev(); }
      else if ((e.key === 'ArrowDown' || e.key === 'j') && next) { e.preventDefault(); next(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  });

  const resetFilters = () => { setSearch(''); setFilters(EMPTY_FILTERS); };
  const noFilter = search === '' && filterCount({ filters }) === 0;
  const toggle = (id: string) => { setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const allPhases = () => new Set(nodes.filter((n) => !n.parentId).map((n) => n.id));

  if (tasksQ.isError && data === undefined) {
    return <LoadError title="WBS" error={tasksQ.error} retrying={tasksQ.isFetching} onRetry={() => { void tasksQ.refetch(); }} />;
  }
  if (data === undefined) return <div className="page scroll">{skeleton && <PageSkeleton menu="wbs" />}</div>;

  const limit = runnerQ.data?.concurrency?.limit ?? runnerQ.data?.concurrency?.caps?.total ?? null;
  const liveCount = tasks.filter((t) => !t.deletedAt).length;
  const empty = liveCount === 0 && !built.active
    ? <EmptyState kind="none" message="아직 Task가 없습니다." hint={<>「Task 생성」으로 첫 Task를 만들면 여기에 표시됩니다. <button type="button" className="btn sm primary" onClick={() => { setWizard(true); }}>Task 생성</button></>} />
    : <EmptyState kind="filtered" message="조건에 맞는 Task가 없습니다." onReset={resetFilters} />;
  const defaultWp = selTask?.wbsNodeId ?? nodes.find((n) => n.kind === 'work_package')?.id ?? '';
  const splitCls = selKey && selTask ? 'split rail' : exp ? 'split exp' : 'split';

  return (
    <div className="page wbs">
      {missing && (
        <div className="banner danger" style={{ marginBottom: 10 }} role="alert">
          <div className="banner-b">
            <b>{missing}를 찾을 수 없습니다</b> <span className="mono">404 TASK_NOT_FOUND</span> — Change Proposal로 취소되었거나, 프로젝트 초기화로 삭제된 Task일 수 있습니다. 이전 보고서 · 메시지의 링크로 열었다면 그 이후에 바뀌었습니다.{' '}
            <button type="button" className="reflink" onClick={() => { void navigate('/wbs', { replace: true }); }}>닫기</button>
          </div>
        </div>
      )}
      {selKey && !selTask && detailQ.isError && !notFound && (
        <div className="banner danger" style={{ marginBottom: 10 }} role="alert">
          <div className="banner-b">
            <b>{selKey} 상세를 불러오지 못했습니다</b> <span className="mono">{codeLabel(detailQ.error)}</span> — {detailQ.error.body?.error.message ?? '서버가 응답하지 않습니다.'} 잠시 뒤 다시 시도하세요.{' '}
            <button type="button" className="btn sm" onClick={() => { void detailQ.refetch(); }} disabled={detailQ.isFetching}>다시 시도</button>{' '}
            <button type="button" className="reflink" onClick={() => { void navigate('/wbs', { replace: true }); }}>닫기</button>
          </div>
        </div>
      )}
      {restoreOffer}
      <div className="page-h">
        <div>
          <h1>WBS</h1>
          <p className="page-sub">{wbsSubtitle(tasks)}</p>
          {scheduleQ.data && <p className="page-sub sch-sub">{scheduleLine(scheduleQ.data, limit)}</p>}
        </div>
        <button type="button" className="btn primary" onClick={() => { setGo(null); setWizard(true); }}><SmIcon d={WBS_ICON.plus} />Task 생성</button>
      </div>

      <div className={splitCls}>
        {selKey && selTask && (
          <TaskRail
            items={rail} count={railKeys.length} search={search} onSearch={setSearch} filterN={filterCount({ filters })}
            selected={selKey} onPick={(k) => { open(k, { replace: true }); }} onExpand={close}
          />
        )}
        <div className="list">
          <WbsToolbar
            nodes={nodes} search={search} onSearch={setSearch} filters={filters} onFilter={(k, v) => { setFilters((f) => ({ ...f, [k]: v })); }}
            onReset={resetFilters} noFilter={noFilter} view={view} onView={setView} sort={sort} onSort={setSort}
            onExpandAll={() => { setCollapsed(new Set()); }} onCollapseAll={() => { setCollapsed(allPhases()); }}
            cols={cols} onToggleCol={(k) => { setCols((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n; }); }}
          />
          <div className="resbar"><span>{(built.active ? '필터 결과 ' : '전체 ') + String(built.taskCount)}건</span></div>
          {view === 'table' || !scheduleQ.data
            ? (
              <>
                {view === 'gantt' && scheduleQ.isError && <p className="ferr" style={{ padding: '6px 12px' }}>일정을 불러오지 못해 표로 보여 줍니다. <button type="button" className="btn sm" onClick={() => { void scheduleQ.refetch(); }}>다시 시도</button></p>}
                <WbsTable rows={built.rows} cols={cols} byKey={byKey} sched={sched} selected={selKey} onOpen={(k) => { open(k); }} onToggle={toggle} empty={empty} scrollRef={listScroll} />
              </>
            )
            : <WbsGantt rows={built.rows} schedule={scheduleQ.data} now={now} selected={selKey} onOpen={(k) => { open(k); }} onToggle={toggle} empty={empty} scrollRef={listScroll} />}
        </div>
        {selKey && selTask && (
          <EditGuardHost.Provider value={setDetailDirty}>
          <WbsTaskDetail
            key={selKey}
            taskKey={selKey}
            projectId={projectId}
            nav={{
              pos: pos >= 0 ? `${String(pos + 1)} / ${String(railKeys.length)}` : '', prev, next, outside: pos < 0,
              back: backTo ? { taskKey: backTo, go: () => { open(backTo, { back: backStack.slice(0, -1) }); } } : null,
            }}
            onOpenTask={(k, ref) => { open(k, ref ? { push: selKey } : {}); }}
          />
          </EditGuardHost.Provider>
        )}
      </div>

      {wizard && (
        <TaskWizard
          projectId={projectId} nodes={nodes} tasks={allQ.data?.tasks} defaultWp={defaultWp}
          initial={restored} onDraft={setWizDraft}
          onClose={() => { setWizard(false); setWizDraft(null); setRestored(null); }}
          onRejected={() => { void invalidateTopics(queryClient, ['task']); }}
          onCreated={(key, title, linked) => {
            setWizard(false);
            setWizDraft(null);
            setRestored(null);
            // 새 Task가 속한 Phase·WP는 펼친다(P createTask L6811).
            setCollapsed(new Set());
            void invalidateTopics(queryClient, ['task', 'dependency', 'schedule']);
            notify(linked
              ? `${key} 「${title}」을(를) 생성했습니다. 작업 명세를 작성하세요.`
              : `${key} 「${title}」을(를) 생성했습니다. 선택한 선행 Task 중 연결하지 않은 것이 있습니다 — 의존성 탭에서 추가하세요.`);
            setGo(`/wbs/${key}?tab=spec`);
          }}
        />
      )}
    </div>
  );
}
