/**
 * M3-05 E2E 자료 — Planning·변경 제안 화면의 가짜 API 응답과, 승인·반영을 따라가는 작은 상태 저장소.
 * 내용은 원본 스크린샷(desktop-clock20261105/UI-05·UI-05-02·UI-09)과 같은 글자로 맞췄다(시각 비교용).
 * 모양은 계약 타입(ResponseOf)이다. 계약의 열거값 합집합 때문에 객체 리터럴은 `as unknown as`로 바꿔 쓴다.
 */
import type { Route } from '@playwright/test';
import type { ResponseOf } from '../../src/shared/api/contract.ts';
import { errorBody, json, type FakeApi } from './fake-api.ts';

export type Proposal = ResponseOf<'listProposals'>['items'][number];
export type Planning = ResponseOf<'listPlannings'>['items'][number];
type Preview = ResponseOf<'previewProposal'>;

const task = (taskKey: string, title: string, lifecycleStatus: string, preds: string[] = []) => ({
  id: `id-${taskKey}`, taskKey, wbsNodeId: 'wp-6', wbsPath: '1.2', title, workType: 'Implementation', primaryDomain: 'BE', relatedDomains: [],
  priority: 2, assigneeAgent: 'Codex', verifierAgent: 'Claude', lifecycleStatus, verifState: 'none', blocked: false, preds,
  checklist: { done: 0, total: 0 }, gate: { passed: 0, total: 0 }, schedule: null, updatedAt: '2026-11-03T00:00:00.000Z', deletedAt: null,
});
export const TASKS = {
  nodes: [],
  tasks: [
    task('TASK-0004', 'Checklist 데이터 모델', 'done'),
    task('TASK-0005', 'Task CRUD API', 'ready'),
    task('TASK-0006', 'Dependency 검증', 'ready', ['TASK-0005']),
    task('TASK-0007', 'Gantt 화면', 'planning', ['TASK-0005', 'TASK-0008']),
    task('TASK-0008', 'Runner 메시지 처리', 'running'),
    task('TASK-0009', 'Checklist API', 'ready'),
    task('TASK-0010', 'Runner API 계약', 'ready'),
    task('TASK-0011', 'Completion Gate', 'planning', ['TASK-0009']),
    task('TASK-0012', 'Runner 메시지 송수신', 'planning'),
  ],
} as unknown as ResponseOf<'listTasks'>;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const PLN1 = uuid(901);
export const PLN0 = uuid(900);

export function cp(n: number, over: Record<string, unknown>): Proposal {
  return {
    id: uuid(n), cpKey: `CP-${String(n).padStart(3, '0')}`, title: '', reason: '', source: { kind: 'manual', id: null }, status: 'review',
    ops: [], idMap: {}, splitJudgements: null, taskJudgements: [], holdReasons: [], issues: [], events: [],
    createdAt: '2026-11-03T10:30:00.000Z', updatedAt: '2026-11-03T10:30:00.000Z', ...over,
  } as unknown as Proposal;
}

