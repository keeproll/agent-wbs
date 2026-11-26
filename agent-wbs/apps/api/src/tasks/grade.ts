import type { PoolClient } from '@awbs/db';
import { gradeError } from '@awbs/shared';
import { jobPayloadErrors } from '@awbs/shared/api';
import { getExecPolicy, getModels } from '../policy/service.ts';
import { judgedTasks } from '../policy/judged.ts';
import { TaskError } from './errors.ts';
import { taskDetail } from './read.ts';
import { record, type Change, type LockedTask } from './write.ts';

/** G§7.1~7.3: 팀장 고정은 최저선 예외지만 허용 모델·보고된 Effort만 쓸 수 있다. */
export async function changeGrade(client: PoolClient, task: LockedTask, role: 'dev' | 'qa', grade: { modelId: string; effort: string } | null): Promise<Change[]> {
  const detail = await taskDetail(client, task.task_key);
  if (!detail) throw new TaskError('TASK_NOT_FOUND');
  const old = detail.grades[role];
  if (!grade && !old?.locked) return [];
  const models = await getModels(client);
  const agent = role === 'dev' ? detail.assigneeAgent : detail.verifierAgent;
  if (grade) {
    const model = models.models.find(m => m.agent === agent && m.id === grade.modelId);
    const problem = !model ? 'MODEL_UNKNOWN' : gradeError({ agent: model.agent, models: [{ modelId: model.id, rank: model.rank, allowed: model.allowed, efforts: model.efforts?.map(e => e.key) ?? [] }] }, grade);
    if (problem) throw new TaskError('VALIDATION_FAILED', {}, [{ path: problem.startsWith('MODEL') ? 'modelId' : 'effort', rule: problem, message: '허용된 모델과 확인된 Effort(작업 노력 단계)를 고르세요.' }]);
    if (old?.locked && old.modelId === grade.modelId && old.effort === grade.effort) return [];
  }
  const next = grade ? { ...grade, reason: '팀장 지정', locked: true } : old ? { ...old, locked: false } : null;
  if (!next) return [];
  const gradeChange = crypto.randomUUID();
  await client.query(`insert into task_grades(project_id,task,role,model_id,effort,reason,locked,locked_by,effective_from)
    values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()) on conflict(task,role) do update set
    model_id=excluded.model_id,effort=excluded.effort,reason=excluded.reason,locked=excluded.locked,locked_by=excluded.locked_by,effective_from=excluded.effective_from`,
  [task.project_id, task.id, role, next.modelId, next.effort, next.reason, next.locked, next.locked ? '팀장' : null]);
  const field = `grades.${role}`;
  const why = grade ? '팀장 등급 고정 — 작업량 재추정' : '등급 고정 해제 — Planning Agent 재판단·작업량 재추정';
  await record(client, { projectId: task.project_id, taskId: task.id, kind: '실행 등급', text: why, before: old, after: next, ref: { field, gradeChange } });
  const policy = await getExecPolicy(client);
  const payload = {
    tasks: await judgedTasks(client, [task.id]),
    policy: {
      gradeChange,
      rejudge: { reason: 'grade_changed', trigger: why, targets: [{ taskKey: task.task_key, roles: [role] }] },
      floors: policy.floors,
      allowedModels: Object.fromEntries(['Claude', 'Codex'].map(a => [a, models.models.filter(m => m.agent === a && m.allowed).map(m => m.id)])),
      grades: { ...detail.grades, [role]: next }, estimate: detail.estimate,
    },
  };
  const problems = jobPayloadErrors('estimate', payload);
  if (problems.length) throw new Error(problems.join('; '));
  await client.query(`insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key)
    values($1,'estimate',$2::jsonb,'queued',(select epoch from system_state where id=1),$3)`,
  [task.project_id, JSON.stringify(payload), `grade:${crypto.randomUUID()}`]);
  // 재추정 결과를 submitEstimates로 받으면 기존 경로가 일정을 다시 계산한다. 임의 계수로 시간을 만들지 않는다.
  return [{ field, before: old, after: next }];
}
