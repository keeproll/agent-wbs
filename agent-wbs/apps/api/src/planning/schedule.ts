import type { PoolClient } from '@awbs/db';
import {
  displayKey, driftCheck, replan, schedule, ScheduleError, STAGE_PCT, type Agent, type Baseline, type ReplanResult, type ScheduleInput, type TaskStatus,
} from '@awbs/shared';
import { scheduleWarning } from '@awbs/shared/api';
import { TaskError } from '../tasks/errors.ts';
import { wbsPaths } from '../tasks/wbs.ts';
import { deferChange } from '../changes/events.ts';

const MOVE_LABEL = { delayed: '지연', advanced: '앞당김', new: '신규 편입', excluded: '제외' } as const;

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
  // task_estimates의 색인은 (project_id, task)다. 조건에 project_id를 함께 써야 Task마다 표 전체를 훑지 않는다(srv-perf: 5,000개에 0.6초 → 수 ms).
  const [now, tasks, deps, nodes, sessions, blackouts, caps, usage, heartbeat, runnerLimit, observed] = await Promise.all([
    client.query<{ now: string }>(`select ${isoAt('clock_timestamp()')} as now`),
    client.query<{ id: string; task_key: string; wbs_node_id: string; sort_order: number; status: TaskStatus; priority: number; assignee_agent: Agent | null;
      conflict_group: string | null; fix_start: string | null; act_start: string | null; act_end: string | null; updated_at: string; est: string | null; lo: string | null; hi: string | null }>(
      `select t.id,t.task_key,t.wbs_node_id,t.sort_order,t.status,t.priority,t.assignee_agent,t.conflict_group,to_char(t.fix_start,${ymd}) as fix_start,
              ${isoAt('t.act_start')} as act_start,${isoAt('t.act_end')} as act_end,${isoAt('t.updated_at')} as updated_at,e.est::text as est,e.lo::text as lo,e.hi::text as hi
         from tasks t left join lateral (select est,lo,hi from task_estimates where project_id=t.project_id and task=t.id order by created_at desc,id desc limit 1) e on true
        where t.project_id=$1 and t.deleted_at is null`, [projectId]),
    client.query<{ pred: string; succ: string; type: 'FS' | 'SS' }>(
      'select p.task_key as pred,s.task_key as succ,d.dep_type as type from task_dependencies d join tasks p on p.id=d.pred join tasks s on s.id=d.succ where d.project_id=$1 and p.deleted_at is null and s.deleted_at is null', [projectId]),
    client.query<{ id: string; kind: 'phase' | 'work_package'; parent_id: string | null; sort_order: number }>('select id,kind,parent_id,sort_order from wbs_nodes where project_id=$1', [projectId]),
    client.query<{ from: string; to: string | null; last: string }>(`select ${isoAt('started_at')} as from,${isoAt('ended_at')} as to,${isoAt('last_heartbeat_at')} as last from runner_sessions`),
    client.query<{ date: string }>(`select to_char(date,${ymd}) as date from blackout_days order by date`),
    client.query<{ caps: { total?: number; Claude?: number; Codex?: number } | null }>('select caps from concurrency_settings where singleton'),
    client.query<{ agent: Agent; remain: string; reset_at: string }>(`select distinct on (agent) agent,remain_pct::text as remain,${isoAt('reset_at')} as reset_at from agent_usage order by agent,created_at desc`),
    client.query<{ heartbeat_seconds: number; heartbeat_misses: number }>('select heartbeat_seconds,heartbeat_misses from app_settings where singleton'),
    // 상한 안에서 Runner가 조절해 보고한 현재 한도(G§6.2). 가장 최근 보고를 쓴다.
    client.query<{ limit: number }>('select "limit" from runner_concurrency_log order by created_at desc,id desc limit 1'),
    // 관측 하위 Agent 비율 = 관측 창 동안 실행 세션당 하위 Agent 수의 평균(G§6.2 「한도 ÷ (1 + 관측 하위 Agent 비율)」).
    // subagents는 보고의 하위 Agent 수(숫자) 또는 {observed}로 저장된다.
    client.query<{ ratio: string | null }>(
      `select sum(case jsonb_typeof(subagents) when 'number' then (subagents#>>'{}')::numeric else coalesce((subagents->>'observed')::numeric,0) end)/nullif(sum(running),0) as ratio
         from runner_concurrency_log where running>0 and created_at>=clock_timestamp()-make_interval(days=>$1)`, [policy.windowDays]),
  ]);
  const paths = wbsPaths(
    nodes.rows.map((node) => ({ id: node.id, kind: node.kind, parentId: node.parent_id, sortOrder: node.sort_order })),
    tasks.rows.map((task) => ({ id: task.id, wbsNodeId: task.wbs_node_id, sortOrder: task.sort_order, deleted: false })),
  );
  // shortcut: 동시 실행 상한이 아직 설정되지 않았으면(M2-08 설정 전) Agent별 1, 전체 2로 계산한다.
  const cap = caps.rows[0]?.caps ?? {};
  const total = cap.total ?? 2;
  // Runner 보고가 없을 때만 상한을 현재 한도로, 관측이 없을 때만 하위 Agent 비율 0으로 본다(P의 0.5는 Mock 값).
  const current = Math.min(total, runnerLimit.rows[0]?.limit ?? total);
  const subRatio = Number(observed.rows[0]?.ratio ?? 0);
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
    concurrency: { total, current, subRatio, Claude: cap.Claude ?? 1, Codex: cap.Codex ?? 1 },
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
  // 기준 버전은 「마지막 버전 + 1」이다. 입력과 기존 기준을 읽기 전에 프로젝트별로 줄을 세워야 두 재조정이 같은 버전을 만들지 않는다(리뷰 F2).
  // 그래프 잠금(CP 반영)을 잡은 호출도 있으므로 순서는 항상 그래프 → 재조정이다(이 잠금 뒤에 그래프 잠금을 잡지 않는다).
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`awbs:replan:${projectId}`]);
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
    // G§6.4: 재조정 기록과 함께 각 Task 이력에도 남긴다(리뷰 F4). 확정(applied)과 검토 대기(pending)를 글로 구분한다.
    // tasks/write.ts의 record와 같은 규칙(이력 시각 > Task 버전)이다. Task 조회(read.ts)가 이 모듈을 쓰므로 write.ts를 import하면 순환이 생겨 SQL을 직접 쓴다.
    const state = result.status === 'applied' ? `기준 v${String(result.baseline?.v ?? '')} 확정` : '검토 대기(기준 미반영)';
    const delta = move.delta === null ? '' : ` (${move.delta > 0 ? '+' : ''}${String(move.delta)}일)`;
    await client.query(
      `insert into task_history(project_id,at,actor,task,kind,text,before,after,ref)
       values($1,greatest(clock_timestamp(),(select updated_at+interval '1 microsecond' from tasks where id=$3)),$2,$3,'재조정',$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
      [projectId, result.actor, task, `${rpKey} ${result.trigger} — ${MOVE_LABEL[move.kind]}: 종료 ${move.before?.end ?? '없음'} → ${move.after?.end ?? '없음'}${delta}, ${state}`,
        move.before ? JSON.stringify(move.before) : null, move.after ? JSON.stringify(move.after) : null, JSON.stringify({ field: 'schedule', replanId: rpKey, status: result.status })]);
  }
  deferChange(client, projectId, 'schedule', { replanId: rpKey });
  return {
    replanId: rpKey, baselineVersion: result.baseline?.v ?? null, projectEnd: result.after, range: { lo: result.lo, hi: result.hi },
    moved: result.moves.map((move) => ({ taskKey: move.task, kind: move.kind, before: move.before?.end ?? null, after: move.after?.end ?? null, deltaDays: move.delta })),
  };
}

const dayNumber = (value: string) => Date.parse(`${value}T00:00:00Z`) / 86_400_000;
const days = (from: string, to: string) => dayNumber(to) - dayNumber(from);
const pct = (part: number, whole: number) => (whole ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0);
const SEOUL = 9 * 3_600_000;
const ymdSeoul = (instant: string) => new Date(Date.parse(instant) + SEOUL).toISOString().slice(0, 10);
const fractionOfDaySeoul = (instant: string) => ((Date.parse(instant) + SEOUL) % 86_400_000) / 86_400_000;

/** 일정 계산 실패(순환 등)는 409 SCHEDULE_CYCLE, 저장 데이터의 불변식 위반은 500이다(shared SCHEDULE_ERROR). */
function computeSchedule(input: ScheduleInput) {
  try {
    return schedule(input);
  } catch (error) {
    if (error instanceof ScheduleError && error.code === 'SCHEDULE_CYCLE') throw new TaskError('SCHEDULE_CYCLE', { path: error.taskIds });
    throw error;
  }
}

/**
 * GET /api/schedule(G§6.2·§6.4, P scheduleVM L4255~4282, 리뷰 F5). 계산은 M1 `schedule()`이고, 기준 대비 값은 마지막 기준(v)과 최초 기준(v1)으로 붙인다.
 * - 프로젝트 시작일은 프로젝트 등록일(Asia/Seoul)이다. 계획 진척(plannedPct)은 P와 같이 기준 구간의 경과 비율을 공수로 가중한다.
 * - calcVersion은 프로젝트 변경 이벤트 수다. 무엇이든 바뀌면 커지므로 화면이 낡은 계산을 알아챌 수 있다.
 */
export async function scheduleView(client: PoolClient, projectId: string) {
  const policy = await policyOf(client);
  const { input } = await scheduleInput(client, projectId, policy);
  const result = computeSchedule(input);
  const history = await baselines(client, projectId);
  const last = history.at(-1);
  const first = history[0];
  const [project, blackouts, version] = await Promise.all([
    client.query<{ start: string; target: string | null }>(
      `select to_char(created_at at time zone 'Asia/Seoul',${ymd}) as start,to_char(target_date,${ymd}) as target from projects where id=$1`, [projectId]),
    client.query<{ date: string; note: string }>(`select to_char(date,${ymd}) as date,note from blackout_days order by date`),
    client.query<{ n: number }>('select count(*)::int as n from change_events where project_id=$1', [projectId]),
  ]);
  const today = ymdSeoul(input.now);
  const nowFrac = fractionOfDaySeoul(input.now);
  const tasksIn = new Map(input.tasks.map((task) => [task.id, task]));
  let planned = 0;
  let doneHours = 0;
  const tasks = Object.entries(result.by).map(([taskKey, item]) => {
    const task = tasksIn.get(taskKey);
    const base = last?.items[taskKey];
    const ps = base?.start ?? item.start;
    const pe = base?.end ?? item.end;
    const est = task?.est ?? 0;
    planned += est * Math.min(1, Math.max(0, (days(ps, today) + nowFrac) / (days(ps, pe) + 1)));
    if (item.done) doneHours += est;
    return {
      taskKey, start: item.start, end: item.end, lo: item.lo, hi: item.hi, estHours: est, loHours: task?.lo ?? est, hiHours: task?.hi ?? est,
      progressPct: item.pct, started: Boolean(task?.actStart), done: item.done, isNew: !base,
      baselineStart: base?.start ?? null, baselineEnd: base?.end ?? null, slipDays: base ? days(base.end, item.end) : null,
      mid: item.mid, optimistic: item.optimistic, pessimistic: item.pessimistic,
    };
  });
  const p = result.project;
  const start = project.rows[0]?.start ?? today;
  const target = project.rows[0]?.target ?? null;
  const c = result.capacity;
  return {
    calcVersion: version.rows[0]?.n ?? 0,
    at: input.now,
    tasks,
    project: {
      start, end: p.end, lo: p.lo, hi: p.hi, baselineVersion: last?.v ?? 0, baselineEnd: last?.end ?? null, firstBaselineEnd: first?.end ?? null,
      target, slipDays: last ? days(last.end, p.end) : 0, slackDays: target ? days(p.end, target) : null,
      elapsedDays: Math.max(0, days(start, today)), remainingDays: days(today, p.end),
      totalHours: p.total, doneHours, remainHours: p.remain, progressPct: pct(p.progress, 100), plannedPct: pct(planned, p.total),
      doneRatePct: pct(p.doneRate, 100), doneHoursRatePct: pct(p.doneEstRate, 100), doneCount: p.doneN, taskCount: p.n,
    },
    capacity: { days: c.days, measured: c.measured, enough: c.enough, loggedHours: c.logged, rate: c.rate, rateLo: c.rLo, rateHi: c.rHi, todayRate: Math.min(1, c.todayRate) },
    blackouts: blackouts.rows,
    warnings: result.warnings.map(scheduleWarning),
  };
}

/** Task 목록·상세의 일정 요약(TaskSummary.schedule). 일정을 계산할 수 없으면 비어 있고(null 요약) Task 조회는 막지 않는다. */
export async function taskSchedules(client: PoolClient, projectId: string): Promise<Map<string, { estHours: number; loHours: number; hiHours: number; progressPct: number; end: string | null; baselineEnd: string | null }>> {
  try {
    const { input } = await scheduleInput(client, projectId, await policyOf(client));
    const result = schedule(input);
    const last = (await baselines(client, projectId)).at(-1);
    return new Map(input.tasks.map((task) => [task.id, {
      estHours: task.est, loHours: task.lo, hiHours: task.hi, progressPct: STAGE_PCT[task.status],
      end: result.by[task.id]?.end ?? null, baselineEnd: last?.items[task.id]?.end ?? null,
    }]));
  } catch (error) {
    if (error instanceof ScheduleError) return new Map();
    throw error;
  }
}
