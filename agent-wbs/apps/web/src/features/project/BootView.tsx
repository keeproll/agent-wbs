/**
 * UI-02B 초기 분석 진행(P L749–758) + UI-02C 기술 결정 확정(P L760–773) + UI-02D WBS 초안·최초 승인(P L774–786).
 *
 * - 단계는 Runner 보고(GET /api/project의 bootstrap.steps)만 보여 준다. 화면이 시간 경과로 단계를 넘기지 않는다(UAT-PROJECT-04).
 *   원본의 「일시정지 (Mock)」 버튼은 Mock 전용이라 만들지 않는다.
 * - 기술 결정 승인·반려는 결정 id(안정 키)로 모아 두었다가 「기술 결정 확정」 한 번에 보낸다(confirmTech).
 * - 승인·재분석은 화면이 본 초안 revision을 보낸다. 그사이 새 초안이 왔으면 409 충돌이고, 본 적 없는 새 초안을 자동으로 승인하지 않는다(UAT-PROJECT-07).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import type { ResponseOf } from '../../shared/api/contract.ts';
import { invalidateTopics, useApiQuery } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import { useDocumentTitle } from '../../shared/layout/Page.tsx';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { useNotice } from '../../shared/ui/feedback.tsx';
import { BOOT_STEPS, fmtH, STEP_CHIP, TECH_AUTH, TECH_LV, TECH_ST, TYPE_LABEL, shortSha, type BootProject, type Decision, type StepStatus } from './labels.ts';
import { CleanupBanner } from './ResetHistory.tsx';
import { useReapply } from './useReapply.ts';
import { ResetModal } from './ResetModal.tsx';

type Pick = 'approve' | 'reject';
type Draft = NonNullable<BootProject['bootstrap']['draft']>;

/** 초안을 Phase → Work Package → Task 트리 행으로 편다(P setupVM tree). 번호는 화면 표시용이다. */
export function draftTree(draft: Draft) {
  const wpsOf = (phase: string) => draft.wps.filter((w) => w.phaseRef === phase);
  const tasksOf = (wp: string) => draft.tasks.filter((t) => t.wpRef === wp);
  // 1단계: 선행 표시에 쓸 번호(1.2.3)를 먼저 모두 매긴다. 선행이 뒤쪽 Task일 수도 있기 때문이다.
  const num = new Map<string, string>();
  draft.phases.forEach((ph, i) => { wpsOf(ph.ref).forEach((w, j) => { tasksOf(w.ref).forEach((t, k) => { num.set(t.ref, `${String(i + 1)}.${String(j + 1)}.${String(k + 1)}`); }); }); });
  // 2단계: 트리 행을 차례로 만든다.
  const rows: { key: string; cls: string; l: string; meta: string }[] = [];
  draft.phases.forEach((ph, i) => {
    rows.push({ key: ph.ref, cls: 'dr-ph', l: `${String(i + 1)}. ${ph.title}`, meta: '' });
    wpsOf(ph.ref).forEach((w, j) => {
      rows.push({ key: w.ref, cls: 'dr-wp', l: `${String(i + 1)}.${String(j + 1)} ${w.title}`, meta: '' });
      for (const t of tasksOf(w.ref)) {
        const e = t.estimate;
        const preds = draft.deps.filter((d) => d.succRef === t.ref).map((d) => num.get(d.predRef) ?? d.predRef);
        rows.push({ key: t.ref, cls: 'dr-t', l: `${num.get(t.ref) ?? ''} ${t.title}`,
          meta: `${TYPE_LABEL[t.workType] ?? t.workType} / ${t.primaryDomain} · ${t.assigneeAgent} 개발 · ${t.verifierAgent} 검증 · ${fmtH(e.estHours)} (${fmtH(e.loHours)}~${fmtH(e.hiHours)})${preds.length ? ` · 선행 ${preds.join(', ')}` : ''}` });
      }
    });
  });
  const est = draft.tasks.reduce((a, t) => a + t.estimate.estHours, 0);
  const sum = `Phase ${String(draft.phases.length)} · Work Package ${String(draft.wps.length)} · Task ${String(draft.tasks.length)} · 의존성 ${String(draft.deps.length)} · 예상 작업량 ${fmtH(est)} (Agent 실행 시간)`;
  return { rows, sum };
}

