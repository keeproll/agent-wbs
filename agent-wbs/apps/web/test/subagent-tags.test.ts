import { describe, expect, it } from 'vitest';
import { designatedLabel, subagentView, type AttemptSubagents } from '../src/shared/subagents.ts';

const none: AttemptSubagents = { designated: [], used: null, observed: null };

describe('지정 · 실제 하위 Agent 태그 문구(원본 P L5309)', () => {
  it('값이 없으면 아무 태그도 없다(지어내지 않음)', () => {
    expect(subagentView(none, false)).toEqual({ designated: null, used: null, missing: null });
    expect(subagentView(none, true)).toEqual({ designated: null, used: null, missing: null });
    expect(designatedLabel(none)).toBeNull();
  });

  it('끝난 시도: 세션 기록 확인 — 정의 밖 이름은 버전 없이, 초록 태그', () => {
    const s: AttemptSubagents = { designated: [{ id: 'db-migrator', version: 2 }], used: { confirm: 'confirmed', items: [{ id: 'db-migrator', version: 2, count: 2 }, { id: 'Explore', version: null, count: 1 }] }, observed: null };
    expect(subagentView(s, false)).toEqual({ designated: 'db-migrator v2', used: { label: 'db-migrator v2 ×2, Explore ×1 · 세션 기록 확인', cls: 'tag new' }, missing: null });
    expect(designatedLabel(s)).toBe('db-migrator v2');
  });

  it('끝난 시도: 일부 관측은 노란 태그, 빠진 지정이 있어도 「지정 미사용」을 띄우지 않는다', () => {
    const s: AttemptSubagents = { designated: [{ id: 'qa-verifier', version: 4 }, { id: 'security-reviewer', version: 1 }], used: { confirm: 'partial', items: [{ id: 'qa-verifier', version: 4, count: 1 }] }, observed: null };
    expect(subagentView(s, false)).toEqual({ designated: 'qa-verifier v4, security-reviewer v1', used: { label: 'qa-verifier v4 ×1 · 일부 관측', cls: 'tag chg' }, missing: null });
  });

  it('끝난 시도: 확인된 보고에 없는 지정은 「지정 미사용」(원본 ATT-0007-1)', () => {
    const s: AttemptSubagents = { designated: [{ id: 'fe-implementer', version: 3 }], used: { confirm: 'confirmed', items: [{ id: 'Explore', version: null, count: 1 }] }, observed: null };
    expect(subagentView(s, false)).toMatchObject({ used: { label: 'Explore ×1 · 세션 기록 확인' }, missing: '지정 미사용 — fe-implementer' });
    // 확인됐지만 아무것도 부르지 않았으면 실제 태그는 없고 경고만 남는다.
    expect(subagentView({ ...s, used: { confirm: 'confirmed', items: [] } }, false)).toEqual({ designated: 'fe-implementer v3', used: null, missing: '지정 미사용 — fe-implementer' });
  });

  it('실행 중: 관측 수(추정). 끊기면 미확인 · 보유, 노란 태그. 관측이 없으면 태그 없음', () => {
    const s: AttemptSubagents = { designated: [{ id: 'be-implementer', version: 3 }], used: null, observed: { count: 2, state: 'ok' } };
    expect(subagentView(s, true).used).toEqual({ label: '실행 중 · 관측 2개 (추정)', cls: 'tag' });
    expect(subagentView({ ...s, observed: { count: 2, state: 'unconfirmed' } }, true).used).toEqual({ label: '실행 중 · 관측 2개 (추정 — 미확인 · 보유)', cls: 'tag chg' });
    expect(subagentView({ ...s, observed: null }, true).used).toBeNull();
    // 실행 중에는 사후 보고가 있어도 관측을 보이고, 미사용 판정은 하지 않는다.
    expect(subagentView({ ...s, used: { confirm: 'confirmed', items: [] } }, true)).toMatchObject({ used: { label: '실행 중 · 관측 2개 (추정)' }, missing: null });
  });
});
