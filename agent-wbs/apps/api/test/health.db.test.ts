import { createPool } from '@awbs/db';
import { expect, inject, test } from 'vitest';
import { buildApp } from '../src/app.ts';

test('GET /health/db는 실제 DB에서 200과 지연 시간을 준다', async () => {
  const pool = createPool(inject('testDatabaseUrl'), { onError: () => undefined });
  const app = buildApp(pool);
  try {
    const response = await app.inject('/health/db');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ db: 'ok', latencyMs: expect.any(Number) as number });
  } finally {
    await app.close();
    await pool.end();
  }
});
