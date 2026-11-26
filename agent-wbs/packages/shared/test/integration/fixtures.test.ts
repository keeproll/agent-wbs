// M1 결합: 공용 fixture → 순수 판정 → API 스키마
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, test } from 'vitest';
import {
  AGENTS, canonicalPreview, DEFAULT_MODEL_SETTINGS, modelRanks, placeModel, completionGate, concurrency, DEFAULT_EXEC_POLICY, DEFAULT_SPLIT_SETTINGS, effectiveCaps, heldSubagents,
  judgementOf, memoryPressure, parallelWidth, proposalJudgementHolds, recommendedCaps, replanDiff, resolveRunGrade, schedule, ScheduleError,
  simulateProposal, validateSplitProposal,
} from '@awbs/shared';
import type { Baseline, Catalog, JudgedRules, PastAttempt, ResolveInput, ScheduleInput } from '@awbs/shared';
import { gradeAdjust, OPERATIONS, proposalReasons, SCHEDULE_ERROR, scheduleWarning, simulationOp } from '@awbs/shared/api';
import type { WireProposalOp } from '@awbs/shared/api';
import * as m from '../../src/api/models.ts';
import { completion } from '../domain/fixtures.ts';
import { dep, HASH, judged, judgement, newTask, snapshot, task } from '../proposal/fixtures.ts';

const ajv = new Ajv({ strict: false });
interface Fixture {
  id: string;
  body: Record<string, unknown>;
  response: Record<string, unknown>;
}
const load = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(`../../../../contracts/fixtures/${name}.json`, import.meta.url), 'utf8')) as T[];
const fixture = (name: 'lead' | 'runner', id: string) => {
  const found = load<Fixture>(name).find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
};
const responds = (id: string, value: unknown) => {
  const valid = ajv.validate(OPERATIONS.find((item) => item.id === id)?.responses[200] ?? false, value);
  return valid ? null : ajv.errorsText();
};

