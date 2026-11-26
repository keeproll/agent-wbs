import { Ajv } from 'ajv';
import { expect, expectTypeOf, test } from 'vitest';
import type { Static } from 'typebox';
import { Agent, AnyOf, Count, Epoch, Fence } from '../../src/api/common.ts';
import { settingsOperations, wbsOperations } from '../../src/api/index.ts';

type Op = (typeof wbsOperations)[number] | (typeof settingsOperations)[number];
type Of<I extends string> = Extract<Op, { id: I }>;

test('열거값과 생성된 요청 ID는 리터럴 타입을 보존한다', () => {
  const choice = AnyOf('a', 'b');
  expectTypeOf<Static<typeof choice>>().toEqualTypeOf<'a' | 'b'>();
  expectTypeOf<Static<typeof Agent>>().toEqualTypeOf<'Claude' | 'Codex'>();
  expectTypeOf<Of<'approveTask'>>().not.toBeNever();
  expectTypeOf<Of<'rejectTask'>>().not.toBeNever();
  expectTypeOf<Of<'getModelSettings'>>().not.toBeNever();
  expectTypeOf<Of<'putExecPolicy'>>().not.toBeNever();
  type Models = Static<Of<'getModelSettings'>['responses'][200]>;
  expectTypeOf<Models['models'][number]['allowed']>().toEqualTypeOf<boolean>();
  expectTypeOf<Of<'getGithubSettings'>>().not.toBeNever();
  type Github = Static<Of<'getGithubSettings'>['responses'][200]>;
  expectTypeOf<Github['mode']>().toEqualTypeOf<'gh' | 'token'>();
  expectTypeOf<Github['tokenSet']>().toEqualTypeOf<boolean>();
  expectTypeOf<string extends Op['id'] ? true : false>().toEqualTypeOf<false>();
  expect(choice.enum).toEqual(['a', 'b']);
});

test('공통 정수는 정밀도가 보존되는 최댓값까지만 받는다', () => {
  const ajv = new Ajv({ strict: false });
  for (const [schema, maximum] of [[Count, Number.MAX_SAFE_INTEGER], [Fence, 2147483647], [Epoch, 2147483647]] as const) {
    expect(ajv.validate(schema, maximum)).toBe(true);
    expect(ajv.validate(schema, maximum + 1)).toBe(false);
    expect(ajv.validate(schema, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(ajv.validate(schema, 1e308)).toBe(false);
  }
});
