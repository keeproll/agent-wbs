/**
 * 재작업 지시(UI-06C, P L1801–1809). 자동 재작업 한도를 넘었을 때만 연다(contracts §3.5 「팀장 버튼은 1회만」).
 * 지시는 「수정 요청」 메시지로 기록하고 전송한 뒤, 재작업 실행을 요청한다.
 *
 * 공통 규칙(shared/README §3·§5·§6):
 * - useSave: 실패해도 입력 유지, 다시 시도는 같은 멱등 키, 409 충돌은 충돌 창. 다시 적용은 reapplyRequest(M3-04 공통).
 * - useSessionDraft: 세션 만료로 끊겨도 다시 로그인하면 복원 제안. 대상은 taskKey(안정 키).
 * - useEditGuard: 쓰던 지시가 있으면 다른 Task·메뉴로 가기 전에 묻는다.
 *
 * 두 단계가 따로 끝난다(M3-06 리뷰 #2): 지시 메시지를 보낸 뒤 실행 요청만 실패할 수 있다.
 * 보낸 메시지를 기억해 두고, 충돌 뒤 「다시 적용」·「다시 시도」는 실행 요청만 다시 보낸다(같은 지시를 두 번 보내지 않는다).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { invalidateTopics } from '../../shared/api/queries.ts';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import type { Agent } from './messageDrafts.ts';
import { sendMessage, type CreatedMessage } from './sendMessage.ts';
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

interface Payload { body: string; updatedAt: string; created: CreatedMessage | null }

export function ReworkEditor({ projectId, taskKey, agent, attemptId, updatedAt, onClose }: ReworkEditorProps) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  /** 이 지시로 이미 만든(보낸) 메시지. 본문을 바꾸면 새 지시라 잊는다. */
  const [sent, setSent] = useState<{ body: string; message: CreatedMessage } | null>(null);
  const sentRef = useRef(sent);
  const trimmed = body.trim();
  const dirty = trimmed !== '';
  const { guard } = useEditGuard(dirty);
  // 세션 만료에 대비해 지시와 함께 「이 지시로 이미 만든·보낸 메시지」도 보관한다(재리뷰 P2).
  // 복원하면 그것도 되살려, 다시 눌렀을 때 같은 지시를 또 만들지 않고 남은 단계(전송·실행 요청)만 보낸다.
  const { restoreOffer } = useSessionDraft<{ body: string; sent?: { body: string; message: CreatedMessage } | null }>({
    id: `exec:${taskKey}:rework`, label: `${taskKey} 재작업 지시`, value: dirty ? { body, sent } : null,
    onRestore: (data) => {
      setBody(data.body);
      if (data.sent) { sentRef.current = data.sent; setSent(data.sent); }
    },
  });
  const sentFor = (text: string) => (sentRef.current?.body === text ? sentRef.current.message : null);

  const latestVersion = async (signal?: AbortSignal) => {
    const list = await client.call('listTasks', { params: { projectId }, ...(signal ? { signal } : {}) });
    const task = list.tasks.find((t) => t.taskKey === taskKey);
    if (!task) throw new Error(`${taskKey}를 찾을 수 없습니다.`);
    return task.updatedAt;
  };

  const { save, busy, conflictModal } = useSave<unknown, Payload>({
    target: `${taskKey} 재작업 지시`,
    failTitle: sent?.message.sent ? `지시 ${sent.message.msgKey}는 보냈지만 재작업 실행을 요청하지 못했습니다` : '보내지 못했습니다',
    mine: sent && sent.body === trimmed
      ? `재작업 실행 요청 — 지시 ${sent.message.msgKey}는 이미 ${sent.message.sent ? '보냈습니다' : '만들었습니다'}(다시 만들지 않음)`
      : `재작업 지시: ${body.split('\n')[0] ?? ''}`,
    request: () => ({ body: trimmed, updatedAt, created: sentFor(trimmed) }),
    run: async ({ payload, idempotencyKey }) => {
      await sendMessage({
        client, taskKey, idempotencyKey, created: payload.created,
        draft: { type: '수정 요청', toAgent: agent, body: payload.body, attemptId },
        onCreated: (message) => { sentRef.current = { body: payload.body, message }; setSent(sentRef.current); },
      });
      return client.call('requestRun', { params: { taskKey }, body: { updatedAt: payload.updatedAt, kind: 'rework' }, idempotencyKey: `${idempotencyKey}.run` });
    },
    onSuccess: (_r, payload) => {
      void invalidateTopics(queryClient, EXEC_TOPICS);
      // 다시 시도 사이에 더 고쳤으면 닫지 않는다.
      if (trimmed === payload.body) onClose();
    },
    successNotice: '재작업 지시를 보내고 재작업 실행을 요청했습니다.',
    onRejected: () => { void invalidateTopics(queryClient, EXEC_TOPICS); },
    // 창을 닫으면(Esc) signal이 취소된다. 그 뒤 늦게 온 결과로 편집기를 닫지 않는다(M3-01 79c2cc1, 재리뷰 P1).
    onConflictReload: async ({ signal }) => {
      await latestVersion(signal);
      if (signal.aborted) return;
      await invalidateTopics(queryClient, EXEC_TOPICS);
      if (!signal.aborted) onClose();
    },
    // 최신 버전으로 같은 내용을 만든다. 이미 보낸 지시는 created로 넘겨 다시 만들지 않는다.
    reapplyRequest: async ({ signal }) => ({ body: trimmed, updatedAt: await latestVersion(signal), created: sentFor(trimmed) }),
  });

  return (
    <div className="card">
      {restoreOffer}
      <h3 className="sh" style={{ marginTop: 0 }}>재작업 지시 <span className="muted">수정 요청 메시지로 기록되고, 새 재작업 실행 시도와 함께 전달됩니다</span></h3>
      <label className="sr" htmlFor="ex-rw">재작업 지시 내용</label>
      <textarea id="ex-rw" rows={6} className="inp" value={body} onChange={(e) => { setBody(e.target.value); }} />
      {sent && sent.body === trimmed && (
        <p className="fhint" style={{ margin: '8px 0 0' }}>지시 {sent.message.msgKey}는 이미 {sent.message.sent ? '보냈습니다. 다시 누르면 재작업 실행 요청만 보냅니다.' : '만들었습니다. 다시 누르면 그 지시를 전송하고 재작업 실행을 요청합니다.'}</p>
      )}
      <div className="form-acts">
        <span className="ferr" style={{ marginRight: 'auto' }}>{dirty ? '' : '지시 내용을 입력하세요.'}</span>
        <button type="button" className="btn" onClick={() => { void guard(onClose); }}>취소</button>
        <BusyButton busy={busy} busyLabel="보내는 중…" disabled={!dirty} onClick={() => { void save(); }}>지시 전송 후 재작업 실행</BusyButton>
      </div>
      {conflictModal}
    </div>
  );
}
