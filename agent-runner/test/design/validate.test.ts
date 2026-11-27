import { expect, test } from 'vitest';
import { designSnapshotProblems } from '../../src/design/validate.ts';

const body = () => ({ jobId: 'job', fence: 1, commit: 'a'.repeat(40), ref: 'main', files: [{ path: 'contracts/api/openapi.json', kind: 'REST', format: 'OpenAPI 3.1', status: 'ok' }], items: [{ itemKey: 'GET /users', kind: 'REST', path: 'contracts/api/openapi.json', content: {}, extracted: null }], drifts: [] });

test('전송 전 OpenAPI 스키마와 파일·중복 참조 규칙을 검사한다', () => {
  expect(designSnapshotProblems(body())).toEqual([]);
  const duplicate = body(); duplicate.items.push(duplicate.items[0] as typeof duplicate.items[number]);
  expect(designSnapshotProblems(duplicate).some(e => e.rule === 'unique')).toBe(true);
  const missing = body(); missing.items = missing.items.map(i => ({ ...i, path: 'contracts/missing.json' }));
  expect(designSnapshotProblems(missing).some(e => e.rule === 'reference')).toBe(true);
});

test('스키마의 문자열 길이와 별도로 JSON UTF-8 본문 1 MiB 상한을 검사한다', () => {
  const value = body();
  const files = Array.from({ length: 4 }, (_, i) => ({ ...value.files[0], path: i ? `contracts/${i}.json` : 'contracts/api/openapi.json', raw: ' '.repeat(262144) }));
  expect(designSnapshotProblems({ ...value, files }).some(e => e.rule === 'maxBytes')).toBe(true);
});

