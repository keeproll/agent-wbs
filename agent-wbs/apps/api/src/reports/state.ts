import type { PoolClient } from '@awbs/db';
import { schedule as computeSchedule, ScheduleError, type ScheduleInput, type TaskStatus } from '@awbs/shared';
import { policyOf, scheduleInput } from '../planning/schedule.ts';
import { wbsPaths } from '../tasks/wbs.ts';

/**
 * 보고서의 「그 시점」 자료(owner 2026-11-27 아이템 13, G L375 기간 말 재구성).
 *
 * 무엇을 어떻게 되살리나:
 * - 바뀌는 표(Task·체크리스트·산출물·의존성·등급·명세·시도·메시지·변경 제안·CI 실행·WBS·프로젝트)는
 *   상태 기록(state_log, 마이그레이션 0036)에서 시각 T **직전**의 마지막 행을 원래 표 모양으로 되돌린다(`rel`).
 * - 추가 전용 표(검증·결함·Evidence·추정·재조정·기준 일정 등)는 기록 시각이 T 전인 행만 쓴다.
 * - 끝 시각이 있는 기록(실행 PC 세션·알림)은 T 뒤에 끝난 것을 「T에는 아직 열림」으로 본다.
 *
 * source:
 * - `log`(운영): 위 규칙으로 되살린다. 정기(일간·주간)·기간 지정 모두 이것만 쓴다.
 * - `live`(시험 전용): 지금 표를 그대로 읽는다. 「그때 바로 찍은 값 = 나중에 되살린 값」을 시험으로 비교하는 데 쓴다.
 *
 * 되살릴 수 없는 것:
 * - 0036 전부터 있던 행은 마이그레이션 때 「seed」로 한 번 남았다. 그보다 이른 시점의 상태는 모른다 → `missing: ['state']`.
 * - 설정(일정 정책·작업 불가일·동시 실행 한도)은 기록하지 않아 지금 값을 쓴다. 이 값은 Task별 예상 날짜 계산에만 영향을 준다.
 */
