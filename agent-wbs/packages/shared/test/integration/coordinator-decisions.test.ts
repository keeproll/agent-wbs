// 조정자 결정(2026-11-26): 분할 CP의 source.id 필수, 설계 kind 중복은 입력 검증 400
import { Ajv } from 'ajv';
import { describe, expect, test } from 'vitest';
import { inputErrors, OPERATIONS, renderOpenApi } from '@awbs/shared/api';

const ajv = new Ajv({ strict: false });
const operation = (id: string) => {
  const found = OPERATIONS.find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
};
const accepts = (id: string, body: unknown) => ajv.validate(operation(id).body ?? false, body);
const t = (extra: object = {}) => ({
  title: '신규', type: 'Implementation', domain: 'BE', wp: 'WP-1', priority: 1, assignee: 'Claude', verifier: 'Codex',
  purpose: 'p', doneCond: 'd', splitBasis: '근거', ...extra,
});
const add = (extra: object = {}) => ({ op: 'add', ref: 'NEW-1', t: t(extra), preds: [] });
const job = { jobId: 'job-1', fence: 1 };
const body = (kind: string, ops: unknown[], id?: string) =>
  ({ title: 't', reason: 'r', source: { kind, ...(id !== undefined && { id }) }, ops });

describe.each([['createProposal', {}], ['submitPlanningProposal', job]])('%s', (id, extra) => {
  test('분할 CP는 source.id(원래 Task 키)가 필수다', () => {
    const split = [add(), { op: 'remove', task: 'TASK-0001' }];
    expect(accepts(id, { ...extra, ...body('split', split, 'TASK-0001') })).toBe(true);
    expect(accepts(id, { ...extra, ...body('split', split) })).toBe(false);
    expect(accepts(id, { ...extra, ...body('split', split, 'PLN-1') })).toBe(false);
  });

  test('일반 CP의 source.id는 전처럼 선택이다', () => {
    expect(accepts(id, { ...extra, ...body('manual', [add()]) })).toBe(true);
    expect(accepts(id, { ...extra, ...body('planning', [add()], 'PLN-1') })).toBe(true);
  });

  test('설계 kind가 겹치면 VALIDATION_FAILED 입력 오류다', () => {
    const design = (...kinds: string[]) => kinds.map((kind) => ({ kind, content: {} }));
    const ok = { ...extra, ...body('planning', [add({ design: design('DB', 'API') })]) };
    const dup = { ...extra, ...body('planning', [add(), { ...add({ design: design('DB', 'API', 'DB') }), ref: 'NEW-2' }]) };
    expect(accepts(id, dup)).toBe(true); // 형식은 맞고 규칙만 어긴다
    expect(inputErrors(operation(id), ok)).toEqual([]);
    expect(inputErrors(operation(id), dup)).toEqual([
      { path: 'ops.1.t.design.2.kind', rule: 'uniqueDesignKind', message: '설계 종류 DB가 겹칩니다.' },
    ]);
    expect(operation(id).errors).toContain('VALIDATION_FAILED');
  });
});

test('Planning 검토의 ops 세 묶음도 같은 규칙을 쓴다', () => {
  const dup = add({ design: [{ kind: 'FE', content: {} }, { kind: 'FE', content: {} }] });
  const review = { topic: 't', kind: 'k', codex: 'c', claude: 'c', ops: [add()], codexOps: [dup], claudeOps: [add()] };
  expect(inputErrors(operation('submitPlanningReviews'), { ...job, reviews: [review] })).toEqual([
    { path: 'reviews.0.codexOps.0.t.design.1.kind', rule: 'uniqueDesignKind', message: '설계 종류 FE가 겹칩니다.' },
  ]);
});

test('add op의 설계를 받는 모든 요청에 규칙이 있고, 다른 요청에는 없다', () => {
  for (const op of OPERATIONS) {
    const carriesDesign = JSON.stringify(op.body ?? {}).includes('"design":{"type":"array"');
    expect(op.inputRules?.includes('uniqueDesignKind') ?? false, op.id).toBe(carriesDesign);
  }
});

test('규칙 이름이 OpenAPI에 보인다', () => {
  const doc = JSON.parse(renderOpenApi(OPERATIONS)) as { paths: Record<string, Record<string, { 'x-input-rules'?: string[] }>> };
  expect(doc.paths['/api/proposals']?.post?.['x-input-rules']).toEqual(['uniqueDesignKind']);
  expect(doc.paths['/api/runner/heartbeat']?.post?.['x-input-rules']).toBeUndefined();
  expect(inputErrors(operation('heartbeat'), {})).toEqual([]);
});
