/**
 * 검증 상세의 Evidence 목록과 체크리스트 연결 토글(UI-07-01A, P L1934–1945·6347).
 *
 * 저장: PATCH /api/tasks/:taskKey/checklist/:itemKey `{ updatedAt, evidence: <Evidence id> | null }`.
 * - 편집 대상은 화면 위치가 아니라 안정 키(체크리스트 itemKey + Evidence id)로 정한다.
 * - 요청 내용은 「토글」이 아니라 「이 항목의 evidence를 이 값으로」라는 절대값이다.
 *   왜: 재시도·다시 적용 때 같은 요청이 두 번 가도 결과가 같다(두 번 토글되어 원래대로 돌아가지 않는다).
 * - 공통 흐름(useSave): 처리 중 버튼 잠금, 500·끊김은 같은 멱등 키로 다시 시도, 409 VERSION_CONFLICT는 충돌 창.
 * - 결과를 모르는 변경(저장 실패)이 남아 있으면 「저장하지 않은 연결 변경」으로 보고 편집 보호(useEditGuard)와
 *   세션 만료 초안(useSessionDraft)으로 지킨다. 성공·최신 불러오기·버리기에서만 지운다.
 *
 * Evidence 추가(UAT-VERIFY-02, P L1945·6246–6252): POST /api/verifications/:id/evidence `{ path }`(서버 후속 2차 계약).
 * - 빈 경로(공백만 포함)는 버튼을 막는다. 같은 검증에 이미 있는 경로는 보내지 않고 안내한다. 서버도 둘 다 400으로 거부한다.
 * - 서버가 거부하면(400 VALIDATION_FAILED) 서버가 준 사유(details.reasons)를 입력 칸 아래에 보이고 입력은 그대로 둔다.
 * - 입력 중인 경로는 초안이다: 편집 보호와 세션 만료 초안으로 지킨다. 성공하면 같은 내용일 때만 비운다.
 * - 경로는 참조일 뿐이다. 서버가 그 파일을 읽지 않으므로 지문·크기가 없고 「원본 내려받기」도 없다.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { apiUrl } from '../../shared/api/client.ts';
import type { ResponseOf } from '../../shared/api/contract.ts';
import { apiKey } from '../../shared/api/queries.ts';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { evidenceKind, evidenceName, type EvidenceItem } from './model.ts';
import { ApiError } from '../../shared/api/client.ts';

type TaskDetail = ResponseOf<'getTask'>;
/** 저장할 연결 변경 하나. evidence가 null이면 연결 해제 */
export interface LinkChange { taskKey: string; itemKey: string; evidence: string | null; label: string }

/** Evidence와 체크리스트 항목이 연결됐는가. 체크리스트 값은 Evidence id 또는 경로다(서버 listEvidence 판정과 같음). */
export const isLinked = (value: string | null, e: Pick<EvidenceItem, 'id' | 'path'>) => value !== null && (value === e.id || (!!e.path && value === e.path));

