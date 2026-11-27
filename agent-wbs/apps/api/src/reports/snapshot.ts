import type { PoolClient } from '@awbs/db';
import {
  blockers as blockersOf, blockedTasks, completionGate, daysBetween, periodBounds, seoulDay, seoulMidnight, addDays, STAGE_PCT, TASK_STATUSES,
  type ReportKind, type ReportSnapshotData, type TaskStatus,
} from '@awbs/shared';
import { gateInputs } from '../execution/gate.ts';
import { scheduleView } from '../planning/schedule.ts';
import { wbsPaths } from '../tasks/wbs.ts';

/**
 * 보고서 스냅샷 만들기(G§4.11 L371-396, P report L3800-3868, milestones §4.0).
 *
 * 무엇을 어느 시점으로 세나:
 * - 「기간 중 일어난 일」(완료·시작·시도·검증·메시지·재조정·중단)은 기록 시각이 [기간 시작, 기간 끝) 안에 있는 것만 센다.
 *   기간 끝은 다음 날 00:00(서울)과 생성 시각 중 이른 쪽이다(period.ts periodBounds).
 * - 「지금 상태」(상태 분포·진행 중·다음 예정·전체 표·일정)는 생성 시각의 값이다. 원본도 같다(P L3800: 현재 데이터 d를 쓴다).
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

export async function buildSnapshot(client: PoolClient, projectId: string, period: SnapshotPeriod): Promise<ReportSnapshotData> {
  const { start, end } = periodBounds(period.from, period.to, period.at);
  const at = period.at;
  const inRange = (v: string | null | undefined) => !!v && ms(v) >= ms(start) && ms(v) < ms(end);
  const upTo = (v: string | null | undefined) => !!v && ms(v) <= ms(at);

  // 한 연결에서 질의를 동시에 보내지 않는다(pg는 한 연결의 동시 질의를 차례로 줄 세우며, 그 방식은 다음 판에서 없어진다). 앞 질의가 끝난 뒤 다음을 보낸다.
  let chain: Promise<unknown> = Promise.resolve();
  const q = <T extends object>(sql: string, args: unknown[] = []): Promise<T[]> => {
    const next = chain.then(() => client.query<T>(sql, args)).then((r) => r.rows);
    chain = next.catch(() => undefined);
    return next;
  };
  const [project, tasks, nodes, deps, attempts, verifs, defects, evidence, messages, replans, moves, sessions, alerts, proposals, checklist, outputs, grades] = await Promise.all([
    q<{ target: string | null; name: string }>("select to_char(target_date,'YYYY-MM-DD') target,name from projects where id=$1", [projectId]),
    q<{ id: string; key: string; title: string; status: TaskStatus; work_type: string; domain: string; assignee: 'Claude' | 'Codex'; verifier: 'Claude' | 'Codex';
      verif_state: string; act_start: string | null; act_end: string | null; cg: string | null; done_cond: string | null; wbs_node_id: string; sort_order: number; est: string | null }>(
      `select t.id,t.task_key key,t.title,t.status,t.work_type,t.primary_domain domain,t.assignee_agent assignee,t.verifier_agent verifier,t.verif_state,
        ${iso('t.act_start')} act_start,${iso('t.act_end')} act_end,t.conflict_group cg,s.overview->>'doneCond' done_cond,t.wbs_node_id,t.sort_order,e.est::text est
       from tasks t left join task_specs s on s.task=t.id
       left join lateral(select est from task_estimates where task=t.id order by created_at desc,id desc limit 1) e on true
       where t.project_id=$1 and t.deleted_at is null and t.status<>'cancelled'`, [projectId]),
    q<{ id: string; kind: 'phase' | 'work_package'; parent_id: string | null; sort_order: number }>('select id,kind,parent_id,sort_order from wbs_nodes where project_id=$1', [projectId]),
    q<{ pred: string; succ: string; type: 'FS' | 'SS' }>('select pred,succ,dep_type type from task_dependencies where project_id=$1', [projectId]),
    q<{ id: string; task: string; key: string; no: number; kind: 'dev' | 'qa' | 'rework' | 'reverify'; agent: 'Claude' | 'Codex'; status: 'running' | 'completed' | 'failed' | 'interrupted';
      started_at: string; ended_at: string | null; model_id: string; effort: string; adjust: ReportSnapshotData['attempts'][number]['adjust']; summary: string | null; tokens: string | null; files: number }>(
      `select a.id,a.task,a.attempt_key key,a.attempt_no no,a.kind,a.agent,a.status,${iso('a.started_at')} started_at,${iso('a.ended_at')} ended_at,a.model_id,a.effort,
        a.grade_adjust adjust,a.summary,a.tokens::text tokens,(select count(*)::int from attempt_files f where f.attempt=a.id) files
       from task_attempts a where a.project_id=$1 order by a.started_at,a.attempt_no,a.id`, [projectId]),
    // 검증 시각: QA 시도가 끝난 시각(없으면 기록 시각). 검증 결과는 시도 종료와 함께 보고된다(contracts §3.5).
    q<{ id: string; attempt: string; task: string; agent: 'Claude' | 'Codex'; result: 'PASS' | 'FAIL' | 'BLOCKED'; cmd: string; expected: string; actual: string; at: string; no: number }>(
      `select v.id,v.attempt,a.task,a.agent,v.result,v.cmd,v.expected,v.actual,${iso('coalesce(a.ended_at,v.created_at)')} at,a.attempt_no no
       from verifications v join task_attempts a on a.id=v.attempt where v.project_id=$1 order by coalesce(a.ended_at,v.created_at),v.id`, [projectId]),
    q<{ verification: string; text: string; blocking: boolean }>("select verification,def_key||' '||content text,blocking from defects where project_id=$1 order by def_key", [projectId]),
    q<{ verification: string; path: string }>('select verification,coalesce(reference_path,storage_path) path from evidence where project_id=$1 and verification is not null order by created_at,id', [projectId]),
    q<{ key: string; task: string; dir: 'in' | 'out'; type: string; to_agent: 'Claude' | 'Codex' | null; from_agent: 'Claude' | 'Codex' | null; body: string; delivery: string | null; pending_next: boolean; at: string }>(
      `select msg_key key,task,dir,type,to_agent,from_agent,body,delivery::text delivery,pending_next,${iso('created_at')} at from messages where project_id=$1 and not draft order by created_at,id`, [projectId]),
    q<{ id: string; key: string; trigger: string; baseline_v: number | null; before: { end?: unknown }; after: { end?: unknown; lo?: unknown; hi?: unknown }; at: string }>(
      `select id,rp_key key,trigger,baseline_v,before,after,${iso('created_at')} at from replans where project_id=$1 and status='applied' order by created_at,id`, [projectId]),
    q<{ replan: string; task: string; kind: 'delayed' | 'advanced' | 'new' | 'excluded'; before: { end?: unknown } | null; after: { end?: unknown } | null }>(
      'select replan,task,kind,before,after from replan_moves where project_id=$1 order by created_at,id', [projectId]),
    q<{ from: string; to: string | null; reason: string | null }>(`select ${iso('started_at')} "from",${iso('ended_at')} "to",end_reason reason from runner_sessions order by started_at,id`),
    q<{ key: string; target: Record<string, unknown> | null; at: string; resolved: string | null }>(
      `select key,target,${iso('created_at')} at,${iso('resolved_at')} resolved from alerts where project_id=$1 or project_id is null order by created_at,id`, [projectId]),
    q<{ key: string; title: string; status: string; at: string }>(
      `select cp_key key,title,status,${iso('created_at')} at from change_proposals where project_id=$1 and deleted_at is null and status in ('review','changes','held') order by created_at,id`, [projectId]),
    q<{ task: string; required: boolean; done: boolean }>('select task,required,done from checklist_items where project_id=$1', [projectId]),
    q<{ task: string; name: string; delivered: boolean }>('select task,name,delivered from task_outputs where project_id=$1 order by name', [projectId]),
    q<{ task: string; model_id: string; effort: string }>("select task,model_id,effort from task_grades where project_id=$1 and role='dev'", [projectId]),
  ]);

  const paths = wbsPaths(
    nodes.map((n) => ({ id: n.id, kind: n.kind, parentId: n.parent_id, sortOrder: n.sort_order })),
    tasks.map((t) => ({ id: t.id, wbsNodeId: t.wbs_node_id, sortOrder: t.sort_order, deleted: false })),
  ).task;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rel = (t: (typeof tasks)[number]) => ({ taskKey: t.key, wbsPath: paths.get(t.id) ?? '', title: t.title });
  const actors = (t: (typeof tasks)[number]) => ({ assignee: t.assignee, verifier: t.verifier });
  const est = (t: (typeof tasks)[number]) => (t.est === null ? 0 : Number(t.est));

  // 일정(생성 시각). 순환 같은 일정 오류가 있어도 보고서는 만든다(일정 칸만 비운다).
  let schedule: Awaited<ReturnType<typeof scheduleView>> | null = null;
  if (tasks.length) {
    try { schedule = await scheduleView(client, projectId); } catch { schedule = null; }
  }
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
  const doneFrom = tasks.filter((t) => t.act_end && ms(t.act_end) < ms(start));
  const rpsUpTo = replans.filter((r) => upTo(r.at));
  const last = rpsUpTo.at(-1);
  const before = replans.filter((r) => ms(r.at) < ms(start)).at(-1);
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
  for (const a of alerts.filter((x) => upTo(x.at) && (!x.resolved || ms(x.resolved) > ms(at)))) {
    const target = a.target ?? {};
    const text = typeof target.message === 'string' && target.message.trim() ? target.message : a.key;
    const taskKey = typeof target.taskKey === 'string' && /^TASK-\d{4,}$/.test(target.taskKey) ? target.taskKey : null;
    issues.push({ level: 'warn', text, taskKey });
  }
  // held는 자동 반영이 막혀 보류된 제안이다(planning/routes.ts). 원본 문구로 검토 대기와 구분한다(P L3812).
  for (const p of proposals.filter((x) => upTo(x.at))) {
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
      const a = ms(seoulMidnight(day));
      const b = Math.min(ms(seoulMidnight(addDays(day, 1))), ms(at));
      const inDay = (v: string | null) => !!v && ms(v) >= a && ms(v) < b;
      series.push({
        day, done: tasks.filter((t) => inDay(t.act_end)).length, attempts: attempts.filter((x) => inDay(x.started_at)).length,
        fails: verifs.filter((v) => v.result === 'FAIL' && inDay(v.at)).length, uptimePct: b > a ? coverage(a, b).pct : 0,
        forecast: endOf(replans.filter((r) => ms(r.at) < b).at(-1)),
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
  const gates = await gateInputs(client, activeTasks.map((t) => t.id));
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

  return {
    projectName: project[0]?.name ?? '',
    summary: {
      taskCount: tasks.length, doneCount: doneTo.length, doneBefore: doneFrom.length, workPct: workPct(doneTo), workPctBefore: workPct(doneFrom),
      baselineVersion: last?.baseline_v ?? schedule?.project.baselineVersion ?? 0,
      // 완료 예상은 생성 시각까지의 마지막 재조정 결과다(P L3866). 재조정이 없으면 생성 시각의 계산값을 쓴다.
      forecast: endOf(last) ?? schedule?.project.end ?? null,
      lo: last && isDate(last.after.lo) ? last.after.lo : last ? null : schedule?.project.lo ?? null,
      hi: last && isDate(last.after.hi) ? last.after.hi : last ? null : schedule?.project.hi ?? null,
      forecastBefore: endOf(before), target: project[0]?.target ?? null, uptimePct: up.pct,
      ratePct: clampPct(Math.round((schedule?.capacity.rate ?? 0) * 100)), blocked: tasks.filter((t) => t.status !== 'done' && blocked.has(t.id)).length,
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
  };
}
