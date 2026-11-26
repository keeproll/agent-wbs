/**
 * 검증(UI-07) — 원본 P L1902–1968을 그대로 옮긴 화면. 탭 3개: 검증 결과(UI-07-01)·Evidence(UI-07-02)·Completion Gate(UI-07-03).
 *
 * 주소(새로고침·뒤로 가기·알림 링크로 같은 화면이 열린다, MM-29):
 * - `/verify` 검증 결과 목록, `/verify?sel=<검증 id>` 레일 + 상세(UI-07-01A)
 * - `/verify?tab=evidence`, `/verify?tab=gate`(`&gate=all`이면 전체)
 * - 판정·Agent 필터: `result=FAIL`, `agent=Codex`
 *
 * 키보드(UAT-TASK-11): 상세에서 ↑/K 이전, ↓/J 다음, Esc는 「펼치기」(목록으로). 목록에서 ↑↓로 행 이동, Enter로 열기.
 * 글자 입력 중이거나 창(모달)이 열려 있으면 동작하지 않는다.
 *
 * 데이터(모두 계약 타입): GET /api/verifications·/api/evidence(모든 쪽), /api/gates, /api/projects/:id/tasks(제목·상태),
 * 검증이 있는 Task마다 GET /api/tasks/:taskKey/attempts(검증 Agent·실행 시도 번호), 상세 Task의 GET /api/tasks/:taskKey(체크리스트).
 */
import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { fetchAllPages, useAllPages } from '../../shared/api/allPages.ts';
import { useApiQuery } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import { MenuScreen, useRefreshError, useRevisitFetching, type ProjectState } from '../../shared/layout/MenuScreen.tsx';
import { Page } from '../../shared/layout/Page.tsx';
import { LoadError } from '../../shared/ui/LoadError.tsx';
import { AreaLoading, PageSkeleton, useDelayedFlag } from '../../shared/ui/loading.tsx';
import { TableScroll } from '../../shared/ui/TableScroll.tsx';
import { useTopBar } from '../../shared/ui/feedback.tsx';
import { EvidenceLinks } from './EvidenceLinks.tsx';
import { GATE_LABEL, LINK, statusLabel, verdictClass } from './labels.ts';
import {
  evidenceName, evidenceRows, gateRows, orphanEvidence, position, resultRows, tabCounts, verificationKeys,
  type AttemptInfo, type EvidenceItem, type GateItem, type TaskItem, type VerificationItem,
} from './model.ts';
import './screens.css';

const TITLE = '검증';
const SUB = 'QA · 재검증 결과, Evidence 연결, Completion Gate 판정 — QA 결과 등록은 [작업 실행]에서 실행 시도 단위로 합니다';
/** 원본 열 폭(P vGrid L6339, evGrid L6351, gGrid L6356) */
const V_GRID = '96px 110px minmax(160px,1fr) 110px 88px 80px 148px 70px 80px';
const EV_GRID = 'minmax(240px,1.4fr) 100px 96px 110px minmax(140px,1fr) 90px';
const G_GRID = '96px minmax(160px,1fr) 104px repeat(5, 92px) 92px';

type Tab = 'results' | 'evidence' | 'gate';

