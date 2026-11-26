import { afterEach, beforeEach, expect, test } from 'vitest';
import { ApiTransportError } from '../../../../agent-runner/src/api/client.ts';
import { scenario, type Scenario } from './scenario.ts';

let h: Scenario;
beforeEach(async () => { h = await scenario(); });
afterEach(async () => { await h?.close(); });

test('시나리오 6: Claude 개발 → Codex QA FAIL → 등급 상향 재작업 → 재검증 PASS', async () => {
  expect((await h.run('TASK-0001')).status).toBe(202);
  const dev = await h.runner.startNext();
  expect(dev?.job.payload).toMatchObject({ kind: 'dev', agent: 'Claude' });
  if (!dev) throw new Error('개발 시도가 필요합니다.');
  await h.runner.result(dev);
  const qa = await h.runner.startNext();
  expect(qa?.job.payload).toMatchObject({ kind: 'qa', agent: 'Codex' });
  if (!qa) throw new Error('QA 시도가 필요합니다.');
  await h.runner.result(qa, 'FAIL');
  expect((await h.lead('GET', '/api/tasks/TASK-0001/verifications')).body).toMatchObject({ items: [expect.objectContaining({ result: 'FAIL' })] });
  const rework = await h.runner.startNext();
  // 재작업은 개발 담당(Claude), 재검증은 검증 담당(Codex)이어야 한다(교차 리뷰 F5).
  expect(rework?.job.payload).toMatchObject({ kind: 'rework', agent: 'Claude' });
  expect(rework?.grade).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' });
  if (!rework) throw new Error('재작업 시도가 필요합니다.');
  await h.runner.result(rework);
  const reverify = await h.runner.startNext();
  expect(reverify?.job.payload).toMatchObject({ kind: 'reverify', agent: 'Codex' });
  if (!reverify) throw new Error('재검증 시도가 필요합니다.');
  await h.runner.result(reverify, 'PASS');
  expect((await h.lead('GET', '/api/tasks/TASK-0001/verifications')).body).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ result: 'FAIL' }), expect.objectContaining({ result: 'PASS' })]) });
  expect((await h.rows('select kind,agent,status,effort from task_attempts order by attempt_no'))).toMatchObject([
    { kind: 'dev', agent: 'Claude', status: 'completed', effort: 'high' }, { kind: 'qa', agent: 'Codex', status: 'completed' },
    { kind: 'rework', agent: 'Claude', status: 'completed', effort: 'xhigh' }, { kind: 'reverify', agent: 'Codex', status: 'completed' },
  ]);
});

test('시나리오 8: 연결 끊김 → 전달 실패 → 재연결 → 같은 메시지 재전송·수신 확인', async () => {
  const draft = await h.lead('POST', '/api/messages', { taskKey: 'TASK-0001', type: '추가 지시', toAgent: 'Claude', body: '오류 설명을 한글로 작성해 주세요.' });
  expect(draft.status).toBe(201);
  await h.lead('POST', `/api/messages/${String(draft.body.id)}/send`, { updatedAt: draft.body.updatedAt });
  h.runner.online = false;
  await expect(h.runner.messages()).rejects.toThrow(ApiTransportError);
  await h.watchDisconnected();
  const failed = await h.message(String(draft.body.id));
  expect(failed).toMatchObject({ delivery: 'Failed' });
  h.runner.online = true;
  await h.runner.reconnect();
  const resent = await h.lead('POST', `/api/messages/${String(draft.body.id)}/resend`, { updatedAt: failed.updatedAt });
  expect(resent.status, JSON.stringify(resent.body)).toBe(200);
  const messages = await h.runner.messages();
  expect(messages.map(m => m.id)).toEqual([draft.body.id]);
  await h.runner.ack(String(draft.body.id));
  await h.runner.ack(String(draft.body.id));
  expect(await h.message(String(draft.body.id))).toMatchObject({ delivery: 'Acknowledged', workState: null });
  expect(await h.runner.messages()).toEqual([]);
});

