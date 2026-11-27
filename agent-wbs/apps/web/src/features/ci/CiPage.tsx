/**
 * 빌드·통합(UI-08) — 원본 P L1405–1482를 옮긴 화면. 탭 5개: 실행 기록(UI-08-01)·병합 대기열(UI-08-02)·배포 확인(UI-08-03)·
 * 파이프라인 정의(UI-08-04)·불안정 테스트(UI-08-05). 실행 상세는 UI-08-01A.
 *
 * 주소(새로고침·뒤로 가기·알림 링크로 같은 화면이 열린다, MM-29):
 * - `/ci` 실행 기록, `/ci/<실행 id>` 레일 + 실행 상세(서버 알림 링크 `path: /ci/<id>`와 같은 모양)
 * - `?stage=task|int|night|deploy` 단계 필터, `?tab=queue|deploy|pipe|flaky` 다른 탭
 *
 * 키보드(UAT-TASK-11과 같은 규칙): 상세에서 ↑/K 이전, ↓/J 다음, Esc 펼치기. 글자 입력 중·창이 열려 있으면 동작하지 않는다.
 *
 * 데이터(모두 계약 타입, M7-04): listCiRuns(모든 쪽)·getCiRun·getMergeQueue·listFlakyTests·getPipeline·getCiSettings,
 * listTasks(대기열 제목), 상세 Task의 getTaskAttempts(시도 번호). 바꾸는 요청: retryCiRun·requestDeployCheck(job 생성)·updateFlakyTest.
 * 화면은 결과를 스스로 만들지 않는다. 다시 실행·배포 확인은 Runner가 실제로 실행해 새 기록을 보고한다(MM-07).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { useAllPages } from '../../shared/api/allPages.ts';
import type { ApiError } from '../../shared/api/client.ts';
import { apiKey, useApiQuery } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import { MenuScreen, useRefreshError, useRevisitFetching, type ProjectState } from '../../shared/layout/MenuScreen.tsx';
import { useDocumentTitle } from '../../shared/layout/Page.tsx';
import { LINK } from '../../shared/links.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import { AreaLoading, PageSkeleton, useDelayedFlag } from '../../shared/ui/loading.tsx';
import { TableScroll } from '../../shared/ui/TableScroll.tsx';
import { useTopBar } from '../../shared/ui/feedback.tsx';
import {
  detailSteps, formatDuration, mergeLine, retryHeld, githubLabel, lastDeploy, mainStatus, position, prLabel, queueRows, resultLabel, runDurationMs, runRows, short,
  stageCounts, stageLabel, STAGE_LABEL, STAGES, summaryLine, tabBadges,
  type CiRun, type FlakyTest, type QueueItem, type QueueRow, type Stage,
} from './model.ts';
import './ci.css';

const TITLE = '빌드 · 통합';
const SUB = 'Runner가 직접 빌드 · 테스트 · 기동 · 브라우저 접속을 확인합니다 (외부 CI 없음). 단계 정의는 저장소 .agentwbs/pipeline.yaml, 빌드 기준은 src/. 결과는 Task 근거와 GitHub PR 검사 상태로 함께 남습니다.';
type Tab = 'runs' | 'queue' | 'deploy' | 'pipe' | 'flaky';
const TABS: [Tab, string][] = [['runs', '실행 기록'], ['queue', '병합 대기열'], ['deploy', '배포 확인'], ['pipe', '파이프라인 정의'], ['flaky', '불안정 테스트']];
/** 원본 파이프라인 규칙 문구(P CI_PIPE.rules L3530). 제품 규칙이라 그대로 보인다. */
const RULES = [
  '명령은 Runner가 실행하고 종료 코드 · 로그 · 스크린샷을 근거로 남깁니다 — Agent의 「통과했다」는 근거가 아닙니다.',
  '파이프라인 정의는 main 기준 버전으로 실행합니다 — Task 브랜치에서 바꾼 정의 · 테스트 삭제로 통과시킬 수 없습니다. .agentwbs/ 변경은 팀장 승인.',
  '실패한 테스트는 1회 자동 재시도 — 재시도로만 통과하면 「불안정 테스트」 후보로 기록합니다.',
  '같은 정의 파일을 나중에 GitHub Actions로 옮겨 실행할 수 있게 Runner에 빌드 로직을 넣지 않습니다.',
  '보관하는 것은 커밋 해시와 실행 기록뿐입니다 (Agent WBS DB) — 빌드 결과물 · 이미지는 보관하지 않고 필요하면 커밋 해시로 다시 빌드합니다.',
];

