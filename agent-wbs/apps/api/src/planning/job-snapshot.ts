import { createHash } from 'node:crypto';
import type { Db } from '../project/db.ts';
import { canonicalJson, judgedContent, subjectHash } from '../tasks/hash.ts';
import { loadSnapshot } from './snapshot.ts';

/** 기술 결정의 ID·상태·버전을 함께 고정한다. 반려도 초안의 전제이므로 뺄 수 없다. */
export async function techSnapshot(db: Db, projectId: string) {
  const techDecisions = (await db.query<{
    id: string; tdKey: string; title: string; status: 'fixed' | 'pending' | 'approved' | 'rejected' | 'noted' | 'change'; authority: 'lead' | 'agent' | 'free'; updatedAt: string; content: Record<string, unknown>;
  }>(`select id,td_key as "tdKey",title,status,authority,
      to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt",content
      from tech_decisions where project_id=$1 order by td_key for share`, [projectId])).rows;
  return { techDecisions, techDecisionVersion: snapshotHash(techDecisions) };
}

export const snapshotHash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** 판단 내용 계산과 작업 묶음·의존 관계 읽기는 CP 미리보기와 같은 함수를 쓴다. */
export async function wbsSnapshot(db: Db, projectId: string) {
  // Task를 바꾸는 요청은 먼저 Task 행을 잠근다. 여러 표를 읽는 동안 내용·상태가 섞이지 않게 같은 행을 잡는다.
  await db.query('select id from tasks where project_id=$1 and deleted_at is null order by id for share', [projectId]);
  const { snapshot, sources } = await loadSnapshot(db, projectId);
  const tasks = snapshot.tasks.map((task) => {
    const source = sources.get(task.id);
    if (!source) throw new Error(`Task 판단 내용 없음: ${task.id}`);
    const wp = snapshot.phases.flatMap((phase) => phase.wps).find((item) => item.tasks.includes(task.id))?.id;
    if (!wp) throw new Error(`Task 작업 묶음 없음: ${task.id}`);
    return { taskKey: task.id, wp, status: task.status, subjectHash: subjectHash(source), content: judgedContent(source) };
  });
  return { phases: snapshot.phases, tasks, dependencies: snapshot.dependencies };
}
