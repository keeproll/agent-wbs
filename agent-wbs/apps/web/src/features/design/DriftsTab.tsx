/**
 * 변경 · 불일치 탭(UI-04-06) — 원본 P L1595–1610, 동작 P dsDrift L4831–4835.
 *
 * 원본과 다른 점(계획 contracts §2.3·M6-05 서버, 조정자 승인):
 * - 「계약에 반영」은 Runner job(design_apply)만 만든다(202 { jobId }). 결과 커밋이 보고되고 대조가 일치해야 서버가 해결로 바꾼다.
 *   그래서 요청 직후에는 「계약 반영 대기」로 보이고 「해결됨」으로 바꾸지 않는다(원본은 즉시 done).
 * - 호환을 깨는 차이(breaking)는 승인된(approved) 기술 결정 ID를 붙여야 반영할 수 있다. 창에서 결정을 고르게 하고, 없으면 기술 결정 탭으로 안내한다.
 * - 대조 안 함(unchecked)은 서버가 계약 반영을 거부한다. 버튼을 두지 않고 「불일치 0건이 아님」을 적는다(G L1058).
 * - 「코드 수정 요청」은 서버가 담당 Task에 실제 메시지를 만들고 바로 해결로 기록한다.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { formatDateTime } from '../../shared/format.ts';
import { LINK } from '../../shared/links.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { useNotice } from '../../shared/ui/feedback.tsx';
import { Modal } from '../../shared/ui/Modal.tsx';
import type { DesignCtx } from './DesignPage.tsx';
import { approvedDecisions, driftView, type DriftItem, type Overview } from './model.ts';

export function DriftsTab({ ctx, versions }: { ctx: DesignCtx; versions: Overview['versions'] }) {
  return (
    <>
      <section className="card">
        <div className="dp-h"><h3>설계와 실제 코드의 불일치</h3></div>
        <p className="fhint" style={{ margin: '0 0 8px' }}>Runner가 Task 완료 · 병합 때 코드에서 실제 명세를 추출해 계약 파일과 대조합니다. 호환되는 차이는 계약 반영(기록), 호환을 깨는 차이는 기술 결정 · 설계 변경 승인 또는 코드 수정입니다.</p>
        {ctx.drifts.length === 0 && <p className="empty">불일치가 없습니다.</p>}
        {ctx.drifts.map((d) => <DriftRow key={d.id} d={d} ctx={ctx} />)}
      </section>
      <section className="card">
        <div className="dp-h"><h3>설계 버전</h3></div>
        {versions.length === 0 && <p className="empty">아직 설계 버전이 없습니다. 기술 결정을 확정하면 v1이 생깁니다.</p>}
        <div className="gtb" style={{ margin: 0 }} role="table" aria-label="설계 버전">
          {versions.map((v) => (
            <div key={v.v} className="gtr" role="row" data-ver="" style={{ gridTemplateColumns: '48px 150px minmax(140px,.8fr) minmax(200px,2fr)', minWidth: 0 }}>
              <span className="gc mono" role="cell"><b>v{v.v}</b></span><span className="gc mono" role="cell">{formatDateTime(v.at)}</span><span className="gc" role="cell">{v.by}</span>
              <span className="gc" role="cell">{v.note}{v.breaking && <> <span className="sc sc-bad">호환 깨짐</span></>}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

interface ResolveBody { updatedAt: string; how: 'contract' | 'code'; decisionId?: string }

function DriftRow({ d, ctx }: { d: DriftItem; ctx: DesignCtx }) {
  const v = driftView(d);
  const { client } = useApi();
  const notify = useNotice();
  const [asking, setAsking] = useState(false);
  const r = (d.resolution ?? {}) as Record<string, unknown>;
  /** 호환 깨짐 창에서 고른 결정. 「계약 반영 다시 요청」은 처음 요청에 붙인 결정을 그대로 쓴다. 저장 버튼을 누르는 순간 request()가 읽는다. */
  const [picked, setPicked] = useState('');
  const decisionId = picked || (typeof r.decisionId === 'string' ? r.decisionId : '');
  const resolve = (how: 'contract' | 'code') => ({
    target: `${d.itemKey} ${how === 'contract' ? '계약에 반영' : '코드 수정 요청'}`,
    failTitle: how === 'contract' ? '계약 반영을 요청하지 못했습니다' : '코드 수정을 요청하지 못했습니다',
    mine: `${d.itemKey} — ${how === 'contract' ? '계약에 반영' : '코드 수정 요청'}`,
    request: (): ResolveBody => ({ updatedAt: d.updatedAt, how, ...(how === 'contract' && decisionId ? { decisionId } : {}) }),
    run: ({ payload, idempotencyKey }: { payload: ResolveBody; idempotencyKey: string }) =>
      client.call('resolveDrift', { params: { projectId: ctx.projectId, id: d.id }, body: payload, idempotencyKey }),
    onSuccess: () => {
      notify(how === 'contract' ? '계약 반영을 요청했습니다. Runner가 결과 커밋을 보고하면 해결로 바뀝니다.' : '대상 Task에 코드 수정 요청을 보냈습니다.');
      setAsking(false);
      void ctx.reload();
    },
    onConflictReload: async ({ signal }: { signal: AbortSignal }) => { await ctx.reload(signal); },
    onRejected: () => { void ctx.reload(); },
  });
  const contract = useSave(resolve('contract'));
  const code = useSave(resolve('code'));
  const busy = contract.busy || code.busy;
  const toContract = () => {
    if (v.needsDecision) { setAsking(true); return; }
    void contract.save();
  };
  return (
    <div className="dec-row" data-drift={d.itemKey}>
      <div className="dec-h">
        <span className="tag">{d.kind}</span><b className="mono">{d.itemKey}</b><span className="sp" />
        {d.taskKey && <Link className="reflink mono" to={LINK.task(d.taskKey)}>{d.taskKey}</Link>}
        <span className={v.compatC}>{v.compatL}</span><span className={v.stC}>{v.stL}</span>
      </div>
      <p className="dec-p">{d.text} <span className="tid">({d.where})</span></p>
      {v.note && <p className="dec-p" style={{ color: 'var(--wn)' }}>{v.note}</p>}
      {v.resL && <p className="dec-p muted">처리: {v.resL}</p>}
      {(v.canContract || v.canCode || v.canRetry) && (
        <div className="dec-f"><span className="sp" />
          {v.canRetry && <BusyButton busy={contract.busy} busyLabel="요청 중…" variant="ghost" small title="반영 작업이 실패·취소됐을 때만 다시 요청됩니다. 아직 진행 중이면 서버가 거부합니다." onClick={() => { void contract.save(); }}>계약 반영 다시 요청</BusyButton>}
          {v.canCode && <BusyButton busy={code.busy} busyLabel="요청 중…" variant="default" small disabled={busy} onClick={() => { void code.save(); }}>코드 수정 요청</BusyButton>}
          {v.canContract && <BusyButton busy={contract.busy && !asking} busyLabel="요청 중…" small disabled={busy} onClick={toContract}>계약에 반영</BusyButton>}
        </div>
      )}
      {asking && (
        <BreakingModal
          ctx={ctx} d={d} busy={contract.busy} pick={picked} onPick={setPicked}
          onCancel={() => { setAsking(false); setPicked(''); }}
          onSubmit={() => { void contract.save(); }}
        />
      )}
      {contract.conflictModal}
      {code.conflictModal}
    </div>
  );
}

