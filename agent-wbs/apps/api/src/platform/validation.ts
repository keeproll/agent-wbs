import AjvCompiler, { type ValidatorFactory } from '@fastify/ajv-compiler';
import type { FastifyRequest } from 'fastify';
import type { InputError } from '@awbs/shared/api';
import { PlatformError } from './errors.ts';

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

function nonFiniteError(value: unknown, path: string[] = []): InputError | undefined {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { path: path.join('.'), rule: 'finite', message: '유한한 숫자를 입력하세요.' };
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const error = nonFiniteError(item, [...path, key]);
      if (error) return error;
    }
  }
  return undefined;
}

/** Ajv가 문자열을 숫자로 변환한 뒤에도 Infinity가 남을 수 있어 최종 값을 확인한다. */
export async function validateTransport(request: FastifyRequest): Promise<void> {
  for (const value of [request.query, request.params, request.headers]) {
    const error = nonFiniteError(value);
    if (error) throw new PlatformError('VALIDATION_FAILED', {}, [error]);
  }
}