export function CiPage() {
  return <MenuScreen menu="ci">{(project) => <CiBody project={project} />}</MenuScreen>;
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
const modalOpen = () => document.querySelector('[role="dialog"],[role="alertdialog"]') !== null;

function CiBody({ project }: { project: ProjectState }) {
  useDocumentTitle(TITLE);
  const navigate = useNavigate();
  const { runId = '' } = useParams();
  const [params] = useSearchParams();
  const rawTab = params.get('tab');
  const tab: Tab = runId ? 'runs' : (TABS.find(([k]) => k === rawTab)?.[0] ?? 'runs');
  const stage = STAGES.includes(params.get('stage') as Stage) ? (params.get('stage') as Stage) : '';
  /** 목록 주소. 단계 필터는 상세를 오가도 남긴다(원본: 선택만 바꾼다). */
  const listPath = (patch: { tab?: Tab; stage?: string; run?: string } = {}) => {
    const q = new URLSearchParams();
    const t = patch.tab ?? 'runs';
    if (t !== 'runs') q.set('tab', t);
    const s = patch.stage ?? stage;
    if (t === 'runs' && s) q.set('stage', s);
    const search = q.toString();
    return `${patch.run ? LINK.ci(patch.run) : '/ci'}${search ? `?${search}` : ''}`;
  };

  const projectId = 'id' in project ? String(project.id) : '';
  const p = { params: { projectId } };
  const on = projectId !== '';
  const runs = useAllPages('listCiRuns', p, { topics: ['ci'], enabled: on });
  const queue = useApiQuery('getMergeQueue', p, { topics: ['ci'], enabled: on });
  const flaky = useApiQuery('listFlakyTests', p, { topics: ['ci'], enabled: on });
  const tasks = useApiQuery('listTasks', p, { topics: ['task'], enabled: on });
  const queries = [runs, queue, flaky] as const;

  const loading = queries.some((q) => q.data === undefined);
  const skeleton = useDelayedFlag(loading && queries.some((q) => q.fetchStatus === 'fetching'));
  useTopBar([useRevisitFetching(runs), useRevisitFetching(queue), useRevisitFetching(flaky)].some(Boolean));
  useRefreshError(runs, '실행 기록 최신 내용 불러오기');
  useRefreshError(queue, '병합 대기열 최신 내용 불러오기');
  useRefreshError(flaky, '불안정 테스트 최신 내용 불러오기');

  const failed = queries.find((q) => q.data === undefined && q.isError);
  if (failed?.error) {
    return <LoadError title={TITLE} error={failed.error} retrying={failed.isFetching} onRetry={() => { for (const q of queries) if (q.isError) void q.refetch(); }} />;
  }
  if (loading || !runs.data || !queue.data || !flaky.data) return <div className="page scroll">{skeleton && <PageSkeleton menu="ci" />}</div>;

  const allRuns = runs.data.items;
  const main = mainStatus(allRuns, queue.data.items);
  const badges = tabBadges(allRuns, queue.data.items, flaky.data.items);
  const titles = new Map((tasks.data?.tasks ?? []).map((t) => [t.taskKey, t.title]));
  const taskStatus = new Map((tasks.data?.tasks ?? []).map((t) => [t.taskKey, String(t.lifecycleStatus)]));
  const qRows = queueRows(queue.data.items, titles, allRuns, taskStatus).reverse();
  /** 서버가 자동 재통합할 실행(대기열의 최신 기준선 실패 차수). 상세 안내에 쓴다. */
  const autoRuns = new Set(qRows.filter((q) => q.autoReintegrate && q.ciRunId).map((q) => q.ciRunId as string));
  /** 병합 불일치로 완료가 보류된 Task. 서버는 이 Task의 기준선 실패 재통합(다시 실행)을 409로 거부한다(M7-04 fix3 보류 조건). */
  const holds = new Set(qRows.filter((q) => q.mismatch).map((q) => q.taskKey));
  const badge: Partial<Record<Tab, [number, string]>> = { runs: [badges.runs, 'tab-c alert'], queue: [badges.queue, 'tab-c'], flaky: [badges.flaky, 'tab-c'] };

  return (
    <div className="page scroll">
      <div className="page-h">
        <div>
          <h1>{TITLE}</h1>
          <p className="page-sub">{SUB}</p>
          <p className="page-sub" style={{ marginTop: 4 }}><span className={main.c}>{main.l}</span> <span className="mono muted">{summaryLine(allRuns, queue.data.items)}</span></p>
        </div>
      </div>
      {allRuns.length === 0 && (
        <div className="card" data-empty="runs">
          <p className="empty" style={{ margin: '0 0 6px' }}>아직 빌드 · 검사 실행 기록이 없습니다.</p>
          <p className="fhint" style={{ margin: 0 }}>첫 Task의 Agent 작업이 끝나면 ① Task 검사가 자동으로 실행됩니다. 파이프라인 정의는 「파이프라인 정의」 탭에서 확인합니다.</p>
        </div>
      )}
      <div className="stabs" role="tablist" aria-label="빌드 · 통합 영역">
        {TABS.map(([k, l]) => {
          const b = badge[k];
          return (
            <button key={k} type="button" role="tab" className={tab === k ? 'tab on' : 'tab'} aria-selected={tab === k} onClick={() => { void navigate(listPath({ tab: k })); }}>
              {l}{b && b[0] > 0 && <span className={b[1]}>{b[0]}</span>}
            </button>
          );
        })}
      </div>
      {tab === 'runs' && (
        <RunsTab
          runs={allRuns} stage={stage} runId={runId}
          onStage={(s) => { void navigate(listPath({ stage: s })); }}
          onSelect={(id) => { void navigate(listPath({ run: id })); }}
          onClose={() => { void navigate(listPath()); }}
          onStep={(ids, delta) => {
            // 지금 주소에서 한 칸 옮긴다. 키를 빠르게 연달아 눌러도 그린 시점이 아니라 최신 주소를 기준으로 한다.
            const cur = decodeURIComponent(window.location.pathname.replace(/^\/ci\/?/, ''));
            const next = ids[ids.indexOf(cur) + delta];
            if (ids.includes(cur) && next) void navigate(listPath({ run: next }));
          }}
          projectId={projectId}
          holds={holds}
          queue={queue.data.items}
          autoRuns={autoRuns}
        />
      )}
      {tab === 'queue' && <QueueTab rows={qRows} />}
      {tab === 'deploy' && <DeployTab runs={allRuns} projectId={projectId} openRun={(id) => { void navigate(listPath({ run: id, stage: '' })); }} />}
      {tab === 'pipe' && <PipeTab projectId={projectId} />}
      {tab === 'flaky' && <FlakyTab items={flaky.data.items} projectId={projectId} />}
    </div>
  );
}

/* ---------------- 실행 기록 + 상세 ---------------- */

function RunsTab({ runs, stage, runId, onStage, onSelect, onClose, onStep, projectId, holds, autoRuns, queue }: {
  runs: CiRun[]; stage: string; runId: string; projectId: string; holds: ReadonlySet<string>; autoRuns: ReadonlySet<string>; queue: readonly QueueItem[];
  onStage: (s: string) => void; onSelect: (id: string) => void; onClose: () => void; onStep: (ids: string[], delta: 1 | -1) => void;
}) {
  const rows = runRows(runs, stage);
  const counts = stageCounts(runs);
  const ids = rows.map((r) => r.id);
  const idKey = ids.join(' ');
  const listRef = useRef<HTMLDivElement>(null);
  const detail = useApiQuery('getCiRun', { params: { projectId, id: runId } }, { topics: ['ci'], enabled: runId !== '', keepPrevious: false });

  // 상세 키보드: ↑/K 이전, ↓/J 다음, Esc 펼치기. 상세인지는 누른 순간의 주소로 판단한다.
  useEffect(() => {
    const list = idKey.split(' ');
    const onKey = (e: KeyboardEvent) => {
      if (!/^\/ci\/./.test(window.location.pathname)) return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typing(e.target) || modalOpen()) return;
      const k = e.key;
      if (k === 'ArrowUp' || k === 'k' || k === 'K') { e.preventDefault(); onStep(list, -1); }
      else if (k === 'ArrowDown' || k === 'j' || k === 'J') { e.preventDefault(); onStep(list, 1); }
      else if (k === 'Escape') { e.preventDefault(); onClose(); }
    };
    addEventListener('keydown', onKey);
    return () => { removeEventListener('keydown', onKey); };
  }, [idKey, onStep, onClose]);

  if (!runId) {
    const rowKey = (e: ReactKeyboardEvent<HTMLDivElement>, id: string) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const all = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-cirow]') ?? [])];
      const i = all.indexOf(e.currentTarget);
      all[e.key === 'ArrowDown' ? Math.min(all.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
    };
    return (
      <>
        <div className="ds-bar">
          <div className="seg" role="group" aria-label="단계">
            {([['', '전체'], ...STAGES.map((s) => [s, STAGE_LABEL[s]])] as [string, string][]).map(([k, l]) => (
              <button key={k || 'all'} type="button" aria-pressed={stage === k} onClick={() => { onStage(k); }}>{l} {counts[k as '' | Stage]}</button>
            ))}
          </div>
        </div>
        <div className="card" style={{ padding: 0 }}>
          <TableScroll minWidth={900} label="실행 기록 표">
            <div className="gtb" style={{ margin: 0 }} role="table" aria-label="실행 기록" ref={listRef}>
              <div className="gtr h cirow" role="row" aria-label="머리글">
                {['실행', '단계', '결과', 'Task', '대상', 'PR', '시각 · 소요', '계기'].map((h) => <span key={h} className="gc" role="columnheader">{h}</span>)}
              </div>
              {runs.length === 0 && <div className="gtr" role="row" data-empty="none"><span className="gc muted" role="cell">실행 기록이 없습니다.</span></div>}
              {runs.length > 0 && rows.length === 0 && (
                <div className="gtr" role="row" data-empty="filtered">
                  <span className="gc muted" role="cell">조건에 맞는 실행 기록이 없습니다. 다른 단계의 실행은 있습니다. <button type="button" className="btn sm" onClick={() => { onStage(''); }}>필터 초기화</button></span>
                </div>
              )}
              {rows.map((r) => {
                const res = resultLabel(r);
                return (
                  <div
                    key={r.id} className="gtr cirow" role="row" tabIndex={0} data-cirow=""
                    aria-label={`${r.runKey} ${stageLabel(r.stage)} ${res.l} 상세 열기`}
                    onClick={() => { onSelect(r.id); }} onKeyDown={(e) => { rowKey(e, r.id); }}
                  >
                    <span className="gc mono" role="cell"><b>{r.runKey}</b></span>
                    <span className="gc" role="cell">{stageLabel(r.stage)}</span>
                    <span className="gc" role="cell"><span className={res.c}>{res.l}</span></span>
                    <span className="gc mono" role="cell">{r.taskKey ?? '—'}</span>
                    <span className="gc mono" role="cell" style={{ fontSize: 12 }}>{r.ref}</span>
                    <span className="gc mono" role="cell">{prLabel(r.pr)}</span>
                    <span className="gc mono" role="cell" style={{ fontSize: 12 }}>{formatDateTime(r.startedAt)}<br /><span className="muted">{formatDuration(runDurationMs(r))}</span></span>
                    <span className="gc" role="cell">{r.trigger ?? '—'}</span>
                  </div>
                );
              })}
            </div>
          </TableScroll>
        </div>
      </>
    );
  }

  const pos = position(ids, runId);
  return (
    <div className="two ci-two">
      <aside className="side scrollc" aria-label="실행 기록">
        <div className="rail-h">
          <span className="rail-ttl">실행 기록 <span className="mono muted">{rows.length}</span></span>
          <button type="button" className="btn sm rail-exp" onClick={onClose} title="상세를 닫고 원래 목록으로 펼칩니다">
            <svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6" /></svg>펼치기
          </button>
        </div>
        {rows.map((r) => {
          const res = resultLabel(r);
          return (
            <button key={r.id} type="button" className={r.id === runId ? 'side-i on' : 'side-i'} aria-current={r.id === runId || undefined} onClick={() => { onSelect(r.id); }}>
              <span className="side-r"><span className="mono muted">{r.runKey}</span><span className={res.c}>{res.l}</span></span>
              <span className="side-t">{stageLabel(r.stage)} · {r.taskKey ?? '—'}</span>
              <span className="muted">{formatDateTime(r.startedAt)}</span>
            </button>
          );
        })}
      </aside>
      <div className="mainc">
        {detail.data === undefined && (detail.isError
          ? <DetailError error={detail.error} retrying={detail.isFetching} onRetry={() => { void detail.refetch(); }} onClose={onClose} />
          : <div className="card"><AreaLoading label="실행 상세 불러오는 중" /></div>)}
        {detail.data && <RunDetail run={detail.data} pos={pos} onSelect={onSelect} projectId={projectId} held={retryHeld(detail.data, holds)} autoReintegrate={autoRuns.has(detail.data.id)} merge={mergeLine(detail.data, queue)} />}
      </div>
    </div>
  );
}

