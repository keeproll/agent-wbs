import type { PoolClient } from '@awbs/db';

export interface PageFilter { taskKey?: string; result?: string; cursor?: string; limit?: number }
/** ID를 정렬·커서로 함께 써서 같은 시각에 기록된 행도 빠뜨리지 않는다. */
export async function verifications(client: PoolClient, query: PageFilter) {
  const rows = (await client.query(`select v.id,t.task_key "taskKey",a.id "attemptId",v.result,v.head_sha "headSha",v.spec_revision "specRevision",v.cmd,v.expected,v.actual,
    exists(select 1 from verification_invalidations i where i.verification=v.id) invalidated,
    to_char(v.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,
    coalesce((select jsonb_agg(jsonb_build_object('defKey',d.def_key,'text',d.content,'blocking',d.blocking,'resolved',exists(select 1 from defect_events e where e.defect=d.id and e.kind='resolved')) order by d.def_key) from defects d where d.verification=v.id),'[]') defects
    from verifications v join task_attempts a on a.id=v.attempt join tasks t on t.id=a.task where ($1::text is null or t.task_key=$1)
    and ($2::text is null or v.result::text=$2) and ($3::text is null or v.id::text>$3) order by v.id limit $4`, [query.taskKey ?? null,query.result ?? null,query.cursor ?? null,(query.limit ?? 50)+1])).rows;
  return page(rows,query.limit ?? 50);
}

export async function evidenceList(client: PoolClient, query: PageFilter) {
  const rows = (await client.query(`select e.id,t.task_key "taskKey",e.attempt "attemptId",coalesce(e.verification,v.id) "verificationId",cl.item_key "checklistItemKey",e.kind,e.sha256,e.size::float8 size
    from evidence e join tasks t on t.id=e.task left join verifications v on v.attempt=e.attempt
    left join lateral(select item_key from checklist_items where task=e.task and (id=e.checklist or evidence=to_jsonb(e.id::text)) order by item_key limit 1) cl on true
    where ($1::text is null or t.task_key=$1) and ($2::text is null or e.id::text>$2) order by e.id limit $3`, [query.taskKey ?? null,query.cursor ?? null,(query.limit ?? 50)+1])).rows;
  return page(rows,query.limit ?? 50);
}

export async function attempts(client: PoolClient, taskKey: string, query: PageFilter) {
  const rows = (await client.query(`select a.id,a.attempt_key "attemptKey",t.task_key "taskKey",a.kind,a.agent,a.status,
    to_char(a.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "startedAt",
    to_char(a.ended_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "endedAt",
    to_char(a.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "updatedAt",
    a.model_id "modelId",a.effort,a.grade_adjust "gradeAdjust",a.summary,a.failure->>'reason' failure,a.tokens::float8 tokens,a.resumed_from "resumedFrom",a.base_sha "baseSha",a.head_sha "headSha",
    coalesce((select jsonb_agg(path order by path) from attempt_files f where f.attempt=a.id),'[]') "changedFiles"
    from task_attempts a join tasks t on t.id=a.task where t.task_key=$1 and ($2::text is null or a.id::text>$2) order by a.id limit $3`, [taskKey,query.cursor ?? null,(query.limit ?? 50)+1])).rows;
  return page(rows,query.limit ?? 50);
}

function page(rows: Record<string, unknown>[], limit: number) {
  const items = rows.slice(0,limit);
  return { items,nextCursor:rows.length > limit ? items.at(-1)?.id ?? null : null };
}
