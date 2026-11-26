import AjvCompiler, { type ValidatorFactory } from '@fastify/ajv-compiler';

/** Fastify의 형식·참조 지원은 유지하고, 본문과 URL 입력의 변환 정책만 나눈다. */
export const buildValidator: ValidatorFactory = (schemas, options) => {
  if (options?.mode === 'JTD') throw new Error('이 API는 JSON Schema 검증만 사용합니다.');
  const compile = AjvCompiler();
  const customOptions = { ...options?.customOptions, removeAdditional: false, useDefaults: false };
  const body = compile(schemas, { ...options, customOptions: { ...customOptions, coerceTypes: false } });
  // URL·헤더는 스칼라만 변환한다. 단일 문자열을 배열로 감싸지는 않는다.
  const transport = compile(schemas, { ...options, customOptions: { ...customOptions, coerceTypes: true } });
  return (definition) => (definition.httpPart === 'body' ? body : transport)(definition);
};
