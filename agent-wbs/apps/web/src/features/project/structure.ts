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

/** 원본 prog(진행 중으로 세는 상태) — 실행~Gate 대기. WBS 필터 「진행 중」과 같다. */
const PROGRESS = ['running', 'paused', 'qa', 'rework', 'verifying', 'gate'];

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
      const ps = Math.min(...sc.map((s) => dayNo(s.baselineStart ?? s.start)));
      const pe = Math.max(...sc.map((s) => dayNo(s.baselineEnd ?? s.end)));
      // 지연은 서버가 작업일로 센 slipDays의 최댓값(원본 S.wdB(pe, fe)와 같은 뜻)
      const slip = Math.max(0, ...sc.map((s) => s.slipDays ?? 0));
      const iso = (n: number) => new Date(n * 864e5).toISOString().slice(0, 10);
      win = `${md(iso(ps))} ~ ${md(iso(pe))}${slip > 0 ? ` (+${String(slip)})` : ''}`;
    }
    return {
      n: tasks.length, done: tasks.filter((t) => String(t.lifecycleStatus) === 'done').length,
      act: tasks.filter((t) => PROGRESS.includes(String(t.lifecycleStatus))).length,
      blk: tasks.filter((t) => t.blocked).length, est: fmtH(est), win, pct,
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

export interface AgentRow { name: 'Claude' | 'Codex'; dev: number; ver: number; run: number; att: number }

/**
 * Agent 참여 현황(P L6481): 담당·검증 Task 수는 Task 목록, 실행 중·시도 수는 대시보드(서버 집계).
 * 대시보드가 아직 없으면 실행 중·시도는 null(「—」).
 */
export function agentRows(list: TaskList, dash: Dashboard | undefined): (Omit<AgentRow, 'run' | 'att'> & { run: number | null; att: number | null })[] {
  const live = list.tasks.filter((t) => !t.deletedAt);
  return (['Claude', 'Codex'] as const).map((name) => ({
    name,
    dev: live.filter((t) => String(t.assigneeAgent) === name).length,
    ver: live.filter((t) => String(t.verifierAgent) === name).length,
    run: dash ? dash.panels.executions.filter((x) => x.kind === 'running' && String(x.agent) === name).length : null,
    att: dash ? dash.grades.filter((g) => String(g.agent) === name).reduce((a, g) => a + g.attempts, 0) : null,
  }));
}

/** 계획 변경 수(P L6492): 이견 조정이 남은 Planning, 승인 · 반영 대기 CP(review·changes·approved). */
export function planChangeCounts(dash: Dashboard | undefined): { pl: number | null; cp: number | null } {
  if (!dash) return { pl: null, cp: null };
  const pl = dash.panels.approvals.filter((a) => a.kind === 'planning' && a.unresolved > 0).length;
  const cp = dash.panels.approvals.filter((a) => a.kind === 'proposal' && ['review', 'changes', 'approved'].includes(String(a.status))).length;
  return { pl, cp };
}