function DetailError({ error, retrying, onRetry, onClose }: { error: ApiError | null; retrying: boolean; onRetry: () => void; onClose: () => void }) {
  if (error?.status === 404) {
    return (
      <div className="banner danger" role="alert">
        <div className="banner-b"><b>실행 기록을 찾을 수 없습니다 (404)</b> — 다른 프로젝트의 기록이거나 잘못된 주소입니다. <button type="button" className="btn sm" onClick={onClose}>목록으로</button></div>
      </div>
    );
  }
  return (
    <div className="banner danger" role="alert">
      <div className="banner-b"><b>실행 상세를 불러오지 못했습니다</b> — {error?.message ?? ''} <BusyButton busy={retrying} busyLabel="다시 시도 중…" variant="default" small onClick={onRetry}>다시 시도</BusyButton></div>
    </div>
  );
}

function RunDetail({ run, pos, onSelect, projectId, held, autoReintegrate, merge }: {
  run: CiRun; pos: ReturnType<typeof position>; onSelect: (id: string) => void; projectId: string; held: boolean; autoReintegrate: boolean; merge: string | null;
}) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const res = resultLabel(run);
  const steps = detailSteps(run);
  const attempts = useAllPages('getTaskAttempts', { params: { taskKey: run.taskKey ?? '' } }, { topics: ['attempt'], enabled: run.taskKey !== null && run.attemptId !== null });
  const attemptKey = attempts.data?.items.find((a) => a.id === run.attemptId)?.attemptKey ?? null;
  const shotsTitle = run.stage === 'deploy' || run.stage === 'night' ? '스크린샷' : '근거 파일';
  const retry = useSave<{ jobId: string }, { id: string }>({
    target: `${run.runKey} 다시 실행`,
    failTitle: '다시 실행을 요청하지 못했습니다',
    request: () => ({ id: run.id }),
    run: ({ payload, idempotencyKey }) => client.call('retryCiRun', { params: { projectId, id: payload.id }, idempotencyKey }),
    // 실행 목록·상세를 다시 읽는다. 새 기록은 Runner가 실제로 실행을 시작해 보고할 때 생긴다.
    onSuccess: () => { void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('listCiRuns') || q.queryKey[0] === 'getCiRun' }); },
    successNotice: '다시 실행을 요청했습니다 — Runner가 실제로 다시 실행해 새 실행 기록을 남깁니다.',
  });
  return (
    <div className="card ci-detail" role="region" aria-label={`${run.runKey} 실행 상세`}>
      <div className="vf-nav">
        <span className="tag">{stageLabel(run.stage)}</span><span className={res.c}>{res.l}</span>
        <span className="sp" />
        <span className="muted mono" style={{ fontSize: 12 }}>{pos.label}</span>
        <button type="button" className="btn ghost sm" disabled={!pos.prev} onClick={() => { if (pos.prev) onSelect(pos.prev); }}>↑ 이전</button>
        <button type="button" className="btn ghost sm" disabled={!pos.next} onClick={() => { if (pos.next) onSelect(pos.next); }}>↓ 다음</button>
      </div>
      <h2 className="mono" style={{ margin: '0 0 8px', fontSize: 18 }}>{run.runKey}</h2>
      <div className="kv" style={{ gridTemplateColumns: '110px minmax(0,1fr)', margin: '0 0 10px' }}>
        <span className="kv-l">대상</span><span className="kv-v mono">{run.ref}</span>
        <span className="kv-l">Task · 시도</span>
        <span className="kv-v">
          {run.taskKey && <><Link className="reflink mono" to={LINK.task(run.taskKey)}>{run.taskKey}</Link>{' '}</>}
          {run.taskKey && run.attemptId && <Link className="mono muted" to={LINK.exec(run.taskKey, run.attemptId)}>{attemptKey ?? '실행 시도'}</Link>}
        </span>
        <span className="kv-l">계기</span><span className="kv-v">{run.trigger ?? '—'}</span>
        <span className="kv-l">시각 · 소요</span><span className="kv-v mono">{formatDateTime(run.startedAt)} · {formatDuration(runDurationMs(run))}</span>
        <span className="kv-l">GitHub</span>
        <span className="kv-v mono" style={{ fontSize: 12.5 }}>{run.githubStatus?.url ? <a href={run.githubStatus.url} target="_blank" rel="noreferrer">{githubLabel(run)}</a> : githubLabel(run)}</span>
        {merge && <><span className="kv-l">병합</span><span className="kv-v mono">{merge}</span></>}
        {run.url && <><span className="kv-l">접속 URL</span><span className="kv-v mono">{run.url}</span></>}
      </div>
      {run.note && <p className="fhint" style={{ margin: '0 0 10px' }}>{run.note}</p>}
      {run.failScope === 'baseline' && run.status === 'fail' && (
        <p className="fhint" style={{ margin: '0 0 10px' }}>기준선 실패 — main 기준 커밋에서도 실패했습니다({short(run.baseSha)}). 이 Task의 변경 탓이 아니므로 Task 실패로 세지 않습니다.{autoReintegrate && ' main이 바뀌면 서버가 자동으로 다시 통합 확인합니다.'}</p>
      )}
      <h3 className="ds-h4">단계</h3>
      {steps.length === 0 ? <p className="empty">보고된 단계가 없습니다.</p> : (
        <div className="gtb" style={{ margin: '0 0 10px' }} role="table" aria-label="단계">
          {steps.map((x, i) => (
            <div key={`${String(i)}-${x.name}`} className="gtr" role="row" style={{ gridTemplateColumns: 'minmax(220px,1fr) 80px 90px', minWidth: 0 }}>
              <span className="gc" role="cell">{x.name}</span>
              <span className="gc" role="cell"><span className={x.c}>{x.l}</span></span>
              <span className="gc mono muted" role="cell">{x.dur}</span>
            </div>
          ))}
        </div>
      )}
      {run.logExcerpt && <><h3 className="ds-h4">실패 로그 (요약)</h3><pre className="code" style={{ whiteSpace: 'pre-wrap' }}>{run.logExcerpt}</pre></>}
      {run.artifacts.length > 0 && <><h3 className="ds-h4">{shotsTitle}</h3><div className="ds-chips">{run.artifacts.map((z) => <span key={z} className="tag mono">{z}</span>)}</div></>}
      {run.status === 'fail' && (
        <div className="form-acts" style={{ marginTop: 10 }}>
          <span className="muted" style={{ marginRight: 'auto' }}>{held
            ? `${run.taskKey ?? ''}의 실제 병합이 검증 근거와 달라 완료를 보류 중입니다. 병합 결과를 확인하기 전에는 기준선 실패를 다시 통합할 수 없습니다.`
            : '원인을 고친 뒤 다시 실행합니다. Task 검사 실패는 Runner가 Agent에게 로그를 전달해 같은 시도 안에서 고치게 합니다.'}</span>
          <BusyButton busy={retry.busy} busyLabel="요청 중…" small disabled={held} onClick={() => { void retry.save(); }}>다시 실행</BusyButton>
        </div>
      )}
      {retry.conflictModal}
    </div>
  );
}

