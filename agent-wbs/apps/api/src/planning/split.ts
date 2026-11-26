import type { PoolClient } from '@awbs/db';
import { checkSplit, splitExceptionProblem, type JudgedRules } from '@awbs/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { TaskError } from '../tasks/errors.ts';
import { judgedContent, subjectHash, type JudgedSource } from '../tasks/hash.ts';
import { taskDetail, type TaskDetail } from '../tasks/read.ts';
import { assertEditable, assertVersion, changed, LEAD, lockTask, record, touch, type LockedTask } from '../tasks/write.ts';
import { ApiError } from '../changes/http.ts';
import { applyRegrade } from '../policy/service.ts';
import { assertGradeChange, assertJob } from './jobs.ts';
import { clientOf } from './proposals.ts';
import { loadSnapshot } from './snapshot.ts';

/*
 * 분할 요청·예외 사유(G§5.2-1)와 Planning의 Task 판단 보고(contracts §3.3 /planning/tasks/:taskKey/plan).
 */

export type RouteFn = (id: string, action: string, handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>, params?: object) => void;
const TASK = { type: 'object', properties: { taskKey: { type: 'string', pattern: '^TASK-[0-9]{4,}$' } }, required: ['taskKey'] };
const OPEN = ['queued', 'leased', 'started', 'reconcile'];
const PRESTART = ['planning', 'approval', 'ready'];
interface Grade { modelId: string; effort: string; reason: string }
const keyOf = (request: FastifyRequest) => (request.params as { taskKey?: string }).taskKey ?? '';
const sourceOf = (d: TaskDetail): JudgedSource => ({
  title: d.title, overview: d.spec.overview, spec: d.spec.spec, ac: d.spec.ac, outputs: d.outputs, designs: d.designs, conflictGroup: d.conflictGroup,
});

async function detailOf(client: PoolClient, key: string): Promise<TaskDetail> {
  const detail = await taskDetail(client, key);
  if (!detail) throw new TaskError('TASK_NOT_FOUND', { taskKey: key });
  return detail;
}

/** 시작 전이라도 실행 기록·열린 보유가 있으면 시작한 것으로 본다(shared hasStarted, M2-02 삭제 규칙과 같다). */
async function started(client: PoolClient, task: LockedTask): Promise<boolean> {
  if (!PRESTART.includes(task.status)) return true;
  const row = (await client.query<{ yes: boolean }>(
    `select exists(select 1 from task_attempts where task=$1) or exists(select 1 from execution_holds where task=$1 and closed_at is null) as yes`, [task.id])).rows[0];
  return row?.yes ?? false;
}

