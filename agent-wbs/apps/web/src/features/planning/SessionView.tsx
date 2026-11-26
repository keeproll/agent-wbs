/**
 * Planning 세션 한 건(UI-05-01): 단계 → 독립 분석 2개 → 교차 검토·이견 조정 → 최종 제안 Diff → Change Proposal 작성.
 * 원본 P L1639–1683.
 *
 * - 이견 선택은 바로 서버에 저장한다(POST /api/plannings/:id/reviews/:rid/choice, 검토의 updatedAt으로 충돌 검사).
 *   메모는 선택과 함께 저장한다. 이미 고른 뒤 메모만 바꾸면 「메모 저장」으로 같은 선택을 다시 보낸다.
 * - 이 세션의 CP가 반려가 아닌 상태로 있으면 조정을 잠근다(원본 locked). 반려되면 다시 조정하고 새 CP를 만들 수 있다.
 * - 미조정 이견이 있거나 변경이 없으면 CP를 만들 수 없다. 문제(issues) 판정은 서버가 CP를 만든 뒤 미리보기로 보인다.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { formatDateTime } from '../../shared/format.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { useNotice } from '../../shared/ui/feedback.tsx';
import { PAGE_LIMIT } from '../change/find.ts';
import { cpStatus, diffRows, opText, type TaskInfo } from '../change/model.ts';
import { DIFF_GRID } from '../change/ProposalDetail.tsx';
import type { Proposal } from '../change/types.ts';
import { cpReason, isDiff, openCount, planOps, planStep, type Planning, type PlanningReview } from './model.ts';

const CHOICES = [['codex', 'Codex 안 채택'], ['claude', 'Claude 안 채택'], ['hold', '변경 없음 (보류)']] as const;
const agCls = (a: string) => (a === 'Claude' ? 'ag-claude' : 'ag-codex');
const agInit = (a: string) => (a === 'Claude' ? 'Cl' : 'Cx');

function useRefreshPlanning() {
  const queryClient = useQueryClient();
  return () => Promise.all(['listPlannings', 'listProposals'].map((id) => queryClient.invalidateQueries({ queryKey: [id] })));
}

export function SessionView({ planning, cp, tasks, memos, setMemo, openCp }: {
  planning: Planning;
  cp: Proposal | null;
  tasks: ReadonlyMap<string, TaskInfo> | null;
  memos: Readonly<Record<string, string>>;
  setMemo: (reviewId: string, memo: string | null) => void;
  openCp: (cpKey: string) => void;
}) {
  const { client } = useApi();
  const notify = useNotice();
  const refresh = useRefreshPlanning();
  const status = cp ? String(cp.status) : null;
  const locked = cp !== null && status !== 'rejected';
  const step = planStep(planning.reviews, status);
  const openN = openCount(planning.reviews);
  const ops = locked && cp ? cp.ops : planOps(planning.reviews);
  const diff = diffRows(ops, locked && cp ? cp.idMap : {}, tasks ?? new Map(), []);
  const agreeN = planning.reviews.filter((rv) => !isDiff(rv.kind)).length;
  const diffN = planning.reviews.length - agreeN;

  const makeCp = useSave<Proposal, { title: string; reason: string }>({
    target: `Planning ${planning.title} Change Proposal 작성`,
    failTitle: 'Change Proposal을 작성하지 못했습니다',
    request: () => ({ title: planning.title, reason: cpReason(planning.title, planning.reviews) }),
    run: ({ payload, idempotencyKey }) => client.call('createPlanningProposal', { params: { id: planning.id }, body: payload, idempotencyKey }),
    onSuccess: (created) => {
      void refresh();
      notify(`${created.cpKey} Change Proposal 초안을 작성했습니다. 변경 제안 화면에서 제출하면 승인 대기가 됩니다. 팀장 승인과 WBS 반영 전까지 WBS는 바뀌지 않습니다.`);
      openCp(created.cpKey);
    },
    onRejected: () => { void refresh(); },
  });
  const cannotCp = locked || openN > 0 || ops.length === 0;
  const cpNote = locked && cp
    ? `${cp.cpKey}로 제출됨 — 승인 · 반영 상태는 변경 제안 화면에서 확인합니다.`
    : openN ? `미조정 이견 ${String(openN)}건을 조정해야 Change Proposal을 작성할 수 있습니다.`
      : !ops.length ? '반영할 변경이 없습니다.'
        : `조정 완료 — 변경 ${String(ops.length)}건으로 Change Proposal을 작성합니다. 서버가 변경 항목을 검사해 문제가 있으면 제출을 막습니다.`;

  return (
    <>
      <div className="card">
        <div className="pane-h" style={{ margin: 0 }}>
          <div>
            <span className="mono muted">{formatDateTime(planning.createdAt)}</span>
            <h2 className="h2">{planning.title}</h2>
            <span className="muted">대상 범위: {planning.scope} · 요청 {formatDateTime(planning.createdAt)}</span>
          </div>
          {cp && <Link className="btn sm" to={`/change/${cp.cpKey}`}>{cp.cpKey} · {cpStatus(cp.status).l}</Link>}
        </div>
        <ol className="flow" aria-label="진행 단계">
          {step.steps.map((s) => <li key={s.n} className={s.cls} aria-current={s.cls === 'cur' ? 'step' : undefined}><span className="st-n">{s.n}</span>{s.l}</li>)}
        </ol>
      </div>
      <h3 className="sh">독립 분석 결과 <span className="muted">Codex와 Claude가 서로의 결과를 보지 않고 작성</span></h3>
      {planning.analyses.length === 0
        ? <div className="card"><p className="empty" style={{ margin: 0 }}>아직 독립 분석이 없습니다. Codex · Claude가 분석을 보고하면 여기에 나란히 보입니다.</p></div>
        : (
          <div className="cmp">
            {planning.analyses.map((a) => (
              <div key={String(a.agent)} className="card">
                <div className="att-h">
                  <span className="agent"><span className={`ag-mk ${agCls(String(a.agent))}`} aria-hidden="true">{agInit(String(a.agent))}</span>{String(a.agent)}</span>
                  <span className="tag">독립 분석</span><span className="mono muted">{formatDateTime(a.at)}</span>
                </div>
                <p style={{ margin: '0 0 8px', color: '#3E4651' }}>{a.summary}</p>
                <ul className="lst">{a.items.map((it, i) => <li key={`${String(i)}-${it}`}>{it}</li>)}</ul>
              </div>
            ))}
          </div>
        )}
      <h3 className="sh">교차 검토 · 이견 조정 <span className="muted">일치 {agreeN} · 이견 {diffN} · 미조정 {openN}</span></h3>
      {planning.reviews.length === 0 && <div className="card"><p className="empty" style={{ margin: 0 }}>아직 교차 검토가 없습니다. 두 독립 분석이 끝나면 일치 · 이견이 여기에 보입니다.</p></div>}
      {planning.reviews.map((rv) => (
        <ReviewCard key={rv.id} planning={planning} review={rv} locked={locked} memo={memos[rv.id]} setMemo={(m) => { setMemo(rv.id, m); }} />
      ))}
      <h3 className="sh">최종 제안 <span className="muted">WBS 변경 전 / 후 Diff — 승인 전에는 WBS에 반영되지 않음</span></h3>
      <div className="card">
        {ops.length === 0 && <p className="empty">반영할 변경이 없습니다.</p>}
        <div className="gtb" role="region" aria-label="최종 제안 Diff" tabIndex={0}>
          <div className="gtr h" style={DIFF_GRID}><span className="gc">구분</span><span className="gc">대상 Task</span><span className="gc">항목</span><span className="gc">변경 전</span><span className="gc">변경 후</span><span className="gc" /></div>
          {diff.map((r, i) => (
            <div key={`${String(i)}-${r.kindL}-${r.target}`} className="gtr" style={DIFF_GRID}>
              <span className="gc"><span className={r.kindC}>{r.kindL}</span></span>
              <span className="gc">{r.canOpen ? <Link className="reflink" to={`/wbs/${r.target}`}>{r.target}</Link> : <span className="mono">{r.target}</span>} <span className="muted">{r.tTitle}</span></span>
              <span className="gc">{r.field}</span><span className="gc dbef">{r.before}</span><span className="gc daft">{r.after}</span><span className="gc" />
            </div>
          ))}
        </div>
        <div className="form-acts">
          <span className="muted" style={{ marginRight: 'auto' }}>{cpNote}</span>
          <BusyButton busy={makeCp.busy} busyLabel="작성 중…" disabled={cannotCp} onClick={() => { void makeCp.save(); }}>Change Proposal 작성</BusyButton>
        </div>
      </div>
      {makeCp.conflictModal}
    </>
  );
}

function ReviewCard({ planning, review, locked, memo, setMemo }: {
  planning: Planning; review: PlanningReview; locked: boolean; memo: string | undefined; setMemo: (m: string | null) => void;
}) {
  const { client } = useApi();
  const refresh = useRefreshPlanning();
  const diff = isDiff(review.kind);
  const choice = review.choice;
  const memoNow = memo ?? review.memo;
  const ops = !diff ? review.ops : choice === 'codex' ? review.codexOps : choice === 'claude' ? review.claudeOps : [];
  const label = review.topic;

  const send = (updatedAt: string, payload: { choice: string; memo: string }) => client.call('choosePlanningReview', {
    params: { id: planning.id, rid: review.id }, body: { updatedAt, choice: payload.choice, ...(payload.memo.trim() ? { memo: payload.memo.trim() } : {}) },
  });
  /** 누른 선택을 request()가 읽게 둔다(저장 버튼을 누른 순간의 값). */
  const pending = useRef(choice ?? '');
  const choose = useSave<unknown, { updatedAt: string; choice: string; memo: string }>({
    target: `「${label}」 이견 조정`,
    failTitle: '조정 결과를 저장하지 못했습니다',
    mine: `조정 결과 저장${memoNow ? ` · 메모 ${memoNow}` : ''}`,
    request: () => ({ updatedAt: review.updatedAt, choice: pending.current, memo: memoNow }),
    run: ({ payload, idempotencyKey }) => client.call('choosePlanningReview', {
      params: { id: planning.id, rid: review.id }, idempotencyKey,
      body: { updatedAt: payload.updatedAt, choice: payload.choice, ...(payload.memo.trim() ? { memo: payload.memo.trim() } : {}) },
    }),
    onSuccess: (_r, payload) => {
      // 그 사이 메모를 더 고쳤으면 초안을 남긴다.
      if (memo === undefined || memo === payload.memo) setMemo(null);
      void refresh();
    },
    onConflictReload: () => { setMemo(null); void refresh(); },
    onConflictReapply: async () => {
      const fresh = (await client.call('listPlannings', { query: { limit: PAGE_LIMIT } })).items.find((p) => p.id === planning.id)?.reviews.find((r) => r.id === review.id);
      if (!fresh) throw new Error('검토를 다시 찾지 못했습니다.');
      await send(fresh.updatedAt, { choice: pending.current, memo: memoNow });
      setMemo(null);
      await refresh();
    },
    onRejected: () => { void refresh(); },
  });
  const pick = (value: string) => { pending.current = value; void choose.save(); };

  return (
    <div className={diff && !choice ? 'rv open' : 'rv'} role="group" aria-label={`검토: ${label}`}>
      <div className="rv-h">
        <span className={diff ? 'kb k-diff' : 'kb k-agree'}>{diff ? '이견' : '일치'}</span><b>{label}</b><span className="sp" />
        <span className={diff && !choice ? 'blk' : 'okt'}>{!diff ? '일치 — 그대로 반영' : !choice ? '미조정' : (CHOICES.find((c) => c[0] === choice)?.[1] ?? choice)}</span>
      </div>
      <div className="cmp">
        <div className={`rv-opt${!diff || choice === 'codex' ? ' pick' : choice ? ' drop' : ''}`}><span className="rv-a">Codex 안</span><p>{review.codex}</p></div>
        <div className={`rv-opt${!diff || choice === 'claude' ? ' pick' : choice ? ' drop' : ''}`}><span className="rv-a">Claude 안</span><p>{review.claude}</p></div>
      </div>
      {diff && !locked && (
        <div className="rv-act">
          <span className="muted">조정 결과</span>
          <div className="seg" role="group" aria-label={`「${label}」 조정 결과`}>
            {CHOICES.map(([value, text]) => (
              <button key={value} type="button" aria-pressed={choice === value} disabled={choose.busy} onClick={() => { pick(value); }}>{text}</button>
            ))}
          </div>
          <input className="inp" aria-label={`「${label}」 조정 메모`} placeholder="조정 메모 (선택) — 판단 근거를 남깁니다" value={memoNow}
            onChange={(e) => { setMemo(e.target.value === review.memo ? null : e.target.value); }} />
          {choice && memo !== undefined && (
            <BusyButton small variant="default" busy={choose.busy} busyLabel="저장 중…" onClick={() => { pick(choice); }}>메모 저장</BusyButton>
          )}
        </div>
      )}
      {diff && locked && review.memo && <p className="fhint" style={{ margin: '8px 0 0' }}>조정 메모: {review.memo}</p>}
      {ops.length > 0 && (
        <div className="rv-ops"><span className="muted">반영될 변경</span>{ops.map((o, i) => <span key={String(i)} className="opchip">{opText(o, null)}</span>)}</div>
      )}
      {choose.conflictModal}
    </div>
  );
}
