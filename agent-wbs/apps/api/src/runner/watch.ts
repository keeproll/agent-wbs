import type { Pool } from '@awbs/db';
import { inEpoch } from '../platform/transaction.ts';
import { EXTERNAL_JOBS } from './service.ts';
import { RunnerRepository } from './repository.ts';

/** worker 진입점에서도 호출한다. 시간 경과는 프로세스 종료 증거가 아니다. */
export async function watchRunner(pool: Pool, epoch: number, at?: Date) {
  return inEpoch(pool, epoch, async client => {
    const repo = new RunnerRepository(client);
    await repo.lock();
    const time = at ?? await repo.now();
    const jobs = await repo.expired(time);
    for (const job of jobs) {
      const hold = await repo.hold(job.id);
      await repo.unconfirm(job.id);
      if (hold?.attempt) {
        const a = await repo.attempt(hold.attempt);
        if (a?.status === 'running') {
          await repo.closeAttempt(a, 'interrupted', time, { reason: 'unknown' });
          const task = await repo.taskById(a.task);
          if (task) await repo.historyEvent(task, 'Runner 연결 중단', { attemptId: a.id });
        }
      }
      await repo.state(job.id, EXTERNAL_JOBS.includes(job.kind) ? 'reconcile' : 'cancelled');
      await repo.event(job, 'lease_lost');
      if (hold && hold.slot_state !== 'none') await repo.alert(job.project_id, `unconfirmed:${job.id}`, 'Runner 연결이 끊겨 프로세스 종료를 확인하지 못했습니다.', { jobId:job.id });
    }
    await repo.closeSessions(time);
    return jobs.length;
  });
}
