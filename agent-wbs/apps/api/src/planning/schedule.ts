import type { PoolClient } from '@awbs/db';
import {
  displayKey, driftCheck, replan, ScheduleError, type Agent, type Baseline, type ReplanResult, type ScheduleInput, type TaskStatus,
} from '@awbs/shared';
import { TaskError } from '../tasks/errors.ts';
import { wbsPaths } from '../tasks/wbs.ts';

/**
 * 일정 재조정(G§6.4, D-10). 일정 계산은 판정이므로 서버가 다시 계산한다(contracts §3.3).
 * owner 결정(open-questions §0, 2026-11-26): 가정 가동률 60%, 재조정 임계값 1일. seed에 값이 들어오기 전(null)에는 이 값을 쓴다.
 */
export const OWNER_ASSUME_RATE = 0.6;
export const OWNER_THRESHOLD_DAYS = 1;

interface Policy { autoReplan: boolean; thresholdDays: number; assumeRate: number; windowDays: number; minHours: number }

async function policyOf(client: PoolClient): Promise<Policy> {
  const row = (await client.query<{ auto_replan: boolean | null; threshold_days: string | null; assume_rate: string | null; window_days: number; min_hours: number }>(
    'select auto_replan,threshold_days::text,assume_rate::text,window_days,min_hours from schedule_policy where singleton')).rows[0];
  return {
    // G에 확정 근거가 없어 null로 둔 자동 재조정(data-model §5)은 「끔」으로 본다: 202 + pending(D-10).
    autoReplan: row?.auto_replan ?? false,
    thresholdDays: row?.threshold_days == null ? OWNER_THRESHOLD_DAYS : Number(row.threshold_days),
    assumeRate: row?.assume_rate == null ? OWNER_ASSUME_RATE : Number(row.assume_rate),
    windowDays: row?.window_days ?? 7,
    minHours: row?.min_hours ?? 72,
  };
}