export function VerifyPage() {
  return <MenuScreen menu="verify">{(project) => <VerifyBody project={project} />}</MenuScreen>;
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
const modalOpen = () => document.querySelector('[role="dialog"],[role="alertdialog"]') !== null;

function VerifyBody({ project }: { project: ProjectState }) {
  const { client } = useApi();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const tab: Tab = params.get('tab') === 'evidence' ? 'evidence' : params.get('tab') === 'gate' ? 'gate' : 'results';
  const sel = params.get('sel') ?? '';
  const filter = { result: params.get('result') ?? '', agent: params.get('agent') ?? '' };
  const gateAll = params.get('gate') === 'all';
  const setParam = (patch: Record<string, string>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
      return next;
    });
  };

  const projectId = 'id' in project ? String(project.id) : '';
  const verifs = useAllPages('listVerifications', {}, { topics: ['verification'] });
  const evidence = useAllPages('listEvidence', {}, { topics: ['verification', 'task'] });
  const gates = useApiQuery('listGates', {}, { topics: ['task', 'verification', 'attempt', 'ci'] });
  const tasks = useApiQuery('listTasks', { params: { projectId } }, { topics: ['task'], enabled: projectId !== '' });
  const queries = [verifs, evidence, gates, tasks] as const;

  const taskKeys = useMemo(() => [...new Set((verifs.data?.items ?? []).map((v) => v.taskKey))].sort(), [verifs.data]);
  const attemptQs = useQueries({
    queries: taskKeys.map((taskKey) => ({
      queryKey: ['allPages', 'getTaskAttempts', { params: { taskKey } }] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchAllPages(client, 'getTaskAttempts', { params: { taskKey } }, signal),
      meta: { topics: ['attempt'] },
    })),
  });
  const attempts = useMemo(() => {
    const m = new Map<string, AttemptInfo>();
    for (const q of attemptQs) for (const a of q.data?.items ?? []) m.set(a.id, { attemptKey: a.attemptKey, agent: String(a.agent) });
    return m;
  }, [attemptQs]);

  const loading = queries.some((q) => q.data === undefined);
  const skeleton = useDelayedFlag(loading && queries.some((q) => q.fetchStatus === 'fetching'));
  const revisit = [useRevisitFetching(verifs), useRevisitFetching(evidence), useRevisitFetching(gates), useRevisitFetching(tasks)];
  useTopBar(revisit.some(Boolean));
  useRefreshError(verifs, '검증 결과 최신 내용 불러오기');
  useRefreshError(evidence, 'Evidence 최신 내용 불러오기');
  useRefreshError(gates, 'Completion Gate 최신 내용 불러오기');
  useRefreshError(tasks, 'Task 목록 최신 내용 불러오기');

  const failed = queries.find((q) => q.data === undefined && q.isError);
  if (failed?.error) {
    return <LoadError title={TITLE} error={failed.error} retrying={failed.isFetching} onRetry={() => { for (const q of queries) if (q.isError) void q.refetch(); }} />;
  }
  if (loading || !verifs.data || !evidence.data || !gates.data || !tasks.data) {
    return <div className="page scroll">{skeleton && <PageSkeleton menu="verify" />}</div>;
  }

  const allV = verifs.data.items;
  const allE = evidence.data.items;
  const counts = tabCounts(allV, allE, gates.data.items, tasks.data.tasks);
  const tabs: [Tab, string, string][] = [
    ['results', '검증 결과', String(counts.results)],
    ['evidence', 'Evidence', String(counts.evidence)],
    ['gate', 'Completion Gate', `${String(counts.gateUnpassed)} 미통과`],
  ];
  const ctx: Ctx = {
    verifs: allV, evidence: allE, tasks: tasks.data.tasks, attempts, keys: verificationKeys(allV),
    titles: new Map(tasks.data.tasks.map((t) => [t.taskKey, t.title])),
    attemptsLoading: attemptQs.some((q) => q.isPending),
  };

  return (
    <Page title={TITLE} sub={SUB}>
      <div className="seg pgtabs" role="group" aria-label="검증 화면 탭">
        {tabs.map(([k, l, n]) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => { setParam({ tab: k === 'results' ? '' : k }); }}>{l} <span className="mono">{n}</span></button>
        ))}
      </div>
      {tab === 'results' && (
        <ResultsTab
          ctx={ctx} sel={sel} filter={filter}
          onFilter={(patch) => { setParam(patch); }}
          onSelect={(id) => { setParam({ sel: id }); }}
          onOpenTask={(path) => { void navigate(path); }}
        />
      )}
      {tab === 'evidence' && <EvidenceTab ctx={ctx} onOpen={(id) => { setParam({ tab: '', sel: id }); }} />}
      {tab === 'gate' && <GateTab gates={gates.data.items} tasks={tasks.data.tasks} all={gateAll} onAll={(all) => { setParam({ gate: all ? 'all' : '' }); }} />}
    </Page>
  );
}

