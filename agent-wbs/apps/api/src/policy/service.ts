import { execPolicyToApi, type ExecPolicyRow, type PoolClient } from '@awbs/db';
import {
  belowFloor, DEFAULT_EXEC_POLICY, effortLevel, floorOf, gradeError,
  type Agent, type AttemptKind, type ModelSettings, type ResolveResult, type TaskStatus,
} from '@awbs/shared';
import { canonicalJson, ChangeBatch, deferChange, iso } from '../changes/events.ts';
import { jobPayloadErrors } from '@awbs/shared/api';
import { ApiError, assertSameVersion, invalid, isUuid, json } from '../changes/http.ts';
import { judgedTasks } from './judged.ts';
import { writeResumeRegrade } from './resume.ts';
import { resolveGrade } from '../runner/service.ts';
import { RunnerRepository } from '../runner/repository.ts';
import { touchSetting, type SettingGroup } from '../settings/version.ts';
import {
  AGENTS, catalogOf, completeOrder, gradesToRejudge, modelKey, planModelChange, ranksOf,
  type GradeRow, type ModelPut, type ModelRow, type Rejudge,
} from './rules.ts';

/**
 * 실행 정책·모델·하위 Agent 설정(G§7, contracts §2.1 `settings/*`)과 Planning 재판단 연결(G§7.2, D-29).
 * 잠금 순서: 공통 관문이 system_state를 먼저 잡는다. 설정 행을 잡은 뒤 영향받는 Task를 id 순서로 잡는다.
 * (설정 행은 다른 쓰기가 Task보다 먼저 잡지 않으므로 서로 기다리는 교착이 생기지 않는다. 생기면 DB가 40P01로 한쪽을 취소한다.)
 */

const LEAD = '팀장';
const PLANNING = 'Planning Agent';
const TERMINAL: readonly TaskStatus[] = ['done', 'cancelled'];

/** G§4.6 「Claude 개발 → Codex QA」를 기본 Workflow로 한다(milestones §1 담당 기준과 같다). */
const DEFAULT_WORKFLOW = { devAgent: 'Claude', qaAgent: 'Codex', subagentsEnabled: true } as const;

interface WorkflowJson { devAgent?: Agent; qaAgent?: Agent; subagentsEnabled?: boolean }

/** 설정 변경 이력(Task와 무관한 전역 이력, task=null). 이력 화면의 「유형=설정」으로 보인다. */
async function settingsHistory(client: PoolClient, changes: ChangeBatch, text: string, before: unknown, after: unknown, key: SettingGroup): Promise<void> {
  await touchSetting(client, key);
  const project = (await client.query<{ id: string }>('select id from projects')).rows[0]?.id ?? null;
  await client.query("insert into task_history(project_id,at,actor,task,kind,text,before,after,ref) values($1,clock_timestamp(),$2,null,'설정',$3,$4::jsonb,$5::jsonb,$6::jsonb)",
    [project, LEAD, text, json(before), json(after), JSON.stringify({ key })]);
  changes.add(project, 'settings', { key });
}

