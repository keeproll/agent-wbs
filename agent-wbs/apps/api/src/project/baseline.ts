import {
  DEFAULT_MEM_RESERVE_GB, effectiveCaps, recommendedCaps, replan,
  type Agent, type Dependency, type ScheduleInput, type ScheduleTask,
} from '@awbs/shared';
import { nextNumber, type Db } from './db.ts';
import { ProjectError } from './errors.ts';

/*
 * 초기 WBS 승인 때 만드는 기준 일정 v1(G§4.2 「승인하면 WBS가 되고 기준 일정 v1」, §6.4).
 * 계산은 M1-04의 replan()을 그대로 쓰고, 여기서는 DB 값을 그 입력으로 모으기만 한다.
 * 값이 없을 때 임의 기본값을 지어내지 않는다. PC 사양·가정 가동률이 없으면 승인을 멈추고 이유를 알린다.
 */

export interface BaselineTask extends Omit<ScheduleTask, 'cg'> { cg?: string; uuid: string }

async function concurrency(db: Db): Promise<ScheduleInput['concurrency']> {
  const host = (await db.query<{ cores: number; mem_gb: string; disk_gb: string; per_session_gb: string | null }>(
    'select cores,mem_gb,disk_gb,per_session_gb from runner_hosts order by seen_at desc,created_at desc limit 1')).rows[0];
  if (!host) {
    throw new ProjectError('INVALID_TRANSITION', { message: '실행 PC 사양 보고가 없어 기준 일정 v1의 동시 실행 수를 계산할 수 없습니다.',
      fix: 'Runner를 연결해 PC 사양을 보고한 뒤 다시 승인하세요.' });
  }
  const settings = (await db.query<{ mode: 'auto' | 'manual'; caps: { total: number; Claude: number; Codex: number; heavy: number } | null; mem_reserve_gb: string | null }>(
    'select mode,caps,mem_reserve_gb from concurrency_settings where singleton')).rows[0];
  // M2-05(runner/service.ts caps)와 같은 공식: PC 사양 추천값, 수동 모드면 팀장 상한(추천 이하).
  const recommended = recommendedCaps({ cores: host.cores, memGb: Number(host.mem_gb), diskGb: Number(host.disk_gb), perSessionGb: host.per_session_gb === null ? null : Number(host.per_session_gb) },
    Number(settings?.mem_reserve_gb ?? DEFAULT_MEM_RESERVE_GB)).caps;
  const manual = settings?.caps;
  const caps = effectiveCaps(settings?.mode ?? 'auto', manual ? { total: manual.total, perAgent: { Claude: manual.Claude, Codex: manual.Codex }, heavy: manual.heavy } : recommended, recommended).caps;
  const current = (await db.query<{ limit: number }>('select "limit" from runner_concurrency_log order by created_at desc limit 1')).rows[0]?.limit ?? caps.total;
  // 하위 Agent 비율은 저장된 관측값이 없어 0으로 둔다(보고서의 「계획과 다른 점」 참고).
  return { total: caps.total, current, subRatio: 0, Claude: caps.perAgent.Claude, Codex: caps.perAgent.Codex };
}

