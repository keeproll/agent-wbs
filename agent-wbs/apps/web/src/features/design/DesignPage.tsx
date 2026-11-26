/**
 * 설계(UI-04) — 원본 P L1483–1610을 옮긴 화면. 탭 6개: 구성도 · 계약 파일 / 기술 결정 / 인터페이스 / 데이터 / 소유권 · 흐름 / 변경 · 불일치.
 * 계산은 model.ts, 탭 본문은 DecisionsTab·ItemsTab·DriftsTab에 있다. 왜 이렇게 하는지는 README.md에 적었다.
 *
 * 주소(새로고침·뒤로 가기·Task 상세 링크로 같은 화면이 열린다):
 * - `/design` 구성도, `/design?tab=dec|iface|data|own|chg`
 * - 인터페이스: `kind=REST|WebSocket|SSE|Kafka`, 데이터: `store=postgres|neo4j|questdb|redis`, 검색 `q=`, 항목 상세 `sel=<항목 key>`
 *   주소는 shared/links.ts의 LINK.design으로 만든다.
 *
 * 데이터(모두 M6-05 계약, main 기준): GET /api/projects/:projectId/design(요약·구성도·파일·버전), /decisions, /interfaces, /data,
 * /ownership, /drifts. 항목 상태(계획·구현 중 등)는 담당 Task 상태로 계산하므로 Task 목록도 읽는다(G L452).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { apiKey, useApiQuery } from '../../shared/api/queries.ts';
import { MenuScreen, useRefreshError, useRevisitFetching, type ProjectState } from '../../shared/layout/MenuScreen.tsx';
import { useDocumentTitle } from '../../shared/layout/Page.tsx';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import { PageSkeleton, useDelayedFlag } from '../../shared/ui/loading.tsx';
import { useNotice, useTopBar } from '../../shared/ui/feedback.tsx';
import { DecisionsTab } from './DecisionsTab.tsx';
import { DriftsTab } from './DriftsTab.tsx';
import { ItemsTab } from './ItemsTab.tsx';
import {
  fileRows, isTab, layers, parseErrors, pendingDecisions, summaryLine, tabBadges, TABS, visibleLinks,
  type DecisionItem, type DriftItem, type Overview, type Tab, type TaskInfo,
} from './model.ts';

const TITLE = '설계';
const SUB = '제품 전체의 기술 결정 · 인터페이스(API · 이벤트) · 데이터(저장소별) — 기준은 저장소의 계약 파일이며, Agent WBS는 읽어서 보여주고 실제 코드와 대조합니다.';

export function DesignPage() {
  return <MenuScreen menu="design">{(project) => <DesignBody project={project} />}</MenuScreen>;
}

/** 화면 안 여러 곳(결정·불일치 처리)이 저장 뒤 같은 방법으로 최신을 다시 읽는다. */
export interface DesignCtx {
  projectId: string;
  decisions: DecisionItem[];
  drifts: DriftItem[];
  /** 서버에서 새로 읽어 캐시에 넣는다(fetchQuery 캐시가 아니라 실제 요청). 실패는 그대로 던진다. */
  reload: (signal?: AbortSignal) => Promise<void>;
  goTab: (tab: Tab) => void;
  setDirty: (dirty: boolean) => void;
}

