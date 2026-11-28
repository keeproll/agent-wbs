import type { PoolClient } from '@awbs/db';

export interface PageFilter { taskKey?: string; result?: string; cursor?: string; limit?: number }
/** ID를 정렬·커서로 함께 써서 같은 시각에 기록된 행도 빠뜨리지 않는다. */
export async function verifications(client: PoolClient, query: PageFilter) {
  const rows = (await client.query(`select v.id,v.record_no::float8 seq,'V-'||substring(t.task_key from 6)||'-'||(select count(*) from verifications prev join task_attempts pa on pa.id=prev.attempt where pa.task=a.task and pa.attempt_no<=a.attempt_no) "verificationKey",t.task_key "taskKey",a.id "attemptId",v.result,v.head_sha "headSha",v.spec_revision "specRevision",v.cmd,v.expected,v.actual,
    exists(select 1 from verification_invalidations i where i.verification=v.id) invalidated,
    to_char(v.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,
    coalesce((select jsonb_agg(jsonb_build_object('defKey',d.def_key,'text',d.content,'blocking',d.blocking,'resolved',exists(select 1 from defect_events e where e.defect=d.id and e.kind='resolved')) order by d.def_key) from defects d where d.verification=v.id),'[]') defects
    from verifications v join task_attempts a on a.id=v.attempt join tasks t on t.id=a.task where ($1::text is null or t.task_key=$1)
    and ($2::text is null or v.result::text=$2) and ($3::text is null or v.id::text>$3) order by v.id limit $4`, [query.taskKey ?? null,query.result ?? null,query.cursor ?? null,(query.limit ?? 50)+1])).rows;
  return page(rows,query.limit ?? 50);
}

export async function evidenceList(client: PoolClient, query: PageFilter) {
  const rows = (await client.query(`select e.id,t.task_key "taskKey",e.attempt "attemptId",coalesce(e.verification,v.id) "verificationId",cl.item_key "checklistItemKey",e.kind,e.sha256,e.size::float8 size,
    case when e.reference_path is not null then e.reference_path end path
    from evidence e join tasks t on t.id=e.task left join verifications v on v.attempt=e.attempt
    left join lateral(select item_key from checklist_items where task=e.task and (id=e.checklist or evidence=to_jsonb(e.id::text) or evidence=to_jsonb(e.reference_path)) order by item_key limit 1) cl on true
    where ($1::text is null or t.task_key=$1) and ($2::text is null or e.id::text>$2) order by e.id limit $3`, [query.taskKey ?? null,query.cursor ?? null,(query.limit ?? 50)+1])).rows;
  return page(rows,query.limit ?? 50);
}

/**
 * 시도의 지정·실제 하위 Agent(UAT-TASK-10). 모두 실제 기록에서 읽는다. 없으면 빈 목록·null이다(지어내지 않음).
 * - designated: jobs/start 때 설치한 지정 정의(attempt_subagents.designated). 정의 ID와 그때 버전.
 * - used: Runner 사후 보고(attempt_subagent_usage). 보고가 없으면 null. 지정 정의 행의 confirm도 보고가 왔다는 표시다
 *   (빈 목록 보고). 확정도는 모든 이름 행과 보고가 confirmed일 때만 confirmed다. 일부 관측에서만 본 이름이 하나라도 있으면 partial(리뷰 Codex 3).
 * - observed: 마지막 출력 스트림 관측(attempt_observations). 관측 수가 있는 마지막 행의 수와 마지막 행의 상태.
 */
const ATTEMPT_SUBAGENTS = `jsonb_build_object(
      'designated',coalesce((select jsonb_agg(jsonb_build_object('id',d.def_key,'version',s.version) order by d.def_key)
        from attempt_subagents s join subagent_defs d on d.id=s.subagent where s.attempt=a.id and s.designated),'[]'),
      'used',(select case when count(*)=0 then null else jsonb_build_object(
          'confirm',case when bool_and(x.confirm='confirmed') then 'confirmed' else 'partial' end,
          'items',coalesce(jsonb_agg(jsonb_build_object('id',x.name,'version',x.version,'count',x.uses) order by x.builtin,x.name) filter (where x.name is not null),'[]')) end
        from (select u.name,u.version,u.uses,u.confirm,u.subagent is null builtin from attempt_subagent_usage u where u.attempt=a.id
          union all select null,null,null,s.confirm,null from attempt_subagents s where s.attempt=a.id and s.confirm is not null) x),
      'observed',(select jsonb_build_object('count',n.observed,'state',l.state)
        from (select o.observed from attempt_observations o where o.attempt=a.id and o.observed is not null order by o.record_no desc limit 1) n,
          (select o.state from attempt_observations o where o.attempt=a.id order by o.record_no desc limit 1) l))`;

export async function attempts(client: PoolClient, taskKey: string, query: PageFilter) {
  const rows = (await client.query(`select a.id,a.attempt_key "attemptKey",a.attempt_no "attemptNo",t.task_key "taskKey",a.kind,a.agent,a.status,
    to_char(a.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "startedAt",
    to_char(a.ended_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "endedAt",
    to_char(a.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "updatedAt",
    a.model_id "modelId",a.effort,a.grade_adjust "gradeAdjust",a.summary,a.failure->>'reason' failure,a.tokens::float8 tokens,a.resumed_from "resumedFrom",a.base_sha "baseSha",a.head_sha "headSha",
    coalesce((select jsonb_agg(path order by path) from attempt_files f where f.attempt=a.id),'[]') "changedFiles",
    ${ATTEMPT_SUBAGENTS} "subagents"
    from task_attempts a join tasks t on t.id=a.task where t.task_key=$1 and ($2::text is null or a.id::text>$2) order by a.id limit $3`, [taskKey,query.cursor ?? null,(query.limit ?? 50)+1])).rows;
  return page(rows,query.limit ?? 50);
}

function page(rows: Record<string, unknown>[], limit: number) {
  const items = rows.slice(0,limit);
  return { items,nextCursor:rows.length > limit ? items.at(-1)?.id ?? null : null };
}
