import { createPool } from '@awbs/db';
import { afterAll, expect, test } from 'vitest';
import { buildApp } from '../src/app.ts';
import { PlatformError, validationErrors } from '../src/platform/errors.ts';
import { buildValidator } from '../src/platform/validation.ts';

const pool = createPool('postgres://u:p@127.0.0.1:1/awbs_test_unused', { onError: () => undefined });
const app = buildApp(pool);
const errors = [{ path: 'spec.acceptance.0.title', rule: 'required', message: '필수 항목을 입력하세요.' }];
app.addHook('preHandler', async (request) => {
  if (request.url.includes('business-error')) throw new PlatformError('VALIDATION_FAILED', {}, errors);
});
afterAll(async () => { await app.close(); await pool.end(); });

test('업무 입력 오류도 공통 PlatformError를 통해 항목별 오류를 보존한다', async () => {
  const response = await app.inject('/health?business-error=1');
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED', errors } });
});

test('입력 경로의 JSON Pointer 이스케이프를 풀고 원문 오류 메시지는 노출하지 않는다', () => {
  expect(validationErrors([{ keyword: 'type', instancePath: '/rows/0/a~1b~0c', schemaPath: '#/type', params: { type: 'string' }, message: 'Bearer secret-value-do-not-echo' }]))
    .toEqual([{ path: 'rows.0.a/b~c', rule: 'type', message: '입력 형식과 조건을 확인하세요.' }]);
});

test('프로젝트 계약과 다른 JTD 모드는 검증기 생성 때 거부한다', () => {
  expect(() => buildValidator({}, { mode: 'JTD' })).toThrow('JSON Schema');
});