/** 원본 UI-09의 CP-002(승인 대기, SS로 바꿔 병행 착수) */
export const CP2 = cp(2, {
  title: 'Dependency 검증을 Task CRUD API와 병행 착수',
  reason: 'Service 계층의 순환 검사 로직은 CRUD Route와 독립적이므로 선행 관계를 시작→시작(SS)으로 바꿔 병행한다.',
  ops: [{ op: 'dep-remove', pred: 'TASK-0005', succ: 'TASK-0006' }, { op: 'dep-add', pred: 'TASK-0005', succ: 'TASK-0006', type: 'SS' }],
  events: [{ at: '2026-11-03T10:30:00.000Z', actor: '팀장', action: 'submitted', comment: '' }],
});
export const CP1 = cp(1, {
  title: 'Runner API 계약 Task 추가', reason: '초기 WBS 수립 결과', status: 'applied', source: { kind: 'planning', id: PLN0 },
  ops: [{ op: 'add', ref: 'NEW-1', preds: [], t: { title: 'Runner API 계약', type: 'Design', domain: 'API', wp: 'wp-6', priority: 1, assignee: 'Codex', verifier: 'Claude', purpose: '', doneCond: '' } }],
  idMap: { 'NEW-1': 'TASK-0010' }, createdAt: '2026-11-01T01:00:00.000Z',
  events: [{ at: '2026-11-01T01:00:00.000Z', actor: 'Planning', action: 'created', comment: '' }, { at: '2026-11-01T01:05:00.000Z', actor: '팀장', action: 'applied', comment: '' }],
});
/** 취소 CP(D-27): TASK-0005를 취소하면 TASK-0006은 풀리고 TASK-0007은 TASK-0008 때문에 계속 막힌다. */
export const CP3 = cp(3, {
  title: 'Task CRUD API 취소', reason: '범위 축소 — 기존 API 재사용', ops: [{ op: 'remove', task: 'TASK-0005' }],
  events: [{ at: '2026-11-04T01:00:00.000Z', actor: '팀장', action: 'submitted', comment: '' }], createdAt: '2026-11-04T01:00:00.000Z', updatedAt: '2026-11-04T01:00:00.000Z',
});
/** 보류된 Planning CP(D-33~35): 판단 불충족 + 진행 중 Task 새 차단 */
const judged = (rule: string, result: string, basis: string) => ({ rule, result, agreedBy: ['Claude', 'Codex'], basis, judgedAt: '2026-11-04T02:00:00.000Z', sourceRef: 'job-7', subjectHash: 'a'.repeat(64) });
export const CP4 = cp(4, {
  title: 'Runner 메시지 처리 분할', reason: 'Planning 분할 판단', status: 'held', source: { kind: 'planning', id: PLN1 },
  ops: [
    { op: 'add', ref: 'NEW-1', preds: [], t: { title: '메시지 수신 처리', type: 'Implementation', domain: 'BE', wp: 'wp-6', priority: 1, assignee: 'Codex', verifier: 'Claude', purpose: '', doneCond: '', judgedRules: { schemaVersion: 1, items: [judged('refactor', 'not_met', '리팩터링이 기능 변경과 섞임')] } } },
    { op: 'dep-add', pred: 'TASK-0009', succ: 'TASK-0008', type: 'FS' },
  ],
  idMap: { 'NEW-1': 'TASK-0013' },
  taskJudgements: [{ taskKey: 'TASK-0008', judgedRules: { schemaVersion: 1, items: [judged('revert', 'met', '되돌리기 쉬운 단위')] } }],
  holdReasons: [
    { code: 'JUDGEMENT_NOT_MET', taskKey: 'TASK-0013', rule: 'refactor', message: '규칙 9 판단이 불충족입니다.' },
    { code: 'ACTIVE_TASK_BLOCKED', taskKey: 'TASK-0008', message: '실행 중인 TASK-0008을 새로 차단합니다.' },
  ],
  events: [{ at: '2026-11-04T02:00:00.000Z', actor: 'Planning', action: 'created', comment: '' }, { at: '2026-11-04T02:00:01.000Z', actor: 'Planning', action: 'held', comment: '' }],
  createdAt: '2026-11-04T02:00:00.000Z', updatedAt: '2026-11-04T02:00:01.000Z',
});

