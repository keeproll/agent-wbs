/**
 * Task별 메시지 작성 초안(UAT-MSG-01, P draftOf L5399, G§4.10 「작성 중 내용 유실 방지」).
 *
 * - 화면(React 상태)이 아니라 이 모듈의 저장소에 Task별로 둔다.
 *   왜: 다른 Task·다른 메뉴로 갔다 와도 초안이 남아야 하기 때문이다.
 * - 브라우저 저장소에는 쓰지 않는다(메모리만). 새로고침에서는 편집 보호(beforeunload)가 묻는다.
 * - 세션 만료(401)는 useSessionDraft가 따로 보관·복원한다. 명시적 로그아웃이면 clearAll로 모두 지운다.
 */
import { useSyncExternalStore } from 'react';
import { onDraftsCleared } from '../../shared/state/sessionDrafts.ts';

export type MessageKind = '추가 지시' | '수정 요청' | '질문' | '일반 의견';
export const MESSAGE_TYPES: readonly MessageKind[] = ['추가 지시', '수정 요청', '질문', '일반 의견'];

export type Agent = 'Claude' | 'Codex';
export const AGENTS: readonly Agent[] = ['Claude', 'Codex'];

export interface MessageDraft {
  type: MessageKind;
  toAgent: Agent;
  body: string;
  /** 관련 실행 시도 id(서버 uuid). 없으면 null */
  attemptId: string | null;
}

export const emptyDraft = (agent: Agent): MessageDraft => ({ type: '추가 지시', toAgent: agent, body: '', attemptId: null });

export function createDraftStore() {
  let drafts = new Map<string, MessageDraft>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const l of listeners) l(); };
  return {
    get: (taskKey: string, agent: Agent): MessageDraft => drafts.get(taskKey) ?? emptyDraft(agent),
    has: (taskKey: string) => (drafts.get(taskKey)?.body.trim() ?? '') !== '',
    set: (taskKey: string, draft: MessageDraft) => { drafts = new Map(drafts).set(taskKey, draft); emit(); },
    clearBody: (taskKey: string) => {
      const d = drafts.get(taskKey);
      if (d) { drafts = new Map(drafts).set(taskKey, { ...d, body: '' }); emit(); }
    },
    clearAll: () => { drafts = new Map(); emit(); },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => drafts,
  };
}

export const messageDrafts = createDraftStore();
// 로그아웃(이 탭·다른 탭)하면 다음 사람에게 남기지 않는다(shared/README §5).
onDraftsCleared(() => { messageDrafts.clearAll(); });

/** 화면에서 한 Task의 초안을 읽고 바꾼다. */
export function useMessageDraft(taskKey: string, agent: Agent): [MessageDraft, (patch: Partial<MessageDraft>) => void] {
  const all = useSyncExternalStore(messageDrafts.subscribe, messageDrafts.snapshot);
  const draft = all.get(taskKey) ?? emptyDraft(agent);
  return [draft, (patch) => { messageDrafts.set(taskKey, { ...messageDrafts.get(taskKey, agent), ...patch }); }];
}
