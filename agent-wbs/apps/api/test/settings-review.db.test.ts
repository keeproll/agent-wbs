import { afterAll, beforeAll, expect, test } from 'vitest';
import { installRunner } from '../src/runner/routes.ts';
import { installProjectRunner } from '../src/project/runner-routes.ts';
import { harness, projectWith, attemptFor, type Body, type Harness } from './m208-fixture.ts';

let h: Harness;
const groups = ['split', 'blackouts', 'workflow', 'models', 'subagents', 'exec-policy', 'schedule', 'concurrency', 'obs-budget', 'github'];
const get = async (key: string) => (await h.lead('GET', `/api/settings/${key}`)).body;
const put = (key: string, body: Body) => h.lead('PUT', `/api/settings/${key}`, body);
const input = (key: string, view: Body): Body => key === 'models'
  ? { updatedAt: view.updatedAt, models: view.models.map((m: Body) => ({ agent: m.agent, id: m.id, allowed: m.allowed })), rankOrder: view.rankOrder }
  : key === 'subagents' ? { updatedAt: view.updatedAt, enabled: view.enabled, allowed: view.defs.map((d: Body) => ({ id: d.id, allowed: d.allowed })) }
    : key === 'github' ? { updatedAt: view.updatedAt, mode: view.mode } : view;
beforeAll(async () => { h = await harness('settings_review', (app, pool) => { installRunner(app, pool); installProjectRunner(app, pool); }); });
afterAll(async () => { await h?.close(); });

test('준비 재점검과 Runner 상태 보고는 열린 설정의 버전을 바꾸지 않는다', async () => {
  const before = new Map<string, Body>();
  for (const key of groups) before.set(key, await get(key));
  await h.owner.query("insert into subagent_defs(def_key,version,agent,role,tools,sandbox,text,hash,allowed) values('reported-definition',1,'Claude','dev','{}','safe','지시','hash',true)");
  expect((await h.lead('POST', '/api/settings/readiness/check')).status).toBe(202);
  expect((await h.runner('POST', '/api/runner/models', { agent: 'Claude', models: [{ id: 'claude-opus-5-5', label: '보고 모델', efforts: ['high'] }] })).status).toBe(200);
  expect((await h.runner('POST', '/api/runner/github/status', { mode: 'gh', ok: false, account: null, scopes: null, expiresAt: null })).status).toBe(204);
  for (const key of groups) {
    expect((await get(key)).updatedAt, key).toBe(before.get(key).updatedAt);
    const saved = await put(key, input(key, before.get(key)));
    expect(saved.status, `${key}: ${JSON.stringify(saved.body)}`).toBe(200);
  }
  const unopened = await get('concurrency');
  const budget = await get('obs-budget');
  expect((await put('obs-budget', { ...budget, budget: { dev: 1, qa: 0 } })).status).toBe(200);
  expect((await get('concurrency')).updatedAt).toBe(unopened.updatedAt);
  expect((await put('concurrency', unopened)).status).toBe(200);
});

test('같은 행의 서로 다른 설정을 동시에 바꿔도 둘 다 남고 같은 설정은 하나만 저장된다', async () => {
  const workflow = await get('workflow');
  const subagents = await get('subagents');
  const result = await Promise.all([
    put('workflow', { ...workflow, heartbeatSeconds: workflow.heartbeatSeconds + 1 }),
    put('subagents', { ...input('subagents', subagents), enabled: !subagents.enabled }),
  ]);
  expect(result.map(r => r.status)).toEqual([200, 200]);
  expect((await get('workflow')).heartbeatSeconds).toBe(workflow.heartbeatSeconds + 1);
  expect((await get('subagents')).enabled).toBe(!subagents.enabled);
  const split = await get('split');
  const sameGroup = await Promise.all([1, 2].map(n => put('split', { ...split, maxHours: split.maxHours + n })));
  expect(sameGroup.map(r => r.status).sort()).toEqual([200, 409]);
});

test('설정 열 묶음 10개는 자기 묶음만 버전을 바꾸고 같은 묶음의 낡은 저장만 거절한다', async () => {
  const originalKey = process.env.AWBS_SECRET_KEY;
  process.env.AWBS_SECRET_KEY = '13'.repeat(32);
  try {
    for (const target of groups) {
      const before = new Map<string, Body>();
      for (const key of groups) before.set(key, await get(key));
      const value = input(target, before.get(target));
      const change: Record<string, () => Body> = {
        split: () => ({ ...value, maxHours: value.maxHours + 1 }),
        blackouts: () => ({ ...value, days: [{ date: '2030-12-24', note: '휴무' }] }),
        workflow: () => ({ ...value, heartbeatSeconds: value.heartbeatSeconds + 1 }),
        models: () => ({ ...value, rankOrder: { ...value.rankOrder, Claude: [...value.rankOrder.Claude].reverse() } }),
        subagents: () => ({ ...value, enabled: !value.enabled }),
        'exec-policy': () => ({ ...value, lowPct: value.lowPct + 1 }),
        schedule: () => ({ ...value, thresholdDays: value.thresholdDays + 1 }),
        concurrency: () => ({ ...value, mode: 'manual', caps: { total: 4, Claude: 2, Codex: 2, heavy: 1 } }),
        'obs-budget': () => ({ ...value, budget: { dev: value.budget.dev + 1, qa: value.budget.qa } }),
        github: () => ({ ...value, mode: 'token', token: 'test-token' }),
      };
      const saved = await put(target, change[target]?.());
      expect(saved.status, `${target}: ${JSON.stringify(saved.body)}`).toBe(200);
      expect(saved.body.updatedAt, target).not.toBe(before.get(target).updatedAt);
      expect((await put(target, value)).status, target).toBe(409);
      for (const key of groups.filter(k => k !== target)) {
        expect((await get(key)).updatedAt, `${target} → ${key}`).toBe(before.get(key).updatedAt);
        const other = await put(key, input(key, before.get(key)));
        expect(other.status, `${target} → ${key}: ${JSON.stringify(other.body)}`).toBe(200);
      }
    }
  } finally {
    if (originalKey === undefined) delete process.env.AWBS_SECRET_KEY;
    else process.env.AWBS_SECRET_KEY = originalKey;
  }
});