interface Ctx {
  verifs: VerificationItem[];
  evidence: EvidenceItem[];
  tasks: TaskItem[];
  attempts: ReadonlyMap<string, AttemptInfo>;
  keys: ReadonlyMap<string, string>;
  titles: ReadonlyMap<string, string>;
  attemptsLoading: boolean;
}

const RESULT_OPTS = [['', '전체'], ['PASS', 'PASS'], ['FAIL', 'FAIL'], ['BLOCKED', 'BLOCKED']] as const;
const AGENT_OPTS = [['', '전체'], ['Codex', 'Codex'], ['Claude', 'Claude']] as const;

function ResultsTab({ ctx, sel, filter, onFilter, onSelect, onOpenTask }: {
  ctx: Ctx; sel: string; filter: { result: string; agent: string };
  onFilter: (patch: Record<string, string>) => void; onSelect: (id: string) => void; onOpenTask: (path: string) => void;
}) {
  const rows = resultRows(ctx.verifs, ctx.attempts, filter);
  const selected = sel ? ctx.verifs.find((v) => v.id === sel) ?? null : null;
  const pos = position(rows, sel);
  const listRef = useRef<HTMLDivElement>(null);

  // 상세 키보드: ↑/K 이전, ↓/J 다음, Esc 펼치기(UAT-TASK-11)
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typing(e.target) || modalOpen()) return;
      const k = e.key;
      if ((k === 'ArrowUp' || k === 'k' || k === 'K') && pos.prev) { e.preventDefault(); onSelect(pos.prev); }
      else if ((k === 'ArrowDown' || k === 'j' || k === 'J') && pos.next) { e.preventDefault(); onSelect(pos.next); }
      else if (k === 'Escape') { e.preventDefault(); onSelect(''); }
    };
    addEventListener('keydown', onKey);
    return () => { removeEventListener('keydown', onKey); };
  }, [selected, pos.prev, pos.next, onSelect]);

  const agentOf = (v: VerificationItem) => ctx.attempts.get(v.attemptId)?.agent ?? (ctx.attemptsLoading ? '…' : '—');
  const attemptOf = (v: VerificationItem) => ctx.attempts.get(v.attemptId)?.attemptKey ?? (ctx.attemptsLoading ? '…' : '—');
  const evCount = (id: string) => ctx.evidence.filter((e) => e.verificationId === id).length;
  const keyOf = (v: VerificationItem) => ctx.keys.get(v.id) ?? v.id.slice(0, 8);

  if (sel && !selected) {
    return (
      <div className="banner danger" role="alert">
        <div className="banner-b"><b>검증 결과를 찾을 수 없습니다 (404)</b> — 삭제됐거나 잘못된 주소입니다. <button type="button" className="btn sm" onClick={() => { onSelect(''); }}>목록으로</button></div>
      </div>
    );
  }

  if (!selected) {
    const rowKey = (e: ReactKeyboardEvent<HTMLDivElement>, id: string) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const all = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-vrow]') ?? [])];
      const i = all.indexOf(e.currentTarget);
      all[e.key === 'ArrowDown' ? Math.min(all.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
    };
    return (
      <>
        <div className="fbar">
          <span className="muted">판정</span>
          <div className="seg" role="group" aria-label="판정">
            {RESULT_OPTS.map(([v, l]) => <button key={l} type="button" aria-pressed={filter.result === v} onClick={() => { onFilter({ result: v }); }}>{l}</button>)}
          </div>
          <span className="muted">검증 Agent</span>
          <div className="seg" role="group" aria-label="검증 Agent">
            {AGENT_OPTS.map(([v, l]) => <button key={l} type="button" aria-pressed={filter.agent === v} onClick={() => { onFilter({ agent: v }); }}>{l}</button>)}
          </div>
        </div>
        <TableScroll minWidth={980} label="검증 결과 표">
          <div className="gtb" role="table" aria-label="검증 결과" ref={listRef}>
            <div className="gtr h" role="row" style={{ gridTemplateColumns: V_GRID }}>
              {['검증 ID', 'Task', '제목', '실행 시도', '판정', 'Agent', '시각', '결함', 'Evidence'].map((h) => <span key={h} className="gc" role="columnheader">{h}</span>)}
            </div>
            {rows.map((v) => (
              <div
                key={v.id} className="gtr vrow" role="row" tabIndex={0} data-vrow="" style={{ gridTemplateColumns: V_GRID }}
                aria-label={`${keyOf(v)} ${v.taskKey} ${String(v.result)} 상세 열기`}
                onClick={() => { onSelect(v.id); }} onKeyDown={(e) => { rowKey(e, v.id); }}
              >
                <span className="gc" role="cell"><span className="reflink">{keyOf(v)}</span></span>
                <span className="gc mono" role="cell">{v.taskKey}</span>
                <span className="gc" role="cell">{ctx.titles.get(v.taskKey) ?? ''}</span>
                <span className="gc mono" role="cell">{attemptOf(v)}</span>
                <span className="gc" role="cell"><span className={verdictClass(String(v.result))}>{String(v.result)}</span></span>
                <span className="gc" role="cell">{agentOf(v)}</span>
                <span className="gc mono" role="cell">{formatDateTime(v.at).slice(5)}</span>
                <span className="gc mono" role="cell">{v.defects.length}</span>
                <span className="gc mono" role="cell">{evCount(v.id)}</span>
              </div>
            ))}
            {ctx.verifs.length === 0 && (
              <div className="gtr" role="row" data-empty="none">
                <span className="gc muted" role="cell">아직 검증 결과가 없습니다. QA · 재검증이 끝나면 여기에 표시됩니다. 결과는 Runner가 실행 시도 단위로 보고합니다 — <Link to="/exec">작업 실행 열기</Link></span>
              </div>
            )}
            {ctx.verifs.length > 0 && rows.length === 0 && (
              <div className="gtr" role="row" data-empty="filtered">
                <span className="gc muted" role="cell">조건에 맞는 검증 결과가 없습니다. 필터를 바꿔 보세요. <button type="button" className="btn sm" onClick={() => { onFilter({ result: '', agent: '' }); }}>필터 초기화</button></span>
              </div>
            )}
          </div>
        </TableScroll>
      </>
    );
  }

  const ev = ctx.evidence.filter((e) => e.verificationId === selected.id);
  return (
    <div className="two">
      <aside className="side scrollc" aria-label="검증 결과 목록">
        <div className="rail-h">
          <span className="rail-ttl">검증 결과 <span className="mono muted">{rows.length}</span></span>
          <button type="button" className="btn sm rail-exp" onClick={() => { onSelect(''); }} title="상세를 닫고 원래 목록으로 펼칩니다">
            <svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6" /></svg>펼치기
          </button>
        </div>
        {rows.map((v) => (
          <button key={v.id} type="button" className={v.id === selected.id ? 'side-i on' : 'side-i'} aria-current={v.id === selected.id || undefined} onClick={() => { onSelect(v.id); }}>
            <span className="side-r"><span className="mono muted">{keyOf(v)}</span><span className={verdictClass(String(v.result))}>{String(v.result)}</span></span>
            <span className="side-t">{v.taskKey} {ctx.titles.get(v.taskKey) ?? ''}</span>
            <span className="muted">{agentOf(v)} · {formatDateTime(v.at).slice(5)}</span>
          </button>
        ))}
      </aside>
      <div className="mainc">
        <div className="card" aria-label={`검증 결과 ${keyOf(selected)} 상세`} role="region">
          <div className="vf-nav">
            <span className="sp" />
            <span className="muted mono" style={{ fontSize: 12 }}>{pos.label}</span>
            <button type="button" className="btn ghost sm" disabled={!pos.prev} onClick={() => { if (pos.prev) onSelect(pos.prev); }}>↑ 이전</button>
            <button type="button" className="btn ghost sm" disabled={!pos.next} onClick={() => { if (pos.next) onSelect(pos.next); }}>↓ 다음</button>
          </div>
          <div className="pane-h" style={{ margin: '0 0 8px' }}>
            <div className="att-h" style={{ margin: 0 }}>
              <span className="att-n mono">{keyOf(selected)}</span>
              <span className={verdictClass(String(selected.result))}>{String(selected.result)}</span>
              <span>{agentOf(selected)}</span>
              <span className="mono muted">{formatDateTime(selected.at)}</span>
              {selected.invalidated && <span className="tag chg" title="명세·코드가 바뀌어 이 결과는 Gate 판정에 쓰이지 않습니다">무효화됨</span>}
            </div>
            <span style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="btn sm" onClick={() => { onOpenTask(LINK.task(selected.taskKey, 'verif')); }}>{selected.taskKey} {ctx.titles.get(selected.taskKey) ?? ''}</button>
              <button type="button" className="btn sm" onClick={() => { onOpenTask(LINK.exec(selected.taskKey, selected.attemptId)); }}>실행 {attemptOf(selected)}</button>
            </span>
          </div>
          <div className="ev">
            <span className="ev-l">테스트 명령</span><span><code>{selected.cmd}</code></span>
            <span className="ev-l">예상 결과</span><span>{selected.expected || '—'}</span>
            <span className="ev-l">실제 결과</span><span>{selected.actual}</span>
            {selected.defects.length > 0 && (
              <>
                <span className="ev-l">결함 · 재작업 사유</span>
                <ul className="lst" style={{ margin: 0, color: '#8A1C12' }}>
                  {selected.defects.map((d) => <li key={d.defKey}>{d.text}{d.blocking ? ' (차단)' : ''}{d.resolved ? ' — 해결됨' : ''}</li>)}
                </ul>
              </>
            )}
          </div>
          <h4 style={{ marginTop: 16 }}>Evidence <span className="muted" style={{ fontWeight: 400 }}>체크리스트 항목을 눌러 이 Evidence와 연결하거나 해제합니다</span></h4>
          <TaskEvidence taskKey={selected.taskKey} evidence={ev} />
        </div>
      </div>
    </div>
  );
}

