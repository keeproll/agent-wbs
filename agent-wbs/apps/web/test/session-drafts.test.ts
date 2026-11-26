import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllDrafts, discardStoredDraft, persistRegisteredDrafts, readStoredDraft, registerDraft, resolveTabId, stripSecrets,
} from '../src/shared/state/sessionDrafts.ts';

class MemoryStorage {
  map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  /** window.open이 opener 탭의 sessionStorage를 복사하는 것과 같은 사본 */
  copy() { const c = new MemoryStorage(); c.map = new Map(this.map); return c; }
}

describe('세션 만료 초안 보관(조정자 결정)', () => {
  let storage: MemoryStorage;
  let win: { name: string };
  beforeEach(() => { storage = new MemoryStorage(); win = { name: '' }; });

  it('비밀값 필드(비밀번호·토큰·키·secret)는 깊은 곳까지 빼고 저장한다', () => {
    expect(stripSecrets({
      title: 't', password: 'p', botToken: 'x', smtp: { host: 'h', pass: 'y', apiKey: 'k' }, list: [{ secret: 's', name: 'n' }], note: 'token 설명',
    }, ['customField'])).toEqual({ title: 't', smtp: { host: 'h' }, list: [{ name: 'n' }], note: 'token 설명' });
    expect(stripSecrets({ customField: 'c', keep: 1 }, ['customField'])).toEqual({ keep: 1 });
  });

  it('세션이 끊기면 등록된 화면별 초안만 이 탭 이름으로 남기고, 등록 해제한 초안은 남기지 않는다', () => {
    const tab = resolveTabId(storage, win);
    const offA = registerDraft('task:A:title', () => ({ label: 'A 제목', path: '/wbs/A', data: { title: 'a', token: 't' } }));
    const offB = registerDraft('task:B:title', () => ({ label: 'B 제목', path: '/wbs/B', data: { title: 'b' } }));
    offB();
    persistRegisteredDrafts(storage, tab, 1_800_000_000_000);
    expect(readStoredDraft(storage, tab, 'task:A:title')).toEqual({ tabId: tab, label: 'A 제목', path: '/wbs/A', savedAt: 1_800_000_000_000, data: { title: 'a' } });
    expect(readStoredDraft(storage, tab, 'task:B:title')).toBeNull();
    discardStoredDraft(storage, 'task:A:title');
    expect(readStoredDraft(storage, tab, 'task:A:title')).toBeNull();
    offA();
  });

  it('같은 탭은 새로고침해도 같은 탭 id를 쓴다', () => {
    const first = resolveTabId(storage, win);
    expect(resolveTabId(storage, win)).toBe(first);
  });

  // 재리뷰 622c334 #2: opener가 있는 새 탭은 sessionStorage 사본을 받는다.
  it('복사된 sessionStorage를 받은 새 탭은 새 탭 id를 받고, 복사된 초안을 읽지 못하며 사본을 지운다', () => {
    const tab = resolveTabId(storage, win);
    const off = registerDraft('task:A:title', () => ({ label: 'A', path: '/a', data: { title: 'a' } }));
    persistRegisteredDrafts(storage, tab, 1);
    off();
    const copied = storage.copy();
    const newWin = { name: '' };
    const newTab = resolveTabId(copied, newWin);
    expect(newTab).not.toBe(tab);
    expect(readStoredDraft(copied, newTab, 'task:A:title')).toBeNull();
    expect([...copied.map.keys()].filter((k) => k.startsWith('awbs.draft:'))).toEqual([]);
    // 원래 탭은 그대로 읽는다.
    expect(resolveTabId(storage, win)).toBe(tab);
    expect(readStoredDraft(storage, tab, 'task:A:title')?.data).toEqual({ title: 'a' });
  });

  // 재리뷰 622c334 #1: 명시적 로그아웃이면 즉시 지운다.
  it('clearAllDrafts는 이 탭의 초안을 모두 지운다(다른 키는 건드리지 않음)', () => {
    const tab = resolveTabId(storage, win);
    const off = registerDraft('x', () => ({ label: 'x', path: '/', data: 1 }));
    persistRegisteredDrafts(storage, tab, 1);
    off();
    storage.setItem('other', 'keep');
    clearAllDrafts(storage);
    expect(readStoredDraft(storage, tab, 'x')).toBeNull();
    expect(storage.getItem('other')).toBe('keep');
  });

  it('저장소가 깨졌거나 막혀도 예외 없이 null', () => {
    storage.setItem('awbs.draft:x', '{bad');
    expect(readStoredDraft(storage, 't', 'x')).toBeNull();
    const blocked = { length: 0, key: () => null, getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined };
    expect(readStoredDraft(blocked, 't', 'x')).toBeNull();
    expect(() => { persistRegisteredDrafts(blocked, 't', 1); }).not.toThrow();
    expect(() => { clearAllDrafts(blocked); }).not.toThrow();
    expect(typeof resolveTabId(blocked, { name: '' })).toBe('string');
  });
});