test('시나리오 9: 재부팅 → 중단 → 종료 증거 전 재개 거절 → 같은 등급의 새 시도', async () => {
  expect(await h.runner.startNext()).toBeUndefined();
  expect((await h.run('TASK-0001')).status).toBe(202);
  const first = await h.runner.startNext();
  expect(first).toBeDefined();
  if (!first) throw new Error('실행 중 시도가 필요합니다.');
  await h.runner.reboot();
  expect(await h.rows('select status from task_attempts')).toEqual([{ status: 'interrupted' }]);
  expect((await h.resume(first.attemptId)).status).toBe(409);
  await h.runner.releaseAfterReboot(first);
  expect((await h.resume(first.attemptId)).status).toBe(202);
  const resumed = await h.runner.startNext();
  expect(resumed?.attemptId).not.toBe(first.attemptId);
  expect(resumed?.grade).toMatchObject({ model: first.grade.model, effort: first.grade.effort });
  expect(await h.rows("select resumed_from from task_attempts where status='running'")).toEqual([{ resumed_from: first.attemptId }]);
  expect((await h.lead('GET', '/api/tasks/TASK-0001')).body).toMatchObject({ lifecycleStatus: 'running' });
});

test('시나리오 10: Claude 한도 도달 → 해당 Agent만 실행 보류·리셋 이후 일정 → 리셋', async () => {
  const before = await h.lead('GET', '/api/schedule');
  expect(before.status).toBe(200);
  const resetAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await h.runner.usage('Claude', 0, resetAt);
  expect((await h.run('TASK-0001')).status).toBe(409);
  expect((await h.run('TASK-0002')).status).toBe(202);
  expect((await h.runner.startNext())?.job.payload.agent).toBe('Codex');
  const delayed = await h.lead('GET', '/api/schedule');
  expect(delayed.status, JSON.stringify(delayed.body)).toBe(200);
  const task = (delayed.body.tasks as { taskKey: string; start: string }[]).find(t => t.taskKey === 'TASK-0001');
  expect(task?.start).toBeDefined();
  expect(String(task?.start) >= resetAt.slice(0, 10)).toBe(true);
  await h.runner.usage('Claude', 100);
  expect((await h.run('TASK-0001')).status).toBe(202);
  expect((await h.runner.startNext())?.job.payload.agent).toBe('Claude');
  const reset = await h.lead('GET', '/api/schedule');
  const after = (reset.body.tasks as { taskKey: string; start: string }[]).find(t => t.taskKey === 'TASK-0001');
  expect(String(after?.start) < String(task?.start)).toBe(true);
});

test('메시지 수신 확인: 연결 복구 후 중복 조회·중복 ack도 메시지를 한 번만 확인한다', async () => {
  const draft = await h.lead('POST', '/api/messages', { taskKey: 'TASK-0001', type: '질문', toAgent: 'Claude', body: '검증 방법을 알려 주세요.' });
  expect(draft.status).toBe(201);
  expect((await h.lead('POST', `/api/messages/${String(draft.body.id)}/send`, { updatedAt: draft.body.updatedAt })).status).toBe(200);
  h.runner.online = false;
  await expect(h.runner.messages()).rejects.toThrow(ApiTransportError);
  expect(await h.message(String(draft.body.id))).toMatchObject({ delivery: 'Queued' });
  h.runner.online = true;
  expect((await h.runner.messages()).map(m => m.id)).toEqual([draft.body.id]);
  expect((await h.runner.messages()).map(m => m.id)).toEqual([draft.body.id]);
  await h.runner.ack(String(draft.body.id));
  await h.runner.ack(String(draft.body.id));
  expect(await h.message(String(draft.body.id))).toMatchObject({ delivery: 'Acknowledged', workState: null });
  expect(await h.runner.messages()).toEqual([]);
  expect(await h.rows("select count(*)::int n from messages where dir='out'")).toEqual([{ n: 1 }]);
});
