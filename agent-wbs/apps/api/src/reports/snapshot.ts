import type { PoolClient } from '@awbs/db';
import {
  blockers as blockersOf, blockedTasks, completionGate, daysBetween, periodBounds, seoulDay, seoulMidnight, addDays, STAGE_PCT, TASK_STATUSES, toMicro,
  type GateInput, type ReportKind, type ReportSnapshotData, type TaskStatus, type VerificationResult,
} from '@awbs/shared';
import { wbsPaths } from '../tasks/wbs.ts';
import { asOf, scheduleAt, settingsAt, stateFrom, uncertainAt, type StateSource } from './state.ts';
import { redact } from '../platform/redact.ts';

/**
 * 보고서 스냅샷 만들기(G§4.11 L371-396, P report L3800-3868, milestones §4.0).
 *
 * 무엇을 어느 시점으로 세나:
 * - 「기간 중 일어난 일」(완료·시작·시도·검증·메시지·재조정·중단)은 기록 시각이 [기간 시작, 기간 끝) 안에 있는 것만 센다.
 *   기간 끝은 다음 날 00:00(서울)과 생성 시각 중 이른 쪽이다(period.ts periodBounds).
 * - 「그 시점 상태」(상태 분포·진행 중·다음 예정·전체 표·완료 예상·Gate)는 **기간 끝 시점(T)**의 값을 상태 기록에서 되살린다(state.ts).
 *   T는 기간 끝(서울 종료일 다음 날 00:00, 그 직전까지)과 생성 시각 중 이른 쪽이다. owner 2026-11-27 아이템 13, G L375.
 *   정기(일간·주간)와 기간 지정이 같은 함수를 쓴다. 생성 시각이 기간 안이면 T=생성 시각이라 「지금 상태」와 같다.
 * - 되살릴 수 없는 시점(상태 기록이 시작되기 전)은 상태 칸을 비우고 `basis.missing`에 'state'를 적는다. 값을 지어내지 않는다.
 * - 생성한 뒤에는 다시 계산하지 않는다. 열 때는 저장한 값만 보인다(G L373).
 */
export interface SnapshotPeriod { kind: ReportKind; from: string; to: string; at: string }

