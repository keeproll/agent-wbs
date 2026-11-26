/**
 * 화면 하나의 초안을 세션 만료에 대비해 등록하고, 재로그인 뒤 복원을 제안한다(sessionDrafts.ts).
 *
 *   const { restoreOffer } = useSessionDraft({
 *     id: `task:${taskKey}:title`,          // 화면·대상마다 다른 이름
 *     label: `${taskKey} 제목 편집`,          // 복원 안내에 보일 이름
 *     value: dirty ? { title: draft } : null, // 저장하지 않은 초안. 없으면 null
 *     onRestore: (data) => { setDraft(data.title); },
 *     secretFields: ['smtpPass'],            // 이름 규칙으로 못 거르는 비밀값이 있으면 추가
 *   });
 *   return <>{restoreOffer}…</>;
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { formatDateTime } from '../format.ts';
import { browserStorage, browserTabId, discardStoredDraft, readStoredDraft, registerDraft, stripSecrets, type StoredDraft } from './sessionDrafts.ts';

export interface SessionDraftOptions<T> {
  id: string;
  label: string;
  value: T | null;
  onRestore: (data: T) => void;
  secretFields?: readonly string[];
}

function readFor(id: string): StoredDraft | null {
  const storage = browserStorage();
  const tabId = browserTabId();
  return storage && tabId ? readStoredDraft(storage, tabId, id) : null;
}

export function useSessionDraft<T>({ id, label, value, onRestore, secretFields = [] }: SessionDraftOptions<T>): { restoreOffer: ReactNode } {
  const location = useLocation();
  const latest = useRef({ value, label, path: `${location.pathname}${location.search}`, secretFields });
  useEffect(() => { latest.current = { value, label, path: `${location.pathname}${location.search}`, secretFields }; });

  const hasDraft = value !== null;
  useEffect(() => {
    if (!hasDraft) return;
    return registerDraft(id, () => ({
      label: latest.current.label,
      path: latest.current.path,
      data: stripSecrets(latest.current.value, latest.current.secretFields),
    }));
  }, [id, hasDraft]);

  // 제안은 「어느 id의 초안인지」와 함께 둔다. id가 바뀌면 새 id의 기록만 읽는다(재리뷰 622c334 #3).
  const [offer, setOffer] = useState<{ id: string; draft: StoredDraft | null }>(() => ({ id, draft: readFor(id) }));
  if (offer.id !== id) setOffer({ id, draft: readFor(id) });
  const stored = offer.id === id ? offer.draft : null;

  /** 제안에 연결된 id의 기록만 지운다. */
  const close = (draftId: string) => {
    const storage = browserStorage();
    if (storage) discardStoredDraft(storage, draftId);
    setOffer((current) => (current.id === draftId ? { id: draftId, draft: null } : current));
  };

  const restoreOffer = stored ? (
    <section className="banner info" role="region" aria-label={`${stored.label} — 저장하지 못한 초안`} style={{ marginTop: 0, marginBottom: 10 }}>
      <div className="banner-b">
        <b>로그인이 끊겨 저장하지 못한 편집 내용이 있습니다</b> — {stored.label} · {formatDateTime(stored.savedAt)}.
        {' '}복원하면 편집 상태로 다시 엽니다. 비밀번호·토큰 같은 비밀값은 보관하지 않으므로 다시 입력해야 합니다.
      </div>
      <button type="button" className="btn sm primary" onClick={() => { onRestore(stored.data as T); close(id); }}>복원</button>
      <button type="button" className="btn sm ghost" onClick={() => { close(id); }}>버리기</button>
    </section>
  ) : null;

  return { restoreOffer };
}
