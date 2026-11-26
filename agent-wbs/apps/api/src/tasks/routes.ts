import assert from 'node:assert/strict';
import { splitSettingsToDomain, type Pool, type PoolClient } from '@awbs/db';
import {
  assertDependency, displayKey, DomainError, isBlocked, JUDGED_RULES, judgementOf, lifecycleTransition, type VerificationResult,
  type Agent, type ApprovalInput, type JudgedRules, type TaskStatus,
} from '@awbs/shared';
import { OPERATIONS } from '@awbs/shared/api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { approvalErrors } from './approval.ts';
import { installTaskErrors, TaskError } from './errors.ts';
import { canonicalJson, specBody, subjectHash, type Ac, type Output, type Overview, type SpecBody } from './hash.ts';
import { acOf, listTasks, overviewOf, publicDetail, taskDetail, type TaskDetail } from './read.ts';
import {
  assertEditable, assertVersion, changed, changeEvent, lockGraph, lockTask, lockTasks, nextChecklistKey, record, SYSTEM, touch,
  type Change, type LockedTask,
} from './write.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const params = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties) });
const TASK_KEY = { type: 'string', pattern: '^TASK-[0-9]{4,}$' };
const TASK = params({ taskKey: TASK_KEY });
const PROJECT = params({ projectId: { type: 'string', pattern: UUID.source } });
const DESIGN = params({ taskKey: TASK_KEY, kind: { type: 'string', enum: ['DB', 'API', 'FE', 'DevOps'] } });
const ITEM = params({ taskKey: TASK_KEY, itemKey: { type: 'string', minLength: 1, maxLength: 128 } });
const DEPENDENCY = params({ dependencyId: { type: 'string', minLength: 1, maxLength: 128 } });
/** 진행 중이라 새 차단을 허용하지 않는 상태(D-35) */
const ACTIVE: readonly TaskStatus[] = ['running', 'qa', 'verifying'];
const STATUS_HISTORY = { 'request-approval': ['승인 요청', '착수 승인 요청'], approve: ['승인', '착수 승인'], reject: ['반려', '착수 반려'] } as const;

interface Versioned { updatedAt: string }
type Params = Record<string, string>;
type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const clientOf = (request: FastifyRequest): PoolClient => {
  const client = request.platform?.client;
  assert(client, '변경 요청은 공통 관문이 연 트랜잭션 안에서 처리한다.');
  return client;
};
const paramsOf = (request: FastifyRequest) => request.params as Params;
const keyOf = (request: FastifyRequest) => paramsOf(request).taskKey ?? '';

/** 조회는 한 시점의 스냅샷(읽기 전용 반복 읽기)으로 계산한다. */
async function read<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

const domainError = (error: unknown, keys: ReadonlyMap<string, string>): never => {
  if (!(error instanceof DomainError)) throw error;
  const path = Array.isArray(error.details.path) ? (error.details.path as string[]).map((id) => keys.get(id) ?? id) : undefined;
  throw new TaskError(error.code === 'TASK_NOT_FOUND' ? 'TASK_NOT_FOUND' : error.code, path ? { path } : {});
};

