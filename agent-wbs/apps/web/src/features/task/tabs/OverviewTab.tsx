/**
 * 개요 탭(UI-03-01) + 실행 등급·하위 Agent(UI-03-01A) + 분할 근거·점검(UI-03-01B) — 원본 P L1028–1127.
 *
 * 제품과 원본이 다른 곳(README §4에 정리):
 * - 예상 토큰·추정 주체/신뢰도/근거·실제 실행·고정 시작일은 계약(TaskDetail)에 없어 보이지 않는다. 값을 지어내지 않는다(UAT-EMPTY-01).
 * - 개요 편집의 실행 시간·토큰·고정 시작일 입력도 저장할 API가 없어 두지 않는다(보고함).
 * - 저장은 두 요청이다: 제목·우선순위·Agent는 PATCH /api/tasks/:taskKey, 목적·범위 등은 PATCH …/spec.
 */
import { SPLIT_RULES } from '@awbs/shared';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiKey } from '../../../shared/api/queries.ts';
import { formatDateTime } from '../../../shared/format.ts';
import { BusyButton } from '../../../shared/ui/BusyButton.tsx';
import { useConfirm } from '../../../shared/ui/feedback.tsx';
import type { ResponseOf } from '../../../shared/api/contract.ts';
import { useEditSlot } from '../edit-slot.tsx';
import { overviewErrors } from '../editor-model.ts';
import { agCls, agInit, ATTEMPT_KIND, PRIORITY, priorityOf, statusOf, TYPE_LABEL, toLines, type TaskDetailData, type TaskSummaryData } from '../labels.ts';
import { Lines, Segs, short } from '../parts.tsx';
import { fmtH, slipState } from '../schedule.ts';
import { useApiClient, useTaskSave } from '../useTaskData.ts';

type Node = ResponseOf<'listTasks'>['nodes'][number];
type Attempt = ResponseOf<'getTaskAttempts'>['items'][number];
const ROLE_LABEL = { dev: '개발', qa: '검증' } as const;
/** P L3450 */
const EFF: Record<string, { l: string; n: number }> = { low: { l: '낮음', n: 1 }, medium: { l: '보통', n: 2 }, high: { l: '높음', n: 3 }, xhigh: { l: '매우 높음', n: 4 }, max: { l: '최대', n: 5 } };

