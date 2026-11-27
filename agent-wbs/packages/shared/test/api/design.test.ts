import { Ajv } from 'ajv';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { OPERATIONS } from '../../src/api/index.ts';

const ajv = new Ajv({ strict: false });
const schema = OPERATIONS.find(op => op.id === 'reportDesignSnapshot')?.body;
assert(schema);
const snapshot = {
  jobId: 'job', fence: 1, commit: 'a'.repeat(40), ref: 'agent/TASK-0001',
  files: [{ path: 'contracts/api/openapi.yaml', kind: 'REST', format: 'OpenAPI 3.1', status: 'ok', raw: 'openapi: 3.1.0' }],
  items: [{ itemKey: 'GET /users', name: '사용자', kind: 'REST', path: 'contracts/api/openapi.yaml', content: {},
    contract: { fields: [{ path: '/response/id', type: 'string', required: true }] }, extracted: null }],
  drifts: [], ownership: [], edges: [], components: [], links: [],
};

test('설계 보고는 브랜치·원문·기계 대조 필드를 전달하고 깨진 필드는 거부한다', () => {
  expect(ajv.validate(schema, snapshot), JSON.stringify(ajv.errors)).toBe(true);
  expect(ajv.validate(schema, { ...snapshot, items: [{ ...snapshot.items[0], extracted: { fields: [{ path: '/id', type: 'string', required: 'yes' }] } }] })).toBe(false);
});

const fixtures = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/design-snapshot.json', import.meta.url), 'utf8')) as { id: string; validSchema: boolean; body: unknown }[];
test.each(fixtures)('$id의 보고 형식을 OpenAPI 원본 스키마로 검증한다', fixture => {
  expect(ajv.validate(schema, fixture.body), JSON.stringify(ajv.errors)).toBe(fixture.validSchema);
});

test('필드 수와 원문 크기 상한은 저장 전에 스키마로 거절한다', () => {
  const body = structuredClone(snapshot);
  const entry = body.items[0];
  assert(entry);
  entry.contract.fields = Array.from({ length: 5001 }, (_, i) => ({ path: `/responses/200/f${String(i)}`, type: 'string', required: true }));
  expect(ajv.validate(schema, body)).toBe(false);
  expect(ajv.validate(schema, { ...snapshot, files: [{ ...snapshot.files[0], raw: 'x'.repeat(262145) }] })).toBe(false);
});

test('ref를 반드시 받고 기존 Task 브랜치 이름만 받는다', () => {
  expect(ajv.validate(schema, { ...snapshot, ref: undefined })).toBe(false);
  for (const ref of ['Main', 'refs/heads/main', 'agent/foo', 'agent/task-0001']) expect(ajv.validate(schema, { ...snapshot, ref })).toBe(false);
  for (const ref of ['main', 'agent/TASK-0001', 'agent/TASK-0001-h1']) expect(ajv.validate(schema, { ...snapshot, ref })).toBe(true);
});
