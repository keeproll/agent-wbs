/**
 * Task 생성 Wizard(MOD-06, 원본 P L2785–2847, 로직 L6782–6813). 3단계: 기본 정보·분류 → 목적·범위·완료 조건 → 선행 Task·확인.
 *
 * - 단계마다 필수값을 검사하고, 틀리면 「다음」을 막고 항목별 오류를 보인다(UAT-WIZ-01).
 * - 이전 단계로 가도 입력은 그대로다.
 * - 상위 Work Package는 서버가 준 실제 목록만 고를 수 있다(MM-05, UAT-WIZ-02). 그 사이 지워졌으면 서버가 4xx로 거부한다.
 * - 제목·목적을 입력한 뒤 닫으면 「Task 생성 취소」를 묻는다. 「취소」는 입력을 유지한다(UAT-WIZ-04).
 * - 생성: POST createTask → 선행마다 POST addDependency(FS). 실패해도 입력은 남고 오류 막대로 알린다(useSave).
 */
import { useRef, useState } from 'react';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { ApiError } from '../../shared/api/client.ts';
import type { BodyOf } from '../../shared/api/contract.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { useConfirm } from '../../shared/ui/feedback.tsx';
import { Icon, ICON } from '../../shared/ui/Icon.tsx';
import { Modal } from '../../shared/ui/Modal.tsx';
import { AreaLoading } from '../../shared/ui/loading.tsx';
import { StatusPill } from './cells.tsx';
import { DOMAIN_LABEL, fmtH, lines, TYPE_LABEL, wizardErrors, wizardMissing, type TaskSummary, type WbsNode } from './model.ts';

const DOMAIN_TO_DESIGN: Record<string, string> = { DB: 'DB 설계', BE: 'BE / API 설계', API: 'BE / API 설계', FE: 'FE 설계', DevOps: 'DevOps 설계' };
const AGENTS = ['Claude', 'Codex'] as const;
type Agent = (typeof AGENTS)[number];

export interface Draft {
  title: string; wbsNodeId: string; type: string; domain: string; rel: string[]; priority: string; assignee: Agent; verifier: Agent;
  est: string; fixStart: string; purpose: string; background: string; scope: string; out: string; doneCond: string; preds: string[];
}

