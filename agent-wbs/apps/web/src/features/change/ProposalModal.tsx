/**
 * 「Change Proposal 작성」 모달(MOD-07). 원본 P L2849–2885, 로직 P L5764–5805.
 *
 * 제출 흐름(계약 contracts §2.1): 초안 작성(POST /api/proposals → draft) → 미리보기(서버 판정) → 문제가 없을 때만 제출(review).
 * - 서버 미리보기에 문제(issues)가 있으면 제출하지 않고 창 안에 「제출할 수 없습니다」와 사유를 보인다.
 *   이때 초안 CP는 「작성 중」으로 남는다(계약에 초안 수정·삭제 API가 없음 — 보고서에 적음).
 * - 재시도(오류 막대 「다시 시도」)는 같은 멱등 키로 보낸다. 초안 작성은 같은 CP를 돌려받고, 제출은 `<키>:submit` 키를 쓴다.
 *   왜: 첫 시도가 서버에서 끝나고 응답만 잃었으면 새 키로는 CP가 두 개 생긴다.
 * - 행은 id로 고치고 지운다(form.ts). 입력은 세션이 끊겨도 보관했다가 복원을 제안한다.
 */
import { useEffect, useState } from 'react';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { useSave } from '../../shared/state/useSave.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { useNotice } from '../../shared/ui/feedback.tsx';
import { ICON, Icon } from '../../shared/ui/Icon.tsx';
import { Modal } from '../../shared/ui/Modal.tsx';
import { buildProposal, newRow, removeRow, ROW_TYPES, updateRow, type CreateBody, type FormState, type RowType } from './form.ts';
import { diffRows, type TaskInfo } from './model.ts';
import { DIFF_GRID } from './ProposalDetail.tsx';
import type { Proposal, ProposalOp, ProposalPreview } from './types.ts';

const ROW_GRID = { gridTemplateColumns: '180px 140px minmax(240px,1fr) 44px' };
const EMPTY = (): FormState => ({ title: '', reason: '', rows: [newRow('')] });

interface Outcome { cp: Proposal; preview: ProposalPreview; submitted: Proposal | null }