/** 카드의 편집 여부를 화면(BootView)에 알린다. 카드가 사라지면 편집 없음으로 돌린다. */
function useReportDirty(dirty: boolean, onDirty: (dirty: boolean) => void) {
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => { onDirty(false); }, [onDirty]);
}

export function BootView({ project }: { project: BootProject }) {
  useDocumentTitle('초기 분석');
  const b = project.bootstrap;
  const runner = useApiQuery('getRunnerState', {}, { topics: ['runner'] });
  const online = runner.data?.connection.online;
  const stepOf = (key: string) => b.steps.find((s) => s.key === key)?.status as StepStatus | undefined;
  const failed = b.steps.find((s) => s.status === 'fail');
  const waitRunner = online === false || project.cleanup !== 'none';
  const input = project.inputs.find((i) => i.v === 1) ?? project.inputs[0];
  const [resetOpen, setResetOpen] = useState(false);
  /**
   * 편집 보호는 화면에 하나만 둔다(리뷰 M3-04 P1). React Router의 useBlocker는 한 번에 보호기 하나만 지원해,
   * 기술 결정 카드와 초안 카드가 각각 보호기를 두면 뒤의 dirty=false가 앞의 선택을 덮어 묻지 않고 이동했다.
   * 그래서 두 카드는 편집 여부만 알리고, 여기서 합쳐 한 번만 등록한다.
   */
  const [techDirty, setTechDirty] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  useEditGuard(techDirty || draftDirty);

  return (
    <div className="page scroll">
      <CleanupBanner project={project} />
      <div className="page-h">
        <div>
          <h1>초기 분석 <span className="mono muted" style={{ fontSize: 15 }}>PL-000</span> {b.runNo > 1 && <span className="tag">재분석 {b.runNo - 1}회</span>}</h1>
          <p className="page-sub">입력 prototype/ (uiux · docs) (md {input?.mdList.length ?? 0}개) @ {shortSha(input?.commit)} · 저장소 {project.repo.owner}/{project.repo.name} ({project.repo.branch} @ {shortSha(project.repo.baseCommit)})</p>
        </div>
        <button type="button" className="btn ghost" onClick={() => { setResetOpen(true); }}>등록 취소 (초기화)</button>
      </div>
      {waitRunner && <div className="banner warn" role="status"><div className="banner-b">{project.cleanup !== 'none' ? '이전 초기화의 Runner 정리가 끝나야 진행됩니다 — Runner를 연결하세요.' : 'Runner 연결이 끊겨 초기 분석이 멈춰 있습니다 — 다시 연결되면 이어서 진행합니다.'}</div></div>}
      {b.fail && <BootFailure project={project} stepLabel={failed ? BOOT_STEPS[String(failed.key)]?.[0] ?? String(failed.key) : '초기 분석'} onCancel={() => { setResetOpen(true); }} />}
      <div className="cmp" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)' }}>
        <section className="card" aria-labelledby="bs-h">
          <div className="dp-h"><h2 id="bs-h">진행 단계</h2><span className="fhint">Runner 보고에 따라 진행됩니다</span></div>
          <ol className="bsteps" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="초기 분석 단계">
            {b.steps.map((s, i) => {
              const [l, d] = BOOT_STEPS[String(s.key)] ?? [String(s.key), ''];
              const st = s.status as StepStatus;
              const [c, sl] = STEP_CHIP[st];
              return (
                <li key={String(s.key)} className={`bs bs-${st}`} data-step={s.key}>
                  <span className="bs-n">{i + 1}</span>
                  <div><b>{l}</b> <span className={c}>{s.key === 'approve' && st === 'run' ? '팀장 확인 대기' : sl}</span>
                    <div className="muted" style={{ fontSize: 12 }}>{d}</div>
                    {s.note && <div style={{ fontSize: 12 }}>{s.note}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
          <h3 className="h4l">팀장 지시</h3><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{project.instruction || '(지시 없음)'}</p>
          <h3 className="h4l">Runner 보고</h3>
          {b.logs.length === 0 && <p className="muted" style={{ margin: 0 }}>아직 Runner 보고가 없습니다. Runner가 단계를 시작하면 여기에 보입니다.</p>}
          {[...b.logs].reverse().slice(0, 8).map((l, i) => <div key={`${l.at}-${String(i)}`} className="rpt-li"><span className="mono muted">{formatDateTime(l.at)}</span><span>{l.text}</span></div>)}
        </section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {b.decisions.length > 0 && <TechPanel project={project} techStep={stepOf('tech')} onDirty={setTechDirty} />}
          <DraftPanel project={project} onDirty={setDraftDirty} />
        </div>
      </div>
      {resetOpen && <ResetModal project={project} onClose={() => { setResetOpen(false); }} />}
    </div>
  );
}


function BootFailure({ project, stepLabel, onCancel }: { project: BootProject; stepLabel: string; onCancel: () => void }) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const b = project.bootstrap;
  const refresh = () => { void invalidateTopics(queryClient, ['project']); };
  type RetryBody = { revision: number } | { revision: null; runNo: number };
  const retry = useSave<unknown, RetryBody>({
    target: '초기 분석 다시 시도',
    failTitle: '다시 시도를 요청하지 못했습니다',
    request: () => (b.revision !== null ? { revision: b.revision } : { revision: null, runNo: b.runNo }),
    run: ({ payload, idempotencyKey }) => client.call('retryBootstrap', { body: payload, idempotencyKey }),
    onSuccess: refresh,
    successNotice: '실패한 단계부터 다시 시도합니다.',
    onRejected: refresh,
    onConflictReload: refresh,
    onConflictReapply: async () => { await queryClient.invalidateQueries({ queryKey: ['getProject'] }); },
  });
  return (
    <div className="banner danger" data-testid="boot-fail">
      <div className="banner-b"><b>{stepLabel} 실패</b> — {b.fail?.reason}
        <div style={{ marginTop: 4 }}>{b.fail?.fix}</div>
        <div className="msg-acts" style={{ marginTop: 6 }}>
          <BusyButton small busy={retry.busy} busyLabel="요청 중…" onClick={() => { void retry.save(); }}>다시 시도</BusyButton>
          <button type="button" className="btn ghost sm" onClick={onCancel}>등록 취소 (초기화)</button>
        </div>
      </div>
      {retry.conflictModal}
    </div>
  );
}

/** UI-02C 기술 결정 확정 */
function TechPanel({ project, techStep, onDirty }: { project: BootProject; techStep: StepStatus | undefined; onDirty: (dirty: boolean) => void }) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const notify = useNotice();
  const decisions = project.bootstrap.decisions;
  const waiting = techStep === 'run';
  /** 결정 id → 고른 값. 위치가 아니라 id로 기억한다. */
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [err, setErr] = useState('');
  const pending = decisions.filter((d) => d.status === 'pending');
  const chosen = Object.fromEntries(Object.entries(picks).filter(([id]) => pending.some((d) => d.id === id)));
  const left = pending.filter((d) => !chosen[d.id]).length;
  const dirty = Object.keys(chosen).length > 0;
  useReportDirty(dirty, onDirty);
  const { restoreOffer } = useSessionDraft<Record<string, Pick>>({
    id: `project:boot:tech:${project.bootstrap.jobId}`, label: '기술 결정 승인 · 반려 선택', value: dirty ? chosen : null,
    onRestore: (data) => { setPicks(data); },
  });
  const refresh = () => { void invalidateTopics(queryClient, ['project']); };

  interface Body { decisions: { id: string; choice: Pick; updatedAt: string }[] }
  const build = (list: readonly Decision[], from: Record<string, Pick>): Body => ({
    decisions: list.filter((d) => d.status === 'pending' && from[d.id]).map((d) => ({ id: d.id, choice: from[d.id] as Pick, updatedAt: d.updatedAt })),
  });
  // 충돌 재적용 요청은 결과가 확인될 때까지 같은 본문·키로 다시 보낸다(useReapply).
  const reapply = useReapply<Body>();
  const confirm = useSave<ResponseOf<'confirmTech'>, Body>({
    target: '기술 결정 확정',
    failTitle: '확정하지 못했습니다',
    mine: `기술 결정 승인 ${String(Object.values(chosen).filter((v) => v === 'approve').length)} · 반려 ${String(Object.values(chosen).filter((v) => v === 'reject').length)}`,
    request: () => build(decisions, chosen),
    run: ({ payload, idempotencyKey }) => client.call('confirmTech', { params: { projectId: project.id }, body: payload, idempotencyKey }),
    onSuccess: (_, payload) => {
      // 보낸 선택과 지금 선택이 같을 때만 지운다(재시도 사이에 바꾼 선택은 남긴다).
      setPicks((cur) => (payload.decisions.every((d) => cur[d.id] === d.choice) ? {} : cur));
      refresh();
    },
    successNotice: '기술 결정을 확정했습니다. 이 결정을 기준으로 WBS 초안을 작성합니다.',
    onRejected: refresh,
    onConflictReload: () => { setPicks({}); refresh(); },
    onConflictReapply: async () => {
      await reapply(async () => {
        const latest = await client.call('getProject', {});
        if (!('bootstrap' in latest)) throw new Error('초기 분석 단계가 아닙니다.');
        return build(latest.bootstrap.decisions, chosen);
      }, (body, key) => client.call('confirmTech', { params: { projectId: project.id }, body, idempotencyKey: key }));
      setPicks({});
      refresh();
      notify('최신 결정에 내 선택을 다시 적용해 확정했습니다.');
    },
  });
  const submit = () => {
    if (left > 0) { setErr('승인 · 반려를 정하지 않은 제안이 있습니다. 모든 「Agent 제안」 항목을 정한 뒤 확정하세요.'); return; }
    setErr('');
    void confirm.save();
  };

  const stL = waiting ? '팀장 확인 대기' : techStep === 'done' ? '확정됨' : '대기';
  return (
    <section className="card" aria-labelledby="tech-h">
      <div className="dp-h"><h2 id="tech-h">기술 결정 확정</h2><span className={waiting ? 'sc sc-warn' : 'sc sc-ok'}>{stL}</span></div>
      {restoreOffer}
      <p className="fhint" style={{ margin: '0 0 8px' }}>팀장 지정 제약은 그대로 확정되고, Agent 제안은 하나씩 승인 · 반려합니다. 확정해야 WBS 초안 작성이 시작됩니다 — 초기 WBS 승인과는 별도 단계입니다.</p>
      {decisions.map((x) => {
        const pick = chosen[x.id];
        const shown = pick ? (pick === 'approve' ? 'approved' : 'rejected') : x.status;
        const [auth, authC] = TECH_AUTH[x.authority] ?? ['—', 'sc sc-none'];
        const [stLabel, stC] = TECH_ST[shown] ?? ['—', 'vf v-none'];
        const canPick = waiting && x.status === 'pending';
        return (
          <div key={x.id} className={shown === 'rejected' ? 'dec-row off' : 'dec-row'} data-testid="decision" data-td={x.tdKey}>
            <div className="dec-h"><span className="mono muted">{x.tdKey}</span><b>{x.title}</b><span className="dec-c">{x.choice}</span><span className="sp" /><span className={authC}>{auth}{x.level ? ` · ${TECH_LV[x.level] ?? x.level}` : ''}</span><span className={stC}>{stLabel}</span></div>
            {x.condition && <p className="dec-p"><span className="muted">조건</span> {x.condition}</p>}
            <p className="dec-p"><span className="muted">근거</span> {x.reason}</p>
            {x.alternatives && <p className="dec-p"><span className="muted">대안</span> {x.alternatives}</p>}
            {canPick && (
              <div className="dec-f"><span className="sp" /><div className="seg" role="group" aria-label={`${x.tdKey} 승인 · 반려`}>
                <button type="button" aria-pressed={pick === 'reject'} onClick={() => { setPicks((p) => ({ ...p, [x.id]: 'reject' })); setErr(''); }}>반려</button>
                <button type="button" aria-pressed={pick === 'approve'} onClick={() => { setPicks((p) => ({ ...p, [x.id]: 'approve' })); setErr(''); }}>승인</button>
              </div></div>
            )}
          </div>
        );
      })}
      {err && <div className="banner danger" data-testid="tech-err" style={{ marginTop: 8 }}><div className="banner-b">{err}</div></div>}
      {waiting && (
        <div className="form-acts" style={{ marginTop: 10 }}>
          <span className="muted" style={{ marginRight: 'auto' }}>{left ? `아직 정하지 않은 Agent 제안 ${String(left)}건` : '모두 정했습니다 — 확정하면 WBS 초안 작성을 시작합니다.'}</span>
          <BusyButton busy={confirm.busy} busyLabel="확정 중…" onClick={submit}>기술 결정 확정</BusyButton>
        </div>
      )}
      {confirm.conflictModal}
    </section>
  );
}

/** UI-02D WBS 초안·최초 승인 */
function DraftPanel({ project, onDirty }: { project: BootProject; onDirty: (dirty: boolean) => void }) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const notify = useNotice();
  const b = project.bootstrap;
  const waitApprove = b.steps.some((s) => s.key === 'approve' && s.status === 'run');
  const draft = b.draft && waitApprove ? b.draft : null;
  const [reInstr, setReInstr] = useState('');
  const [err, setErr] = useState('');
  const dirty = reInstr.trim() !== '';
  useReportDirty(dirty, onDirty);
  const { restoreOffer } = useSessionDraft<{ reInstr: string }>({
    id: `project:boot:rerun:${b.jobId}`, label: '재분석 지시', value: dirty ? { reInstr } : null,
    onRestore: (data) => { setReInstr(data.reInstr); },
  });
  const refresh = () => { void invalidateTopics(queryClient, ['project']); };
  /** 충돌(그사이 새 초안 도착): 본 적 없는 초안을 자동으로 승인·재분석하지 않는다. 최신 초안을 다시 읽고 팀장이 다시 누른다. */
  const reloadOnly = async () => {
    await queryClient.invalidateQueries({ queryKey: ['getProject'] });
    notify('새 초안을 불러왔습니다. 새 초안을 확인한 뒤 다시 진행하세요.');
  };

  const approve = useSave<ResponseOf<'approveBootstrap'>, { revision: number }>({
    target: '초기 WBS 승인',
    failTitle: '승인하지 못했습니다',
    mine: `초안 r${String(b.revision ?? 0)} 승인`,
    request: () => ({ revision: b.revision ?? 0 }),
    run: ({ payload, idempotencyKey }) => client.call('approveBootstrap', { body: payload, idempotencyKey }),
    onSuccess: (res) => {
      notify(`초기 WBS ${String(res.taskCount)}건을 승인했습니다. 기준 일정 v1이 만들어졌고, 선행 조건이 없는 Task부터 Runner가 실행할 수 있습니다.`);
      // 승인 뒤 첫 Task 상세로 이동한다(UAT-PROJECT-06 b, P L4547). 첫 Task = Task 키 순서의 첫 번째.
      void client.call('listTasks', { params: { projectId: project.id } }).then(
        (list) => {
          const first = list.tasks.map((t) => t.taskKey).sort()[0];
          void invalidateTopics(queryClient, 'all');
          void navigate(first ? `/wbs/${first}` : '/wbs');
        },
        () => { void invalidateTopics(queryClient, 'all'); void navigate('/wbs'); },
      );
    },
    onRejected: refresh,
    onConflictReload: refresh,
    onConflictReapply: reloadOnly,
  });
  const rerun = useSave<ResponseOf<'rerunBootstrap'>, { revision: number; instruction: string }>({
    target: '재분석 요청',
    failTitle: '재분석을 요청하지 못했습니다',
    mine: `재분석 지시: ${reInstr}`,
    request: () => ({ revision: b.revision ?? 0, instruction: reInstr.trim() }),
    run: ({ payload, idempotencyKey }) => client.call('rerunBootstrap', { body: payload, idempotencyKey }),
    onSuccess: (_, payload) => { setReInstr((cur) => (cur.trim() === payload.instruction ? '' : cur)); refresh(); },
    successNotice: '재분석을 요청했습니다. Codex 독립 분석부터 다시 진행합니다.',
    onRejected: refresh,
    onConflictReload: refresh,
    onConflictReapply: reloadOnly,
  });
  const askRerun = () => {
    if (!reInstr.trim()) { setErr('재분석 지시를 적어 주세요. 무엇을 바꿀지 적어야 Planning Agent가 반영합니다.'); return; }
    setErr('');
    void rerun.save();
  };

  const tree = draft ? draftTree(draft) : null;
  const sc = draft?.splitCheck;
  const splitC = sc ? (sc.violation ? 'sc sc-bad' : sc.suspect ? 'sc sc-warn' : 'sc sc-ok') : '';
  return (
    <section className="card" aria-labelledby="draft-h">
      <div className="dp-h"><h2 id="draft-h">WBS 초안</h2>{draft && <span className="mono muted">r{b.revision}</span>}</div>
      {draft && tree && sc ? (
        <>
          {restoreOffer}
          <p style={{ margin: '0 0 4px' }}><b>{tree.sum}</b></p>
          <p style={{ margin: '0 0 8px' }}><span className={splitC}>분할 점검 — 통과 {sc.pass} · 의심 {sc.suspect} · 위반 {sc.violation}</span> <span className="fhint">{sc.violation ? '위반 Task는 승인 후 Task 상세에서 「Planning Agent 분할 제안」으로 나눌 수 있습니다. 승인 전에 고치려면 재분석 지시에 적으세요 (예: 6시간 넘는 Task는 나눠줘).' : '모든 Task가 분할 기준을 지킵니다.'}</span></p>
          <div className="dr-tree" role="tree" aria-label="WBS 초안">{tree.rows.map((t) => <div key={t.key} className={t.cls} role="treeitem" aria-selected={false}><span>{t.l}</span>{t.meta && <span className="muted">{t.meta}</span>}</div>)}</div>
          <div className="form" style={{ marginTop: 12 }}>
            <div className="frow"><label className="flabel" htmlFor="re-instr">재분석 지시</label><div className="fctl"><textarea id="re-instr" className="inp" rows={2} placeholder="수정이 필요하면 적고 「재분석 요청」 — 예: 메시지 기능을 별도 Work Package로 분리해줘" value={reInstr} onChange={(e) => { setReInstr(e.target.value); setErr(''); }} /></div></div>
            {err && <div className="banner danger"><div className="banner-b">{err}</div></div>}
            <div className="form-acts"><span className="muted" style={{ marginRight: 'auto' }}>승인하면 이 초안이 WBS가 되고 기준 일정 v1이 만들어집니다. 이후 변경은 Change Proposal로 진행됩니다.</span>
              <BusyButton variant="default" busy={rerun.busy} busyLabel="요청 중…" disabled={approve.busy} onClick={askRerun}>재분석 요청</BusyButton>
              <BusyButton busy={approve.busy} busyLabel="승인 · 기준 일정 계산 중…" disabled={rerun.busy} onClick={() => { void approve.save(); }}>초기 WBS 승인</BusyButton>
            </div>
          </div>
        </>
      ) : <p className="muted" style={{ margin: 0 }}>분석이 끝나면 WBS 초안이 여기에 표시됩니다.</p>}
      {approve.conflictModal}{rerun.conflictModal}
    </section>
  );
}