export function EvidenceLinks({ task, verificationId, evidence }: { task: TaskDetail; verificationId: string; evidence: EvidenceItem[] }) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<LinkChange | null>(null);
  const pendingRef = useRef<LinkChange | null>(null);
  const taskRef = useRef(task);
  useEffect(() => { taskRef.current = task; }, [task]);
  const keep = (change: LinkChange | null) => { pendingRef.current = change; setPending(change); };

  const applyTask = (next: TaskDetail) => {
    queryClient.setQueryData(apiKey('getTask', { params: { taskKey: next.taskKey } }), next);
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'allPages' && q.queryKey[1] === 'listEvidence' });
  };
  const send = (change: LinkChange, updatedAt: string, signal?: AbortSignal) => client.call('updateChecklistItem', {
    params: { taskKey: change.taskKey, itemKey: change.itemKey },
    body: { updatedAt, evidence: change.evidence },
    ...(signal ? { signal } : {}),
  });
  const reload = async (signal?: AbortSignal) => {
    const latest = await client.call('getTask', { params: { taskKey: taskRef.current.taskKey }, ...(signal ? { signal } : {}) });
    if (signal?.aborted) return null;
    queryClient.setQueryData(apiKey('getTask', { params: { taskKey: latest.taskKey } }), latest);
    return latest;
  };

  const { save, busy, conflictModal } = useSave<ResponseOf<'updateChecklistItem'>, { change: LinkChange; updatedAt: string }>({
    target: `${task.taskKey} 체크리스트 Evidence 연결 저장`,
    mine: pending ? pending.label : 'Evidence 연결 변경',
    request: () => ({ change: pendingRef.current as LinkChange, updatedAt: taskRef.current.updatedAt }),
    run: ({ payload }) => send(payload.change, payload.updatedAt),
    onSuccess: (result, payload) => {
      applyTask(result.task);
      // 성공한 변경과 지금 남은 변경이 같을 때만 지운다(그 사이 다른 항목을 눌렀으면 남긴다).
      if (JSON.stringify(pendingRef.current) === JSON.stringify(payload.change)) keep(null);
    },
    successNotice: 'Evidence 연결을 저장했습니다.',
    onConflictReload: async ({ signal }) => {
      const latest = await reload(signal);
      if (latest) keep(null);
    },
    onConflictReapply: async () => {
      const change = pendingRef.current;
      const latest = await reload();
      if (!change || !latest) return;
      applyTask((await send(change, latest.updatedAt)).task);
      keep(null);
    },
  });

  // ---- Evidence 추가 ----
  const [addPath, setAddPath] = useState('');
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const addRef = useRef('');
  useEffect(() => { addRef.current = addPath; }, [addPath]);
  const added = useSave<ResponseOf<'addVerificationEvidence'>, { path: string }>({
    target: 'Evidence 경로 추가',
    request: () => ({ path: addRef.current.trim() }),
    run: async ({ payload, idempotencyKey }) => {
      try {
        return await client.call('addVerificationEvidence', { params: { id: verificationId }, body: payload, idempotencyKey });
      } catch (error) {
        // 서버 거부 사유(빈 경로·형식·중복)는 입력 칸 아래에 그대로 보인다.
        const reasons = error instanceof ApiError ? (error.body?.error.details as { reasons?: unknown } | undefined)?.reasons : undefined;
        if (error instanceof ApiError && error.kind === 'validation') setAddProblem(Array.isArray(reasons) && reasons.length ? reasons.map(String).join(' ') : error.message);
        throw error;
      }
    },
    onSuccess: (_result, payload) => {
      setAddProblem(null);
      setAddPath((cur) => (cur.trim() === payload.path ? '' : cur));
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'allPages' && q.queryKey[1] === 'listEvidence' });
    },
    successNotice: 'Evidence를 추가했습니다.',
  });
  const submitAdd = () => {
    const path = addPath.trim();
    if (!path) return;
    if (evidence.some((e) => e.path === path)) { setAddProblem('이미 이 검증에 연결된 Evidence 경로입니다.'); return; }
    setAddProblem(null);
    void added.save();
  };

  // 한 화면에 편집 보호(useBlocker)는 하나만 둘 수 있어 두 초안을 합쳐 판단한다.
  const dirty = pending !== null || addPath.trim() !== '';
  useEditGuard(dirty);
  const { restoreOffer: addRestore } = useSessionDraft<{ path: string }>({
    id: `verify:evidence-add:${verificationId}`,
    label: 'Evidence 경로 입력',
    value: addPath.trim() ? { path: addPath } : null,
    onRestore: (data) => { setAddPath(data.path); },
  });
  const { restoreOffer } = useSessionDraft<LinkChange>({
    id: `verify:evidence-link:${task.taskKey}`,
    label: `${task.taskKey} Evidence 연결 변경`,
    value: pending,
    onRestore: (data) => { keep(data); },
  });

  const toggle = (itemKey: string, content: string, current: string | null, e: EvidenceItem) => {
    const linking = !isLinked(current, e);
    keep({ taskKey: task.taskKey, itemKey, evidence: linking ? e.id : null, label: `${itemKey} ${linking ? '←' : '연결 해제'} ${evidenceName(e)} (${content})` });
    void save();
  };

  const items = task.checklistItems;
  return (
    <>
      {restoreOffer}
      {addRestore}
      {pending && !busy && (
        <div className="banner warn" role="status">
          <div className="banner-b">
            <b>저장하지 않은 연결 변경</b> — {pending.label}{' '}
            <BusyButton busy={busy} busyLabel="저장 중…" small variant="default" onClick={() => { void save(); }}>다시 저장</BusyButton>{' '}
            <button type="button" className="btn ghost sm" onClick={() => { keep(null); }}>변경 버리기</button>
          </div>
        </div>
      )}
      {evidence.length === 0 && <p className="empty">연결된 Evidence가 없습니다. Runner가 이 검증 결과와 함께 Evidence를 올리거나, 아래에서 경로를 추가하면 여기에 표시됩니다.</p>}
      {evidence.map((e) => (
        <div key={e.id} className="evrow">
          <span className="tag">{evidenceKind(e)}</span>
          <span className="mono evp">{evidenceName(e)}</span>
          {e.sha256 && <a className="btn ghost sm" href={apiUrl('getEvidenceContent', { params: { id: e.id } })} download>원본 내려받기</a>}
          <span className="sp" />
          {items.length > 0 && <span className="muted">체크리스트</span>}
          {items.length > 0 && (
            <div className="seg" role="group" aria-label={`${evidenceName(e)} 체크리스트 연결`}>
              {items.map((c) => {
                const on = isLinked(c.evidence, e);
                return (
                  <button
                    key={c.itemKey}
                    type="button"
                    className="mono"
                    aria-pressed={on}
                    disabled={busy}
                    title={`${c.content}${on ? ' — 연결됨 (클릭 시 해제)' : ' — 클릭 시 이 Evidence 연결'}`}
                    onClick={() => { toggle(c.itemKey, c.content, c.evidence, e); }}
                  >{c.itemKey}</button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {items.length === 0 && <p className="fhint">이 Task에는 체크리스트가 없어 Evidence를 항목에 연결할 수 없습니다.</p>}
      <div className="addbox-r" style={{ marginTop: 10 }}>
        <label className="sr" htmlFor={`ev-add-${verificationId}`}>Evidence 경로</label>
        <input
          id={`ev-add-${verificationId}`} className="inp mono-in" style={{ flex: 1, minWidth: 260 }}
          placeholder="evidence/TASK-0000/... 파일 경로 또는 링크" value={addPath}
          aria-invalid={addProblem !== null || undefined} aria-describedby={addProblem ? `ev-add-err-${verificationId}` : undefined}
          onChange={(ev) => { setAddPath(ev.target.value); setAddProblem(null); }}
          onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submitAdd(); } }}
        />
        <BusyButton busy={added.busy} busyLabel="추가 중…" small variant="default" disabled={!addPath.trim()} onClick={submitAdd}>Evidence 추가</BusyButton>
      </div>
      {addProblem && <p id={`ev-add-err-${verificationId}`} className="fhint" role="alert" style={{ color: 'var(--dg)' }}>{addProblem}</p>}
      {conflictModal}
      {added.conflictModal}
    </>
  );
}
