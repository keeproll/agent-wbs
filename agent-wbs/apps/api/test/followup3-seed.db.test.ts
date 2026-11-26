import { afterAll, beforeAll, expect, test } from 'vitest';
import { seedDemo } from '@awbs/db';
import { harness, type Harness } from './m208-fixture.ts';

let h: Harness;
beforeAll(async () => { h = await harness('sf3_seed'); });
afterAll(async () => { await h?.close(); });
test('demo 메시지 다음 번호부터 발급하며 실제 메시지 생성이 500으로 실패하지 않는다', async () => {
  await seedDemo(h.owner, 'postgres://unused@127.0.0.1/awbs_test_sf3_seed');
  const max = Number((await h.owner.query("select max(substring(msg_key from 5)::int) n from messages")).rows[0]?.n);
  expect(Number((await h.owner.query("select value from counters where kind='message'")).rows[0]?.value)).toBe(max);
  const created = await h.lead('POST', '/api/messages', { taskKey: 'TASK-0007', type: '추가 지시', toAgent: 'Claude', body: 'seed 다음 메시지' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.msgKey).toBe(`MSG-${String(max + 1).padStart(3, '0')}`);
});
