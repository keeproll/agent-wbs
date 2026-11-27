import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { boundJudgements, jcs, judgedContentHash } from '../../src/judgement.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/judgement-bindings.json', import.meta.url), 'utf8')) as {
  id: string; input: unknown; canonical: string; subjectHash: string;
}[];
test.each(vectors)('$id: RFC 8785 직렬화와 UTF-8 SHA-256 고정 벡터', (v) => {
  expect(jcs(v.input)).toBe(v.canonical);
  expect(judgedContentHash(v.input)).toBe(v.subjectHash);
});
test.each([NaN, Infinity, '\ud800', { '\udfff': 1 }, { a: undefined }, [undefined], new Date()])('JCS가 지원하지 않는 값을 다른 입력으로 바꾸지 않는다: %j', (value) => {
  expect(() => jcs(value)).toThrow();
});
test('새 hash를 제시해도 sourceRef가 옛 입력이면 거부하고 같은 입력의 지문만 보관한다', () => {
  const hash = vectors[0]?.subjectHash ?? '';
  const item = { sourceRef: `sha256:${'0'.repeat(64)}`, subjectHash: hash };
  const record = { schemaVersion: 1, items: [item] };
  expect(() => boundJudgements(record, hash)).toThrow('JUDGEMENT_INPUT_MISMATCH');
  item.sourceRef = `sha256:${hash}`;
  expect(boundJudgements(record, hash)).toEqual(record);
});
