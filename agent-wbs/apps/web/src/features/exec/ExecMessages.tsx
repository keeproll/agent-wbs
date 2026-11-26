/**
 * 오른쪽: 연결 메시지(UI-06E, P L1842–1854)와 메시지 작성(P Task 메시지 탭 L1385–1393의 작성 칸).
 *
 * - 일반 채팅이 아니라 Task·실행 시도에 연결된 지시 · 응답 기록이다(G§4.10). 말풍선을 쓰지 않는다.
 * - 전달 상태(Draft→Queued→Sent→Acknowledged / Failed / Cancelled)와 Agent 응답 · 작업 상태는 따로 보인다(G§9.4-1).
 *   수신 확인(ack)은 작업 완료가 아니다.
 * - 실행 중 전달을 지원하지 않으면 「다음 실행 대기」로 보인다(서버 pendingNext 값 그대로).
 * - 메시지는 공식 명세를 바꾸지 않는다. 명세 변경은 Change Proposal로 간다.
 * - 작성 초안은 Task별로 보관한다(messageDrafts.ts). 다른 Task로 옮겨도 남는다.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { invalidateTopics } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { useConfirm } from '../../shared/ui/feedback.tsx';
import { AGENTS, draftSessionId, MESSAGE_TYPES, messageDrafts, useMessageDraft, type Agent, type MessageDraft } from './messageDrafts.ts';
import { deliveryView, type ExecAttempt, type ExecMessage } from './model.ts';
import { AreaError } from './AreaError.tsx';
import { latestMessage, sendMessage, type CreatedMessage } from './sendMessage.ts';
import type { ExecData } from './useExecData.ts';

export interface MessagesProps {
  taskKey: string;
  taskStatus: string;
  defaultAgent: Agent;
  attempts: readonly ExecAttempt[];
  /** 주소로 고른 시도. 있으면 그 시도에 연결된 메시지만 보인다. */
  scopeAttempt: ExecAttempt | null;
  /** 메시지 조회(모든 쪽). 실패를 「메시지 없음」으로 보이지 않기 위해 query 그대로 받는다. */
  messages: ExecData['messages'];
  online: boolean;
  liveInject: boolean;
}

/** 원본은 running만 다음 실행 대기로 봤다(MM-08). QA·재검증 실행 중도 같은 실행 세션이다(G L355). */
const RUNNING_STATES = ['running', 'qa', 'verifying'];

export function ExecMessages({ taskKey, taskStatus, defaultAgent, attempts, scopeAttempt, messages, online, liveInject }: MessagesProps) {
  const [composing, setComposing] = useState(false);
  const list = messages.data ?? [];
  const shown = scopeAttempt ? list.filter((m) => m.attemptId === scopeAttempt.id) : list;
  const attemptKeyOf = (id: string | null) => (id ? attempts.find((a) => a.id === id)?.attemptKey ?? '—' : '—');
  // 받은 응답에는 보낸 Agent 필드가 없다(계약 Message). 연결 시도의 Agent로 추측하지 않는다(M3-06 리뷰 #9).
  // 시도의 Agent와 응답한 Agent는 다를 수 있다(예: QA 시도에 연결된 Claude의 재작업 계획 응답).
  const fromOf = (m: ExecMessage) => (m.dir === 'in' ? 'Agent' : '팀장');
  const toOf = (m: ExecMessage) => (m.dir === 'in' ? '팀장' : String(m.toAgent ?? '—'));
  // 쓰던 초안이 있으면 작성 칸을 열어 둔다(Task를 옮겨 왔을 때).
  const [current] = useMessageDraft(taskKey, defaultAgent);
  const hasDraft = current.body.trim() !== '';
  const open = composing || hasDraft;

  return (
    <aside className="side scrollc" aria-label="연결 메시지">
      <div className="side-h">
        <h2 className="ex-side-t">{scopeAttempt ? `${scopeAttempt.attemptKey}에 연결된 메시지` : `${taskKey} 전체 메시지`}</h2>
        <button type="button" className="btn sm" aria-expanded={open} onClick={() => { setComposing(true); }}>메시지 작성</button>
      </div>
      <p className="fhint" style={{ margin: '0 0 6px' }}>실행 이력과 분리된 지시 · 응답 기록입니다.</p>
      {messages.data === undefined && messages.isError && (
        <AreaError what="메시지를" error={messages.error} retrying={messages.isFetching} onRetry={() => { void messages.refetch(); }} />
      )}
      {messages.data === undefined && !messages.isError && <p className="muted">메시지 불러오는 중…</p>}
      {messages.data !== undefined && shown.length === 0 && (
        <>
          <p className="empty">연결된 메시지가 없습니다.</p>
          <p className="fhint" style={{ margin: '0 0 6px' }}>「메시지 작성」으로 추가 지시 · 질문을 보낼 수 있습니다. Agent의 응답도 여기에 보입니다.</p>
        </>
      )}
      {shown.map((m) => <MessageItem key={m.id} m={m} from={String(fromOf(m))} to={toOf(m)} attemptKey={attemptKeyOf(m.attemptId)} />)}
      {open && (
        <Composer
          key={taskKey} taskKey={taskKey} defaultAgent={defaultAgent} attempts={attempts} scopeAttempt={scopeAttempt}
          runningWarn={RUNNING_STATES.includes(taskStatus) && !liveInject} offline={!online} onClose={() => { setComposing(false); }}
        />
      )}
    </aside>
  );
}