export type StateSource = 'log' | 'live';
export const LOGGED_TABLES = [
  'projects', 'wbs_nodes', 'tasks', 'task_specs', 'task_dependencies', 'checklist_items', 'task_outputs', 'task_grades',
  'task_attempts', 'messages', 'change_proposals', 'ci_runs',
] as const;
export type LoggedTable = (typeof LOGGED_TABLES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AsOf {
  /** T(이 시각 **전**까지의 기록을 쓴다). UTC ISO */
  before: string;
  source: StateSource;
  /** 표 이름 → SQL 관계식(괄호로 묶은 하위 질의 또는 표 이름) */
  rel: (table: LoggedTable) => string;
  /** 추가 전용 표: 기록 시각이 T 전인 행 */
  added: (table: string, column?: string) => string;
  /** SQL에 넣는 T(timestamptz 상수) */
  t: string;
}

export function asOf(projectId: string, before: string, source: StateSource): AsOf {
  if (!UUID.test(projectId)) throw new Error('프로젝트 id 형식이 아닙니다.');
  const time = new Date(before);
  if (Number.isNaN(time.getTime())) throw new Error('시각 형식이 아닙니다.');
  // 마이크로초까지 보존한다(DB 시각과 같은 정밀도). 입력은 서버가 만든 ISO 문자열이다.
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(before) ? before : time.toISOString();
  const t = `'${iso}'::timestamptz`;
  return {
    before: iso, source, t,
    rel: (table) => (source === 'live' ? `public.${table}` : `(select r.* from (select distinct on (l.row_id) l.op,l.data from public.state_log l
      where l.project_id='${projectId}' and l.tbl='${table}' and l.created_at<${t} order by l.row_id,l.created_at desc,l.seq desc) l
      cross join lateral jsonb_populate_record(null::public.${table},l.data) r where l.op<>'delete')`),
    added: (table, column = 'created_at') => `(select * from public.${table} where ${column}<${t})`,
  };
}

/** 그 프로젝트의 상태를 되살릴 수 있는 가장 이른 시각(0036 seed). null이면 처음부터 기록이 있다. */
export async function stateFrom(client: PoolClient, projectId: string): Promise<string | null> {
  const row = (await client.query<{ at: string | null }>(
    `select to_char(min(created_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at from state_log where project_id=$1 and op='seed'`, [projectId])).rows[0];
  return row?.at ?? null;
}

/**
 * T 시점의 일정 계산. 계산 함수는 GET /api/schedule과 같은 shared `schedule()`이다.
 * 입력 중 Task·의존성·추정·세션·사용량·관측 비율·기준 일정은 T 시점 값, 설정(정책·불가일·한도·heartbeat)은 지금 값이다.
 */
export async function scheduleAt(client: PoolClient, projectId: string, a: AsOf) {
  const policy = await policyOf(client);
  const { input: current } = await scheduleInput(client, projectId, policy);
  const q = <T extends object>(sql: string, args: unknown[] = []) => client.query<T>(sql, args).then((r) => r.rows);
  const isoAt = (c: string) => `to_char(${c} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const tasks = await q<{ id: string; task_key: string; wbs_node_id: string; sort_order: number; status: TaskStatus; priority: number; assignee_agent: 'Claude' | 'Codex' | null;
    conflict_group: string | null; fix_start: string | null; act_start: string | null; act_end: string | null; updated_at: string; est: string | null; lo: string | null; hi: string | null }>(
    `select t.id,t.task_key,t.wbs_node_id,t.sort_order,t.status,t.priority,t.assignee_agent,t.conflict_group,to_char(greatest(t.fix_start,p.start_date),'YYYY-MM-DD') fix_start,
       ${isoAt('t.act_start')} act_start,${isoAt('t.act_end')} act_end,${isoAt('t.updated_at')} updated_at,e.est::text est,e.lo::text lo,e.hi::text hi
     from ${a.rel('tasks')} t join ${a.rel('projects')} p on p.id=t.project_id
     left join lateral(select est,lo,hi from ${a.added('task_estimates')} x where x.task=t.id order by created_at desc,id desc limit 1) e on true
     where t.project_id=$1 and t.deleted_at is null order by t.task_key`, [projectId]);
  const deps = await q<{ pred: string; succ: string; type: 'FS' | 'SS' }>(
    `select p.task_key pred,s.task_key succ,d.dep_type type from ${a.rel('task_dependencies')} d join ${a.rel('tasks')} p on p.id=d.pred join ${a.rel('tasks')} s on s.id=d.succ
     where d.project_id=$1 and p.deleted_at is null and s.deleted_at is null order by d.id`, [projectId]);
  const nodes = await q<{ id: string; kind: 'phase' | 'work_package'; parent_id: string | null; sort_order: number }>(`select id,kind,parent_id,sort_order from ${a.rel('wbs_nodes')} n where n.project_id=$1 order by n.id`, [projectId]);
  const sessions = await q<{ from: string; to: string | null; last: string }>(
    `select ${isoAt('started_at')} "from",case when ended_at<${a.t} then ${isoAt('ended_at')} end "to",${isoAt(`least(last_heartbeat_at,${a.t})`)} last from runner_sessions where started_at<${a.t}`);
  const usage = await q<{ agent: 'Claude' | 'Codex'; remain: string; reset_at: string }>(
    `select distinct on (agent) agent,remain_pct::text remain,${isoAt('reset_at')} reset_at from ${a.added('agent_usage')} u order by agent,created_at desc`);
  const limit = (await q<{ limit: number }>(`select "limit" from ${a.added('runner_concurrency_log')} c order by created_at desc,id desc limit 1`))[0]?.limit;
  const ratio = Number((await q<{ ratio: string | null }>(
    `select sum(case jsonb_typeof(subagents) when 'number' then (subagents#>>'{}')::numeric else coalesce((subagents->>'observed')::numeric,0) end)/nullif(sum(running),0) ratio
     from ${a.added('runner_concurrency_log')} c where running>0 and created_at>=${a.t}-make_interval(days=>$1)`, [policy.windowDays]))[0]?.ratio ?? 0);
  const paths = wbsPaths(nodes.map((n) => ({ id: n.id, kind: n.kind, parentId: n.parent_id, sortOrder: n.sort_order })),
    tasks.map((t) => ({ id: t.id, wbsNodeId: t.wbs_node_id, sortOrder: t.sort_order, deleted: false })));
  const input: ScheduleInput = {
    ...current,
    now: a.before,
    tasks: tasks.map((task) => {
      const est = task.est === null ? 0 : Number(task.est);
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
    deps,
    sessions: sessions.map((s) => ({ from: s.from, ...(s.to ? { to: s.to } : {}), lastHeartbeatAt: s.last })),
    concurrency: { ...current.concurrency, current: Math.min(current.concurrency.total, limit ?? current.concurrency.total), subRatio: ratio },
    usage: Object.fromEntries(usage.map((row) => [row.agent, { remain: Number(row.remain), resetAt: row.reset_at }])),
  };
  const baselines = await q<{ v: number; expected: { end?: string }; range: { lo: string; hi: string }; id: string }>(
    `select id,v,expected,range from ${a.added('schedule_baselines')} b where project_id=$1 order by v`, [projectId]);
  const last = baselines.at(-1);
  const items = last ? await q<{ task_key: string; end: string }>(
    `select t.task_key,to_char(b."end" at time zone 'Asia/Seoul','YYYY-MM-DD') "end" from ${a.added('baseline_items')} b join ${a.rel('tasks')} t on t.id=b.task where b.baseline=$1`, [last.id]) : [];
  const baseEnd = new Map(items.map((i) => [i.task_key, i.end]));
  let result;
  try { result = computeSchedule(input); } catch (error) {
    if (error instanceof ScheduleError || error instanceof RangeError) return null;
    throw error;
  }
  const day = (v: string) => Date.parse(`${v}T00:00:00Z`) / 86_400_000;
  return {
    project: { end: result.project.end, lo: result.project.lo, hi: result.project.hi, baselineVersion: last?.v ?? 0 },
    rate: result.capacity.rate,
    tasks: Object.entries(result.by).map(([taskKey, item]) => {
      const base = baseEnd.get(taskKey);
      const est = input.tasks.find((t) => t.id === taskKey)?.est ?? 0;
      return { taskKey, start: item.start, end: item.end, lo: item.lo, hi: item.hi, estHours: est, done: item.done, isNew: base === undefined,
        slipDays: base === undefined ? null : day(item.end) - day(base) };
    }),
  };
}
