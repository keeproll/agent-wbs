/**
 * WBS 시험 자료 — 원본 기본 Mock(P L3093–3232, Task 12건)과 같은 구성의 계약 모양 응답.
 * 단위 시험(test/wbs-model.test.ts)과 E2E(e2e/wbs-*.spec.ts)가 함께 쓴다.
 * 일정 날짜는 원본 스크린샷(desktop-clock20261105/UI-03.png, 2026-11-05 20:00 KST)에 보이는 값에 맞췄다.
 */
import type { ResponseOf } from '../../src/shared/api/contract.ts';

export type TaskList = ResponseOf<'listTasks'>;
export type TaskSummary = TaskList['tasks'][number];
export type WbsNode = TaskList['nodes'][number];
export type ScheduleData = ResponseOf<'getSchedule'>;

export const PROJECT_ID = 'p1';

const node = (id: string, kind: 'phase' | 'work_package', parentId: string | null, wbsPath: string, title: string, sortOrder: number): WbsNode =>
  ({ id, kind, parentId, title, wbsPath, sortOrder }) as WbsNode;

export const NODES: WbsNode[] = [
  node('PH-1', 'phase', null, '1', '기반 구성', 0),
  node('WP-01', 'work_package', 'PH-1', '1.1', '개발 환경', 0),
  node('WP-02', 'work_package', 'PH-1', '1.2', '데이터 모델', 1),
  node('PH-2', 'phase', null, '2', 'Core WBS', 1),
  node('WP-03', 'work_package', 'PH-2', '2.1', 'Task API', 0),
  node('WP-04', 'work_package', 'PH-2', '2.2', 'WBS UI', 1),
  node('PH-3', 'phase', null, '3', 'Workflow', 2),
  node('WP-05', 'work_package', 'PH-3', '3.1', 'Planning · Gate', 0),
  node('WP-06', 'work_package', 'PH-3', '3.2', 'Runner 연동', 1),
];

interface Seed {
  key: string; wp: string; path: string; title: string; type: string; domain: string; rel: string[]; status: string; priority: number;
  assignee: string; verifier: string; verif: string; blocked: boolean; preds: string[]; cl: [number, number];
  est: number; lo: number; hi: number; pct: number; start: string; end: string; loEnd: string; hiEnd: string;
  bStart: string | null; bEnd: string | null; started: boolean; done: boolean; updated: string;
}