const ymd = `'YYYY-MM-DD'`;
const isoAt = (column: string) => `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** 일정 계산 입력. 시각은 DB 시계 하나로 맞춘다. */
export async function scheduleInput(client: PoolClient, projectId: string, policy: Policy): Promise<{ input: ScheduleInput; ids: Map<string, string> }> {
  const [now, tasks, deps, nodes, sessions, blackouts, caps, usage, heartbeat] = await Promise.all([
    client.query<{ now: string }>(`select ${isoAt('clock_timestamp()')} as now`),
    client.query<{ id: string; task_key: string; wbs_node_id: string; sort_order: number; status: TaskStatus; priority: number; assignee_agent: Agent | null;
      conflict_group: string | null; fix_start: string | null; act_start: string | null; act_end: string | null; updated_at: string; est: string | null; lo: string | null; hi: string | null }>(
      `select t.id,t.task_key,t.wbs_node_id,t.sort_order,t.status,t.priority,t.assignee_agent,t.conflict_group,to_char(t.fix_start,${ymd}) as fix_start,
              ${isoAt('t.act_start')} as act_start,${isoAt('t.act_end')} as act_end,${isoAt('t.updated_at')} as updated_at,e.est::text as est,e.lo::text as lo,e.hi::text as hi
         from tasks t left join lateral (select est,lo,hi from task_estimates where task=t.id order by created_at desc,id desc limit 1) e on true
        where t.project_id=$1 and t.deleted_at is null`, [projectId]),
    client.query<{ pred: string; succ: string; type: 'FS' | 'SS' }>(
      'select p.task_key as pred,s.task_key as succ,d.dep_type as type from task_dependencies d join tasks p on p.id=d.pred join tasks s on s.id=d.succ where d.project_id=$1 and p.deleted_at is null and s.deleted_at is null', [projectId]),
    client.query<{ id: string; kind: 'phase' | 'work_package'; parent_id: string | null; sort_order: number }>('select id,kind,parent_id,sort_order from wbs_nodes where project_id=$1', [projectId]),
    client.query<{ from: string; to: string | null; last: string }>(`select ${isoAt('started_at')} as from,${isoAt('ended_at')} as to,${isoAt('last_heartbeat_at')} as last from runner_sessions`),
    client.query<{ date: string }>(`select to_char(date,${ymd}) as date from blackout_days order by date`),
    client.query<{ caps: { total?: number; Claude?: number; Codex?: number } | null }>('select caps from concurrency_settings where singleton'),
    client.query<{ agent: Agent; remain: string; reset_at: string }>(`select distinct on (agent) agent,remain_pct::text as remain,${isoAt('reset_at')} as reset_at from agent_usage order by agent,created_at desc`),
    client.query<{ heartbeat_seconds: number; heartbeat_misses: number }>('select heartbeat_seconds,heartbeat_misses from app_settings where singleton'),
  ]);
  const paths = wbsPaths(
    nodes.rows.map((node) => ({ id: node.id, kind: node.kind, parentId: node.parent_id, sortOrder: node.sort_order })),
    tasks.rows.map((task) => ({ id: task.id, wbsNodeId: task.wbs_node_id, sortOrder: task.sort_order, deleted: false })),
  );
  // shortcut: 동시 실행 상한이 아직 설정되지 않았으면(M2-08 설정 전) Agent별 1, 전체 2로 계산한다.
  const cap = caps.rows[0]?.caps ?? {};
  const total = cap.total ?? 2;
  const hb = heartbeat.rows[0];
  const input: ScheduleInput = {
    now: now.rows[0]?.now ?? new Date().toISOString(),
    tasks: tasks.rows.map((task) => {
      const est = task.est === null ? 0 : Number(task.est);
      // 완료인데 실제 시각이 없는 이전 데이터는 마지막 갱신 시각을 시작·종료로 본다(계산에만 쓰고 저장하지 않는다).
      const done = task.status === 'done';
      const actStart = task.act_start ?? (done ? task.updated_at : undefined);
      const actEnd = task.act_end ?? (done ? task.updated_at : undefined);
      return {
        id: task.task_key, wbs: paths.task.get(task.id) || task.task_key, status: task.status, priority: task.priority, assignee: task.assignee_agent ?? 'Claude',
        est, lo: task.lo === null ? est : Number(task.lo), hi: task.hi === null ? est : Number(task.hi),
        ...(task.conflict_group ? { cg: task.conflict_group } : {}), ...(task.fix_start ? { fixStart: task.fix_start } : {}),
        ...(actStart ? { actStart } : {}), ...(actEnd ? { actEnd } : {}),
      };
    }),
    deps: deps.rows,
    sessions: sessions.rows.map((s) => ({ from: s.from, ...(s.to ? { to: s.to } : {}), lastHeartbeatAt: s.last })),
    assumeRate: policy.assumeRate,
    policy: { windowDays: policy.windowDays, minHours: policy.minHours },
    ...(hb ? { heartbeat: { intervalSec: hb.heartbeat_seconds, missLimit: hb.heartbeat_misses } } : {}),
    blackouts: blackouts.rows.map((row) => row.date),
    concurrency: { total, current: total, subRatio: 0, Claude: cap.Claude ?? 1, Codex: cap.Codex ?? 1 },
    usage: Object.fromEntries(usage.rows.map((row) => [row.agent, { remain: Number(row.remain), resetAt: row.reset_at }])),
  };
  return { input, ids: new Map(tasks.rows.map((task) => [task.task_key, task.id])) };
}

async function baselines(client: PoolClient, projectId: string): Promise<Baseline[]> {
  const rows = (await client.query<{ id: string; v: number; at: string; expected: { end?: string; trigger?: string; actor?: string; rLo?: number; rHi?: number }; range: { lo: string; hi: string }; rate: string }>(
    `select id,v,${isoAt('created_at')} as at,expected,range,applied_rate::text as rate from schedule_baselines where project_id=$1 order by v`, [projectId])).rows;
  const items = (await client.query<{ baseline: string; task_key: string; start: string; end: string; lo: string; hi: string }>(
    `select b.baseline,t.task_key,to_char(b.start at time zone 'Asia/Seoul',${ymd}) as start,to_char(b."end" at time zone 'Asia/Seoul',${ymd}) as "end",
            to_char(b.lo at time zone 'Asia/Seoul',${ymd}) as lo,to_char(b.hi at time zone 'Asia/Seoul',${ymd}) as hi
       from baseline_items b join tasks t on t.id=b.task where b.project_id=$1`, [projectId])).rows;
  return rows.map((row) => ({
    v: row.v, at: row.at, trigger: row.expected.trigger ?? '', actor: row.expected.actor ?? '', rate: Number(row.rate),
    rLo: row.expected.rLo ?? Number(row.rate), rHi: row.expected.rHi ?? Number(row.rate), end: row.expected.end ?? row.range.hi, lo: row.range.lo, hi: row.range.hi,
    items: Object.fromEntries(items.filter((item) => item.baseline === row.id).map(({ task_key, start, end, lo, hi }) => [task_key, { start, end, lo, hi }])),
  }));
}

export interface ReplanSummary {
  replanId: string; baselineVersion: number | null; projectEnd: string; range: { lo: string; hi: string };
  moved: { taskKey: string; kind: string; before: string | null; after: string | null; deltaDays: number | null }[];
}

/**
 * 재조정을 계산하고 기록한다. 호출한 트랜잭션 안에서 실행되므로 CP 반영·추정과 같은 트랜잭션에 묶인다.
 * - `drift`: 기준과 임계값 이상 어긋날 때만 기록(G§6.4). 기준이 없으면 항상 기록한다.
 * - `policy`: Planning 재조정 요청. 자동 재조정 정책이 켜져 있으면 확정, 꺼져 있으면 pending(D-10).
 * - `manual`: 팀장 「재조정 실행」. 항상 다시 계산해 확정한다.
 */
export async function recordReplan(client: PoolClient, projectId: string, meta: { trigger: string; actor: string; mode: 'drift' | 'policy' | 'manual' }): Promise<ReplanSummary | null> {
  const policy = await policyOf(client);
  const { input, ids } = await scheduleInput(client, projectId, policy);
  const history = await baselines(client, projectId);
  let result: ReplanResult | null;
  try {
    result = meta.mode === 'drift'
      ? driftCheck(input, history, { thresholdDays: policy.thresholdDays, autoReplan: policy.autoReplan }, meta)
      : replan(input, history, { ...meta, autoReplan: policy.autoReplan, manual: meta.mode === 'manual' });
  } catch (error) {
    if (error instanceof ScheduleError && error.code === 'SCHEDULE_CYCLE') throw new TaskError('SCHEDULE_CYCLE', { path: error.taskIds });
    throw error;
  }
  if (!result) return null;
  const sequence = (await client.query<{ value: number }>(
    `insert into counters(project_id,kind,value) values($1,'replan',1)
     on conflict (project_id,kind) do update set value=counters.value+1 returning value::int as value`, [projectId])).rows[0]?.value ?? 1;
  const rpKey = displayKey('RP', sequence);
  const replanRow = (await client.query<{ id: string }>(
    'insert into replans(project_id,rp_key,trigger,actor,baseline_v,status,before,after) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) returning id',
    [projectId, rpKey, result.trigger, result.actor, result.baseline?.v ?? null, result.status,
      JSON.stringify({ end: result.before }), JSON.stringify({ end: result.after, lo: result.lo, hi: result.hi, rate: result.rate, warnings: result.warnings })])).rows[0];
  if (result.baseline) {
    const b = result.baseline;
    const baselineId = (await client.query<{ id: string }>(
      'insert into schedule_baselines(project_id,v,expected,range,applied_rate) values($1,$2,$3::jsonb,$4::jsonb,$5) returning id',
      [projectId, b.v, JSON.stringify({ end: b.end, trigger: b.trigger, actor: b.actor, rLo: b.rLo, rHi: b.rHi }), JSON.stringify({ lo: b.lo, hi: b.hi }), b.rate])).rows[0]?.id;
    for (const [taskKey, item] of Object.entries(b.items)) {
      const day = (value: string) => `${value}T00:00:00+09:00`;
      await client.query('insert into baseline_items(project_id,task,baseline,start,"end",lo,hi) values($1,$2,$3,$4,$5,$6,$7)',
        [projectId, ids.get(taskKey), baselineId, day(item.start), day(item.end), day(item.lo), day(item.hi)]);
    }
  }
  for (const move of result.moves) {
    const task = ids.get(move.task);
    // 기준에는 있었지만 지금은 지워진 Task의 제외 기록은 Task 행을 찾을 수 없어 요약(after)에만 남는다.
    if (!task) continue;
    await client.query('insert into replan_moves(project_id,task,replan,kind,before,after) values($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
      [projectId, task, replanRow?.id, move.kind, move.before ? JSON.stringify(move.before) : null, move.after ? JSON.stringify(move.after) : null]);
  }
  await client.query("insert into change_events(project_id,topic,ref) values($1,'schedule',$2::jsonb)", [projectId, JSON.stringify({ replanId: rpKey })]);
  return {
    replanId: rpKey, baselineVersion: result.baseline?.v ?? null, projectEnd: result.after, range: { lo: result.lo, hi: result.hi },
    moved: result.moves.map((move) => ({ taskKey: move.task, kind: move.kind, before: move.before?.end ?? null, after: move.after?.end ?? null, deltaDays: move.delta })),
  };
}
