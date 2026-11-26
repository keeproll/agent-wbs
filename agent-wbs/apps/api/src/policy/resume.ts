import type { PoolClient } from '@awbs/db';
import type { ResolveResult } from '@awbs/shared';
import { deferChange } from '../changes/events.ts';
import { resumeRegradeEntry } from './rules.ts';

/**
 * D-29 「재개할 때 재판단된 등급이면 이전→이후 등급·사유를 이력에 기록」의 한 곳.
 * 실제 재개(M2-05 시도 시작)와 M2-08 `recordResumeRegrade`가 같은 함수를 쓴다.
 * 같은 등급 재개처럼 재판단이 아니면 아무것도 쓰지 않고 false를 돌려준다.
 * 이 모듈은 Runner 쪽에서도 읽으므로 policy/service.ts를 import하지 않는다(순환 방지).
 */
export async function writeResumeRegrade(client: PoolClient, task: { id: string; project_id: string; task_key: string }, attemptId: string, result: ResolveResult): Promise<boolean> {
  const entry = result.ok ? resumeRegradeEntry(task.task_key, result) : null;
  if (!entry) return false;
  // 이력 시각은 그 Task의 현재 버전보다 늦게 둔다(M2-02 `record`와 같은 규칙).
  await client.query(
    `insert into task_history(project_id,at,actor,task,kind,text,before,after,ref)
     values($1,greatest(clock_timestamp(),(select updated_at+interval '1 microsecond' from tasks where id=$2)),'시스템',$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
    [task.project_id, task.id, entry.kind, entry.text, JSON.stringify(entry.before), JSON.stringify(entry.after), JSON.stringify({ ...entry.ref, attemptId })],
  );
  deferChange(client, task.project_id, 'task', { taskKey: task.task_key });
  return true;
}