export const preview = (p: Proposal, over: Partial<Preview> = {}): Preview => ({
  previewHash: `hash-${p.cpKey}-${p.updatedAt}`, issues: [], holdReasons: p.holdReasons, idMap: p.idMap, diff: [],
  impact: { removedDependencies: [], unblockedSuccessors: [] }, ...over,
} as Preview);
export const PREVIEWS: Record<string, Partial<Preview>> = {
  'CP-002': {
    diff: [{ index: 0, op: 'dep-remove', target: 'TASK-0006', field: 'pred', before: 'TASK-0005 (FS)', after: null }],
    impact: { removedDependencies: [{ pred: 'TASK-0005', succ: 'TASK-0006', type: 'FS', reason: 'dep-remove' }], unblockedSuccessors: [{ taskKey: 'TASK-0006', remainingBlockers: [] }] },
  } as Partial<Preview>,
  'CP-003': {
    impact: {
      removedDependencies: [
        { pred: 'TASK-0005', succ: 'TASK-0006', type: 'SS', reason: 'pred-cancelled' },
        { pred: 'TASK-0005', succ: 'TASK-0007', type: 'FS', reason: 'pred-cancelled' },
      ],
      unblockedSuccessors: [
        { taskKey: 'TASK-0006', remainingBlockers: [] },
        { taskKey: 'TASK-0007', remainingBlockers: [{ pred: 'TASK-0008', succ: 'TASK-0007', type: 'FS', predStatus: 'running' }] },
      ],
    },
  } as Partial<Preview>,
};

const rv = (id: string, topic: string, kind: string, codex: string, claude: string, extra: Record<string, unknown> = {}) => ({
  id, topic, kind, codex, claude, choice: null, memo: '', ops: [], codexOps: [], claudeOps: [], updatedAt: '2026-11-03T03:00:00.000Z', ...extra,
});
const mod = (task: string, field: string, after: unknown) => ({ op: 'modify', task, field, after });
/** 원본 UI-05의 PLN-001(이견 3건 미조정) */
export const PLANNING1 = {
  id: PLN1, title: 'Workflow Phase 상세화 — Runner 메시지 · 응답 연동', scope: 'WP-05 Planning · Gate, WP-06 Runner 연동',
  analyses: [
    { agent: 'Codex', at: '2026-11-03T02:05:00.000Z', summary: 'Runner 메시지 응답 처리가 WBS에 빠져 있습니다. Message 상태 머신은 별도 설계 Task로 분리하는 것이 검증에 유리합니다.',
      items: ['WP-06에 「Runner 응답 수신 처리」 BE Task 추가 필요', 'Message 상태 머신(Draft~Cancelled)을 별도 설계 Task로 분리', 'TASK-0011 Completion Gate의 선행 TASK-0009 유지 — Checklist 데이터 확정 후 구현', 'TASK-0012 완료 조건에 ack와 작업 완료 보고 분리를 명시', 'TASK-0010 우선순위는 현행(높음) 유지'] },
    { agent: 'Claude', at: '2026-11-03T02:40:00.000Z', summary: '응답 수신 Task 추가에 동의합니다. Gate는 Checklist 데이터 모델(TASK-0004)만 있으면 BE 구현이 가능하므로 선행을 조정하는 편이 일정에 유리합니다.',
      items: ['WP-06에 「Runner 응답 수신 처리」 BE Task 추가 — 동의', 'Message 상태 머신은 TASK-0012 계약 범위에 포함 — 별도 Task 불필요', 'TASK-0011 선행을 TASK-0009 → TASK-0005로 교체', 'TASK-0012 완료 조건 보강 — 동의', 'TASK-0010 우선순위를 긴급으로 상향 (Runner 계약과 병행 검토)'] },
  ],
  reviews: [
    rv('rv-1', 'Runner 응답 수신 처리 Task 추가', 'agree', 'WP-06에 BE Task 추가, 선행 TASK-0012', '동일 의견', {
      ops: [{ op: 'add', ref: 'NEW-1', preds: [{ pred: 'TASK-0012', type: 'FS' }], t: { title: 'Runner 응답 수신 처리', type: 'Implementation', domain: 'BE', wp: 'wp-6', priority: 1, assignee: 'Codex', verifier: 'Claude', purpose: '', doneCond: '' } }],
    }),
    rv('rv-2', 'TASK-0012 완료 조건 보강', 'agree', 'ack와 작업 완료 보고를 분리해 명시', '동일 의견', {
      ops: [mod('TASK-0012', 'doneCond', 'ack(수신 확인)와 작업 완료 보고가 별도 이벤트로 정의되고, Codex · Claude 교차 검토 후 팀장 승인')],
    }),
    rv('rv-3', 'Message 상태 머신 설계 위치', 'diff', '별도 설계 Task 「Message 상태 머신 설계」(설계 / Architecture)를 WP-06에 추가', 'TASK-0012 작업 범위에 포함 — 별도 Task 불필요', {
      codexOps: [{ op: 'add', ref: 'NEW-2', preds: [], t: { title: 'Message 상태 머신 설계', type: 'Design', domain: 'Architecture', wp: 'wp-6', priority: 2, assignee: 'Claude', verifier: 'Codex', purpose: '', doneCond: '' } }],
      claudeOps: [mod('TASK-0012', 'scopeAdd', 'Message 상태 머신(Draft~Cancelled) 정의')],
    }),
    rv('rv-4', 'TASK-0011 선행 관계', 'diff', '선행 TASK-0009 유지', '선행을 TASK-0005로 교체', {
      claudeOps: [{ op: 'dep-remove', pred: 'TASK-0009', succ: 'TASK-0011' }, { op: 'dep-add', pred: 'TASK-0005', succ: 'TASK-0011', type: 'FS' }],
    }),
    rv('rv-5', 'TASK-0010 우선순위', 'diff', '현행(높음) 유지', '긴급으로 상향', { claudeOps: [mod('TASK-0010', 'priority', 0)] }),
  ],
  proposalId: null, createdAt: '2026-11-03T01:20:00.000Z', updatedAt: '2026-11-03T03:00:00.000Z',
} as unknown as Planning;
export const PLANNING0 = {
  id: PLN0, title: '초기 WBS 수립 — Runner API 계약 분리', scope: '전체', analyses: [], reviews: [], proposalId: CP1.id,
  createdAt: '2026-10-27T01:20:00.000Z', updatedAt: '2026-10-27T01:20:00.000Z',
} as unknown as Planning;

