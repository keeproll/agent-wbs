// data-model §2.4-1: CP add 선택 필드의 API 스키마와 변환
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, test } from 'vitest';
import { simulateProposal, validateSplitProposal } from '@awbs/shared';
import { OPERATIONS, proposalReasons, simulationOp } from '@awbs/shared/api';
import type { WireProposalOp } from '@awbs/shared/api';
import * as m from '../../src/api/models.ts';
import { snapshot, task } from '../proposal/fixtures.ts';

const ajv = new Ajv({ strict: false });
const operation = (id: string) => OPERATIONS.find((item) => item.id === id);
const accepts = (id: string, body: unknown) => ajv.validate(operation(id)?.body ?? false, body);
const responds = (id: string, body: unknown) => ajv.validate(operation(id)?.responses[200] ?? false, body);
const load = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(`../../../../contracts/fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const t = (extra: object = {}) => ({
  title: '신규', type: 'Implementation', domain: 'BE', rel: ['DB'], wp: 'WP-1', priority: 1, assignee: 'Claude', verifier: 'Codex',
  purpose: 'p', doneCond: 'd', splitBasis: '근거', ...extra,
});
const add = (extra: object = {}) => ({ op: 'add', ref: 'NEW-1', t: t(extra), preds: [] });
const full = {
  scope: ['조회'], files: ['src/a.ts'], conflictGroup: 'DB Schema',
  design: [{ kind: 'API', content: { ents: [{ method: 'GET', path: '/api/x' }], b: {} } }],
};
const body = (kind: string, op: unknown) => ({ title: 't', reason: 'r', source: { kind, id: 'TASK-0001' }, ops: [op] });
const job = { jobId: 'job-1', fence: 1 };
const convert = (op: unknown) => {
  const result = simulationOp(op as WireProposalOp);
  if (result.op !== 'add') throw new Error(result.op);
  return result.task;
};

test.each(['planning', 'split'])('Planning 작성 CP(%s)는 네 필드를 선택으로 받는다', (kind) => {
  const planning = (extra: object) => accepts('submitPlanningProposal', { ...job, ...body(kind, add(extra)) });
  expect(planning({})).toBe(true);
  expect(planning(full)).toBe(true);
  expect(planning({ scope: [], files: [], design: [], conflictGroup: null })).toBe(true);
  for (const bad of [
    { conflictGroup: '' }, { conflictGroup: '  ' }, { scope: null }, { files: 'a' }, { files: [1] }, { design: null },
    { design: [{ kind: 'QA', content: {} }] }, { design: [{ kind: 'API' }] }, { design: [{ kind: 'API', content: {}, x: 1 }] },
  ]) expect(planning(bad), JSON.stringify(bad)).toBe(false);
});

test.each(['manual', 'split'])('팀장 작성 CP(%s)는 충돌 묶음을 받지 않는다(null도)', (kind) => {
  const lead = (extra: object) => accepts('createProposal', body(kind, add(extra)));
  const { scope, files, design } = full;
  expect(lead({ scope, files, design })).toBe(true);
  for (const conflictGroup of ['DB Schema', null]) expect(lead({ conflictGroup })).toBe(false);
});

test('저장된 CP와 Planning 검토·판단 job의 ops는 충돌 묶음을 보존하고, 판단 job은 판단 기록을 받지 않는다', () => {
  expect(ajv.validate(m.ProposalOp, add(full))).toBe(true);
  expect(ajv.validate(m.PlanningProposalOp, add(full))).toBe(true);
  const jobs = load<{ kind: string; response: { job: { payload: { proposal: { ops: unknown[] } } } } }[]>('judgement-jobs');
  for (const kind of ['lead-proposal', 'split-proposal']) {
    const response = structuredClone(jobs.find((item) => item.kind === kind)?.response);
    const ops = response?.job.payload.proposal.ops ?? [];
    ops[0] = add(full);
    expect(responds('claimJob', response), kind).toBe(true);
    ops[0] = add({ judgedRules: { schemaVersion: 1, items: [] } });
    expect(responds('claimJob', response), kind).toBe(false);
  }
});

test('필드 형식은 Task 상세·판단 대상과 같다', () => {
  const props = (schema: unknown) => (schema as { properties: Record<string, object> }).properties;
  const [op] = (m.ProposalOp as unknown as { anyOf: { properties: { t: object } }[] }).anyOf;
  const wire = props(op?.properties.t);
  const judged = props(m.JudgedContent);
  expect(wire.scope).toMatchObject(judged.scope ?? {});
  expect(wire.files).toMatchObject(props(judged.spec).files ?? {});
  expect(JSON.stringify((wire.design as { items?: unknown }).items)).toBe(JSON.stringify((judged.designs as { items?: unknown }).items));
});

describe('simulationOp', () => {
  test('생략과 명시한 null·빈 배열을 구분한다', () => {
    const omitted = convert(add());
    for (const key of ['scope', 'files', 'design', 'conflictGroup']) expect(omitted, key).not.toHaveProperty(key);
    expect(convert(add({ conflictGroup: null, scope: [], files: [], design: [] })))
      .toMatchObject({ conflictGroup: null, scope: [], files: [], design: [] });
    expect(convert(add(full))).toMatchObject({ scope: ['조회'], files: ['src/a.ts'], conflictGroup: 'DB Schema' });
  });

  test('설계 항목은 content.ents다(P DESIGN). 없거나 배열이 아니면 빈 구역', () => {
    const count = (content: object) => convert(add({ design: [{ kind: 'DB', content }] })).design?.[0]?.items.length;
    expect(count({ ents: [{ name: 'a' }, { name: 'b' }], b: {} })).toBe(2);
    for (const content of [{}, { ents: [] }, { ents: 'x' }, { b: { text: 'x' } }]) expect(count(content)).toBe(0);
  });

  test('생략 시 기본값: 영역에 맞는 빈 설계 구역, 명시한 []는 구역 없음', () => {
    const last = (op: unknown) => simulateProposal(snapshot([task('TASK-0001')]), [simulationOp(op as WireProposalOp)]).next.tasks.at(-1);
    expect(last(add())).toMatchObject({
      scope: [], files: [], conflictGroup: null, design: [{ kind: 'API', items: [] }, { kind: 'DB', items: [] }],
    });
    expect(last(add({ design: [] }))?.design).toEqual([]);
  });
});

test('API 분할 CP: 생략은 상속, 명시한 null은 변경으로 미리보기에 보인다', () => {
  const base = snapshot([task('TASK-0001', 'ready', { conflictGroup: 'DB Schema', files: ['a'] })]);
  const ops = [add(), { ...add({ conflictGroup: null }), ref: 'NEW-2' }, { op: 'remove', task: 'TASK-0001' }];
  const { simulation, problems, warnings } = validateSplitProposal(base, 'TASK-0001', (ops as WireProposalOp[]).map(simulationOp), {
    splitJudgements: null, splitSubjectHash: null, taskHashes: { before: {}, after: {} }, taskJudgements: [],
  });
  expect(simulation.diff.filter((item) => item.field === 'conflictGroup').map(({ before, after }) => [before, after]))
    .toEqual([['DB Schema', 'DB Schema'], ['DB Schema', null]]);
  expect(warnings.some((item) => item.message.includes('변경 범위 미기재'))).toBe(true);
  const { impact, idMap, diff } = simulation;
  const reasons = proposalReasons(problems);
  const missing = reasons.issues.find((item) => item.code === 'ESTIMATE_MISSING');
  expect(missing).toMatchObject({ taskKey: 'TASK-0021' });
  const preview = { previewHash: 'h', idMap, diff, impact, ...reasons };
  expect(responds('previewProposal', preview), ajv.errorsText()).toBe(true);
  expect(responds('previewProposal', { ...preview, issues: [{ index: null, code: 'X', message: 'm', taskKey: 'NEW-1' }] })).toBe(false);
  expect(responds('previewProposal', { ...preview, issues: [{ index: null, code: 'X', message: 'm' }] })).toBe(true);
});