export function registerSplitRoutes(route: RouteFn, epochOf: (request: FastifyRequest) => number): void {
  route('splitTask', '분할 제안 요청', async (request, reply) => {
    const client = clientOf(request);
    const body = request.body as { updatedAt: string };
    const task = await lockTask(client, keyOf(request));
    await assertVersion(client, task, body.updatedAt);
    assertEditable(task);
    // 시작한 Task는 나누지 않고 예외 사유를 기록하거나 후속 Task로 제안한다(G§5.2-1).
    if (await started(client, task)) {
      throw new TaskError('INVALID_TRANSITION', { taskKey: task.task_key, status: task.status }, [], '이미 시작한 Task는 분할하지 않습니다. 예외 사유를 기록하거나 남은 일을 후속 Task로 제안하세요.');
    }
    const detail = await detailOf(client, task.task_key);
    const source = sourceOf(detail);
    const hash = subjectHash(source);
    // 같은 내용(hash)의 열린 분할 job이 있으면 그 job을 돌려준다. 내용이 바뀌면 새 job이다.
    const key = `split:${task.task_key}:${hash}`;
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    const existing = (await client.query<{ id: string | null; n: number }>(
      "select (array_agg(id order by created_at desc) filter (where state::text=any($2)))[1] as id,count(*)::int as n from runner_jobs where dedup_key like $1",
      [`${key}:%`, OPEN])).rows[0];
    if (existing?.id) return reply.code(202).send({ jobId: existing.id });
    const settings = (await client.query<{ split: unknown }>('select split from app_settings where singleton')).rows[0]?.split ?? null;
    const payload = { tasks: [{ taskKey: task.task_key, subjectHash: hash, content: judgedContent(source) }], policy: { split: settings }, proposal: null };
    const jobId = (await client.query<{ id: string }>(
      "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'split',$2::jsonb,'queued',$3,$4) returning id",
      [task.project_id, JSON.stringify(payload), epochOf(request), `${key}:${String((existing?.n ?? 0) + 1)}`])).rows[0]?.id;
    await record(client, { projectId: task.project_id, taskId: task.id, kind: '분할 요청', text: 'Planning Agent에 분할 제안 요청', ref: { field: 'split', jobId } });
    return reply.code(202).send({ jobId });
  }, TASK);

  route('addSplitException', '분할 예외 사유 기록', async (request, reply) => {
    const client = clientOf(request);
    const body = request.body as { updatedAt: string; rule: string; why: string };
    const task = await lockTask(client, keyOf(request));
    await assertVersion(client, task, body.updatedAt);
    assertEditable(task);
    const loaded = await loadSnapshot(client, task.project_id);
    const target = loaded.snapshot.tasks.find((item) => item.id === task.task_key);
    const source = loaded.sources.get(task.task_key);
    if (!target || !source) throw new TaskError('TASK_NOT_FOUND', { taskKey: task.task_key });
    const preds = loaded.snapshot.dependencies.filter((dep) => dep.succ === task.task_key)
      .flatMap((dep) => loaded.snapshot.tasks.find((item) => item.id === dep.pred) ?? []);
    const check = checkSplit(target, preds, subjectHash(source), loaded.settings);
    const at = (await client.query<{ at: string }>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`)).rows[0]?.at ?? '';
    const exception = { rule: body.rule, why: body.why, by: LEAD, at };
    const problem = splitExceptionProblem(target, check, exception);
    if (problem) {
      // 시작 전 Task는 예외가 아니라 분할 대상이다(상태 문제). 그 밖의 문제는 입력 문제다.
      if (!(await started(client, task))) throw new TaskError('INVALID_TRANSITION', { taskKey: task.task_key, status: task.status }, [], problem);
      throw new TaskError('VALIDATION_FAILED', {}, [{ path: 'rule', rule: 'flaggedRule', message: problem }]);
    }
    const exceptions = [...target.exceptions.filter((item) => item.rule !== body.rule), exception];
    await client.query(`insert into task_splits(project_id,task,basis,judged_rules,exceptions) values($1,$2,'','{"schemaVersion":1,"items":[]}'::jsonb,$3::jsonb)
      on conflict (task) do update set exceptions=excluded.exceptions`, [task.project_id, task.id, JSON.stringify(exceptions)]);
    await record(client, { projectId: task.project_id, taskId: task.id, kind: '분할 예외', text: `분할 기준 「${body.rule}」 예외 — ${body.why}`, before: target.exceptions, after: exceptions, ref: { field: 'split.exceptions' } });
    await touch(client, task);
    return reply.code(201).send(await changed(client, task, [{ field: 'split.exceptions', before: target.exceptions, after: exceptions }]));
  }, TASK);

  route('submitTaskPlan', 'Planning Task 판단 보고', async (request, reply) => {
    const client = clientOf(request);
    const body = request.body as {
      jobId: string; fence: number; grades: { dev: Grade; qa: Grade }; subagents: { dev: string[]; qa: string[]; basis: string };
      conflictGroup: { name: string; reason: string } | null; judgedRules?: JudgedRules;
    };
    const rules = (body.judgedRules?.items ?? []).map((item) => item.rule);
    const duplicates = rules.flatMap((rule, index) => (rules.indexOf(rule) === index ? [] : [{ path: `judgedRules.items.${String(index)}.rule`, rule: 'uniqueRule', message: `규칙 ${rule} 판단이 두 번 있습니다.` }]));
    if (duplicates.length) throw new TaskError('VALIDATION_FAILED', {}, duplicates);
    const job = await assertJob(client, body.jobId, body.fence);
    const task = await lockTask(client, keyOf(request));
    await assertGradeChange(client, job.payload, task.id);
    // 등급 재판단 작업(M2-08 requestRejudge가 만든 estimate job의 policy.rejudge)의 대상 역할이면 결과를 applyRegrade로 저장한다(G§7.2, D-29).
    const rejudgeRoles = ((job.payload as { policy?: { rejudge?: { targets?: { taskKey: string; roles: string[] }[] } } } | null)?.policy?.rejudge?.targets ?? [])
      .find((target) => target.taskKey === task.task_key)?.roles ?? [];
    assertEditable(task);
    const before = await detailOf(client, task.task_key);
    const hash = subjectHash(sourceOf(before));
    // 기존 Task 재판단은 payload의 hash를 그대로 돌려받아 판단한 뒤 내용이 바뀌었는지 검출한다(data-model §2.3-1).
    if (body.judgedRules?.items.some((item) => item.subjectHash !== hash)) {
      throw new TaskError('VERSION_CONFLICT', { taskKey: task.task_key, subjectHash: hash, changes: [] }, [], '판단한 내용이 지금 Task 내용과 다릅니다.');
    }
    const projectId = task.project_id;
    const history = (input: Omit<Parameters<typeof record>[1], 'projectId' | 'taskId' | 'actor'>) => record(client, { projectId, taskId: task.id, actor: 'Planning', ...input });

    const group = body.conflictGroup?.name ?? null;
    if (group !== before.conflictGroup) {
      await client.query('update tasks set conflict_group=$2 where id=$1', [task.id, group]);
      await history({ kind: '충돌 묶음', text: `충돌 묶음 ${group ?? '없음'}${body.conflictGroup ? ` — ${body.conflictGroup.reason}` : ''}`, before: before.conflictGroup, after: group, ref: { field: 'conflictGroup' } });
    }
    if (body.judgedRules) {
      // 충돌 묶음 판단과 규칙 5·7·9 판단은 같은 보고에 함께 온다. 함께 정한 묶음을 반영한 내용으로 hash를 서버가 다시 붙인다.
      const after = group === before.conflictGroup ? hash : subjectHash({ ...sourceOf(before), conflictGroup: group });
      const judged = { ...body.judgedRules, items: body.judgedRules.items.map((item) => ({ ...item, subjectHash: after })) };
      await client.query(`insert into task_splits(project_id,task,basis,judged_rules,exceptions) values($1,$2,'',$3::jsonb,'[]'::jsonb)
        on conflict (task) do update set judged_rules=excluded.judged_rules`, [projectId, task.id, JSON.stringify(judged)]);
      await history({ kind: '분할 판단', text: '규칙 5·7·9 판단 기록', before: before.split?.judgedRules ?? null, after: judged, ref: { field: 'judgedRules' } });
    }
    for (const role of ['dev', 'qa'] as const) {
      const grade = body.grades[role];
      const current = (await client.query<{ model_id: string; effort: string; reason: string; locked: boolean }>('select model_id,effort,reason,locked from task_grades where task=$1 and role=$2 for update', [task.id, role])).rows[0];
      // 팀장이 고정한 등급은 Planning 판단으로 바꾸지 않는다(G§7.1).
      if (current?.locked || (current?.model_id === grade.modelId && current.effort === grade.effort && current.reason === grade.reason)) continue;
      if (rejudgeRoles.includes(role)) {
        // 허용·매핑·최저선을 검사하고 이전→이후 등급을 「실행 등급」 이력에 남긴다(M2-08). 오류는 이 범위의 TaskError로 바꿔 답한다.
        try {
          await applyRegrade(client, { taskKey: task.task_key, role, modelId: grade.modelId, effort: grade.effort, reason: grade.reason });
        } catch (error) {
          if (error instanceof ApiError) throw new TaskError(error.code, error.details, error.errors, error.message);
          throw error;
        }
        continue;
      }
      await client.query(`insert into task_grades(project_id,task,role,model_id,effort,reason,locked,effective_from) values($1,$2,$3,$4,$5,$6,false,clock_timestamp())
        on conflict (task,role) do update set model_id=excluded.model_id,effort=excluded.effort,reason=excluded.reason,effective_from=excluded.effective_from`,
      [projectId, task.id, role, grade.modelId, grade.effort, grade.reason]);
      await history({ kind: '등급', text: `${role} 등급 ${grade.modelId} ${grade.effort} — ${grade.reason}`, before: current ? `${current.model_id} ${current.effort}` : null, after: `${grade.modelId} ${grade.effort}`, ref: { field: `grades.${role}` } });
    }
    for (const role of ['dev', 'qa'] as const) {
      const wanted = body.subagents[role];
      const defs = (await client.query<{ id: string; def_key: string }>(
        'select distinct on (def_key) id,def_key from subagent_defs where def_key=any($1::text[]) or id::text=any($1::text[]) order by def_key,version desc', [wanted])).rows;
      if (defs.length !== new Set(wanted).size) throw new TaskError('VALIDATION_FAILED', {}, [{ path: `subagents.${role}`, rule: 'exists', message: '등록되지 않은 하위 Agent가 있습니다.' }]);
      await client.query('delete from task_subagents where task=$1 and role=$2 and not (subagent_id=any($3::uuid[]))', [task.id, role, defs.map((def) => def.id)]);
      for (const def of defs) {
        await client.query('insert into task_subagents(project_id,task,role,subagent_id,basis) values($1,$2,$3,$4,$5) on conflict (task,role,subagent_id) do update set basis=excluded.basis',
          [projectId, task.id, role, def.id, body.subagents.basis]);
      }
    }
    await touch(client, task);
    return reply.code(204).send();
  }, TASK);
}
