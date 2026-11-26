import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { OPERATIONS } from '@awbs/shared/api';
import { jobPayloadErrors } from '@awbs/shared/api';
import { installRunner } from '../src/runner/routes.ts';
import { installProjectRunner } from '../src/project/runner-routes.ts';
import { policyOf, scheduleInput } from '../src/planning/schedule.ts';
import { harness, projectWith, attemptFor, type Harness, type ProjectFixture } from './m208-fixture.ts';

let h: Harness, p: ProjectFixture;
const shared = createRequire(new URL('../../../packages/shared/package.json', import.meta.url));
const { Ajv } = shared('ajv') as { Ajv: new (options: object) => { validate: (schema: unknown, data: unknown) => boolean; errorsText: () => string } };
const ajv = new Ajv({ strict: false });
function contract(id: string, status: number, body: unknown) {
  const op = OPERATIONS.find(x => x.id === id);
  expect(ajv.validate(op?.responses[status], body), ajv.errorsText()).toBe(true);
}
beforeAll(async () => {
  h = await harness('followup3', (app, pool) => { installRunner(app, pool); installProjectRunner(app, pool); });
  p = await projectWith(h.owner, ['ready', 'qa', 'verifying']);
  expect((await h.runner('POST', '/api/runner/host', { hostId: 'sf3-host', bootId: 'sf3-boot', cpu: 'cpu', cores: 8, memGB: 32, swapGB: 0, diskFreeGB: 100, os: 'linux' })).status).toBe(200);
});
afterAll(async () => { await h?.close(); });

test('자동 상한은 저장된 수동 입력 대신 PC 사양을 쓰고 일정도 같은 상한을 쓴다', async () => {
  const before = (await h.lead('GET', '/api/settings/concurrency')).body;
  const saved = await h.lead('PUT', '/api/settings/concurrency', { ...before, mode: 'auto', caps: { total: 0, Claude: 0, Codex: 0, heavy: 0 } });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const policy = (await h.runner('GET', '/api/runner/policy')).body;
  expect(policy.caps.total).toBeGreaterThan(0);
  expect(saved.body.caps.total).toBe(policy.caps.total);
  const client = await h.owner.connect();
  try { expect((await scheduleInput(client, p.project, await policyOf(client))).input.concurrency.total).toBe(policy.caps.total); }
  finally { client.release(); }
});

