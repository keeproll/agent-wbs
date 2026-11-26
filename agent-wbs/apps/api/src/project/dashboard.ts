import type { PoolClient } from '@awbs/db';
import { completionGate, DOMAINS, isBlocked, WORK_TYPES, type TaskStatus } from '@awbs/shared';
import { listAlerts } from '../changes/alerts.ts';
import { gateInputs } from '../execution/gate.ts';
import { attentionMessages } from '../messages/service.ts';
import { scheduleView } from '../planning/schedule.ts';
import { iso } from './db.ts';

/** P6274–6328: 계산과 Gate 판정은 기존 함수를 쓴다. 같은 읽기 트랜잭션에서 카드와 집계를 함께 읽는다. */
export async function dashboard(client: PoolClient) {
  const project = (await client.query<{ id: string }>('select id from projects')).rows[0];
  const tasks = (await client.query<{ id: string; taskKey: string; title: string; status: TaskStatus; work_type: string; primary_domain: string; verif_state: string }>(
    'select id,task_key "taskKey",title,status,work_type,primary_domain,verif_state from tasks where deleted_at is null order by task_key')).rows;
  const live = tasks.filter((t) => t.status !== 'cancelled');
  const deps = (await client.query<{ pred: string; succ: string; type: 'FS' | 'SS' }>('select pred,succ,dep_type type from task_dependencies')).rows;
  const blocked = new Set(live.filter((t) => isBlocked(tasks, deps, t.id)).map((t) => t.id));
  const schedule = project && tasks.length ? await scheduleView(client, project.id) : null;
  const approvals = (await client.query<{ id: string; title: string; unresolved: number }>(`select p.id,p.title,count(*)::int unresolved from plannings p join planning_reviews r on r.planning=p.id
    where r.kind in ('diff','이견') and r.choice is null group by p.id,p.title order by p.created_at,p.id`)).rows;
  const proposals = (await client.query<{ id: string; title: string; status: string }>("select id,title,status from change_proposals where deleted_at is null and status in ('review','changes','approved') order by created_at,id")).rows;
  const attempts = (await client.query<{ task: string; taskKey: string; title: string; attemptId: string; attemptKind: string; agent: string }>(`select a.task,t.task_key "taskKey",t.title,a.id "attemptId",a.kind "attemptKind",a.agent
    from task_attempts a join tasks t on t.id=a.task where a.status='running' and t.deleted_at is null and t.status<>'cancelled' order by a.created_at,a.id`)).rows;
  const verifications = (await client.query<{ task: string; id: string; result: string; defects: number }>(`select distinct on(a.task) a.task,v.id,v.result,
    (select count(*)::int from defects d where d.verification=v.id and not exists(select 1 from defect_events e where e.defect=d.id and e.kind='resolved')) defects
    from verifications v join task_attempts a on a.id=v.attempt order by a.task,a.attempt_no desc,v.id desc`)).rows;
  const verificationOf = new Map(verifications.map((v) => [v.task, v]));
  const gates = await gateInputs(client, live.filter((t) => t.status === 'gate' || t.verif_state === 'pass').map((t) => t.id));
  const recent = (await client.query(`select 'attempt' kind,${iso('coalesce(a.started_at,a.created_at)')} at,a.id,t.task_key "taskKey",a.agent,coalesce(a.summary,'') text,a.status,null result
    from task_attempts a join tasks t on t.id=a.task where t.deleted_at is null
    union all select 'verification',${iso('v.created_at')},v.id,t.task_key,a.agent,v.actual,null,v.result::text
    from verifications v join task_attempts a on a.id=v.attempt join tasks t on t.id=a.task where t.deleted_at is null
    order by at desc,id desc limit 8`)).rows.map((r) => r.kind === 'attempt'
    ? { kind: r.kind, at: r.at, id: r.id, taskKey: r.taskKey, agent: r.agent, text: r.text, status: r.status }
    : { kind: r.kind, at: r.at, id: r.id, taskKey: r.taskKey, agent: r.agent, text: r.text, result: r.result });
  // 개발·재작업 뒤 첫 QA의 PASS/FAIL만 판정 수에 넣는다. BLOCKED는 실패율 분모에서도 뺀다(P6320–6328).
  const grades = (await client.query<{ agent: string; modelId: string; effort: string; attempts: number; judged: number; fails: number; escalations: number; tokens: number }>(`select a.agent,a.model_id "modelId",a.effort,count(*)::int attempts,
    count(*) filter(where v.result in ('PASS','FAIL'))::int judged,count(*) filter(where v.result='FAIL')::int fails,
    count(*) filter(where a.grade_adjust->>'kind'='up')::int escalations,coalesce(sum(a.tokens),0)::float8 tokens
    from task_attempts a join tasks t on t.id=a.task left join lateral
      (select v.result from task_attempts q left join verifications v on v.attempt=q.id where q.task=a.task and q.attempt_no>a.attempt_no and q.kind in ('qa','reverify') order by q.attempt_no limit 1) v on true
    where a.kind in ('dev','rework') and t.deleted_at is null group by a.agent,a.model_id,a.effort order by a.agent,a.model_id,a.effort`)).rows;
  const ref = (t: { taskKey: string; title: string }) => ({ taskKey: t.taskKey, title: t.title });
  const byKey = new Map(tasks.map((t) => [t.taskKey, t]));
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  return {
    at: (await client.query<{ at: string }>(`select ${iso('clock_timestamp()')} at`)).rows[0]?.at,
    tasks: { total: live.length, done: live.filter((t) => t.status === 'done').length,
      active: live.filter((t) => ['running', 'qa', 'rework', 'verifying', 'gate'].includes(t.status)).length, blocked: blocked.size },
    byWorkType: WORK_TYPES.map((key) => ({ key, count: live.filter((t) => t.work_type === key).length })),
    byDomain: DOMAINS.map((key) => ({ key, count: live.filter((t) => t.primary_domain === key).length })),
    schedule: schedule ? { ...schedule.project, rate: schedule.capacity.rate } : null,
    panels: {
      late: (schedule?.tasks ?? []).flatMap((s) => {
        const t = byKey.get(s.taskKey);
        return t && t.status !== 'done' && ((s.slipDays ?? 0) > 0 || (!s.started && s.baselineStart !== null && s.baselineStart < today))
          ? [{ ...ref(t), baselineEnd: s.baselineEnd, end: s.end, slipDays: s.slipDays, paused: t.status === 'paused' }] : [];
      }).sort((a, b) => (b.slipDays ?? 0) - (a.slipDays ?? 0)),
      approvals: [...approvals.map((p) => ({ kind: 'planning', ...p })), ...proposals.map((p) => ({ kind: 'proposal', ...p }))],
      executions: [...attempts.map((a) => ({ kind: 'running', ...ref(a), attemptId: a.attemptId, attemptKind: a.attemptKind, agent: a.agent })),
        ...live.filter((t) => t.status === 'ready' && !blocked.has(t.id)).map((t) => ({ kind: 'ready', ...ref(t) }))],
      rework: live.filter((t) => t.status !== 'done' && (t.status === 'rework' || ['fail', 'blocked'].includes(t.verif_state))).map((t) => {
        const v = verificationOf.get(t.id);
        return { ...ref(t), verificationId: v?.id ?? null, result: v?.result ?? null, defects: v?.defects ?? 0 };
      }),
      gate: live.flatMap((t) => {
        const input = gates.get(t.id);
        return t.status !== 'done' && input ? [{ ...ref(t), unmet: completionGate(input).filter((c) => c.result !== 'PASS').map((c) => c.key) }] : [];
      }),
      messages: await attentionMessages(client),
    },
    recent,
    grades: grades.map((g) => ({ ...g, reworkRatePct: g.judged ? Math.round(g.fails / g.judged * 100) : null })),
    alerts: (await listAlerts(client)).items,
  };
}
