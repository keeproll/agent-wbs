import type { PoolClient } from '@awbs/db';
import { checkSplit, wbsNumbers } from '@awbs/shared';
import { loadSnapshot } from '../planning/snapshot.ts';
import { subjectHash } from '../tasks/hash.ts';
import { iso } from '../changes/events.ts';

/** G§5.2-1·P L6703: 완료·취소·삭제 Task를 빼고, 예외를 반영한 공통 판정으로 센다. */
export async function splitViolations(client: PoolClient) {
  const project = (await client.query<{ id: string }>('select id from projects')).rows[0]?.id;
  if (!project) return { count: 0, items: [] };
  const loaded = await loadSnapshot(client, project);
  const paths = wbsNumbers(loaded.snapshot.phases).task;
  const tasks = new Map(loaded.snapshot.tasks.map(task => [task.id, task]));
  const predecessors = new Map<string, typeof loaded.snapshot.tasks>();
  for (const dep of loaded.snapshot.dependencies) {
    const pred = tasks.get(dep.pred);
    if (pred) predecessors.set(dep.succ, [...predecessors.get(dep.succ) ?? [], pred]);
  }
  const items = loaded.snapshot.tasks.filter(t => !['done', 'cancelled'].includes(t.status)).flatMap(task => {
    const source = loaded.sources.get(task.id);
    const preds = predecessors.get(task.id) ?? [];
    const check = checkSplit(task, preds, source ? subjectHash(source) : null, loaded.settings);
    return check.violations || check.suspicions ? [{ taskKey: task.id, title: task.title, wbs: paths.get(task.id) ?? '', ...check }] : [];
  });
  return { count: items.length, items };
}

/** 설정 화면의 집계(P L6710~6716·L6763). 실제 사용은 관측으로 확인한 것만 센다(G§6.7-8). */
export async function agentUsage(client: PoolClient) {
  const lockedTasks = (await client.query(`select t.task_key "taskKey",t.title,g.role,
    case g.role when 'dev' then t.assignee_agent else t.verifier_agent end agent,g.model_id "modelId",g.effort
    from task_grades g join tasks t on t.id=g.task where g.locked and t.deleted_at is null and t.status not in ('done','cancelled') order by t.task_key,g.role`)).rows;
  const models = (await client.query(`select case g.role when 'dev' then t.assignee_agent else t.verifier_agent end agent,g.model_id "modelId",
    array_agg(distinct t.task_key order by t.task_key) "taskKeys" from task_grades g join tasks t on t.id=g.task
    where t.deleted_at is null and t.status not in ('done','cancelled') group by 1,2 order by 1,2`)).rows;
  const subagents = (await client.query(`select d.id,d.def_key "defKey",d.version,
    coalesce((select jsonb_agg(x.task_key order by x.task_key) from
      (select distinct t.task_key from task_subagents s join tasks t on t.id=s.task where s.subagent_id in(select id from subagent_defs where def_key=d.def_key) and t.deleted_at is null and t.status<>'cancelled') x),'[]') "taskKeys",
    last.task_key "lastTaskKey",last.attempt_key "lastAttemptKey",${iso('last.started_at')} "lastUsedAt",
    stats.decisions,stats.failures,case when stats.decisions=0 then null else stats.failures::float8/stats.decisions end "reworkRate"
    from (select distinct on(def_key) * from subagent_defs order by def_key,version desc) d
    left join lateral(select a.started_at,a.attempt_key,t.task_key from attempt_subagents s join task_attempts a on a.id=s.attempt join tasks t on t.id=a.task
      where s.subagent in(select id from subagent_defs where def_key=d.def_key) and s.observed_used is true order by a.record_no desc limit 1) last on true
    cross join lateral(select count(*)::int decisions,count(*) filter(where q.result='FAIL')::int failures from task_attempts a
      join lateral(select v.result from task_attempts qa left join verifications v on v.attempt=qa.id and not exists(select 1 from verification_invalidations i where i.verification=v.id)
        where qa.task=a.task and qa.attempt_no>a.attempt_no and qa.kind in ('qa','reverify') order by qa.attempt_no limit 1) q on true
      where exists(select 1 from attempt_subagents s join subagent_defs sd on sd.id=s.subagent where s.attempt=a.id and sd.def_key=d.def_key and s.observed_used is true)
      and a.kind in ('dev','rework') and q.result in ('PASS','FAIL')) stats
    order by d.def_key,d.version`)).rows;
  return { lockedTasks, models, subagents };
}