/* ---------------- 병합 대기열 ---------------- */

function QueueTab({ rows }: { rows: QueueRow[] }) {
  const mismatches = rows.filter((r) => r.mismatch);
  return (
    <section className="card">
      <div className="dp-h"><h2>병합 대기열</h2></div>
      <p className="fhint" style={{ margin: '0 0 8px' }}>검증 PASS인 PR만 들어오고, ② 통합 확인을 한 번에 하나씩 거쳐 통과해야 main에 병합됩니다(GitHub main 보호 규칙: 「agentwbs/int 통과」 필수). 실패하면 병합하지 않고 원인 Task에 재작업을 요청합니다. 대기가 길어지면 여러 PR을 묶어 확인하고, 실패 시 나눠서 원인을 찾습니다.</p>
      {rows.some((r) => r.c === 'sc sc-warn') && (
        <p className="fhint" style={{ margin: '0 0 8px' }}>기준선 실패는 예외입니다 — main 기준 커밋 자체가 실패한 것이라 원인 Task에 재작업을 요청하지 않습니다. Gate에서 기다리는 Task는 main이 고쳐지면 다시 통합 확인합니다.</p>
      )}
      {mismatches.map((r) => (
        <div key={r.id} className="banner danger" role="alert" style={{ marginBottom: 8 }}>
          <div className="banner-b"><b>실제 병합이 검증 근거와 다릅니다</b> — PR {r.pr} ({r.taskKey}) 실제 병합 {short(r.actualMergeSha)}. 완료를 보류합니다. 병합 결과를 확인한 뒤 <Link to={LINK.exec(r.taskKey)}>{r.taskKey} 실행 보기</Link></div>
        </div>
      ))}
      {rows.length === 0 && <p className="empty">대기열이 비어 있습니다.</p>}
      {rows.length > 0 && (
        <TableScroll minWidth={700} label="병합 대기열 표">
          <div className="gtb" style={{ margin: 0 }} role="table" aria-label="병합 대기열">
            {rows.map((q) => (
              <div key={q.id} className="gtr" role="row" style={{ gridTemplateColumns: '60px 100px minmax(180px,1fr) 170px 148px', minWidth: 0 }}>
                <span className="gc mono" role="cell"><b>{q.pr}</b></span>
                <span className="gc" role="cell"><Link className="reflink mono" to={LINK.task(q.taskKey)}>{q.taskKey}</Link></span>
                <span className="gc" role="cell">{q.title}</span>
                <span className="gc" role="cell">{q.mismatch ? <span className="vf v-fail">병합 불일치 — 완료 보류</span> : <span className={q.c}>{q.st}</span>}</span>
                {/* 시각은 연결된 통합 확인 실행의 시작 시각이다. 누르면 그 실행 상세(실패 원인·재작업 추적, UAT-CI-03). 원본 열 배치를 지키려고 칸을 늘리지 않았다. */}
                <span className="gc mono" role="cell">{q.ciRunId
                  ? <Link className="ci-at" to={LINK.ci(q.ciRunId)} title={`${q.ciRunKey ?? ''} 실행 상세`} aria-label={`${q.at} · ${q.ciRunKey ?? '실행'} 실행 상세`}>{q.at}</Link>
                  : q.at}</span>
              </div>
            ))}
          </div>
        </TableScroll>
      )}
    </section>
  );
}