export function OverviewTab({ task: t, byKey, nodes, attempts, onOpenTask }: {
  task: TaskDetailData; byKey: Map<string, TaskSummaryData>; nodes: Node[]; attempts: Attempt[]; onOpenTask: (k: string, ref: boolean) => void;
}) {
  const slot = useEditSlot();
  const editing = slot.current === 'overview';
  const wp = nodes.find((n) => n.id === t.wbsNodeId);
  const ph = wp?.parentId ? nodes.find((n) => n.id === wp.parentId) : undefined;
  const ov = t.spec.overview;
  const sch = t.schedule;
  const slip = slipState(t);
  const pri = priorityOf(Number(t.priority));
  const txt = (v: string) => (v.trim() ? <p><Segs text={v} /></p> : <p className="empty">미작성</p>);
  return (
    <div className="pane">
      <div className="pane-h"><h3>개요</h3>{!editing && <button type="button" className="btn sm" disabled={slot.current !== null} onClick={() => { slot.open('overview'); }}>개요 편집</button>}</div>
      {editing ? <OverviewForm task={t} /> : (
        <>
          <div className="kv">
            <span className="kv-l">Task ID</span><span className="kv-v mono">{t.taskKey}</span>
            <span className="kv-l">WBS 번호</span><span className="kv-v mono">{t.wbsPath}</span>
            <span className="kv-l">상위 Work Package</span><span className="kv-v">{wp ? `${wp.wbsPath} ${wp.title}` : '—'}</span>
            <span className="kv-l">Phase</span><span className="kv-v">{ph ? `${ph.wbsPath} ${ph.title}` : '—'}</span>
            <span className="kv-l">작업 유형</span><span className="kv-v">{TYPE_LABEL[String(t.workType)]} <span className="muted mono">{String(t.workType)}</span></span>
            <span className="kv-l">기술 영역</span><span className="kv-v">주 {String(t.primaryDomain)} · 관련 {t.relatedDomains.length ? t.relatedDomains.join(', ') : '없음'}</span>
            <span className="kv-l">담당 Agent</span><span className="kv-v">{t.assigneeAgent === null ? '미지정' : String(t.assigneeAgent)}</span>
            <span className="kv-l">검증 Agent</span><span className="kv-v">{t.verifierAgent === null ? '미지정' : String(t.verifierAgent)}</span>
            <span className="kv-l">우선순위</span><span className="kv-v">{pri.l}</span>
            <span className="kv-l">최근 변경</span><span className="kv-v mono">{formatDateTime(t.updatedAt)}</span>
          </div>
          <div className="sec">
            <h4>작업량 · 일정</h4>
            {sch ? (
              <div className="kv">
                <span className="kv-l">예상 실행 시간</span><span className="kv-v"><span className="mono">{fmtH(sch.estHours)}</span><span className="muted">낙관 {fmtH(sch.loHours)} · 비관 {fmtH(sch.hiHours)}</span></span>
                <span className="kv-l">충돌 묶음</span><span className="kv-v">{t.conflictGroup ?? '없음'}</span>
                <span className="kv-l">기준 일정 (완료)</span><span className="kv-v mono">{sch.baselineEnd ?? '기준 미포함 — 다음 재조정 때 편입'}</span>
                <span className="kv-l">{String(t.lifecycleStatus) === 'done' ? '실제 완료' : '완료 예상'}</span><span className="kv-v mono">{sch.end ?? '—'}</span>
                <span className="kv-l">기준 대비</span><span className="kv-v">{slip ? <span className={`sc ${slip.c}`}>{slip.l}</span> : '—'}</span>
                <span className="kv-l">진행률</span><span className="kv-v mono">{sch.progressPct}%</span>
              </div>
            ) : <p className="empty" style={{ margin: '0 0 8px' }}>아직 일정이 계산되지 않았습니다 — Planning Agent 추정 뒤 표시됩니다.</p>}
            <p className="fhint" style={{ margin: 0 }}>예상 실행 시간은 Agent 세션이 실제로 작업하는 시간입니다. 날짜는 관측 가동률 · 동시 실행 슬롯 · 사용량 리셋 · 작업 불가일로 계속 다시 계산되고, 범위(낙관~비관)로 표시합니다. Task 추가 · 삭제 · 재추정 · 중단이 생기면 Planning Agent가 기준 일정을 자동 재조정합니다.</p>
          </div>
          <GradeSection task={t} attempts={attempts} />
          <SplitSection task={t} />
          <div className="sec"><h4>작업 목적</h4>{txt(ov.purpose)}</div>
          <div className="sec"><h4>작업 배경</h4>{txt(ov.background)}</div>
          <div className="sec cols2">
            <div><h4>작업 범위</h4><Lines items={ov.scope} /></div>
            <div><h4>제외 범위</h4><Lines items={ov.out} /></div>
          </div>
          <div className="sec"><h4>선행 조건</h4>{txt(ov.precond)}
            {t.predecessors.length > 0 && (
              <div className="chips" style={{ marginTop: 8 }}>
                {t.predecessors.map((p) => {
                  const pt = byKey.get(p.pred);
                  const s = statusOf(String(pt?.lifecycleStatus ?? ''));
                  return <button type="button" key={p.id} className="chipref" onClick={() => { onOpenTask(p.pred, true); }}><span className="mono">{p.pred}</span>{pt?.title ?? ''}{pt && <span className={`st ${s.c}`}><span className="st-d" aria-hidden="true" />{s.l}</span>}</button>;
                })}
              </div>
            )}
          </div>
          <div className="sec"><h4>완료 조건</h4>{txt(ov.doneCond)}</div>
          <div className="sec"><h4>예상 산출물</h4>
            {!t.outputs.length && <p className="empty">미정의 — Completion Gate의 산출물 조건을 통과할 수 없습니다.</p>}
            <ul className="lst none">{t.outputs.map((o, i) => <li key={i}><span className={`deliv ${o.delivered ? 'y' : 'n'}`}>{o.delivered ? '제출됨' : '미제출'}</span> <span className="tag">{o.kind}</span> <span className="muted">{o.required ? '필수' : '선택'}</span> <code>{o.name}</code>{o.verify && <span className="muted"> — 검증: {o.verify}</span>}</li>)}</ul>
            <p className="fhint" style={{ margin: '6px 0 0' }}>산출물과 검증 조건은 [작업 명세] 탭 「완료 판단」에서 편집합니다.</p>
          </div>
        </>
      )}
    </div>
  );
}

