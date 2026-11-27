import { expect, test } from 'vitest';
import { apiCiReport } from '../../src/ci/night/report.ts';
import type { ApiClient } from '../../src/api/client.ts';

test('시작은 client로 바로 부르고 갱신은 outbox의 일반 멱등 키로 쌓은 뒤 보낸다', async () => {
  const calls: unknown[] = [];
  const api = (async (id: string, request: unknown) => { calls.push({ id, request }); return { status: 201, body: { id: 'r1', runKey: 'CI-1' }, headers: new Headers() }; }) as unknown as ApiClient;
  const queued: { op: string; request: { idempotencyKey: string; params: unknown; body: unknown; epoch: number } }[] = [];
  let flushed = 0;
  const outbox = { enqueue: async (op: string, request: never) => { queued.push({ op, request }); return {} as never; }, flush: async () => { flushed++; } };
  const report = apiCiReport({ api, outbox: outbox as never, epoch: () => 3, runnerId: () => 'runner-1' });
  const body = { stage: 'night' as const, ref: 'main', trigger: '야간 일정', pipelineSha: 'a'.repeat(40) };
  expect(await report.start(body, 'night:2026-11-27')).toEqual({ id: 'r1', runKey: 'CI-1' });
  expect(calls).toEqual([{ id: 'startCiRun', request: { body, epoch: 3, idempotencyKey: 'night:2026-11-27' } }]);
  await report.update('r1', { fence: null, status: 'run' });
  expect(queued[0]?.op).toBe('updateCiRun');
  expect(queued[0]?.request).toMatchObject({ params: { id: 'r1' }, body: { fence: null, status: 'run' }, epoch: 3 });
  expect(queued[0]?.request.idempotencyKey).toMatch(/^updateCiRun:runner-1:[0-9a-f-]{36}$/);
  expect(flushed).toBe(1);
  await report.start({ ...body, stage: 'deploy', jobId: 'j', fence: 1 } as never);
  expect((calls[1] as { request: { idempotencyKey: string } }).request.idempotencyKey).toMatch(/^startCiRun:runner-1:[0-9a-f-]{36}$/);
});