/* ---------------- 배포 확인 ---------------- */

function DeployTab({ runs, projectId, openRun }: { runs: CiRun[]; projectId: string; openRun: (id: string) => void }) {
  const { client } = useApi();
  const settings = useApiQuery('getCiSettings', { params: { projectId } }, { topics: ['settings', 'ci'] });
  const last = lastDeploy(runs);
  const lastRes = last ? resultLabel(last) : { l: '없음', c: 'vf v-none' };
  const check = useSave<{ jobId: string }>({
    target: '배포 확인 요청',
    failTitle: '배포 확인을 요청하지 못했습니다',
    run: ({ idempotencyKey }) => client.call('requestDeployCheck', { params: { projectId }, idempotencyKey }),
    successNotice: '배포 확인을 요청했습니다 — Runner가 운영 빌드 · 기동 · 접속을 확인해 새 실행 기록을 남깁니다.',
  });
  const url = settings.data ? settings.data.deployUrl ?? '설정되지 않음' : settings.isError ? '불러오지 못함' : '…';
  return (
    <section className="card">
      <div className="dp-h"><h2>배포 확인</h2><span className={lastRes.c}>{lastRes.l}</span></div>
      <p className="fhint" style={{ margin: '0 0 8px' }}>「Web Service가 정상 기동하고 브라우저로 접속된다」를 배포로 봅니다. 운영 빌드(Docker 이미지) → docker compose up → health check → Playwright로 실제 URL 접속(로그인 · 핵심 화면 · 주요 API) → 스크린샷. 같은 절차를 이 PC든 다른 서버든 그대로 씁니다.</p>
      <div className="kv" style={{ gridTemplateColumns: '130px minmax(0,1fr)', margin: '0 0 10px' }}>
        <span className="kv-l">접속 URL</span><span className="kv-v mono">{url}</span>
        <span className="kv-l">마지막 확인</span>
        <span className="kv-v">{last
          ? <Link className="reflink mono" to={LINK.ci(last.id)} onClick={(e) => { e.preventDefault(); openRun(last.id); }}>{`${formatDateTime(last.startedAt)} · ${lastRes.l} · ${last.runKey}`}</Link>
          : <span className="muted">배포 확인을 실행한 적이 없습니다</span>}</span>
      </div>
      <div className="msg-acts">
        <BusyButton busy={check.busy} busyLabel="요청 중…" small onClick={() => { void check.save(); }}>배포 확인 실행</BusyButton>
      </div>
      {check.conflictModal}
    </section>
  );
}

