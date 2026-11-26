/**
 * M3-07(대시보드·검증·이력) E2E용 가짜 API 데이터. 원본 Mock(2026-11-05 20:00 KST 스크린샷)과 같은 값으로 맞춰
 * 시각 비교에도 쓴다. 모양은 계약 타입(ResponseOf)이라 서버 계약과 어긋나면 typecheck가 실패한다.
 *
 * installM307(api, data)로 가짜 API에 붙인다. data를 바꿔(예: 목록 비우기) 빈 상태·필터 시험을 만든다.
 */
import type { ResponseOf } from '../../src/shared/api/contract.ts';
import { json, type FakeApi } from './fake-api.ts';

type Task = ResponseOf<'listTasks'>['tasks'][number];
type Verification = ResponseOf<'listVerifications'>['items'][number];
type Evidence = ResponseOf<'listEvidence'>['items'][number];
type Gate = ResponseOf<'listGates'>['items'][number];
type History = ResponseOf<'listHistory'>['items'][number];
type Attempt = ResponseOf<'getTaskAttempts'>['items'][number];
type TaskDetail = ResponseOf<'getTask'>;

/** KST 시각 → ISO(UTC) */
export const kst = (s: string) => new Date(`${s.replace(' ', 'T')}:00+09:00`).toISOString();

const TASKS: [string, string, string][] = [
  ['TASK-0001', 'Monorepo 구성', 'done'], ['TASK-0002', 'Docker Compose 개발 환경', 'done'], ['TASK-0003', '데이터 모델 설계', 'done'],
  ['TASK-0004', 'Drizzle Schema 설계', 'qa'], ['TASK-0005', 'Task CRUD API', 'running'], ['TASK-0006', 'Dependency 검증', 'ready'],
  ['TASK-0007', 'WBS Tree UI', 'rework'], ['TASK-0008', 'Task Detail UI', 'ready'], ['TASK-0009', 'Checklist 기능', 'planning'],
  ['TASK-0010', 'Planning Workflow', 'approval'], ['TASK-0011', 'Completion Gate', 'planning'], ['TASK-0012', 'Runner API 계약', 'approval'],
];
export const tasks = (): Task[] => TASKS.map(([taskKey, title, status], i) => ({
  id: `t${String(i + 1)}`, taskKey, wbsNodeId: 'wp1', wbsPath: `1.1.${String(i + 1)}`, title, workType: 'Implementation', primaryDomain: 'FE',
  relatedDomains: [], priority: 2, assigneeAgent: 'Claude', verifierAgent: 'Codex', lifecycleStatus: status, verifState: 'none', blocked: false,
  preds: [], checklist: { done: 0, total: taskKey === 'TASK-0007' ? 2 : 0 }, gate: { passed: 0, total: 5 }, schedule: null, updatedAt: kst('2026-11-03 10:00'), deletedAt: null,
} as unknown as Task));

/** 원본 UI-07-03 스크린샷의 조건 값(P Sel.gate) */
const GATE_ROWS: Record<string, string> = {
  'TASK-0001': 'PPPPP', 'TASK-0002': 'PPPPP', 'TASK-0003': 'PPPPP',
  'TASK-0004': 'FFBPP', 'TASK-0005': 'FFBPP', 'TASK-0006': 'FFBPP', 'TASK-0007': 'FFFFP', 'TASK-0008': 'FFBPP',
  'TASK-0009': 'FFBPB', 'TASK-0010': 'PPBPB', 'TASK-0011': 'FFBPB', 'TASK-0012': 'FPBPB',
};
const GATE_KEYS = ['checklist', 'outputs', 'verification', 'defects', 'approval'] as const;
const LETTER: Record<string, string> = { P: 'PASS', F: 'FAIL', B: 'BLOCKED' };
export const gates = (): Gate[] => Object.entries(GATE_ROWS).map(([taskKey, s]) => ({
  taskKey, passed: s === 'PPPPP',
  conditions: GATE_KEYS.map((key, i) => ({ key, result: LETTER[s[i] ?? 'P'], reason: `${taskKey} ${key} 사유 ${s[i] ?? ''}` })),
} as unknown as Gate));

