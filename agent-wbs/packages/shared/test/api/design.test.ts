import { Ajv } from 'ajv';
import { expect, test } from 'vitest';
import { OPERATIONS } from '../../src/api/index.ts';

const ajv = new Ajv({ strict: false });
const schema = OPERATIONS.find(op => op.id === 'reportDesignSnapshot')!.body!;
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
