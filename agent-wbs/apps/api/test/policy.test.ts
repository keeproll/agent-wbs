// M2-08 실행 정책·모델·하위 Agent의 순수 규칙(DB 없이). DB를 쓰는 검증은 policy.db.test.ts.
// 핵심: D-29 「허용 해제 → 재판단 → 재개 이력」을 순수 함수만으로 끝까지 잇는다.
import { describe, expect, test } from 'vitest';
import { DEFAULT_EXEC_POLICY, DEFAULT_MODEL_SETTINGS, resolveRunGrade, type Catalog } from '@awbs/shared';
import {
  catalogOf, gradeText, gradesToRejudge, planModelChange, resumeRegradeEntry, type GradeRow, type ModelRow,
} from '../src/policy/rules.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const rows: ModelRow[] = [
  { agent: 'Claude', modelId: 'claude-opus-5-5', label: 'Opus 5.5', allowed: true, isNew: false, efforts: EFFORTS },
  { agent: 'Claude', modelId: 'claude-sonnet-5-5', label: 'Sonnet 5.5', allowed: true, isNew: false, efforts: EFFORTS },
  { agent: 'Claude', modelId: 'claude-fable-5-2', label: 'Fable 5.2', allowed: false, isNew: true, efforts: null },
  { agent: 'Codex', modelId: 'gpt-6.2-sol', label: 'gpt-6.2-sol', allowed: true, isNew: false, efforts: EFFORTS },
];