export const verifications = (): Verification[] => [
  {
    id: 'v-0007-1', taskKey: 'TASK-0007', attemptId: 'att-0007-2', result: 'FAIL', headSha: 'b'.repeat(40), specRevision: 2,
    cmd: 'pnpm --filter web test -- tree', expected: '14건 모두 통과', actual: '12/14 통과 — 필터 시 상위 Phase 행 누락, 1,000행 펼치기 412ms',
    defects: [
      { defKey: 'D-1', text: '필터 적용 시 상위 Phase 행이 사라짐', blocking: true, resolved: false },
      { defKey: 'D-2', text: '1,000행 펼치기 412ms(기준 300ms 초과)', blocking: true, resolved: false },
    ],
    invalidated: false, at: kst('2026-11-01 13:35'),
  },
  {
    id: 'v-0001-1', taskKey: 'TASK-0001', attemptId: 'att-0001-2', result: 'PASS', headSha: 'c'.repeat(40), specRevision: 1,
    cmd: 'pnpm install && pnpm -r build', expected: '종료 코드 0', actual: '종료 코드 0 (52.4s)', defects: [], invalidated: false, at: kst('2026-10-28 16:20'),
  },
] as unknown as Verification[];

export const attempts = (taskKey: string): Attempt[] => ({
  'TASK-0007': [{ id: 'att-0007-2', attemptKey: 'ATT-0007-2', agent: 'Codex' }, { id: 'att-0007-1', attemptKey: 'ATT-0007-1', agent: 'Claude' }],
  'TASK-0001': [{ id: 'att-0001-2', attemptKey: 'ATT-0001-2', agent: 'Codex' }],
}[taskKey] ?? []).map((a) => ({
  ...a, taskKey, kind: 'qa', status: 'completed', startedAt: kst('2026-11-01 13:10'), endedAt: null, modelId: null, effort: null, gradeAdjust: null,
  summary: null, failure: null, tokens: null, resumedFrom: null, baseSha: null, headSha: null, changedFiles: [], updatedAt: kst('2026-11-01 13:10'),
} as unknown as Attempt));

const sha = (c: string) => c.repeat(64);
export const evidence = (): Evidence[] => [
  { id: 'e1', taskKey: 'TASK-0007', attemptId: 'att-0007-2', verificationId: 'v-0007-1', checklistItemKey: null, kind: '로그', sha256: sha('a'), size: 120 },
  { id: 'e2', taskKey: 'TASK-0007', attemptId: 'att-0007-2', verificationId: 'v-0007-1', checklistItemKey: null, kind: '측정 데이터', sha256: sha('b'), size: 80 },
  { id: 'e3', taskKey: 'TASK-0007', attemptId: 'att-0007-2', verificationId: 'v-0007-1', checklistItemKey: null, kind: '스크린샷', sha256: sha('c'), size: 4000 },
  { id: 'e4', taskKey: 'TASK-0001', attemptId: 'att-0001-2', verificationId: 'v-0001-1', checklistItemKey: null, kind: '로그', sha256: sha('d'), size: 300 },
  { id: 'e5', taskKey: 'TASK-0001', attemptId: 'att-0001-2', verificationId: 'v-0001-1', checklistItemKey: null, kind: '로그', sha256: sha('e'), size: 310 },
];

export const taskDetail = (taskKey: string, checklist: { itemKey: string; content: string; evidence: string | null }[], updatedAt = kst('2026-11-03 10:00')): TaskDetail => ({
  ...tasks().find((t) => t.taskKey === taskKey),
  updatedAt,
  checklistItems: checklist.map((c) => ({ ...c, required: true, done: false, verifyMethod: null, note: null })),
} as unknown as TaskDetail);

const H = (at: string, actor: string, kind: string, taskKey: string | null, text: string, before: string | null = null, after: string | null = null, i = 0): History =>
  ({ id: `h${at}${String(i)}`, at: kst(at), actor, taskKey, kind, text, before, after, ref: null });