/** 개요 편집(P L1111–1127). 실패해도 입력을 지우지 않는다(useSave). */
function OverviewForm({ task: t }: { task: TaskDetailData }) {
  const slot = useEditSlot();
  const client = useApiClient();
  const ov = t.spec.overview;
  const initial = {
    title: t.title, priority: String(t.priority), assignee: t.assigneeAgent === null ? '' : String(t.assigneeAgent), verifier: t.verifierAgent === null ? '' : String(t.verifierAgent),
    purpose: ov.purpose, background: ov.background, scope: ov.scope.join('\n'), out: ov.out.join('\n'), precond: ov.precond, doneCond: ov.doneCond,
  };
  const [d, setD] = useState(initial);
  const [touched, setTouched] = useState(false);
  const L: Record<keyof typeof initial, string> = { title: '제목', priority: '우선순위', assignee: '담당 Agent', verifier: '검증 Agent', purpose: '작업 목적', background: '작업 배경', scope: '작업 범위', out: '제외 범위', precond: '선행 조건', doneCond: '완료 조건' };
  const diff = (Object.keys(L) as (keyof typeof initial)[]).filter((k) => d[k].trim() !== initial[k].trim());
  const errs = overviewErrors(d);
  const invalid = errs.title || errs.purpose || errs.doneCond;
  useEffect(() => { slot.setDirty(diff.length > 0); }, [diff.length, slot]);
  const set = (k: keyof typeof initial) => (e: { target: { value: string } }) => { setTouched(true); setD((x) => ({ ...x, [k]: e.target.value })); };
  const head = diff.filter((k) => ['title', 'priority', 'assignee', 'verifier'].includes(k));
  const body = diff.filter((k) => !head.includes(k));
  const save = useTaskSave(t.taskKey, {
    target: `${t.taskKey} 개요 저장`,
    mine: diff.map((k) => `${L[k]}: ${short(d[k])}`).join(' · '),
    run: async ({ updatedAt }) => {
      let version = updatedAt;
      let last: ResponseOf<'updateTask'> | null = null;
      if (head.length) {
        last = await client.call('updateTask', { params: { taskKey: t.taskKey }, body: {
          updatedAt: version,
          ...(head.includes('title') ? { title: d.title.trim() } : {}),
          ...(head.includes('priority') ? { priority: Number(d.priority) } : {}),
          ...(head.includes('assignee') && d.assignee ? { assigneeAgent: d.assignee as 'Claude' } : {}),
          ...(head.includes('verifier') && d.verifier ? { verifierAgent: d.verifier as 'Claude' } : {}),
        } });
        version = last.task.updatedAt;
      }
      if (body.length) {
        last = await client.call('updateTaskSpec', { params: { taskKey: t.taskKey }, body: {
          updatedAt: version,
          overview: { purpose: d.purpose.trim(), background: d.background.trim(), scope: toLines(d.scope), out: toLines(d.out), precond: d.precond.trim(), doneCond: d.doneCond.trim() },
        } });
      }
      return last;
    },
    onSuccess: () => { slot.close(); },
    onReload: () => { slot.close(); },
    successNotice: `개요 ${String(diff.length)}개 항목을 저장했습니다.`,
  });
  const show = (k: 'title' | 'purpose' | 'doneCond') => touched && errs[k];
  return (
    <div className="form">
      <div className="frow"><label className="flabel" htmlFor="ov-title">제목<span className="req">필수</span></label><div className="fctl"><input id="ov-title" className={`inp ${show('title') ? 'bad' : ''}`} value={d.title} onChange={set('title')} aria-invalid={show('title')} />{show('title') && <span className="ferr">제목을 입력하세요.</span>}</div></div>
      <div className="frow"><label className="flabel" htmlFor="ov-pri">우선순위<span className="req">필수</span></label><div className="fctl"><select id="ov-pri" className="inp" value={d.priority} onChange={set('priority')}>{PRIORITY.map((p, i) => <option key={p.l} value={String(i)}>{p.l}</option>)}</select></div></div>
      <div className="frow"><label className="flabel" htmlFor="ov-asg">담당 Agent<span className="req">필수</span></label><div className="fctl"><select id="ov-asg" className="inp" value={d.assignee} onChange={set('assignee')}>{!d.assignee && <option value="">미지정</option>}<option value="Claude">Claude</option><option value="Codex">Codex</option></select><span className="fhint">담당 Agent 변경은 이력에 기록됩니다. 담당과 검증 Agent는 다르게 지정하는 것을 권장합니다.</span></div></div>
      <div className="frow"><label className="flabel" htmlFor="ov-vf">검증 Agent<span className="req">필수</span></label><div className="fctl"><select id="ov-vf" className="inp" value={d.verifier} onChange={set('verifier')}>{!d.verifier && <option value="">미지정</option>}<option value="Codex">Codex</option><option value="Claude">Claude</option></select>{errs.same && <span className="ferr">담당 Agent와 검증 Agent가 같습니다. 교차 검증 원칙에 맞지 않습니다.</span>}</div></div>
      <div className="frow"><label className="flabel" htmlFor="ov-pur">작업 목적<span className="req">필수</span></label><div className="fctl"><textarea id="ov-pur" rows={3} className={`inp ${show('purpose') ? 'bad' : ''}`} value={d.purpose} onChange={set('purpose')} aria-invalid={show('purpose')} />{show('purpose') && <span className="ferr">작업 목적을 입력하세요.</span>}</div></div>
      <div className="frow"><label className="flabel" htmlFor="ov-bg">작업 배경<span className="opt">선택</span></label><div className="fctl"><textarea id="ov-bg" rows={3} className="inp" value={d.background} onChange={set('background')} /></div></div>
      <div className="frow"><label className="flabel" htmlFor="ov-sc">작업 범위<span className="opt">선택</span></label><div className="fctl"><textarea id="ov-sc" rows={4} className="inp" value={d.scope} onChange={set('scope')} /><span className="fhint">한 줄에 한 항목 · `백틱`으로 파일 경로·코드 표시</span></div></div>
      <div className="frow"><label className="flabel" htmlFor="ov-out">제외 범위<span className="opt">선택</span></label><div className="fctl"><textarea id="ov-out" rows={3} className="inp" value={d.out} onChange={set('out')} /><span className="fhint">작업 명세의 「구현하지 않을 내용」과 같은 데이터입니다.</span></div></div>
      <div className="frow"><label className="flabel" htmlFor="ov-pre">선행 조건<span className="opt">선택</span></label><div className="fctl"><input id="ov-pre" className="inp" value={d.precond} onChange={set('precond')} /><span className="fhint">선행 Task 지정은 [의존성] 탭에서 합니다. 여기에는 Task 외 조건을 적습니다.</span></div></div>
      <div className="frow"><label className="flabel" htmlFor="ov-dc">완료 조건<span className="req">필수</span></label><div className="fctl"><textarea id="ov-dc" rows={2} className={`inp ${show('doneCond') ? 'bad' : ''}`} value={d.doneCond} onChange={set('doneCond')} aria-invalid={show('doneCond')} />{show('doneCond') && <span className="ferr">완료 조건을 입력하세요.</span>}</div></div>
      <div className="form-acts">
        <span className="muted" style={{ marginRight: 'auto' }}>{diff.length ? `변경 ${String(diff.length)}개 — ${diff.map((k) => L[k]).join(', ')}` : '변경 없음'}</span>
        <button type="button" className="btn" disabled={save.busy} onClick={() => { slot.close(); }}>취소</button>
        <BusyButton busy={save.busy} busyLabel="저장 중…" disabled={invalid} onClick={() => { if (!diff.length) slot.close(); else void save.save(); }}>저장</BusyButton>
      </div>
      {save.conflictModal}
    </div>
  );
}

