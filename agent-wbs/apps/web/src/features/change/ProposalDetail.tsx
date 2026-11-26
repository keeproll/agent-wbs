/**
 * CP 상세·승인·반영(UI-09A). 원본 P L1697–1741.
 *
 * 저장(상태 바꾸기) 규칙 — 모두 공통 useSave를 쓴다(shared/README §3):
 * - 요청 내용(updatedAt·의견·previewHash)은 버튼을 누른 순간 찍고, 재시도는 같은 내용·같은 멱등 키로 보낸다.
 * - 성공해도 그 사이 의견을 더 고쳤으면 의견을 지우지 않는다(onSuccess에서 payload와 비교).
 * - 409 VERSION_CONFLICT는 충돌 창, 보류(SPLIT_JUDGEMENT_REQUIRED·ORDER_NOT_PRESERVED·ACTIVE_TASK_BLOCKED)·상태 불일치는
 *   오류 막대 + 최신 다시 읽기(보류 사유가 새 미리보기로 화면에 보인다).
 * - 의견은 세션이 끊겨도 useSessionDraft로 보관했다가 다시 로그인하면 복원을 제안한다.
 */
import { Link } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { staleTargetError } from '../../shared/api/client.ts';
import { useApiQuery } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import { useRefreshError } from '../../shared/layout/MenuScreen.tsx';
import { useSave } from '../../shared/state/useSave.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { useConfirm, useNotice } from '../../shared/ui/feedback.tsx';
import { AreaLoading } from '../../shared/ui/loading.tsx';
import { useRef, useState } from 'react';
import { useProposalRefresh } from './ChangePage.tsx';
import { getProposalOrNull } from './find.ts';
import { cpStatus, diffRows, eventLabel, holdReasonText, impactRows, judgementRows, sourceLabel, type TaskInfo } from './model.ts';
import type { Proposal, ProposalPreview } from './types.ts';
import { LINK } from '../../shared/links.ts';

/**
 * 원본 diffGrid(P L7064)는 `100px 230px 148px minmax(150px,1fr) minmax(150px,1fr) 64px`.
 * 1920에서는 같은 폭이 되고, 1280에서 표가 상세 칸(약 740px)을 넘지 않도록 대상 Task 열과 마지막 빈 열만 줄어들 수 있게 했다(D-28).
 * 마지막 열은 원본의 「제외」 버튼 자리다(계약에 항목 제외 API가 없어 버튼은 없다).
 */
export const DIFF_GRID = { gridTemplateColumns: '100px minmax(150px,230px) 148px minmax(150px,1fr) minmax(150px,1fr) minmax(0,64px)' };
export const IMP_GRID = { gridTemplateColumns: '110px minmax(160px,1fr) 120px minmax(220px,1.4fr)' };
const JUDGE_GRID = { gridTemplateColumns: '110px minmax(120px,170px) 70px 120px minmax(200px,1fr) minmax(110px,130px)' };

/** 원본 배너(P L5997) + 원본에 없는 보류(held) */
const BANNER: Record<string, [string, string]> = {
  review: ['warn', '승인 대기 — 승인 후 「WBS 반영」을 실행하기 전까지 실제 WBS에는 반영되지 않습니다.'],
  changes: ['warn', '수정 요청됨 — 항목을 조정한 뒤 재제출하세요. WBS에는 반영되지 않았습니다.'],
  approved: ['info', '승인됨 — 「WBS 반영」을 실행하면 아래 변경이 WBS에 적용되고 각 Task 이력에 기록됩니다.'],
  rejected: ['danger', '반려됨 — WBS에 반영되지 않았습니다.'],
  applied: ['ok', 'WBS 반영 완료 — 완료 Task와 기존 검증 결과는 변경하지 않았습니다.'],
  draft: ['info', '작성 중 — 제출하면 승인 대기 상태가 됩니다. 승인과 「WBS 반영」 전까지 WBS는 바뀌지 않습니다.'],
  held: ['danger', '보류 — 반영할 수 없는 사유가 있어 WBS에 반영하지 않았습니다. 아래 사유를 확인하세요.'],
};

