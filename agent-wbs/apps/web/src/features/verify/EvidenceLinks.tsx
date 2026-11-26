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
 * Evidence 추가(경로 입력) 자리: 팀장용 Evidence 추가 API가 계약에 없어 비워 둔다(가짜 버튼 금지, 조정자 결정). 계약이 생기면 이 목록 아래에 붙인다.
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
import { evidenceName, type EvidenceItem } from './model.ts';

type TaskDetail = ResponseOf<'getTask'>;
/** 저장할 연결 변경 하나. evidence가 null이면 연결 해제 */
export interface LinkChange { taskKey: string; itemKey: string; evidence: string | null; label: string }

export function EvidenceLinks({ task, evidence }: { task: TaskDetail; evidence: EvidenceItem[] }) {
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

  const dirty = pending !== null;
  useEditGuard(dirty);
  const { restoreOffer } = useSessionDraft<LinkChange>({
    id: `verify:evidence-link:${task.taskKey}`,
    label: `${task.taskKey} Evidence 연결 변경`,
    value: pending,
    onRestore: (data) => { keep(data); },
  });

  const toggle = (itemKey: string, content: string, current: string | null, e: EvidenceItem) => {
    const linking = current !== e.id;
    keep({ taskKey: task.taskKey, itemKey, evidence: linking ? e.id : null, label: `${itemKey} ${linking ? '←' : '연결 해제'} ${evidenceName(e)} (${content})` });
    void save();
  };

  const items = task.checklistItems;
  return (
    <>
      {restoreOffer}
      {pending && !busy && (
        <div className="banner warn" role="status">
          <div className="banner-b">
            <b>저장하지 않은 연결 변경</b> — {pending.label}{' '}
            <BusyButton busy={busy} busyLabel="저장 중…" small variant="default" onClick={() => { void save(); }}>다시 저장</BusyButton>{' '}
            <button type="button" className="btn ghost sm" onClick={() => { keep(null); }}>변경 버리기</button>
          </div>
        </div>
      )}
      {evidence.length === 0 && <p className="empty">연결된 Evidence가 없습니다. Runner가 이 검증 결과와 함께 Evidence를 올리면 여기에 표시됩니다.</p>}
      {evidence.map((e) => (
        <div key={e.id} className="evrow">
          <span className="tag">{e.kind}</span>
          <span className="mono evp">{evidenceName(e)}</span>
          <a className="btn ghost sm" href={apiUrl('getEvidenceContent', { params: { id: e.id } })} download>원본 내려받기</a>
          <span className="sp" />
          {items.length > 0 && <span className="muted">체크리스트</span>}
          {items.length > 0 && (
            <div className="seg" role="group" aria-label={`${evidenceName(e)} 체크리스트 연결`}>
              {items.map((c) => {
                const on = c.evidence === e.id;
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
      {conflictModal}
    </>
  );
}
