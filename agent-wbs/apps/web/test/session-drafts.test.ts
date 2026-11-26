import { beforeEach, describe, expect, it } from 'vitest';
import {
  discardStoredDraft, persistRegisteredDrafts, readStoredDraft, registerDraft, stripSecrets,
} from '../src/shared/state/sessionDrafts.ts';

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

describe('세션 만료 초안 보관(조정자 결정)', () => {
  let storage: MemoryStorage;
  beforeEach(() => { storage = new MemoryStorage(); });

  it('비밀값 필드(비밀번호·토큰·키·secret)는 깊은 곳까지 빼고 저장한다', () => {
    expect(stripSecrets({
      title: 't', password: 'p', botToken: 'x', smtp: { host: 'h', pass: 'y', apiKey: 'k' }, list: [{ secret: 's', name: 'n' }], note: 'token 설명',
    }, ['customField'])).toEqual({ title: 't', smtp: { host: 'h' }, list: [{ name: 'n' }], note: 'token 설명' });
    expect(stripSecrets({ customField: 'c', keep: 1 }, ['customField'])).toEqual({ keep: 1 });
  });

  it('세션이 끊기면 등록된 화면별 초안만 sessionStorage에 남기고, 등록 해제한 초안은 남기지 않는다', () => {
    const offA = registerDraft('task:A:title', () => ({ label: 'A 제목', path: '/wbs/A', data: { title: 'a', token: 't' } }));
    const offB = registerDraft('task:B:title', () => ({ label: 'B 제목', path: '/wbs/B', data: { title: 'b' } }));
    offB();
    persistRegisteredDrafts(storage, 1_800_000_000_000);
    expect(readStoredDraft(storage, 'task:A:title')).toEqual({ label: 'A 제목', path: '/wbs/A', savedAt: 1_800_000_000_000, data: { title: 'a' } });
    expect(readStoredDraft(storage, 'task:B:title')).toBeNull();
    discardStoredDraft(storage, 'task:A:title');
    expect(readStoredDraft(storage, 'task:A:title')).toBeNull();
    offA();
  });

  it('저장소가 깨졌거나 막혀도 예외 없이 null', () => {
    storage.setItem('awbs.draft:x', '{bad');
    expect(readStoredDraft(storage, 'x')).toBeNull();
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined };
    expect(readStoredDraft(blocked, 'x')).toBeNull();
    expect(() => { persistRegisteredDrafts(blocked, 1); }).not.toThrow();
  });
});
