/**
 * Task 상세(UI-03E 요약·Gate + 9탭) — 원본 P L924–1355.
 *
 * 다른 화면(M3-02 WBS 화면)이 레일 옆에 이 컴포넌트를 놓는다. props 계약은 features/task/README.md §2.
 * 이 컴포넌트가 하지 않는 것: 레일·목록 필터·주소 바꾸기. 이동은 모두 props 콜백으로 부모에게 맡긴다.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { codeLabel } from '../../shared/ui/errors.ts';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { AreaLoading } from '../../shared/ui/loading.tsx';
import { useConfirm } from '../../shared/ui/feedback.tsx';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { EditSlotContext, type EditSlot } from './edit-slot.tsx';
import {
  agCls, agInit, GATE_LABEL, GATE_ORDER, priorityOf, SPEC_GROUPS, statusOf, TYPE_LABEL, VERIF, type TaskDetailData, type TaskSummaryData,
} from './labels.ts';
import { fmtH, md, slipState } from './schedule.ts';
import { ApprovalBar } from './ApprovalBar.tsx';
import { useTaskData, useTaskSave } from './useTaskData.ts';
import { OverviewTab } from './tabs/OverviewTab.tsx';
import { SpecTab } from './tabs/SpecTab.tsx';
import { DepsTab } from './tabs/DepsTab.tsx';
import { DesignTab, presentDesigns } from './tabs/DesignTab.tsx';
import { ChecklistTab } from './tabs/ChecklistTab.tsx';
import { ExecTab } from './tabs/ExecTab.tsx';
import { VerifTab } from './tabs/VerifTab.tsx';
import { HistoryTab } from './tabs/HistoryTab.tsx';
import { MessagesTab } from './tabs/MessagesTab.tsx';
import { useApiClient } from './useTaskData.ts';
import './task.css';

export const TABS = ['overview', 'spec', 'deps', 'tech', 'checklist', 'exec', 'verif', 'hist', 'msg'] as const;
export type TabKey = (typeof TABS)[number];
export const isTabKey = (v: string | null): v is TabKey => (TABS as readonly string[]).includes(v ?? '');

/** 상세 위쪽 이동 정보. 부모(WBS 화면)가 레일 순서로 계산해 넘긴다. */
export interface TaskNav {
  /** 「4 / 12」 또는 「목록 밖 (필터에 맞지 않음)」(P L5100) */
  posLabel: string;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  /** 링크로 이동해 왔으면 돌아갈 Task ID(P L929 「← TASK-xxxx로 돌아가기」) */
  backTo?: string | null | undefined;
  onBack?: (() => void) | undefined;
}

export interface TaskDetailProps {
  taskKey: string;
  projectId: string;
  tab: TabKey;
  onTab: (tab: TabKey) => void;
  nav: TaskNav;
  /** 선행·후속 등 참조 링크로 다른 Task를 연다. ref=true면 부모가 복귀 스택에 지금 Task를 쌓는다. */
  onOpenTask: (taskKey: string, ref: boolean) => void;
}

/** 원본 SPEC_GROUPS 기준 작성된 섹션 수(P L5221) */
export function specFilled(t: TaskDetailData): { filled: number; total: number } {
  let filled = 0;
  let total = 0;
  for (const g of SPEC_GROUPS) {
    for (const s of g.keys) {
      total += 1;
      const arr = s.key === '__out' ? t.spec.overview.out : s.key === '__outputs' ? t.outputs : s.key === 'ac' ? t.spec.ac : t.spec.spec[s.key];
      if (arr.length) filled += 1;
    }
  }
  return { filled, total };
}