export function registerTaskRoutes(app: FastifyInstance, pool: Pool): void {
  void app.register((scope, _options, done) => {
    const actions = new Map<string, string>();
    installTaskErrors(scope, actions);

    const route = (id: string, schemaParams: object | undefined, action: string, handler: Handler) => {
      const op = OPERATIONS.find((item) => item.id === id);
      assert(op, `계약에 없는 Task 경로: ${id}`);
      actions.set(`${op.method} ${op.path}`, action);
      scope.route({
        method: op.method, url: op.path, handler,
        schema: { ...(op.body ? { body: op.body } : {}), ...(op.query ? { querystring: op.query } : {}), ...(schemaParams ? { params: schemaParams } : {}) },
      });
    };

    /** 한 Task를 잠그고 버전을 비교한 뒤 바꾼다. 바뀐 것이 있으면 Task 버전을 올린다. */
    const edit = async (request: FastifyRequest, version: string, fn: (client: PoolClient, task: LockedTask) => Promise<Change[]>) => {
      const client = clientOf(request);
      const task = await lockTask(client, keyOf(request));
      await assertVersion(client, task, version);
      assertEditable(task);
      const changes = await fn(client, task);
      if (changes.length) await touch(client, task);
      return changed(client, task, changes);
    };

    route('listTasks', PROJECT, 'WBS 목록 조회', async (request) => {
      const { projectId = '' } = paramsOf(request);
      const query = request.query as { status?: string; q?: string; includeDeleted?: boolean };
      return read(pool, async (client) => {
        if (!(await client.query('select 1 from projects where id=$1', [projectId])).rowCount) throw new TaskError('PROJECT_NOT_FOUND', { projectId });
        return listTasks(client, projectId, query);
      });
    });

    route('getTask', TASK, 'Task 상세 조회', async (request) => {
      const detail = await read(pool, (client) => taskDetail(client, keyOf(request), true));
      if (!detail) throw new TaskError('TASK_NOT_FOUND', { taskKey: keyOf(request) });
      return publicDetail(detail);
    });

    route('createTask', PROJECT, 'Task 생성', async (request, reply) => {
      const client = clientOf(request);
      const { projectId = '' } = paramsOf(request);
      const body = request.body as {
        title: string; wbsNodeId: string; workType: string; primaryDomain: string; relatedDomains?: string[]; priority?: number;
        assigneeAgent?: Agent; verifierAgent?: Agent; overview?: Overview; spec?: SpecBody; ac?: Ac[];
        checklist?: { content: string; required: boolean; verifyMethod?: string | null }[];
      };
      if (!(await client.query('select 1 from projects where id=$1 for share', [projectId])).rowCount) throw new TaskError('PROJECT_NOT_FOUND', { projectId });
      // Task의 부모는 같은 프로젝트의 Work Package다(data-model §2.3). 부모 노드가 그 사이 바뀌지 않게 잠근다.
      const node = (await client.query<{ kind: string }>('select kind from wbs_nodes where id=$1 and project_id=$2 for share', [body.wbsNodeId, projectId])).rows[0];
      if (node?.kind !== 'work_package') throw new TaskError('WBS_NODE_NOT_FOUND', { wbsNodeId: body.wbsNodeId });
      const related = body.relatedDomains ?? [];
      if (related.includes(body.primaryDomain)) {
        throw new TaskError('VALIDATION_FAILED', {}, [{ path: 'relatedDomains', rule: 'notPrimaryDomain', message: '주 기술 영역은 관련 영역에 다시 넣을 수 없습니다.' }]);
      }
      // 기본 담당은 Workflow 설정의 개발·검증 Agent(P wizDefault, 기본 Claude 개발 → Codex QA)
      const workflow = (await client.query<{ workflow: { devAgent?: Agent; qaAgent?: Agent } | null }>('select workflow from app_settings where singleton')).rows[0]?.workflow;
      // 표시 ID 순번은 프로젝트 counters 행을 잠가 증가시키고 재사용하지 않는다(data-model §1).
      const sequence = (await client.query<{ value: number }>(
        `insert into counters(project_id,kind,value)
         values($1,'task',(select coalesce(max((substring(task_key from 6))::bigint),0)+1 from tasks where project_id=$1))
         on conflict (project_id,kind) do update set value=counters.value+1 returning value::int as value`, [projectId])).rows[0]?.value ?? 0;
      const taskKey = displayKey('TASK', sequence);
      const inserted = (await client.query<{ id: string }>(
        `insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state)
         values($1,$2,$3,(select coalesce(max(sort_order)+1,0) from tasks where wbs_node_id=$3),$4,$5,$6,$7::domain[],$8,$9,$10,'planning','none') returning id`,
        [projectId, taskKey, body.wbsNodeId, body.title, body.workType, body.primaryDomain, related, body.priority ?? 2,
          body.assigneeAgent ?? workflow?.devAgent ?? 'Claude', body.verifierAgent ?? workflow?.qaAgent ?? 'Codex'],
      )).rows[0];
      assert(inserted);
      const task = { id: inserted.id, project_id: projectId, task_key: taskKey };
      await client.query('insert into task_specs(project_id,task,overview,spec,ac,revision) values($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,1)',
        [projectId, task.id, JSON.stringify(overviewOf(body.overview)), JSON.stringify(specBody(body.spec ?? {})), JSON.stringify(acOf(body.ac))]);
      for (const [index, item] of (body.checklist ?? []).entries()) {
        await client.query('insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order) values($1,$2,$3,$4,$5,false,$6,$7)',
          [projectId, task.id, await nextChecklistKey(client, task), item.content, item.required, item.verifyMethod ?? '', index]);
      }
      await record(client, { projectId, taskId: task.id, kind: '생성', text: `Task 생성 — ${body.workType} / ${body.primaryDomain}`, after: 'planning' });
      // 버전은 이력보다 늦어야 충돌 창에 자기 생성 이력이 「그 뒤의 변경」으로 섞이지 않는다.
      await touch(client, { ...task, status: 'planning', updated_at: '', deleted_at: null });
      const detail = await taskDetail(client, taskKey);
      return reply.code(201).send({ id: task.id, taskKey, wbsPath: detail?.wbsPath ?? '', lifecycleStatus: 'planning' });
    });

    route('updateTask', TASK, 'Task 수정', async (request) => {
      const body = request.body as Versioned & { title?: string; priority?: number; assigneeAgent?: Agent; verifierAgent?: Agent };
      return edit(request, body.updatedAt, async (client, task) => {
        const current = (await client.query<Record<string, unknown>>('select title,priority,assignee_agent,verifier_agent from tasks where id=$1', [task.id])).rows[0] ?? {};
        const fields = [['title', 'title', '제목'], ['priority', 'priority', '우선순위'], ['assigneeAgent', 'assignee_agent', '담당 Agent'], ['verifierAgent', 'verifier_agent', '검증 Agent']] as const;
        const changes: Change[] = [];
        for (const [field, column, label] of fields) {
          const after = body[field];
          if (after === undefined || after === current[column]) continue;
          await client.query(`update tasks set ${column}=$2 where id=$1`, [task.id, after]);
          await record(client, { projectId: task.project_id, taskId: task.id, kind: '수정', text: `${label} 변경`, before: current[column], after, ref: { field } });
          changes.push({ field, before: current[column], after });
        }
        return changes;
      });
    });

    route('deleteTask', TASK, 'Task 삭제', async (request, reply) => {
      const client = clientOf(request);
      const { updatedAt } = request.query as Versioned;
      const found = (await client.query<{ project_id: string }>('select project_id from tasks where task_key=$1 and deleted_at is null', [keyOf(request)])).rows[0];
      if (!found) throw new TaskError('TASK_NOT_FOUND', { taskKey: keyOf(request) });
      await lockGraph(client, found.project_id);
      const task = await lockTask(client, keyOf(request));
      await assertVersion(client, task, updatedAt);
      assertEditable(task);
      // 시작한 Task는 지우지 않는다. 시작 전 상태라도 실행 기록·열린 보유가 있으면 시작된 것으로 본다(D-16, P cancelBeforeStart).
      // 시작 후 삭제를 허용하려면 중단·보유 정리 절차부터 정해야 한다(독립 리뷰 P1-1).
      const started = (await client.query<{ attempts: boolean; holds: boolean }>(
        `select exists(select 1 from task_attempts where task=$1) as attempts,
                exists(select 1 from execution_holds where task=$1 and closed_at is null) as holds`, [task.id])).rows[0];
      if (!['planning', 'approval', 'ready'].includes(task.status) || started?.attempts || started?.holds) {
        throw new TaskError('INVALID_TRANSITION', { taskKey: task.task_key, status: task.status, executionHistory: started?.attempts ?? false, openHold: started?.holds ?? false },
          [], '이미 시작했거나 실행 기록이 있는 Task는 삭제할 수 없습니다.');
      }
      const successors = (await client.query<{ task_key: string }>(
        'select s.task_key from task_dependencies d join tasks s on s.id=d.succ where d.pred=$1 and s.deleted_at is null order by s.task_key', [task.id])).rows;
      if (successors.length) throw new TaskError('TASK_HAS_SUCCESSORS', { successors: successors.map((row) => row.task_key) });
      // 지운 Task가 후속으로 걸린 관계는 함께 정리한다. 남겨 두면 선행 Task를 영영 지울 수 없다.
      const removed = (await client.query<{ id: string; pred_key: string; dep_type: string }>(
        `with gone as (delete from task_dependencies where succ=$1 returning id,pred,dep_type)
         select gone.id,p.task_key as pred_key,gone.dep_type from gone join tasks p on p.id=gone.pred order by p.task_key`, [task.id])).rows;
      for (const dep of removed) {
        await record(client, { projectId: task.project_id, taskId: task.id, kind: '선행 관계', text: `선행 Task ${dep.pred_key} 삭제 (Task 삭제)`, before: `${dep.pred_key} (${dep.dep_type})`, ref: { field: 'predecessors', dependencyId: dep.id } });
        await changeEvent(client, task.project_id, 'dependency', { id: dep.id, pred: dep.pred_key, succ: task.task_key });
      }
      await client.query('update tasks set deleted_at=clock_timestamp() where id=$1', [task.id]);
      await record(client, { projectId: task.project_id, taskId: task.id, kind: '삭제', text: 'Task 삭제 (soft delete)', ref: { field: 'deletedAt' } });
      await changeEvent(client, task.project_id, 'task', { taskKey: task.task_key });
      return reply.code(204).send();
    });

    route('addDependency', TASK, '의존성 추가', async (request, reply) => {
      const client = clientOf(request);
      const succKey = keyOf(request);
      const body = request.body as Versioned & { predTaskKey: string; depType: 'FS' | 'SS' };
      if (body.predTaskKey === succKey) throw new TaskError('DEPENDENCY_SELF', { taskKey: succKey });
      const found = (await client.query<{ project_id: string }>('select project_id from tasks where task_key=$1 and deleted_at is null', [succKey])).rows[0];
      if (!found) throw new TaskError('TASK_NOT_FOUND', { taskKey: succKey });
      // 순환 판정은 그래프 전체를 본다. 동시 추가를 프로젝트 잠금으로 한 줄로 세운 뒤 검사한다(data-model §4).
      await lockGraph(client, found.project_id);
      const locked = await lockTasks(client, [succKey, body.predTaskKey]);
      const succ = locked.get(succKey);
      if (!succ) throw new TaskError('TASK_NOT_FOUND', { taskKey: succKey });
      const pred = locked.get(body.predTaskKey);
      if (!pred) throw new TaskError('TASK_NOT_FOUND', { taskKey: body.predTaskKey });
      await assertVersion(client, succ, body.updatedAt);
      assertEditable(succ);
      const tasks = (await client.query<{ id: string; status: TaskStatus; task_key: string }>('select id,status,task_key from tasks where project_id=$1 and deleted_at is null', [succ.project_id])).rows;
      const deps = (await client.query<{ pred: string; succ: string; type: 'FS' | 'SS' }>('select pred,succ,dep_type as type from task_dependencies where project_id=$1', [succ.project_id])).rows;
      const candidate = { pred: pred.id, succ: succ.id, type: body.depType };
      try { assertDependency(tasks, deps, candidate); } catch (error) { domainError(error, new Map(tasks.map((task) => [task.id, task.task_key]))); }
      const wasBlocked = isBlocked(tasks, deps, succ.id);
      const blocked = isBlocked(tasks, [...deps, candidate], succ.id);
      // D-35: 변경 전에는 막히지 않았던 진행 중 Task가 이 관계로 막히면 거부한다. 강제 우회는 없다.
      if (ACTIVE.includes(succ.status) && !wasBlocked && blocked) {
        throw new TaskError('ACTIVE_TASK_BLOCKED', { taskKey: succKey, status: succ.status, predTaskKey: pred.task_key });
      }
      const id = (await client.query<{ id: string }>('insert into task_dependencies(project_id,pred,succ,dep_type) values($1,$2,$3,$4) returning id',
        [succ.project_id, pred.id, succ.id, body.depType])).rows[0]?.id ?? '';
      const label = body.depType === 'FS' ? '완료 후 시작' : '시작 후 시작';
      await record(client, { projectId: succ.project_id, taskId: succ.id, kind: '선행 관계', text: `선행 Task ${pred.task_key} 추가 (${label})`, after: `${pred.task_key} (${body.depType})`, ref: { field: 'predecessors', dependencyId: id } });
      if (blocked && !wasBlocked && succ.status !== 'done') {
        await record(client, { projectId: succ.project_id, taskId: succ.id, actor: SYSTEM, kind: '차단', text: `${pred.task_key} 미충족으로 실행 차단`, before: '실행 가능', after: '차단', ref: { field: 'blocked' } });
      }
      await touch(client, succ);
      await changeEvent(client, succ.project_id, 'dependency', { id, pred: pred.task_key, succ: succKey });
      return reply.code(201).send({ dependency: { id, pred: pred.task_key, succ: succKey, type: body.depType }, blocked });
    });

    route('deleteDependency', DEPENDENCY, '의존성 삭제', async (request, reply) => {
      const client = clientOf(request);
      const { dependencyId = '' } = paramsOf(request);
      const { updatedAt } = request.query as Versioned;
      const notFound = () => new TaskError('DEPENDENCY_NOT_FOUND', { id: dependencyId });
      if (!UUID.test(dependencyId)) throw notFound();
      const found = (await client.query<{ project_id: string }>('select project_id from task_dependencies where id=$1', [dependencyId])).rows[0];
      if (!found) throw notFound();
      await lockGraph(client, found.project_id);
      const dep = (await client.query<{ dep_type: string; pred_key: string; succ_key: string }>(
        'select d.dep_type,p.task_key as pred_key,s.task_key as succ_key from task_dependencies d join tasks p on p.id=d.pred join tasks s on s.id=d.succ where d.id=$1',
        [dependencyId])).rows[0];
      if (!dep) throw notFound();
      const succ = await lockTask(client, dep.succ_key);
      await assertVersion(client, succ, updatedAt);
      assertEditable(succ);
      await client.query('delete from task_dependencies where id=$1', [dependencyId]);
      await record(client, { projectId: succ.project_id, taskId: succ.id, kind: '선행 관계', text: `선행 Task ${dep.pred_key} 삭제`, before: `${dep.pred_key} (${dep.dep_type})`, ref: { field: 'predecessors', dependencyId } });
      await touch(client, succ);
      await changeEvent(client, succ.project_id, 'dependency', { id: dependencyId, pred: dep.pred_key, succ: dep.succ_key });
      return reply.code(204).send();
    });

    route('updateTaskSpec', TASK, '작업 명세 편집', async (request) => {
      const body = request.body as Versioned & { overview?: Overview; spec?: SpecBody; ac?: Ac[] };
      return edit(request, body.updatedAt, async (client, task) => {
        const row = (await client.query<{ overview: unknown; spec: Record<string, unknown>; ac: unknown }>('select overview,spec,ac from task_specs where task=$1 for update', [task.id])).rows[0];
        const before = { overview: overviewOf(row?.overview), spec: specBody(row?.spec ?? {}), ac: acOf(row?.ac) };
        const after = { overview: body.overview ? overviewOf(body.overview) : before.overview, spec: body.spec ? specBody(body.spec) : before.spec, ac: body.ac ? acOf(body.ac) : before.ac };
        const labels = { overview: '개요', spec: '상세 명세', ac: 'Acceptance Criteria' } as const;
        const changes = (['overview', 'spec', 'ac'] as const)
          .filter((field) => canonicalJson(before[field]) !== canonicalJson(after[field]))
          .map((field) => ({ field, before: before[field], after: after[field] }));
        if (!changes.length) return [];
        // 명세가 바뀌면 revision을 올린다. 이전 revision의 검증 근거는 무효가 된다(data-model §3.1 gate→verifying).
        const revision = (await client.query<{ revision: number }>(
          `insert into task_specs(project_id,task,overview,spec,ac,revision) values($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,1)
           on conflict (task) do update set overview=excluded.overview,spec=excluded.spec,ac=excluded.ac,revision=task_specs.revision+1 returning revision`,
          [task.project_id, task.id, JSON.stringify(after.overview), JSON.stringify(after.spec), JSON.stringify(after.ac)])).rows[0]?.revision ?? 1;
        for (const change of changes) {
          await record(client, { projectId: task.project_id, taskId: task.id, kind: '명세 수정', text: `작업 명세 「${labels[change.field as keyof typeof labels]}」 수정`, before: change.before, after: change.after, ref: { field: change.field } });
        }
        return [...changes, ...await invalidateGate(client, task, revision)];
      });
    });

    route('updateTaskDesign', DESIGN, '기술 설계 편집', async (request) => {
      const body = request.body as Versioned & { content: Record<string, unknown> };
      const { kind = '' } = paramsOf(request);
      return edit(request, body.updatedAt, async (client, task) => {
        const before = (await client.query<{ content: unknown }>('select content from task_designs where task=$1 and kind=$2 for update', [task.id, kind])).rows[0]?.content ?? null;
        if (before !== null && canonicalJson(before) === canonicalJson(body.content)) return [];
        await client.query(`insert into task_designs(project_id,task,kind,content) values($1,$2,$3,$4::jsonb)
          on conflict (task,kind) do update set content=excluded.content`, [task.project_id, task.id, kind, JSON.stringify(body.content)]);
        const field = `design.${kind}`;
        await record(client, { projectId: task.project_id, taskId: task.id, kind: '설계 수정', text: `기술 설계 ${kind} 수정`, before, after: body.content, ref: { field } });
        return [{ field, before, after: body.content }];
      });
    });

    route('addChecklistItem', TASK, '체크리스트 항목 추가', async (request, reply) => {
      const body = request.body as Versioned & { content: string; required: boolean; verifyMethod?: string | null };
      const result = await edit(request, body.updatedAt, async (client, task) => {
        const itemKey = await nextChecklistKey(client, task);
        await client.query(`insert into checklist_items(project_id,task,item_key,content,required,done,verify_method,sort_order)
          values($1,$2,$3,$4,$5,false,$6,(select coalesce(max(sort_order)+1,0) from checklist_items where task=$2))`,
        [task.project_id, task.id, itemKey, body.content, body.required, body.verifyMethod ?? '']);
        const field = `checklist.${itemKey}`;
        await record(client, { projectId: task.project_id, taskId: task.id, kind: '체크리스트', text: `${itemKey} 항목 추가 (${body.required ? '필수' : '선택'})`, after: body.content, ref: { field } });
        return [{ field, before: null, after: { content: body.content, required: body.required, done: false, verifyMethod: body.verifyMethod ?? null } }];
      });
      return reply.code(201).send(result);
    });

    const checklistRow = async (client: PoolClient, task: LockedTask, itemKey: string) => {
      const row = (await client.query<{ id: string; content: string; required: boolean; done: boolean; verify_method: string; evidence: unknown; note: string | null }>(
        'select id,content,required,done,verify_method,evidence,note from checklist_items where task=$1 and item_key=$2 for update', [task.id, itemKey])).rows[0];
      if (!row) throw new TaskError('NOT_FOUND', { resource: 'checklist_item', id: itemKey });
      return row;
    };

    route('updateChecklistItem', ITEM, '체크리스트 항목 편집', async (request) => {
      type Patch = Partial<{ content: string; required: boolean; done: boolean; verifyMethod: string | null; evidence: string | null; note: string | null }>;
      const body = request.body as Versioned & Patch;
      const { itemKey = '' } = paramsOf(request);
      return edit(request, body.updatedAt, async (client, task) => {
        const row = await checklistRow(client, task, itemKey);
        const current: Required<Patch> = {
          content: row.content, required: row.required, done: row.done, verifyMethod: row.verify_method || null,
          evidence: row.evidence == null ? null : typeof row.evidence === 'string' ? row.evidence : JSON.stringify(row.evidence), note: row.note,
        };
        const names = (['content', 'required', 'done', 'verifyMethod', 'evidence', 'note'] as const).filter((name) => body[name] !== undefined && body[name] !== current[name]);
        if (!names.length) return [];
        const next = { ...current, ...Object.fromEntries(names.map((name) => [name, body[name]])) } as Required<Patch>;
        await client.query('update checklist_items set content=$2,required=$3,done=$4,verify_method=$5,evidence=$6::jsonb,note=$7 where id=$1',
          [row.id, next.content, next.required, next.done, next.verifyMethod ?? '', next.evidence === null ? null : JSON.stringify(next.evidence), next.note]);
        const pick = (source: Required<Patch>) => Object.fromEntries(names.map((name) => [name, source[name]]));
        await record(client, { projectId: task.project_id, taskId: task.id, kind: '체크리스트', text: `${itemKey} ${next.content} 수정 (${names.join(', ')})`, before: pick(current), after: pick(next), ref: { field: `checklist.${itemKey}` } });
        return names.map((name) => ({ field: `checklist.${itemKey}.${name}`, before: current[name], after: next[name] }));
      });
    });

    route('deleteChecklistItem', ITEM, '체크리스트 항목 삭제', async (request, reply) => {
      const { updatedAt } = request.query as Versioned;
      const { itemKey = '' } = paramsOf(request);
      await edit(request, updatedAt, async (client, task) => {
        const row = await checklistRow(client, task, itemKey);
        await client.query('delete from checklist_items where id=$1', [row.id]);
        const field = `checklist.${itemKey}`;
        await record(client, { projectId: task.project_id, taskId: task.id, kind: '체크리스트', text: `${itemKey} 항목 삭제`, before: row.content, ref: { field } });
        return [{ field, before: row.content, after: null }];
      });
      return reply.code(204).send();
    });

    route('updateTaskOutputs', TASK, '산출물 편집', async (request) => {
      const body = request.body as Versioned & { outputs: Output[] };
      const seen = new Set<string>();
      const duplicates = body.outputs.flatMap((output, index) => {
        if (!seen.has(output.name)) { seen.add(output.name); return []; }
        return [{ path: `outputs.${String(index)}.name`, rule: 'unique', message: `산출물 이름 「${output.name}」이 겹칩니다.` }];
      });
      if (duplicates.length) throw new TaskError('VALIDATION_FAILED', {}, duplicates);
      return edit(request, body.updatedAt, async (client, task) => {
        const before = (await client.query<Output>('select name,kind,required,verify,delivered from task_outputs where task=$1 order by name for update', [task.id])).rows;
        const after = [...body.outputs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map(({ name, kind, required, verify, delivered }) => ({ name, kind, required, verify, delivered }));
        if (canonicalJson(before) === canonicalJson(after)) return [];
        await client.query('delete from task_outputs where task=$1 and not (name=any($2::text[]))', [task.id, after.map((output) => output.name)]);
        for (const output of after) {
          await client.query(`insert into task_outputs(project_id,task,name,kind,required,verify,delivered) values($1,$2,$3,$4,$5,$6,$7)
            on conflict (task,name) do update set kind=excluded.kind,required=excluded.required,verify=excluded.verify,delivered=excluded.delivered`,
          [task.project_id, task.id, output.name, output.kind, output.required, output.verify, output.delivered]);
        }
        await record(client, { projectId: task.project_id, taskId: task.id, kind: '산출물', text: '예상 산출물 수정', before, after, ref: { field: 'outputs' } });
        return [{ field: 'outputs', before, after }];
      });
    });

    /** 착수 승인 요청·승인·반려(Q-05 2·3행). 자동 전이 없이 팀장 요청으로만 바뀐다. */
    const lifecycle = (action: 'request-approval' | 'approve' | 'reject') => async (request: FastifyRequest) => {
      const body = request.body as Versioned & { comment?: string };
      return edit(request, body.updatedAt, async (client, task) => {
        const detail = await taskDetail(client, task.task_key);
        assert(detail);
        const spec: ApprovalInput = {
          purpose: detail.spec.overview.purpose, doneCond: detail.spec.overview.doneCond, ac: detail.spec.ac, checklist: detail.checklistItems,
          outputs: detail.outputs, assignee: detail.assigneeAgent as Agent | null, verifier: detail.verifierAgent as Agent | null,
        };
        let next: TaskStatus;
        try {
          next = lifecycleTransition(task.status, action === 'reject' ? { type: action, leader: true } : { type: action, leader: true, spec });
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          if (error.code === 'VALIDATION_FAILED') throw new TaskError('VALIDATION_FAILED', {}, approvalErrors(spec), '착수 승인에 필요한 명세 항목이 부족합니다.');
          throw new TaskError('INVALID_TRANSITION', { status: task.status, action });
        }
        if (action === 'approve') await assertJudged(client, detail);
        await client.query(`update tasks set status=$2${action === 'approve' ? ',planning_approved_at=clock_timestamp()' : ''} where id=$1`, [task.id, next]);
        const [kind, text] = STATUS_HISTORY[action];
        await record(client, {
          projectId: task.project_id, taskId: task.id, kind, text: body.comment ? `${text} — ${body.comment}` : text, before: task.status, after: next,
          ref: { field: 'lifecycleStatus', ...(body.comment ? { comment: body.comment } : {}) },
        });
        return [{ field: 'lifecycleStatus', before: task.status, after: next }];
      });
    };
    route('requestTaskApproval', TASK, '착수 승인 요청', lifecycle('request-approval'));
    route('approveTask', TASK, '착수 승인', lifecycle('approve'));
    route('rejectTask', TASK, '착수 반려', lifecycle('reject'));

    done();
  });
}

/**
 * D-33: 켜진 규칙 5·7·9마다 현재 판단 대상 hash와 일치하고 두 Agent가 합의한 `met`이 있어야 착수 승인한다.
 * 기록 없음·불충족은 보류(409)이며 자동 규칙의 예외 사유로 대신하지 않는다(data-model §2.3-1).
 */
async function assertJudged(client: PoolClient, detail: TaskDetail): Promise<void> {
  const split = (await client.query<{ split: Record<string, unknown> }>('select split from app_settings where singleton')).rows[0]?.split;
  assert(split, '분할 기준 설정이 필요합니다.');
  const settings = splitSettingsToDomain(split);
  const hash = subjectHash({
    title: detail.title, overview: detail.spec.overview, spec: detail.spec.spec, ac: detail.spec.ac, outputs: detail.outputs,
    designs: detail.designs, conflictGroup: detail.conflictGroup,
  });
  const recordOf = (detail.split?.judgedRules ?? null) as JudgedRules | null;
  const items = JUDGED_RULES.filter((rule) => settings.enabled[rule]).flatMap((rule) => {
    const { state, detail: message } = judgementOf(recordOf, rule, hash);
    return state === 'met' ? [] : [{ rule, reason: state === 'missing' ? 'JUDGEMENT_MISSING' : 'JUDGEMENT_NOT_MET', message }];
  });
  if (items.length) throw new TaskError('SPLIT_JUDGEMENT_REQUIRED', { items, subjectHash: hash });
}

/**
 * Q-05 14행·data-model §3.1: Gate 대기에서 검증한 명세가 바뀌면 검증 근거가 무효가 되어 `gate → verifying`이다.
 * 판정은 shared의 lifecycleTransition(invalidate)이 하고, 원본 검증 행은 그대로 두고 무효 기록만 추가한다.
 * Gate가 아닌 상태의 낡은 검증은 M2-06이 PASS 반영 때 revision을 대조해 거부한다.
 */
export async function invalidateGate(client: PoolClient, task: LockedTask, revision: number): Promise<Change[]> {
  if (task.status !== 'gate') return [];
  const latest = (await client.query<{ id: string; result: VerificationResult; head_sha: string; spec_revision: number }>(
    `select v.id,v.result,v.head_sha,v.spec_revision from verifications v join task_attempts a on a.id=v.attempt
     where a.task=$1 order by v.created_at desc,v.id desc limit 1`, [task.id])).rows[0];
  const next = latest ? lifecycleTransition('gate', {
    type: 'invalidate',
    basis: { headSha: latest.head_sha, specRevision: revision, inputVersion: 0 },
    verification: { result: latest.result, headSha: latest.head_sha, specRevision: latest.spec_revision, inputVersion: 0, invalidated: false },
  }) : 'verifying';
  if (next === 'gate') return [];
  const reason = latest ? `명세 revision ${String(latest.spec_revision)} → ${String(revision)}` : `명세 revision ${String(revision)}: 근거가 될 검증 없음`;
  if (latest) await client.query('insert into verification_invalidations(project_id,verification,reason) values($1,$2,$3)', [task.project_id, latest.id, reason]);
  await client.query('update tasks set status=$2 where id=$1', [task.id, next]);
  await record(client, { projectId: task.project_id, taskId: task.id, actor: SYSTEM, kind: '재검증', text: `${reason} — 검증 근거 무효, 재검증 필요`, before: 'gate', after: next, ref: { field: 'lifecycleStatus', verification: latest?.id ?? null } });
  return [{ field: 'lifecycleStatus', before: 'gate', after: next }];
}