describe('planModelChange — PUT /api/settings/models', () => {
  test('허용을 바꾸고, 바꾼 모델은 「신규」 표시를 끈다. 해제·허용된 모델 목록을 돌려준다', () => {
    const plan = planModelChange(rows, DEFAULT_MODEL_SETTINGS, { models: [
      { agent: 'Claude', id: 'claude-opus-5-5', allowed: false },
      { agent: 'Claude', id: 'claude-fable-5-2', allowed: true },
    ] });
    expect(plan.errors).toEqual([]);
    expect(plan.disallowed).toEqual([{ agent: 'Claude', modelId: 'claude-opus-5-5' }]);
    expect(plan.rows.find((r) => r.modelId === 'claude-fable-5-2')).toMatchObject({ allowed: true, isNew: false });
    expect(plan.rows.find((r) => r.modelId === 'claude-sonnet-5-5')).toMatchObject({ allowed: true });
  });

  test('Agent마다 허용 모델은 최소 1개(G§7.2) — 마지막 허용 모델 해제는 거부', () => {
    const plan = planModelChange(rows, DEFAULT_MODEL_SETTINGS, { models: [{ agent: 'Codex', id: 'gpt-6.2-sol', allowed: false }] });
    expect(plan.errors).toEqual([{ path: 'models', rule: 'minAllowed', message: expect.stringContaining('Codex') }]);
  });

  test('보고되지 않은 모델·같은 모델 두 번은 거부', () => {
    const plan = planModelChange(rows, DEFAULT_MODEL_SETTINGS, { models: [
      { agent: 'Codex', id: 'gpt-9', allowed: true },
      { agent: 'Claude', id: 'claude-sonnet-5-5', allowed: true },
      { agent: 'Claude', id: 'claude-sonnet-5-5', allowed: false },
    ] });
    expect(plan.errors.map((e) => [e.path, e.rule])).toEqual([['models.0.id', 'exists'], ['models.2', 'unique']]);
  });

  test('순서(rankOrder)는 아래부터 1, 2, …. 순서에 없는 보고 모델은 규칙대로 끼워 넣는다', () => {
    const plan = planModelChange(rows, DEFAULT_MODEL_SETTINGS, {
      models: [], rankOrder: { Claude: ['claude-opus-5-5', 'claude-sonnet-5-5'], Codex: [] },
    });
    expect(plan.errors).toEqual([]);
    // fable은 순서에 없어 맨 아래, 그다음 opus < sonnet(팀장이 정한 순서)
    expect(plan.settings.rankOrder.Claude).toEqual(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(plan.settings.rankOrder.Codex).toEqual(['gpt-6.2-sol']);
    expect(plan.ranks.get('Claude|claude-sonnet-5-5')).toBe(3);
    expect(plan.ranks.get('Claude|claude-fable-5-2')).toBe(1);
    // 보내지 않은 항목은 그대로
    expect(plan.settings.claudeModels).toEqual(DEFAULT_MODEL_SETTINGS.claudeModels);
  });
});

const catalogs = (allowedOpus: boolean): Record<'Claude' | 'Codex', Catalog> => {
  const plan = planModelChange(rows, DEFAULT_MODEL_SETTINGS, { models: [] });
  const changed = plan.rows.map((r) => (r.modelId === 'claude-opus-5-5' ? { ...r, allowed: allowedOpus } : r));
  return { Claude: catalogOf('Claude', changed, plan.ranks), Codex: catalogOf('Codex', changed, plan.ranks) };
};

const grade = (over: Partial<GradeRow>): GradeRow => ({
  taskId: 't1', taskKey: 'TASK-0001', status: 'paused', role: 'dev', agent: 'Claude', modelId: 'claude-opus-5-5', effort: 'high',
  locked: false, primaryDomain: 'BE', relatedDomains: [], devLevel: 3, ...over,
});

describe('gradesToRejudge — 재판단 대상', () => {
  test('허용 해제된 모델을 쓰는 진행 전·중 Task(고정 포함), 완료·취소는 제외', () => {
    const list = gradesToRejudge([
      grade({}),
      grade({ taskId: 't2', taskKey: 'TASK-0002', locked: true }),
      grade({ taskId: 't3', taskKey: 'TASK-0003', status: 'done' }),
      grade({ taskId: 't4', taskKey: 'TASK-0004', status: 'cancelled' }),
      grade({ taskId: 't5', taskKey: 'TASK-0005', modelId: 'claude-sonnet-5-5' }),
    ], catalogs(false), DEFAULT_EXEC_POLICY.floors);
    expect(list.map((g) => [g.taskKey, g.reason])).toEqual([['TASK-0001', 'MODEL_NOT_ALLOWED'], ['TASK-0002', 'MODEL_NOT_ALLOWED']]);
  });

  test('최저선을 켜면 그 아래인 등급(고정 제외)이 재판단 대상', () => {
    const list = gradesToRejudge([
      grade({ primaryDomain: 'DB', effort: 'medium' }),
      grade({ taskId: 't2', taskKey: 'TASK-0002', primaryDomain: 'DB', effort: 'medium', locked: true }),
      grade({ taskId: 't3', taskKey: 'TASK-0003', role: 'qa', agent: 'Codex', modelId: 'gpt-6.2-sol', effort: 'medium', devLevel: 4 }),
    ], catalogs(true), { verifyGeDev: true, dbHigh: true });
    expect(list.map((g) => [g.taskKey, g.role, g.reason])).toEqual([['TASK-0001', 'dev', 'BELOW_FLOOR'], ['TASK-0003', 'qa', 'BELOW_FLOOR']]);
    expect(gradesToRejudge([grade({ primaryDomain: 'DB', effort: 'medium' })], catalogs(true), { verifyGeDev: true, dbHigh: false })).toEqual([]);
  });
});

describe('D-29: 허용 해제 → 재판단 → 재개 이력 (순수 판정으로 끝까지)', () => {
  const interrupted = { kind: 'dev' as const, status: 'interrupted' as const, modelId: 'claude-opus-5-5', effort: 'high' };
  const resolve = (taskGrade: { modelId: string; effort: string; locked: boolean }, allowedOpus: boolean) => resolveRunGrade({
    kind: 'dev', taskGrade, task: { primaryDomain: 'BE', relatedDomains: [], devLevel: 3 }, history: [interrupted],
    catalog: catalogs(allowedOpus).Claude, policy: DEFAULT_EXEC_POLICY, remainPct: 50,
  });

  test('허용 중이면 같은 등급으로 재개(재판단 없음)', () => {
    const result = resolve({ modelId: 'claude-opus-5-5', effort: 'high', locked: false }, true);
    expect(result).toMatchObject({ ok: true, grade: { modelId: 'claude-opus-5-5', effort: 'high' }, adjust: { kind: 'resume' } });
    expect(result.ok && resumeRegradeEntry('TASK-0001', result)).toBeNull();
  });

  test('허용 해제 직후(재판단 전)에는 재개하지 않는다', () => {
    expect(resolve({ modelId: 'claude-opus-5-5', effort: 'high', locked: false }, false)).toEqual({ ok: false, code: 'MODEL_NOT_ALLOWED' });
  });

  test('재판단으로 Task 등급이 허용 모델로 바뀌면 그 새 등급으로 재개하고, 이전→이후·사유를 이력으로 남긴다', () => {
    const result = resolve({ modelId: 'claude-sonnet-5-5', effort: 'high', locked: false }, false);
    expect(result).toMatchObject({ ok: true, grade: { modelId: 'claude-sonnet-5-5', effort: 'high' },
      adjust: { kind: 'regrade', replaced: { grade: { modelId: 'claude-opus-5-5', effort: 'high' }, reason: 'MODEL_NOT_ALLOWED' } } });
    expect(result.ok && resumeRegradeEntry('TASK-0001', result)).toEqual({
      kind: '실행 등급',
      text: 'TASK-0001 재개 등급 재판단 — 중단 시도의 모델(claude-opus-5-5)이 허용 해제되어 재판단한 등급으로 재개',
      before: { modelId: 'claude-opus-5-5', effort: 'high' },
      after: { modelId: 'claude-sonnet-5-5', effort: 'high' },
      ref: { taskKey: 'TASK-0001', adjust: 'regrade', reason: 'MODEL_NOT_ALLOWED' },
    });
  });

  test('재작업에서 직전 등급을 대체한 경우는 재개 이력이 아니다(재개만 D-29)', () => {
    const rework = resolveRunGrade({
      kind: 'rework', taskGrade: { modelId: 'claude-sonnet-5-5', effort: 'high', locked: false },
      task: { primaryDomain: 'BE', relatedDomains: [], devLevel: 3 },
      history: [{ kind: 'dev', status: 'completed', modelId: 'claude-opus-5-5', effort: 'high' }],
      catalog: catalogs(false).Claude, policy: DEFAULT_EXEC_POLICY, remainPct: 50,
    });
    expect(rework).toMatchObject({ ok: true, adjust: { kind: 'up', replaced: { reason: 'MODEL_NOT_ALLOWED' } } });
    expect(rework.ok && resumeRegradeEntry('TASK-0001', rework)).toBeNull();
  });

  test('gradeText는 화면용 짧은 표기', () => {
    expect(gradeText({ modelId: 'claude-opus-5-5', effort: 'high' })).toBe('claude-opus-5-5 · high');
  });
});
