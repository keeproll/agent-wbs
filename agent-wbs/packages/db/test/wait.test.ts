import { afterEach, expect, test, vi } from 'vitest';
import { createPool, waitForDatabase } from '../src/index.ts';

const pool = createPool('postgres://u:p@127.0.0.1:1/awbs_test_x', { onError: vi.fn() });
afterEach(() => vi.restoreAllMocks());

test('ECONNREFUSED는 3회 재시도한 뒤 실패한다', async () => {
  const onRetry = vi.fn();
  await expect(waitForDatabase(pool, { delayMs: 1, onRetry })).rejects.toMatchObject({
    code: 'ECONNREFUSED',
  });
  expect(onRetry).toHaveBeenCalledTimes(3);
});

test('인증 실패는 재시도하지 않는다', async () => {
  vi.spyOn(pool, 'query').mockImplementation(() => {
    throw Object.assign(new Error('password authentication failed'), { code: '28P01' });
  });
  const onRetry = vi.fn();
  await expect(waitForDatabase(pool, { delayMs: 1, onRetry })).rejects.toMatchObject({ code: '28P01' });
  expect(onRetry).not.toHaveBeenCalled();
});

test('재시도 중 DB가 준비되면 성공한다', async () => {
  const query = vi.spyOn(pool, 'query');
  query.mockImplementationOnce(() => {
    throw Object.assign(new Error('starting up'), { code: '57P03' });
  });
  query.mockImplementationOnce(() => Promise.resolve({ rows: [] }));
  await waitForDatabase(pool, { delayMs: 1 });
  expect(query).toHaveBeenCalledTimes(2);
});
