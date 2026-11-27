import { expect, test } from 'vitest';
import { compareDesign } from '../src/design/compare.ts';

const field = (path: string, type = 'string', required = false) => ({ path, type, required });
const shape = (...fields: ReturnType<typeof field>[]) => ({ fields });

test.each([
  ['삭제', shape(field('/id')), shape(), 'breaking', true],
  ['타입 변경', shape(field('/id')), shape(field('/id', 'integer')), 'breaking', true],
  ['필수화', shape(field('/id')), shape(field('/id', 'string', true)), 'breaking', true],
  ['필수 필드 추가', shape(), shape(field('/id', 'string', true)), 'breaking', true],
  ['선택 필드 추가', shape(), shape(field('/id')), 'compatible', true],
  ['필수 해제', shape(field('/id', 'string', true)), shape(field('/id')), 'compatible', true],
  ['순서만 변경', shape(field('/id'), field('/name')), shape(field('/name'), field('/id')), 'compatible', false],
  ['추출 불가', shape(field('/id')), null, 'unchecked', true],
  ['계약 미해석', undefined, shape(), 'unchecked', true],
] as const)('%s의 호환성을 Agent 판단 없이 계산한다', (_name, before, after, compat, changed) => {
  expect(compareDesign(before, after)).toEqual({ compat, changed });
});

test.each([
  ['/parameters/query/id', false, null, 'compatible'],
  ['/requestBody/content/application~1json/id', false, null, 'compatible'],
  ['/parameters/query/id', true, false, 'compatible'],
  ['/requestBody/content/application~1json/id', false, true, 'breaking'],
  ['/responses/200/content/application~1json/id', false, null, 'breaking'],
  ['/responses/200/content/application~1json/id', true, false, 'breaking'],
  ['/responses/200/content/application~1json/id', false, true, 'compatible'],
] as const)('REST %s의 삭제·필수 여부는 요청과 응답 방향으로 판정한다', (path, before, after, compat) => {
  expect(compareDesign(shape(field(path, 'string', before)), after === null ? shape() : shape(field(path, 'string', after)), 'REST'))
    .toEqual({ compat, changed: true });
});

test.each([
  ['/parameters/query/id', 'breaking'],
  ['/responses/200/id', 'compatible'],
] as const)('%s에 새 필수 필드가 생기는 방향을 구별한다', (path, compat) => {
  expect(compareDesign(shape(), shape(field(path, 'string', true)), 'REST')).toEqual({ compat, changed: true });
});

test.each(['WebSocket', 'SSE', 'Kafka'])('%s 메시지는 응답 규칙으로 필수 해제를 거부한다', kind => {
  expect(compareDesign(shape(field('/messages/created/id', 'string', true)), shape(field('/messages/created/id')), kind))
    .toEqual({ compat: 'breaking', changed: true });
  expect(compareDesign(shape(), shape(field('/messages/created/id', 'string', true)), kind))
    .toEqual({ compat: 'compatible', changed: true });
});

test.each([
  ['enum', 'string;enum=["a","b"]', 'string;enum=["a"]'],
  ['const', 'string;const="a"', 'string;const="b"'],
  ['format', 'string;format=date-time', 'string;format=uuid'],
] as const)('%s 지문 변화는 요청·응답 모두 타입 변경이다', (_name, before, after) => {
  for (const path of ['/requestBody/id', '/responses/200/id']) {
    expect(compareDesign(shape(field(path, before)), shape(field(path, after)), 'REST')).toEqual({ compat: 'breaking', changed: true });
  }
});
