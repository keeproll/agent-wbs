import type { Pool, PoolClient } from '@awbs/db';
import { dropChanges, flushChanges } from '../changes/events.ts';

/** worker도 같은 잠금 규칙을 쓴다. 콜백에는 재시도해도 되는 DB 작업만 넣는다. */
export async function inEpoch<T>(pool: Pool, epoch: number, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select public.lock_epoch($1)', [epoch]);
      const result = await fn(client);
      await flushChanges(client);
      await client.query('commit');
      return result;
    } catch (error) {
      dropChanges(client);
      await client.query('rollback');
      if ((error as { code?: string }).code !== '40P01' || attempt >= 2) throw error;
    } finally { client.release(); }
  }
}