/* ---------------- 파이프라인 정의 ---------------- */

function PipeTab({ projectId }: { projectId: string }) {
  const pipe = useApiQuery('getPipeline', { params: { projectId } }, { topics: ['ci', 'project'] });
  const settings = useApiQuery('getCiSettings', { params: { projectId } }, { topics: ['settings', 'ci'] });
  const s = settings.data;
  return (
    <>
      <section className="card">
        {pipe.data === undefined && (pipe.isError
          ? <LoadError title="파이프라인 정의" error={pipe.error} retrying={pipe.isFetching} onRetry={() => { void pipe.refetch(); }} />
          : <AreaLoading label="파이프라인 정의 불러오는 중" />)}
        {pipe.data && (
          <>
            <div className="dp-h"><h2>파이프라인 정의</h2><span className="mono muted">{pipe.data.path} · {pipe.data.commit ? `main @ ${short(pipe.data.commit)}` : 'main 커밋 미확인'}</span></div>
            <ul className="ds-ul">{RULES.map((x) => <li key={x}>{x}</li>)}</ul>
            {pipe.data.status === 'missing' && <p className="empty">저장소 main에 정의 파일이 없습니다. 첫 커밋에서 만들어지며, 그 전에는 단계를 표시할 수 없습니다.</p>}
            {pipe.data.status === 'error' && (
              <div className="banner danger" role="alert"><div className="banner-b"><b>정의 파일을 해석하지 못했습니다</b> — {pipe.data.error ?? '원인 미보고'}</div></div>
            )}
            {(pipe.data.stages ?? []).map((g) => (
              <div key={g.stage} className="dec-row">
                <div className="dec-h"><b>{stageLabel(g.stage)}</b><span className="muted">{g.when}</span></div>
                <p className="dec-p"><span className="muted">통과 조건</span> {g.gate}</p>
                <ul className="ds-ul" style={{ marginTop: 4 }}>{g.steps.map((x, i) => <li key={`${String(i)}-${x}`} style={{ listStyle: 'none' }}>{i + 1}. {x}</li>)}</ul>
              </div>
            ))}
          </>
        )}
      </section>
      <section className="card">
        <div className="dp-h"><h2>실행 설정</h2></div>
        {settings.isError && !s && <LoadError title="실행 설정" error={settings.error} retrying={settings.isFetching} onRetry={() => { void settings.refetch(); }} />}
        {s && (
          <div className="kv" style={{ gridTemplateColumns: '150px minmax(0,1fr)' }}>
            <span className="kv-l">야간 점검</span><span className="kv-v mono">매일 {s.nightAt}</span>
            <span className="kv-l">실패 테스트 재시도</span><span className="kv-v">{s.retry}회 — 재시도로만 통과하면 불안정 후보</span>
            <span className="kv-l">서비스 기동</span><span className="kv-v mono">{serviceLabel(s.serviceConfig ?? null)}</span>
            <span className="kv-l">배포 확인 URL</span><span className="kv-v mono">{s.deployUrl ?? '설정되지 않음'}</span>
            <span className="kv-l">동시 실행</span><span className="kv-v">무거운 작업 상한(설정 → Runner · 실행 환경 → 동시 실행)을 Agent 세션과 함께 적용</span>
          </div>
        )}
      </section>
    </>
  );
}

