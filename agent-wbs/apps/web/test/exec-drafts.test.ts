import { describe, expect, it } from 'vitest';
import { createDraftStore, emptyDraft } from '../src/features/exec/messageDrafts.ts';

describe('Task별 메시지 초안(UAT-MSG-01, P draftOf L5399)', () => {
  it('처음에는 담당 Agent·추가 지시·빈 본문', () => {
    const s = createDraftStore();
    expect(s.get('TASK-0005', 'Claude')).toEqual(emptyDraft('Claude'));
    expect(emptyDraft('Codex')).toEqual({ type: '추가 지시', toAgent: 'Codex', body: '', attemptId: null });
  });
  it('Task마다 따로 보관하고 다른 Task로 옮겨도 남는다', () => {
    const s = createDraftStore();
    s.set('TASK-0005', { ...emptyDraft('Claude'), body: 'A' });
    s.set('TASK-0007', { ...emptyDraft('Claude'), body: 'B' });
    expect(s.get('TASK-0005', 'Claude').body).toBe('A');
    expect(s.get('TASK-0007', 'Claude').body).toBe('B');
  });
  it('보낸 뒤 본문만 비운다(유형·대상은 유지)', () => {
    const s = createDraftStore();
    s.set('T', { type: '질문', toAgent: 'Codex', body: 'x', attemptId: 'a1' });
    s.clearBody('T');
    expect(s.get('T', 'Claude')).toEqual({ type: '질문', toAgent: 'Codex', body: '', attemptId: 'a1' });
  });
  it('로그아웃하면 모두 지운다', () => {
    const s = createDraftStore();
    s.set('T', { ...emptyDraft('Claude'), body: 'x' });
    s.clearAll();
    expect(s.get('T', 'Claude').body).toBe('');
  });
  it('구독자에게 바뀜을 알린다', () => {
    const s = createDraftStore();
    let n = 0;
    const off = s.subscribe(() => { n++; });
    s.set('T', emptyDraft('Claude'));
    off();
    s.set('T', emptyDraft('Codex'));
    expect(n).toBe(1);
  });
});
