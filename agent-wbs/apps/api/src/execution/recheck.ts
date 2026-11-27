import type { Pool } from '@awbs/db';
import { inEpoch } from '../platform/transaction.ts';
import { RunnerRepository } from '../runner/repository.ts';
import { enqueueIntegration } from './gate.ts';

/** Runner의 재보고 없이도 저장된 병합 근거와 현재 Gate를 다시 판정한다. */
export async function recheckMergedTasks(pool: Pool): Promise<void> {
  const epoch = (await pool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch;
  if (epoch === undefined) return;
  await inEpoch(pool,epoch,async client => {
    await new RunnerRepository(client).lock();
    const tasks = await client.query<{ id: string }>(`select t.id from tasks t where t.status='gate'
      and exists(select 1 from merge_queue q where q.task=t.id and q.status='merged') order by t.id`);
    for (const task of tasks.rows) await enqueueIntegration(client,task.id,epoch);
  });
}

export function startCompletionRecheck(pool: Pool, onError: (error: unknown) => void) {
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (!pending) pending = recheckMergedTasks(pool).catch(onError).finally(() => { pending = undefined; });
  },5000);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}