test('같은 값 저장은 버전·설정 이력·일정 재계산을 늘리지 않는다', async () => {
  const count = async (table: string) => Number((await h.owner.query(`select count(*) n from ${table}`)).rows[0]?.n);
  const before = [await count('task_history'), await count('replans'), await count('change_events')];
  for (const key of groups) {
    const current = await get(key);
    const saved = await put(key, input(key, current));
    expect(saved.status, key).toBe(200);
    expect(saved.body.updatedAt, key).toBe(current.updatedAt);
  }
  expect([await count('task_history'), await count('replans'), await count('change_events')]).toEqual(before);
  const histories = (await h.owner.query("select text,before,after from task_history where kind='설정'")).rows;
  for (const history of histories) {
    expect(history.text).not.toMatch(/^(split|schedule|blackouts|concurrency|obs-budget|github) /);
    expect(history.before ?? {}).not.toHaveProperty('updatedAt');
    expect(history.after ?? {}).not.toHaveProperty('updatedAt');
  }
});

test('다른 방식의 GitHub 보고는 경고로 남고 옛 확인 작업은 닫히며 설정 버전은 유지된다', async () => {
  const originalKey = process.env.AWBS_SECRET_KEY;
  process.env.AWBS_SECRET_KEY = '14'.repeat(32);
  try { expect((await put('github', { updatedAt: (await get('github')).updatedAt, mode: 'token', token: 'review-token' })).status).toBe(200); }
  finally {
    if (originalKey === undefined) delete process.env.AWBS_SECRET_KEY;
    else process.env.AWBS_SECRET_KEY = originalKey;
  }
  const before = await get('github');
  const jobId = (await h.owner.query<{ id: string }>("insert into runner_jobs(kind,payload,state,fence,lease_owner,lease_until,epoch,dedup_key) values('github_check','{\"mode\":\"gh\"}','leased',1,'runner:runner-1',now()+interval '1 minute',1,gen_random_uuid()::text) returning id")).rows[0]?.id;
  const reported = await h.runner('POST', '/api/runner/github/status', { mode: 'gh', ok: false, account: null, scopes: null, expiresAt: null, jobId, fence: 1 });
  expect(reported.status, JSON.stringify(reported.body)).toBe(204);
  expect(await get('github')).toMatchObject({ mode: 'token', updatedAt: before.updatedAt, warning: expect.stringContaining('gh') });
  expect((await h.owner.query('select state from runner_jobs where id=$1', [jobId])).rows[0]?.state).toBe('cancelled');
  await h.owner.query("insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at) values('review','boot','cpu',8,32,0,100,'linux',1,now())");
  expect((await h.runner('GET', '/api/runner/policy')).body.githubMode).toBe('token');
});

test('같은 하위 Agent의 여러 버전이 한 시도에 있어도 QA 판정은 한 번만 센다', async () => {
  const p = await projectWith(h.owner, ['ready']);
  const task = p.tasks['TASK-0001'] ?? '';
  const dev = await attemptFor(h.owner, p.project, task, { status: 'completed' });
  const qa = await attemptFor(h.owner, p.project, task, { kind: 'qa', no: 2, status: 'completed' });
  for (const version of [1, 2]) {
    const def = (await h.owner.query<{ id: string }>("insert into subagent_defs(def_key,version,agent,role,tools,sandbox,text,hash,allowed) values('two-versions',$1,'Claude','dev','{}','safe','지시','hash',true) returning id", [version])).rows[0]?.id;
    await h.owner.query("insert into attempt_subagents(project_id,attempt,subagent,designated,installed,observed_used,version,def_hash) values($1,$2,$3,true,true,true,$4,'hash')", [p.project, dev, def, version]);
  }
  await h.owner.query("insert into verifications(project_id,attempt,result,head_sha,spec_revision,cmd,expected,actual) values($1,$2,'FAIL',$3,1,'test','통과','실패')", [p.project, qa, 'a'.repeat(40)]);
  const result = (await h.lead('GET', '/api/settings/agent-usage')).body.subagents.find((d: Body) => d.defKey === 'two-versions');
  expect(result).toMatchObject({ decisions: 1, failures: 1, reworkRate: 1 });
});