export function TaskWizard({ projectId, nodes, tasks, defaultWp, initial, onDraft, onClose, onCreated, onRejected }: {
  projectId: string;
  /** 세션 만료 뒤 복원한 초안(useSessionDraft). 없으면 빈 초안 */
  initial?: Draft | null;
  /** 입력이 바뀔 때마다 알린다. WBS 화면이 편집 보호·세션 만료 초안에 쓴다. Task를 만든 뒤에는 null(버릴 초안이 없음). */
  onDraft: (draft: Draft | null) => void;
  nodes: readonly WbsNode[];
  /** 선행 선택지: 표의 필터와 상관없는 프로젝트의 모든 Task(독립 리뷰 #5). 아직 못 읽었으면 undefined */
  tasks: readonly TaskSummary[] | undefined;
  defaultWp: string;
  onClose: () => void;
  /** 끝. linked=false면 선행 일부를 연결하지 않고 마쳤다. */
  onCreated: (taskKey: string, title: string, linked: boolean) => void;
  onRejected: () => void;
}) {
  const { client } = useApi();
  const confirm = useConfirm();
  const asking = useRef(false);
  const wps = nodes.filter((n) => n.kind === 'work_package');
  const [step, setStep] = useState(1);
  const [tried, setTried] = useState(false);
  const [d, setD] = useState<Draft>(() => initial ?? {
    title: '', wbsNodeId: wps.some((w) => w.id === defaultWp) ? defaultWp : (wps[0]?.id ?? ''), type: '', domain: '', rel: [], priority: '2',
    assignee: 'Claude', verifier: 'Codex', est: '4', fixStart: '', purpose: '', background: '', scope: '', out: '', doneCond: '', preds: [],
  });
  const set = (patch: Partial<Draft>) => { setD((x) => { const n = { ...x, ...patch }; onDraft(createdRef.current ? null : n); return n; }); };
  const e = wizardErrors(d);
  const show = tried;
  const missing = show ? wizardMissing(step, e) : [];
  const byKey = new Map((tasks ?? []).map((t) => [t.taskKey, t]));
  const wpLabel = (id: string) => { const w = wps.find((x) => x.id === id); return w ? `${w.wbsPath} ${w.title}` : ''; };
  const designs = [...new Set([d.domain, ...d.rel].map((x) => DOMAIN_TO_DESIGN[x]).filter((x): x is string => !!x))];
  const estOk = !e.est;

  /**
   * 생성은 두 단계다. ① Task 만들기(createTask, 한 번만) ② 선행 연결(addDependency, 선행마다).
   * ②가 실패해도 ①을 되돌리거나 다시 하지 않는다. 만든 Task를 기억하고 「선행 연결」만 다시 한다(독립 리뷰 #1: 중복 생성).
   * ①은 useSave가 결과 모를 때 같은 멱등 키로만 다시 보낸다.
   */
  const createdRef = useRef<{ taskKey: string; title: string } | null>(null);
  const [created, setCreated] = useState<{ taskKey: string; title: string } | null>(null);
  const finish = (linked: boolean) => {
    const c = createdRef.current;
    if (c) onCreated(c.taskKey, c.title, linked);
  };
  /** 선행을 하나씩 FS로 붙인다. 이미 붙은 것은 건너뛴다. 매번 최신 updatedAt을 서버에서 읽는다. */
  const linkAll = async (taskKey: string, preds: readonly string[], keyBase: string) => {
    for (const pred of preds) {
      const now = await client.call('getTask', { params: { taskKey } });
      if (now.preds.includes(pred)) continue;
      await client.call('addDependency', {
        params: { taskKey },
        body: { updatedAt: now.updatedAt, predTaskKey: pred, depType: 'FS' } as BodyOf<'addDependency'>,
        idempotencyKey: `${keyBase}:${pred}:${now.updatedAt}`,
      }).catch((error: unknown) => {
        // 선행이 그 사이 지워졌으면 목록을 다시 읽어 선택지에서 빠지게 한다.
        if (error instanceof ApiError && error.kind === 'notFound') onRejected();
        throw error;
      });
    }
  };

  const link = useSave({
    target: `${created?.taskKey ?? 'Task'} 선행 Task 연결`,
    failTitle: '선행 Task를 연결하지 못했습니다',
    mine: `선행 Task 연결: ${d.preds.join(', ') || '없음'}`,
    request: () => ({ taskKey: createdRef.current?.taskKey ?? '', preds: d.preds }),
    run: async ({ payload, idempotencyKey }) => { await linkAll(payload.taskKey, payload.preds, idempotencyKey); },
    onSuccess: () => { finish(true); },
    // 충돌: 「다시 적용」은 서버의 최신 버전을 다시 읽어 선행을 붙이고 마친다. 실패하면 던져서 창 안에 이유를 보인다.
    onConflictReapply: async () => {
      const c = createdRef.current;
      if (!c) return;
      await linkAll(c.taskKey, d.preds, crypto.randomUUID());
      finish(true);
    },
    // 「최신 불러오기」: 선행을 붙이지 않고, 만든 Task의 최신 상태와 목록만 다시 읽는다. 선행 선택은 그대로 두어 다시 고를 수 있다.
    // 실패하면 던진다 → 충돌 창이 열린 채 이유를 보인다(재리뷰 F2).
    onConflictReload: async () => {
      const c = createdRef.current;
      if (c) await client.call('getTask', { params: { taskKey: c.taskKey } });
      onRejected();
    },
  });

  const create = useSave({
    target: 'Task 생성',
    failTitle: 'Task를 생성하지 못했습니다',
    // 「Task 생성」을 누른 순간의 입력을 찍어 둔다. 「다시 시도」는 화면의 최신 입력이 아니라 이 요청을 같은 멱등 키로 다시 보낸다.
    request: () => ({
      title: d.title.trim(), wbsNodeId: d.wbsNodeId, workType: d.type, primaryDomain: d.domain, relatedDomains: d.rel,
      priority: Number(d.priority), assigneeAgent: d.assignee, verifierAgent: d.verifier,
      overview: { purpose: d.purpose.trim(), background: d.background.trim(), scope: lines(d.scope), out: lines(d.out), precond: '', doneCond: d.doneCond.trim() },
    } as BodyOf<'createTask'>),
    run: async ({ payload, idempotencyKey }) => {
      const result = await client.call('createTask', { params: { projectId }, body: payload, idempotencyKey }).catch((error: unknown) => {
        // 고른 Work Package가 그 사이 지워졌으면 목록을 다시 읽어 실제 WP만 남긴다(UAT-WIZ-02).
        if (error instanceof ApiError && error.code === 'WBS_NODE_NOT_FOUND') onRejected();
        throw error;
      });
      return { taskKey: result.taskKey, title: payload.title };
    },
    onSuccess: (c) => {
      createdRef.current = c;
      setCreated(c);
      // 이제 버릴 초안이 없다(편집 보호·세션 초안 해제).
      onDraft(null);
      if (d.preds.length === 0) finish(true);
      else void link.save();
    },
  });
  const busy = create.busy || link.busy;

  const close = async () => {
    if (asking.current || busy) return;
    // 이미 만든 Task는 버릴 수 없다. 닫으면 선행 없이 마치고 그 Task로 간다.
    if (createdRef.current) { finish(false); return; }
    if (!d.title.trim() && !d.purpose.trim()) { onClose(); return; }
    asking.current = true;
    const ok = await confirm({ title: 'Task 생성 취소', body: '입력한 내용이 저장되지 않습니다. 생성을 취소할까요?', ok: '생성 취소', danger: true });
    asking.current = false;
    if (ok) onClose();
  };
  const next = () => {
    const bad = step === 1 ? (e.title || e.wp || e.type || e.domain || e.est || e.fixStart) : step === 2 ? (e.purpose || e.doneCond) : false;
    if (bad) { setTried(true); return; }
    if (step < 3) { setStep(step + 1); setTried(false); return; }
    void (createdRef.current ? link.save() : create.save());
  };
  const bad = (k: keyof typeof e) => (show && e[k] ? ' bad' : '');
  const choice = <T extends string>(list: readonly (readonly [T, string])[], value: string, pick: (v: T) => void, mono: 'first' | 'second') => (
    <div className="choice">
      {list.map(([k, l]) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => { pick(k); }}>
          {mono === 'first' ? <><span className="mono">{k}</span><span className="en">{l}</span></> : <><span>{l}</span><span className="en">{k}</span></>}
        </button>
      ))}
    </div>
  );

  return (
    <Modal
      size="lg"
      role="dialog"
      title="Task 생성"
      meta={<button type="button" className="iconbtn" aria-label="Task 생성 닫기" onClick={() => { void close(); }}><Icon d={ICON.close} /></button>}
      onCancel={() => { void close(); }}
      initialFocus="#wz-title"
      footer={(
        <>
          <span className="ferr wiz-err" role={missing.length ? 'alert' : undefined}>{missing.length ? `필수 항목을 입력하세요: ${missing.join(', ')}` : ''}</span>
          {created
            ? <button type="button" className="btn" onClick={() => { finish(false); }} disabled={busy}>선행 없이 마치기</button>
            : <button type="button" className="btn" onClick={() => { void close(); }} disabled={busy}>취소</button>}
          <button type="button" className="btn" onClick={() => { setStep(step - 1); setTried(false); }} disabled={step === 1 || busy || !!created}>이전</button>
          {step < 3
            ? <button type="button" className="btn primary" onClick={next}>다음</button>
            : created
              ? <BusyButton busy={busy} busyLabel="연결 중…" onClick={next}>선행 연결</BusyButton>
              : <BusyButton busy={busy} busyLabel="생성 중…" onClick={next}>Task 생성</BusyButton>}
        </>
      )}
    >
      <ol className="steps wiz-steps">
        {['기본 정보 · 분류', '목적 · 범위 · 완료 조건', '선행 Task · 확인'].map((l, i) => (
          <li key={l} className={step === i + 1 ? 'cur' : step > i + 1 ? 'done' : ''} aria-current={step === i + 1 ? 'step' : undefined}><span className="st-n">{i + 1}</span>{l}</li>
        ))}
      </ol>
      {step === 1 && (
        <div className="form">
          <div className="frow"><label className="flabel" htmlFor="wz-title">Task 제목<span className="req">필수</span></label><div className="fctl">
            <input id="wz-title" className={`inp${bad('title')}`} placeholder="예: Task 목록 조회 API 페이지네이션" value={d.title} onChange={(x) => { set({ title: x.target.value }); }} aria-invalid={!!bad('title')} />
            {show && e.title && <span className="ferr">제목을 입력하세요.</span>}
          </div></div>
          <div className="frow"><label className="flabel" htmlFor="wz-wp">상위 Work Package<span className="req">필수</span></label><div className="fctl">
            <select id="wz-wp" className={`inp${bad('wp')}`} value={d.wbsNodeId} onChange={(x) => { set({ wbsNodeId: x.target.value }); }}>
              {wps.length === 0 && <option value="">Work Package 없음</option>}
              {wps.map((w) => <option key={w.id} value={w.id}>{w.wbsPath} {w.title}</option>)}
            </select>
            {show && e.wp && <span className="ferr">상위 Work Package를 선택하세요.</span>}
            <span className="fhint">WBS 번호는 Work Package 위치로 자동 계산되고, Task ID는 생성 후 바뀌지 않습니다.</span>
          </div></div>
          <div className="frow"><span className="flabel">작업 유형<span className="req">필수</span></span><div className="fctl" role="group" aria-label="작업 유형">
            {choice(Object.entries(TYPE_LABEL), d.type, (k) => { set({ type: k }); }, 'second')}
            {show && e.type && <span className="ferr">작업 유형을 하나 선택하세요.</span>}
          </div></div>
          <div className="frow"><span className="flabel">주 기술 영역<span className="req">필수</span></span><div className="fctl" role="group" aria-label="주 기술 영역">
            {choice(Object.entries(DOMAIN_LABEL), d.domain, (k) => { set({ domain: k, rel: d.rel.filter((r) => r !== k) }); }, 'first')}
            {show && e.domain && <span className="ferr">주 기술 영역을 선택하세요.</span>}
            <span className="fhint">작업 유형과 기술 영역은 별개 속성입니다. 기술 영역에 따라 [기술 설계] 탭의 입력 항목이 달라집니다.</span>
          </div></div>
          <div className="frow"><span className="flabel">관련 기술 영역<span className="opt">선택</span></span><div className="fctl"><div className="seg" role="group" aria-label="관련 기술 영역">
            {Object.keys(DOMAIN_LABEL).filter((k) => k !== d.domain).map((k) => (
              <button key={k} type="button" className="mono" aria-pressed={d.rel.includes(k)} onClick={() => { set({ rel: d.rel.includes(k) ? d.rel.filter((r) => r !== k) : [...d.rel, k] }); }}>{k}</button>
            ))}
          </div></div></div>
          <div className="frow"><label className="flabel" htmlFor="wz-est">예상 소요 시간<span className="req">필수</span></label><div className="fctl">
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input id="wz-est" className={`inp mono-in${bad('est')}`} style={{ maxWidth: 120 }} value={d.est} onChange={(x) => { set({ est: x.target.value }); }} aria-invalid={!!bad('est')} /><span className="muted">시간 · 개발 · QA · 재작업 포함</span></span>
            {show && e.est && <span className="ferr">0보다 크고 400 이하인 숫자를 입력하세요.</span>}
          </div></div>
          <div className="frow"><label className="flabel" htmlFor="wz-fix">고정 시작일<span className="opt">선택</span></label><div className="fctl">
            <input id="wz-fix" className={`inp mono-in${bad('fixStart')}`} style={{ maxWidth: 160 }} placeholder="YYYY-MM-DD" value={d.fixStart} onChange={(x) => { set({ fixStart: x.target.value }); }} aria-invalid={!!bad('fixStart')} />
            {show && e.fixStart && <span className="ferr">YYYY-MM-DD 형식으로 입력하세요.</span>}
            <span className="fhint">비우면 선행 관계와 담당 Agent 가용 시간으로 계획 일정을 자동 산정합니다.</span>
          </div></div>
          <div className="frow"><label className="flabel" htmlFor="wz-pri">우선순위<span className="req">필수</span></label><div className="fctl">
            <select id="wz-pri" className="inp" value={d.priority} onChange={(x) => { set({ priority: x.target.value }); }}>
              <option value="0">긴급</option><option value="1">높음</option><option value="2">보통</option><option value="3">낮음</option>
            </select>
          </div></div>
          <div className="frow"><span className="flabel">담당 / 검증 Agent<span className="req">필수</span></span><div className="fctl" style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="muted">담당</span>
            <div className="seg" role="group" aria-label="담당 Agent">{AGENTS.map((a) => <button key={a} type="button" aria-pressed={d.assignee === a} onClick={() => { set({ assignee: a }); }}>{a}</button>)}</div>
            <span className="muted">검증</span>
            <div className="seg" role="group" aria-label="검증 Agent">{(['Codex', 'Claude'] as const).map((a) => <button key={a} type="button" aria-pressed={d.verifier === a} onClick={() => { set({ verifier: a }); }}>{a}</button>)}</div>
          </div></div>
        </div>
      )}
      {step === 2 && (
        <div className="form">
          <div className="frow"><label className="flabel" htmlFor="wz-pur">작업 목적<span className="req">필수</span></label><div className="fctl">
            <textarea id="wz-pur" rows={3} className={`inp${bad('purpose')}`} placeholder="이 Task로 무엇을 가능하게 하는가" value={d.purpose} onChange={(x) => { set({ purpose: x.target.value }); }} aria-invalid={!!bad('purpose')} />
            {show && e.purpose && <span className="ferr">작업 목적을 입력하세요.</span>}
          </div></div>
          <div className="frow"><label className="flabel" htmlFor="wz-bg">작업 배경<span className="opt">선택</span></label><div className="fctl"><textarea id="wz-bg" rows={2} className="inp" placeholder="왜 지금 필요한가" value={d.background} onChange={(x) => { set({ background: x.target.value }); }} /></div></div>
          <div className="frow"><label className="flabel" htmlFor="wz-sc">작업 범위<span className="opt">선택</span></label><div className="fctl"><textarea id="wz-sc" rows={3} className="inp" placeholder="한 줄에 한 항목" value={d.scope} onChange={(x) => { set({ scope: x.target.value }); }} /></div></div>
          <div className="frow"><label className="flabel" htmlFor="wz-out">제외 범위<span className="opt">선택</span></label><div className="fctl"><textarea id="wz-out" rows={2} className="inp" placeholder="구현하지 않을 내용 — 한 줄에 한 항목" value={d.out} onChange={(x) => { set({ out: x.target.value }); }} /></div></div>
          <div className="frow"><label className="flabel" htmlFor="wz-dc">완료 조건<span className="req">필수</span></label><div className="fctl">
            <textarea id="wz-dc" rows={2} className={`inp${bad('doneCond')}`} placeholder="무엇이 확인되면 완료인가" value={d.doneCond} onChange={(x) => { set({ doneCond: x.target.value }); }} aria-invalid={!!bad('doneCond')} />
            {show && e.doneCond && <span className="ferr">완료 조건을 입력하세요.</span>}
            <span className="fhint">상세 요구사항·Acceptance Criteria는 생성 후 [작업 명세] 탭에서 섹션별로 작성합니다.</span>
          </div></div>
        </div>
      )}
      {step === 3 && (
        <div className="cols2">
          <div>
            {created && (
              <div className="banner info" role="status" style={{ marginTop: 0 }}>
                <div className="banner-b"><b>{created.taskKey}을(를) 이미 만들었습니다.</b> 선행 Task 연결만 남았습니다. 지워진 선행은 빼고 「선행 연결」을 누르거나, 「선행 없이 마치기」로 끝내세요. 다시 눌러도 Task를 또 만들지 않습니다.</div>
              </div>
            )}
            <h3 className="wiz-h">선행 Task <span className="opt">선택 · 완료 → 시작(FS)으로 등록</span></h3>
            <div className="predpick" role="group" aria-label="선행 Task">
              {!tasks && <AreaLoading label="Task 목록 불러오는 중" />}
              {/* 고른 선행이 그 사이 지워져 목록에서 빠져도 여기 남겨 해제할 수 있게 한다(재리뷰 F1). */}
              {tasks && d.preds.filter((k) => !byKey.has(k)).map((k) => (
                <label key={k}>
                  <input type="checkbox" className="chk" checked onChange={() => { set({ preds: d.preds.filter((x) => x !== k) }); }} />
                  <span className="mono muted">—</span><span className="mono">{k}</span><span className="ferr">목록에 없음 — 삭제되었을 수 있습니다. 선택을 해제하세요.</span><span />
                </label>
              ))}
              {[...(tasks ?? [])].filter((t) => !t.deletedAt).sort((a, b) => a.wbsPath.localeCompare(b.wbsPath, undefined, { numeric: true })).map((t) => (
                <label key={t.taskKey}>
                  <input type="checkbox" className="chk" checked={d.preds.includes(t.taskKey)} onChange={() => { set({ preds: d.preds.includes(t.taskKey) ? d.preds.filter((x) => x !== t.taskKey) : [...d.preds, t.taskKey] }); }} />
                  <span className="mono muted">{t.wbsPath}</span><span className="mono">{t.taskKey}</span><span>{t.title}</span><StatusPill status={t.lifecycleStatus} />
                </label>
              ))}
            </div>
            {d.preds.some((k) => byKey.get(k)?.lifecycleStatus !== 'done') && (
              <div className="banner danger"><div className="banner-b">선택한 선행 Task 중 미완료가 있어 생성 직후 <b>실행 차단</b> 상태가 됩니다.</div></div>
            )}
          </div>
          <div>
            <h3 className="wiz-h">생성 내용 확인</h3>
            <div className="kv" style={{ gridTemplateColumns: '120px minmax(0,1fr)' }}>
              <span className="kv-l">Task ID</span><span className="kv-v mono">생성 시 자동 부여 <span className="muted">(바뀌지 않음)</span></span>
              <span className="kv-l">제목</span><span className="kv-v">{d.title}</span>
              <span className="kv-l">Work Package</span><span className="kv-v">{wpLabel(d.wbsNodeId)}</span>
              <span className="kv-l">분류</span><span className="kv-v"><span className="wt">{TYPE_LABEL[d.type] ?? '미선택'}</span><span className="dm">{d.domain}</span><span className="dm-rel">{d.rel.length ? `+${d.rel.join(', ')}` : ''}</span></span>
              <span className="kv-l">Agent</span><span className="kv-v">{d.assignee} → {d.verifier}</span>
              <span className="kv-l">초기 상태</span><span className="kv-v"><StatusPill status="planning" /></span>
              <span className="kv-l">선행 Task</span><span className="kv-v mono">{d.preds.length ? d.preds.join(', ') : '없음'}</span>
              <span className="kv-l">기술 설계 섹션</span><span className="kv-v">{designs.length ? `${designs.join(', ')} (기술 영역 기준 권장 — 생성 후 Task 상세에서 추가)` : '없음 — 필요 시 Task 상세에서 추가'}</span>
              <span className="kv-l">일정</span><span className="kv-v">예상 {estOk ? `Agent 실행 ${fmtH(Number(d.est))} (범위 ${fmtH(Number(d.est) * 0.7)} ~ ${fmtH(Number(d.est) * 1.6)} — Planning Agent가 재추정)` : '—'} · 시작 {d.fixStart.trim() || '자동 산정'}</span>
            </div>
            <p className="fhint">생성 후 [작업 명세] 탭이 열립니다. 체크리스트·기술 설계는 Task 상세에서 추가합니다.</p>
            <p className="fhint">예상 소요 시간 · 고정 시작일은 아직 서버 생성 요청에 담을 수 없어 저장되지 않습니다. 생성 후 Planning Agent가 추정합니다.</p>
          </div>
        </div>
      )}
      {create.conflictModal}
      {link.conflictModal}
    </Modal>
  );
}
