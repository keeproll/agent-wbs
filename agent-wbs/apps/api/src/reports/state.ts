import type { PoolClient } from '@awbs/db';
import { schedule as computeSchedule, ScheduleError, type ScheduleInput, type TaskStatus } from '@awbs/shared';
import { OWNER_ASSUME_RATE, OWNER_THRESHOLD_DAYS } from '../planning/schedule.ts';
import { caps as runnerCaps, wireCaps } from '../runner/service.ts';
import type { RunnerRepository } from '../runner/repository.ts';
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
 * - 설정(일정 정책·작업 불가일·heartbeat·동시 실행 한도)은 0037부터 기록한다(project_id 없음). 기록이 T 전에 없으면
 *   설정 묶음별 버전(편집 시각)이 T 전인지로 「지금 값이 그때도 같았다」를 확인한다. 확인할 수 없으면 지금 값을 쓰고 `basis.currentSettings`에 적는다.
 */
export type StateSource = 'log' | 'live';
export const LOGGED_TABLES = [
  'projects', 'wbs_nodes', 'tasks', 'task_specs', 'task_dependencies', 'checklist_items', 'task_outputs', 'task_grades',
  'task_attempts', 'messages', 'change_proposals', 'ci_runs', 'replans',
] as const;
/** 프로젝트가 없는 설정 표(0037부터 기록) */
export const SETTING_TABLES = ['schedule_policy', 'blackout_days', 'app_settings', 'concurrency_settings'] as const;
export type SettingTable = (typeof SETTING_TABLES)[number];
/** 보고서가 「지금 값」을 쓴 설정 묶음(스냅샷 basis.currentSettings 값) */
export type SettingGroup = 'schedule' | 'blackouts' | 'heartbeat' | 'concurrency';
export type LoggedTable = (typeof LOGGED_TABLES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AsOf {
  /** T(이 시각 **전**까지의 기록을 쓴다). UTC ISO */
  before: string;
  source: StateSource;
  /** 표 이름 → SQL 관계식(괄호로 묶은 하위 질의 또는 표 이름) */
  rel: (table: LoggedTable) => string;
  /** 설정 표(project_id 없음)를 T 직전 상태로 */
  setting: (table: SettingTable) => string;
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
    setting: (table) => (source === 'live' ? `public.${table}` : `(select r.* from (select distinct on (l.row_id) l.op,l.data from public.state_log l
      where l.project_id is null and l.tbl='${table}' and l.created_at<${t} order by l.row_id,l.created_at desc,l.seq desc) l
      cross join lateral jsonb_populate_record(null::public.${table},l.data) r where l.op<>'delete')`),
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
/**
 * T 시점 설정. 묶음마다 다음 순서로 정한다.
 * 1. 상태 기록에 T 전 기록이 있으면 그것(정확).
 * 2. 없으면 지금 표. 묶음 버전(편집 시각)이 T 전이면 그때도 같은 값이었다(정확).
 * 3. 그것도 아니면 지금 값을 쓰고 그 묶음을 `current`에 넣는다(보고서가 「설정은 현재 값」으로 표시).
 */
export async function settingsAt(client: PoolClient, a: AsOf) {
  const q = <T extends object>(sql: string, args: unknown[] = []) => client.query<T>(sql, args).then((r) => r.rows);
  const current: SettingGroup[] = [];
  const logged = async (table: SettingTable) => a.source === 'log'
    && Boolean((await q(`select 1 from state_log where project_id is null and tbl=$1 and created_at<${a.t} limit 1`, [table])).length);
  // 기록이 없을 때: 지금 표 + 「그때도 같았나」 확인식(SQL, T 전이면 참)
  const pick = async (table: SettingTable, group: SettingGroup, proof: string) => {
    if (await logged(table)) return a.setting(table);
    if (a.source === 'log' && !(await q<{ ok: boolean }>(`select coalesce((${proof}),true) ok`))[0]?.ok) current.push(group);
    return `public.${table}`;
  };
  interface Policy { auto_replan: boolean | null; threshold_days: string | null; assume_rate: string | null; window_days: number | null; min_hours: string | null }
  const policyRel = await pick('schedule_policy', 'schedule', `select settings_version<${a.t} from schedule_policy where singleton`);
  const row = (await q<Policy>(`select auto_replan,threshold_days::text,assume_rate::text,window_days,min_hours::text from ${policyRel} p where singleton`))[0];
  const policy = {
    autoReplan: row?.auto_replan ?? false,
    thresholdDays: row?.threshold_days == null ? OWNER_THRESHOLD_DAYS : Number(row.threshold_days),
    assumeRate: row?.assume_rate == null ? OWNER_ASSUME_RATE : Number(row.assume_rate),
    windowDays: row?.window_days ?? 7, minHours: Number(row?.min_hours ?? 72),
  };
  const blackoutRel = await pick('blackout_days', 'blackouts', `select blackouts_version<${a.t} from app_settings where singleton`);
  const blackouts = (await q<{ date: string }>(`select to_char(date,'YYYY-MM-DD') date from ${blackoutRel} b order by date`)).map((r) => r.date);
  const appRel = await pick('app_settings', 'heartbeat', `select updated_at<${a.t} from app_settings where singleton`);
  const hb = (await q<{ heartbeat_seconds: number; heartbeat_misses: number }>(`select heartbeat_seconds,heartbeat_misses from ${appRel} s where singleton`))[0];
  // 동시 실행 설정 행이 T 뒤에 처음 만들어졌으면 T에는 없었다(기본값).
  const concRel = await pick('concurrency_settings', 'concurrency', `select coalesce(concurrency_version,created_at)<${a.t} or created_at>=${a.t} from concurrency_settings where singleton`);
  const concRows = await q<Record<string, unknown> & { created_at: Date }>(`select * from ${concRel} c where singleton`);
  const conc = concRows[0] && !(a.source === 'log' && concRel === 'public.concurrency_settings' && concRows[0].created_at.getTime() >= Date.parse(a.before)) ? concRows[0] : undefined;
  // 실행 PC 사양은 추가 전용 기록이라 T 전 마지막 보고를 쓴다. 한도 계산은 실행 화면과 같은 함수(runner/service caps)다.
  const host = (await q(`select * from ${a.added('runner_hosts')} h order by seen_at desc,created_at desc limit 1`))[0];
  const repo = { host: () => Promise.resolve(host), settings: () => Promise.resolve(conc) } as unknown as RunnerRepository;
  const manual = conc?.mode === 'manual' ? conc.caps as { total?: number; Claude?: number; Codex?: number } | null : null;
  const cap: { total?: number; Claude?: number; Codex?: number } = host ? wireCaps((await runnerCaps(repo)).caps) : manual ?? {};
  return { policy, blackouts, heartbeat: hb ? { intervalSec: hb.heartbeat_seconds, missLimit: hb.heartbeat_misses } : null, cap, current };
}

export async function scheduleAt(client: PoolClient, projectId: string, a: AsOf, settings?: Awaited<ReturnType<typeof settingsAt>>) {
  const set = settings ?? await settingsAt(client, a);
  const policy = set.policy;
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
  const total = set.cap.total ?? 2;
  const input: ScheduleInput = {
    now: a.before,
    assumeRate: policy.assumeRate,
    policy: { windowDays: policy.windowDays, minHours: policy.minHours },
    ...(set.heartbeat ? { heartbeat: set.heartbeat } : {}),
    blackouts: set.blackouts,
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
    concurrency: { total, current: Math.min(total, limit ?? total), subRatio: ratio, Claude: set.cap.Claude ?? 1, Codex: set.cap.Codex ?? 1 },
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
