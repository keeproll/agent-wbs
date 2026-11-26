// M2-08 실행 정책·모델·하위 Agent 설정(G§7, contracts §2.1 settings)과 D-29 — 실제 PostgreSQL.
import { DEFAULT_MODEL_SETTINGS } from '@awbs/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { applyRegrade, recordResumeRegrade, resumeGrade } from '../src/policy/service.ts';
import { inEpoch } from '../src/platform/transaction.ts';
import { attemptFor, harness, projectWith, type Harness, type ProjectFixture } from './m208-fixture.ts';

let h: Harness;
let f: ProjectFixture;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const model = (agent: string, id: string, allowed: boolean, isNew = false, efforts: string[] | null = EFFORTS) =>
  h.owner.query('insert into agent_models(agent,model_id,allowed,is_new,report) values($1,$2,$3,$4,$5)', [agent, id, allowed, isNew, { label: id.toUpperCase(), efforts }]);
const grade = (task: string, role: string, modelId: string, effort: string, locked = false) =>
  h.owner.query("insert into task_grades(project_id,task,role,model_id,effort,reason,locked,locked_by,effective_from) values($1,$2,$3,$4,$5,'Planning 판단',$6,$7,now())",
    [f.project, f.tasks[task], role, modelId, effort, locked, locked ? '팀장' : null]);
const gradeOf = async (task: string, role = 'dev') => (await h.owner.query<{ model_id: string; effort: string; locked: boolean; reason: string }>(
  'select model_id,effort,locked,reason from task_grades where task=$1 and role=$2', [f.tasks[task], role])).rows[0];
const jobs = async () => (await h.owner.query<{ kind: string; payload: { reason: string; tasks: { taskKey: string; roles: string[] }[] }; state: string }>(
  "select kind,payload,state from runner_jobs where payload ? 'reason' order by created_at,dedup_key")).rows;
const taskVersion = async (task: string) => (await h.owner.query<{ v: string }>('select updated_at::text as v from tasks where task_key=$1', [task])).rows[0]?.v;

beforeAll(async () => {
  h = await harness('m208_policy');
  // TASK-0001 중단(재개 대기), TASK-0002 완료, TASK-0003 DB 작업(준비), TASK-0004 실행 중
  f = await projectWith(h.owner, ['paused', 'done', 'ready', 'running']);
  await h.owner.query("update tasks set primary_domain='DB' where task_key='TASK-0003'");
  await model('Claude', 'claude-opus-5-5', true);
  await model('Claude', 'claude-sonnet-5-5', true);
  await model('Claude', 'claude-fable-5-2', false, true, null);
  await model('Codex', 'gpt-6.2-sol', true);
  await grade('TASK-0001', 'dev', 'claude-opus-5-5', 'high', true);
  await grade('TASK-0001', 'qa', 'gpt-6.2-sol', 'high');
  await grade('TASK-0002', 'dev', 'claude-opus-5-5', 'high');
  await grade('TASK-0003', 'dev', 'claude-sonnet-5-5', 'medium');
  await grade('TASK-0004', 'dev', 'claude-sonnet-5-5', 'high');
  await h.owner.query("insert into agent_usage(agent,remain_pct,reset_at) values('Claude',50,now()+interval '1 day')");
});
afterAll(async () => { await h.close(); });