/** 원본 UI-10 스크린샷의 이력(최신순) */
export const history = (): History[] => [
  H('2026-11-03 19:58', 'Runner', '실행', 'TASK-0005', 'ATT-0005-1 개발 실행 시작 (Claude) — Runner 재부팅 후 재연결', '실행 대기', '실행 중'),
  H('2026-11-03 19:42', '팀장', '메시지', 'TASK-0005', 'MSG-003 질문 → Codex 전달 실패', 'Queued', 'Failed'),
  H('2026-11-03 19:30', '팀장', '변경 제안', 'TASK-0006', 'CP-002 제출 — 승인 전 WBS 미반영', null, '승인 대기'),
  H('2026-11-03 18:22', 'Runner', '실행', 'TASK-0004', 'ATT-0004-2 Codex QA 시작'),
  H('2026-11-03 17:48', 'Runner', '실행', 'TASK-0004', 'ATT-0004-1 완료 — Seed 스크립트 미제출', '실행 중', 'QA 진행'),
  H('2026-11-02 17:12', '팀장', '재계획', 'TASK-0012', 'CP-001 반영 — 신규 Task 생성', 'NEW-1', 'TASK-0012'),
  H('2026-11-02 10:20', '팀장', '승인', 'TASK-0005', '착수 승인', '승인 대기', '실행 대기'),
  H('2026-11-01 14:02', '팀장', '메시지', 'TASK-0007', 'MSG-001 수정 요청 → Claude', null, 'Acknowledged'),
  H('2026-11-01 13:35', 'Codex', '검증', 'TASK-0007', 'V-0007-1 QA FAIL — 차단 결함 2건', 'QA 진행', '재작업 필요'),
  H('2026-11-01 11:40', 'Runner', '실행', 'TASK-0007', 'ATT-0007-1 완료, QA 요청', '실행 중', 'QA 진행'),
  H('2026-11-01 10:02', 'Runner', '실행', 'TASK-0007', 'ATT-0007-1 개발 실행 시작 (Claude)', '실행 대기', '실행 중'),
  H('2026-10-30 09:12', '팀장', '생성', 'TASK-0007', 'Task 생성'),
  H('2026-10-28 16:40', '팀장', '완료', 'TASK-0001', 'Completion Gate 5/5 통과 — 완료 처리', 'QA 진행', '완료'),
  ...['TASK-0001', 'TASK-0002', 'TASK-0003', 'TASK-0004', 'TASK-0005', 'TASK-0006'].map((k, i) => H('2026-10-27 10:00', '팀장', '생성', k, 'Task 생성 (초기 WBS)', null, null, 9 - i)),
  // 원본은 24건이다. 화면 아래(스크롤 밖) 5건은 같은 초기 WBS 생성 기록으로 채운다.
  ...['TASK-0008', 'TASK-0009', 'TASK-0010', 'TASK-0011', 'TASK-0006'].map((k, i) => H('2026-10-27 09:00', '팀장', '생성', k, 'Task 생성 (초기 WBS)', null, null, 9 - i)),
];

