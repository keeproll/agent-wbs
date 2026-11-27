import type { Db } from '../project/db.ts';
import { deferChange } from '../changes/events.ts';

/** 호출자는 Runner 조정 잠금을 잡는다. 만료된 외부 작업도 reconcile이 끝날 때까지 열린 작업이다. */
export async function activeDesignApply(db: Db, projectId: string | null, driftId: string) {
  return (await db.query<{ id: string }>(`select id from runner_jobs where project_id=$1 and kind='design_apply' and payload->>'driftId'=$2
    and state in ('queued','leased','started','reconcile') order by created_at,id limit 1`, [projectId, driftId])).rows[0]?.id;
}

export async function linkDesignApply(db: Db, projectId: string | null, driftId: string, jobId: string) {
  await db.query("update design_drifts set resolution=resolution||jsonb_build_object('jobId',$3::text) where project_id=$1 and id::text=$2 and status='open'", [projectId, driftId, jobId]);
  deferChange(db, projectId, 'design', { id: driftId });
}