describe('실행 정책 /api/settings/exec-policy', () => {
  test('조회: seed 값, 사용량 부족 기준은 저장 전이면 기본 20%(owner 2026-11-26)', async () => {
    const res = await h.lead('GET', '/api/settings/exec-policy');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ onUsage: 'wait', lowPct: 20, onRework: 'up1', notifyAt: 2, floors: { verifyGeDev: true, dbHigh: true }, autoRetryLimit: 2, autoReworkLimit: 3 });
    expect(res.body.updatedAt).toEqual(expect.any(String));
  });

  test('저장: 낡은 버전 409, 저장하면 이력·변경 이벤트', async () => {
    const current = (await h.lead('GET', '/api/settings/exec-policy')).body;
    const body = { ...current, onUsage: 'down', lowPct: 10, notifyAt: 3 };
    const saved = await h.lead('PUT', '/api/settings/exec-policy', body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ onUsage: 'down', lowPct: 10, notifyAt: 3 });
    expect((await h.lead('PUT', '/api/settings/exec-policy', body)).body.error.code).toBe('VERSION_CONFLICT');
    const row = (await h.owner.query('select on_usage,low_pct,esc_notify from exec_policy')).rows[0];
    expect(row).toEqual({ on_usage: 'down', low_pct: 10, esc_notify: 3 });
    expect((await h.owner.query("select ref from change_events where topic='settings'")).rows).toContainEqual({ ref: { key: 'exec-policy' } });
    expect((await h.owner.query("select kind,task from task_history where text like '실행 정책 변경%'")).rows).toContainEqual({ kind: '설정', task: null });
  });

  test('최저선을 켜면 그 아래가 된 진행 전 Task 등급을 Planning 재판단에 맡긴다', async () => {
    let current = (await h.lead('GET', '/api/settings/exec-policy')).body;
    current = (await h.lead('PUT', '/api/settings/exec-policy', { ...current, floors: { verifyGeDev: true, dbHigh: false } })).body;
    const before = (await jobs()).length;
    const saved = await h.lead('PUT', '/api/settings/exec-policy', { ...current, floors: { verifyGeDev: true, dbHigh: true } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const created = (await jobs()).slice(before);
    expect(created).toEqual([{ kind: 'estimate', state: 'queued', payload: expect.objectContaining({ reason: 'floor_changed', tasks: [{ taskKey: 'TASK-0003', roles: ['dev'] }] }) }]);
    expect((await h.owner.query("select count(*)::int as n from task_history where text like '%최저선%' and task=$1", [f.tasks['TASK-0003']])).rows[0]?.n).toBe(1);
  });

  test('입력 검증: 모르는 값·범위 밖은 400', async () => {
    const current = (await h.lead('GET', '/api/settings/exec-policy')).body;
    expect((await h.lead('PUT', '/api/settings/exec-policy', { ...current, onRework: 'twice' })).status).toBe(400);
    expect((await h.lead('PUT', '/api/settings/exec-policy', { ...current, lowPct: 101 })).status).toBe(400);
    expect((await h.lead('PUT', '/api/settings/exec-policy', { ...current, extra: 1 })).status).toBe(400);
  });
});

describe('Agent 역할·기본 Workflow /api/settings/workflow', () => {
  test('기본값은 Claude 개발 → Codex 검증, 실행 중 전달은 exec_policy.live_inject에 저장', async () => {
    const current = (await h.lead('GET', '/api/settings/workflow')).body;
    expect(current).toMatchObject({ devAgent: 'Claude', qaAgent: 'Codex', liveInject: false, heartbeatSeconds: 60, missedHeartbeats: 3 });
    const saved = await h.lead('PUT', '/api/settings/workflow', { ...current, devAgent: 'Codex', liveInject: true, heartbeatSeconds: 30 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ devAgent: 'Codex', qaAgent: 'Codex', liveInject: true, heartbeatSeconds: 30 });
    expect((await h.owner.query('select live_inject from exec_policy')).rows[0]).toEqual({ live_inject: true });
    expect((await h.owner.query('select heartbeat_seconds from app_settings')).rows[0]).toEqual({ heartbeat_seconds: 30 });
    expect((await h.lead('PUT', '/api/settings/workflow', { ...current, devAgent: 'Claude' })).body.error.code).toBe('VERSION_CONFLICT');
  });
});

