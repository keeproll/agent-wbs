/**
 * Task별 메시지 작성 초안(UAT-MSG-01, P draftOf L5399, G§4.10 「작성 중 내용 유실 방지」).
 *
 * - 화면(React 상태)이 아니라 이 모듈의 저장소에 Task별로 둔다.
 *   왜: 다른 Task·다른 메뉴로 갔다 와도 초안이 남아야 하기 때문이다.
 * - 브라우저 저장소에는 쓰지 않는다(메모리만).
 * - 보호는 지금 열린 작성 칸이 아니라 저장소 전체를 기준으로 한다(M3-06 리뷰 #6). 다른 Task에 둔 초안도 지킨다.
 *   - 새로고침·창 닫기: 보관 중인 초안이 하나라도 있으면 브라우저가 묻는다(beforeunload).
 *   - 세션 만료(401): 초안이 있는 Task마다 공통 초안 보관함(registerDraft)에 `exec:<taskKey>:message`로 등록한다.
 *     다시 로그인한 뒤 그 Task의 작성 칸을 열면 useSessionDraft가 복원을 제안한다.
 * - 명시적 로그아웃이면 clearAll로 모두 지운다.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { onDraftsCleared, registerDraft } from '../../shared/state/sessionDrafts.ts';

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

/** 세션 만료 보관함에서 쓰는 이름(작성 칸의 useSessionDraft와 같아야 복원 제안이 뜬다). */
export const draftSessionId = (taskKey: string) => `exec:${taskKey}:message`;

let installed = false;
/**
 * 저장소 전체 기준 보호를 켠다(한 번만). 작업 실행 화면이 열릴 때 부른다.
 * 켠 뒤에는 다른 메뉴로 가도 유지된다. 초안은 메뉴를 옮겨도 남기 때문이다.
 */
export function installDraftProtection(store = messageDrafts): void {
  if (installed || typeof addEventListener !== 'function') return;
  installed = true;
  const registered = new Map<string, () => void>();
  const sync = () => {
    const live = new Set<string>();
    for (const [taskKey, draft] of store.snapshot()) {
      if (draft.body.trim() === '') continue;
      live.add(taskKey);
      if (registered.has(taskKey)) continue;
      registered.set(taskKey, registerDraft(draftSessionId(taskKey), () => ({
        label: `${taskKey} 메시지 작성`, path: `/exec/${encodeURIComponent(taskKey)}`, data: store.get(taskKey, 'Claude'),
      })));
    }
    for (const [taskKey, off] of registered) if (!live.has(taskKey)) { off(); registered.delete(taskKey); }
  };
  store.subscribe(sync);
  sync();
  addEventListener('beforeunload', (event) => {
    if ([...store.snapshot().values()].some((d) => d.body.trim() !== '')) event.preventDefault();
  });
}

export function useDraftProtection(): void {
  useEffect(() => { installDraftProtection(); }, []);
}