describe('변경 제안', () => {
  const ids = ['TASK-0003', 'TASK-0005', 'TASK-0006', 'TASK-0008', 'TASK-0011', 'TASK-0012'];
  const base = {
    ...snapshot(
      ids.map((id) => task(id, id === 'TASK-0003' ? 'running' : 'ready')),
      [dep('TASK-0005', 'TASK-0006', 'SS'), dep('TASK-0005', 'TASK-0008', 'SS'), dep('TASK-0003', 'TASK-0008')],
    ),
    phases: [{ id: 'PH-1', wps: ['WP-03', 'WP-06'].map((id) => ({ id, tasks: id === 'WP-03' ? ids : [] })) }],
  };
  const preview = (result: ReturnType<typeof simulateProposal>, problems: Parameters<typeof proposalReasons>[0]) => ({
    previewHash: String(canonicalPreview(result).length), idMap: result.idMap, diff: result.diff, impact: result.impact,
    ...proposalReasons(problems),
  });

  test('lead fixture의 취소 CP 영향이 판정 결과와 같다(D-27)', () => {
    const { response } = fixture('lead', 'previewProposal');
    const ops = (fixture('lead', 'applyProposal').response.proposal as { ops: WireProposalOp[] }).ops;
    const result = simulateProposal(base, ops.map(simulationOp));
    expect(result.issues).toEqual([]);
    expect(result.diff).toEqual(response.diff);
    expect(result.impact).toMatchObject(response.impact as object);
    expect(responds('previewProposal', preview(result, result.issues))).toBeNull();
  });

  test('runner fixture의 Planning CP가 시뮬레이션되고 결과가 미리보기 스키마를 통과한다', () => {
    const { body } = fixture('runner', 'submitPlanningProposal');
    const result = simulateProposal(base, (body.ops as WireProposalOp[]).map(simulationOp));
    expect(result.issues).toEqual([]);
    expect(result.idMap).toEqual({ 'NEW-1': 'TASK-0021' });
    expect(result.next.tasks.find((item) => item.id === 'TASK-0021')).toMatchObject({
      workType: 'Implementation', primaryDomain: 'BE', relatedDomains: ['API'], estimate: null, judgedRules: null,
    });
    expect(result.next.tasks.find((item) => item.id === 'TASK-0012')).toMatchObject({ priority: 0, title: '새 제목' });
    const holds = proposalJudgementHolds(base, result, { before: {}, after: {} }, [], DEFAULT_SPLIT_SETTINGS);
    const value = preview(result, [...result.issues, ...holds]);
    expect(value.holdReasons.length).toBeGreaterThan(0);
    expect(value.holdReasons.every((item) => item.code === 'JUDGEMENT_MISSING')).toBe(true);
    expect(responds('previewProposal', value)).toBeNull();
  });

  test('판단 job fixture의 저장된 ops도 같은 변환을 지난다', () => {
    const jobs = load<{ kind: string; response: { job: { payload: { proposal: { ops: WireProposalOp[] } | null } } } }>('judgement-jobs');
    const converted = jobs.flatMap(({ response }) => response.job.payload.proposal?.ops ?? []);
    expect(converted.length).toBeGreaterThan(0);
    for (const { response } of jobs) {
      const ops = response.job.payload.proposal?.ops;
      if (ops) expect(simulateProposal(base, ops.map(simulationOp)).issues).toEqual([]);
    }
  });

  test('simulationOp: 추정·신뢰도·AC 방법·판단 기록, 모든 op', () => {
    const t = { title: '신규', type: 'Design', domain: 'DB', wp: 'WP-03', priority: 1, assignee: 'Claude', verifier: 'Codex',
      purpose: 'p', doneCond: 'd' } as const;
    const hash = 'a'.repeat(64);
    const stored = { schemaVersion: 1, items: [judgement('revert', { subjectHash: hash })] } as const satisfies JudgedRules;
    const wire: WireProposalOp[] = [
      { op: 'add', ref: 'NEW-1', preds: [{ pred: 'TASK-0003', type: 'SS' }],
        t: { ...t, est: 2, lo: 0, ac: [{ given: 'g', when: 'w', then: 't' }], judgedRules: stored } },
      { op: 'add', ref: 'NEW-2', preds: [], t: { ...t, est: 2, lo: 1, hi: 3, conf: '상', rel: ['BE'] } },
      { op: 'modify', task: 'TASK-0005', field: 'acAdd', before: null, after: 'x' },
      { op: 'remove', task: 'TASK-0011' },
      { op: 'dep-add', pred: 'TASK-0005', succ: 'TASK-0012', type: 'FS' },
      { op: 'dep-remove', pred: 'TASK-0005', succ: 'TASK-0006' },
    ];
    for (const op of wire) expect(ajv.validate(m.ProposalOp, op), `${op.op} ${ajv.errorsText()}`).toBe(true);
    const [first, second, ...rest] = wire.map(simulationOp);
    expect(first).toMatchObject({ workPackageId: 'WP-03', preds: [{ pred: 'TASK-0003', type: 'SS' }], task: {
      estimate: { est: 2, lo: 0, hi: null, confidence: '하' }, ac: [{ method: '' }], judgedRules: stored, relatedDomains: [],
    } });
    expect(second).toMatchObject({ task: { estimate: { est: 2, lo: 1, hi: 3, confidence: '상' }, relatedDomains: ['BE'], judgedRules: null } });
    expect(rest).toEqual([
      { op: 'modify', task: 'TASK-0005', field: 'acAdd', after: 'x' }, wire[3], wire[4], wire[5],
    ]);
    const taskOf = first?.op === 'add' ? first.task.judgedRules ?? null : null;
    expect(judgementOf(taskOf, 'revert', hash).state).toBe('met');
  });

  test('판단 fixture에 서버 hash를 붙이면 그대로 판정된다', () => {
    const { body } = fixture('runner', 'submitProposalJudgements');
    const [entry] = body.judgements as { judgedRules: JudgedRules }[];
    expect(ajv.validate(m.JudgedRules, entry?.judgedRules)).toBe(true);
    const hash = entry?.judgedRules.items[0]?.subjectHash ?? '';
    expect(judgementOf(entry?.judgedRules ?? null, 'contract', hash).state).toBe('met');
    expect(judgementOf(entry?.judgedRules ?? null, 'contract', 'e'.repeat(64)).state).toBe('missing');
  });

  test('보류와 반영 불가를 나눈다: D-33~35만 holdReasons, 나머지는 issues', () => {
    const blocked = simulateProposal(
      snapshot([task('TASK-0001', 'running'), task('TASK-0002')]),
      [{ op: 'dep-add', pred: 'TASK-0002', succ: 'TASK-0001' }, { op: 'modify', task: 'TASK-0009', field: 'title', after: 'x' }],
    );
    const split = validateSplitProposal(snapshot([task('TASK-0001')]), 'TASK-0001', [
      { op: 'add', ref: 'NEW-1', workPackageId: 'WP-1', task: newTask() }, { op: 'remove', task: 'TASK-0001' },
    ], {
      splitJudgements: { schemaVersion: 1, items: [judgement('ac_meaning', { result: 'not_met' })] }, splitSubjectHash: HASH,
      taskHashes: { before: {}, after: {} },
      taskJudgements: [{ taskKey: 'TASK-0077', judgedRules: judged() }],
    });
    const value = preview(blocked, [...blocked.issues, ...split.problems, { code: 'ORDER_NOT_PRESERVED', taskKey: 'TASK-0001', message: 'm' }]);
    expect([...new Set(value.holdReasons.map((item) => item.code))].sort()).toEqual([
      'ACTIVE_TASK_BLOCKED', 'JUDGEMENT_MISSING', 'JUDGEMENT_NOT_MET', 'ORDER_NOT_PRESERVED',
    ]);
    expect(value.issues).toContainEqual(expect.objectContaining({ code: 'TASK_NOT_FOUND', index: 1 }));
    expect(value.issues).toContainEqual(expect.objectContaining({ code: 'VALIDATION_FAILED', index: null }));
    expect(value.holdReasons).toContainEqual(expect.objectContaining({ code: 'JUDGEMENT_NOT_MET', rule: 'ac_meaning' }));
    expect(responds('previewProposal', value)).toBeNull();
  });
});