/**
 * 설정의 허용 모델·실행 정책 최저선 — 등급 편집 선택지와 최저선 경고에 쓴다.
 * getModelSettings·getExecPolicy는 계약에서 `get${name}` 템플릿으로 만들어져 id 타입이 string으로 넓어진다(보고함).
 * 그래서 이 화면이 읽는 필드만 좁게 적었다. 필드 이름·뜻은 계약(routes/settings.ts ModelSettings·ExecPolicy) 그대로다.
 */
interface ModelSettingsView { models: { agent: string; id: string; label: string; allowed: boolean; efforts: { key: string; level: number | null }[] | null }[] }
interface ExecPolicyView { floors: { verifyGeDev: boolean; dbHigh: boolean } }
function useGradeSettings() {
  const client = useApiClient();
  const call = client.call as unknown as (id: string, args: { signal?: AbortSignal }) => Promise<unknown>;
  const models = useQuery({ queryKey: apiKey('getModelSettings' as 'getSession'), queryFn: ({ signal }) => call('getModelSettings', { signal }) as Promise<ModelSettingsView>, meta: { topics: ['settings'] } });
  const policy = useQuery({ queryKey: apiKey('getExecPolicy' as 'getSession'), queryFn: ({ signal }) => call('getExecPolicy', { signal }) as Promise<ExecPolicyView>, meta: { topics: ['settings'] } });
  return { models, policy };
}

