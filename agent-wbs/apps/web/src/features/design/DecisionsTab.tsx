/**
 * 기술 결정 탭(UI-04-02) — 원본 P L1510–1522, 동작 P dsDecide·dsChangeReq L4815–4830.
 *
 * - 승인·반려·변경 제안은 공통 저장 흐름(useSave)을 쓴다. 버튼을 누른 순간의 updatedAt을 찍어 보내고, 결과를 모르면 같은 멱등 키로 다시 시도한다.
 * - 변경 제안은 원본에서는 Mock이었다. 계약(POST /api/design/decisions/:id/change)은 팀장이 올릴 수 있어 입력 창을 둔다.
 *   승인 전에는 기존 선택이 그대로 기준이다(서버가 기존 choice를 유지하고 change에 새 선택을 둔다).
 * - 팀장 지정 필수·금지와 Agent 재량 기록은 변경 제안 버튼이 없다(원본 canChg, 서버도 409 INVALID_TRANSITION).
 */
import { useEffect, useState } from 'react';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { formatDateTime } from '../../shared/format.ts';
import { DISCARD_CONFIRM } from '../../shared/state/useEditGuard.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { useConfirm, useNotice } from '../../shared/ui/feedback.tsx';
import { Modal } from '../../shared/ui/Modal.tsx';
import type { DesignCtx } from './DesignPage.tsx';
import { decisionGroups, decisionView, type DecisionItem } from './model.ts';

export function DecisionsTab({ ctx }: { ctx: DesignCtx }) {
  const [changing, setChanging] = useState<DecisionItem | null>(null);
  const groups = decisionGroups(ctx.decisions);
  return (
    <>
      <p className="fhint" style={{ margin: '0 0 10px' }}>
        결정 권한 3단계 — <b>팀장 지정</b>(필수 · 조건부 선호 · 금지, Agent가 바꿀 수 없음) / <b>Agent 제안 → 팀장 승인</b>(되돌리기 어려운 것: 저장소 · 통신 방식 · 메시지 형식) / <b>Agent 재량</b>(되돌리기 쉬운 것: 인덱스 · 캐시 만료 · 모듈 내부 라이브러리, 기록만). 구현 중 바꿔야 하면 Agent가 「기술 결정 변경」을 제안하고 팀장이 승인합니다.
      </p>
      {groups.length === 0 && <div className="card"><p className="empty" style={{ margin: 0 }}>아직 기술 결정이 없습니다. 초기 분석의 「기술 결정 확정」 단계에서 정한 결정이 여기에 나타납니다.</p></div>}
      {groups.map((g) => (
        <section key={g.k} className="card">
          <div className="dp-h"><h2>{g.l}</h2></div>
          {g.rows.map((x) => <DecisionRow key={x.id} x={x} ctx={ctx} onChange={() => { setChanging(x); }} />)}
        </section>
      ))}
      {changing && (
        <ChangeModal
          x={changing}
          ctx={ctx}
          onClose={() => { ctx.setDirty(false); setChanging(null); }}
        />
      )}
    </>
  );
}

function DecisionRow({ x, ctx, onChange }: { x: DecisionItem; ctx: DesignCtx; onChange: () => void }) {
  const v = decisionView(x);
  const { client } = useApi();
  const notify = useNotice();
  const decide = (action: 'approve' | 'reject') => ({
    target: `${x.tdKey} ${action === 'approve' ? '승인' : '반려'}`,
    failTitle: action === 'approve' ? '승인하지 못했습니다' : '반려하지 못했습니다',
    mine: `${x.tdKey} ${x.title} ${action === 'approve' ? '승인' : '반려'}`,
    request: () => ({ updatedAt: x.updatedAt }),
    run: ({ payload, idempotencyKey }: { payload: { updatedAt: string }; idempotencyKey: string }) =>
      client.call(action === 'approve' ? 'approveDecision' : 'rejectDecision', { params: { id: x.id }, body: payload as { updatedAt: string; comment?: string }, idempotencyKey }),
    onSuccess: () => {
      // 원본 안내(P dsDecide L4825)와 같은 문구. 변경 제안의 승인·반려는 「변경」을 붙인다.
      notify(`${x.tdKey} ${v.isChg ? '변경 ' : ''}${action === 'approve' ? '승인 — 설계 버전이 올라갔습니다.' : '반려했습니다.'}`);
      void ctx.reload();
    },
    onConflictReload: async ({ signal }: { signal: AbortSignal }) => { await ctx.reload(signal); },
    onRejected: () => { void ctx.reload(); },
  });
  const approve = useSave(decide('approve'));
  const reject = useSave(decide('reject'));
  const busy = approve.busy || reject.busy;
  return (
    <div className={v.rowC} data-dec={x.tdKey}>
      <div className="dec-h">
        <span className="mono muted">{x.tdKey}</span><span className="tag">{x.area}</span><b>{x.title}</b><span className="dec-c">{x.choice}</span>
        <span className="sp" /><span className={v.authC}>{v.authL}</span><span className={v.stC}>{v.stL}</span>
      </div>
      {v.condL && <p className="dec-p"><span className="muted">조건</span> {v.condL}</p>}
      <p className="dec-p"><span className="muted">근거</span> {x.reason}</p>
      {x.alternatives && <p className="dec-p"><span className="muted">대안</span> {x.alternatives}</p>}
      {v.isChg && <p className="dec-p" style={{ color: 'var(--wn)' }}><span className="muted">변경 제안</span> {v.chgL}</p>}
      <div className="dec-f">
        <span className="tid">{x.by} · {formatDateTime(x.at)}</span><span className="sp" />
        {v.pending && (
          <>
            <BusyButton busy={reject.busy} busyLabel="반려 중…" variant="default" small disabled={busy} onClick={() => { void reject.save(); }}>반려</BusyButton>
            <BusyButton busy={approve.busy} busyLabel="승인 중…" small disabled={busy} onClick={() => { void approve.save(); }}>승인</BusyButton>
          </>
        )}
        {v.canChg && <button type="button" className="btn ghost sm" onClick={onChange}>변경 제안</button>}
      </div>
      {approve.conflictModal}
      {reject.conflictModal}
    </div>
  );
}