export async function scheduleInput(db: Db, tasks: readonly BaselineTask[], deps: readonly Dependency[]): Promise<ScheduleInput> {
  const policy = (await db.query<{ assume_rate: string | null; window_days: number; min_hours: number }>('select assume_rate,window_days,min_hours from schedule_policy where singleton')).rows[0];
  if (policy?.assume_rate == null) {
    throw new ProjectError('INVALID_TRANSITION', { message: '가정 가동률이 설정되지 않아 기준 일정 v1을 계산할 수 없습니다.',
      fix: '설정의 일정 정책에서 가정 가동률을 저장한 뒤 다시 승인하세요.' });
  }
  const heartbeat = (await db.query<{ heartbeat_seconds: number; heartbeat_misses: number }>('select heartbeat_seconds,heartbeat_misses from app_settings where singleton')).rows[0];
  const sessions = (await db.query<{ from: string; to: string | null; last: string }>(
    'select started_at::text as "from",ended_at::text as "to",last_heartbeat_at::text as last from runner_sessions order by started_at')).rows;
  const blackouts = (await db.query<{ d: string }>("select to_char(date,'YYYY-MM-DD') d from blackout_days order by date")).rows.map((row) => row.d);
  const usageRows = (await db.query<{ agent: Agent; remain: string; reset_at: string }>(
    'select distinct on (agent) agent,remain_pct as remain,reset_at::text from agent_usage order by agent,created_at desc')).rows;
  const iso = (value: string) => new Date(value).toISOString();
  return {
    now: new Date().toISOString(),
    tasks: tasks.map((task) => ({ id: task.id, wbs: task.wbs, status: task.status, priority: task.priority, assignee: task.assignee, est: task.est, lo: task.lo, hi: task.hi, ...(task.cg && { cg: task.cg }) })),
    deps,
    sessions: sessions.map((s) => ({ from: iso(s.from), ...(s.to && { to: iso(s.to) }), lastHeartbeatAt: iso(s.last) })),
    assumeRate: Number(policy.assume_rate),
    policy: { windowDays: policy.window_days, minHours: policy.min_hours },
    ...(heartbeat && { heartbeat: { intervalSec: heartbeat.heartbeat_seconds, missLimit: heartbeat.heartbeat_misses } }),
    blackouts,
    concurrency: await concurrency(db),
    usage: Object.fromEntries(usageRows.map((row) => [row.agent, { remain: Number(row.remain), resetAt: iso(row.reset_at) }])),
  };
}

/** 기준 일정 v1과 그 재조정 기록(RP-n)을 저장한다. 같은 트랜잭션에서 WBS를 만든 뒤 부른다. */
export async function createBaseline(db: Db, projectId: string, tasks: readonly BaselineTask[], deps: readonly Dependency[], actor: string): Promise<number> {
  const result = replan(await scheduleInput(db, tasks, deps), [], { trigger: '초기 WBS 승인', actor, autoReplan: true, manual: true });
  const baseline = result.baseline;
  if (!baseline) throw new Error('기준 일정이 만들어지지 않았습니다.');
  const id = (await db.query<{ id: string }>(
    'insert into schedule_baselines(project_id,v,expected,range,applied_rate) values($1,$2,$3::jsonb,$4::jsonb,$5) returning id',
    [projectId, baseline.v, JSON.stringify({ end: baseline.end, at: baseline.at, trigger: baseline.trigger, actor: baseline.actor }),
      JSON.stringify({ lo: baseline.lo, hi: baseline.hi, rLo: baseline.rLo, rHi: baseline.rHi }), baseline.rate])).rows[0]?.id;
  const uuidOf = new Map(tasks.map((task) => [task.id, task.uuid]));
  for (const [key, item] of Object.entries(baseline.items)) {
    await db.query('insert into baseline_items(project_id,task,baseline,start,"end",lo,hi) values($1,$2,$3,$4,$5,$6,$7)',
      [projectId, uuidOf.get(key), id, item.start, item.end, item.lo, item.hi]);
  }
  const rp = await nextNumber(db, projectId, 'replan', "select coalesce(max((substring(rp_key from 4))::bigint),0) from replans");
  const replanId = (await db.query<{ id: string }>(
    "insert into replans(project_id,rp_key,trigger,actor,baseline_v,status,before,after) values($1,$2,$3,$4,$5,'applied',$6::jsonb,$7::jsonb) returning id",
    [projectId, `RP-${String(rp).padStart(3, '0')}`, result.trigger, actor, baseline.v, JSON.stringify({ end: result.before }),
      JSON.stringify({ end: result.after, lo: result.lo, hi: result.hi, rate: result.rate })])).rows[0]?.id;
  for (const move of result.moves) {
    await db.query('insert into replan_moves(project_id,task,replan,kind,before,after) values($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
      [projectId, uuidOf.get(move.task), replanId, move.kind, move.before && JSON.stringify(move.before), move.after && JSON.stringify(move.after)]);
  }
  return baseline.v;
}