/** Task 이력(추가 전용). 시각은 그 Task의 현재 버전보다 늦게 둔다(M2-02 `record`와 같은 규칙). */
async function taskHistory(client: PoolClient, input: { projectId: string; taskId: string; actor: string; text: string; before: unknown; after: unknown; ref: Record<string, unknown> }) {
  await client.query(
    `insert into task_history(project_id,at,actor,task,kind,text,before,after,ref)
     values($1,greatest(clock_timestamp(),(select updated_at+interval '1 microsecond' from tasks where id=$2)),$3,$2,'실행 등급',$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
    [input.projectId, input.taskId, input.actor, input.text, json(input.before), json(input.after), JSON.stringify(input.ref)],
  );
}

/** 등급이 바뀌면 Task 버전을 올린다(contracts §1.3 「등급」은 tasks.updatedAt). 갱신 트리거가 단조 증가를 보장한다. */
async function touchTask(client: PoolClient, changes: ChangeBatch, projectId: string, taskId: string, taskKey: string): Promise<void> {
  await client.query('update tasks set updated_at=clock_timestamp() where id=$1', [taskId]);
  changes.add(projectId, 'task', { taskKey });
}

/* ───────────── 실행 정책 ───────────── */

interface ExecRow extends ExecPolicyRow { updated_at: string; live_inject: boolean }
const EXEC_COLUMNS = `on_usage,low_pct,on_rework,esc_notify,floors,live_inject,auto_retry_limit,auto_rework_limit,${iso('settings_version')} as updated_at`;

async function execRow(client: PoolClient, lock = false): Promise<ExecRow> {
  const row = (await client.query<ExecRow>(`select ${EXEC_COLUMNS} from exec_policy where singleton${lock ? ' for update' : ''}`)).rows[0];
  if (!row) throw new ApiError('UNAVAILABLE', {}, [], '실행 정책 초기값이 없습니다. system seed를 실행하세요.');
  return row;
}

const execView = (row: ExecRow) => ({ ...execPolicyToApi(row, DEFAULT_EXEC_POLICY), updatedAt: row.updated_at });

export async function getExecPolicy(client: PoolClient) { return execView(await execRow(client)); }

export interface ExecPolicyPut {
  updatedAt: string | null; onUsage: 'wait' | 'down'; lowPct: number; onRework: 'same' | 'up1' | 'top'; notifyAt: number;
  floors: { verifyGeDev: boolean; dbHigh: boolean }; autoRetryLimit: number; autoReworkLimit: number;
}

/** 실행 정책 저장(G§7.3). 최저선이 바뀌면 그 아래가 된 등급을 Planning 재판단에 맡긴다(P `normRuns` 「최저선 변경」). */
export async function putExecPolicy(client: PoolClient, body: ExecPolicyPut) {
  const changes = new ChangeBatch();
  const row = await execRow(client, true);
  await assertSameVersion(client, row.updated_at, body.updatedAt, { current: execView(row) });
  const before = execPolicyToApi(row, DEFAULT_EXEC_POLICY);
  await client.query('update exec_policy set on_usage=$1,low_pct=$2,on_rework=$3,esc_notify=$4,floors=$5::jsonb,auto_retry_limit=$6,auto_rework_limit=$7 where singleton',
    [body.onUsage, body.lowPct, body.onRework, body.notifyAt, JSON.stringify(body.floors), body.autoRetryLimit, body.autoReworkLimit]);
  const after = { onUsage: body.onUsage, lowPct: body.lowPct, onRework: body.onRework, notifyAt: body.notifyAt, floors: body.floors, autoRetryLimit: body.autoRetryLimit, autoReworkLimit: body.autoReworkLimit };
  const changed = (Object.keys(after) as (keyof typeof after)[]).filter((key) => canonicalJson(before[key]) !== canonicalJson(after[key]));
  if (changed.length) await settingsHistory(client, changes, `실행 정책 변경 — ${changed.join('·')}`, before, after, 'exec-policy');
  if (changed.includes('floors')) {
    const floorText = `최저선 변경 — 검증≥개발 ${body.floors.verifyGeDev ? '적용' : '해제'}, DB·Migration 높음 이상 ${body.floors.dbHigh ? '적용' : '해제'}`;
    const { grades, catalogs } = await gradeState(client);
    const targets = gradesToRejudge(grades, catalogs, body.floors).filter((item) => item.reason === 'BELOW_FLOOR');
    await requestRejudge(client, changes, targets, 'floor_changed', floorText);
  }
  await changes.emit(client);
  return getExecPolicy(client);
}

/* ───────────── Agent 역할·기본 Workflow ───────────── */

interface AppRow { workflow: WorkflowJson | null; heartbeat_seconds: number; heartbeat_misses: number; model_settings: ModelSettings; workflow_version: string; models_version: string; subagents_version: string }

async function appRow(client: PoolClient, lock = false): Promise<AppRow> {
  const row = (await client.query<AppRow>(`select workflow,heartbeat_seconds,heartbeat_misses,model_settings,${iso('workflow_version')} workflow_version,${iso('models_version')} models_version,${iso('subagents_version')} subagents_version from app_settings where singleton${lock ? ' for update' : ''}`)).rows[0];
  if (!row) throw new ApiError('UNAVAILABLE', {}, [], '앱 설정 초기값이 없습니다. system seed를 실행하세요.');
  return row;
}

const workflowOf = (row: AppRow) => ({ ...DEFAULT_WORKFLOW, ...(row.workflow ?? {}) });

export async function getWorkflow(client: PoolClient) {
  const app = await appRow(client);
  const wf = workflowOf(app);
  // Q-07: CLI 실측 전에는 예전에 저장된 true도 사용하지 않는다(owner 2026-11-27 아이템 18).
  return { devAgent: wf.devAgent, qaAgent: wf.qaAgent, liveInject: false as const, heartbeatSeconds: app.heartbeat_seconds, missedHeartbeats: app.heartbeat_misses, updatedAt: app.workflow_version };
}

export interface WorkflowPut { updatedAt: string | null; devAgent: Agent; qaAgent: Agent; liveInject: boolean; heartbeatSeconds: number; missedHeartbeats: number }

/** 기본 담당 Agent·실행 중 전달·heartbeat 주기 저장. 기본 담당은 새 Task에 쓰고 기존 Task는 바꾸지 않는다. */
export async function putWorkflow(client: PoolClient, body: WorkflowPut) {
  if (body.liveInject) throw invalid([{ path: 'liveInject', rule: 'const', message: '실행 중 전달은 준비 중입니다. 메시지는 다음 실행 때 전달됩니다.' }]);
  const app = await appRow(client, true);
  const before = await getWorkflow(client);
  await assertSameVersion(client, app.workflow_version, body.updatedAt, { current: before });
  await client.query('update app_settings set workflow=$1::jsonb,heartbeat_seconds=$2,heartbeat_misses=$3 where singleton',
    [JSON.stringify({ ...workflowOf(app), devAgent: body.devAgent, qaAgent: body.qaAgent }), body.heartbeatSeconds, body.missedHeartbeats]);
  await client.query('update exec_policy set live_inject=$1 where singleton and live_inject is distinct from $1', [body.liveInject]);
  const pick = (v: Omit<WorkflowPut, 'updatedAt'>) => ({ devAgent: v.devAgent, qaAgent: v.qaAgent, liveInject: v.liveInject, heartbeatSeconds: v.heartbeatSeconds, missedHeartbeats: v.missedHeartbeats });
  const was = pick(before);
  const now = pick(body);
  const changes = new ChangeBatch();
  if (JSON.stringify(was) !== JSON.stringify(now)) await settingsHistory(client, changes, 'Agent 역할·기본 Workflow 변경', was, now, 'workflow');
  await changes.emit(client);
  return getWorkflow(client);
}

/* ───────────── 모델 ───────────── */

interface AgentModelRow { id: string; agent: Agent; model_id: string; allowed: boolean; is_new: boolean; report: { label?: string; efforts?: string[] | null } | null; updated_at: string }

async function modelRows(client: PoolClient, lock = false): Promise<AgentModelRow[]> {
  return (await client.query<AgentModelRow>(`select id,agent,model_id,allowed,is_new,report,${iso('updated_at')} as updated_at from agent_models order by id${lock ? ' for update' : ''}`)).rows;
}

const toModel = (row: AgentModelRow): ModelRow => ({
  agent: row.agent, modelId: row.model_id, label: typeof row.report?.label === 'string' ? row.report.label : row.model_id,
  allowed: row.allowed, isNew: row.is_new, efforts: Array.isArray(row.report?.efforts) ? row.report.efforts : null,
});

function modelsView(app: AppRow, rows: readonly AgentModelRow[]) {
  const models = rows.map(toModel);
  const settings = app.model_settings;
  const order = completeOrder(settings, models);
  const ranks = ranksOf(order);
  return {
    rankOrder: order, codexFamilyOrder: settings.codexFamilyOrder, claudeModels: settings.claudeModels,
    models: models
      .map((m) => ({
        agent: m.agent, id: m.modelId, label: m.label, rank: ranks.get(modelKey(m.agent, m.modelId)) ?? 0, allowed: m.allowed, isNew: m.isNew,
        efforts: m.efforts === null ? null : m.efforts.map((key) => ({ key, level: effortLevel(m.agent, m.modelId, key) })),
      }))
      .sort((a, b) => a.agent.localeCompare(b.agent) || b.rank - a.rank),
    updatedAt: app.models_version,
  };
}

export async function getModels(client: PoolClient) { return modelsView(await appRow(client), await modelRows(client)); }

/**
 * 허용 모델·순서·Claude 모델 목록 저장(G§7.1 ①, owner 2026-11-26 아이템 8).
 * 허용을 해제하면 그 모델을 쓰던 Task 등급을 Planning Agent가 다시 판단한다(G§7.2, 고정 Task 포함·이력 남김).
 * 재판단 전에는 그 Task를 재개하지 않는다(D-29) — run-grade가 MODEL_NOT_ALLOWED로 거절한다.
 */
export async function putModels(client: PoolClient, body: ModelPut & { updatedAt: string | null }) {
  const changes = new ChangeBatch();
  const app = await appRow(client, true);
  const rows = await modelRows(client, true);
  await assertSameVersion(client, app.models_version, body.updatedAt, { current: modelsView(app, rows) });
  const plan = planModelChange(rows.map(toModel), app.model_settings, body);
  if (plan.errors.length) throw invalid(plan.errors);
  for (const row of rows) {
    const next = plan.rows.find((r) => r.agent === row.agent && r.modelId === row.model_id);
    const rank = plan.ranks.get(modelKey(row.agent, row.model_id)) ?? null;
    await client.query('update agent_models set allowed=$2,is_new=$3,rank=$4 where id=$1 and (allowed,is_new,rank) is distinct from ($2,$3,$4)',
      [row.id, next?.allowed ?? row.allowed, next?.isNew ?? row.is_new, rank]);
  }
  await client.query('update app_settings set model_settings=$1::jsonb where singleton and model_settings is distinct from $1::jsonb', [JSON.stringify(plan.settings)]);
  const changedAllowed = plan.rows.filter((r) => rows.some((o) => o.agent === r.agent && o.model_id === r.modelId && o.allowed !== r.allowed));
  const orderChanged = canonicalJson(plan.settings) !== canonicalJson({ ...app.model_settings, rankOrder: completeOrder(app.model_settings, rows.map(toModel)) });
  if (changedAllowed.length || orderChanged) {
    const text = [
      ...changedAllowed.map((r) => `${r.agent} ${r.modelId} ${r.allowed ? '허용' : '허용 해제'}`),
      ...(orderChanged ? ['모델 순서·목록 변경'] : []),
    ].join(', ');
    await settingsHistory(client, changes, `허용 모델 변경 — ${text}`, { allowed: rows.filter((r) => r.allowed).map((r) => modelKey(r.agent, r.model_id)), settings: app.model_settings },
      { allowed: plan.rows.filter((r) => r.allowed).map((r) => modelKey(r.agent, r.modelId)), settings: plan.settings }, 'models');
  }
  if (plan.disallowed.length) {
    const { grades } = await gradeState(client);
    const catalogs = Object.fromEntries(AGENTS.map((agent) => [agent, catalogOf(agent, plan.rows, plan.ranks)])) as Record<Agent, ReturnType<typeof catalogOf>>;
    const floors = (await execRow(client)).floors;
    const targets = gradesToRejudge(grades, catalogs, floors).filter((item) => item.reason === 'MODEL_NOT_ALLOWED');
    const why = plan.disallowed.map((m) => `${m.agent} 허용 모델 변경 — ${m.modelId} 허용 해제`).join(', ');
    await requestRejudge(client, changes, targets, 'model_disallowed', why);
  }
  await changes.emit(client);
  return getModels(client);
}

/* ───────────── 등급 상태와 재판단 ───────────── */

interface GradeDbRow {
  task: string; task_key: string; project_id: string; status: TaskStatus; role: 'dev' | 'qa'; agent: Agent; model_id: string; effort: string; locked: boolean;
  primary_domain: string; related_domains: string[]; dev_model: string | null; dev_effort: string | null; assignee: Agent;
}

/** 진행 전·중 Task의 역할별 등급과 지금 카탈로그(완료·취소·삭제 Task 제외). */
async function gradeState(client: PoolClient) {
  const rows = (await client.query<GradeDbRow>(
    `select g.task,t.task_key,t.project_id,t.status,g.role,case g.role when 'dev' then t.assignee_agent else t.verifier_agent end as agent,
       g.model_id,g.effort,g.locked,t.primary_domain,t.related_domains::text[] as related_domains,t.assignee_agent as assignee,
       d.model_id as dev_model,d.effort as dev_effort
     from task_grades g join tasks t on t.id=g.task left join task_grades d on d.task=g.task and d.role='dev'
     where t.deleted_at is null and t.status not in ('done','cancelled') order by t.id,g.role`,
  )).rows;
  const grades: (GradeRow & { projectId: string })[] = rows.map((r) => ({
    taskId: r.task, taskKey: r.task_key, projectId: r.project_id, status: r.status, role: r.role, agent: r.agent, modelId: r.model_id, effort: r.effort,
    locked: r.locked, primaryDomain: r.primary_domain, relatedDomains: r.related_domains,
    devLevel: r.dev_model && r.dev_effort ? effortLevel(r.assignee, r.dev_model, r.dev_effort) : null,
  }));
  const app = await appRow(client);
  const models = (await modelRows(client)).map(toModel);
  const ranks = ranksOf(completeOrder(app.model_settings, models));
  const catalogs = Object.fromEntries(AGENTS.map((agent) => [agent, catalogOf(agent, models, ranks)])) as Record<Agent, ReturnType<typeof catalogOf>>;
  return { grades, catalogs };
}

export type RejudgeCode = 'model_disallowed' | 'floor_changed' | 'subagent_disallowed';

/**
 * Planning Agent에게 다시 판단을 맡긴다(조정자 승인 기본안 2026-11-26).
 * 1) 영향받는 Task를 id 순서로 잠근다. 2) 팀장 고정 등급은 고정을 풀고 이력을 남긴다(G§7.2 「고정 Task 포함」).
 * 3) Task마다 「재판단 필요」 이력. 4) 재판단 작업(job kind=estimate) 1개에 대상 Task·역할을 싣는다.
 * 결과(새 등급)는 Planning 보고가 `applyRegrade`로 저장한다(submitTaskPlan 라우트는 M2-07/M5 몫).
 */
async function requestRejudge(client: PoolClient, changes: ChangeBatch, targets: readonly (Rejudge | { taskId: string; taskKey: string; role: 'dev' | 'qa'; grade?: undefined; locked?: undefined; reason: 'SUBAGENT_NOT_ALLOWED' })[], code: RejudgeCode, why: string) {
  if (!targets.length) return;
  const taskIds = [...new Set(targets.map((t) => t.taskId))].sort();
  const locked = (await client.query<{ id: string; project_id: string; task_key: string }>('select id,project_id,task_key from tasks where id=any($1::uuid[]) order by id for update', [taskIds])).rows;
  const projectOf = new Map(locked.map((t) => [t.id, t.project_id]));
  for (const target of targets) {
    const projectId = projectOf.get(target.taskId);
    if (!projectId) continue;
    const ref = { taskKey: target.taskKey, role: target.role, rejudge: code };
    if (target.grade && target.locked) {
      await client.query('update task_grades set locked=false,locked_by=null where task=$1 and role=$2', [target.taskId, target.role]);
      await taskHistory(client, { projectId, taskId: target.taskId, actor: LEAD, ref,
        text: `${target.role === 'dev' ? '개발' : '검증'} 등급 — ${why} — 고정 등급의 모델이 허용 목록에서 빠짐, 고정 해제 후 Planning Agent 재판단`,
        before: { ...target.grade, locked: true }, after: { ...target.grade, locked: false } });
    } else {
      await taskHistory(client, { projectId, taskId: target.taskId, actor: LEAD, ref,
        text: `${target.role === 'dev' ? '개발' : '검증'} ${target.grade ? '등급' : '하위 Agent 지정'} — ${why} — Planning Agent 재판단 필요`,
        before: target.grade ? { ...target.grade, locked: false } : null, after: null });
    }
  }
  for (const task of locked) {
    if (targets.some((t) => t.taskId === task.id && t.locked)) await touchTask(client, changes, task.project_id, task.id, task.task_key);
  }
  const byTask = new Map<string, { taskKey: string; roles: Set<string>; projectId: string }>();
  for (const target of targets) {
    const projectId = projectOf.get(target.taskId);
    if (!projectId) continue;
    const entry = byTask.get(target.taskId) ?? { taskKey: target.taskKey, roles: new Set<string>(), projectId };
    entry.roles.add(target.role);
    byTask.set(target.taskId, entry);
  }
  const groups = [...byTask.values()].sort((a, b) => a.taskKey.localeCompare(b.taskKey));
  const projectId = groups[0]?.projectId ?? null;
  const epoch = (await client.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch ?? 0;
  // estimate 계약 모양 그대로: tasks[{taskKey,subjectHash,content}] + policy. 재판단 이유·대상 역할은 policy.rejudge(RejudgeRequest).
  const floors = (await execRow(client)).floors;
  const allowedModels = Object.fromEntries(AGENTS.map((agent) => [agent, [] as string[]]));
  for (const row of await modelRows(client)) if (row.allowed) allowedModels[row.agent]?.push(row.model_id);
  const payload = {
    tasks: await judgedTasks(client, [...byTask.keys()]),
    policy: {
      rejudge: { reason: code, trigger: why, targets: groups.map((g) => ({ taskKey: g.taskKey, roles: [...g.roles].sort() })) },
      floors, allowedModels,
    },
  };
  const problems = jobPayloadErrors('estimate', payload);
  if (problems.length) throw new Error(`재판단 작업 payload가 계약과 다릅니다: ${problems.join('; ')}`);
  await client.query("insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'estimate',$2::jsonb,'queued',$3,$4)",
    [projectId, JSON.stringify(payload), epoch, `rejudge:${crypto.randomUUID()}`]);
  changes.add(projectId, 'planning', { key: 'rejudge' });
}

export interface RegradeInput { taskKey: string; role: 'dev' | 'qa'; modelId: string; effort: string; reason: string; actor?: string }

/**
 * Planning Agent의 재판단 결과(새 등급)를 저장한다. Planning 보고 라우트(POST /planning/tasks/:taskKey/plan)가 부를 함수다.
 * - 허용·매핑·보고된 등급이어야 하고 최저선 아래면 안 된다(재판단 등급은 팀장 고정이 아니므로 최저선 예외가 없다).
 * - 이전→이후 등급을 이력에 남기고 Task 버전을 올린다. 재추정·재조정은 Planning·일정 쪽이 이어서 한다(G§7.3).
 */
export async function applyRegrade(client: PoolClient, input: RegradeInput): Promise<void> {
  const task = (await client.query<{ id: string; project_id: string; status: TaskStatus; assignee_agent: Agent; verifier_agent: Agent; primary_domain: string; related_domains: string[] }>(
    'select id,project_id,status,assignee_agent,verifier_agent,primary_domain,related_domains::text[] as related_domains from tasks where task_key=$1 and deleted_at is null for update', [input.taskKey])).rows[0];
  if (!task) throw new ApiError('TASK_NOT_FOUND', { taskKey: input.taskKey }, [], 'Task를 찾을 수 없습니다.');
  if (TERMINAL.includes(task.status)) throw new ApiError('INVALID_TRANSITION', { taskKey: input.taskKey, status: task.status }, [], '완료·취소된 Task의 등급은 바꾸지 않습니다.');
  const agent = input.role === 'dev' ? task.assignee_agent : task.verifier_agent;
  const { catalogs } = await gradeState(client);
  const grade = { modelId: input.modelId, effort: input.effort };
  const problem = gradeError(catalogs[agent], grade);
  if (problem) throw invalid([{ path: problem.startsWith('MODEL') ? 'modelId' : 'effort', rule: problem, message: `실행에 쓸 수 없는 등급입니다(${problem}).` }]);
  const grades = (await client.query<{ role: string; model_id: string; effort: string; locked: boolean }>('select role,model_id,effort,locked from task_grades where task=$1', [task.id])).rows;
  const dev = input.role === 'dev' ? grade : grades.find((g) => g.role === 'dev');
  const devLevel = dev ? effortLevel(task.assignee_agent, 'modelId' in dev ? dev.modelId : dev.model_id, dev.effort) : null;
  const floors = (await execRow(client)).floors;
  const floor = floorOf(input.role, { primaryDomain: task.primary_domain, relatedDomains: task.related_domains, devLevel }, floors);
  if (belowFloor(agent, { ...grade, locked: false }, floor) !== false) throw invalid([{ path: 'effort', rule: 'floor', message: '최저선 아래이거나 최저선을 판정할 수 없는 등급입니다.' }]);
  const old = grades.find((g) => g.role === input.role);
  await client.query(
    `insert into task_grades(project_id,task,role,model_id,effort,reason,locked,locked_by,effective_from) values($1,$2,$3,$4,$5,$6,false,null,now())
     on conflict(task,role) do update set model_id=excluded.model_id,effort=excluded.effort,reason=excluded.reason,locked=false,locked_by=null,effective_from=now()`,
    [task.project_id, task.id, input.role, input.modelId, input.effort, input.reason]);
  await taskHistory(client, { projectId: task.project_id, taskId: task.id, actor: input.actor ?? PLANNING, ref: { taskKey: input.taskKey, role: input.role },
    text: `${input.role === 'dev' ? '개발' : '검증'} 등급 Planning Agent 재판단 — ${input.reason}`,
    before: old ? { modelId: old.model_id, effort: old.effort, locked: old.locked } : null, after: { ...grade, locked: false } });
  // 부르는 쪽(Planning 보고)이 뒤에서 다른 행을 더 잠글 수 있으므로 변경 이벤트는 커밋 직전에 쓴다(deferChange).
  await client.query('update tasks set updated_at=clock_timestamp() where id=$1', [task.id]);
  deferChange(client, task.project_id, 'task', { taskKey: input.taskKey });
}

/* ───────────── 재개 등급(D-29) ───────────── */

/**
 * 중단된 시도를 재개할 때 쓸 등급(G§6.5·§7.3, D-29). 판정은 M1-06 `resolveRunGrade` 그대로다.
 * - 직전 시도 모델이 허용 중이면 같은 등급(`resume`).
 * - 허용 해제됐으면 재판단된 Task 등급(`regrade`). Task 등급도 아직 그 모델이면(재판단 전) MODEL_NOT_ALLOWED로 거절.
 * M2 통합: 실행 직전 등급 API(run-grade, M2-05)와 같은 판정 함수(`resolveGrade`)를 쓴다. 남은 사용량 보고가 없어도 거절하지 않는다.
 */
export async function resumeGrade(client: PoolClient, attemptId: string): Promise<ResolveResult> {
  if (!isUuid(attemptId)) throw new ApiError('ATTEMPT_NOT_FOUND', { attemptId }, [], '실행 시도를 찾을 수 없습니다.');
  const attempt = (await client.query<{ task: string; kind: AttemptKind; attempt_no: number }>('select task,kind,attempt_no from task_attempts where id=$1', [attemptId])).rows[0];
  if (!attempt) throw new ApiError('ATTEMPT_NOT_FOUND', { attemptId }, [], '실행 시도를 찾을 수 없습니다.');
  const repo = new RunnerRepository(client);
  const task = await repo.taskById(attempt.task);
  if (!task) throw new ApiError('TASK_NOT_FOUND', {}, [], 'Task를 찾을 수 없습니다.');
  const history = (await repo.history(task.id)).filter((a) => a.attempt_no <= attempt.attempt_no);
  const resolved = await resolveGrade(repo, task, attempt.kind, { history });
  return 'missing' in resolved ? { ok: false, code: 'MODEL_UNKNOWN' } : resolved.result;
}

/**
 * 재판단 등급으로 재개할 때의 이력(D-29 「이전→이후 등급·사유를 이력에 기록」).
 * 실제 재개는 M2-05 시도 시작(runner/service.ts `start`)이 같은 `writeResumeRegrade`로 남긴다.
 * 재판단 재개가 아니면(같은 등급 재개·재판단 전·종료된 시도) 409 INVALID_TRANSITION.
 */
export async function recordResumeRegrade(client: PoolClient, attemptId: string): Promise<void> {
  const result = await resumeGrade(client, attemptId);
  const task = (await client.query<{ id: string; project_id: string; task_key: string }>('select t.id,t.project_id,t.task_key from tasks t join task_attempts a on a.task=t.id where a.id=$1', [attemptId])).rows[0];
  if (!task || !await writeResumeRegrade(client, task, attemptId, result)) throw new ApiError('INVALID_TRANSITION', { attemptId }, [], '재판단한 등급으로 재개하는 시도가 아닙니다.');
}

/* ───────────── 하위 Agent ───────────── */

interface DefRow { id: string; def_key: string; version: number; agent: Agent; role: string; tools: string[]; sandbox: string; text: string; hash: string; allowed: boolean; ref: string | null; updated_at: string }

async function defRows(client: PoolClient, lock = false): Promise<DefRow[]> {
  return (await client.query<DefRow>(`select id,def_key,version,agent,role,tools,sandbox,text,hash,allowed,ref,${iso('updated_at')} as updated_at from subagent_defs order by ${lock ? 'id' : 'def_key,version'}${lock ? ' for update' : ''}`)).rows;
}

function subagentsView(app: AppRow, defs: readonly DefRow[]) {
  return {
    enabled: workflowOf(app).subagentsEnabled,
    defs: [...defs].sort((a, b) => a.def_key.localeCompare(b.def_key) || a.version - b.version).map((d) => ({
      id: d.id, version: d.version, agent: d.agent, role: d.role, tools: d.tools.join(' · '), sandbox: d.sandbox, text: d.text, hash: d.hash, allowed: d.allowed, ref: d.ref,
    })),
    updatedAt: app.subagents_version,
  };
}

export async function getSubagents(client: PoolClient) { return subagentsView(await appRow(client), await defRows(client)); }

/**
 * 하위 Agent 사용 켜기/끄기와 정의별 허용(G§7.4-7). 해제하면 그 정의를 지정한 Task를 Planning Agent가 다시 판단한다.
 * G는 「진행 전 Task」라고 하지만, 재작업·재개를 기다리는 Task도 다음 시도에서 설치가 거절되므로 완료·취소 전 Task 전부를 맡긴다(P L4587과 같음).
 */
export async function putSubagents(client: PoolClient, body: { updatedAt: string | null; enabled: boolean; allowed: readonly { id: string; allowed: boolean }[] }) {
  const batch = new ChangeBatch();
  const app = await appRow(client, true);
  const defs = await defRows(client, true);
  await assertSameVersion(client, app.subagents_version, body.updatedAt, { current: subagentsView(app, defs) });
  const errors = body.allowed.flatMap((item, index) => (defs.some((d) => d.id === item.id) ? [] : [{ path: `allowed.${String(index)}.id`, rule: 'exists', message: '없는 하위 Agent 정의입니다.' }]));
  if (errors.length) throw invalid(errors);
  const turnedOff: DefRow[] = [];
  const changes: string[] = [];
  for (const item of body.allowed) {
    const def = defs.find((d) => d.id === item.id);
    if (!def || def.allowed === item.allowed) continue;
    await client.query('update subagent_defs set allowed=$2 where id=$1', [def.id, item.allowed]);
    changes.push(`${def.def_key} v${String(def.version)} ${item.allowed ? '허용' : '허용 해제'}`);
    if (!item.allowed) turnedOff.push(def);
  }
  const wf = workflowOf(app);
  if (wf.subagentsEnabled !== body.enabled) {
    await client.query('update app_settings set workflow=$1::jsonb where singleton', [JSON.stringify({ ...wf, subagentsEnabled: body.enabled })]);
    changes.push(`하위 Agent 사용 ${body.enabled ? '켜기' : '끄기'}`);
  }
  if (changes.length) await settingsHistory(client, batch, `하위 Agent 설정 변경 — ${changes.join(', ')}`, null, { enabled: body.enabled, allowed: body.allowed }, 'subagents');
  if (turnedOff.length) {
    const rows = (await client.query<{ task: string; task_key: string; role: 'dev' | 'qa' }>(
      `select distinct s.task,t.task_key,s.role from task_subagents s join tasks t on t.id=s.task
       where s.subagent_id=any($1::uuid[]) and t.deleted_at is null and t.status not in ('done','cancelled') order by t.task_key,s.role`, [turnedOff.map((d) => d.id)])).rows;
    const why = `하위 Agent 허용 해제 — ${turnedOff.map((d) => `${d.def_key} v${String(d.version)}`).join(', ')}`;
    await requestRejudge(client, batch, rows.map((r) => ({ taskId: r.task, taskKey: r.task_key, role: r.role, reason: 'SUBAGENT_NOT_ALLOWED' as const })), 'subagent_disallowed', why);
  }
  await batch.emit(client);
  return getSubagents(client);
}