describe('등급', () => {
  const { body } = fixture('runner', 'reportModels');
  // 보고가 없는 모델(efforts null)은 쓸 수 있는 값이 없다.
  // rank는 보고값이 아니라 서버 설정 순서에서 계산한다(owner 2026-11-26 아이템 8). 설정에 없는 모델은 규칙대로 끼운다.
  const reported = body.models as { id: string; efforts: string[] | null }[];
  const order = reported.reduce<string[]>(
    (acc, { id }) => placeModel(acc, id, 'Codex', DEFAULT_MODEL_SETTINGS.codexFamilyOrder),
    [...DEFAULT_MODEL_SETTINGS.rankOrder.Codex],
  );
  const ranks = modelRanks(order);
  const catalog: Catalog = {
    agent: body.agent as Catalog['agent'],
    models: reported.map(({ id, efforts }) => ({ modelId: id, rank: ranks.get(id) ?? 0, allowed: true, efforts: efforts ?? [] })),
  };
  const past = (patch: Partial<PastAttempt> = {}): PastAttempt =>
    ({ kind: 'dev', status: 'completed', modelId: 'gpt-5.5', effort: 'medium', ...patch });
  const run = (patch: Partial<ResolveInput> = {}) => resolveRunGrade({
    kind: 'dev', taskGrade: { modelId: 'gpt-5.5', effort: 'medium', locked: false },
    task: { primaryDomain: 'BE', relatedDomains: [], devLevel: 2 }, history: [], catalog, policy: DEFAULT_EXEC_POLICY,
    remainPct: 64, ...patch,
  });
  const wire = (result: ReturnType<typeof run>) => {
    if (!result.ok) throw new Error(result.code);
    const { response } = fixture('runner', 'getRunGrade');
    const adjust = gradeAdjust(result, '사유');
    // 등급 조회 응답의 정책은 도메인 정책과 같은 이름을 쓴다.
    const { onUsage, lowPct, onRework, notifyAt } = DEFAULT_EXEC_POLICY;
    const value = { ...response, model: result.grade.modelId, effort: result.grade.effort, adjust, policy: { onUsage, lowPct, onRework, notifyAt } };
    expect(responds('getRunGrade', value)).toBeNull();
    return adjust;
  };
  const gpt55 = (effort: string) => ({ model: 'gpt-5.5', effort });

  test('조정 없음과 같은 등급 재개는 null', () => {
    expect(wire(run())).toBeNull();
    expect(wire(run({ history: [past({ status: 'interrupted' })] }))).toBeNull();
  });

  test('상향·하향·유지·재판단의 kind와 이전·이후', () => {
    expect(wire(run({ kind: 'rework', history: [past()] }))).toEqual(
      { kind: 'up', from: gpt55('medium'), to: gpt55('high'), reason: '사유' });
    expect(wire(run({ kind: 'rework', history: [past()], policy: { ...DEFAULT_EXEC_POLICY, onRework: 'same' } }))).toEqual(
      { kind: 'keep', from: gpt55('medium'), to: gpt55('medium'), reason: '사유' });
    expect(wire(run({ policy: { ...DEFAULT_EXEC_POLICY, onUsage: 'down' }, remainPct: 5 }))).toEqual(
      { kind: 'down', from: gpt55('medium'), to: gpt55('low'), reason: '사유' });
    const revoked = { ...catalog, models: catalog.models.map((item) => ({ ...item, allowed: item.modelId !== 'gpt-6-sol' })) };
    expect(wire(run({ catalog: revoked, history: [past({ status: 'interrupted', modelId: 'gpt-6-sol', effort: 'high' })] }))).toEqual(
      { kind: 'regrade', from: { model: 'gpt-6-sol', effort: 'high' }, to: gpt55('medium'), reason: '사유' });
    // D-30: 없는 단계의 모델 이동도 up이다.
    expect(wire(run({ kind: 'rework', history: [past({ effort: 'xhigh' })] }))).toMatchObject(
      { kind: 'up', from: gpt55('xhigh'), to: { model: 'gpt-6-sol', effort: 'max' } });
  });

  test('기본 정책이 설정 저장 스키마를 통과한다', () => {
    const put = OPERATIONS.find((item) => item.id === 'putExecPolicy');
    const value = { updatedAt: null, ...DEFAULT_EXEC_POLICY, autoRetryLimit: 2, autoReworkLimit: 3 };
    expect(ajv.validate(put?.body ?? false, value), ajv.errorsText()).toBe(true);
    const split = OPERATIONS.find((item) => item.id === 'putSplitSettings');
    const { enabled, ...sizes } = DEFAULT_SPLIT_SETTINGS;
    expect(ajv.validate(split?.body ?? false, { updatedAt: null, ...sizes, on: enabled, testIn: true, dir: 'layer' }), ajv.errorsText()).toBe(true);
  });
});