export const RP1 = {
  replanId: 'RP-001', baselineVersion: 1, projectEnd: '2026-11-06', range: { lo: '2026-11-06', hi: '2026-11-07' }, moved: [],
  trigger: '초기 WBS 등록 — Planning Agent 추정 (가동률 85% 가정)', actor: 'Planning Agent (Codex · Claude 합의)', status: 'applied', rate: 0.85, at: '2026-10-27T01:20:00.000Z',
};
export const SCHEDULE = {
  calcVersion: 1, at: '2026-11-05T11:00:00.000Z', tasks: [],
  project: { start: '2026-10-27', end: '2026-11-06', lo: '2026-11-06', hi: '2026-11-10', baselineVersion: 1, baselineEnd: '2026-11-06', firstBaselineEnd: '2026-11-06', target: null, slipDays: 0, slackDays: null },
} as unknown as ResponseOf<'getSchedule'>;
export const POLICY = { autoReplan: true, cpAuto: false, thresholdDays: 1, assumeRate: 0.85, windowDays: 14, minHours: 1, updatedAt: '2026-11-01T00:00:00.000Z' } as unknown as ResponseOf<'getScheduleSettings'>;

/**
 * 상태가 있는 가짜 서버. 승인·반려·제출·반영을 계약대로 상태를 바꾸고 updatedAt을 올린다.
 * 보류 사유가 있으면 승인·반영은 409(계약 §2.1), 다른 버전이면 409 VERSION_CONFLICT.
 */