/** 실행 등급(모델 · Effort)·하위 Agent(UI-03-01A, P L1064–1085) */
function GradeSection({ task: t, attempts }: { task: TaskDetailData; attempts: Attempt[] }) {
  const slot = useEditSlot();
  const client = useApiClient();
  const confirm = useConfirm();
  const { models, policy } = useGradeSettings();
  const [edit, setEdit] = useState<{ role: 'dev' | 'qa'; model: string; effort: string } | null>(null);
  const closed = ['done', 'cancelled'].includes(String(t.lifecycleStatus));
  const agentOf = (role: 'dev' | 'qa') => (role === 'dev' ? t.assigneeAgent : t.verifierAgent);
  const modelLabel = (id: string) => models.data?.models.find((m) => m.id === id)?.label ?? id;
  const gradeL = (g: { modelId: string; effort: string }) => `${modelLabel(g.modelId)} · ${EFF[g.effort]?.l ?? g.effort}`;
  const lock = useTaskSave(t.taskKey, {
    target: `${t.taskKey} 실행 등급 저장 · 고정`,
    mine: edit ? `${ROLE_LABEL[edit.role]} 등급 ${gradeL({ modelId: edit.model, effort: edit.effort })}` : '',
    run: ({ updatedAt }) => client.call('lockTaskGrade', { params: { taskKey: t.taskKey }, body: { updatedAt, role: edit?.role ?? 'dev', modelId: edit?.model ?? '', effort: edit?.effort ?? '' } }),
    onSuccess: () => { setEdit(null); slot.close(); },
    onReload: () => { setEdit(null); slot.close(); },
    successNotice: `${t.taskKey} ${edit ? ROLE_LABEL[edit.role] : ''} 등급을 고정했습니다. 등급이 바뀌면 작업량을 재추정하고 일정을 자동 재조정합니다.`,
  });
  const [unlockRole, setUnlockRole] = useState<'dev' | 'qa'>('dev');
  const unlock = useTaskSave(t.taskKey, {
    target: `${t.taskKey} 실행 등급 고정 해제`,
    run: ({ updatedAt }) => client.call('unlockTaskGrade', { params: { taskKey: t.taskKey }, query: { updatedAt, role: unlockRole } }),
    successNotice: `${t.taskKey} ${ROLE_LABEL[unlockRole]} 등급 고정을 해제했습니다. Planning Agent 판단으로 돌아갑니다.`,
  });
  useEffect(() => { if (edit) slot.setDirty(true); }, [edit, slot]);
  const floors = policy.data?.floors;
  /** 최저선 미달(P L6257 fl.n): 검증 ≥ 개발 Effort, DB Task는 높음 이상 */
  const floorWhy = (role: 'dev' | 'qa', effort: string): string[] => {
    const n = EFF[effort]?.n ?? 0;
    const why: string[] = [];
    if (floors?.dbHigh && (String(t.primaryDomain) === 'DB' || t.relatedDomains.map(String).includes('DB')) && n < 3) why.push('DB Task는 Effort 높음 이상');
    const dev = t.grades.dev;
    if (floors?.verifyGeDev && role === 'qa' && dev && n < (EFF[dev.effort]?.n ?? 0)) why.push('검증 Effort ≥ 개발 Effort');
    return why;
  };
  const used = attempts.filter((a) => a.modelId);
  return (
    <div className="sec">
      <h4>실행 등급 (모델 · Effort)</h4>
      {(['dev', 'qa'] as const).map((role) => {
        const g = t.grades[role];
        const ag = agentOf(role) === null ? '' : String(agentOf(role));
        const ed = edit?.role === role ? edit : null;
        const allowed = (models.data?.models ?? []).filter((m) => String(m.agent) === ag && m.allowed);
        const mOpts = allowed.length ? allowed.map((m) => ({ id: m.id, l: m.label })) : g ? [{ id: g.modelId, l: modelLabel(g.modelId) }] : [];
        const chosen = models.data?.models.find((m) => m.id === ed?.model);
        const eOpts = chosen?.efforts?.map((e) => e.key) ?? (g ? [g.effort] : Object.keys(EFF));
        const why = ed ? floorWhy(role, ed.effort) : [];
        return (
          <div className="runrow" key={role}>
            <div className="dp-h" style={{ margin: 0 }}>
              <span className="agent"><span className="tag">{ROLE_LABEL[role]}</span>{ag && <span className={`ag-mk ${agCls(ag)}`} aria-hidden="true">{agInit(ag)}</span>}{ag || '미지정'} <b style={{ marginLeft: 4 }}>{g ? gradeL(g) : '등급 미정'}</b></span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={g?.locked ? 'tag lock' : 'tag'}>{g?.locked ? '팀장 고정' : 'Planning Agent 판단'}</span>
                {!closed && !ed && <button type="button" className="btn ghost sm" disabled={slot.current !== null} onClick={() => { slot.open(`grade-${role}`); setEdit({ role, model: g?.modelId ?? mOpts[0]?.id ?? '', effort: g?.effort ?? 'high' }); }}>변경 · 고정</button>}
                {!closed && !ed && g?.locked && <BusyButton variant="ghost" small busy={unlock.busy && unlockRole === role} busyLabel="해제 중…" onClick={() => {
                  setUnlockRole(role);
                  void confirm({ title: '등급 고정 해제', body: `${t.taskKey} ${ROLE_LABEL[role]} 등급 고정을 해제합니다. Planning Agent가 등급을 다시 판단하고 작업량을 재추정합니다.`, ok: '고정 해제' }).then((ok) => { if (ok) void unlock.save(); });
                }}>고정 해제</BusyButton>}
              </span>
            </div>
            <p className="fhint" style={{ margin: '4px 0 0' }}>근거 — {g?.reason || '—'}</p>
            {ed && (
              <div className="form" style={{ marginTop: 8 }}>
                <div className="frow"><span className="flabel">모델</span><div className="fctl"><div className="seg" role="group" aria-label={`${ROLE_LABEL[role]} 모델`}>{mOpts.map((o) => <button type="button" key={o.id} aria-pressed={ed.model === o.id} onClick={() => { setEdit({ ...ed, model: o.id }); }}>{o.l}</button>)}</div></div></div>
                <div className="frow"><span className="flabel">Effort</span><div className="fctl"><div className="seg" role="group" aria-label={`${ROLE_LABEL[role]} Effort`}>{eOpts.map((k) => <button type="button" key={k} aria-pressed={ed.effort === k} onClick={() => { setEdit({ ...ed, effort: k }); }}>{EFF[k]?.l ?? k}</button>)}</div></div></div>
                {why.length > 0 && <div className="banner warn" role="note"><div className="banner-b">최저선 미달 ({why.join(' · ')}) — 저장하면 팀장 예외로 고정되고 이력에 남습니다.</div></div>}
                <div className="form-acts">
                  <span className="muted" style={{ marginRight: 'auto' }}>저장하면 팀장 고정 — Planning Agent가 바꾸지 않습니다. Effort가 바뀌면 작업량을 재추정합니다.</span>
                  <button type="button" className="btn" disabled={lock.busy} onClick={() => { setEdit(null); slot.close(); }}>취소</button>
                  <BusyButton busy={lock.busy} busyLabel="저장 중…" onClick={() => { void lock.save(); }}>저장 · 고정</BusyButton>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <h4 style={{ margin: '12px 0 6px' }}>하위 Agent <span className="muted" style={{ fontWeight: 400 }}>Planning Agent 지정 · 실행 직전 Runner가 worktree에 자동 설치</span></h4>
      {(['dev', 'qa'] as const).map((role) => {
        const ag = agentOf(role) === null ? '' : String(agentOf(role));
        const list = t.subagents[role];
        return (
          <div className="ev" key={role} style={{ gridTemplateColumns: '120px minmax(0,1fr)' }}>
            <span className="agent"><span className="tag">{ROLE_LABEL[role]}</span>{ag && <span className={`ag-mk ${agCls(ag)}`} aria-hidden="true">{agInit(ag)}</span>}{ag || '미지정'}</span>
            <span>{list.length ? list.map((x) => <span className="subline" key={x}><b className="mono">{x}</b></span>) : <span className="muted">지정 없음 — 기본 Agent로 실행</span>}</span>
          </div>
        );
      })}
      {!used.length
        ? <p className="fhint" style={{ margin: 0 }}>아직 실행 기록이 없습니다. Runner는 이 등급으로 시작하고, 재작업 · 사용량 부족 시에는 설정의 Agent 실행 정책에 따라 등급을 조정합니다.</p>
        : used.map((a) => (
          <div className="ev" key={a.id} style={{ gridTemplateColumns: '110px 60px minmax(0,1fr)' }}>
            <span className="mono">{a.attemptKey}</span><span className="wt">{ATTEMPT_KIND[String(a.kind)] ?? String(a.kind)}</span>
            <span>{gradeL({ modelId: a.modelId ?? '', effort: a.effort ?? '' })} {a.gradeAdjust && <span className={a.gradeAdjust.kind === 'down' ? 'sc sc-none' : 'sc sc-warn'}>{a.gradeAdjust.reason}</span>}</span>
          </div>
        ))}
      {lock.conflictModal}
      {unlock.conflictModal}
    </div>
  );
}

/** 분할 근거 · 점검(UI-03-01B). 원본의 규칙 10개 자동 점검은 서버 판정 결과가 계약에 없어, 저장된 판단 기록·예외만 보인다(보고함). */
function SplitSection({ task: t }: { task: TaskDetailData }) {
  const client = useApiClient();
  const [exc, setExc] = useState<{ rule: string; why: string } | null>(null);
  const started = !['planning', 'approval', 'ready'].includes(String(t.lifecycleStatus));
  const split = t.split;
  const judged = new Map((split?.judgedRules?.items ?? []).map((j) => [String(j.rule), j]));
  const excs = new Map((split?.exceptions ?? []).map((e) => [e.rule, e]));
  const propose = useTaskSave(t.taskKey, {
    target: `${t.taskKey} 분할 제안 요청`, failTitle: '분할 제안을 요청하지 못했습니다',
    run: ({ idempotencyKey, updatedAt }) => client.call('splitTask', { params: { taskKey: t.taskKey }, body: { updatedAt }, idempotencyKey }),
    successNotice: `${t.taskKey} 분할 제안을 Planning Agent에 요청했습니다. Change Proposal로 올라옵니다.`,
  });
  const record = useTaskSave(t.taskKey, {
    target: `${t.taskKey} 분할 예외 사유 기록`,
    run: ({ idempotencyKey, updatedAt }) => client.call('addSplitException', { params: { taskKey: t.taskKey }, body: { updatedAt, rule: (exc?.rule ?? 'one') as 'one', why: exc?.why.trim() ?? '' }, idempotencyKey }),
    onSuccess: () => { setExc(null); },
    successNotice: '분할 기준 예외 사유를 기록했습니다.',
  });
  return (
    <div className="sec">
      <h4>분할 근거 · 점검</h4>
      <p className="fhint" style={{ margin: '0 0 6px' }}>근거 — {split?.basis || '—'}</p>
      <div className="gtb" style={{ margin: 0 }}>
        {SPLIT_RULES.map((r) => {
          const j = judged.get(r.key);
          const e = excs.get(r.key);
          const st = e ? { l: '예외', c: 'tag lock' } : r.mode === 'judge' ? (j ? (String(j.result) === 'met' ? { l: '통과', c: 'sc sc-ok' } : { l: '위반', c: 'sc sc-bad' }) : { l: '판단', c: 'sc sc-none' }) : { l: '—', c: 'sc sc-none' };
          const detail = e ? `${e.why} (${e.by} · ${formatDateTime(e.at)})` : j ? j.basis : r.mode === 'judge' ? 'Agent 판단 기록 없음' : '서버 자동 점검 결과는 설정 → 일정 · Task 「기준을 벗어난 Task」에서 확인';
          return (
            <div className="gtr" key={r.key} style={{ gridTemplateColumns: '170px 70px minmax(0,1fr) 120px', minWidth: 0 }}>
              <span className="gc">{r.label}</span><span className="gc"><span className={st.c}>{st.l}</span></span>
              <span className="gc">{detail} <span className="muted">· {r.mode === 'judge' ? 'Agent 판단' : '자동 점검'}</span></span>
              <span className="gc">{started && !e && <button type="button" className="btn ghost sm" onClick={() => { setExc({ rule: r.key, why: '' }); }}>예외 사유 기록</button>}</span>
            </div>
          );
        })}
      </div>
      {exc && (
        <div className="addbox" style={{ marginTop: 8 }}>
          <div className="addbox-r">
            <label className="flabel" htmlFor="split-why" style={{ padding: 0 }}>{SPLIT_RULES.find((r) => r.key === exc.rule)?.label} 예외 사유</label>
            <input id="split-why" className="inp" style={{ flex: 1, minWidth: 240 }} value={exc.why} onChange={(e) => { setExc({ ...exc, why: e.target.value }); }} />
            <button type="button" className="btn sm" onClick={() => { setExc(null); }}>취소</button>
            <BusyButton small busy={record.busy} busyLabel="기록 중…" disabled={!exc.why.trim()} onClick={() => { void record.save(); }}>기록</BusyButton>
          </div>
        </div>
      )}
      {!started
        ? <div className="form-acts" style={{ justifyContent: 'flex-start', marginTop: 8 }}><BusyButton small busy={propose.busy} busyLabel="요청 중…" onClick={() => { void propose.save(); }}>Planning Agent 분할 제안</BusyButton><span className="muted">계층별 · 계약 먼저(A) 기준으로 나눠 Change Proposal로 올립니다 — 자동 반영 정책이면 바로 반영 · 일정 재조정</span></div>
        : <p className="fhint" style={{ margin: '8px 0 0' }}>이미 시작된 Task는 나누지 않습니다 — 예외 사유를 기록하거나 남은 일을 후속 Task로 제안합니다.</p>}
      {propose.conflictModal}
      {record.conflictModal}
    </div>
  );
}
