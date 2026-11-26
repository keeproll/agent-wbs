/**
 * 프로젝트 WBS 구조·Agent 참여 계산을 원본 프로토타입 pjVM(P L6462–6481)의 같은 계산과 대조한다(M3 통합 재리뷰 sf3-43e05b9 P2-2·P2-3).
 * 아래 proto*는 원본 코드를 그대로 옮긴 것이다(입력만 계약 모양에서 원본 모양으로 바꿈). 원본: prototype/uiux/Main.dc.html.
 */
import { describe, expect, it } from 'vitest';
import { agentRows, structureRows } from '../src/features/project/structure.ts';
import type { ResponseOf } from '../src/shared/api/contract.ts';

type TaskList = ResponseOf<'listTasks'>;
type Task = TaskList['tasks'][number];
type Node = TaskList['nodes'][number];
type SchedTask = ResponseOf<'getSchedule'>['tasks'][number];
type Attempt = ResponseOf<'getTaskAttempts'>['items'][number];

const dayNo = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 864e5);
/** 원본 Cal.md(일 번호 → MM-DD) */
const calMd = (n: number) => new Date(n * 864e5).toISOString().slice(5, 10);
/** 원본 fmtH */
const fmtH = (h: number) => `${String(Math.round(h * 10) / 10)}h`;

/* ---- 원본 pjVM 계산(P L6464–6472, L6481) 그대로 ---- */
interface PTask { id: string; status: string; assignee: string | null; verifier: string | null; blocked: boolean }
interface PSc { est: number; pct: number; ps: number; pe: number; fe: number }
function protoStat(ids: string[], tasks: Record<string, PTask>, by: Record<string, PSc | undefined>) {
  const prog = ['running', 'qa', 'rework', 'verifying', 'gate'];
  const S = { by, wdB: (a: number, b: number) => b - a };
  const isBlocked = (t: PTask) => t.status !== 'done' && t.blocked;
  const ts = ids.map((id) => tasks[id] as PTask).filter((t) => t.status !== 'cancelled'), dn = ts.filter((t) => t.status === 'done').length, sc = ts.map((t) => S.by[t.id]).filter(Boolean) as PSc[];
  const est = sc.reduce((a, x) => a + x.est, 0), wp = est ? Math.round(sc.reduce((a, x) => a + x.est * x.pct, 0) / est) : 0;
  const ps = sc.length ? Math.min(...sc.map((x) => x.ps)) : 0, pe = sc.length ? Math.max(...sc.map((x) => x.pe)) : 0, fe = sc.length ? Math.max(...sc.map((x) => x.fe)) : 0;
  return { n: ts.length, done: dn, act: ts.filter((t) => prog.includes(t.status)).length, blk: ts.filter(isBlocked).length, pct: wp, est: fmtH(est),
    win: sc.length ? `${calMd(ps)} ~ ${calMd(pe)}${S.wdB(pe, fe) > 0 ? ` (+${String(S.wdB(pe, fe))})` : ''}` : '—' };
}
function protoAgents(tasks: PTask[], attempts: { agent: string; status: string }[]) {
  const all = tasks.filter((t) => t.status !== 'cancelled');
  return ['Claude', 'Codex'].map((a) => ({ name: a, dev: all.filter((t) => t.assignee === a).length, ver: all.filter((t) => t.verifier === a).length,
    run: attempts.filter((x) => x.agent === a && x.status === '실행 중').length, att: attempts.filter((x) => x.agent === a).length }));
}

/* ---- 시험 자료(계약 모양) ---- */
const node = (id: string, kind: 'phase' | 'work_package', parentId: string | null, wbsPath: string, sortOrder: number): Node =>
  ({ id, kind, parentId, wbsPath, title: id, sortOrder }) as unknown as Node;
const task = (taskKey: string, wbsNodeId: string, status: string, assignee: 'Claude' | 'Codex', verifier: 'Claude' | 'Codex', blocked = false): Task =>
  ({ id: `id-${taskKey}`, taskKey, wbsNodeId, wbsPath: '', title: taskKey, lifecycleStatus: status, assigneeAgent: assignee, verifierAgent: verifier, blocked, deletedAt: null }) as unknown as Task;
const sched = (taskKey: string, est: number, pct: number, baseStart: string, baseEnd: string, end: string): SchedTask =>
  ({ taskKey, start: baseStart, end, lo: end, hi: end, estHours: est, loHours: est, hiHours: est, progressPct: pct, started: false, done: false, isNew: false, baselineStart: baseStart, baselineEnd: baseEnd, slipDays: dayNo(end) - dayNo(baseEnd) }) as unknown as SchedTask;
const attempt = (taskKey: string, agent: 'Claude' | 'Codex', kind: Attempt['kind'], status: Attempt['status']): Attempt =>
  ({ id: `${taskKey}-${kind}-${status}`, taskKey, agent, kind, status }) as unknown as Attempt;

