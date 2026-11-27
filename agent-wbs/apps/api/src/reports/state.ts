import type { PoolClient } from '@awbs/db';
import { schedule as computeSchedule, ScheduleError, type ScheduleInput, type TaskStatus } from '@awbs/shared';
import { OWNER_ASSUME_RATE, OWNER_THRESHOLD_DAYS } from '../planning/schedule.ts';
import { caps as runnerCaps, wireCaps } from '../runner/service.ts';
import type { RunnerRepository } from '../runner/repository.ts';
import { wbsPaths } from '../tasks/wbs.ts';
import { FALLBACK_CURRENT, GLOBAL_TABLES, MIXED_TABLES, PROJECT_TABLES, type TrackedTable } from './tracked.ts';

/**
 * 보고서의 「그 시점」 자료(owner 2026-11-27 아이템 13, G L375 기간 말 재구성 · 재리뷰 2 원칙).
 *
 * 무엇을 어떻게 되살리나
 * - 보고서가 읽는 모든 표(tracked.ts TRACKED)는 행이 바뀔 때마다 이력(state_log·global_log, 마이그레이션 0028)에 남는다.
 * - 「T 전」은 **커밋 기준**이다. 이력 행을 쓴 트랜잭션의 커밋 시계 값과 실제 커밋 시각(commit_real, track_commit_timestamp)이
 *   모두 T보다 작은 것만 쓴다. 커밋 시계 값만 보면, 제약 트리거를 일찍 실행해(SET CONSTRAINTS ALL IMMEDIATE) 값을 먼저 받고
 *   늦게 커밋한 변경이 T 전으로 잘못 들어간다(재리뷰 3 문제 1).
 * - 실제 커밋 시각을 모르면(기록이 꺼져 있던 때) 지어내지 않는다. 그 커밋은 「커밋 시계 값 뒤, 정리가 처음 본 시각(observed_at) 전」에
 *   일어났다는 것만 안다. 그래서 관측 시각이 T 전이면 넣고, 커밋 시계 값이 T 뒤면 빼고, 그 사이면 **넣지 않고 「경계 불확실」로 센다**
 *   (스냅샷 basis.uncertain, 재리뷰 4 — 근거: reports/README.md).
 *   - 커밋 시계는 커밋 순서대로 단조 증가한다(PC 시계가 뒤로 가도 줄지 않는다).
 *   - 같은 행의 여러 기록 중에서는 순번(seq)이 가장 큰 것을 고른다. 같은 행의 변경은 행 잠금으로 차례가 정해지므로 순번 순서 = 커밋 순서다.
 * - 그 행을 jsonb_populate_record로 원래 표 모양으로 되돌린다(`rel`). 보고서 SQL은 표 이름 대신 이 관계식을 읽는다.
 *
 * 기준점과 「그때 = 나중」
 * - 보고서는 읽기 전에 기준점(awbs_report_anchor, 0029)을 잡는다. 그 뒤의 커밋은 모두 기준점보다 큰 값을 받으므로,
 *   T ≤ 기준점이면 「커밋 시계 < T」인 이력은 읽기 시작 전에 모두 확정돼 있다. 나중에 같은 T로 다시 읽어도 범위가 같다.
 *
 * source
 * - `log`(운영): 위 규칙. 정기(일간·주간)·기간 지정 모두 이것만 쓴다.
 * - `live`(시험 전용): 지금 표를 그대로 읽는다. 「그때 바로 찍은 값 = 나중에 되살린 값」을 시험으로 비교한다.
 *
 * 되살릴 수 없는 것
 * - 0028 전부터 있던 행은 마이그레이션 때 「seed」로 한 번 남았다. 그 커밋 시계보다 이른 T의 상태는 모른다 → `missing: ['state']`.
 * - 설정은 기록이 T 전에 없으면 묶음 버전(편집 시각)으로 「지금 값이 그때도 같았나」를 확인하고, 모르면 `basis.currentSettings`에 적는다.
 *
 * 경계 오차(문서 fix3.md §3)
 * - 커밋 시계 값은 greatest(직전 값 + 1µs, 지금 시각)이다. PC 시계가 d초 뒤로 가면 그 뒤 최대 d초 동안의 커밋은 벽시계보다 늦은 값을 받는다.
 *   그래서 자정 같은 경계 T 근처(최대 d초)의 커밋은 실제 벽시계 기준보다 늦은 쪽(다음 기간)으로 분류될 수 있다. 이 PC는 d≈2.3초다.
 *   이 오차는 「몇 번을 다시 만들어도 같은 결과」(결정성)에는 영향이 없다.
 */

