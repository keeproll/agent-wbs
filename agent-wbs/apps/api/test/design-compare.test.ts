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