interface ChangeForm { choice: string; reason: string }

/** 기술 결정 변경 제안 입력 창. 입력은 세션이 끊겨도 보관했다가 복원을 제안하고, 창 밖 이동은 화면의 편집 보호가 막는다. */
function ChangeModal({ x, ctx, onClose }: { x: DecisionItem; ctx: DesignCtx; onClose: () => void }) {
  const { client } = useApi();
  const notify = useNotice();
  const confirm = useConfirm();
  const [form, setForm] = useState<ChangeForm>({ choice: '', reason: '' });
  const [tried, setTried] = useState(false);
  const dirty = form.choice.trim() !== '' || form.reason.trim() !== '';
  const { setDirty } = ctx;
  useEffect(() => { setDirty(dirty); }, [dirty, setDirty]);
  const { restoreOffer } = useSessionDraft({
    id: `design:change:${x.id}`,
    label: `${x.tdKey} 기술 결정 변경 제안`,
    value: dirty ? form : null,
    onRestore: (data: ChangeForm) => { setForm(data); },
  });
  const { save, busy, conflictModal } = useSave({
    target: `${x.tdKey} 변경 제안`,
    failTitle: '변경 제안을 올리지 못했습니다',
    mine: `${x.choice} → ${form.choice.trim()}`,
    request: () => ({ updatedAt: x.updatedAt, choice: form.choice.trim(), reason: form.reason.trim() }),
    run: ({ payload, idempotencyKey }) => client.call('changeDecision', { params: { id: x.id }, body: payload, idempotencyKey }),
    onSuccess: (_result, payload) => {
      notify(`${x.tdKey} 변경 제안을 올렸습니다 — 팀장 승인 전까지 기존 결정을 유지합니다.`);
      void ctx.reload();
      // 재시도 사이에 입력을 더 고쳤으면 창을 닫지 않는다.
      if (payload.choice === form.choice.trim() && payload.reason === form.reason.trim()) onClose();
    },
    onConflictReload: async ({ signal }) => { await ctx.reload(signal); },
    onRejected: () => { void ctx.reload(); },
  });
  const errs = tried ? [...(form.choice.trim() ? [] : ['새 선택을 입력하세요.']), ...(form.reason.trim() ? [] : ['변경 이유를 입력하세요.'])] : [];
  const submit = () => {
    setTried(true);
    if (!form.choice.trim() || !form.reason.trim()) return;
    void save();
  };
  const cancel = () => {
    if (!dirty) { onClose(); return; }
    void confirm(DISCARD_CONFIRM).then((ok) => { if (ok) onClose(); });
  };
  return (
    <Modal
      title={`${x.tdKey} 기술 결정 변경 제안`}
      role="dialog"
      onCancel={cancel}
      initialFocus="#dc-choice"
      footer={<>
        <button type="button" className="btn" onClick={cancel}>취소</button>
        <BusyButton busy={busy} busyLabel="올리는 중…" onClick={submit}>변경 제안 올리기</BusyButton>
      </>}
    >
      {restoreOffer}
      <p className="fhint" style={{ margin: '0 0 10px' }}>현재 결정: <b>{x.title} — {x.choice}</b>. 승인 전까지 기존 결정을 유지합니다. 영향(계약 파일 · 관련 Task 재작업 · 데이터 이전 여부)을 이유에 적습니다.</p>
      <div className="form" style={{ maxWidth: 'none' }}>
        <div className="frow"><label className="flabel" htmlFor="dc-choice">새 선택<span className="req">필수</span></label><div className="fctl"><input id="dc-choice" className="inp" value={form.choice} aria-invalid={tried && !form.choice.trim()} onChange={(e) => { setForm({ ...form, choice: e.target.value }); }} /></div></div>
        <div className="frow"><label className="flabel" htmlFor="dc-reason">변경 이유<span className="req">필수</span></label><div className="fctl"><textarea id="dc-reason" rows={3} className="inp" value={form.reason} aria-invalid={tried && !form.reason.trim()} onChange={(e) => { setForm({ ...form, reason: e.target.value }); }} /></div></div>
      </div>
      {errs.length > 0 && <div className="banner danger" role="alert"><div className="banner-b">{errs.join(' ')}</div></div>}
      {conflictModal}
    </Modal>
  );
}
