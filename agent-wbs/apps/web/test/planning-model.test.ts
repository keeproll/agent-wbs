import { describe, expect, it } from 'vitest';
import { cpReason, isDiff, planOps, planStep, replanRows } from '../src/features/planning/model.ts';
import type { PlanningReview, ReplanItem } from '../src/features/planning/model.ts';

const op = (task: string) => ({ op: 'modify', task, field: 'doneCond', after: 'x' }) as unknown as PlanningReview['ops'][number];
const rv = (over: Partial<PlanningReview>): PlanningReview => ({
  id: 'r', topic: '주제', kind: 'agree', codex: 'a', claude: 'b', choice: null, memo: '', ops: [], codexOps: [], claudeOps: [], updatedAt: 't', ...over,
});

describe('이견 여부: 원본 값(diff)과 서버 값(이견)을 같이 받는다', () => {
  it('diff·이견은 이견, 그 밖은 일치', () => {
    expect(isDiff('diff')).toBe(true);
    expect(isDiff('이견')).toBe(true);
    expect(isDiff('agree')).toBe(false);
    expect(isDiff('일치')).toBe(false);
  });
});

describe('최종 제안의 변경(원본 planOps P L5692, 서버 chosenOps와 같은 규칙)', () => {
  it('일치는 공통 변경, 이견은 고른 쪽 변경, 보류는 공통 변경(대개 비어 있음)', () => {
    const reviews = [
      rv({ id: '1', ops: [op('TASK-0001')] }),
      rv({ id: '2', kind: 'diff', choice: 'codex', codexOps: [op('TASK-0002')], claudeOps: [op('TASK-0003')] }),
      rv({ id: '3', kind: 'diff', choice: 'claude', codexOps: [op('TASK-0004')], claudeOps: [op('TASK-0005')] }),
      rv({ id: '4', kind: 'diff', choice: 'hold', codexOps: [op('TASK-0006')] }),
    ];
    expect(planOps(reviews).map((o) => (o as unknown as { task: string }).task)).toEqual(['TASK-0001', 'TASK-0002', 'TASK-0005']);
  });
});

describe('단계 표시(원본 plStep P L5704)', () => {
  it('미조정 이견이 있으면 4단계', () => {
    const s = planStep([rv({ kind: 'diff' })], null);
    expect(s.label).toBe('4단계 · 이견 식별 · 조정');
    expect(s.steps.map((x) => x.cls)).toEqual(['done', 'done', 'done', 'cur', '', '', '']);
  });
  it('조정을 마치고 CP가 없으면 5단계, 승인 대기 6, 승인됨 7, 반영 완료', () => {
    expect(planStep([], null).label).toBe('5단계 · Change Proposal 작성');
    expect(planStep([], 'review').label).toBe('6단계 · 팀장 승인');
    expect(planStep([], 'draft').label).toBe('6단계 · 팀장 승인');
    expect(planStep([], 'approved').label).toBe('7단계 · 승인된 WBS 반영');
    expect(planStep([], 'applied').label).toBe('완료 — WBS 반영됨');
    expect(planStep([], 'rejected').label).toBe('제안 반려 — 재조정');
  });
});

describe('CP 사유 문구(원본 makeCpFromPlan P L5718)', () => {
  it('주제별 일치·채택 결과와 메모를 잇는다', () => {
    expect(cpReason('PLN-007', [rv({ topic: '응답 Task' }), rv({ topic: '설계 위치', kind: 'diff', choice: 'claude', memo: '범위 작음' })]))
      .toBe('Planning PLN-007 교차 검토 결과 — 응답 Task: 일치 / 설계 위치: Claude 안 (범위 작음)');
  });
});

describe('재조정 이력 행(원본 rps P L5966)', () => {
  const item = (id: string, end: string, extra: Partial<ReplanItem> = {}): ReplanItem => ({
    replanId: id, baselineVersion: 2, projectEnd: end, range: { lo: '2026-11-06', hi: '2026-11-10' }, moved: [],
    trigger: 't', actor: 'Planning', status: 'applied', rate: 0.85, at: '2026-11-03T01:00:00.000Z', ...extra,
  });
  it('바로 앞(더 오래된) 기록과 비교해 밀림·당겨짐·초기를 보인다', () => {
    const rows = replanRows([item('RP-003', '2026-11-09'), item('RP-002', '2026-11-06'), item('RP-001', '2026-11-08')]);
    expect(rows.map((r) => [r.id, r.dL, r.dC, r.endL])).toEqual([
      ['RP-003', '+3일 밀림', 'sc sc-bad', '11-06 → 11-09'],
      ['RP-002', '2일 당겨짐', 'sc sc-ok', '11-08 → 11-06'],
      ['RP-001', '초기', 'sc sc-none', '11-08'],
    ]);
    expect(rows[0]).toMatchObject({ rangeL: '11-06 ~ 11-10', rateL: '85%', v: '기준 v2', n: '0건' });
  });
  it('자동 재조정이 꺼져 기록만 된 대기(pending)는 기준 버전 없이 「반영 대기」', () => {
    const rows = replanRows([item('RP-004', '2026-11-09', { baselineVersion: null, status: 'pending' })]);
    expect(rows[0]).toMatchObject({ v: '반영 대기', pending: true });
  });
  it('변경 Task 행: 종류·전후·차이', () => {
    const rows = replanRows([item('RP-002', '2026-11-09', { moved: [
      { taskKey: 'TASK-0007', kind: 'delayed', before: '2026-11-05', after: '2026-11-07', deltaDays: 2 },
      { taskKey: 'TASK-0013', kind: 'new', before: null, after: '2026-11-08', deltaDays: null },
    ] })]);
    expect(rows[0]?.moved.map((m) => [m.task, m.kind, m.kindC, m.before, m.after, m.delta])).toEqual([
      ['TASK-0007', '밀림', 'sc sc-bad', '11-05', '11-07', '+2일'],
      ['TASK-0013', '신규', 'sc sc-none', '—', '11-08', '—'],
    ]);
  });
});
