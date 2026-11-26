import { afterAll, beforeAll, expect, test } from 'vitest';
import { attemptFor, harness, projectWith, type Harness, type ProjectFixture } from './m208-fixture.ts';
import { judgedTasks } from '../src/policy/judged.ts';
import { buildApp } from '../src/app.ts';
import { installRunner } from '../src/runner/routes.ts';
import { issueRunnerToken } from '../src/platform/credentials.ts';

let h: Harness;
let f: ProjectFixture;
beforeAll(async () => {
  h = await harness('followup_p2');
  f = await projectWith(h.owner, ['ready', 'ready']);
  await h.owner.query(`insert into agent_models(agent,model_id,allowed,is_new,report)
    values('Claude','claude-sonnet-5-5',true,false,'{"efforts":["low","high"]}')`);
});
afterAll(() => h.close());
const view = async (key: string) => (await h.lead('GET', `/api/tasks/${key}`)).body;
async function lock(key: string) {
  const current = await view(key);
  const response = await h.lead('PUT', `/api/tasks/${key}/grade`, { updatedAt: current.updatedAt, role: 'dev', modelId: 'claude-sonnet-5-5', effort: 'low' });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}
async function job(payload: object) {
  return (await h.owner.query<{ id: string }>(`insert into runner_jobs(project_id,kind,payload,state,epoch,fence,dedup_key)
    values($1,'estimate',$2,'leased',1,1,gen_random_uuid()::text) returning id`, [f.project, payload])).rows[0]?.id ?? '';
}
const item = (taskKey: string, estHours: number) => ({ taskKey, estHours, loHours: estHours, hiHours: estHours, confidence: '중', basis: '추정 근거', agreedBy: ['Claude', 'Codex'] });
const report = (jobId: string, items: ReturnType<typeof item>[]) => h.runner('POST', '/api/planning/estimates', { jobId, fence: 1, items });
async function snapshot(keys: string[]) {
  const client = await h.owner.connect();
  try { return await judgedTasks(client, keys.map(key => f.tasks[key] ?? '')); }
  finally { client.release(); }
}

test('번호 없는 옛 일반 추정은 최초 등급 고정 뒤 409이고 추정·버전·재조정을 바꾸지 않는다', async () => {
  const tasks = (await snapshot(['TASK-0001'])).map(({ taskKey, subjectHash, content }) => ({ taskKey, subjectHash, content }));
  const old = await job({ tasks, policy: {} });
  expect((await report(old, [item('TASK-0001', 1)])).status).toBe(200);
  await lock('TASK-0001');
  const before = await view('TASK-0001');
  const counts = async () => (await h.owner.query('select (select count(*) from task_estimates) estimates,(select count(*) from replans) replans')).rows;
  const stored = await counts();
  const rejected = await report(old, [item('TASK-0001', 50)]);
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
  expect(rejected.body.error.code).toBe('LEASE_LOST');
  const plan = await h.runner('POST', '/api/planning/tasks/TASK-0001/plan', {
    jobId: old, fence: 1, grades: { dev: { modelId: 'claude-sonnet-5-5', effort: 'high', reason: '옛 판단' }, qa: { modelId: 'gpt-6.2-sol', effort: 'high', reason: '검증' } },
    subagents: { dev: [], qa: [], basis: '' }, conflictGroup: null,
  });
  expect(plan.status, JSON.stringify(plan.body)).toBe(409);
  expect(plan.body.error.code).toBe('LEASE_LOST');
  expect((await view('TASK-0001')).updatedAt).toBe(before.updatedAt);
  expect((await view('TASK-0001')).estimate).toEqual(before.estimate);
  expect(await counts()).toEqual(stored);
});