/** 호환을 깨는 차이의 계약 반영: 승인된 기술 결정을 골라야 보낸다(M6-05 resolveDrift decisionId). */
function BreakingModal({ ctx, d, busy, pick, onPick, onCancel, onSubmit }: {
  ctx: DesignCtx; d: DriftItem; busy: boolean; pick: string; onPick: (id: string) => void; onCancel: () => void; onSubmit: () => void;
}) {
  const options = approvedDecisions(ctx.decisions);
  return (
    <Modal
      title="호환을 깨는 변경 — 계약에 반영"
      role="dialog"
      onCancel={onCancel}
      footer={<>
        <button type="button" className="btn" onClick={onCancel}>취소</button>
        <BusyButton busy={busy} busyLabel="요청 중…" disabled={!pick} onClick={onSubmit}>반영 요청</BusyButton>
      </>}
    >
      <p style={{ margin: '0 0 8px' }}><b className="mono">{d.itemKey}</b> — {d.text}</p>
      <p className="fhint" style={{ margin: '0 0 10px' }}>호환을 깨는 변경(필드 삭제 · 타입 변경 · 필수화)은 승인된 기술 결정이 필요합니다. 설계 변경을 승인한 결정을 고르면 그 결정 ID와 함께 반영을 요청합니다. 다른 방법은 「코드 수정 요청」입니다.</p>
      {options.length === 0 ? (
        <div className="banner warn"><div className="banner-b" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ marginRight: 'auto' }}>승인된 기술 결정이 없습니다 — 기술 결정 탭에서 설계 변경을 승인한 뒤 반영하세요.</span>
          <button type="button" className="btn sm" onClick={() => { onCancel(); ctx.goTab('dec'); }}>기술 결정 보기</button>
        </div></div>
      ) : (
        <div className="form" style={{ maxWidth: 'none' }}>
          <div className="frow"><label className="flabel" htmlFor={`bd-${d.id}`}>승인된 기술 결정<span className="req">필수</span></label>
            <div className="fctl">
              <select id={`bd-${d.id}`} className="inp" value={pick} onChange={(e) => { onPick(e.target.value); }}>
                <option value="">결정을 고르세요</option>
                {options.map((x) => <option key={x.id} value={x.id}>{`${x.tdKey} ${x.title} — ${x.choice}`}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