/**
 * 서비스 기동 구성(M7-04 fix2 계약 5). Runner가 main 커밋에서 읽은 구성 파일이다.
 * 원본 문구 「docker compose — docker-compose.ci.yml」 모양을 따른다. 아직 관측되지 않았으면 꾸미지 않는다.
 */
function serviceLabel(cfg: { path: string; commit: string; status: string; error: string | null } | null): string {
  if (!cfg) return '아직 관측되지 않음 — Runner가 main에서 구성 파일을 읽으면 표시됩니다';
  if (cfg.status === 'missing') return `${cfg.path} 없음 (main @ ${short(cfg.commit)})`;
  if (cfg.status === 'error') return `${cfg.path} 해석 실패 — ${cfg.error ?? '원인 미보고'}`;
  return `docker compose — ${cfg.path}`;
}

/* ---------------- 불안정 테스트 ---------------- */

function FlakyTab({ items, projectId }: { items: FlakyTest[]; projectId: string }) {
  return (
    <section className="card">
      <div className="dp-h"><h2>불안정 테스트</h2></div>
      <p className="fhint" style={{ margin: '0 0 8px' }}>가끔만 실패하는 테스트는 재작업을 끝없이 만들 수 있어 격리합니다. 격리된 테스트는 실패해도 통과를 막지 않되 결과는 기록하고, 담당 Task에 수정이 배정됩니다.</p>
      {items.length === 0 && (
        <>
          <p className="empty">불안정 테스트가 없습니다.</p>
          <p className="fhint" style={{ margin: 0 }}>재시도로만 통과한 테스트가 생기면 야간 점검이 불안정 후보로 기록하고 여기에 보입니다.</p>
        </>
      )}
      {items.length > 0 && (
        <TableScroll minWidth={760} label="불안정 테스트 표">
          <div className="gtb" style={{ margin: 0 }} role="table" aria-label="불안정 테스트">
            {items.map((f) => <FlakyRow key={f.id} item={f} projectId={projectId} />)}
          </div>
        </TableScroll>
      )}
    </section>
  );
}