describe('용량', () => {
  test('host 보고 fixture의 권장 상한이 공식과 같다', () => {
    const { body, response } = fixture('runner', 'reportHost');
    const host = body as { cores: number; memGB: number; diskFreeGB: number; perSessionGB: number };
    const { caps, warnings } = recommendedCaps(
      { cores: host.cores, memGb: host.memGB, diskGb: host.diskFreeGB, perSessionGb: host.perSessionGB }, 4);
    const { perAgent, ...rest } = caps;
    expect({ ...rest, ...perAgent }).toEqual(response.recommended);
    expect(effectiveCaps('auto', caps, caps)).toEqual({ caps, overruns: [] });
    const state = fixture('lead', 'getRunnerState').response as { host: object };
    expect(responds('getRunnerState', { ...state, host: { ...state.host, recommended: { ...rest, ...perAgent }, warnings } })).toBeNull();
  });

  test('Runner 상태 fixture의 제한 요인·압박·충돌 대기·보유가 판정과 같다', () => {
    const { response } = fixture('lead', 'getRunnerState');
    const c = response.concurrency as {
      caps: { total: number }; limit: number; parallelWidth: number; subRatio: number; factor: string; pressure: boolean;
      memReserveGB: number; resources: { memFreeGB: number; swapGB: number }; conflictWaits: unknown;
    };
    expect(concurrency({ capTotal: c.caps.total, runnerLimit: c.limit, width: c.parallelWidth, subRatio: c.subRatio }))
      .toMatchObject({ limit: c.limit, factor: c.factor });
    expect(memoryPressure(c.resources.memFreeGB, c.resources.swapGB, c.memReserveGB)).toBe(c.pressure);
    expect(parallelWidth({
      running: [{ taskKey: 'TASK-0004', conflictGroup: 'DB' }],
      startable: [{ taskKey: 'TASK-0008', conflictGroup: 'DB' }],
    }).conflictWaits).toEqual(c.conflictWaits);
    const [session] = response.sessions as { observed: number; reserved: number; state: 'unconfirmed'; grade: 'partial' }[];
    if (!session) throw new Error('session');
    expect(heldSubagents({ ...session, budget: session.reserved, previousHeld: 0 })).toBe(session.reserved);
  });
});

