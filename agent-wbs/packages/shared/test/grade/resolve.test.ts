import { describe, expect, test } from 'vitest';
import { DEFAULT_EXEC_POLICY, resolveRunGrade } from '../../src/grade/index.ts';
import type { Catalog, PastAttempt, ResolveInput } from '../../src/grade/index.ts';

const E = ['low', 'medium', 'high', 'xhigh', 'max'];
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const catalog: Catalog = {
  agent: 'Claude',
  models: [
    { modelId: OPUS, rank: 3, allowed: true, efforts: E },
    { modelId: SONNET, rank: 2, allowed: true, efforts: E },
  ],
};
const past = (kind: PastAttempt['kind'], modelId: string, effort: string, status: PastAttempt['status'] = 'completed'): PastAttempt => ({ kind, modelId, effort, status });
const DOWN = { ...DEFAULT_EXEC_POLICY, onUsage: 'down' as const };
const run = (o: Partial<ResolveInput> = {}) =>
  resolveRunGrade({
    kind: 'dev',
    taskGrade: { modelId: SONNET, effort: 'high', locked: false },
    task: { primaryDomain: 'FE', relatedDomains: [], devLevel: 3 },
    history: [],
    catalog,
    policy: DEFAULT_EXEC_POLICY,
    remainPct: 80,
    ...o,
  });

test('최초 시도·실패한 개발의 재시도는 Task 등급 그대로', () => {
  expect(run()).toMatchObject({ ok: true, grade: { modelId: SONNET, effort: 'high' }, adjust: { kind: 'none' }, notify: null });
  expect(run({ history: [past('dev', OPUS, 'max', 'failed')] })).toMatchObject({ grade: { modelId: SONNET, effort: 'high' } });
});

describe('재작업', () => {
  test('직전 개발 시도 기준 한 단계 상향 — QA 시도는 기준이 아니다', () => {
    expect(run({ kind: 'rework', history: [past('dev', SONNET, 'xhigh'), past('qa', OPUS, 'low')] })).toMatchObject({
      grade: { modelId: SONNET, effort: 'max' },
      adjust: { kind: 'up', from: { modelId: SONNET, effort: 'xhigh' }, alreadyTop: false },
    });
  });
  test('Effort 최상위면 위 모델', () => {
    expect(run({ kind: 'rework', history: [past('rework', SONNET, 'max')] })).toMatchObject({ grade: { modelId: OPUS, effort: 'max' }, notify: null });
  });
  test('최상위로 상향은 모든 단계를 기록한다', () => {
    const r = run({ kind: 'rework', history: [past('dev', SONNET, 'high')], policy: { ...DEFAULT_EXEC_POLICY, onRework: 'top' } });
    expect(r).toMatchObject({ grade: { modelId: OPUS, effort: 'max' }, notify: null });
    expect(r.ok && r.adjust.steps.map((s) => s.to)).toEqual(['xhigh', 'max', OPUS]);
  });
  test('같은 등급 유지 정책은 직전 등급을 유지하고 알리지 않는다', () => {
    const history = [past('dev', OPUS, 'max'), past('rework', OPUS, 'max'), past('rework', OPUS, 'max')];
    expect(run({ kind: 'rework', history, policy: { ...DEFAULT_EXEC_POLICY, onRework: 'same' } })).toMatchObject({
      grade: { modelId: OPUS, effort: 'max' }, adjust: { kind: 'keep' }, notify: null,
    });
  });
  test.each([
    [1, 0, 1], [1, 1, 2], [2, 0, null], [2, 1, 2], [3, 1, null], [3, 2, 3], [0, 5, null],
  ])('알림 %i회째, 최상위 등급의 이전 재작업 %i건 → %s', (escNotify, prior, want) => {
    const history = [past('dev', OPUS, 'max'), ...Array.from({ length: prior }, () => past('rework', OPUS, 'max'))];
    const r = run({ kind: 'rework', history, policy: { ...DEFAULT_EXEC_POLICY, escNotify } });
    expect(r).toMatchObject({ grade: { modelId: OPUS, effort: 'max' }, adjust: { kind: 'up', alreadyTop: true } });
    expect(r.ok && (r.notify?.count ?? null)).toBe(want);
  });
  test('고정 Task도 재작업 상향은 적용된다(고정은 하향만 막는다)', () => {
    expect(run({ kind: 'rework', taskGrade: { modelId: SONNET, effort: 'high', locked: true }, history: [past('dev', SONNET, 'high')] })).toMatchObject({ grade: { effort: 'xhigh' } });
  });
  test('직전 개발 시도가 없으면 등급을 추정하지 않는다', () => {
    expect(run({ kind: 'rework' })).toEqual({ ok: false, code: 'PREVIOUS_DEV_MISSING' });
  });
});