test('여러 Task의 일반 추정은 각 발행 번호를 담고 하나라도 낡으면 전체 보고를 되돌린다', async () => {
  await lock('TASK-0001');
  const tasks = await snapshot(['TASK-0001', 'TASK-0002']);
  expect(tasks).toEqual([
    expect.objectContaining({ taskKey: 'TASK-0001', gradeChange: expect.any(String) }),
    expect.objectContaining({ taskKey: 'TASK-0002', gradeChange: null }),
  ]);
  const current = await job({ tasks, policy: {} });
  expect((await report(current, [item('TASK-0001', 2), item('TASK-0002', 3)])).status).toBe(200);
  await lock('TASK-0002');
  const before = await view('TASK-0001');
  const rejected = await report(current, [item('TASK-0001', 40), item('TASK-0002', 50)]);
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
  expect((await view('TASK-0001')).estimate).toEqual(before.estimate);
  expect((await view('TASK-0001')).updatedAt).toBe(before.updatedAt);
});

test('정책 재판단 작업도 Task별 번호를 담고 이후 고정·해제 전의 추정은 거부한다', async () => {
  await lock('TASK-0002');
  await h.owner.query("update tasks set primary_domain='DB' where task_key='TASK-0002'");
  const unlocked = await h.lead('DELETE', `/api/tasks/TASK-0002/grade?role=dev&updatedAt=${encodeURIComponent((await view('TASK-0002')).updatedAt)}`);
  expect(unlocked.status).toBe(200);
  let policy = (await h.lead('GET', '/api/settings/exec-policy')).body;
  policy = (await h.lead('PUT', '/api/settings/exec-policy', { ...policy, floors: { verifyGeDev: true, dbHigh: false } })).body;
  expect((await h.lead('PUT', '/api/settings/exec-policy', { ...policy, floors: { verifyGeDev: true, dbHigh: true } })).status).toBe(200);
  const requested = (await h.owner.query<{ id: string; payload: { tasks: { taskKey: string; gradeChange?: string | null }[] } }>(
    "select id,payload from runner_jobs where payload->'policy'->'rejudge'->>'reason'='floor_changed' order by created_at desc limit 1")).rows[0];
  expect(requested?.payload.tasks.find(t => t.taskKey === 'TASK-0002')?.gradeChange).toEqual(expect.any(String));
  await lock('TASK-0002');
  await h.owner.query("update runner_jobs set state='leased',fence=1 where id=$1", [requested?.id]);
  const rejected = await report(requested?.id ?? '', [item('TASK-0002', 50)]);
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
  expect(rejected.body.error.code).toBe('LEASE_LOST');
});

test('int4 상한 밖 정책 입력은 500 대신 400이고 상한 자체는 저장된다', async () => {
  const before = (await h.lead('GET', '/api/settings/exec-policy')).body;
  const bad = await h.lead('PUT', '/api/settings/exec-policy', { ...before, autoRetryLimit: 2147483648 });
  expect(bad.status, JSON.stringify(bad.body)).toBe(400);
  expect(bad.body.error.errors).toContainEqual(expect.objectContaining({ path: 'autoRetryLimit', rule: 'maximum' }));
  expect((await h.lead('GET', '/api/settings/exec-policy')).body).toEqual(before);
  const boundary = await h.lead('PUT', '/api/settings/exec-policy', { ...before, autoRetryLimit: 2147483647 });
  expect(boundary.status, JSON.stringify(boundary.body)).toBe(200);
  expect(boundary.body.autoRetryLimit).toBe(2147483647);
  expect((await h.lead('GET', `/api/changes?after=${String(Number.MAX_SAFE_INTEGER)}`)).status).toBe(200);
  const edited = await h.lead('PATCH', '/api/tasks/TASK-0001', { updatedAt: (await view('TASK-0001')).updatedAt,
    estimate: { estHours: 2, loHours: 1, hiHours: 3, tokensK: 2147483648 } });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  expect(edited.body.task.estimate.tokensK).toBe(2147483648);
});

