import type { PoolClient } from '@awbs/db';
import { jobPayloadErrors } from '@awbs/shared/api';
import { getExecPolicy, getModels } from '../policy/service.ts';
import { judgedTasks } from '../policy/judged.ts';
import { taskDetail } from '../tasks/read.ts';
import { enqueueJob } from '../project/db.ts';

export interface RejudgeInput { reason: string; trigger: string; targets: { taskKey: string; roles: string[] }[] }

/** 등급 변경·정책 변경·계약 변경 모두 같은 현재 내용과 정책으로 추정을 요청한다. */
export async function requestEstimate(client: PoolClient, projectId: string, taskIds: string[], rejudge: RejudgeInput, epoch: number, dedupKey: string): Promise<string> {
  const policy = await getExecPolicy(client);
  const models = await getModels(client);
  const tasks = await judgedTasks(client, taskIds);
  if (!tasks.length || tasks.length !== taskIds.length) throw new Error('추정 대상 Task를 확인하세요.');
  const detail = rejudge.reason === 'grade_changed' ? await taskDetail(client, tasks[0]?.taskKey ?? '') : null;
  const payload = {
    tasks,
    policy: {
      rejudge, floors: policy.floors,
      allowedModels: Object.fromEntries(['Claude', 'Codex'].map(a => [a, models.models.filter(m => m.agent === a && m.allowed).map(m => m.id)])),
      ...(detail && { gradeChange: tasks[0]?.gradeChange, grades: detail.grades, estimate: detail.estimate }),
    },
  };
  const problems = jobPayloadErrors('estimate', payload);
  if (problems.length) throw new Error(problems.join('; '));
  return enqueueJob(client, { projectId, kind: 'estimate', payload, epoch, dedupKey });
}