const NODES = [node('PH-1', 'phase', null, '1', 0), node('WP-1', 'work_package', 'PH-1', '1.1', 0), node('WP-2', 'work_package', 'PH-1', '1.2', 1)];
// 리뷰 재현: A는 월(11-02)→목(11-05)로 3일 늦어지지만 B가 원래대로 금(11-06)에 끝나 그룹 완료일은 그대로다.
const TASKS = [
  task('TASK-0001', 'WP-1', 'running', 'Claude', 'Codex'),
  task('TASK-0002', 'WP-1', 'paused', 'Claude', 'Codex', true),
  task('TASK-0003', 'WP-2', 'done', 'Codex', 'Claude', true),
  task('TASK-0004', 'WP-2', 'cancelled', 'Claude', 'Codex'),
  task('TASK-0005', 'WP-2', 'qa', 'Codex', 'Claude', true),
];
const SCHED = { calcVersion: 1, at: '', tasks: [
  sched('TASK-0001', 4, 50, '2026-11-02', '2026-11-02', '2026-11-05'),
  sched('TASK-0002', 2, 0, '2026-11-03', '2026-11-06', '2026-11-06'),
  sched('TASK-0003', 3, 100, '2026-10-28', '2026-10-30', '2026-10-30'),
  sched('TASK-0004', 1, 0, '2026-11-01', '2026-11-01', '2026-11-01'),
  sched('TASK-0005', 5, 70, '2026-11-04', '2026-11-09', '2026-11-12'),
] } as unknown as ResponseOf<'getSchedule'>;
const ATTEMPTS = new Map<string, Attempt[]>([
  ['TASK-0001', [attempt('TASK-0001', 'Claude', 'dev', 'running')]],
  ['TASK-0003', [attempt('TASK-0003', 'Codex', 'dev', 'completed'), attempt('TASK-0003', 'Claude', 'qa', 'completed')]],
  ['TASK-0004', [attempt('TASK-0004', 'Claude', 'dev', 'interrupted')]],
  ['TASK-0005', [attempt('TASK-0005', 'Codex', 'dev', 'completed'), attempt('TASK-0005', 'Claude', 'qa', 'running'), attempt('TASK-0005', 'Codex', 'rework', 'failed')]],
]);

/* 계약 모양 → 원본 모양 */
const P_TASKS = Object.fromEntries(TASKS.map((t) => [t.taskKey, { id: t.taskKey, status: String(t.lifecycleStatus), assignee: t.assigneeAgent, verifier: t.verifierAgent, blocked: t.blocked }])) as Record<string, PTask>;
const P_BY = Object.fromEntries(SCHED.tasks.map((s) => [s.taskKey, { est: s.estHours, pct: s.progressPct, ps: dayNo(s.baselineStart ?? s.start), pe: dayNo(s.baselineEnd ?? s.end), fe: dayNo(s.end) }])) as Record<string, PSc>;
const P_ATTEMPTS = [...ATTEMPTS.values()].flat().map((a) => ({ agent: String(a.agent), status: a.status === 'running' ? '실행 중' : String(a.status) }));

describe('프로젝트 WBS 구조 — 원본 pjVM stat과 같다', () => {
  const rows = structureRows({ nodes: NODES, tasks: TASKS }, SCHED);
  const ids = (wp: string) => TASKS.filter((t) => t.wbsNodeId === wp).map((t) => t.taskKey);
  const cases: [string, string[]][] = [['PH-1', [...ids('WP-1'), ...ids('WP-2')]], ['WP-1', ids('WP-1')], ['WP-2', ids('WP-2')]];
  for (const [id, taskIds] of cases) {
    it(`${id}`, () => {
      const r = rows.find((x) => x.id === id);
      expect(r && { n: r.n, done: r.done, act: r.act, blk: r.blk, pct: r.pct, est: r.est, win: r.win }).toEqual(protoStat(taskIds, P_TASKS, P_BY));
    });
  }
  it('리뷰 재현: 그룹 완료일이 그대로면 지연 표시가 없다(Task 지연 최댓값이 아님)', () => {
    expect(rows.find((x) => x.id === 'WP-1')?.win).toBe('11-02 ~ 11-06');
  });
});

describe('프로젝트 Agent 참여 — 원본 pjVM agents와 같다', () => {
  it('취소 Task는 담당·검증에서 빼고, 시도는 QA·재작업 포함 모든 종류를 센다', () => {
    const got = agentRows({ nodes: NODES, tasks: TASKS }, ATTEMPTS).map((a) => ({ name: a.name, dev: a.dev, ver: a.ver, run: a.run, att: a.att }));
    expect(got).toEqual(protoAgents(Object.values(P_TASKS), P_ATTEMPTS));
  });
  it('시도 목록을 아직 못 읽었으면 실행 중·시도는 null', () => {
    expect(agentRows({ nodes: NODES, tasks: TASKS }, null).map((a) => [a.run, a.att])).toEqual([[null, null], [null, null]]);
  });
});