function MessageItem({ m, from, to, attemptKey }: { m: ExecMessage; from: string; to: string; attemptKey: string }) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const inbound = m.dir === 'in';
  const unread = inbound && m.readAt === null;
  const dv = deliveryView(m);
  const refresh = () => invalidateTopics(queryClient, ['message']);
  const [action, setAction] = useState<'cancel' | 'resend' | 'read'>('resend');
  const { save, busy, conflictModal } = useSave<unknown, { updatedAt: string; action: typeof action }>({
    target: `${m.msgKey} ${action === 'cancel' ? '전송 취소' : action === 'read' ? '읽음 표시' : '재전송'}`,
    failTitle: '처리하지 못했습니다',
    request: () => ({ updatedAt: m.updatedAt, action }),
    run: ({ payload, idempotencyKey }) => {
      if (payload.action === 'read') return client.call('readMessage', { params: { messageId: m.id }, idempotencyKey });
      const id = payload.action === 'cancel' ? 'cancelMessage' : 'resendMessage';
      return client.call(id, { params: { messageId: m.id }, body: { updatedAt: payload.updatedAt }, idempotencyKey });
    },
    onSuccess: () => { void refresh(); },
    ...(action === 'read' ? {} : { successNotice: action === 'cancel' ? '전송을 취소했습니다. 전달 대상에서 빠졌습니다.' : '다시 전달 대기열에 넣었습니다.' }),
    onRejected: () => { void refresh(); },
    // 서버에서 실제로 읽은 뒤에 끝낸다(M3-04 공통: 실패를 성공 안내로 숨기지 않음).
    onConflictReload: async () => { await latestMessage(client, m.taskKey, m.id); await refresh(); },
    // 다시 적용(공통 reapplyRequest): 같은 동작을 그 메시지의 최신 버전으로 만든다.
    reapplyRequest: async () => ({ updatedAt: (await latestMessage(client, m.taskKey, m.id)).updatedAt, action }),
  });
  // 누른 동작을 한 번 그린 뒤 보낸다(오류 막대 「대상」이 그 동작 이름이 되게).
  const [queued, setQueued] = useState(0);
  useEffect(() => { if (queued > 0) void save(); }, [queued, save]);
  const doIt = (a: typeof action) => { setAction(a); setQueued((n) => n + 1); };

  return (
    <article className={inbound ? `msg in${unread ? ' new' : ''}` : 'msg'} style={{ marginBottom: 6 }} aria-label={`${m.msgKey} ${String(m.type)}`}>
      <div className="msg-h">
        <span className="msg-who">{from}</span><span className="muted">→</span><span className="msg-who">{to}</span>
        <span className="mtype">{String(m.type)}</span>
        <span className={`dl ${dv.cls}`}>{dv.label}</span>
        {m.workState && <span className="ws">작업 상태: {m.workState}</span>}
        {unread && <span className="newtag">새 응답</span>}
      </div>
      <p className="msg-sm">{m.body.split('\n').slice(0, 3).join(' ')}</p>
      {m.delivery === 'Failed' && (
        <div className="banner danger"><div className="banner-b"><b>전달 실패</b> — {m.failReason ?? '원인 미보고'}</div>
          <BusyButton small variant="default" busy={busy && action === 'resend'} busyLabel="재전송 중…" onClick={() => { doIt('resend'); }}>재전송</BusyButton>
        </div>
      )}
      {m.pendingNext && (m.delivery === 'Queued' || m.delivery === 'Sent') && (
        <div className="banner warn"><div className="banner-b"><b>다음 실행 대기</b> — Runner가 실행 중인 세션에 메시지를 넣지 못합니다. 다음 실행 시작 시 함께 전달됩니다.</div></div>
      )}
      <div className="msg-acts">
        <span className="mono muted">{formatDateTime(m.createdAt)} · {attemptKey}</span><span className="sp" />
        {(m.delivery === 'Draft' || m.delivery === 'Queued') && (
          <BusyButton small variant="ghost" busy={busy && action === 'cancel'} busyLabel="취소 중…" onClick={() => {
            void confirm({ title: '전송 취소', body: `${m.msgKey}를 전달 대상에서 뺍니다. 이미 Runner가 가져간 메시지는 취소할 수 없습니다.`, ok: '전송 취소', danger: true })
              .then((ok) => { if (ok) doIt('cancel'); });
          }}>전송 취소</BusyButton>
        )}
        {unread && <BusyButton small variant="ghost" busy={busy && action === 'read'} busyLabel="표시 중…" onClick={() => { doIt('read'); }}>읽음 표시</BusyButton>}
        <Link className="btn ghost sm" to={`/wbs/${encodeURIComponent(m.taskKey)}?tab=msg`}>Task 메시지에서 보기</Link>
      </div>
      {conflictModal}
    </article>
  );
}