export type StateSource = 'log' | 'live';
export type SettingTable = (typeof FALLBACK_CURRENT)[number];
/** 보고서가 「지금 값」을 쓴 설정 묶음(스냅샷 basis.currentSettings 값) */
export type SettingGroup = 'schedule' | 'blackouts' | 'heartbeat' | 'concurrency';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MICRO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface AsOf {
  /** T(이 커밋 시계 값 **전**까지). 마이크로초 6자리 UTC ISO */
  before: string;
  source: StateSource;
  /** 표 이름 → T 시점의 그 표(SQL 관계식) */
  rel: (table: TrackedTable) => string;
  /** SQL에 넣는 T(timestamptz 상수) */
  t: string;
}

const isGlobal = (table: string) => (GLOBAL_TABLES as readonly string[]).includes(table);
const isMixed = (table: string) => (MIXED_TABLES as readonly string[]).includes(table);
const isProject = (table: string) => (PROJECT_TABLES as readonly string[]).includes(table);

export function asOf(projectId: string, before: string, source: StateSource): AsOf {
  if (!UUID.test(projectId)) throw new Error('프로젝트 id 형식이 아닙니다.');
  // 정밀도를 줄이지 않는다: 마이크로초 6자리 문자열만 받는다(재리뷰 2 원칙 4).
  if (!MICRO.test(before)) throw new Error(`기준 시각은 마이크로초 6자리 UTC여야 합니다: ${before}`);
  const t = `'${before}'::timestamptz`;
  const latest = (log: 'state_log' | 'global_log', table: string) => `(select distinct on (l.row_id) l.op,l.data from public.${log} l
      join public.commit_real c on c.xid=l.xid where ${log === 'state_log' ? `l.project_id='${projectId}' and ` : ''}l.tbl='${table}' and c.stamp<${t} and coalesce(c.committed_at,c.observed_at)<${t}
      order by l.row_id,l.seq desc)`;
  const populate = (inner: string, table: string) => `(select r.* from ${inner} l cross join lateral jsonb_populate_record(null::public.${table},l.data) r where l.op<>'delete')`;
  return {
    before, source, t,
    rel: (table) => {
      if (!isProject(table) && !isGlobal(table) && !isMixed(table)) throw new Error(`기록 대상이 아닌 표: ${table}`);
      if (source === 'live') return `public.${table}`;
      if (isMixed(table)) return `(${populate(latest('state_log', table), table)} union all ${populate(latest('global_log', table), table)})`;
      return populate(latest(isGlobal(table) ? 'global_log' : 'state_log', table), table);
    },
  };
}

/**
 * 상태를 되살릴 수 있는 가장 이른 커밋 시계 값(0028 seed). null이면 처음부터 기록이 있다.
 * 프로젝트 이력과 전역 이력(실행 PC·설정) 중 이른 쪽이다(같은 마이그레이션 트랜잭션이라 보통 같다).
 */
export async function stateFrom(client: PoolClient, projectId: string): Promise<string | null> {
  const row = (await client.query<{ at: string | null }>(
    `select to_char(min(c.stamp) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at from (
       select xid from state_log where project_id=$1 and op='seed' union all select xid from global_log where op='seed') s join commit_real c on c.xid=s.xid`, [projectId])).rows[0];
  return row?.at ?? null;
}

/**
 * T 시점의 일정 계산. 계산 함수는 GET /api/schedule과 같은 shared `schedule()`이다.
 * 입력은 모두 T 시점 값이다(설정은 settingsAt 규칙).
 */
/**
 * T 시점 설정. 묶음마다 다음 순서로 정한다.
 * 1. T가 기록 시작 이후면 전역 이력(global_log)에서 되살린다(정확). 빈 DB에서 시작했으면 언제나 이 경우다.
 * 2. 업그레이드 전 시점(T < 기록 시작)이면 지금 표를 읽고, 묶음 버전(편집 시각)이 T 전이면 그때도 같은 값이었다(정확).
 * 3. 그것도 아니면 지금 값을 쓰고 그 묶음을 `current`에 넣는다(보고서가 「설정은 현재 값」으로 표시).
 */