describe('모델 /api/settings/models', () => {
  test('조회: 서버 순서에서 계산한 rank, 모델별 Effort 공통 단계, 신규 보고 표시', async () => {
    const res = await h.lead('GET', '/api/settings/models');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rankOrder).toEqual(DEFAULT_MODEL_SETTINGS.rankOrder);
    const opus = res.body.models.find((m: { id: string }) => m.id === 'claude-opus-5-5');
    expect(opus).toMatchObject({ agent: 'Claude', label: 'CLAUDE-OPUS-5-5', rank: 3, allowed: true, isNew: false });
    expect(opus.efforts).toEqual([{ key: 'low', level: 1 }, { key: 'medium', level: 2 }, { key: 'high', level: 3 }, { key: 'xhigh', level: 4 }, { key: 'max', level: 5 }]);
    expect(res.body.models.find((m: { id: string }) => m.id === 'claude-fable-5-2')).toMatchObject({ rank: 4, allowed: false, isNew: true, efforts: null });
  });

  test('마지막 허용 모델 해제·보고 안 된 모델은 400', async () => {
    const current = (await h.lead('GET', '/api/settings/models')).body;
    const last = await h.lead('PUT', '/api/settings/models', { updatedAt: current.updatedAt, models: [{ agent: 'Codex', id: 'gpt-6.2-sol', allowed: false }] });
    expect(last.body.error).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'models', rule: 'minAllowed' }] });
    const unknown = await h.lead('PUT', '/api/settings/models', { updatedAt: current.updatedAt, models: [{ agent: 'Codex', id: 'gpt-x', allowed: true }] });
    expect(unknown.body.error.errors).toEqual([expect.objectContaining({ path: 'models.0.id', rule: 'exists' })]);
  });

  test('순서를 바꾸면 rank를 다시 계산해 저장한다', async () => {
    const current = (await h.lead('GET', '/api/settings/models')).body;
    const order = { ...current.rankOrder, Claude: ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2'] };
    const saved = await h.lead('PUT', '/api/settings/models', { updatedAt: current.updatedAt, models: [], rankOrder: order });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await h.owner.query("select rank from agent_models where model_id='claude-sonnet-5-5'")).rows[0]).toEqual({ rank: 3 });
    expect((await h.owner.query("select model_settings->'rankOrder'->'Claude' as o from app_settings")).rows[0]?.o).toEqual(order.Claude);
    // 낡은 화면(바꾸기 전 버전)으로 다시 저장하면 409
    expect((await h.lead('PUT', '/api/settings/models', { updatedAt: current.updatedAt, models: [] })).body.error.code).toBe('VERSION_CONFLICT');
    const back = await h.lead('PUT', '/api/settings/models', { updatedAt: saved.body.updatedAt, models: [], rankOrder: DEFAULT_MODEL_SETTINGS.rankOrder });
    expect(back.status).toBe(200);
  });
});

