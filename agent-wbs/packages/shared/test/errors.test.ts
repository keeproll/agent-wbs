import { expect, test } from 'vitest';
import { errorBody } from '../src/index.ts';

test('오류 본문은 계약의 모든 필드를 가진다', () => {
  expect(
    errorBody({ code: 'UNAVAILABLE', message: 'm', action: 'a', fix: 'f', requestId: 'r' }),
  ).toEqual({
    error: { code: 'UNAVAILABLE', message: 'm', action: 'a', fix: 'f', errors: [], details: {}, requestId: 'r' },
  });
});