export async function settingsAt(client: PoolClient, a: AsOf) {
  const q = <T extends object>(sql: string, args: unknown[] = []) => client.query<T>(sql, args).then((r) => r.rows);
  const current: SettingGroup[] = [];
  // 기록 시작(0028 업그레이드 표시) 이후의 T면 이력이 완전하다 → 이력만 읽는다(빈 표도 「그때 비어 있었다」).
  const start = a.source === 'log'
    ? (await q<{ at: string | null }>(`select min(c.stamp)::text at from global_log l join commit_real c on c.xid=l.xid where l.tbl='log_start'`))[0]?.at ?? null : null;
  const covered = a.source === 'live' || start === null
    || Boolean((await q<{ ok: boolean }>(`select $1::timestamptz<=${a.t} ok`, [start]))[0]?.ok);
  const logged = () => Promise.resolve(a.source === 'log' && covered);
  // 기록이 없을 때: 지금 표 + 「그때도 같았나」 확인식(SQL, T 전이면 참)
  const pick = async (table: SettingTable, group: SettingGroup, proof: string) => {
    if (await logged()) return a.rel(table);
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
  // 실행 PC 사양은 T 시점의 마지막 보고를 쓴다. 한도 계산은 실행 화면과 같은 함수(runner/service caps)다.
  const host = (await q(`select * from ${a.rel('runner_hosts')} h order by seen_at desc,created_at desc,id desc limit 1`))[0];
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
    `with t as materialized (select * from ${a.rel('tasks')} x), p as materialized (select * from ${a.rel('projects')} x),
       e as materialized (select distinct on (x.task) x.task,x.est,x.lo,x.hi from ${a.rel('task_estimates')} x order by x.task,x.created_at desc,x.id desc)
     select t.id,t.task_key,t.wbs_node_id,t.sort_order,t.status,t.priority,t.assignee_agent,t.conflict_group,to_char(greatest(t.fix_start,p.start_date),'YYYY-MM-DD') fix_start,
       ${isoAt('t.act_start')} act_start,${isoAt('t.act_end')} act_end,${isoAt('t.updated_at')} updated_at,e.est::text est,e.lo::text lo,e.hi::text hi
     from t join p on p.id=t.project_id left join e on e.task=t.id
     where t.project_id=$1 and t.deleted_at is null order by t.task_key`, [projectId]);
  // 의존성은 id만 읽고 위 Task 목록(삭제 제외)으로 키를 붙인다. 되살린 Task 관계식을 다시 조인하지 않는다(성능, 재리뷰 3 문제 3).
  const keyOf = new Map(tasks.map((t) => [t.id, t.task_key]));
  const deps = (await q<{ pred: string; succ: string; type: 'FS' | 'SS' }>(
    `select d.pred,d.succ,d.dep_type type from ${a.rel('task_dependencies')} d where d.project_id=$1 order by d.id`, [projectId]))
    .flatMap((d) => { const pred = keyOf.get(d.pred); const succ = keyOf.get(d.succ); return pred && succ ? [{ pred, succ, type: d.type }] : []; });
  const nodes = await q<{ id: string; kind: 'phase' | 'work_package'; parent_id: string | null; sort_order: number }>(`select id,kind,parent_id,sort_order from ${a.rel('wbs_nodes')} n where n.project_id=$1 order by n.id`, [projectId]);
  const sessions = await q<{ from: string; to: string | null; last: string }>(
    `select ${isoAt('started_at')} "from",${isoAt('ended_at')} "to",${isoAt('last_heartbeat_at')} last from ${a.rel('runner_sessions')} s order by started_at,id`);
  const usage = await q<{ agent: 'Claude' | 'Codex'; remain: string; reset_at: string }>(
    `select distinct on (agent) agent,remain_pct::text remain,${isoAt('reset_at')} reset_at from ${a.rel('agent_usage')} u order by agent,created_at desc,id desc`);
  const limit = (await q<{ limit: number }>(`select "limit" from ${a.rel('runner_concurrency_log')} c order by created_at desc,id desc limit 1`))[0]?.limit;
  const ratio = Number((await q<{ ratio: string | null }>(
    `select sum(case jsonb_typeof(subagents) when 'number' then (subagents#>>'{}')::numeric else coalesce((subagents->>'observed')::numeric,0) end)/nullif(sum(running),0) ratio
     from ${a.rel('runner_concurrency_log')} c where running>0 and created_at>=${a.t}-make_interval(days=>$1)`, [policy.windowDays]))[0]?.ratio ?? 0);
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
    `select id,v,expected,range from ${a.rel('schedule_baselines')} b where project_id=$1 order by v`, [projectId]);
  const last = baselines.at(-1);
  const items = last ? await q<{ task_key: string; end: string }>(
    `with t as materialized (select id,task_key from ${a.rel('tasks')} x), b as materialized (select * from ${a.rel('baseline_items')} x)
     select t.task_key,to_char(b."end" at time zone 'Asia/Seoul','YYYY-MM-DD') "end" from b join t on t.id=b.task where b.baseline=$1 order by t.task_key`, [last.id]) : [];
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

/**
 * 경계 불확실 건수: 실제 커밋 시각을 모르는 커밋 중, 커밋 시계 값은 T 전인데 관측 시각은 T 뒤라 T 전에 확정됐는지 알 수 없는 이력 행 수.
 * 이 행들은 T 시점 상태에 넣지 않았다(보수적). 그 프로젝트의 이력과 전역 이력을 함께 센다.
 */
export async function uncertainAt(client: PoolClient, projectId: string, a: AsOf): Promise<number> {
  if (a.source === 'live') return 0;
  const row = (await client.query<{ n: number }>(
    `select count(*)::int n from (select xid from state_log where project_id=$1 union all select xid from global_log) l join commit_real c on c.xid=l.xid
     where c.committed_at is null and c.stamp<${a.t} and c.observed_at>=${a.t}`, [projectId])).rows[0];
  return row?.n ?? 0;
}
