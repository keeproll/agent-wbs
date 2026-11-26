/**
 * 프로젝트 화면의 WBS 구조·Agent 참여·계획 변경 계산(원본 P projectVM L6458–6493, UAT-PROJECT-11). 화면 없는 순수 함수다.
 * M3 통합(교차 리뷰 지적 2): M3-04·M3-07이 서로 상대 몫으로 남겨 빠졌던 카드다. 이미 있는 조회(listTasks·getSchedule·getDashboard)로 만든다.
 */
import type { ResponseOf } from '../../shared/api/contract.ts';
import { dayNo, fmtH, md } from '../wbs/model.ts';

type TaskList = ResponseOf<'listTasks'>;
type Task = TaskList['tasks'][number];
type Node = TaskList['nodes'][number];
type Schedule = ResponseOf<'getSchedule'>;
type Dashboard = ResponseOf<'getDashboard'>;

/** 원본 pjVM prog(P L6464) 그대로 — 중단(paused)은 진행으로 세지 않는다. */
const PROGRESS = ['running', 'qa', 'rework', 'verifying', 'gate'];

export interface StructureRow {
  id: string; wbs: string; kind: 'Phase' | 'Work Package'; title: string;
  /** 누르면 열 Phase(원본: Work Package 행도 그 Phase로 거른다, P L6478) */
  phaseId: string;
  n: number; done: number; act: number; blk: number; est: string; win: string; pct: number;
}

/** Phase → Work Package 순서의 행(P L6475–6479). 취소·삭제 Task는 세지 않는다. */
export function structureRows(list: TaskList, schedule: Schedule | undefined): StructureRow[] {
  const live = list.tasks.filter((t) => !t.deletedAt && String(t.lifecycleStatus) !== 'cancelled');
  const sched = new Map((schedule?.tasks ?? []).map((s) => [s.taskKey, s]));
  const byOrder = (a: Node, b: Node) => a.sortOrder - b.sortOrder;
  const phases = list.nodes.filter((n) => n.kind === 'phase').sort(byOrder);
  const wpsOf = (p: Node) => list.nodes.filter((n) => n.parentId === p.id).sort(byOrder);
  const stat = (tasks: readonly Task[]) => {
    const sc = tasks.flatMap((t) => { const s = sched.get(t.taskKey); return s ? [s] : []; });
    const est = sc.reduce((a, s) => a + s.estHours, 0);
    const pct = est ? Math.round(sc.reduce((a, s) => a + s.estHours * s.progressPct, 0) / est) : 0;
    let win = '—';
    if (sc.length) {
      // 원본 P L6469–6472: 그룹의 계획 시작(최소)·계획 완료(최대)·예상 완료(최대)를 구하고, 지연은 S.wdB(pe, fe) = fe − pe(일)다.
      // Task별 지연의 최댓값이 아니다(재리뷰 P2-3: 한 Task가 늦어져도 그룹의 마지막 완료일이 그대로면 지연 0).
      const ps = Math.min(...sc.map((s) => dayNo(s.baselineStart ?? s.start)));
      const pe = Math.max(...sc.map((s) => dayNo(s.baselineEnd ?? s.end)));
      const fe = Math.max(...sc.map((s) => dayNo(s.end)));
      const iso = (n: number) => new Date(n * 864e5).toISOString().slice(0, 10);
      win = `${md(iso(ps))} ~ ${md(iso(pe))}${fe - pe > 0 ? ` (+${String(fe - pe)})` : ''}`;
    }
    return {
      n: tasks.length, done: tasks.filter((t) => String(t.lifecycleStatus) === 'done').length,
      act: tasks.filter((t) => PROGRESS.includes(String(t.lifecycleStatus))).length,
      // 원본 Sel.isBlocked(P L3683): 완료 Task는 차단으로 세지 않는다.
      blk: tasks.filter((t) => String(t.lifecycleStatus) !== 'done' && t.blocked).length, est: fmtH(est), win, pct,
    };
  };
  const rows: StructureRow[] = [];
  for (const ph of phases) {
    const wps = wpsOf(ph);
    const inPhase = live.filter((t) => t.wbsNodeId === ph.id || wps.some((w) => w.id === t.wbsNodeId));
    rows.push({ id: ph.id, wbs: ph.wbsPath, kind: 'Phase', title: ph.title, phaseId: ph.id, ...stat(inPhase) });
    for (const w of wps) rows.push({ id: w.id, wbs: w.wbsPath, kind: 'Work Package', title: w.title, phaseId: ph.id, ...stat(live.filter((t) => t.wbsNodeId === w.id)) });
  }
  return rows;
}

type Attempt = ResponseOf<'getTaskAttempts'>['items'][number];
export interface AgentRow { name: 'Claude' | 'Codex'; dev: number; ver: number; run: number | null; att: number | null }

/**
 * Agent 참여 현황(원본 pjVM agents, P L6481).
 * - 담당·검증: 취소·삭제 Task를 뺀 Task 수.
 * - 실행 중·시도: 개발·QA·재작업·재검증 모든 시도(재리뷰 P2-2). 대시보드 등급 통계는 개발·재작업만 세므로 쓰지 않는다.
 *   attemptsByTask가 null이면(아직 다 읽지 못함) 실행 중·시도는 null(「—」).
 */
export function agentRows(list: TaskList, attemptsByTask: ReadonlyMap<string, readonly Attempt[]> | null): AgentRow[] {
  const live = list.tasks.filter((t) => !t.deletedAt && String(t.lifecycleStatus) !== 'cancelled');
  const attempts = attemptsByTask ? [...attemptsByTask.values()].flat() : null;
  return (['Claude', 'Codex'] as const).map((name) => ({
    name,
    dev: live.filter((t) => String(t.assigneeAgent) === name).length,
    ver: live.filter((t) => String(t.verifierAgent) === name).length,
    run: attempts ? attempts.filter((a) => String(a.agent) === name && String(a.status) === 'running').length : null,
    att: attempts ? attempts.filter((a) => String(a.agent) === name).length : null,
  }));
}

/** 시도가 있을 수 있는 Task(계획·승인 대기는 아직 실행 전). 시도 목록은 이 Task들만 읽는다. */
export const mayHaveAttempts = (t: Task) => !t.deletedAt && !['planning', 'approval'].includes(String(t.lifecycleStatus));

/** 계획 변경 수(P L6492): 이견 조정이 남은 Planning, 승인 · 반영 대기 CP(review·changes·approved). */
export function planChangeCounts(dash: Dashboard | undefined): { pl: number | null; cp: number | null } {
  if (!dash) return { pl: null, cp: null };
  const pl = dash.panels.approvals.filter((a) => a.kind === 'planning' && a.unresolved > 0).length;
  const cp = dash.panels.approvals.filter((a) => a.kind === 'proposal' && ['review', 'changes', 'approved'].includes(String(a.status))).length;
  return { pl, cp };
}
