/**
 * 세션 만료 초안 보관(조정자 결정, 2026-11-27).
 *
 * - 편집 중 로그인이 끊기면(401) 화면별 초안을 sessionStorage에 남긴다. 같은 브라우저 탭에서만 보이고 탭을 닫으면 사라진다.
 * - 재로그인 뒤 같은 화면을 열면 복원을 제안한다(useSessionDraft.tsx).
 * - 비밀값(비밀번호·토큰·키·secret 등)은 저장하지 않는다. 왜: 비밀값은 서버에만 암호화해 두고 화면에는 쓰기 전용으로 다룬다(G L554, UAT-GITHUB-02).
 * - 초안은 인증 수단이 아니다. 복원은 다시 로그인한 뒤에만 보이고, 저장은 평소처럼 서버 검사를 거친다.
 */

export interface DraftEntry { label: string; path: string; data: unknown }
export interface StoredDraft extends DraftEntry { savedAt: number }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

const PREFIX = 'awbs.draft:';
/** 이 이름의 필드는 어디에 있든 저장하지 않는다. */
export const SECRET_KEY = /pass(word|wd|phrase)?$|secret|token|api[-_]?key|private[-_]?key|credential|^otp$/i;

/** 비밀값 필드를 깊은 곳까지 뺀 복사본. extra는 화면이 더 빼고 싶은 필드 이름. */
export function stripSecrets(value: unknown, extra: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item, extra));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key) && !extra.includes(key))
      .map(([key, item]) => [key, stripSecrets(item, extra)]));
  }
  return value;
}

const registry = new Map<string, () => DraftEntry>();

/** 저장하지 않은 초안이 있는 동안 등록한다. 돌려받은 함수로 해제한다. */
export function registerDraft(id: string, snapshot: () => DraftEntry): () => void {
  registry.set(id, snapshot);
  return () => { if (registry.get(id) === snapshot) registry.delete(id); };
}

/** 세션이 끊길 때 등록된 초안을 모두 저장한다(ApiProvider가 부른다). 저장소가 막혀 있으면 조용히 건너뛴다. */
export function persistRegisteredDrafts(storage: Storage, now: number = Date.now()): void {
  for (const [id, snapshot] of registry) {
    try {
      const entry = snapshot();
      // 등록하는 쪽이 빠뜨려도 비밀값은 여기서 한 번 더 뺀다.
      const stored: StoredDraft = { label: entry.label, path: entry.path, savedAt: now, data: stripSecrets(entry.data) };
      storage.setItem(PREFIX + id, JSON.stringify(stored));
    } catch { /* 저장소가 막혀도 로그인 이동은 계속한다 */ }
  }
}

export function readStoredDraft(storage: Storage, id: string): StoredDraft | null {
  try {
    const raw = storage.getItem(PREFIX + id);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    return typeof parsed.savedAt === 'number' && typeof parsed.label === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function discardStoredDraft(storage: Storage, id: string): void {
  try { storage.removeItem(PREFIX + id); } catch { /* 무시 */ }
}

/** 브라우저의 sessionStorage. 막혀 있으면 null */
export function browserStorage(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}