function DesignBody({ project }: { project: ProjectState }) {
  useDocumentTitle(TITLE);
  const { client } = useApi();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'map';
  const projectId = 'id' in project ? String(project.id) : '';
  const on = projectId !== '';
  const p = { params: { projectId }, query: {} };

  const overview = useApiQuery('getDesign', p, { topics: ['design'], enabled: on });
  const decisions = useApiQuery('listDecisions', { params: { projectId } }, { topics: ['design'], enabled: on });
  const ifaces = useApiQuery('listInterfaces', p, { topics: ['design', 'task'], enabled: on });
  const data = useApiQuery('listDataItems', p, { topics: ['design', 'task'], enabled: on });
  const ownership = useApiQuery('getOwnership', p, { topics: ['design'], enabled: on });
  const drifts = useApiQuery('listDrifts', p, { topics: ['design'], enabled: on });
  const tasks = useApiQuery('listTasks', { params: { projectId } }, { topics: ['task'], enabled: on });
  const queries = [overview, decisions, ifaces, data, ownership, drifts, tasks] as const;

  const [dirty, setDirty] = useState(false);
  const { guard } = useEditGuard(dirty);

  const loading = queries.some((q) => q.data === undefined);
  const skeleton = useDelayedFlag(loading && queries.some((q) => q.fetchStatus === 'fetching'));
  const revisit = [useRevisitFetching(overview), useRevisitFetching(decisions), useRevisitFetching(ifaces), useRevisitFetching(data), useRevisitFetching(ownership), useRevisitFetching(drifts), useRevisitFetching(tasks)];
  useTopBar(revisit.some(Boolean));
  useRefreshError(overview, '설계 요약 최신 내용 불러오기');
  useRefreshError(decisions, '기술 결정 최신 내용 불러오기');
  useRefreshError(ifaces, '인터페이스 최신 내용 불러오기');
  useRefreshError(data, '데이터 항목 최신 내용 불러오기');
  useRefreshError(ownership, '소유권 · 흐름 최신 내용 불러오기');
  useRefreshError(drifts, '불일치 최신 내용 불러오기');
  useRefreshError(tasks, 'Task 목록 최신 내용 불러오기');

  const failed = queries.find((q) => q.data === undefined && q.isError);
  if (failed?.error) {
    return <LoadError title={TITLE} error={failed.error} retrying={failed.isFetching} onRetry={() => { for (const q of queries) if (q.isError) void q.refetch(); }} />;
  }
  if (loading || !overview.data || !decisions.data || !ifaces.data || !data.data || !ownership.data || !drifts.data || !tasks.data) {
    return <div className="page scroll">{skeleton && <PageSkeleton menu="design" />}</div>;
  }

  const reload = async (signal?: AbortSignal) => {
    const sig = signal ? { signal } : {};
    const [o, d, r] = await Promise.all([
      client.call('getDesign', { ...p, ...sig }), client.call('listDecisions', { params: { projectId }, ...sig }), client.call('listDrifts', { ...p, ...sig }),
    ]);
    if (signal?.aborted) return;
    queryClient.setQueryData(apiKey('getDesign', p), o);
    queryClient.setQueryData(apiKey('listDecisions', { params: { projectId } }), d);
    queryClient.setQueryData(apiKey('listDrifts', p), r);
  };
  /** 탭 이동: 선택·검색은 그 탭의 것이라 지운다(원본 dsSet({tab, sel:'', q:''})). 입력 중이면 먼저 묻는다. */
  const goTab = (next: Tab) => {
    void guard(() => { setParams(next === 'map' ? {} : { tab: next }); });
  };
  const ctx: DesignCtx = { projectId, decisions: decisions.data.items, drifts: drifts.data.items, reload, goTab, setDirty };
  const decs = decisions.data.items;
  const allDrifts = drifts.data.items;
  const ifaceCount = ifaces.data.items.length;
  const dataCount = data.data.items.length;
  const taskMap = new Map<string, TaskInfo>(tasks.data.tasks.map((t) => [t.taskKey, { status: String(t.lifecycleStatus), verif: String(t.verifState) }]));
  const empty = decs.length === 0 && overview.data.files.length === 0;
  const badges = tabBadges(decs, ifaceCount, dataCount, allDrifts);
  const pend = pendingDecisions(decs).length;
  const errs = parseErrors(overview.data.files);

  return (
    <div className="page scroll">
      <div className="page-h">
        <div>
          <h1>{TITLE}</h1>
          <p className="page-sub">{SUB}</p>
          <p className="page-sub mono" style={{ marginTop: 2 }}>{summaryLine(overview.data.version, decs, ifaceCount, dataCount, allDrifts)}</p>
        </div>
      </div>
      {empty ? (
        <div className="card">
          <p className="empty" style={{ margin: '0 0 6px' }}>아직 확정된 기술 결정이 없습니다.</p>
          <p className="fhint" style={{ margin: 0 }}>프로젝트 등록 → 초기 분석의 「기술 결정 확정」 단계에서 팀장이 확정하면 여기에 나타납니다. 계약 파일(API · 스키마)은 계약 설계 Task가 main에 병합한 뒤 표시됩니다.</p>
        </div>
      ) : (
        <>
          {errs.length > 0 && <ParseErrorBanner errs={errs} reload={reload} files={overview.data.files} />}
          {pend > 0 && (
            <div className="banner warn"><div className="banner-b" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ marginRight: 'auto' }}>팀장 승인이 필요한 기술 결정 {pend}건 — 승인 전까지 관련 계약 · Task는 진행하지 않습니다.</span>
              <button type="button" className="btn sm" onClick={() => { goTab('dec'); }}>기술 결정 보기</button>
            </div></div>
          )}
          <div className="stabs" role="tablist" aria-label="설계 영역">
            {TABS.map(([k, l]) => {
              const b = badges[k];
              return (
                <button key={k} type="button" role="tab" className={tab === k ? 'tab on' : 'tab'} aria-selected={tab === k} onClick={() => { goTab(k); }}>
                  {l}{b && b[0] > 0 && <span className={b[1]}>{b[0]}</span>}
                </button>
              );
            })}
          </div>
          {tab === 'map' && <MapTab overview={overview.data} decisions={decs} drifts={allDrifts} />}
          {tab === 'dec' && <DecisionsTab ctx={ctx} />}
          {(tab === 'iface' || tab === 'data') && (
            <ItemsTab key={tab} ctx={ctx} which={tab} items={tab === 'iface' ? ifaces.data.items : data.data.items} tasks={taskMap} params={params} setParams={setParams} />
          )}
          {tab === 'own' && <OwnershipTab items={ownership.data.items} />}
          {tab === 'chg' && <DriftsTab ctx={ctx} versions={overview.data.versions} />}
        </>
      )}
    </div>
  );
}