interface Payload { updatedAt: string; comment: string; previewHash: string }
type ActionId = 'submitProposal' | 'rejectProposal' | 'requestChangesProposal' | 'approveProposal' | 'applyProposal';
const ACTION_NAME: Record<ActionId, string> = {
  submitProposal: '제출', rejectProposal: '반려', requestChangesProposal: '수정 요청', approveProposal: '승인', applyProposal: 'WBS 반영',
};

export function ProposalDetail({ cp, tasks, planningLabel, comment, setComment }: {
  cp: Proposal;
  tasks: ReadonlyMap<string, TaskInfo> | null;
  /** 출처 Planning 표시(「Planning PLN-001」). 모르면 undefined */
  planningLabel: string | undefined;
  comment: string;
  setComment: (value: string) => void;
}) {
  const status = String(cp.status);
  const closed = status === 'applied' || status === 'rejected';
  const preview = useApiQuery('previewProposal', { params: { id: cp.id } }, { topics: ['proposal', 'task', 'dependency'], enabled: !closed, keepPrevious: false });
  useRefreshError(preview, `${cp.cpKey} 미리보기 최신 내용 불러오기`);
  const [err, setErr] = useState('');
  const { restoreOffer } = useSessionDraft({
    id: `cp:${cp.id}:comment`,
    label: `${cp.cpKey} 승인 의견`,
    value: comment.trim() ? { comment } : null,
    onRestore: (data: { comment: string }) => { setComment(data.comment); },
  });

  const taskMap = tasks ?? new Map<string, TaskInfo>();
  const p = preview.data;
  const idMap = status === 'applied' ? cp.idMap : (p?.idMap ?? cp.idMap);
  const diff = diffRows(cp.ops, idMap, taskMap, p?.diff ?? []);
  const issues = closed ? cp.issues : (p?.issues ?? []);
  const holds = closed ? cp.holdReasons : (p?.holdReasons ?? cp.holdReasons);
  const impact = closed ? [] : impactRows(cp.ops, idMap, taskMap, p?.impact ?? null);
  const judged = judgementRows(cp);
  const st = cpStatus(cp.status);
  const banner = BANNER[status] ?? ['info', st.l];
  const author = cp.events[0]?.actor ?? '';
  const noOps = cp.ops.length === 0;
  const exclude = useExclude(cp);

  return (
    <div className="card cp-detail">
      {restoreOffer}
      <div className="pane-h" style={{ margin: 0 }}>
        <div>
          <span className="mono muted">{cp.cpKey}</span>
          <h2 className="h2">{cp.title}</h2>
          <span className="muted">작성 {author} · {formatDateTime(cp.createdAt)}</span>
        </div>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {String(cp.source.kind) === 'planning' && cp.source.id && (
            <Link className="btn sm" to={LINK.planning(cp.source.id)}>출처: {sourceLabel(cp.source, planningLabel)}</Link>
          )}
          {!['manual', 'planning'].includes(String(cp.source.kind)) && <span className="muted">출처: {sourceLabel(cp.source)}</span>}
          <span className={st.c}>{st.l}</span>
        </span>
      </div>
      <div className={`banner ${banner[0]}`}><div className="banner-b">{banner[1]}</div></div>
      <div className="sec" style={{ marginTop: 14 }}><h3 className="h4">변경 사유</h3><p>{cp.reason}</p></div>
      <div className="sec">
        <h3 className="h4">변경 전 / 후 비교</h3>
        {noOps && <p className="empty">변경 항목이 없습니다.</p>}
        <div className="gtb" role="region" aria-label="변경 전 / 후 비교" tabIndex={0}>
          <div className="gtr h" style={DIFF_GRID}><span className="gc">구분</span><span className="gc">대상 Task</span><span className="gc">항목</span><span className="gc">변경 전</span><span className="gc">변경 후</span><span className="gc" /></div>
          {diff.map((r, i) => (
            // 서버가 준 ops 순서 그대로다(읽기 전용). 편집하지 않으므로 순번을 key로 쓴다.
            <div key={`${String(i)}-${r.kindL}-${r.target}`} className="gtr" style={DIFF_GRID}>
              <span className="gc"><span className={r.kindC}>{r.kindL}</span></span>
              <span className="gc">{r.canOpen ? <Link className="reflink" to={`/wbs/${r.target}`}>{r.target}</Link> : <span className="mono">{r.target}</span>} <span className="muted">{r.tTitle}</span></span>
              <span className="gc">{r.field}</span>
              <span className="gc dbef">{r.before}</span>
              <span className="gc daft">{r.after}</span>
              <span className="gc">
                {status === 'changes' && (
                  // 원본의 「제외」(P L1707). 서버 후속 2차의 POST /api/proposals/:id/exclude(excludeProposalOp)에 연결했다(M3 통합).
                  <BusyButton small variant="ghost" busy={exclude.busyIndex === i} busyLabel="제외 중…" disabled={exclude.busyIndex !== null} aria-label={`${r.target} ${r.field} 제외`} onClick={() => { exclude.run(i); }}>제외</BusyButton>
                )}
              </span>
            </div>
          ))}
        </div>
        {status === 'changes' && (
          <p className="fhint" style={{ margin: '-8px 0 0' }}>
            받아들이지 않을 항목은 「제외」로 빼고 재제출합니다. 모든 항목을 빼면 재제출할 수 없으니 새 변경 제안을 작성하세요.
          </p>
        )}
        {exclude.conflictModal}
      </div>
      {!closed && preview.isPending && <AreaLoading label="영향 분석 불러오는 중" />}
      {issues.length > 0 && (
        <div className="banner danger" role="region" aria-label="반영할 수 없는 문제">
          <div className="banner-b">
            <b>{closed || status === 'held' ? '반영할 수 없었습니다' : '반영할 수 없는 문제가 있습니다'}</b> — 아래 문제를 해결해야 합니다. 승인하더라도 「WBS 반영」 때 다시 판정해 보류합니다.
            <ul className="lst" style={{ margin: '4px 0 0', color: 'inherit' }}>{issues.map((i, n) => <li key={`${String(n)}-${i.code}`}>{i.taskKey ? `${i.taskKey} · ` : ''}{i.message} ({i.code})</li>)}</ul>
          </div>
        </div>
      )}
      {holds.length > 0 && (
        <div className="banner warn" role="region" aria-label="보류 사유">
          <div className="banner-b">
            <b>보류 사유</b> — 승인·반영할 수 없습니다. Planning이 판단을 다시 기록하거나 원인이 풀리면 다시 판정합니다(강제 진행 없음).
            <ul className="lst" style={{ margin: '4px 0 0', color: 'inherit' }}>{holds.map((h, n) => <li key={`${String(n)}-${String(h.code)}`}>{holdReasonText(h)}</li>)}</ul>
          </div>
        </div>
      )}
      {judged.length > 0 && (
        <div className="sec">
          <h3 className="h4">판단 결과 <span className="muted" style={{ fontWeight: 400 }}>Planning(Codex · Claude)이 기록한 분할 규칙 판단</span></h3>
          <div className="gtb" role="region" aria-label="판단 결과" tabIndex={0}>
            <div className="gtr h" style={JUDGE_GRID}><span className="gc">대상</span><span className="gc">규칙</span><span className="gc">결과</span><span className="gc">합의</span><span className="gc">근거</span><span className="gc">판단 시각</span></div>
            {judged.map((j) => (
              <div key={`${j.target}-${j.rule}`} className="gtr" style={JUDGE_GRID}>
                <span className="gc mono">{j.target}</span><span className="gc">{j.rule}</span>
                <span className="gc"><span className={j.met ? 'sc sc-ok' : 'sc sc-bad'}>{j.result}</span></span>
                <span className="gc">{j.agreedBy}</span><span className="gc">{j.basis}</span><span className="gc mono">{formatDateTime(j.judgedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!closed && !noOps && (
        <div className="sec">
          <h3 className="h4">영향 분석 <span className="muted" style={{ fontWeight: 400 }}>반영 시 영향받는 Task — 차단 변화와 후속 Task 포함</span></h3>
          <div className="gtb" role="region" aria-label="영향 분석" tabIndex={0}>
            <div className="gtr h" style={IMP_GRID}><span className="gc">Task</span><span className="gc">제목</span><span className="gc">현재 상태</span><span className="gc">영향</span></div>
            {impact.map((im) => (
              <div key={im.id} className="gtr" style={IMP_GRID} data-unblocked={im.unblocked === null ? undefined : String(im.unblocked)}>
                <span className="gc">{im.canOpen ? <Link className="reflink" to={`/wbs/${im.id}`}>{im.id}</Link> : <><span className="mono">{im.id}</span> <span className="tag new">신규</span></>}</span>
                <span className="gc">{im.title}</span>
                <span className="gc"><span className={`st ${im.stC}`}><span className="st-d" aria-hidden="true" />{im.stL}</span></span>
                <span className="gc">{im.notes}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <Actions cp={cp} preview={p} issues={issues.length} holds={holds.length} comment={comment} setComment={setComment} err={err} setErr={setErr} />
      <div className="sec">
        <h3 className="h4">승인 이력</h3>
        <ul className="tl">
          {[...cp.events].reverse().map((e, n) => (
            <li key={`${e.at}-${String(n)}`}><span className="mono muted">{formatDateTime(e.at)}</span> <b>{e.actor}</b> <span className="tag">{eventLabel(e.action)}</span>{e.comment && <span className="muted"> — {e.comment}</span>}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Actions({ cp, preview, issues, holds, comment, setComment, err, setErr }: {
  cp: Proposal; preview: ProposalPreview | undefined; issues: number; holds: number;
  comment: string; setComment: (v: string) => void; err: string; setErr: (v: string) => void;
}) {
  const { client } = useApi();
  const refresh = useProposalRefresh();
  const confirm = useConfirm();
  const notify = useNotice();
  const status = String(cp.status);

  /** 충돌 뒤 다시 적용: 서버에서 이 CP와 미리보기를 새로 읽는다(캐시를 쓰지 않는다). */
  const latest = async (signal: AbortSignal) => {
    const fresh = await getProposalOrNull(client, cp.id, signal);
    if (!fresh) throw staleTargetError(`${cp.cpKey}를 다시 찾지 못했습니다.`, '삭제됐을 수 있습니다. 변경 제안 목록을 다시 확인하세요.', `${cp.cpKey} 다시 읽기`);
    const hash = ['applied', 'rejected'].includes(String(fresh.status)) ? '' : (await client.call('previewProposal', { params: { id: cp.id }, signal })).previewHash;
    return { updatedAt: fresh.updatedAt, previewHash: hash };
  };
  const call = (id: ActionId, payload: Payload, idempotencyKey: string) => {
    const params = { id: cp.id };
    // M3 통합: 계약의 submit·reject·request-changes는 `.map` 한 정의라 TS 타입이 「comment 필수」로 합쳐진다.
    // 실제 계약(openapi)은 submit만 comment 선택, reject·request-changes는 필수다. 화면은 필수일 때 빈 의견을 막으므로(아래 사유 검사) 보내는 값은 그대로 두고 타입만 맞춘다.
    const base = { updatedAt: payload.updatedAt, ...(payload.comment.trim() ? { comment: payload.comment.trim() } : {}) } as { updatedAt: string; comment: string };
    if (id === 'approveProposal') return client.call(id, { params, idempotencyKey, body: { ...base, previewHash: payload.previewHash } });
    if (id === 'applyProposal') return client.call(id, { params, idempotencyKey, body: { ...base, previewHash: payload.previewHash } });
    return client.call(id, { params, idempotencyKey, body: base });
  };
  const useAction = (id: ActionId, notice: (result: unknown) => string) => useSave<unknown, Payload>({
    target: `${cp.cpKey} ${ACTION_NAME[id]}`,
    failTitle: `${ACTION_NAME[id]}하지 못했습니다`,
    mine: `${ACTION_NAME[id]}${comment.trim() ? ` — 의견: ${comment.trim()}` : ''}`,
    request: () => ({ updatedAt: cp.updatedAt, comment, previewHash: preview?.previewHash ?? '' }),
    run: ({ payload, idempotencyKey }) => call(id, payload, idempotencyKey),
    onSuccess: (result, payload) => {
      // 그 사이 의견을 더 고쳤으면 지우지 않는다.
      if (comment === payload.comment) setComment('');
      setErr('');
      void refresh();
      notify(notice(result));
    },
    // 최신을 서버에서 새로 읽은 뒤에만 의견을 버린다. 창을 닫아 취소됐으면(signal) 화면을 바꾸지 않는다(M3-01 79c2cc1).
    onConflictReload: async ({ signal }) => {
      await latest(signal);
      if (signal.aborted) return;
      setComment('');
      await refresh();
    },
    // 「다시 적용」: 공통 reapplyRequest(M3-04). 최신 버전·미리보기 해시로 같은 의견을 만든다. 보내기·성공 처리는 위 run·onSuccess가 한다.
    reapplyRequest: async ({ signal }) => ({ ...(await latest(signal)), comment }),
    // 보류·상태 불일치: 최신 미리보기를 다시 읽어 사유를 화면에 보인다.
    onRejected: () => { void refresh(); },
  });
  const approve = useAction('approveProposal', () => `${cp.cpKey} 승인 처리했습니다. 「WBS 반영」을 실행하기 전까지 WBS는 바뀌지 않습니다.`);
  const reject = useAction('rejectProposal', () => `${cp.cpKey} 반려 처리했습니다.`);
  const changes = useAction('requestChangesProposal', () => `${cp.cpKey} 수정 요청 처리했습니다.`);
  const submit = useAction('submitProposal', () => `${cp.cpKey} 제출했습니다. 승인 전에는 WBS에 반영되지 않습니다.`);
  const apply = useAction('applyProposal', (r) => {
    const st = String((r as { proposal?: Proposal } | undefined)?.proposal?.status ?? '');
    return st === 'held'
      ? `${cp.cpKey} 반영 보류 — 변경 항목에 문제가 있습니다.`
      : `${cp.cpKey}를 WBS에 반영했습니다. 영향받은 Task의 이력과 차단 여부가 갱신되었습니다.`;
  });

  /** 반려·수정 요청은 의견 필수(원본 cpAct P L5727). 비어 있으면 보내지 않는다. */
  const needComment = (action: '반려' | '수정 요청', go: () => Promise<boolean>) => {
    if (!comment.trim()) { setErr(`${action} 사유를 입력하세요.`); return; }
    setErr('');
    void go();
  };
  const busy = approve.busy || reject.busy || changes.busy || submit.busy || apply.busy;
  const noPreview = !preview;
  const modals = <>{approve.conflictModal}{reject.conflictModal}{changes.conflictModal}{submit.conflictModal}{apply.conflictModal}</>;

  if (status === 'review') {
    return (
      <div className="apbox">
        <h3 className="h4">팀장 승인</h3>
        <label className="sr" htmlFor={`cp-com-${cp.id}`}>승인 의견</label>
        <textarea id={`cp-com-${cp.id}`} rows={2} className="inp" placeholder="의견 — 반려 · 수정 요청 시 필수" value={comment}
          aria-invalid={err ? true : undefined} aria-describedby={err ? `cp-err-${cp.id}` : undefined}
          onChange={(e) => { setComment(e.target.value); setErr(''); }} />
        {err && <span className="ferr" id={`cp-err-${cp.id}`} role="alert">{err}</span>}
        <div className="form-acts" style={{ border: 0, paddingTop: 8 }}>
          <BusyButton variant="default" busy={changes.busy} busyLabel="수정 요청 중…" disabled={busy} onClick={() => { needComment('수정 요청', changes.save); }}>수정 요청</BusyButton>
          <BusyButton variant="default" busy={reject.busy} busyLabel="반려 중…" disabled={busy} onClick={() => { needComment('반려', reject.save); }}>반려</BusyButton>
          <BusyButton busy={approve.busy} busyLabel="승인 중…" disabled={busy || noPreview || holds > 0 || cp.ops.length === 0} onClick={() => { void approve.save(); }}>승인</BusyButton>
        </div>
        {modals}
      </div>
    );
  }
  if (status === 'draft' || status === 'changes' || status === 'held') {
    const label = status === 'draft' ? '제출 — 승인 요청' : '재제출';
    return (
      <div className="apbox">
        <h3 className="h4">{status === 'draft' ? '제출' : '수정 후 재제출'}</h3>
        <p className="fhint" style={{ margin: '0 0 8px' }}>
          {status === 'draft'
            ? '제출하면 승인 대기 상태가 됩니다. 팀장 승인과 「WBS 반영」 전까지 공식 Task 명세와 WBS는 바뀌지 않습니다.'
            : '재제출하면 다시 승인 대기 상태가 됩니다. 변경 항목에 문제가 있으면 재제출할 수 없습니다.'}
        </p>
        <div className="form-acts" style={{ border: 0, paddingTop: 0 }}>
          <BusyButton busy={submit.busy} busyLabel="제출 중…" disabled={busy || noPreview || issues > 0 || cp.ops.length === 0} onClick={() => { void submit.save(); }}>{label}</BusyButton>
        </div>
        {modals}
      </div>
    );
  }
  if (status === 'approved') {
    return (
      <div className="apbox">
        <h3 className="h4">Replanning — WBS 반영</h3>
        <p className="fhint" style={{ margin: '0 0 8px' }}>승인된 변경을 실제 WBS에 적용합니다. 완료 Task와 기존 검증 결과는 변경하지 않습니다.</p>
        <div className="form-acts" style={{ border: 0, paddingTop: 0 }}>
          <BusyButton busy={apply.busy} busyLabel="반영 중…" disabled={busy || noPreview || holds > 0} onClick={() => {
            void confirm({
              title: 'WBS 반영',
              body: `${cp.cpKey}의 변경 ${String(cp.ops.length)}건을 WBS에 반영합니다. 신규 Task에는 ID가 부여되고, 각 Task 이력에 재계획으로 기록됩니다.`,
              ok: 'WBS 반영',
            }).then((ok) => { if (ok) void apply.save(); });
          }}>WBS 반영</BusyButton>
        </div>
        {modals}
      </div>
    );
  }
  return modals;
}

/**
 * 「제외」(수정 요청 중인 CP의 변경 항목 하나 빼기, excludeProposalOp). 공통 useSave 규칙을 쓴다.
 * - 보내는 값: 화면이 본 CP 버전(updatedAt)과 항목 순번(index).
 * - 충돌(409)의 「다시 적용」: 최신 CP를 읽어 **같은 내용의 항목**을 다시 찾아 그 순번으로 보낸다.
 *   왜 순번을 그대로 쓰지 않나: 그 사이 다른 항목이 빠졌으면 같은 순번이 다른 항목을 가리킨다. 같은 항목이 없으면 이유를 보이고 보내지 않는다.
 */
function useExclude(cp: Proposal) {
  const { client } = useApi();
  const notify = useNotice();
  const refresh = useProposalRefresh();
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const picked = useRef<number | null>(null);
  const sameOp = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const { save, conflictModal } = useSave<Proposal, { updatedAt: string; index: number }>({
    target: `${cp.cpKey} 항목 제외`,
    failTitle: '제외하지 못했습니다',
    mine: '변경 항목 제외',
    request: () => ({ updatedAt: cp.updatedAt, index: picked.current ?? 0 }),
    run: ({ payload, idempotencyKey }) => client.call('excludeProposalOp', { params: { id: cp.id }, body: payload, idempotencyKey }),
    onSuccess: () => { notify(`${cp.cpKey}에서 항목을 제외했습니다. 확인한 뒤 재제출하세요.`); void refresh(); },
    onRejected: () => { void refresh(); },
    onConflictReload: async ({ signal }) => { await client.call('getProposal', { params: { id: cp.id }, signal }); if (!signal.aborted) await refresh(); },
    reapplyRequest: async ({ signal }) => {
      const latest = await client.call('getProposal', { params: { id: cp.id }, signal });
      const op = cp.ops[picked.current ?? -1];
      const index = latest.ops.findIndex((o) => sameOp(o, op));
      if (index < 0) throw staleTargetError('제외하려던 항목이 최신 변경 제안에 없습니다.', '다른 곳에서 먼저 제외했거나 바뀌었습니다. 「최신 내용 불러오기」로 지금 항목을 확인하세요.', `${cp.cpKey} 항목 제외`);
      return { updatedAt: latest.updatedAt, index };
    },
  });
  const run = (index: number) => {
    picked.current = index;
    setBusyIndex(index);
    void save().finally(() => { setBusyIndex(null); });
  };
  return { run, busyIndex, conflictModal };
}
