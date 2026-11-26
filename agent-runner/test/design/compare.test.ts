import { expect, test } from 'vitest';
import { compareShapes, schemaFields } from '../../src/design/shape.ts';

const field = (path: string, type = 'string', required = false) => ({ path, type, required });
const shape = (...fields: ReturnType<typeof field>[]) => ({ fields });

test('삭제·타입 변경·기존 필드 필수화·필수 필드 추가는 breaking이다', () => {
  const contract = shape(field('/id', 'string', true), field('/name'));
  for (const extracted of [
    shape(field('/id', 'string', true)),
    shape(field('/id', 'number', true), field('/name')),
    shape(field('/id', 'string', true), field('/name', 'string', true)),
    shape(...contract.fields, field('/email', 'string', true)),
  ]) expect(compareShapes(contract, extracted)?.compat).toBe('breaking');
});

test('순서만 다르면 일치이고 선택 필드 추가·필수 해제는 compatible이다', () => {
  const contract = shape(field('/id', 'string', true), field('/name'));
  expect(compareShapes(contract, shape(field('/name'), field('/id', 'string', true)))).toBeNull();
  expect(compareShapes(contract, shape(...contract.fields, field('/email')))?.compat).toBe('compatible');
  expect(compareShapes(contract, shape(field('/id'), field('/name')))?.compat).toBe('compatible');
});

test('추출 없음·중복 주소·잘못된 추출은 일치나 불일치 0건이 아니라 unchecked다', () => {
  const contract = shape(field('/id'));
  for (const extracted of [null, undefined, shape(field('/id'), field('/id')), { fields: [{ path: 'id', type: 'string', required: false }] }]) {
    expect(compareShapes(contract, extracted)?.compat).toBe('unchecked');
  }
  expect(compareShapes(undefined, shape())?.compat).toBe('unchecked');
});

test('중첩·배열·지역 참조·JSON Pointer 특수 문자를 고정 필드 주소로 바꾼다', () => {
  const root = { components: { schemas: { Id: { type: 'string' } } } };
  expect(schemaFields({ type: 'object', required: ['a/b'], properties: {
    'a/b': { $ref: '#/components/schemas/Id' },
    'x~y': { type: 'array', items: { type: 'integer' } },
  } }, root, '/body', true)).toEqual([
    field('/body', 'object', true), field('/body/a~1b', 'string', true),
    field('/body/x~0y', 'array'), field('/body/x~0y/*', 'integer'),
  ]);
});

test('외부·순환 참조와 해석하지 못한 스키마를 빈 필드 목록으로 위장하지 않는다', () => {
  const root = { node: { type: 'object', properties: { child: { $ref: '#/node' } } } };
  for (const schema of [{ $ref: 'https://example.invalid/schema' }, root.node, { oneOf: [{ type: 'string' }, { type: 'number' }] }]) {
    expect(() => schemaFields(schema, root, '/body', false)).toThrow();
  }
});
