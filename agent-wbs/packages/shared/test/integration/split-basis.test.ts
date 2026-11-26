// G§5.2-1 「Task마다 분할 근거」: CP add → 시뮬레이션 → 분할 검증
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, test } from 'vitest';
import { simulateProposal, validateSplitProposal } from '@awbs/shared';
import type { JudgedRules } from '@awbs/shared';
import { OPERATIONS, simulationOp } from '@awbs/shared/api';
import type { WireProposalOp } from '@awbs/shared/api';
import * as m from '../../src/api/models.ts';
import { judged, snapshot, task } from '../proposal/fixtures.ts';

const ajv = new Ajv({ strict: false });
const operation = (id: string) => OPERATIONS.find((item) => item.id === id);
const accepts = (id: string, body: unknown) => ajv.validate(operation(id)?.body ?? false, body);
const load = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(`../../../../contracts/fixtures/${name}.json`, import.meta.url), 'utf8')) as T;

const t = (splitBasis?: string) => ({
  title: '신규', type: 'Implementation', domain: 'BE', wp: 'WP-1', priority: 1, assignee: 'Claude', verifier: 'Codex',
  purpose: 'p', doneCond: 'd', est: 2, lo: 1, hi: 3, conf: '상', ac: [{ given: 'g', when: 'w', then: 't' }],
  ...(splitBasis !== undefined && { splitBasis }),
});
const add = (ref: string, splitBasis?: string) => ({ op: 'add', ref, t: t(splitBasis), preds: [] });
const remove = { op: 'remove', task: 'TASK-0001' };
const job = { jobId: 'job-1', fence: 1 };
// 분할 CP의 source.id는 원래 Task 키다(조정자 결정 2026-11-26).
const body = (kind: string, ops: unknown[]) => ({ title: 't', reason: 'r', source: { kind, id: kind === 'split' ? 'TASK-0001' : 'x' }, ops });

describe.each([
  ['submitPlanningProposal', job],
  ['createProposal', {}],
])('%s', (id, extra) => {
  test.each(['planning', 'message', 'manual', 'input', 'decision'])('일반 CP(%s)에서는 선택이다', (kind) => {
    expect(accepts(id, { ...extra, ...body(kind, [add('NEW-1')]) })).toBe(true);
    expect(accepts(id, { ...extra, ...body(kind, [add('NEW-1', '근거')]) })).toBe(true);
  });

  test('분할 CP의 모든 추가 Task에서 필수다', () => {
    const split = (...ops: unknown[]) => accepts(id, { ...extra, ...body('split', ops) });
    expect(split(add('NEW-1', '근거 1'), add('NEW-2', '근거 2'), remove)).toBe(true);
    expect(split(add('NEW-1', '근거 1'), add('NEW-2'), remove)).toBe(false);
    expect(split(add('NEW-1'), remove)).toBe(false);
  });

  test.each(['planning', 'split'])('%s: 빈 값은 기존 Task의 분할 근거처럼 거부한다', (kind) => {
    for (const bad of ['', '  ']) expect(accepts(id, { ...extra, ...body(kind, [add('NEW-1', bad)]) })).toBe(false);
    expect(accepts(id, { ...extra, ...body(kind, [{ ...add('NEW-1'), t: { ...t(), splitBasis: null } }]) })).toBe(false);
  });

  test('없는 source는 거부한다', () => {
    expect(accepts(id, { ...extra, ...body('etc', [add('NEW-1', '근거')]) })).toBe(false);
  });
});

test('초안 Task의 분할 근거와 같은 정의다', () => {
  const draft = m.WbsDraft.tasks as unknown as { items: { properties: { splitBasis: unknown } } };
  for (const schema of [m.ProposalOp, m.LeadProposalOp, m.PlanningProposalOp, m.LeadSplitProposalOp, m.PlanningSplitProposalOp, m.JudgedProposalOp, m.JudgedSplitProposalOp]) {
    const [first] = (schema as unknown as { anyOf: { properties: { t: { properties: Record<string, object> } } }[] }).anyOf;
    expect(JSON.stringify(first?.properties.t.properties.splitBasis)).toBe(JSON.stringify(draft.items.properties.splitBasis));
  }
});

test('Planning 검토의 ops와 저장된 CP도 분할 근거를 보존한다', () => {
  expect(ajv.validate(m.ProposalOp, add('NEW-1', '근거'))).toBe(true);
  expect(ajv.validate(m.PlanningProposalOp, add('NEW-1', '근거'))).toBe(true);
});

test('분할 판단 job의 추가 Task에도 필수이고, 일반 판단 job은 선택이다', () => {
  const jobs = load<{ kind: string; response: { job: { payload: { proposal: { ops: { op: string; t?: object }[] } | null } } } }[]>('judgement-jobs');
  for (const [kind, expected] of [['split-proposal', false], ['lead-proposal', true]] as const) {
    const response = structuredClone(jobs.find((item) => item.kind === kind)?.response);
    expect(ajv.validate(operation('claimJob')?.responses[200] ?? false, response), kind).toBe(true);
    const target = response?.job.payload.proposal?.ops.find((item) => item.op === 'add')?.t;
    Reflect.deleteProperty(target ?? {}, 'splitBasis');
    expect(ajv.validate(operation('claimJob')?.responses[200] ?? false, response), kind).toBe(expected);
  }
});

describe('판정까지 이어진다', () => {
  const base = snapshot([task('TASK-0001', 'ready', { title: '조회 및 수정', ac: [{ given: 'g', when: 'w', then: 't', method: '' }] })]);
  const codes = (ops: unknown[]) => validateSplitProposal(base, 'TASK-0001', (ops as WireProposalOp[]).map(simulationOp), {
    splitJudgements: null, splitSubjectHash: null, taskHashes: { before: {}, after: {} }, taskJudgements: [],
  }).problems.map(({ code, taskKey }) => `${code} ${taskKey}`).filter((code) => code.startsWith('SPLIT_BASIS_MISSING'));

  test('API 분할 CP의 분할 근거가 검증을 통과하고, 빠진 Task만 걸린다', () => {
    expect(codes([add('NEW-1', '조회만'), add('NEW-2', '수정만'), remove])).toEqual([]);
    expect(codes([add('NEW-1', '조회만'), add('NEW-2'), remove])).toEqual(['SPLIT_BASIS_MISSING TASK-0022']);
  });

  test('시뮬레이션 결과 Task에 저장되고, 생략하면 빈 값이며 일반 CP를 막지 않는다', () => {
    const stored = { ...t('근거'), judgedRules: judged() as JudgedRules };
    const result = simulateProposal(base, ([{ ...add('NEW-1'), t: stored }, add('NEW-2')] as WireProposalOp[]).map(simulationOp));
    expect(result.issues).toEqual([]);
    expect(result.next.tasks.slice(1).map((item) => item.splitBasis)).toEqual(['근거', '']);
  });
});