const SEEDS: Seed[] = [
  { key: 'TASK-0001', wp: 'WP-01', path: '1.1.1', title: 'Monorepo 구성', type: 'Configuration', domain: 'DevOps', rel: ['Common'], status: 'done', priority: 1, assignee: 'Claude', verifier: 'Codex', verif: 'pass', blocked: false, preds: [], cl: [3, 3], est: 1.5, lo: 1, hi: 2.5, pct: 100, start: '2026-10-28', end: '2026-10-28', loEnd: '2026-10-28', hiEnd: '2026-10-28', bStart: '2026-10-28', bEnd: '2026-10-28', started: true, done: true, updated: '2026-10-28T07:20:00.000000Z' },
  { key: 'TASK-0002', wp: 'WP-01', path: '1.1.2', title: 'PostgreSQL 연결', type: 'Configuration', domain: 'DevOps', rel: ['DB'], status: 'done', priority: 1, assignee: 'Claude', verifier: 'Codex', verif: 'pass', blocked: false, preds: ['TASK-0001'], cl: [2, 2], est: 1, lo: 0.5, hi: 2, pct: 100, start: '2026-10-29', end: '2026-10-29', loEnd: '2026-10-29', hiEnd: '2026-10-29', bStart: '2026-10-29', bEnd: '2026-10-29', started: true, done: true, updated: '2026-10-29T02:30:00.000000Z' },
  { key: 'TASK-0003', wp: 'WP-02', path: '1.2.1', title: 'Task 데이터 모델 설계', type: 'Analysis', domain: 'Architecture', rel: ['DB'], status: 'done', priority: 0, assignee: 'Codex', verifier: 'Claude', verif: 'pass', blocked: false, preds: ['TASK-0001'], cl: [3, 3], est: 3, lo: 2, hi: 5, pct: 100, start: '2026-10-29', end: '2026-10-30', loEnd: '2026-10-30', hiEnd: '2026-10-30', bStart: '2026-10-29', bEnd: '2026-10-30', started: true, done: true, updated: '2026-10-30T08:00:00.000000Z' },
  { key: 'TASK-0004', wp: 'WP-02', path: '1.2.2', title: 'Drizzle Schema 설계', type: 'Design', domain: 'DB', rel: ['BE'], status: 'qa', priority: 0, assignee: 'Claude', verifier: 'Codex', verif: 'running', blocked: false, preds: ['TASK-0002', 'TASK-0003'], cl: [3, 5], est: 4, lo: 3, hi: 6, pct: 65, start: '2026-11-03', end: '2026-11-05', loEnd: '2026-11-05', hiEnd: '2026-11-06', bStart: '2026-11-03', bEnd: '2026-11-05', started: true, done: false, updated: '2026-11-03T09:22:00.000000Z' },
  { key: 'TASK-0005', wp: 'WP-03', path: '2.1.1', title: 'Task CRUD API', type: 'Implementation', domain: 'BE', rel: ['API'], status: 'running', priority: 0, assignee: 'Claude', verifier: 'Codex', verif: 'none', blocked: false, preds: ['TASK-0003', 'TASK-0004'], cl: [1, 5], est: 6, lo: 4, hi: 10, pct: 35, start: '2026-11-03', end: '2026-11-06', loEnd: '2026-11-05', hiEnd: '2026-11-06', bStart: '2026-11-03', bEnd: '2026-11-06', started: true, done: false, updated: '2026-11-03T10:58:00.000000Z' },
  { key: 'TASK-0006', wp: 'WP-03', path: '2.1.2', title: 'Dependency 검증', type: 'Implementation', domain: 'BE', rel: [], status: 'ready', priority: 1, assignee: 'Claude', verifier: 'Codex', verif: 'none', blocked: true, preds: ['TASK-0005'], cl: [0, 3], est: 3, lo: 2, hi: 5, pct: 0, start: '2026-11-06', end: '2026-11-06', loEnd: '2026-11-06', hiEnd: '2026-11-07', bStart: '2026-11-06', bEnd: '2026-11-06', started: false, done: false, updated: '2026-11-02T01:00:00.000000Z' },
  { key: 'TASK-0007', wp: 'WP-04', path: '2.2.1', title: 'WBS Tree UI', type: 'Implementation', domain: 'FE', rel: [], status: 'rework', priority: 1, assignee: 'Claude', verifier: 'Codex', verif: 'fail', blocked: false, preds: ['TASK-0003'], cl: [2, 6], est: 5, lo: 3.5, hi: 9, pct: 40, start: '2026-11-01', end: '2026-11-05', loEnd: '2026-11-05', hiEnd: '2026-11-06', bStart: '2026-11-01', bEnd: '2026-11-05', started: true, done: false, updated: '2026-11-01T04:35:00.000000Z' },
  { key: 'TASK-0008', wp: 'WP-04', path: '2.2.2', title: 'Task Detail UI', type: 'Implementation', domain: 'FE', rel: [], status: 'ready', priority: 1, assignee: 'Claude', verifier: 'Codex', verif: 'none', blocked: true, preds: ['TASK-0005', 'TASK-0007'], cl: [0, 4], est: 6, lo: 4, hi: 10, pct: 0, start: '2026-11-06', end: '2026-11-06', loEnd: '2026-11-06', hiEnd: '2026-11-07', bStart: '2026-11-06', bEnd: '2026-11-06', started: false, done: false, updated: '2026-11-02T02:00:00.000000Z' },
  { key: 'TASK-0009', wp: 'WP-04', path: '2.2.3', title: 'Checklist 기능', type: 'Implementation', domain: 'FE', rel: ['BE', 'DB'], status: 'planning', priority: 2, assignee: 'Claude', verifier: 'Codex', verif: 'none', blocked: true, preds: ['TASK-0008'], cl: [0, 0], est: 4, lo: 3, hi: 7, pct: 0, start: '2026-11-06', end: '2026-11-06', loEnd: '2026-11-06', hiEnd: '2026-11-08', bStart: '2026-11-06', bEnd: '2026-11-06', started: false, done: false, updated: '2026-11-02T03:00:00.000000Z' },
  { key: 'TASK-0010', wp: 'WP-05', path: '3.1.1', title: 'Planning Workflow', type: 'Design', domain: 'Architecture', rel: [], status: 'approval', priority: 1, assignee: 'Codex', verifier: 'Claude', verif: 'none', blocked: false, preds: ['TASK-0003'], cl: [0, 2], est: 2.5, lo: 1.5, hi: 4, pct: 0, start: '2026-11-05', end: '2026-11-05', loEnd: '2026-11-05', hiEnd: '2026-11-06', bStart: '2026-11-05', bEnd: '2026-11-05', started: false, done: false, updated: '2026-11-02T04:00:00.000000Z' },
  { key: 'TASK-0011', wp: 'WP-05', path: '3.1.2', title: 'Completion Gate', type: 'Implementation', domain: 'BE', rel: ['QA'], status: 'planning', priority: 1, assignee: 'Claude', verifier: 'Codex', verif: 'none', blocked: true, preds: ['TASK-0009', 'TASK-0010'], cl: [0, 0], est: 3.5, lo: 2.5, hi: 6, pct: 0, start: '2026-11-06', end: '2026-11-06', loEnd: '2026-11-06', hiEnd: '2026-11-10', bStart: '2026-11-06', bEnd: '2026-11-06', started: false, done: false, updated: '2026-11-02T05:00:00.000000Z' },
  { key: 'TASK-0012', wp: 'WP-06', path: '3.2.1', title: 'Runner API 계약', type: 'Design', domain: 'API', rel: ['Architecture'], status: 'approval', priority: 0, assignee: 'Codex', verifier: 'Claude', verif: 'none', blocked: false, preds: ['TASK-0003'], cl: [0, 3], est: 2.5, lo: 1.5, hi: 4, pct: 0, start: '2026-11-05', end: '2026-11-05', loEnd: '2026-11-05', hiEnd: '2026-11-06', bStart: '2026-11-05', bEnd: '2026-11-05', started: false, done: false, updated: '2026-11-02T06:00:00.000000Z' },
];

