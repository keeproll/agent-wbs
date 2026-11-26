/**
 * 재작업 지시(UI-06C, P L1801–1809). 자동 재작업 한도를 넘었을 때만 연다(contracts §3.5 「팀장 버튼은 1회만」).
 * 지시는 「수정 요청」 메시지로 기록하고 전송한 뒤, 재작업 실행을 요청한다.
 *
 * 공통 규칙(shared/README §3·§5·§6):
 * - useSave: 실패해도 입력 유지, 다시 시도는 같은 멱등 키, 409 충돌은 충돌 창.
 * - useSessionDraft: 세션 만료로 끊겨도 다시 로그인하면 복원 제안. 대상은 taskKey(안정 키).
 * - useEditGuard: 쓰던 지시가 있으면 다른 Task·메뉴로 가기 전에 묻는다.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { invalidateTopics } from '../../shared/api/queries.ts';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import type { Agent } from './messageDrafts.ts';
import { createAndSend } from './sendMessage.ts';
import { EXEC_TOPICS } from './useTaskCommand.tsx';

export interface ReworkEditorProps {
  projectId: string;
  taskKey: string;
  agent: Agent;
  /** 실패한 검증이 연결된 시도 id(지시를 그 시도에 연결한다) */
  attemptId: string | null;
  updatedAt: string;
  onClose: () => void;
}

interface Payload { body: string; updatedAt: string }

export function ReworkEditor({ projectId, taskKey, agent, attemptId, updatedAt, onClose }: ReworkEditorProps) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const dirty = body.trim() !== '';
  const { guard } = useEditGuard(dirty);
  const { restoreOffer } = useSessionDraft({
    id: `exec:${taskKey}:rework`, label: `${taskKey} 재작업 지시`, value: dirty ? { body } : null,
    onRestore: (data) => { setBody(data.body); },
  });

  const send = async ({ body: text, updatedAt: version }: Payload, key: string) => {
    await createAndSend(client, taskKey, { type: '수정 요청', toAgent: agent, body: text, attemptId }, key);
    return client.call('requestRun', { params: { taskKey }, body: { updatedAt: version, kind: 'rework' }, idempotencyKey: `${key}.run` });
  };
  const latestVersion = async (signal?: AbortSignal) => {
    const list = await client.call('listTasks', { params: { projectId }, ...(signal ? { signal } : {}) });
    const task = list.tasks.find((t) => t.taskKey === taskKey);
    if (!task) throw new Error(`${taskKey}를 찾을 수 없습니다.`);
    return task.updatedAt;
  };

  const { save, busy, conflictModal } = useSave<unknown, Payload>({
    target: `${taskKey} 재작업 지시`,
    failTitle: '보내지 못했습니다',
    mine: `재작업 지시: ${body.split('\n')[0] ?? ''}`,
    request: () => ({ body: body.trim(), updatedAt }),
    run: ({ payload, idempotencyKey }) => send(payload, idempotencyKey),
    onSuccess: (_r, payload) => {
      void invalidateTopics(queryClient, EXEC_TOPICS);
      // 다시 시도 사이에 더 고쳤으면 닫지 않는다.
      if (body.trim() === payload.body) onClose();
    },
    successNotice: '재작업 지시를 보내고 재작업 실행을 요청했습니다.',
    onRejected: () => { void invalidateTopics(queryClient, EXEC_TOPICS); },
    onConflictReload: async ({ signal }) => {
      await latestVersion(signal);
      await invalidateTopics(queryClient, EXEC_TOPICS);
      if (!signal.aborted) onClose();
    },
    onConflictReapply: async ({ signal }) => {
      const version = await latestVersion(signal);
      await send({ body: body.trim(), updatedAt: version }, crypto.randomUUID());
      await invalidateTopics(queryClient, EXEC_TOPICS);
      onClose();
    },
  });

  return (
    <div className="card">
      {restoreOffer}
      <h3 className="sh" style={{ marginTop: 0 }}>재작업 지시 <span className="muted">수정 요청 메시지로 기록되고, 새 재작업 실행 시도와 함께 전달됩니다</span></h3>
      <label className="sr" htmlFor="ex-rw">재작업 지시 내용</label>
      <textarea id="ex-rw" rows={6} className="inp" value={body} onChange={(e) => { setBody(e.target.value); }} />
      <div className="form-acts">
        <span className="ferr" style={{ marginRight: 'auto' }}>{dirty ? '' : '지시 내용을 입력하세요.'}</span>
        <button type="button" className="btn" onClick={() => { void guard(onClose); }}>취소</button>
        <BusyButton busy={busy} busyLabel="보내는 중…" disabled={!dirty} onClick={() => { void save(); }}>지시 전송 후 재작업 실행</BusyButton>
      </div>
      {conflictModal}
    </div>
  );
}