describe('재개', () => {
  test('중단된 같은 종류는 직전 등급 유지 — 사용량이 부족해도 낮추지 않는다', () => {
    expect(run({ history: [past('dev', OPUS, 'xhigh', 'interrupted')], policy: DOWN, remainPct: 5 })).toMatchObject({
      grade: { modelId: OPUS, effort: 'xhigh' }, adjust: { kind: 'resume', steps: [] },
    });
  });
  test('중단된 재작업은 다시 상향하지 않는다', () => {
    expect(run({ kind: 'rework', history: [past('dev', SONNET, 'high'), past('rework', SONNET, 'xhigh', 'interrupted')] })).toMatchObject({
      grade: { effort: 'xhigh' }, adjust: { kind: 'resume' },
    });
  });
  test('다른 종류의 중단은 재개로 보지 않는다', () => {
    expect(run({ kind: 'reverify', history: [past('qa', OPUS, 'max', 'interrupted')] })).toMatchObject({ grade: { modelId: SONNET, effort: 'high' }, adjust: { kind: 'none' } });
  });
});

describe('사용량', () => {
  test('기준 미만에서 한 단계 하향, 기준값과 같으면 유지', () => {
    expect(run({ policy: DOWN, remainPct: 19 })).toMatchObject({ grade: { effort: 'medium' }, adjust: { kind: 'down' } });
    expect(run({ policy: DOWN, remainPct: 20 })).toMatchObject({ grade: { effort: 'high' }, adjust: { kind: 'none' } });
  });
  test('대기 정책·미보고는 낮추지 않는다', () => {
    expect(run({ remainPct: 1 })).toMatchObject({ grade: { effort: 'high' } });
    expect(run({ policy: DOWN, remainPct: null })).toMatchObject({ grade: { effort: 'high' } });
  });
  test('고정·재작업 상향(이미 최상위 포함)·최저선은 낮추지 않는다', () => {
    expect(run({ policy: DOWN, remainPct: 5, taskGrade: { modelId: SONNET, effort: 'high', locked: true } })).toMatchObject({ grade: { effort: 'high' } });
    expect(run({ kind: 'rework', policy: DOWN, remainPct: 5, history: [past('dev', SONNET, 'high')] })).toMatchObject({ grade: { effort: 'xhigh' } });
    expect(run({ kind: 'rework', policy: DOWN, remainPct: 5, history: [past('dev', OPUS, 'max')] })).toMatchObject({ grade: { effort: 'max' } });
    expect(run({ policy: DOWN, remainPct: 5, task: { primaryDomain: 'DB', relatedDomains: [], devLevel: 3 } })).toMatchObject({ grade: { effort: 'high' } });
    expect(run({ kind: 'qa', policy: DOWN, remainPct: 5 })).toMatchObject({ grade: { effort: 'high' } });
  });
  test('같은 등급 유지 재작업은 상향이 아니므로 낮출 수 있다', () => {
    expect(run({ kind: 'rework', policy: { ...DOWN, onRework: 'same' }, remainPct: 5, history: [past('dev', SONNET, 'high')] })).toMatchObject({ grade: { effort: 'medium' }, adjust: { kind: 'down' } });
  });
  test('0%면 정책·재개·재작업과 무관하게 대기', () => {
    const wait = { ok: false, code: 'USAGE_EXHAUSTED' };
    expect(run({ remainPct: 0 })).toEqual(wait);
    expect(run({ remainPct: 0, policy: DOWN, kind: 'rework', history: [past('dev', SONNET, 'high')] })).toEqual(wait);
    expect(run({ remainPct: 0, history: [past('dev', OPUS, 'high', 'interrupted')] })).toEqual(wait);
  });
  test('검증 최저선을 알 수 없으면 낮추지 않고 거부', () => {
    expect(run({ kind: 'qa', policy: DOWN, remainPct: 5, task: { primaryDomain: 'FE', relatedDomains: [], devLevel: null } })).toEqual({ ok: false, code: 'FLOOR_UNDETERMINED' });
  });
});

describe('쓸 수 없는 등급', () => {
  test.each([
    ['ultra', SONNET, 'ultra', 'EFFORT_UNMAPPED'],
    ['미확인 모델', 'claude-next', 'high', 'MODEL_UNKNOWN'],
  ])('%s는 고정이어도 실행하지 않는다', (_l, modelId, effort, code) => {
    expect(run({ taskGrade: { modelId, effort, locked: true } })).toEqual({ ok: false, code });
  });
  test('직전 모델의 허용이 해제되면 재판단된 Task 등급에서 시작한다', () => {
    const c: Catalog = { agent: 'Claude', models: [{ modelId: OPUS, rank: 3, allowed: false, efforts: E }, { modelId: SONNET, rank: 2, allowed: true, efforts: E }] };
    expect(run({ kind: 'rework', catalog: c, history: [past('dev', OPUS, 'low')] })).toMatchObject({
      grade: { modelId: SONNET, effort: 'xhigh' }, adjust: { previousUnusable: 'MODEL_NOT_ALLOWED' },
    });
    expect(run({ catalog: c, history: [past('dev', OPUS, 'low', 'interrupted')] })).toMatchObject({
      grade: { modelId: SONNET, effort: 'high' }, adjust: { kind: 'resume', previousUnusable: 'MODEL_NOT_ALLOWED' },
    });
  });
});