type Dash = ResponseOf<'getDashboard'>;
export const dashboard = (): Dash => ({
  at: kst('2026-11-05 20:00'),
  tasks: { total: 12, done: 3, active: 3, blocked: 4 },
  byWorkType: [['Analysis', 1], ['Design', 3], ['Implementation', 6], ['Configuration', 2], ['Test', 0], ['Verification', 0], ['Documentation', 0], ['Integration', 0]].map(([key, count]) => ({ key, count })),
  byDomain: [['FE', 3], ['BE', 3], ['DB', 1], ['DevOps', 2], ['API', 1], ['QA', 0], ['Architecture', 2], ['Common', 0]].map(([key, count]) => ({ key, count })),
  schedule: {
    start: '2026-10-27', end: '2026-11-06', lo: '2026-11-06', hi: '2026-11-10', baselineVersion: 1, baselineEnd: '2026-11-06', firstBaselineEnd: '2026-11-06',
    target: '2026-12-18', slipDays: 0, slackDays: 42, elapsedDays: 9, remainingDays: 1, totalHours: 42, doneHours: 5.5, remainHours: 29.3,
    progressPct: 30, plannedPct: 54, doneRatePct: 25, doneHoursRatePct: 13, doneCount: 3, taskCount: 12, rate: 0.69,
  },
  panels: {
    late: [],
    approvals: [
      { kind: 'planning', id: 'pln-001', title: 'Workflow Phase 상세화 — Runner 메시지 · 응답 연동', unresolved: 3 },
      { kind: 'proposal', id: 'CP-002', title: 'Dependency 검증을 Task CRUD API와 병행 착수', status: 'review' },
    ],
    executions: [
      { kind: 'running', taskKey: 'TASK-0004', title: 'Drizzle Schema 설계', attemptId: 'att-0004-2', attemptKind: 'qa', agent: 'Codex' },
      { kind: 'running', taskKey: 'TASK-0005', title: 'Task CRUD API', attemptId: 'att-0005-1', attemptKind: 'dev', agent: 'Claude' },
    ],
    rework: [{ taskKey: 'TASK-0007', title: 'WBS Tree UI', verificationId: 'v-0007-1', result: 'FAIL', defects: 2 }],
    gate: [],
    messages: [
      { id: 'm2', msgKey: 'MSG-002', taskKey: 'TASK-0007', attemptId: null, dir: 'in', type: '응답', toAgent: 'Claude', body: '', delivery: null, pendingNext: false, workState: null, failReason: null, readAt: null, createdAt: kst('2026-11-01 14:30'), updatedAt: kst('2026-11-01 14:30') },
      { id: 'm3', msgKey: 'MSG-003', taskKey: 'TASK-0005', attemptId: null, dir: 'out', type: '질문', toAgent: 'Codex', body: '', delivery: 'Failed', pendingNext: false, workState: null, failReason: 'x', readAt: null, createdAt: kst('2026-11-03 19:42'), updatedAt: kst('2026-11-03 19:42') },
    ],
  },
  recent: [
    { kind: 'attempt', at: kst('2026-11-03 19:58'), id: 'att-0005-1', taskKey: 'TASK-0005', agent: 'Claude', text: '개발 · Claude — Route 등록 완료, Service 계층 작성 중.', status: 'running' },
    { kind: 'attempt', at: kst('2026-11-03 18:22'), id: 'att-0004-2', taskKey: 'TASK-0004', agent: 'Codex', text: 'QA · Codex — 빈 DB에서 migrate 및 제약 위반 SQL 실행 중.', status: 'running' },
    { kind: 'attempt', at: kst('2026-11-03 15:10'), id: 'att-0004-1', taskKey: 'TASK-0004', agent: 'Claude', text: '개발 · Claude — Schema 4종과 Migration 생성. Seed 스크립트는 미작성.', status: 'completed' },
    { kind: 'verification', at: kst('2026-11-01 13:35'), id: 'v-0007-1', taskKey: 'TASK-0007', agent: 'Codex', text: 'Codex — 12/14 통과 — 필터 시 상위 Phase 행 누락, 1,000행 펼치기 412ms', result: 'FAIL' },
    { kind: 'attempt', at: kst('2026-11-01 13:10'), id: 'att-0007-2', taskKey: 'TASK-0007', agent: 'Codex', text: 'QA · Codex — 기능 · 성능 QA — 14건 중 2건 FAIL (V-0007-1). 재작업 요청.', status: 'completed' },
    { kind: 'attempt', at: kst('2026-11-01 10:02'), id: 'att-0007-1', taskKey: 'TASK-0007', agent: 'Claude', text: '개발 · Claude — Tree 평탄화 훅과 Table 컴포넌트 구현, 필터 9종 연결.', status: 'completed' },
    { kind: 'verification', at: kst('2026-10-28 16:20'), id: 'v-0001-1', taskKey: 'TASK-0001', agent: 'Codex', text: 'Codex — 종료 코드 0 (52.4s)', result: 'PASS' },
    { kind: 'attempt', at: kst('2026-10-28 15:30'), id: 'att-0001-2', taskKey: 'TASK-0001', agent: 'Codex', text: 'QA · Codex — 클린 컨테이너 설치·빌드 검증 — PASS (V-0001-1).', status: 'completed' },
  ],
  grades: [
    { agent: 'Claude', modelId: 'Opus 5.5', effort: 'high', attempts: 3, judged: 1, fails: 1, reworkRatePct: 100, escalations: 0, tokens: 1_050_000 },
    { agent: 'Claude', modelId: 'Sonnet 5.5', effort: 'low', attempts: 1, judged: 1, fails: 0, reworkRatePct: 0, escalations: 0, tokens: 210_000 },
  ],
  alerts: [],
} as unknown as Dash);