type EndReason = ReportSnapshotData['gaps'][number]['reason'];
const END_REASONS: readonly EndReason[] = ['reboot', 'power_off', 'error', 'manual', 'unknown'];
const ACTIVE: readonly TaskStatus[] = ['running', 'paused', 'qa', 'rework', 'verifying', 'gate', 'failed'];
const iso = (column: string) => `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const ms = (value: string) => Date.parse(value);
const round1 = (n: number) => Math.round(n * 10) / 10;
const clampPct = (n: number) => Math.min(100, Math.max(0, n));
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
/** 메시지 본문 첫 줄(P msgDet L3858: 140자) */
const firstLine = (body: string) => (body.split('\n')[0] ?? '').slice(0, 140);

/** 원본 nextL(P L3838). 상태별 「다음 작업」 문구 */
function nextStep(status: TaskStatus, dev: string | null, qa: string | null): string {
  const a = dev ?? '담당 Agent';
  const v = qa ?? '검증 Agent';
  switch (status) {
    case 'running': return `${a} 개발 진행 → 완료 보고 후 ${v} QA`;
    case 'paused': return '중단된 시도 재개 대기 (Runner · 사용량 확인)';
    case 'qa': return `${v} QA 진행 → 결과에 따라 Gate 또는 재작업`;
    case 'rework': return `${a} 재작업 → ${v} 재검증`;
    case 'verifying': return `${v} 재검증 진행`;
    case 'gate': return 'Completion Gate 확인 후 완료 처리';
    case 'failed': return '실패 원인 확인 후 재실행';
    default: return '실행 대기';
  }
}

export async function buildSnapshot(client: PoolClient, projectId: string, period: SnapshotPeriod, source: StateSource = 'log'): Promise<ReportSnapshotData> {
  const { start, end } = periodBounds(period.from, period.to, period.at);
  // T: 이 시각 **전**까지 일어난 일과 그 시점 상태를 쓴다.
  const at = end;
  const src = asOf(projectId, end, source);
  const coverage0 = await stateFrom(client, projectId);
  const missing = source === 'log' && coverage0 !== null && at < coverage0;
  // 경계 비교는 마이크로초 문자열로 한다(정밀도를 줄이지 않는다, 재리뷰 2 원칙 4). DB 시각은 모두 6자리 UTC다.
  const inRange = (v: string | null | undefined) => !!v && toMicro(v) >= start && toMicro(v) < end;
  const upTo = (v: string | null | undefined) => !!v && toMicro(v) < at;

  // 한 연결에서 질의를 동시에 보내지 않는다(pg는 한 연결의 동시 질의를 차례로 줄 세우며, 그 방식은 다음 판에서 없어진다). 앞 질의가 끝난 뒤 다음을 보낸다.
  let chain: Promise<unknown> = Promise.resolve();
  const q = <T extends object>(sql: string, args: unknown[] = []): Promise<T[]> => {
    const next = chain.then(() => client.query<T>(sql, args)).then((r) => r.rows);
    chain = next.catch(() => undefined);
    return next;
  };
  const [project, tasks, nodes, deps, attempts, verifs, defects, evidence, messages, replans, moves, sessions, alerts, proposals, checklist, outputs, grades] = await Promise.all([
    // 통합(M6-01×M6-02): 목표일은 T 시점(되살린 관계식, M6-01), 이름은 **생성 시점** 이름(M6-02 조정자 7 「보고서·PDF 제목은 스냅샷 값」).
    // 이름을 T 시점 값으로 바꾸지 않는다: 제목은 「만든 때 이름」이라는 M6-02 계약이고, 0030(옛 0047) 이름 채움도 같은 기준이다.
    // 생성 시점 이름은 지금 프로젝트 행에서 읽는다(기간 끝 재구성 대상이 아니다). 보고서 계산이 기록 대상 표를 직접 읽는 유일한 예외다.
    // 왜 이력이 아닌가: 초기화하면 프로젝트 이력(state_log)이 지워져 새 프로젝트의 행이 이력에 없을 수 있다(reports 시나리오 빈 상태).
    // 시험(reports-history 「이력 표만 읽는다」)은 이 한 곳만 NAME_SOURCE로 허용한다.
    q<{ target: string | null; name: string | null }>(`select (select to_char(target_date,'YYYY-MM-DD') from ${src.rel('projects')} p where id=$1) target,
      (select name from public.projects where id=$1) name`, [projectId]),
    q<{ id: string; key: string; title: string; status: TaskStatus; work_type: string; domain: string; assignee: 'Claude' | 'Codex'; verifier: 'Claude' | 'Codex';
      verif_state: string; act_start: string | null; act_end: string | null; cg: string | null; done_cond: string | null; wbs_node_id: string; sort_order: number; est: string | null }>(
      // 각 관계식은 한 번만 되살린다(CTE MATERIALIZED). 통계가 낡아도 Task마다 다시 되살리는 계획이 나오지 않게 한다(재리뷰 3 문제 3).
      `with t as materialized (select * from ${src.rel('tasks')} x), s as materialized (select task,overview from ${src.rel('task_specs')} x),
         e as materialized (select distinct on (x.task) x.task,x.est from ${src.rel('task_estimates')} x order by x.task,x.record_no desc)
       select t.id,t.task_key key,t.title,t.status,t.work_type,t.primary_domain domain,t.assignee_agent assignee,t.verifier_agent verifier,t.verif_state,
        ${iso('t.act_start')} act_start,${iso('t.act_end')} act_end,t.conflict_group cg,s.overview->>'doneCond' done_cond,t.wbs_node_id,t.sort_order,e.est::text est
       from t left join s on s.task=t.id left join e on e.task=t.id
       where t.project_id=$1 and t.deleted_at is null and t.status<>'cancelled' and not $2::boolean order by t.task_key`, [projectId, missing]),
    q<{ id: string; kind: 'phase' | 'work_package'; parent_id: string | null; sort_order: number }>(`select id,kind,parent_id,sort_order from ${src.rel('wbs_nodes')} n where project_id=$1 order by id`, [projectId]),
    q<{ pred: string; succ: string; type: 'FS' | 'SS' }>(`select pred,succ,dep_type type from ${src.rel('task_dependencies')} d where project_id=$1 order by id`, [projectId]),
    q<{ id: string; task: string; key: string; no: number; kind: 'dev' | 'qa' | 'rework' | 'reverify'; agent: 'Claude' | 'Codex'; status: 'running' | 'completed' | 'failed' | 'interrupted';
      started_at: string; ended_at: string | null; model_id: string; effort: string; adjust: ReportSnapshotData['attempts'][number]['adjust']; summary: string | null; tokens: string | null; files: number }>(
      `select a.id,a.task,a.attempt_key key,a.attempt_no no,a.kind,a.agent,a.status,${iso('a.started_at')} started_at,${iso('a.ended_at')} ended_at,a.model_id,a.effort,
        a.grade_adjust adjust,a.summary,a.tokens::text tokens,(select count(*)::int from ${src.rel('attempt_files')} f where f.attempt=a.id) files
       from ${src.rel('task_attempts')} a where a.project_id=$1 order by a.started_at,a.attempt_no,a.id`, [projectId]),
    // 검증 시각: QA 시도가 끝난 시각(없으면 기록 시각). 검증 결과는 시도 종료와 함께 보고된다(contracts §3.5).
    q<{ id: string; attempt: string; task: string; agent: 'Claude' | 'Codex'; result: 'PASS' | 'FAIL' | 'BLOCKED'; cmd: string; expected: string; actual: string; at: string; no: number }>(
      `select v.id,v.attempt,a.task,a.agent,v.result,v.cmd,v.expected,v.actual,${iso('coalesce(a.ended_at,v.created_at)')} at,a.attempt_no no
       from ${src.rel('verifications')} v join ${src.rel('task_attempts')} a on a.id=v.attempt where v.project_id=$1 order by coalesce(a.ended_at,v.created_at),v.id`, [projectId]),
    q<{ verification: string; text: string; blocking: boolean }>(`select verification,def_key||' '||content text,blocking from ${src.rel('defects')} d where project_id=$1 order by def_key`, [projectId]),
    q<{ verification: string; path: string }>(`select verification,coalesce(reference_path,storage_path) path from ${src.rel('evidence')} e where project_id=$1 and verification is not null order by created_at,id`, [projectId]),
    q<{ key: string; task: string; dir: 'in' | 'out'; type: string; to_agent: 'Claude' | 'Codex' | null; from_agent: 'Claude' | 'Codex' | null; body: string; delivery: string | null; pending_next: boolean; at: string }>(
      `select msg_key key,task,dir,type,to_agent,from_agent,body,delivery::text delivery,pending_next,${iso('created_at')} at from ${src.rel('messages')} m where project_id=$1 and not draft order by created_at,id`, [projectId]),
    q<{ id: string; key: string; trigger: string; baseline_v: number | null; before: { end?: unknown }; after: { end?: unknown; lo?: unknown; hi?: unknown }; at: string }>(
      `select id,rp_key key,trigger,baseline_v,before,after,${iso('created_at')} at from ${src.rel('replans')} r where project_id=$1 and status='applied' order by created_at,id`, [projectId]),
    q<{ replan: string; task: string; kind: 'delayed' | 'advanced' | 'new' | 'excluded'; before: { end?: unknown } | null; after: { end?: unknown } | null }>(
      `select replan,task,kind,before,after from ${src.rel('replan_moves')} m where project_id=$1 order by created_at,id`, [projectId]),
    // 실행 PC 세션·알림도 T 시점 행이다(끝 시각·해소 시각·본문 모두 그때 값, 재리뷰 2 문제 3).
    q<{ from: string; to: string | null; reason: string | null }>(`select ${iso('started_at')} "from",${iso('ended_at')} "to",end_reason reason
      from ${src.rel('runner_sessions')} s order by started_at,id`),
    q<{ key: string; target: Record<string, unknown> | null; at: string; resolved: string | null }>(
      `select key,target,${iso('created_at')} at,${iso('resolved_at')} resolved from ${src.rel('alerts')} x where project_id=$1 or project_id is null order by created_at,id`, [projectId]),
    q<{ key: string; title: string; status: string; at: string }>(
      `select cp_key key,title,status,${iso('created_at')} at from ${src.rel('change_proposals')} c where project_id=$1 and deleted_at is null and status in ('review','changes','held') order by created_at,id`, [projectId]),
    q<{ task: string; required: boolean; done: boolean }>(`select task,required,done from ${src.rel('checklist_items')} c where project_id=$1 order by task,sort_order,id`, [projectId]),
    q<{ task: string; name: string; delivered: boolean }>(`select task,name,delivered from ${src.rel('task_outputs')} o where project_id=$1 order by name,id`, [projectId]),
    q<{ task: string; model_id: string; effort: string }>(`select task,model_id,effort from ${src.rel('task_grades')} g where project_id=$1 and role='dev' order by task`, [projectId]),
  ]);

  const paths = wbsPaths(
    nodes.map((n) => ({ id: n.id, kind: n.kind, parentId: n.parent_id, sortOrder: n.sort_order })),
    tasks.map((t) => ({ id: t.id, wbsNodeId: t.wbs_node_id, sortOrder: t.sort_order, deleted: false })),
  ).task;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rel = (t: (typeof tasks)[number]) => ({ taskKey: t.key, wbsPath: paths.get(t.id) ?? '', title: t.title });
  const actors = (t: (typeof tasks)[number]) => ({ assignee: t.assignee, verifier: t.verifier });
  const est = (t: (typeof tasks)[number]) => (t.est === null ? 0 : Number(t.est));

  // 일정(T 시점). 순환 같은 일정 오류가 있어도 보고서는 만든다(일정 칸만 비운다).
  const settings = await settingsAt(client, src);
  const schedule = tasks.length ? await scheduleAt(client, projectId, src, settings) : null;
  const plan = new Map((schedule?.tasks ?? []).map((s) => [s.taskKey, s]));

  // 의존성: 공유 판정 함수(blockers)를 그대로 쓴다. 삭제·취소된 Task는 선행 조건에서 빠진다.
  const domainTasks = tasks.map((t) => ({ id: t.id, status: t.status }));
  const liveDeps = deps.filter((d) => byId.has(d.pred) && byId.has(d.succ));
  const blocked = blockedTasks(domainTasks as never, liveDeps);
  const blockersFor = (id: string) => blockersOf(domainTasks as never, liveDeps, id).map((d) => {
    const pred = byId.get(d.pred);
    return { pred: pred?.key ?? '', type: d.type, status: pred?.status ?? 'ready' };
  });

  const attemptsOf = (taskId: string) => attempts.filter((a) => a.task === taskId && upTo(a.started_at));
  const lastVerification = (taskId: string) => {
    const v = verifs.filter((x) => x.task === taskId && upTo(x.at)).at(-1);
    return v ? { id: v.id, result: v.result, cmd: v.cmd, actual: v.actual } : null;
  };
  const checklistOf = (taskId: string) => {
    const items = checklist.filter((c) => c.task === taskId);
    return { done: items.filter((c) => c.done).length, total: items.length, requiredLeft: items.filter((c) => c.required && !c.done).length };
  };
  const gradeOf = (a: { model_id: string; effort: string } | undefined) => (a ? { modelId: a.model_id, effort: a.effort } : null);
  const slipOf = (key: string) => {
    const s = plan.get(key);
    return s && !s.isNew ? s.slipDays : null;
  };

  // 1. 핵심 지표 · 상태 분포
  const totalEst = tasks.reduce((sum, t) => sum + est(t), 0) || 1;
  const workPct = (list: typeof tasks) => clampPct(Math.round((list.reduce((sum, t) => sum + est(t), 0) / totalEst) * 1000) / 10);
  const doneTo = tasks.filter((t) => upTo(t.act_end));
  const doneFrom = tasks.filter((t) => t.act_end && toMicro(t.act_end) < start);
  const rpsUpTo = replans.filter((r) => upTo(r.at));
  const last = rpsUpTo.at(-1);
  const before = replans.filter((r) => toMicro(r.at) < start).at(-1);
  const endOf = (r: (typeof replans)[number] | undefined) => (r && isDate(r.after.end) ? r.after.end : null);
  const inAtts = attempts.filter((a) => inRange(a.started_at));
  const inVerifs = verifs.filter((v) => inRange(v.at));

  // 9. 작업 환경 중단 · 가동률(P uptime L3790)
  const coverage = (a: number, b: number) => {
    let on = 0;
    const gaps: ReportSnapshotData['gaps'] = [];
    sessions.forEach((s, i) => {
      const f = ms(s.from);
      const t = s.to ? ms(s.to) : b;
      on += Math.max(0, Math.min(b, t) - Math.max(a, f));
      const next = sessions[i + 1];
      if (s.to) {
        const gFrom = ms(s.to);
        const gTo = next ? ms(next.from) : b;
        const x = Math.max(a, gFrom);
        const y = Math.min(b, gTo);
        if (y > x) {
          gaps.push({ from: s.to, to: next ? next.from : null, minutes: Math.round((y - x) / 60_000),
            reason: END_REASONS.includes(s.reason as EndReason) ? s.reason as EndReason : 'unknown' });
        }
      }
    });
    return { pct: b > a ? Math.round((on / (b - a)) * 100) : 0, gaps };
  };
  const up = coverage(ms(start), ms(end));

  // 2. 팀장 확인 필요(P issues L3810-3814)
  const issues: ReportSnapshotData['issues'] = [];
  // 그 시점에 열려 있던 알림: T 시점 행에서 해소 시각이 비어 있다(해소가 T 뒤에 커밋됐으면 T 시점 행에는 없다).
  for (const a of alerts.filter((x) => !x.resolved)) {
    const target = a.target ?? {};
    const text = typeof target.message === 'string' && target.message.trim() ? target.message : a.key;
    const taskKey = typeof target.taskKey === 'string' && /^TASK-\d{4,}$/.test(target.taskKey) ? target.taskKey : null;
    issues.push({ level: 'warn', text, taskKey });
  }
  // held는 자동 반영이 막혀 보류된 제안이다(planning/routes.ts). 원본 문구로 검토 대기와 구분한다(P L3812).
  // 그 시점에 있던 제안인지는 상태 기록이 정한다(rel). 행의 created_at은 고칠 수 없는 등록 시각이라 다시 거르지 않는다.
  for (const p of proposals) {
    issues.push({ level: 'info', text: `${p.key} Change Proposal ${p.status === 'held' ? '자동 반영 보류' : '검토 대기'} — ${p.title}`, taskKey: null });
  }
  for (const m of messages.filter((x) => x.dir === 'out' && upTo(x.at) && (x.delivery === 'Failed' || x.delivery === 'Queued' || x.pending_next))) {
    const t = byId.get(m.task);
    if (!t) continue;
    issues.push({ level: m.delivery === 'Failed' ? 'bad' : 'info', text: `메시지 ${m.key} ${m.delivery === 'Failed' ? '전달 실패' : '전달 대기'} (${t.key})`, taskKey: t.key });
  }
  for (const t of tasks.filter((x) => x.status === 'rework' && verifs.some((v) => v.task === x.id && v.result === 'FAIL' && upTo(v.at)))) {
    issues.push({ level: 'warn', text: `${t.key} 재작업 필요 — ${t.title}`, taskKey: t.key });
  }

  // 3. 일별 추세(주간 · 기간만, P series L3815-3820)
  const series: ReportSnapshotData['series'] = [];
  if (period.kind !== 'daily') {
    for (let day = period.from; day <= period.to; day = addDays(day, 1)) {
      const a = seoulMidnight(day);
      const next = seoulMidnight(addDays(day, 1));
      const b = next < at ? next : at;
      const inDay = (v: string | null) => !!v && toMicro(v) >= a && toMicro(v) < b;
      series.push({
        day, done: tasks.filter((t) => inDay(t.act_end)).length, attempts: attempts.filter((x) => inDay(x.started_at)).length,
        fails: verifs.filter((v) => v.result === 'FAIL' && inDay(v.at)).length, uptimePct: b > a ? coverage(ms(a), ms(b)).pct : 0,
        forecast: endOf(replans.filter((r) => toMicro(r.at) < b).at(-1)),
      });
    }
  }

  // 4. 완료한 Task
  const durationHours = (taskId: string) => attemptsOf(taskId).reduce((sum, a) => sum + (a.ended_at ? Math.max(0, ms(a.ended_at) - ms(a.started_at)) : 0), 0) / 3_600_000;
  const done: ReportSnapshotData['done'] = tasks.filter((t) => inRange(t.act_end)).sort((a, b) => ms(a.act_end ?? '') - ms(b.act_end ?? '')).map((t) => ({
    ...rel(t), ...actors(t), workType: t.work_type as never, domain: t.domain as never,
    actStart: t.act_start, actEnd: t.act_end ?? at, estHours: est(t), actualHours: round1(durationHours(t.id)), attempts: attemptsOf(t.id).length,
    slipDays: slipOf(t.key), verification: lastVerification(t.id), checklist: checklistOf(t.id),
    outputs: { delivered: outputs.filter((o) => o.task === t.id && o.delivered).length, names: outputs.filter((o) => o.task === t.id).map((o) => o.name) },
    doneCond: t.done_cond ?? '',
  }));

  // 5. 진행 중 · 확인 필요 Task
  const activeTasks = tasks.filter((t) => (!t.act_start || upTo(t.act_start)) && (ACTIVE.includes(t.status) || (inRange(t.act_start) && t.status !== 'done')));
  const gates = await gateInputsAt(client, src, activeTasks.map((t) => t.id));
  const active: ReportSnapshotData['active'] = activeTasks.map((t) => {
    const s = plan.get(t.key);
    const la = attemptsOf(t.id).at(-1);
    const gate = gates.get(t.id);
    const conditions = gate ? completionGate(gate) : [];
    return {
      ...rel(t), ...actors(t), workType: t.work_type as never, domain: t.domain as never, status: t.status, progressPct: STAGE_PCT[t.status],
      actStart: t.act_start, end: s?.end ?? null, lo: s?.lo ?? null, hi: s?.hi ?? null, slipDays: slipOf(t.key),
      remainHours: s ? round1(s.estHours * (1 - STAGE_PCT[t.status] / 100)) : null,
      lastAttempt: la ? { attemptKey: la.key, kind: la.kind, agent: la.agent, grade: gradeOf(la), status: la.status, summary: la.summary ?? '' } : null,
      verification: lastVerification(t.id), checklist: checklistOf(t.id),
      gate: { passed: conditions.filter((c) => c.result === 'PASS').length, unmet: conditions.filter((c) => c.result !== 'PASS').map((c) => c.key) },
      blockingDefects: gate?.unresolvedBlockingDefects ?? 0, blockers: blockersFor(t.id), next: nextStep(t.status, t.assignee, t.verifier),
    };
  });

  // 6. QA 실패 · 결함 상세
  const failures: ReportSnapshotData['failures'] = inVerifs.filter((v) => v.result === 'FAIL').flatMap((v) => {
    const t = byId.get(v.task);
    if (!t) return [];
    return [{
      verificationId: v.id, taskKey: t.key, title: t.title, agent: v.agent, at: v.at, cmd: v.cmd, expected: v.expected, actual: v.actual,
      defects: defects.filter((d) => d.verification === v.id).map((d) => d.text), evidence: evidence.filter((e) => e.verification === v.id).map((e) => e.path),
      messages: messages.filter((m) => m.task === v.task && m.dir === 'out' && upTo(m.at) && ms(m.at) >= ms(v.at)).map((m) => ({ msgKey: m.key, delivery: m.delivery ?? '' })),
      reworks: attempts.filter((a) => a.task === v.task && a.kind === 'rework' && upTo(a.started_at) && ms(a.started_at) > ms(v.at)).map((a) => ({ attemptKey: a.key, status: a.status })),
    }];
  });

  // 7. 실행 기록 표
  const attemptRows: ReportSnapshotData['attempts'] = inAtts.flatMap((a) => {
    const t = byId.get(a.task);
    return t ? [{
      attemptKey: a.key, taskKey: t.key, kind: a.kind, agent: a.agent, grade: gradeOf(a), startedAt: a.started_at, endedAt: a.ended_at, status: a.status,
      summary: a.summary ?? '', adjust: a.adjust ?? null, files: a.files, tokens: Number(a.tokens ?? 0),
    }] : [];
  });

  // 8. 일정 재조정
  const replanRows: ReportSnapshotData['replans'] = replans.filter((r) => inRange(r.at) && isDate(r.after.end) && isDate(r.after.lo) && isDate(r.after.hi)).map((r) => ({
    replanId: r.key, at: r.at, trigger: r.trigger, before: isDate(r.before.end) ? r.before.end : null,
    after: r.after.end as string, lo: r.after.lo as string, hi: r.after.hi as string,
    moved: moves.filter((m) => m.replan === r.id).flatMap((m) => {
      const t = byId.get(m.task);
      const b = isDate(m.before?.end) ? m.before.end : null;
      const e = isDate(m.after?.end) ? m.after.end : null;
      return t ? [{ taskKey: t.key, title: t.title, kind: m.kind, before: b, after: e, deltaDays: b && e ? daysBetween(b, e) : null }] : [];
    }),
  }));

  // 10. 팀장 지시 · Runner 응답
  const messageRows: ReportSnapshotData['messages'] = messages.filter((m) => inRange(m.at)).flatMap((m) => {
    const t = byId.get(m.task);
    return t ? [{
      at: m.at, taskKey: t.key, dir: m.dir, agent: m.dir === 'out' ? m.to_agent : m.from_agent, type: m.type,
      delivery: m.dir === 'out' ? m.delivery : null, pendingNext: m.pending_next, firstLine: firstLine(m.body),
    }] : [];
  });

  // 11. 다음 날 · 다음 주 예정(P nxt L3807: 일간은 하루, 주간·기간은 7일, 최대 8건)
  const nextFrom = addDays(period.to, 1);
  const nextTo = addDays(period.to, period.kind === 'daily' ? 1 : 7);
  const gradeByTask = new Map(grades.map((g) => [g.task, g]));
  const next: ReportSnapshotData['next'] = tasks.flatMap((t) => {
    const s = plan.get(t.key);
    return s && !s.done && s.start <= nextTo && s.end >= nextFrom ? [{ t, s }] : [];
  }).sort((a, b) => a.s.start.localeCompare(b.s.start) || a.t.key.localeCompare(b.t.key)).slice(0, 8).map(({ t, s }) => ({
    ...rel(t), ...actors(t), status: t.status, start: s.start, end: s.end, estHours: est(t), grade: gradeOf(gradeByTask.get(t.id)), blockers: blockersFor(t.id), conflictGroup: t.cg,
  }));

  // 12. 부록: 전체 Task 현황표(WBS 번호순)
  const all: ReportSnapshotData['all'] = [...tasks].sort((a, b) => (paths.get(a.id) ?? '').localeCompare(paths.get(b.id) ?? '', undefined, { numeric: true })).map((t) => {
    const s = plan.get(t.key);
    const c = checklistOf(t.id);
    return {
      ...rel(t), ...actors(t), status: t.status, progressPct: STAGE_PCT[t.status], checklist: { done: c.done, total: c.total }, verifState: t.verif_state as never,
      end: t.status === 'done' && t.act_end ? seoulDay(t.act_end) : s?.end ?? null,
      slipDays: s && !s.isNew && !s.done ? s.slipDays : null, blocked: t.status !== 'done' && blocked.has(t.id),
    };
  });

  return redact({
    projectName: project[0]?.name ?? '',
    projectNameStatus: 'snapshot',
    summary: {
      taskCount: tasks.length, doneCount: doneTo.length, doneBefore: doneFrom.length, workPct: workPct(doneTo), workPctBefore: workPct(doneFrom),
      baselineVersion: last?.baseline_v ?? schedule?.project.baselineVersion ?? 0,
      // 완료 예상은 생성 시각까지의 마지막 재조정 결과다(P L3866). 재조정이 없으면 생성 시각의 계산값을 쓴다.
      forecast: endOf(last) ?? schedule?.project.end ?? null,
      lo: last && isDate(last.after.lo) ? last.after.lo : last ? null : schedule?.project.lo ?? null,
      hi: last && isDate(last.after.hi) ? last.after.hi : last ? null : schedule?.project.hi ?? null,
      forecastBefore: endOf(before), target: project[0]?.target ?? null, uptimePct: up.pct,
      ratePct: clampPct(Math.round((schedule?.rate ?? 0) * 100)), blocked: tasks.filter((t) => t.status !== 'done' && blocked.has(t.id)).length,
      statuses: TASK_STATUSES.flatMap((status) => {
        const count = tasks.filter((t) => t.status === status).length;
        return count ? [{ status, count }] : [];
      }),
      started: tasks.filter((t) => inRange(t.act_start)).map((t) => ({ ...rel(t), at: t.act_start ?? at })),
      attempts: {
        total: inAtts.length, dev: inAtts.filter((a) => a.kind === 'dev' || a.kind === 'rework').length, qa: inAtts.filter((a) => a.kind === 'qa' || a.kind === 'reverify').length,
        pass: inVerifs.filter((v) => v.result === 'PASS').length, fail: inVerifs.filter((v) => v.result === 'FAIL').length,
        escalated: inAtts.filter((a) => a.adjust?.kind === 'up').length, interrupted: inAtts.filter((a) => a.status === 'interrupted').length,
        tokens: inAtts.reduce((sum, a) => sum + Number(a.tokens ?? 0), 0),
      },
    },
    issues, series, done, active, failures, attempts: attemptRows, replans: replanRows, gaps: up.gaps, messages: messageRows, next, all,
    basis: { asOf: at, stateFrom: coverage0, missing: missing ? ['state'] : [], currentSettings: settings.current, uncertain: await uncertainAt(client, projectId, src) },
  }) as ReportSnapshotData;
}

/**
 * T 시점 Completion Gate 입력. execution/gate.ts의 gateInputs와 같은 규칙을 T 시점 자료(state.ts)로 읽는다.
 * 왜 따로 두나: gateInputs는 지금 표를 읽는다. 보고서는 기간 끝 시점의 체크리스트·산출물·검증·결함으로 판정해야 한다.
 */
async function gateInputsAt(client: PoolClient, src: ReturnType<typeof asOf>, taskIds: string[]): Promise<Map<string, GateInput>> {
  if (!taskIds.length) return new Map();
  const rows = (await client.query<{ id: string; planning_approved_at: Date | null; revision: number; input_v: number; head_sha: string; open_qa: boolean;
    verification: { result: VerificationResult; headSha: string; specRevision: number; inputVersion: number; invalidated: boolean } | null;
    check_result: string | null; check_revision: number; check_input: number; defects: number;
    checklist: { required: boolean; done: boolean }[]; outputs: { name: string; required: boolean; delivered: boolean }[] }>(`
    -- 성능(재리뷰 3 문제 3): 각 표의 T 시점 행을 한 번만 되살리고(CTE MATERIALIZED) Task별로는 모아 둔 결과를 붙인다.
    -- 이전에는 Task마다 상관 하위 질의 안에서 같은 표를 다시 되살려 Task 수의 제곱으로 느려졌다.
    with t as materialized (select * from ${src.rel('tasks')} x where x.id=any($1::uuid[])),
      att as materialized (select * from ${src.rel('task_attempts')} x where x.task=any($1::uuid[])),
      ver as materialized (select * from ${src.rel('verifications')} x),
      inv as materialized (select distinct verification from ${src.rel('verification_invalidations')} x),
      res as materialized (select distinct defect from ${src.rel('defect_events')} x where x.kind='resolved'),
      ivs as materialized (select * from ${src.rel('input_versions')} x),
      spec as materialized (select * from ${src.rel('task_specs')} x where x.task=any($1::uuid[])),
      cl as materialized (select task,jsonb_agg(jsonb_build_object('required',required,'done',done) order by sort_order,id) items
        from ${src.rel('checklist_items')} x where x.task=any($1::uuid[]) group by task),
      outp as materialized (select task,jsonb_agg(jsonb_build_object('name',name,'required',required,'delivered',delivered) order by name,id) items
        from ${src.rel('task_outputs')} x where x.task=any($1::uuid[]) group by task),
      cir as materialized (select * from ${src.rel('ci_runs')} x where x.stage=1 and x.task=any($1::uuid[])),
      lastatt as materialized (select distinct on (task) task,head_sha from att order by task,attempt_no desc),
      openqa as materialized (select distinct task from att where status='running' and kind in ('qa','reverify')),
      lastqa as materialized (select distinct on (qa.task) qa.task,v.id,v.result,v.head_sha,v.spec_revision,iv.v input_v
        from att qa left join ver v on v.attempt=qa.id left join ivs iv on iv.id=qa.input_version where qa.kind in ('qa','reverify') order by qa.task,qa.attempt_no desc),
      blocking as materialized (select da.task,count(*)::int n from ${src.rel('defects')} d join ver dv on dv.id=d.verification join att da on da.id=dv.attempt
        where d.blocking and not exists(select 1 from res where res.defect=d.id) and not exists(select 1 from inv where inv.verification=dv.id) group by da.task)
    select t.id,t.planning_approved_at,s.revision,iv.v input_v,coalesce(t.execution_head_sha,a.head_sha) head_sha,
      exists(select 1 from openqa o where o.task=t.id) open_qa,
      case when q.id is not null then jsonb_build_object('result',q.result,'headSha',q.head_sha,'specRevision',q.spec_revision,'inputVersion',coalesce(q.input_v,0),
        'invalidated',exists(select 1 from inv where inv.verification=q.id)) end verification,
      c.status check_result,c.spec_revision check_revision,c.input_v check_input,
      coalesce(b.n,0) defects, coalesce(cl.items,'[]') checklist, coalesce(outp.items,'[]') outputs
    from t left join spec s on s.task=t.id
    left join lateral(select * from ivs x where x.project_id=t.project_id and (t.src_input_version is null or x.id=t.src_input_version) order by v desc limit 1) iv on true
    left join lastatt a on a.task=t.id
    left join lastqa q on q.task=t.id
    left join blocking b on b.task=t.id
    left join cl on cl.task=t.id
    left join outp on outp.task=t.id
    left join lateral(select c.status,c.spec_revision,iv2.v input_v from cir c left join ivs iv2 on iv2.id=c.input_version
      where c.project_id=t.project_id and c.task=t.id and c.head_sha=coalesce(t.execution_head_sha,a.head_sha) order by c.run_no desc limit 1) c on true`, [taskIds])).rows;
  return new Map(rows.map((task) => {
    const basis = { headSha: task.head_sha ?? '', specRevision: task.revision ?? 0, inputVersion: task.input_v ?? 0 };
    return [task.id, {
      checklist: task.checklist, outputs: task.outputs, basis, verification: task.verification,
      ...(task.open_qa ? { verificationState: 'running' as const } : {}),
      taskCheck: task.check_result ? { ...basis, specRevision: task.check_revision, inputVersion: task.check_input ?? 0, result: task.check_result === 'pass' ? 'PASS' as const : 'FAIL' as const } : null,
      unresolvedBlockingDefects: task.defects, planningApprovedAt: task.planning_approved_at ? new Date(task.planning_approved_at).toISOString() : null, headSync: null,
    }];
  }));
}