const summary = (s: Seed): TaskSummary => ({
  id: `id-${s.key}`, taskKey: s.key, wbsNodeId: s.wp, wbsPath: s.path, title: s.title, workType: s.type, primaryDomain: s.domain,
  relatedDomains: s.rel, priority: s.priority, assigneeAgent: s.assignee, verifierAgent: s.verifier, lifecycleStatus: s.status,
  verifState: s.verif, blocked: s.blocked, preds: s.preds, checklist: { done: s.cl[0], total: s.cl[1] }, gate: { passed: 0, total: 5 },
  schedule: { estHours: s.est, loHours: s.lo, hiHours: s.hi, progressPct: s.pct, end: s.end, baselineEnd: s.bEnd },
  updatedAt: s.updated, deletedAt: null,
}) as TaskSummary;

export const TASKS: TaskSummary[] = SEEDS.map(summary);
export const TASK_LIST: TaskList = { nodes: NODES, tasks: TASKS };

const dayIndex = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 864e5);

export const SCHEDULE = {
  calcVersion: 3, at: '2026-11-05T11:00:00.000000Z',
  tasks: SEEDS.map((s) => ({
    taskKey: s.key, start: s.start, end: s.end, lo: s.loEnd, hi: s.hiEnd, estHours: s.est, loHours: s.lo, hiHours: s.hi,
    progressPct: s.pct, started: s.started, done: s.done, isNew: s.bEnd === null, baselineStart: s.bStart, baselineEnd: s.bEnd,
    slipDays: s.bEnd === null ? null : dayIndex(s.end) - dayIndex(s.bEnd),
    mid: { s: 0, e: 1 }, optimistic: { s: 0, e: 1 }, pessimistic: { s: 0, e: 1 },
  })),
  project: {
    start: '2026-10-27', end: '2026-11-06', lo: '2026-11-06', hi: '2026-11-10', baselineVersion: 1, baselineEnd: '2026-11-06',
    firstBaselineEnd: '2026-11-06', target: '2026-12-18', slipDays: 0, slackDays: 42, elapsedDays: 9, remainingDays: 1,
    totalHours: 42, doneHours: 5.5, remainHours: 36.5, progressPct: 30, plannedPct: 40, doneRatePct: 25, doneHoursRatePct: 13,
    doneCount: 3, taskCount: 12,
  },
  capacity: { days: [], measured: 0.69, enough: true, loggedHours: 80, rate: 0.69, rateLo: 0.6, rateHi: 0.8, todayRate: 0.7 },
  blackouts: [{ date: '2026-11-04', note: '사내 점검' }, { date: '2026-11-08', note: '휴무' }, { date: '2026-11-15', note: '휴무' }],
  warnings: [],
} as unknown as ScheduleData;