describe('일정', () => {
  const { response } = fixture('lead', 'getSchedule');
  const rows = response.tasks as { taskKey: string; estHours: number; loHours: number; hiHours: number }[];
  const now = '2026-11-25T01:02:03.123456Z';
  const input: ScheduleInput = {
    now, deps: [], assumeRate: 0.5, blackouts: ['2026-12-01'],
    tasks: rows.map((row) => ({
      id: row.taskKey, wbs: '1.1.1', status: 'running', priority: 1, assignee: 'Claude', est: row.estHours, lo: row.loHours, hi: row.hiHours,
      actStart: '2026-11-25T02:00:00Z',
    })),
    sessions: [{ from: '2026-11-25T01:00:00Z', lastHeartbeatAt: '2026-11-25T03:00:00Z' }],
    concurrency: { total: 4, current: 4, subRatio: 0, Claude: 2, Codex: 2 },
    usage: { Claude: { remain: 64 }, Codex: { remain: 0 } },
  };

  test('fixture의 추정으로 계산한 결과와 경고 3종이 응답 스키마를 통과한다', () => {
    const result = schedule(input);
    const warnings = result.warnings.map(scheduleWarning);
    expect(warnings).toEqual([
      { code: 'CLOCK_SKEW_CLAMPED', sessionFrom: '2026-11-25T01:00:00Z', field: 'lastHeartbeatAt', before: '2026-11-25T03:00:00Z', after: now },
      { code: 'CLOCK_SKEW_CLAMPED', taskKey: 'TASK-0005', field: 'actStart', before: '2026-11-25T02:00:00Z', after: now },
      { code: 'USAGE_RESET_UNKNOWN', agent: 'Codex' },
    ]);
    const tasks = rows.map((row) => {
      const item = result.by[row.taskKey];
      if (!item) throw new Error(row.taskKey);
      const { start, end, lo, hi, pct, done, mid, optimistic, pessimistic } = item;
      return { ...row, start, end, lo, hi, progressPct: pct, done, mid, optimistic, pessimistic };
    });
    expect(responds('getSchedule', { ...response, tasks, warnings })).toBeNull();
    expect(responds('getSchedule', { ...response, warnings: result.warnings })).not.toBeNull();
  });

  test('재조정 이동이 API 이동으로 들어간다', () => {
    const result = schedule(input);
    const baseline: Baseline = { v: 1, at: now, trigger: 't', actor: 'a', rate: 1, rLo: 1, rHi: 1, end: '2026-12-01', lo: '2026-12-01',
      hi: '2026-12-01', items: { 'TASK-0001': { start: '2026-12-01', end: '2026-12-01', lo: '2026-12-01', hi: '2026-12-01' } } };
    const moved = replanDiff(baseline, result).map(({ task: taskKey, kind, before, after, delta }) =>
      ({ taskKey, kind, before: before?.end ?? null, after: after?.end ?? null, deltaDays: delta }));
    expect(moved.map((item) => item.kind)).toEqual(['new', 'excluded']);
    const summary = fixture('runner', 'requestReplan').response;
    expect(ajv.validate(m.ReplanSummary, { ...summary, moved }), ajv.errorsText()).toBe(true);
  });

  test('일정 오류 코드 변환', () => {
    const [first] = input.tasks;
    if (!first) throw new Error('task');
    const code = (patch: Partial<ScheduleInput>) => {
      try {
        schedule({ ...input, ...patch });
      } catch (error) {
        if (error instanceof ScheduleError) return SCHEDULE_ERROR[error.code];
        throw error;
      }
      return null;
    };
    expect(code({})).toBeNull();
    expect(code({ tasks: [{ ...first, est: -1 }] })).toBe('INTERNAL');
    expect(code({ deps: [{ pred: first.id, succ: first.id, type: 'FS' }] })).toBe('SCHEDULE_CYCLE');
  });
});

test('Gate 판정 결과가 응답 스키마를 통과한다', () => {
  for (const input of [completion(), completion({ verification: null, outputs: [], planningApprovedAt: null })]) {
    const conditions = completionGate(input);
    const passed = conditions.every((item) => item.result === 'PASS');
    expect(responds('getTaskGate', { taskKey: 'TASK-0005', passed, conditions })).toBeNull();
  }
  expect(AGENTS).toHaveLength(2);
});
