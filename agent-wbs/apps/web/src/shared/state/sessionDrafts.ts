/**
 * 세션 만료 초안 보관(조정자 결정, 2026-11-27).
 *
 * - 편집 중 로그인이 끊기면(401) 화면별 초안을 sessionStorage에 남긴다. 탭을 닫으면 사라진다.
 * - 초안은 그것을 남긴 탭에서만 읽는다(탭 id). window.open으로 연 새 탭은 저장소 사본을 받지만 복원하지 않고 사본을 지운다.
 * - 사용자가 직접 로그아웃하면 보관 초안을 바로 모두 지운다. 세션 만료 뒤 다시 로그인한 경우에만 복원을 제안한다.
 *   여러 탭: 로그아웃 시각을 localStorage(`awbs.logoutAt`, 모든 탭이 함께 보는 저장소)에 남기고 BroadcastChannel로 다른 탭에 알린다.
 *   알림을 받은 탭은 바로 지운다. 알림을 못 받은 탭(닫혀 있었거나 멈춰 있던 탭)도 복원 전에 「로그아웃 시각 이전에 보관된 초안은 무조건 버린다」.
 * - 이 제품의 로그인 주체는 팀장 한 명(principal lead)이라 사용자 계정을 구분하지 않는다. 저장소가 사용자 구분을 대신 보장하지 않는다.
 * - 재로그인 뒤 같은 화면을 열면 복원을 제안한다(useSessionDraft.tsx).
 * - 비밀값(비밀번호·토큰·키·secret 등)은 저장하지 않는다. 왜: 비밀값은 서버에만 암호화해 두고 화면에는 쓰기 전용으로 다룬다(G L554, UAT-GITHUB-02).
 * - 초안은 인증 수단이 아니다. 복원은 다시 로그인한 뒤에만 보이고, 저장은 평소처럼 서버 검사를 거친다.
 */