export function TaskDetail({ taskKey, projectId, tab, onTab, nav, onOpenTask }: TaskDetailProps) {
  const data = useTaskData(taskKey, projectId);
  const [slot, setSlot] = useState<{ id: string; dirty: boolean } | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const { guard } = useEditGuard(slot?.dirty ?? false);
  const edit: EditSlot = useMemo(() => ({
    current: slot?.id ?? null,
    dirty: slot?.dirty ?? false,
    open: (id) => { setSlot((s) => s ?? { id, dirty: false }); },
    close: () => { setSlot(null); },
    setDirty: (dirty) => { setSlot((s) => (s && s.dirty !== dirty ? { ...s, dirty } : s)); },
  }), [slot]);

  const t = data.task.data;
  if (!t) {
    return (
      <section className="detail" aria-label="Task 상세">
        <div className="dt-body">
          {data.task.isError ? <TaskLoadError taskKey={taskKey} error={data.task.error} retrying={data.task.isFetching} onRetry={() => { void data.task.refetch(); }} /> : <AreaLoading label="Task 불러오는 중" />}
        </div>
      </section>
    );
  }

  const tasks = data.list.data?.tasks ?? [];
  const byKey = new Map(tasks.map((x) => [x.taskKey, x]));
  const st = statusOf(String(t.lifecycleStatus));
  const pri = priorityOf(Number(t.priority));
  const vf = VERIF[String(t.verifState)] ?? { l: String(t.verifState), c: 'v-none' };
  const wp = data.list.data?.nodes.find((n) => n.id === t.wbsNodeId);
  const preds = t.predecessors;
  const succs = t.successors;
  const blockers = String(t.lifecycleStatus) === 'done' ? [] : preds.filter((p) => !depMet(p.type, byKey.get(p.pred)));
  const blocked = t.blocked;
  const cl = { done: t.checklistItems.filter((c) => c.done).length, tot: t.checklistItems.length, reqLeft: t.checklistItems.filter((c) => c.required && !c.done).length };
  const clPct = cl.tot ? Math.round((cl.done / cl.tot) * 100) : 0;
  const gate = data.gate.data;
  const gateRows = GATE_ORDER.map((k) => gate?.conditions.find((c) => c.key === k)).filter((x) => x !== undefined);
  const gp = gate ? gate.conditions.filter((c) => c.result === 'PASS').length : t.gate.passed;
  const gt = gate ? gate.conditions.length : t.gate.total;
  const gatePass = gt > 0 && gp === gt;
  const spec = specFilled(t);
  const designCount = presentDesigns(t).length;
  const attempts = data.attempts.data?.items ?? [];
  const vers = data.verifications.data?.items ?? [];
  const hist = data.history.data?.items ?? [];
  const msgs = data.messages.data?.items ?? [];
  const msgAlert = msgs.some((m) => (m.dir === 'in' && !m.readAt) || m.delivery === 'Failed');
  const count = (q: { data?: unknown }, n: number) => (q.data === undefined ? '' : String(n));
  const tabsDef: [TabKey, string, string, boolean][] = [
    ['overview', '개요', '', false],
    ['spec', '작업 명세', `${String(spec.filled)}/${String(spec.total)}`, false],
    ['deps', '의존성', String(preds.length + succs.length), false],
    ['tech', '기술 설계', designCount ? String(designCount) : '', false],
    ['checklist', '체크리스트', cl.tot ? `${String(cl.done)}/${String(cl.tot)}` : '0', cl.reqLeft > 0],
    ['exec', '실행', count(data.attempts, attempts.length), false],
    ['verif', '검증·Evidence', count(data.verifications, vers.length), false],
    ['hist', '이력', count(data.history, hist.length), false],
    ['msg', '메시지', count(data.messages, msgs.length), msgAlert],
  ];
  const sch = t.schedule;
  const slip = slipState(t);
  const failG = gateRows.filter((g) => g.result !== 'PASS');
  const isDone = String(t.lifecycleStatus) === 'done';
  const gateNote = isDone ? '이미 완료 처리된 Task입니다.' : gatePass ? (blocked ? '선행 Task 차단이 해소되어야 완료할 수 있습니다.' : '모든 조건 충족 — 완료 처리할 수 있습니다.') : `완료 불가 — ${failG.map((g) => g.reason).join(' · ')}`;

  return (
    <EditSlotContext.Provider value={edit}>
      <section className="detail" aria-label="Task 상세">
        <div className="dt-head">
          <div className="dt-top">
            <div className="dt-crumbs">
              {nav.backTo && <button type="button" className="btn sm" onClick={nav.onBack}>← {nav.backTo}로 돌아가기</button>}
              <span className="mono muted">WBS {t.wbsPath}</span>
              <span className="idchip mono">{t.taskKey}</span>
              {wp && <span className="muted">Work Package {wp.wbsPath} {wp.title}</span>}
            </div>
            <div className="dt-acts">
              <span className="muted mono" style={{ fontSize: 12 }}>{nav.posLabel}</span>
              <button type="button" className="btn ghost sm" onClick={nav.onPrev} disabled={!nav.onPrev} aria-label="이전 Task">↑ 이전</button>
              <button type="button" className="btn ghost sm" onClick={nav.onNext} disabled={!nav.onNext} aria-label="다음 Task">↓ 다음</button>
            </div>
          </div>
          <h2 className="dt-title">{t.title}</h2>
          <div className="summary">
            <Sum l="작업 유형 / 기술 영역"><span className="wt">{TYPE_LABEL[String(t.workType)] ?? String(t.workType)}</span><span className="dm">{String(t.primaryDomain)}</span>{t.relatedDomains.length > 0 && <span className="dm-rel">+{t.relatedDomains.join(', ')}</span>}</Sum>
            <Sum l="현재 상태"><span className={`st ${st.c}`} title={st.tip}><span className="st-d" aria-hidden="true" />{st.l}</span></Sum>
            <Sum l="담당 → 검증 Agent"><Agent a={t.assigneeAgent} /><span className="muted">→</span><Agent a={t.verifierAgent} /></Sum>
            <Sum l="우선순위"><span className={`pri ${pri.c}`}>{pri.l}</span></Sum>
            <Sum l="선행 Task">
              {blocked
                ? <span className="blk"><svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z" /></svg>차단 {blockers.length || preds.length}건</span>
                : <span className="okt"><svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10" /></svg>{!preds.length ? '선행 없음' : isDone ? '완료된 Task' : `모두 충족 (${String(preds.length)}건)`}</span>}
            </Sum>
            <Sum l="체크리스트"><span className="cl-n">{cl.tot ? `${String(cl.done)}/${String(cl.tot)}` : '0/0'}</span><span className="muted">{cl.reqLeft ? `· 필수 ${String(cl.reqLeft)}건 남음` : cl.tot ? '· 필수 완료' : '· 항목 없음'}</span><span className={cl.tot && cl.done === cl.tot ? 'bar full' : 'bar'}><span className="bar-f" style={{ width: `${String(clPct)}%` }} /></span></Sum>
            <Sum l="Verification"><span className={`vf ${vf.c}`}>{vf.l}</span></Sum>
            <Sum l="Completion Gate"><button type="button" className={`gatebtn ${gatePass ? 'pass' : 'fail'}`} onClick={() => { setGateOpen((o) => !o); }} aria-expanded={gateOpen}>{gatePass ? `PASS ${String(gp)}/${String(gt)}` : `미통과 ${String(gp)}/${String(gt)}`} ▾</button></Sum>
            <Sum l={`일정 (예상 실행 ${sch ? fmtH(sch.estHours) : '—'})`}>
              <span className="mono" title={sch ? `범위 ${fmtH(sch.loHours)}~${fmtH(sch.hiHours)}` : undefined}>{sch?.end ? `${md(sch.end)}${isDone ? ' 완료' : ' 예상'}` : '—'}</span>
              {slip && <span className={`sc ${slip.c}`}>{slip.l}</span>}
            </Sum>
            <Sum l="진행률"><span className="cl-n">{sch ? `${String(sch.progressPct)}%` : '—'}</span><span className={sch?.progressPct === 100 ? 'bar full' : 'bar'} style={{ width: 90 }}><span className="bar-f" style={{ width: `${String(sch?.progressPct ?? 0)}%` }} /></span></Sum>
          </div>
          {gateOpen && <GatePanel rows={gateRows} note={gateNote} canComplete={gatePass && !isDone && !blocked} task={t} />}
          {blocked && (
            <div className="banner danger">
              <svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z" /></svg>
              <div className="banner-b"><b>실행 차단</b> — 선행 조건이 충족되지 않아 Runner 실행 요청을 할 수 없습니다.
                {blockers.map((b) => {
                  const pt = byKey.get(b.pred);
                  return <span key={b.id}> · <button type="button" className="reflink" onClick={() => { onOpenTask(b.pred, true); }}>{b.pred}</button> {pt?.title ?? ''} ({pt ? statusOf(String(pt.lifecycleStatus)).l : '상태 모름'}, {b.type === 'FS' ? '완료 필요' : '시작 필요'})</span>;
                })}
              </div>
            </div>
          )}
          <ApprovalBar task={t} />
          <div className="tabs" role="tablist" aria-label="Task 상세 탭">
            {tabsDef.map(([key, label, c, alert]) => (
              <button key={key} type="button" className={`tab${tab === key ? ' on' : ''}`} role="tab" aria-selected={tab === key} onClick={() => { if (tab !== key) void guard(() => { setSlot(null); onTab(key); }); }}>
                {label}{c !== '' && <span className={`tab-c${alert ? ' alert' : ''}`}>{c}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="dt-body" role="tabpanel">
          {tab === 'overview' && <OverviewTab task={t} byKey={byKey} nodes={data.list.data?.nodes ?? []} attempts={attempts} onOpenTask={onOpenTask} />}
          {tab === 'spec' && <SpecTab task={t} />}
          {tab === 'deps' && <DepsTab task={t} tasks={tasks} byKey={byKey} blocked={blocked} onOpenTask={onOpenTask} />}
          {tab === 'tech' && <DesignTab task={t} tasks={tasks} />}
          {tab === 'checklist' && <ChecklistTab task={t} />}
          {tab === 'exec' && <ExecTab task={t} attempts={data.attempts} />}
          {tab === 'verif' && <VerifTab task={t} verifications={data.verifications} evidence={data.evidence.data?.items ?? []} />}
          {tab === 'hist' && <HistoryTab history={data.history} />}
          {tab === 'msg' && <MessagesTab messages={data.messages} />}
        </div>
      </section>
    </EditSlotContext.Provider>
  );
}

/** 선행 관계가 충족됐는가: FS는 선행 완료, SS는 선행 시작(P Sel.depMet) */
export function depMet(type: unknown, pred: TaskSummaryData | undefined): boolean {
  if (!pred) return false;
  const s = String(pred.lifecycleStatus);
  if (String(type) === 'SS') return !['planning', 'approval', 'ready', 'cancelled'].includes(s);
  return s === 'done';
}

function Sum({ l, children }: { l: string; children: ReactNode }) {
  return <div className="sum-i"><span className="sum-l">{l}</span><span className="sum-v">{children}</span></div>;
}

export function Agent({ a }: { a: unknown }) {
  const name = a === null || a === undefined ? null : String(a);
  if (!name) return <span className="muted">미지정</span>;
  return <span className="agent"><span className={`ag-mk ${agCls(name)}`} aria-hidden="true">{agInit(name)}</span>{name}</span>;
}

function GatePanel({ rows, note, canComplete, task }: { rows: { key: unknown; result: unknown; reason: string }[]; note: string; canComplete: boolean; task: TaskDetailData }) {
  const confirm = useConfirm();
  const client = useApiClient();
  const complete = useTaskSave(task.taskKey, {
    target: `${task.taskKey} 완료 처리`,
    failTitle: '완료 처리하지 못했습니다',
    run: ({ idempotencyKey, updatedAt }) => client.call('completeTask', { params: { taskKey: task.taskKey }, body: { updatedAt }, idempotencyKey }),
    successNotice: `${task.taskKey}를 완료 처리했습니다. 후속 Task의 차단 여부와 일정 전망이 갱신되었습니다.`,
  });
  return (
    <div className="gate">
      {rows.map((g) => {
        const r = String(g.result);
        return <div className="gate-r" key={String(g.key)}><span>{GATE_LABEL[String(g.key)] ?? String(g.key)}</span><span className={`vf ${r === 'PASS' ? 'v-pass' : r === 'FAIL' ? 'v-fail' : 'v-blk'}`}>{r}</span><span className="muted">{g.reason}</span></div>;
      })}
      <div className="gate-f">
        <span className="muted">{note}</span>
        <BusyButton small busy={complete.busy} busyLabel="완료 처리 중…" disabled={!canComplete} onClick={() => {
          void confirm({ title: 'Task 완료 처리', body: `${task.taskKey} ${task.title}을(를) 완료 처리합니다. Completion Gate 5개 조건이 모두 PASS입니다.`, ok: '완료 처리' }).then((ok) => { if (ok) void complete.save(); });
        }}>Task 완료 처리</BusyButton>
      </div>
      {complete.conflictModal}
    </div>
  );
}

function TaskLoadError({ taskKey, error, retrying, onRetry }: { taskKey: string; error: Parameters<typeof codeLabel>[0]; retrying: boolean; onRetry: () => void }) {
  if (error.kind === 'notFound') {
    return (
      <div className="banner danger" role="alert">
        <div className="banner-b"><b>{taskKey}를 찾을 수 없습니다</b> <span className="mono">404 TASK_NOT_FOUND</span> — Change Proposal로 취소되었거나, 프로젝트 초기화로 삭제된 Task일 수 있습니다. 이전 보고서 · 메시지의 링크로 열었다면 그 이후에 바뀌었습니다.</div>
      </div>
    );
  }
  return (
    <section className="card load-err" aria-label="Task 불러오기 실패">
      <h3>{taskKey} 상세를 불러오지 못했습니다</h3>
      <p>서버가 요청을 처리하지 못했습니다 ({codeLabel(error)}). 잠시 후 다시 시도하세요.</p>
      <div className="form-acts" style={{ justifyContent: 'flex-start' }}>
        <BusyButton busy={retrying} busyLabel="다시 불러오는 중…" onClick={onRetry}>다시 시도</BusyButton>
      </div>
    </section>
  );
}