/**
 * 계약 파일 읽기 실패(UAT-DESIGN-01 a). 「다시 읽기」는 서버의 최신 해석 결과를 다시 읽는다.
 * 실제 재해석은 Runner가 하고 서버가 성공을 기록한 뒤에만 배너가 사라진다(원본 「다시 읽기 (Mock: 수정됨)」처럼 화면이 지우지 않는다).
 */
function ParseErrorBanner({ errs, reload, files }: { errs: string[]; reload: (signal?: AbortSignal) => Promise<void>; files: Overview['files'] }) {
  const notify = useNotice();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const again = async () => {
    setBusy(true);
    try {
      await reload();
      // 항목 목록·상세도 마지막 성공 버전에서 새 버전으로 바뀔 수 있다.
      await queryClient.invalidateQueries({ predicate: (q) => ['listInterfaces', 'listDataItems', 'getInterface', 'getDataItem'].includes(String(q.queryKey[0])) });
      const still = (queryClient.getQueriesData<Overview>({ queryKey: ['getDesign'] })[0]?.[1]?.files ?? files).some((f) => f.status === 'error');
      notify(still ? '아직 읽기 실패 상태입니다 — Runner가 파일을 다시 해석해 성공을 보고하면 해제됩니다.' : '계약 파일을 다시 읽었습니다 — 정상.');
    } catch {
      notify('최신 상태를 불러오지 못했습니다. 잠시 뒤 다시 시도하세요.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="banner danger" role="alert"><div className="banner-b" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ marginRight: 'auto' }}>{errs.map((e) => <span key={e} style={{ display: 'block' }}><b>계약 파일 읽기 실패</b> — {e}</span>)}</span>
      <BusyButton busy={busy} busyLabel="읽는 중…" variant="default" small onClick={() => { void again(); }}>다시 읽기</BusyButton>
    </div></div>
  );
}

function MapTab({ overview, decisions, drifts }: { overview: Overview; decisions: DecisionItem[]; drifts: DriftItem[] }) {
  const ls = layers(overview.components, decisions);
  const links = visibleLinks(overview.components, overview.links, decisions);
  const files = fileRows(overview.files, drifts);
  return (
    <>
      <section className="card">
        <div className="dp-h"><h3>시스템 구성</h3><span className="muted">확정 · 승인된 기술 결정과 main 계약 파일 기준</span></div>
        {ls.length === 0 && <p className="empty">구성 요소가 아직 없습니다 — 확정된 기술 결정을 바탕으로 계약 설계 Task가 계약 파일을 만들면 구성도와 연결이 표시됩니다.</p>}
        {ls.map((ly) => (
          <div key={ly.l} className="ds-layer">
            <span className="ds-lay-l">{ly.l}</span>
            <div className="ds-comps">
              {ly.comps.map((c) => (
                <div key={c.id} className={c.cls}><b>{c.name}</b><span className="muted">{c.tech}</span><span className="tid">{c.note}</span>{c.decL && <span className="tid mono">{c.decL}</span>}</div>
              ))}
            </div>
          </div>
        ))}
        {links.length > 0 && (
          <>
            <h4 style={{ margin: '14px 0 6px' }}>연결</h4>
            <div className="gtb" style={{ margin: 0 }} role="table" aria-label="연결">
              <div className="gtr h lkrow" role="row"><span className="gc" role="columnheader">보내는 쪽</span><span className="gc" role="columnheader">받는 쪽</span><span className="gc" role="columnheader">방식</span><span className="gc" role="columnheader">계약 파일</span></div>
              {links.map((k) => (
                <div key={`${k.from}-${k.to}-${k.how}`} className="gtr lkrow" role="row" data-link=""><span className="gc" role="cell">{k.from}</span><span className="gc" role="cell">{k.to}</span><span className="gc" role="cell">{k.how}</span><span className="gc mono" role="cell">{k.file}</span></div>
              ))}
            </div>
          </>
        )}
      </section>
      <section className="card">
        <div className="dp-h"><h3>계약 파일</h3></div>
        <p className="fhint" style={{ margin: '0 0 8px' }}>기준(정본)은 저장소 main 브랜치의 이 파일들입니다. 진행 중 Task 브랜치의 차이는 「변경 제안」으로 보입니다. Runner가 병합 · Task 완료 때 읽어 실제 코드에서 추출한 명세와 대조합니다.</p>
        {files.length === 0 && <p className="empty">아직 계약 파일이 없습니다 — 계약 설계 Task가 만듭니다.</p>}
        <div className="gtb" style={{ margin: 0 }} role="table" aria-label="계약 파일">
          {files.length > 0 && <div className="gtr h cfrow" role="row"><span className="gc" role="columnheader">파일</span><span className="gc" role="columnheader">대상</span><span className="gc" role="columnheader">형식</span><span className="gc" role="columnheader">기준 커밋</span><span className="gc" role="columnheader">상태</span></div>}
          {files.map((f) => (
            <div key={f.path} className="gtr cfrow" role="row" data-file="">
              <span className="gc mono" role="cell">{f.path}</span><span className="gc" role="cell">{f.kind}</span><span className="gc" role="cell">{f.format}</span><span className="gc mono" role="cell">{f.commit}</span>
              <span className="gc" role="cell"><span className={f.stC}>{f.stL}</span>{f.unchecked && <> <span className="sc sc-warn" title="코드에서 명세를 추출하지 못해 대조하지 않았습니다">대조 안 함</span></>}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function OwnershipTab({ items }: { items: { data: string; source: string; copy: string; sync: string; lag: string }[] }) {
  return (
    <section className="card">
      <div className="dp-h"><h3>데이터 소유권 · 흐름</h3></div>
      <p className="fhint" style={{ margin: '0 0 8px' }}>저장소가 둘 이상이면 데이터마다 원본 한 곳을 정합니다. Agent는 원본에만 쓰고, 복제본은 정해진 동기화 경로로만 갱신합니다.</p>
      {items.length === 0 && <p className="empty">아직 정의가 없습니다.</p>}
      <div className="gtb" style={{ margin: 0 }} role="table" aria-label="데이터 소유권 · 흐름">
        {items.length > 0 && <div className="gtr h owrow" role="row"><span className="gc" role="columnheader">데이터</span><span className="gc" role="columnheader">원본</span><span className="gc" role="columnheader">복제</span><span className="gc" role="columnheader">동기화</span><span className="gc" role="columnheader">지연 허용</span></div>}
        {items.map((o) => (
          <div key={o.data} className="gtr owrow" role="row" data-own=""><span className="gc" role="cell"><b>{o.data}</b></span><span className="gc" role="cell">{o.source}</span><span className="gc" role="cell">{o.copy}</span><span className="gc" role="cell">{o.sync}</span><span className="gc" role="cell">{o.lag}</span></div>
        ))}
      </div>
    </section>
  );
}