export function ProposalModal({ tasks, onDirty, onClose, onSubmitted }: {
  tasks: ReadonlyMap<string, TaskInfo> | null;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
  onSubmitted: (cp: Proposal) => void;
}) {
  const { client } = useApi();
  const notify = useNotice();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [tried, setTried] = useState(false);
  /** 서버 미리보기가 막은 결과(초안 키와 사유). 입력을 고치면 지운다. */
  const [blocked, setBlocked] = useState<{ cpKey: string; reasons: string[] } | null>(null);
  const dirty = form.title.trim() !== '' || form.reason.trim() !== '' || form.rows.some((r) => r.value.trim() !== '' || r.task.trim() !== '');
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const { restoreOffer } = useSessionDraft({
    id: 'cp:new',
    label: '새 변경 제안 작성',
    value: dirty ? form : null,
    onRestore: (data: FormState) => { setForm(data); },
  });

  const built = buildProposal(form, tasks);
  const edit = (next: FormState) => { setForm(next); setBlocked(null); };

  const { save, busy, conflictModal } = useSave<Outcome, CreateBody>({
    target: '새 변경 제안 제출',
    failTitle: '제출하지 못했습니다',
    request: () => built.body as CreateBody,
    run: async ({ payload, idempotencyKey }) => {
      const cp = await client.call('createProposal', { body: payload, idempotencyKey });
      const preview = await client.call('previewProposal', { params: { id: cp.id } });
      if (preview.issues.length > 0) return { cp, preview, submitted: null };
      const submitted = await client.call('submitProposal', { params: { id: cp.id }, body: { updatedAt: cp.updatedAt }, idempotencyKey: `${idempotencyKey}:submit` });
      return { cp, preview, submitted };
    },
    onSuccess: (result, payload) => {
      if (!result.submitted) {
        setBlocked({ cpKey: result.cp.cpKey, reasons: result.preview.issues.map((i) => `${i.taskKey ? `${i.taskKey} · ` : ''}${i.message} (${i.code})`) });
        return;
      }
      notify(`${result.submitted.cpKey} 변경 제안을 제출했습니다. 승인 전에는 WBS에 반영되지 않습니다.`);
      // 그 사이 입력을 더 고쳤으면 창을 닫지 않는다(고친 내용은 새 제안으로 다시 낸다).
      const now = buildProposal(form, tasks).body;
      if (JSON.stringify(now) === JSON.stringify(payload)) onSubmitted(result.submitted);
    },
  });

  const submit = () => {
    setTried(true);
    if (built.errs.length) return;
    void save();
  };
  const errs = tried ? built.errs : [];
  const preview = built.body ? diffRows((built.body as { ops: ProposalOp[] }).ops, {}, tasks ?? new Map(), []) : [];

  return (
    <Modal
      title="Change Proposal 작성"
      size="lg"
      role="dialog"
      onCancel={onClose}
      initialFocus="#cpm-title"
      footer={<>
        <button type="button" className="btn" onClick={onClose}>취소</button>
        <BusyButton busy={busy} busyLabel="제출 중…" onClick={submit}>제출 — 승인 요청</BusyButton>
      </>}
    >
      {restoreOffer}
      <div className="banner info" style={{ margin: '0 0 14px' }}><div className="banner-b">제출하면 <b>승인 대기</b> 상태가 됩니다. 팀장 승인과 「WBS 반영」 전까지 공식 Task 명세와 WBS는 바뀌지 않습니다.</div></div>
      <div className="form" style={{ maxWidth: 'none' }}>
        <div className="frow"><label className="flabel" htmlFor="cpm-title">제목<span className="req">필수</span></label><div className="fctl"><input id="cpm-title" className="inp" value={form.title} onChange={(e) => { edit({ ...form, title: e.target.value }); }} /></div></div>
        <div className="frow"><label className="flabel" htmlFor="cpm-reason">변경 사유<span className="req">필수</span></label><div className="fctl"><textarea id="cpm-reason" rows={3} className="inp" value={form.reason} onChange={(e) => { edit({ ...form, reason: e.target.value }); }} /></div></div>
        <div className="frow"><span className="flabel">출처</span><div className="fctl"><span style={{ paddingTop: 7 }}>팀장 직접 작성</span></div></div>
      </div>
      <h4 style={{ marginTop: 16 }}>변경 항목</h4>
      <div className="gtb" role="region" aria-label="변경 항목" tabIndex={0}>
        <div className="gtr h" style={ROW_GRID}><span className="gc">유형</span><span className="gc">대상 Task</span><span className="gc">값</span><span className="gc" /></div>
        {form.rows.map((r, i) => (
          <div key={r.id} className="gtr ed" style={ROW_GRID} data-row={r.id}>
            <span className="gc">
              <select className="inp cellin" value={r.type} aria-label={`항목 ${String(i + 1)} 변경 유형`} onChange={(e) => { edit({ ...form, rows: updateRow(form.rows, r.id, { type: e.target.value as RowType }) }); }}>
                {(Object.keys(ROW_TYPES) as RowType[]).map((k) => <option key={k} value={k}>{ROW_TYPES[k].l}</option>)}
              </select>
            </span>
            <span className="gc"><input className="inp cellin mono-in" value={r.task} placeholder="TASK-0000" aria-label={`항목 ${String(i + 1)} 대상 Task ID`} onChange={(e) => { edit({ ...form, rows: updateRow(form.rows, r.id, { task: e.target.value }) }); }} /></span>
            <span className="gc"><input className="inp cellin" value={r.value} placeholder={ROW_TYPES[r.type].hint} aria-label={`항목 ${String(i + 1)} 변경 값`} onChange={(e) => { edit({ ...form, rows: updateRow(form.rows, r.id, { value: e.target.value }) }); }} /></span>
            <span className="gc"><button type="button" className="iconbtn sm" aria-label={`항목 ${String(i + 1)} 삭제`} onClick={() => { edit({ ...form, rows: removeRow(form.rows, r.id) }); }}><Icon d={ICON.close} small /></button></span>
          </div>
        ))}
      </div>
      <button type="button" className="btn sm" onClick={() => { edit({ ...form, rows: [...form.rows, newRow(form.rows.at(-1)?.task ?? '')] }); }}>+ 항목 추가</button>
      {(errs.length > 0 || blocked) && (
        <div className="banner danger" role="alert">
          <div className="banner-b">
            <b>제출할 수 없습니다</b>
            {blocked && <> — 서버 미리보기에서 문제가 나와 제출하지 않았습니다. 초안 {blocked.cpKey}은(는) 「작성 중」으로 남습니다.</>}
            <ul className="lst" style={{ margin: '4px 0 0', color: 'inherit' }}>{[...errs, ...(blocked?.reasons ?? [])].map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        </div>
      )}
      {built.errs.length === 0 && preview.length > 0 && (
        <>
          <h4 style={{ marginTop: 16 }}>변경 전 / 후 미리보기</h4>
          <div className="gtb" role="region" aria-label="변경 전 / 후 미리보기" tabIndex={0}>
            <div className="gtr h" style={DIFF_GRID}><span className="gc">구분</span><span className="gc">대상 Task</span><span className="gc">항목</span><span className="gc">변경 전</span><span className="gc">변경 후</span><span className="gc" /></div>
            {preview.map((r, i) => (
              <div key={form.rows[i]?.id ?? String(i)} className="gtr" style={DIFF_GRID}>
                <span className="gc"><span className={r.kindC}>{r.kindL}</span></span>
                <span className="gc mono">{r.target} <span className="muted">{r.tTitle}</span></span>
                <span className="gc">{r.field}</span><span className="gc dbef">{r.before}</span><span className="gc daft">{r.after}</span><span className="gc" />
              </div>
            ))}
          </div>
        </>
      )}
      {conflictModal}
    </Modal>
  );
}