test('설정 6종은 조회·저장·충돌·이력·변경 이벤트를 제공한다', async () => {
  for (const path of ['split', 'schedule', 'blackouts', 'concurrency', 'obs-budget', 'github']) {
    const read = await h.lead('GET', `/api/settings/${path}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const body = path === 'github' ? { mode: 'gh', updatedAt: read.body.updatedAt } : read.body;
    const saved = await h.lead('PUT', `/api/settings/${path}`, body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.updatedAt).toEqual(expect.any(String));
    const op = OPERATIONS.find(x => x.method === 'PUT' && x.path === `/api/settings/${path}`);
    contract(op?.id ?? '', 200, saved.body);
    expect((await h.lead('GET', `/api/settings/${path}`)).body).toEqual(saved.body);
    expect((await h.lead('PUT', `/api/settings/${path}`, body)).status).toBe(409);
  }
  const policy = (await h.lead('GET', '/api/settings/schedule')).body;
  expect(policy).toMatchObject({ assumeRate: 0.6, thresholdDays: 1 });
  expect((await h.lead('GET', '/api/settings/exec-policy')).body.lowPct).toBe(20);
  const changes = (await h.lead('GET', '/api/changes?after=0')).body.events;
  expect(changes.filter((x: { topic: string }) => x.topic === 'settings').length).toBeGreaterThanOrEqual(6);
});

test('잘못된 분할 범위·불가일 중복과 달력 오류·알 수 없는 필드를 거부한다', async () => {
  const split = (await h.lead('GET', '/api/settings/split')).body;
  expect((await h.lead('PUT', '/api/settings/split', { ...split, minHours: split.maxHours + 1 })).status).toBe(400);
  const blackout = (await h.lead('GET', '/api/settings/blackouts')).body;
  for (const days of [[{ date: '2030-02-30', note: '' }], [{ date: '2030-01-01', note: '' }, { date: '2030-01-01', note: '중복' }]]) {
    expect((await h.lead('PUT', '/api/settings/blackouts', { ...blackout, days })).status).toBe(400);
  }
  expect((await h.lead('PUT', '/api/settings/split', { ...split, extra: true })).status).toBe(400);
});

test('QA·재검증 중 전송과 재전송도 다음 실행을 기다린다', async () => {
  for (const taskKey of ['TASK-0002', 'TASK-0003']) {
    const draft = await h.lead('POST', '/api/messages', { taskKey, type: '추가 지시', toAgent: 'Codex', body: '다음 실행 지시' });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const sent = await h.lead('POST', `/api/messages/${draft.body.id}/send`, { updatedAt: draft.body.updatedAt });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.pendingNext).toBe(true);
    await h.owner.query("update messages set delivery='Failed',fail_reason='시험 실패' where id=$1", [draft.body.id]);
    const current = (await h.lead('GET', `/api/tasks/${taskKey}/messages`)).body.items.find((m: { id: string }) => m.id === draft.body.id);
    const resent = await h.lead('POST', `/api/messages/${draft.body.id}/resend`, { updatedAt: current.updatedAt });
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    expect(resent.body.pendingNext).toBe(true);
  }
});

test('분할 목록은 공통 판정을 쓰고 예외 처리된 위반을 배지에서 뺀다', async () => {
  const result = await h.lead('GET', '/api/settings/split/violations');
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.count).toBe(result.body.items.length);
  expect(result.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ taskKey: 'TASK-0001', violations: expect.any(Number), items: expect.any(Array) })]));
  contract('getSplitViolations', 200, result.body);
  await h.owner.query("insert into task_splits(project_id,task,basis,judged_rules,exceptions) values($1,$2,'','{\"schemaVersion\":1,\"items\":[]}',$3::jsonb)",
    [p.project, p.tasks['TASK-0002'], JSON.stringify([{ rule: 'verify', why: '기존 작업 예외', by: '팀장', at: '2026-11-27T00:00:00Z' }])]);
  const exempt = await h.lead('GET', '/api/settings/split/violations');
  expect(exempt.body.count).toBe(result.body.count - 1);
  expect(exempt.body.items.some((t: { taskKey: string }) => t.taskKey === 'TASK-0002')).toBe(false);
});

test('설정 사용 현황은 잠금·모델 Task·지정/실제 하위 Agent를 구분한다', async () => {
  await h.owner.query("insert into task_grades(project_id,task,role,model_id,effort,reason,locked,locked_by,effective_from) values($1,$2,'dev','claude-opus-5-5','high','근거',true,'팀장',now())", [p.project, p.tasks['TASK-0001']]);
  const a = await attemptFor(h.owner, p.project, p.tasks['TASK-0001'] ?? '', { status: 'completed' });
  const def = (await h.owner.query<{ id: string }>("insert into subagent_defs(def_key,version,agent,role,tools,sandbox,text,hash,allowed,is_demo) values('sf3',1,'Claude','dev','{}','safe','내용','hash',true,false) returning id")).rows[0]?.id;
  await h.owner.query("insert into task_subagents(project_id,task,role,subagent_id,basis) values($1,$2,'dev',$3,'근거')", [p.project, p.tasks['TASK-0001'], def]);
  await h.owner.query('insert into attempt_subagents(project_id,attempt,subagent,designated,installed,observed_used,version,def_hash) values($1,$2,$3,true,true,true,1,\'hash\')', [p.project, a, def]);
  const usage = await h.lead('GET', '/api/settings/agent-usage');
  expect(usage.status, JSON.stringify(usage.body)).toBe(200);
  expect(usage.body.lockedTasks).toEqual([expect.objectContaining({ taskKey: 'TASK-0001', role: 'dev', modelId: 'claude-opus-5-5' })]);
  expect(usage.body.models).toEqual(expect.arrayContaining([expect.objectContaining({ agent: 'Claude', modelId: 'claude-opus-5-5', taskKeys: ['TASK-0001'] })]));
  expect(usage.body.subagents).toEqual([expect.objectContaining({ id: def, taskKeys: ['TASK-0001'], lastUsedAt: expect.any(String), lastTaskKey: 'TASK-0001', decisions: 0, failures: 0, reworkRate: null })]);
  contract('getAgentUsage', 200, usage.body);
});

test('실제 불가일 추가·해제는 일정에 보이고 소수 가동 시간도 계약대로 저장된다', async () => {
  const schedule = (await h.lead('GET', '/api/settings/schedule')).body;
  const changed = await h.lead('PUT', '/api/settings/schedule', { ...schedule, minHours: 71.5 });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(changed.body.minHours).toBe(71.5);
  const blackout = (await h.lead('GET', '/api/settings/blackouts')).body;
  const days = [{ date: '2030-01-01', note: '휴무' }];
  const saved = await h.lead('PUT', '/api/settings/blackouts', { ...blackout, days });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect((await h.lead('GET', '/api/schedule')).body.blackouts).toEqual(days);
  const removed = await h.lead('PUT', '/api/settings/blackouts', { ...saved.body, days: [] });
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect((await h.lead('GET', '/api/schedule')).body.blackouts).toEqual([]);
  expect((await h.owner.query('select count(*)::int n from replans')).rows[0]?.n).toBeGreaterThan(0);
});

test('검증 표시 번호는 결과 필터와 무관하며 대시보드도 같은 번호를 쓴다', async () => {
  const verify = async (taskKey: string, no: number, result: string) => {
    const attempt = await attemptFor(h.owner, p.project, p.tasks[taskKey] ?? '', { kind: 'qa', status: 'completed', no, agent: 'Codex' });
    await h.owner.query("insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual) values($1,$2,$3,$4,1,'test','통과','결과')", [p.project, attempt, result, 'a'.repeat(40)]);
  };
  await verify('TASK-0001', 2, 'PASS');
  await verify('TASK-0001', 3, 'FAIL');
  const all = (await h.lead('GET', '/api/tasks/TASK-0001/verifications')).body;
  expect(all.items.map((v: { verificationKey: string }) => v.verificationKey).sort()).toEqual(['V-0001-1', 'V-0001-2']);
  const failed = (await h.lead('GET', '/api/verifications?result=FAIL')).body.items.find((v: { taskKey: string }) => v.taskKey === 'TASK-0001');
  expect(failed.verificationKey).toBe('V-0001-2');
  const recent = (await h.lead('GET', '/api/dashboard')).body;
  expect(recent.recent).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'verification', id: failed.id, verificationKey: failed.verificationKey })]));
  contract('getDashboard', 200, recent);
  // 첫 QA가 PASS이면 뒤의 FAIL은 이 개발 시도의 실패율을 올리지 않는다.
  const used = (await h.lead('GET', '/api/settings/agent-usage')).body.subagents[0];
  expect(used).toMatchObject({ decisions: 1, failures: 0, reworkRate: 0 });
  const dev = await attemptFor(h.owner, p.project, p.tasks['TASK-0002'] ?? '', { status: 'completed' });
  await h.owner.query("insert into attempt_subagents(project_id,attempt,subagent,designated,installed,observed_used,version,def_hash) values($1,$2,$3,true,true,true,1,'hash')", [p.project, dev, used.id]);
  await verify('TASK-0002', 2, 'BLOCKED');
  await verify('TASK-0002', 3, 'FAIL');
  expect((await h.lead('GET', '/api/settings/agent-usage')).body.subagents[0]).toMatchObject({ decisions: 1, failures: 0, reworkRate: 0 });
});

test('설정 저장이 후속 일정 기록에서 실패하면 설정·이력도 함께 되돌린다', async () => {
  const before = (await h.lead('GET', '/api/settings/schedule')).body;
  await h.owner.query("create function fail_sf3_replan() returns trigger language plpgsql as 'begin raise exception ''시험 실패''; end'");
  await h.owner.query('create trigger fail_sf3_replan before insert on replans for each row execute function fail_sf3_replan()');
  try {
    const saved = await h.lead('PUT', '/api/settings/schedule', { ...before, thresholdDays: before.thresholdDays + 1 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(500);
    expect((await h.lead('GET', '/api/settings/schedule')).body).toEqual(before);
  } finally {
    await h.owner.query('drop trigger fail_sf3_replan on replans');
    await h.owner.query('drop function fail_sf3_replan()');
  }
});

test('알림 확인은 반복 가능하고 숨겨진 알림은 현재 목록에서 빠진다', async () => {
  const id = (await h.owner.query<{ id: string }>("insert into alerts(project_id,key,severity,target) values($1,$2,'warn','{}') returning id", [p.project, randomUUID()])).rows[0]?.id;
  for (let n = 0; n < 2; n++) expect((await h.lead('POST', `/api/alerts/${id}/ack`)).status).toBe(204);
  expect((await h.lead('GET', '/api/alerts')).body.items.some((x: { id: string }) => x.id === id)).toBe(false);
  expect((await h.owner.query('select resolved_at,acknowledged_at is not null acknowledged from alerts where id=$1', [id])).rows[0]).toEqual({ resolved_at: null, acknowledged: true });
  expect((await h.lead('POST', `/api/alerts/${randomUUID()}/ack`)).status).toBe(404);
});

test('점검 요청은 성공 상태를 만들지 않고 Runner 정책에서 전달한다', async () => {
  const key = randomUUID();
  const check = await h.lead('POST', '/api/settings/readiness/check', undefined, { 'idempotency-key': key });
  expect(check.status, JSON.stringify(check.body)).toBe(202);
  expect(check.body.readinessCheckRequest).toBeGreaterThan(0);
  contract('checkReadiness', 202, check.body);
  expect((await h.lead('POST', '/api/settings/readiness/check', undefined, { 'idempotency-key': key })).body).toEqual(check.body);
  expect((await h.owner.query('select * from runner_readiness')).rows).toHaveLength(0);
  expect((await h.runner('GET', '/api/runner/policy')).body.readinessCheckRequest).toBe(check.body.readinessCheckRequest);
});

test('GitHub 확인은 계약에 맞는 Runner 작업만 만들고 토큰은 암호화한다', async () => {
  const read = (await h.lead('GET', '/api/settings/github')).body;
  const token = 'github-test-private-token';
  const originalKey = process.env.AWBS_SECRET_KEY;
  try {
    delete process.env.AWBS_SECRET_KEY;
    expect((await h.lead('PUT', '/api/settings/github', { updatedAt: read.updatedAt, mode: 'token', token })).status).toBe(503);
    expect((await h.lead('GET', '/api/settings/github')).body).toEqual(read);
    process.env.AWBS_SECRET_KEY = '12'.repeat(32);
    const saved = await h.lead('PUT', '/api/settings/github', { updatedAt: read.updatedAt, mode: 'token', token });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ mode: 'token', tokenSet: true, status: 'unchecked' });
    expect(JSON.stringify(saved.body)).not.toContain(token);
    const secret = (await h.owner.query('select * from secrets')).rows;
    expect(secret).toHaveLength(1);
    expect(JSON.stringify(secret)).not.toContain(token);
    const encrypted = Buffer.from(secret[0]?.ciphertext as string, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from('12'.repeat(32), 'hex'), Buffer.from(secret[0]?.nonce as string, 'base64'));
    decipher.setAuthTag(encrypted.subarray(-16));
    expect(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8')).toBe(token);
    const requested = await h.lead('POST', '/api/settings/github/check');
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    const job = (await h.owner.query('select kind,payload from runner_jobs where id=$1', [requested.body.jobId])).rows[0];
    expect(job?.kind).toBe('github_check');
    expect(job?.payload).toEqual({ mode: 'token' });
    expect(jobPayloadErrors(job?.kind as string, job?.payload)).toEqual([]);
    const claimed = await h.runner('POST', '/api/runner/jobs/claim', { kinds: ['github_check'], capacity: 1 });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body.job.id).toBe(requested.body.jobId);
    const report = { mode: 'token', ok: true, account: 'test', scopes: { contents: 'verified', pulls: 'verified', statuses: 'verified', metadata: 'verified' }, expiresAt: null, jobId: requested.body.jobId, fence: claimed.body.job.fence };
    expect((await h.runner('POST', '/api/runner/github/status', { ...report, fence: report.fence + 1 })).status).toBe(409);
    expect((await h.runner('POST', '/api/runner/github/status', report)).status).toBe(204);
    expect((await h.owner.query('select state from runner_jobs where id=$1', [report.jobId])).rows[0]?.state).toBe('done');
    expect((await h.lead('GET', '/api/settings/github')).body.checkedAt).toEqual(expect.any(String));
    expect((await h.owner.query('select count(*)::int n from execution_holds where job=$1', [report.jobId])).rows[0]?.n).toBe(0);
  } finally {
    if (originalKey === undefined) delete process.env.AWBS_SECRET_KEY;
    else process.env.AWBS_SECRET_KEY = originalKey;
  }
});