/**
 * 격리·해제 한 줄. 요청은 「토글」이 아니라 「quarantined를 이 값으로」라는 절대값이다.
 * 왜: 다시 시도·다시 적용으로 같은 요청이 두 번 가도 결과가 같다(두 번 토글되어 원래대로 돌아가지 않는다).
 */
function FlakyRow({ item: f, projectId }: { item: FlakyTest; projectId: string }) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const want = useRef(!f.quarantined);
  const key = apiKey('listFlakyTests', { params: { projectId } });
  const put = (next: FlakyTest) => {
    queryClient.setQueryData<{ items: FlakyTest[] }>(key, (old) => (old ? { items: old.items.map((x) => (x.id === next.id ? next : x)) } : old));
  };
  const save = useSave<FlakyTest, { updatedAt: string; quarantined: boolean }>({
    target: `${f.testKey} ${f.quarantined ? '격리 해제' : '다시 격리'}`,
    mine: f.quarantined ? '격리 해제' : '다시 격리',
    request: () => ({ updatedAt: f.updatedAt, quarantined: want.current }),
    run: ({ payload }) => client.call('updateFlakyTest', { params: { projectId, id: f.id }, body: payload }),
    onSuccess: (next) => { put(next); },
    successNotice: '불안정 테스트 상태를 바꿨습니다.',
    onConflictReload: async ({ signal }) => {
      const latest = await client.call('listFlakyTests', { params: { projectId }, signal });
      if (!signal.aborted) queryClient.setQueryData(key, latest);
    },
    reapplyRequest: async ({ signal }) => {
      const latest = await client.call('listFlakyTests', { params: { projectId }, signal });
      queryClient.setQueryData(key, latest);
      const now = latest.items.find((x) => x.id === f.id);
      if (!now) throw new Error('불안정 테스트가 더 이상 없습니다.');
      return { updatedAt: now.updatedAt, quarantined: want.current };
    },
  });
  const st = f.quarantined ? { l: '격리', c: 'vf v-run' } : { l: '정상 (격리 해제)', c: 'vf v-pass' };
  return (
    <>
    <div className="gtr" role="row" style={{ gridTemplateColumns: 'minmax(220px,1fr) 110px 148px 140px 100px 100px', minWidth: 0 }}>
      <span className="gc mono" role="cell">{f.testKey}</span>
      <span className="gc" role="cell">{f.rate}</span>
      <span className="gc mono" role="cell" title="마지막 실패 시각">{f.lastFailedAt ? formatDateTime(f.lastFailedAt) : '—'}</span>
      <span className="gc" role="cell"><span className={st.c}>{st.l}</span></span>
      <span className="gc" role="cell">{f.taskKey ? <Link className="reflink mono" to={LINK.task(f.taskKey)}>{f.taskKey}</Link> : '—'}</span>
      <span className="gc" role="cell">
        <BusyButton busy={save.busy} busyLabel="저장 중…" variant="ghost" small onClick={() => { want.current = !f.quarantined; void save.save(); }}>{f.quarantined ? '격리 해제' : '다시 격리'}</BusyButton>
      </span>
    </div>
    {save.conflictModal}
    </>
  );
}