/** 상세 Task의 체크리스트를 읽어 연결 토글을 그린다. 다른 Task로 옮기면 화면을 새로 만든다(key). */
function TaskEvidence({ taskKey, evidence }: { taskKey: string; evidence: EvidenceItem[] }) {
  const task = useApiQuery('getTask', { params: { taskKey } }, { topics: ['task'], keepPrevious: false });
  useRefreshError(task, `${taskKey} 체크리스트 최신 내용 불러오기`);
  if (task.data === undefined && task.isError) {
    return (
      <div className="banner danger" role="alert">
        <div className="banner-b"><b>체크리스트를 불러오지 못했습니다</b> — 연결 상태를 볼 수 없습니다. <button type="button" className="btn sm" onClick={() => { void task.refetch(); }}>다시 시도</button></div>
      </div>
    );
  }
  if (task.data === undefined) return <AreaLoading label="체크리스트 불러오는 중" />;
  return <EvidenceLinks key={taskKey} task={task.data} evidence={evidence} />;
}

function EvidenceTab({ ctx, onOpen }: { ctx: Ctx; onOpen: (verificationId: string) => void }) {
  const rows = evidenceRows(ctx.evidence, ctx.verifs);
  const orphan = orphanEvidence(ctx.evidence);
  const byId = new Map(ctx.verifs.map((v) => [v.id, v]));
  return (
    <>
      <p className="fhint" style={{ margin: '0 0 8px' }}>모든 Evidence는 검증 결과에 속하며, 체크리스트 항목에 연결할 수 있습니다. 행을 누르면 검증 결과로 이동합니다.</p>
      <TableScroll minWidth={860} label="Evidence 표">
        <div className="gtb" role="table" aria-label="Evidence">
          <div className="gtr h" role="row" style={{ gridTemplateColumns: EV_GRID }}>
            {['Evidence', '유형', '검증', 'Task', '연결 체크리스트', '판정'].map((h) => <span key={h} className="gc" role="columnheader">{h}</span>)}
          </div>
          {rows.map((e) => {
            const v = e.verificationId ? byId.get(e.verificationId) : undefined;
            return (
              <div key={e.id} className="gtr" role="row" style={{ gridTemplateColumns: EV_GRID }}>
                <span className="gc mono" role="cell">
                  {v ? <button type="button" className="reflink" style={{ fontWeight: 500 }} onClick={() => { onOpen(v.id); }}>{evidenceName(e)}</button> : evidenceName(e)}
                </span>
                <span className="gc" role="cell"><span className="tag">{e.kind}</span></span>
                <span className="gc mono" role="cell">{v ? ctx.keys.get(v.id) : <span className="muted">검증 없음</span>}</span>
                <span className="gc mono" role="cell">{e.taskKey}</span>
                <span className={`gc mono ${e.linked ? '' : 'muted'}`.trim()} role="cell">{e.checklist}</span>
                <span className="gc" role="cell">{v ? <span className={verdictClass(String(v.result))}>{String(v.result)}</span> : <span className="muted">—</span>}</span>
              </div>
            );
          })}
          {rows.length === 0 && (
            <div className="gtr" role="row" data-empty="none">
              <span className="gc muted" role="cell">Evidence가 없습니다. Runner가 실행 · 검증 결과와 함께 Evidence 파일을 올리면 여기에 표시됩니다.</span>
            </div>
          )}
        </div>
      </TableScroll>
      {orphan.length > 0 && (
        <div className="banner warn" role="status">
          <div className="banner-b">
            <b>검증 결과에 없는 체크리스트 Evidence</b> — {orphan.map((o) => `${o.taskKey} ${o.checklistItemKey ?? ''} → ${evidenceName(o)}`).join(' · ')}. 검증 결과에 속한 Evidence로 다시 연결하세요.
          </div>
        </div>
      )}
    </>
  );
}