export function planningServer(api: FakeApi, init: { proposals?: Proposal[]; plannings?: Planning[]; replans?: unknown[]; previews?: Record<string, Partial<Preview>> } = {}) {
  const state = {
    proposals: [...(init.proposals ?? [CP4, CP3, CP2, CP1])],
    plannings: [...(init.plannings ?? [PLANNING1, PLANNING0])],
    replans: [...(init.replans ?? [RP1])],
    previews: { ...PREVIEWS, ...(init.previews ?? {}) },
    tick: 0,
  };
  const stamp = () => { state.tick += 1; return `2026-11-05T11:00:${String(state.tick).padStart(2, '0')}.000Z`; };
  const byId = (id: string) => state.proposals.find((p) => p.id === id);
  const page = <T>(items: T[], url: URL) => {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null };
  };
  const previewOf = (p: Proposal) => preview(p, state.previews[p.cpKey] ?? {});

  api.on('GET /api/projects/p1/tasks', (route) => json(route, 200, TASKS));
  api.on('GET /api/proposals', (route, request) => json(route, 200, page(state.proposals, new URL(request.url()))));
  api.on('GET /api/plannings', (route, request) => json(route, 200, page(state.plannings, new URL(request.url()))));
  api.on('GET /api/replans', (route, request) => json(route, 200, page(state.replans, new URL(request.url()))));
  api.on('GET /api/schedule', (route) => json(route, 200, SCHEDULE));
  api.on('GET /api/settings/schedule', (route) => json(route, 200, POLICY));

  const transition = (to: string, eventAction: string, needsHash: boolean) => async (route: Route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/')[3] ?? '';
    const p = byId(id);
    if (!p) return json(route, 404, errorBody('NOT_FOUND'));
    const body = route.request().postDataJSON() as { updatedAt: string; comment?: string; previewHash?: string };
    if (body.updatedAt !== p.updatedAt) return json(route, 409, errorBody('VERSION_CONFLICT', { message: '다른 곳에서 먼저 바뀌었습니다.', details: { current: p, changes: [] } }));
    if (needsHash && p.holdReasons.length) {
      return json(route, 409, errorBody('ACTIVE_TASK_BLOCKED', { message: '진행 중인 Task를 새로 차단하므로 변경 제안을 보류합니다.', details: { holdReasons: p.holdReasons } }));
    }
    if (needsHash && body.previewHash !== previewOf(p).previewHash) return json(route, 409, errorBody('VERSION_CONFLICT', { message: '미리보기 뒤에 변경 결과가 달라졌습니다.' }));
    const next = { ...p, status: to, updatedAt: stamp(), events: [...p.events, { at: '2026-11-05T11:00:00.000Z', actor: '팀장', action: eventAction, comment: body.comment ?? '' }] } as Proposal;
    state.proposals = state.proposals.map((x) => (x.id === id ? next : x));
    if (to === 'applied') return json(route, 200, { proposal: next, ...previewOf(next) });
    return json(route, 200, next);
  };
  for (const [action, to, ev, hash] of [
    ['submit', 'review', 'submitted', false], ['reject', 'rejected', 'rejected', false], ['request-changes', 'changes', 'changes', false],
    ['approve', 'approved', 'approved', true], ['apply', 'applied', 'applied', true],
  ] as const) {
    for (const p of state.proposals) api.on(`POST /api/proposals/${p.id}/${action}`, transition(to, ev, hash));
  }
  for (const p of state.proposals) api.on(`GET /api/proposals/${p.id}/preview`, (route) => json(route, 200, previewOf(byId(p.id) ?? p)));

  /** 새로 만든 CP에도 같은 경로를 단다. */
  const add = (p: Proposal) => {
    state.proposals = [p, ...state.proposals];
    for (const [action, to, ev, hash] of [['submit', 'review', 'submitted', false], ['reject', 'rejected', 'rejected', false], ['request-changes', 'changes', 'changes', false], ['approve', 'approved', 'approved', true], ['apply', 'applied', 'applied', true]] as const) {
      api.on(`POST /api/proposals/${p.id}/${action}`, transition(to, ev, hash));
    }
    api.on(`GET /api/proposals/${p.id}/preview`, (route) => json(route, 200, previewOf(byId(p.id) ?? p)));
  };
  return { state, add, previewOf };
}