/** n개의 Task를 Phase 5개 · WP 20개에 나눠 담은 대량 목록(UAT-WBS-05 200/1,000행 측정). */
export function bulkList(count: number): TaskList {
  const nodes: WbsNode[] = [];
  const tasks: TaskSummary[] = [];
  const phases = 5;
  const wpsPer = 4;
  for (let p = 0; p < phases; p++) {
    nodes.push(node(`BP-${String(p + 1)}`, 'phase', null, String(p + 1), `대량 Phase ${String(p + 1)}`, p));
    for (let w = 0; w < wpsPer; w++) nodes.push(node(`BW-${String(p + 1)}-${String(w + 1)}`, 'work_package', `BP-${String(p + 1)}`, `${String(p + 1)}.${String(w + 1)}`, `대량 WP ${String(p + 1)}.${String(w + 1)}`, w));
  }
  const statuses = ['planning', 'ready', 'running', 'qa', 'done'];
  const per = Math.ceil(count / (phases * wpsPer));
  for (let i = 0; i < count; i++) {
    const g = Math.floor(i / per);
    const p = Math.floor(g / wpsPer) + 1;
    const w = (g % wpsPer) + 1;
    const n = (i % per) + 1;
    const key = `TASK-${String(i + 1).padStart(4, '0')}`;
    tasks.push(summary({
      key, wp: `BW-${String(p)}-${String(w)}`, path: `${String(p)}.${String(w)}.${String(n)}`, title: `대량 Task ${String(i + 1)}`,
      type: 'Implementation', domain: i % 2 ? 'FE' : 'BE', rel: [], status: statuses[i % statuses.length] ?? 'planning', priority: i % 4,
      assignee: i % 3 ? 'Claude' : 'Codex', verifier: i % 3 ? 'Codex' : 'Claude', verif: 'none', blocked: i % 7 === 0, preds: [], cl: [0, 2],
      est: 2, lo: 1, hi: 3, pct: 0, start: '2026-11-06', end: '2026-11-07', loEnd: '2026-11-07', hiEnd: '2026-11-08', bStart: '2026-11-06', bEnd: '2026-11-07',
      started: false, done: false, updated: '2026-11-02T06:00:00.000000Z',
    }));
  }
  return { nodes, tasks };
}