function GateTab({ gates, tasks, all, onAll }: { gates: GateItem[]; tasks: TaskItem[]; all: boolean; onAll: (all: boolean) => void }) {
  const rows = gateRows(gates, tasks, !all);
  return (
    <>
      <div className="fbar">
        <span className="muted">표시</span>
        <div className="seg" role="group" aria-label="표시">
          <button type="button" aria-pressed={!all} onClick={() => { onAll(false); }}>미통과만</button>
          <button type="button" aria-pressed={all} onClick={() => { onAll(true); }}>전체</button>
        </div>
        <span className="fhint">상태를 Completed로 바꾸는 것만으로는 완료되지 않습니다 — 5개 조건이 모두 PASS여야 완료 처리할 수 있습니다.</span>
      </div>
      <TableScroll minWidth={1000} label="Completion Gate 표">
        <div className="gtb" role="table" aria-label="Completion Gate">
          <div className="gtr h" role="row" style={{ gridTemplateColumns: G_GRID }}>
            {['Task', '제목', '상태', 'Checklist', '산출물', 'Verification', '차단 결함', '승인', '판정'].map((h) => <span key={h} className="gc" role="columnheader">{h}</span>)}
          </div>
          {rows.map((g) => {
            const st = statusLabel(g.status);
            return (
              <div key={g.taskKey} className="gtr" role="row" style={{ gridTemplateColumns: G_GRID }} data-task={g.taskKey}>
                <span className="gc" role="cell"><Link className="reflink" to={LINK.task(g.taskKey, 'checklist')}>{g.taskKey}</Link></span>
                <span className="gc" role="cell">{g.title}</span>
                <span className="gc" role="cell"><span className={`st ${st.c}`}><span className="st-d" aria-hidden="true" />{st.l}</span></span>
                {g.cells.map((c) => (
                  <span key={c.key} className="gc" role="cell" data-gate={c.key}>
                    <span className={verdictClass(c.result)} title={`${GATE_LABEL[c.key] ?? c.key} — ${c.reason}`}>{c.result}</span>
                    <span className="sr"> — {c.reason}</span>
                  </span>
                ))}
                <span className="gc" role="cell"><span className={g.all ? 'vf v-pass' : 'vf v-fail'}>{g.total}</span></span>
              </div>
            );
          })}
          {rows.length === 0 && (
            <div className="gtr" role="row" data-empty={all ? 'none' : 'filtered'}>
              <span className="gc muted" role="cell">{all ? 'Task가 없습니다. 초기 WBS를 승인하면 Task마다 5개 조건이 표시됩니다.' : '미통과 Task가 없습니다.'}</span>
            </div>
          )}
        </div>
      </TableScroll>
    </>
  );
}