describe('D-29: 허용 해제 → 재판단 → 재개 이력 (실제 DB)', () => {
  let attempt = '';
  beforeAll(async () => {
    attempt = await attemptFor(h.owner, f.project, f.tasks['TASK-0001'] ?? '', { kind: 'dev', status: 'interrupted', modelId: 'claude-opus-5-5', effort: 'high' });
  });

  test('허용 중이면 같은 등급으로 재개(재판단 이력 없음)', async () => {
    const result = await inEpoch(h.pool, 1, (client) => resumeGrade(client, attempt));
    expect(result).toMatchObject({ ok: true, grade: { modelId: 'claude-opus-5-5', effort: 'high' }, adjust: { kind: 'resume' } });
  });

  test('1) 팀장이 허용 해제: 그 모델을 쓰는 진행 전·중 Task 등급은 고정 해제 + 이력 + Planning 재판단 작업, 완료 Task는 그대로', async () => {
    const version = await taskVersion('TASK-0001');
    const current = (await h.lead('GET', '/api/settings/models')).body;
    const before = (await jobs()).length;
    const saved = await h.lead('PUT', '/api/settings/models', { updatedAt: current.updatedAt, models: [{ agent: 'Claude', id: 'claude-opus-5-5', allowed: false }] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.models.find((m: { id: string }) => m.id === 'claude-opus-5-5').allowed).toBe(false);
    expect(await gradeOf('TASK-0001')).toMatchObject({ model_id: 'claude-opus-5-5', locked: false });
    expect(await gradeOf('TASK-0002')).toMatchObject({ model_id: 'claude-opus-5-5', locked: false });
    expect(await taskVersion('TASK-0001')).not.toBe(version);
    const created = (await jobs()).slice(before);
    expect(created).toEqual([{ kind: 'estimate', state: 'queued', payload: expect.objectContaining({ reason: 'model_disallowed', tasks: [{ taskKey: 'TASK-0001', roles: ['dev'] }] }) }]);
    const hist = (await h.owner.query<{ actor: string; text: string; before: unknown }>("select actor,text,before from task_history where task=$1 and kind='실행 등급' order by at", [f.tasks['TASK-0001']])).rows;
    expect(hist.at(-1)).toMatchObject({ actor: '팀장', before: { modelId: 'claude-opus-5-5', effort: 'high', locked: true } });
    expect(hist.at(-1)?.text).toContain('고정 해제');
  });

  test('2) 재판단 전에는 재개하지 않는다', async () => {
    expect(await inEpoch(h.pool, 1, (client) => resumeGrade(client, attempt))).toEqual({ ok: false, code: 'MODEL_NOT_ALLOWED' });
  });

  test('3) 재판단 결과 저장: 허용 안 된 모델·매핑 없는 Effort는 거부, 허용 모델이면 새 등급 + 이전→이후 이력', async () => {
    await expect(inEpoch(h.pool, 1, (client) => applyRegrade(client, { taskKey: 'TASK-0001', role: 'dev', modelId: 'claude-opus-5-5', effort: 'high', reason: 'x' })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(inEpoch(h.pool, 1, (client) => applyRegrade(client, { taskKey: 'TASK-0001', role: 'dev', modelId: 'claude-sonnet-5-5', effort: 'ultra', reason: 'x' })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(inEpoch(h.pool, 1, (client) => applyRegrade(client, { taskKey: 'TASK-0002', role: 'dev', modelId: 'claude-sonnet-5-5', effort: 'high', reason: 'x' })))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // DB 작업은 최저선 「높음 이상」 — 보통(medium)으로는 재판단할 수 없다.
    await expect(inEpoch(h.pool, 1, (client) => applyRegrade(client, { taskKey: 'TASK-0003', role: 'dev', modelId: 'claude-sonnet-5-5', effort: 'medium', reason: 'x' })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'effort', rule: 'floor' }] });
    await inEpoch(h.pool, 1, (client) => applyRegrade(client, { taskKey: 'TASK-0001', role: 'dev', modelId: 'claude-sonnet-5-5', effort: 'high', reason: '허용 모델 중 차상위 — 구현 작업' }));
    expect(await gradeOf('TASK-0001')).toEqual({ model_id: 'claude-sonnet-5-5', effort: 'high', locked: false, reason: '허용 모델 중 차상위 — 구현 작업' });
    const last = (await h.owner.query("select actor,before,after from task_history where task=$1 and kind='실행 등급' order by at desc limit 1", [f.tasks['TASK-0001']])).rows[0];
    expect(last).toEqual({ actor: 'Planning Agent', before: { modelId: 'claude-opus-5-5', effort: 'high', locked: false }, after: { modelId: 'claude-sonnet-5-5', effort: 'high', locked: false } });
  });

  test('4) 재개: 재판단한 새 등급으로, 이전→이후·사유를 이력에 남긴다', async () => {
    const result = await inEpoch(h.pool, 1, (client) => resumeGrade(client, attempt));
    expect(result).toMatchObject({ ok: true, grade: { modelId: 'claude-sonnet-5-5', effort: 'high' }, adjust: { kind: 'regrade' } });
    await inEpoch(h.pool, 1, (client) => recordResumeRegrade(client, attempt));
    const last = (await h.owner.query("select actor,text,before,after,ref from task_history where task=$1 order by at desc limit 1", [f.tasks['TASK-0001']])).rows[0];
    expect(last).toMatchObject({
      actor: '시스템', before: { modelId: 'claude-opus-5-5', effort: 'high' }, after: { modelId: 'claude-sonnet-5-5', effort: 'high' },
      ref: { taskKey: 'TASK-0001', adjust: 'regrade', reason: 'MODEL_NOT_ALLOWED', attemptId: attempt },
    });
    expect(last?.text).toContain('허용 해제');
    const history = await h.lead('GET', '/api/tasks/TASK-0001/history');
    expect(history.body.items[0]).toMatchObject({ kind: '실행 등급', before: '{"effort":"high","modelId":"claude-opus-5-5"}', after: '{"effort":"high","modelId":"claude-sonnet-5-5"}' });
  });

  test('재개 이력 기록은 재판단이 아닌 재개·끝난 시도에는 쓰지 않는다', async () => {
    const other = await attemptFor(h.owner, f.project, f.tasks['TASK-0004'] ?? '', { kind: 'dev', status: 'running', modelId: 'claude-sonnet-5-5', effort: 'high', no: 2 });
    await expect(inEpoch(h.pool, 1, (client) => recordResumeRegrade(client, other))).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('하위 Agent /api/settings/subagents', () => {
  let a = '';
  beforeAll(async () => {
    const def = async (key: string, agent: string) => (await h.owner.query<{ id: string }>(
      "insert into subagent_defs(def_key,version,agent,role,tools,sandbox,text,hash,allowed) values($1,1,$2,'구현','{Read,Write}','worktree 쓰기','지시문','abc',true) returning id", [key, agent])).rows[0]?.id ?? '';
    a = await def('be-implementer', 'Claude');
    await def('qa-verifier', 'Codex');
    await h.owner.query("insert into task_subagents(project_id,task,role,subagent_id,basis) values($1,$2,'dev',$3,'BE 구현')", [f.project, f.tasks['TASK-0003'], a]);
    await h.owner.query("insert into task_subagents(project_id,task,role,subagent_id,basis) values($1,$2,'dev',$3,'BE 구현')", [f.project, f.tasks['TASK-0002'], a]);
  });

  test('조회: 사용 켜짐(기본)과 정의 목록(도구는 · 로 이음)', async () => {
    const res = await h.lead('GET', '/api/settings/subagents');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.defs.find((d: { id: string }) => d.id === a)).toMatchObject({ version: 1, agent: 'Claude', role: '구현', tools: 'Read · Write', allowed: true, ref: null });
  });

  test('정의 허용 해제 → 그 정의를 지정한 진행 전·중 Task를 Planning이 다시 판단, 사용 끄기 저장', async () => {
    const current = (await h.lead('GET', '/api/settings/subagents')).body;
    const before = (await jobs()).length;
    const saved = await h.lead('PUT', '/api/settings/subagents', { updatedAt: current.updatedAt, enabled: false, allowed: [{ id: a, allowed: false }] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.enabled).toBe(false);
    expect(saved.body.defs.find((d: { id: string }) => d.id === a).allowed).toBe(false);
    expect((await jobs()).slice(before)).toEqual([{ kind: 'estimate', state: 'queued', payload: expect.objectContaining({ reason: 'subagent_disallowed', tasks: [{ taskKey: 'TASK-0003', roles: ['dev'] }] }) }]);
    expect((await h.lead('PUT', '/api/settings/subagents', { updatedAt: saved.body.updatedAt, enabled: true, allowed: [{ id: crypto.randomUUID(), allowed: true }] })).body.error.errors)
      .toEqual([expect.objectContaining({ path: 'allowed.0.id', rule: 'exists' })]);
  });
});