type AlertList = ResponseOf<'listAlerts'>;
export const alerts = (): AlertList['items'] => [
  { id: 'al1', key: 'input_history_rewritten', severity: 'warn', taskKey: null, target: null, text: '입력 자료 변경 커밋 2개 — 프로젝트 → 입력 자료에서 확인 후 분석', at: kst('2026-11-05 21:45') },
  { id: 'al2', key: 'drift:open', severity: 'warn', taskKey: null, target: null, text: '설계 불일치 2건 — 계약 파일과 Task 브랜치 코드가 다름 · 설계 → 변경 · 불일치', at: kst('2026-11-05 18:02') },
];

export const RUNNER_M307 = {
  connection: { online: true, runnerId: 'r1', version: '1', lastHeartbeatAt: null, sessionStartedAt: null },
  concurrency: { limit: 10, caps: { total: 16, Claude: 8, Codex: 8, heavy: 2 } },
} as unknown as ResponseOf<'getRunnerState'>;

export interface M307Data {
  dashboard: Dash;
  alerts: AlertList['items'];
  tasks: Task[];
  verifications: Verification[];
  evidence: Evidence[];
  gates: Gate[];
  history: History[];
  details: Map<string, TaskDetail>;
}

export const m307Data = (): M307Data => ({
  dashboard: dashboard(), alerts: alerts(), tasks: tasks(), verifications: verifications(), evidence: evidence(), gates: gates(), history: history(),
  details: new Map([
    ['TASK-0007', taskDetail('TASK-0007', [
      { itemKey: 'CL-0007-1', content: '필터 시 상위 행 유지', evidence: null },
      { itemKey: 'CL-0007-2', content: '1,000행 300ms 이내', evidence: null },
    ])],
    ['TASK-0001', taskDetail('TASK-0001', [])],
  ]),
});

/** Asia/Seoul 날짜(YYYY-MM-DD) */
const seoulDate = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);

/** 가짜 API에 M3-07 요청을 붙인다. 목록 요청은 쪽 나눔(cursor)도 흉내 낸다(limit보다 많으면 nextCursor). */
export function installM307(api: FakeApi, data: M307Data): void {
  const page = <T,>(items: T[], url: URL) => {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const slice = items.slice(start, start + limit);
    return { items: slice, nextCursor: start + limit < items.length ? String(start + limit) : null };
  };
  api.on('GET /api/runner-state', (route) => json(route, 200, RUNNER_M307));
  api.on('GET /api/dashboard', (route) => json(route, 200, data.dashboard));
  api.on('GET /api/alerts', (route) => json(route, 200, { items: data.alerts }));
  api.on('GET /api/projects/p1/tasks', (route) => json(route, 200, { nodes: [], tasks: data.tasks }));
  api.on('GET /api/gates', (route) => json(route, 200, { items: data.gates }));
  api.on('GET /api/verifications', (route, req) => json(route, 200, page(data.verifications, new URL(req.url()))));
  api.on('GET /api/evidence', (route, req) => json(route, 200, page(data.evidence, new URL(req.url()))));
  api.on('GET /api/history', (route, req) => {
    const url = new URL(req.url());
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const rows = data.history.filter((h) => (!from || seoulDate(h.at) >= from) && (!to || seoulDate(h.at) <= to));
    return json(route, 200, page(rows, url));
  });
  for (const taskKey of ['TASK-0001', 'TASK-0007']) {
    api.on(`GET /api/tasks/${taskKey}/attempts`, (route) => json(route, 200, { items: attempts(taskKey), nextCursor: null }));
  }
  for (const t of data.tasks) {
    api.on(`GET /api/tasks/${t.taskKey}`, (route) => (data.details.has(t.taskKey)
      ? json(route, 200, data.details.get(t.taskKey))
      : json(route, 200, taskDetail(t.taskKey, []))));
  }
}