export interface DraftEntry { label: string; path: string; data: unknown }
/** tabId: 초안을 남긴 탭. 다른 탭(복사본 포함)에서는 읽지 않는다. */
export interface StoredDraft extends DraftEntry { tabId: string; savedAt: number }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const PREFIX = 'awbs.draft:';
const TAB_KEY = 'awbs.tab';
const NAME_PREFIX = 'awbs-tab:';

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${String(Date.now())}-${String(Math.random()).slice(2)}`);

/**
 * 이 탭의 id. sessionStorage와 window.name 두 곳에 같은 값을 둔다.
 * 왜 두 곳인가: window.open으로 연 새 탭은 여는 탭의 sessionStorage 사본을 받지만 window.name은 받지 않는다.
 * 두 값이 다르면 「복사된 저장소를 받은 새 탭」이므로 새 id를 만들고, 복사돼 온 초안을 지운다(재리뷰 622c334 #2).
 * 같은 탭의 새로고침·같은 출처 이동에서는 두 값이 유지된다.
 */
export function resolveTabId(storage: Storage, win: { name: string }): string {
  const fromName = win.name.startsWith(NAME_PREFIX) ? win.name.slice(NAME_PREFIX.length) : null;
  let stored: string | null = null;
  try { stored = storage.getItem(TAB_KEY); } catch { /* 막힌 저장소 */ }
  if (stored && fromName === stored) return stored;
  const id = newId();
  if (stored) clearAllDrafts(storage); // 다른 탭에서 복사돼 온 초안
  try { storage.setItem(TAB_KEY, id); } catch { /* 무시 */ }
  win.name = NAME_PREFIX + id;
  return id;
}
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
export function persistRegisteredDrafts(storage: Storage, tabId: string, now: number = sessionStamp()): void {
  for (const [id, snapshot] of registry) {
    try {
      const entry = snapshot();
      // 등록하는 쪽이 빠뜨려도 비밀값은 여기서 한 번 더 뺀다.
      const stored: StoredDraft = { tabId, label: entry.label, path: entry.path, savedAt: now, data: stripSecrets(entry.data) };
      storage.setItem(PREFIX + id, JSON.stringify(stored));
    } catch { /* 저장소가 막혀도 로그인 이동은 계속한다 */ }
  }
}

/** 이 탭(tabId)이 남긴 초안만 돌려준다. notBefore(마지막 로그아웃 시각) 이전·같은 시각에 보관된 초안은 지우고 null. */
export function readStoredDraft(storage: Storage, tabId: string, id: string, notBefore = 0): StoredDraft | null {
  try {
    const raw = storage.getItem(PREFIX + id);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    if (typeof parsed.savedAt !== 'number' || typeof parsed.label !== 'string' || parsed.tabId !== tabId) return null;
    if (parsed.savedAt <= notBefore) {
      storage.removeItem(PREFIX + id);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function discardStoredDraft(storage: Storage, id: string): void {
  try { storage.removeItem(PREFIX + id); } catch { /* 무시 */ }
}

/** 보관한 초안을 모두 지운다. 명시적 로그아웃 때 부른다(재리뷰 622c334 #1). */
export function clearAllDrafts(storage: Storage): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch { /* 무시 */ }
}

const LOGOUT_KEY = 'awbs.logoutAt';
const CHANNEL = 'awbs.session';
const STAMP_KEY = 'awbs.sessionStamp';

/**
 * 세션 사건(로그인·로그아웃·초안 보관·페이지 열기)에 붙이는 번호(ms). 벽시계 값과 「모든 탭에서 마지막으로 쓴 번호 + 1」 중 큰 값이다.
 * 왜: 벽시계가 뒤로 가면(이 PC는 약 32초마다 2.3초) 나중 로그아웃이 앞선 로그인보다 작은 시각으로 찍혀,
 * 로그아웃 뒤에도 초안 보관을 허용하는 쪽으로 틀릴 수 있다. 번호를 모든 탭이 보는 localStorage에 두어 순서를 지킨다.
 * 저장소가 막혀 있으면 벽시계 값을 그대로 쓴다.
 */
export function sessionStamp(local: Storage | null = browserLocalStorage(), now: number = Date.now()): number {
  let stamp = now;
  try {
    const last = Number(local?.getItem(STAMP_KEY));
    if (Number.isFinite(last) && last >= stamp) stamp = last + 1;
    local?.setItem(STAMP_KEY, String(stamp));
  } catch { /* 막힌 저장소: 벽시계 값 */ }
  return stamp;
}

/** 명시적 로그아웃 시각을 남긴다(모든 탭이 보는 localStorage). */
export function recordLogout(local: Storage, now: number = sessionStamp(local)): void {
  try { local.setItem(LOGOUT_KEY, String(now)); } catch { /* 무시 */ }
}

/** 마지막 명시적 로그아웃 시각(ms). 없거나 읽을 수 없으면 0 */
export function lastLogoutAt(local: Storage): number {
  try {
    const value = Number(local.getItem(LOGOUT_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

const clearedListeners = new Set<() => void>();
/** 보관 초안이 지워졌을 때(로그아웃) 알림을 받는다. useSessionDraft가 복원 제안을 닫는 데 쓴다. */
export function onDraftsCleared(listener: () => void): () => void {
  clearedListeners.add(listener);
  return () => { clearedListeners.delete(listener); };
}

/**
 * 초안 보관 허용 규칙(재리뷰 64b29b9). 규칙 하나:
 * 로그아웃 알림을 받았거나(blocked) 로그아웃 시각이 이 탭의 마지막 로그인 이후(같은 시각 포함)면,
 * 이 탭에서 새 로그인이 성공하기 전까지 어떤 401에서도 초안을 보관하지 않는다.
 * 왜: 로그아웃 뒤에도 화면에 남은 옛 입력이 다음 401에서 「새 기록」으로 다시 저장되는 것을 막는다.
 */
export function draftsAllowed({ blocked, logoutAt, loginAt }: { blocked: boolean; logoutAt: number; loginAt: number }): boolean {
  return !blocked && logoutAt < loginAt;
}

const LOGIN_KEY = 'awbs.loginAt';
/** 이 페이지를 연 시각. 이 탭에서 로그인한 기록이 없을 때(이미 로그인된 세션으로 연 탭) 로그인 시각으로 본다. */
const pageOpenedAt = sessionStamp();
let blockedByLogout = false;

/** 이 탭에서 로그인이 성공했다: 시각을 남기고 보관 차단을 푼다. */
export function markLoggedIn(now: number = sessionStamp()): void {
  blockedByLogout = false;
  const storage = browserStorage();
  try { storage?.setItem(LOGIN_KEY, String(now)); } catch { /* 무시 */ }
}

/** 지금 이 탭에서 만료 초안을 보관해도 되는가 */
export function mayPersistDrafts(): boolean {
  const storage = browserStorage();
  let loginAt = pageOpenedAt;
  try {
    const value = Number(storage?.getItem(LOGIN_KEY));
    if (Number.isFinite(value) && value > 0) loginAt = value;
  } catch { /* 무시 */ }
  return draftsAllowed({ blocked: blockedByLogout, logoutAt: browserLogoutAt(), loginAt });
}

function dropAllHere(): void {
  // 이 탭이든 다른 탭이든 로그아웃했다: 새 로그인 전까지 보관을 막는다.
  blockedByLogout = true;
  const storage = browserStorage();
  if (storage) clearAllDrafts(storage);
  for (const listener of clearedListeners) listener();
}

/** 이 탭에서 명시적으로 로그아웃했다: 시각을 남기고, 이 탭 초안을 지우고, 다른 탭에 알린다. */
export function announceLogout(now: number = sessionStamp()): void {
  const local = browserLocalStorage();
  if (local) recordLogout(local, now);
  dropAllHere();
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ type: 'logout', at: now });
    channel.close();
  } catch { /* BroadcastChannel이 없으면 로그아웃 시각 검사로만 지킨다 */ }
}

/** 다른 탭의 로그아웃 알림을 듣는다(앱 시작 때 한 번). */
export function listenForLogout(): () => void {
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<{ type?: string }>) => { if (event.data.type === 'logout') dropAllHere(); };
  } catch { /* 없음 */ }
  return () => { channel?.close(); };
}

/** 이 탭에서 복원해도 되는 초안의 기준 시각(마지막 로그아웃 시각) */
export function browserLogoutAt(): number {
  const local = browserLocalStorage();
  return local ? lastLogoutAt(local) : 0;
}

function browserLocalStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

let tabIdCache: string | null = null;
/** 브라우저에서 이 탭의 id(처음 부를 때 한 번 정한다) */
export function browserTabId(): string | null {
  const storage = browserStorage();
  if (!storage) return null;
  tabIdCache ??= resolveTabId(storage, window);
  return tabIdCache;
}

/** 브라우저의 sessionStorage. 막혀 있으면 null */
export function browserStorage(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}