interface Payload { draft: MessageDraft; created: CreatedMessage | null }

interface ComposerProps {
  taskKey: string;
  defaultAgent: Agent;
  attempts: readonly ExecAttempt[];
  scopeAttempt: ExecAttempt | null;
  runningWarn: boolean;
  offline: boolean;
  onClose: () => void;
}

function Composer({ taskKey, defaultAgent, attempts, scopeAttempt, runningWarn, offline, onClose }: ComposerProps) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const [draft, patch] = useMessageDraft(taskKey, defaultAgent);
  const empty = draft.body.trim() === '';
  // 처음 열 때 고른 시도가 있으면 그 시도에 연결한다(P writeMsg L6075).
  useEffect(() => {
    if (scopeAttempt && messageDrafts.get(taskKey, defaultAgent).attemptId === null && !messageDrafts.has(taskKey)) patch({ attemptId: scopeAttempt.id });
    // 처음 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 새로고침 보호와 세션 만료 보관은 Task별 초안 저장소 전체를 기준으로 한다(messageDrafts.ts의 useDraftProtection, 리뷰 #6).
  // 여기서는 다시 로그인했을 때의 복원 제안만 받는다(value는 null — 등록은 저장소가 한다).
  const { restoreOffer } = useSessionDraft<MessageDraft>({
    id: draftSessionId(taskKey), label: `${taskKey} 메시지 작성`, value: null,
    onRestore: (data) => { messageDrafts.set(taskKey, data); },
  });
  /** 이 내용으로 이미 만든 메시지. 전송만 실패했으면 다시 만들지 않는다(리뷰 #2와 같은 이유). */
  const created = useRef<{ draft: MessageDraft; message: CreatedMessage } | null>(null);
  const request = (): Payload => {
    const d = { ...draft, body: draft.body.trim() };
    return { draft: d, created: created.current && JSON.stringify(created.current.draft) === JSON.stringify(d) ? created.current.message : null };
  };
  const { save, busy, conflictModal } = useSave<unknown, Payload>({
    target: `${taskKey} 메시지 전송`,
    failTitle: '보내지 못했습니다',
    mine: `메시지: ${draft.body.split('\n')[0] ?? ''}`,
    request,
    run: ({ payload, idempotencyKey }) => sendMessage({
      client, taskKey, draft: payload.draft, idempotencyKey, created: payload.created,
      onCreated: (message) => { created.current = { draft: payload.draft, message }; },
    }),
    onSuccess: (_r, payload) => {
      void invalidateTopics(queryClient, ['message']);
      created.current = null;
      // 다시 시도 사이에 더 고친 초안은 지우지 않는다.
      if (messageDrafts.get(taskKey, defaultAgent).body.trim() === payload.draft.body) messageDrafts.clearBody(taskKey);
    },
    successNotice: '메시지를 전달 대기열에 넣었습니다.',
    onRejected: () => { void invalidateTopics(queryClient, ['message']); },
    onConflictReload: async () => {
      if (created.current) await latestMessage(client, taskKey, created.current.message.id);
      await invalidateTopics(queryClient, ['message']);
    },
    // 다시 적용(공통 reapplyRequest): 같은 초안. 이미 만든 메시지는 전송만 이어 간다.
    reapplyRequest: () => Promise.resolve(request()),
  });

  return (
    <div className="compose" style={{ marginTop: 10 }}>
      {restoreOffer}
      <h3 className="ex-cmp-t">메시지 작성</h3>
      <div className="cmp-row"><span className="flabel" style={{ padding: 0 }}>메시지 유형</span>
        <div className="seg" role="group" aria-label="메시지 유형">
          {MESSAGE_TYPES.map((t) => <button key={t} type="button" aria-pressed={draft.type === t} onClick={() => { patch({ type: t }); }}>{t}</button>)}
        </div>
      </div>
      <div className="cmp-row"><span className="flabel" style={{ padding: 0 }}>대상 Agent</span>
        <div className="seg" role="group" aria-label="대상 Agent">
          {AGENTS.map((a) => <button key={a} type="button" aria-pressed={draft.toAgent === a} onClick={() => { patch({ toAgent: a }); }}>{a}</button>)}
        </div>
      </div>
      <div className="cmp-row"><span className="flabel" style={{ padding: 0 }}>관련 실행 시도</span>
        <div className="seg" role="group" aria-label="관련 실행 시도">
          <button type="button" aria-pressed={draft.attemptId === null} onClick={() => { patch({ attemptId: null }); }}>지정 안 함</button>
          {attempts.map((a) => <button key={a.attemptKey} type="button" className="mono" aria-pressed={draft.attemptId === a.id} onClick={() => { patch({ attemptId: a.id }); }}>{a.attemptKey}</button>)}
        </div>
      </div>
      <label className="sr" htmlFor="msg-body">메시지 내용</label>
      <textarea id="msg-body" rows={6} className="inp" placeholder="작업 지시를 입력하세요. ``` 로 코드 블록, `경로` 로 파일 경로를 표시합니다." value={draft.body} onChange={(e) => { patch({ body: e.target.value }); }} />
      {runningWarn && <div className="banner warn"><div className="banner-b">이 Task는 <b>실행 중</b>입니다. 현재 Runner는 실행 중 세션에 즉시 전달하지 못하므로, 전송하면 <b>다음 실행 대기</b> 메시지로 보관됩니다.</div></div>}
      {offline && <div className="banner danger"><div className="banner-b"><b>Runner 연결 끊김</b> — 지금 전송하면 전달 실패로 기록되고, 연결 복구 후 재전송할 수 있습니다.</div></div>}
      <p className="fhint" style={{ margin: '8px 0 0' }}>메시지는 공식 명세를 바꾸지 않습니다. 범위 · AC · 선행 관계 · 기술 설계 변경은 Change Proposal로 승인 절차를 거칩니다.</p>
      <div className="cmp-acts">
        <span className={empty ? 'ferr' : 'fhint'}>{empty ? '보낼 내용을 입력하세요.' : '작성 중인 내용은 Task별로 보관되어 Task를 옮겨도 유지됩니다.'}</span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn" onClick={onClose} disabled={!empty} title={empty ? undefined : '쓰던 내용이 있으면 닫지 않습니다'}>닫기</button>
          <BusyButton busy={busy} busyLabel="전송 중…" disabled={empty} onClick={() => { void save(); }}>전송</BusyButton>
        </span>
      </div>
      {conflictModal}
    </div>
  );
}