test('실제 Runner 보고의 int4 범위와 동시 실행 합계도 저장 전에 검사한다', async () => {
  const app = buildApp(h.pool);
  installRunner(app, h.pool);
  const bearer = await issueRunnerToken(h.pool, 'integer-runner', 'fake');
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url,
    headers: { authorization: `Bearer ${bearer}`, 'x-project-epoch': '1', 'idempotency-key': crypto.randomUUID() }, payload });
  try {
    const host = { hostId: 'integer-host', bootId: 'boot', cpu: 'cpu', cores: 4, memGB: 16, swapGB: 0, diskFreeGB: 500, os: 'Linux', samples: 1 };
    expect((await post('/api/runner/host', host)).statusCode).toBe(200);
    for (const field of ['cores', 'samples']) {
      const bad = await post('/api/runner/host', { ...host, [field]: 2147483648 });
      expect(bad.statusCode, bad.body).toBe(400);
      expect(bad.json()).toMatchObject({ error: { errors: [{ path: field, rule: 'maximum' }] } });
    }
    const before = (await h.owner.query('select count(*) from runner_concurrency_log')).rows;
    const sum = await post('/api/runner/concurrency', { at: '2026-11-27T00:00:00Z', limit: 1,
      running: { Claude: 2147483647, Codex: 2147483647 }, subagents: 0, heavyJobs: 0,
      resources: { cpuPct: 0, memFreeGB: 10, swapGB: 0 }, sessions: [] });
    expect(sum.statusCode, sum.body).toBe(400);
    expect(sum.json()).toMatchObject({ error: { errors: [{ path: 'running', rule: 'maximum' }] } });
    expect((await h.owner.query('select count(*) from runner_concurrency_log')).rows).toEqual(before);
    const attempt = await attemptFor(h.owner, f.project, f.tasks['TASK-0001'] ?? '', {});
    await h.owner.query(`insert into execution_holds(project_id,job,attempt,epoch,host_id,boot_id,fence,task,agent,slots,heavy,slot_state,lock_state)
      select project_id,job,id,1,'integer-host','boot',1,task,agent,1,false,'reserved','held' from task_attempts where id=$1`, [attempt]);
    const slots = await post('/api/runner/concurrency', { at: '2026-11-27T00:00:00Z', limit: 1,
      running: { Claude: 1, Codex: 0 }, subagents: 2147483647, heavyJobs: 0,
      resources: { cpuPct: 0, memFreeGB: 10, swapGB: 0 }, sessions: [{ attemptId: attempt, observed: 2147483647, reserved: 0, state: 'ok' }] });
    expect(slots.statusCode, slots.body).toBe(400);
    expect(slots.json()).toMatchObject({ error: { errors: [{ path: 'sessions.0.observed', rule: 'maximum' }] } });
    expect((await h.owner.query('select slots from execution_holds where attempt=$1', [attempt])).rows).toEqual([{ slots: 1 }]);
  } finally { await app.close(); }
});

test('등급 고정 뒤 새 분할 작업은 현재 번호를 담고 등급이 바뀌면 새 작업을 만든다', async () => {
  const split = async () => {
    const result = await h.lead('POST', '/api/tasks/TASK-0002/split', { updatedAt: (await view('TASK-0002')).updatedAt });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    return result.body.jobId as string;
  };
  const first = await split();
  const row = (await h.owner.query<{ payload: { tasks: { gradeChange?: string | null }[] } }>('select payload from runner_jobs where id=$1', [first])).rows[0];
  expect(row?.payload.tasks[0]?.gradeChange).toEqual(expect.any(String));
  const changed = await h.lead('PUT', '/api/tasks/TASK-0002/grade', { updatedAt: (await view('TASK-0002')).updatedAt,
    role: 'dev', modelId: 'claude-sonnet-5-5', effort: 'high' });
  expect(changed.status).toBe(200);
  const second = await split();
  expect(second).not.toBe(first);
  await h.owner.query("update runner_jobs set state='leased',fence=1 where id=$1", [second]);
  const result = await h.runner('POST', '/api/planning/tasks/TASK-0002/plan', { jobId: second, fence: 1,
    grades: { dev: { modelId: 'claude-sonnet-5-5', effort: 'high', reason: '현재 판단' }, qa: { modelId: 'gpt-6.2-sol', effort: 'high', reason: '검증' } },
    subagents: { dev: [], qa: [], basis: '' }, conflictGroup: null });
  expect(result.status, JSON.stringify(result.body)).toBe(204);
});
