/**
 * 작업 실행(UI-06) E2E용 가짜 Runner 보고 fixture.
 * 원본 Mock(P demo: TASK-0001·0004·0005·0006·0007·0008)과 같은 값으로 만들어 원본 스크린샷과 비교할 수 있게 한다.
 * 응답 모양은 계약 타입(ResponseOf)으로 적는다. 서버 계약이 바뀌면 typecheck가 잡는다.
 *
 * 쓰는 법:
 *   const exec = await execApi(page);           // 기본 fixture 설치(fakeApi 포함)
 *   exec.state.attempts['TASK-0005'][0].status = 'interrupted'; // 상태를 바꾸고
 *   exec.bump();                                 // 화면이 다시 읽게 한다(변경 이벤트)
 */
import type { Page, Route } from '@playwright/test';
import type { ResponseOf } from '../../src/shared/api/contract.ts';
import { ACTIVE_PROJECT, errorBody, fakeApi, json, type FakeApi } from './fake-api.ts';
import { MOCK_SUBAGENTS } from './task-api.ts';

export type Summary = ResponseOf<'listTasks'>['tasks'][number];
export type Attempt = ResponseOf<'getTaskAttempts'>['items'][number];
export type Verification = ResponseOf<'getTaskVerifications'>['items'][number];
export type Message = ResponseOf<'getTaskMessages'>['items'][number];
export type Alert = ResponseOf<'listAlerts'>['items'][number];
export type Gate = ResponseOf<'getTaskGate'>;
export type RunnerState = ResponseOf<'getRunnerState'>;

const UPDATED = '2026-11-03T10:58:00.000Z';

export function summary(taskKey: string, wbsPath: string, title: string, status: Summary['lifecycleStatus'], extra: Partial<Summary> = {}): Summary {
  return {
    id: `id-${taskKey}`, taskKey, wbsNodeId: 'n1', wbsPath, title, workType: 'Implementation', primaryDomain: 'BE', relatedDomains: [], priority: 1,
    assigneeAgent: 'Claude', verifierAgent: 'Codex', lifecycleStatus: status, verifState: 'none', blocked: false, preds: [],
    checklist: { done: 0, total: 3 }, gate: { passed: 0, total: 5 }, schedule: null, updatedAt: UPDATED, deletedAt: null, ...extra,
  };
}

export function attempt(attemptKey: string, taskKey: string, kind: Attempt['kind'], status: Attempt['status'], startedAt: string, extra: Partial<Attempt> = {}): Attempt {
  return {
    id: `att-${attemptKey}`, attemptKey, taskKey, kind, agent: kind === 'qa' || kind === 'reverify' ? 'Codex' : 'Claude', status, startedAt,
    endedAt: status === 'running' ? null : startedAt, modelId: kind === 'qa' || kind === 'reverify' ? 'Codex Large' : 'Opus 5.5', effort: '높음', gradeAdjust: null,
    summary: null, failure: null, tokens: null, resumedFrom: null, baseSha: null, headSha: null, changedFiles: [], updatedAt: startedAt,
    // 지정·실제 하위 Agent는 원본 Mock 같은 시도의 값(없는 키는 빈 값 — 지정 없음·보고 없음)
    subagents: MOCK_SUBAGENTS.get(attemptKey) ?? { designated: [], used: null, observed: null }, ...extra,
  };
}

export function verification(id: string, a: Attempt, result: Verification['result'], extra: Partial<Verification> = {}): Verification {
  return {
    id, taskKey: a.taskKey, attemptId: a.id, result, headSha: 'a'.repeat(40), specRevision: 1, cmd: 'pnpm test', expected: '', actual: '',
    defects: [], invalidated: false, at: a.startedAt, ...extra,
  };
}

export function message(msgKey: string, taskKey: string, extra: Partial<Message> = {}): Message {
  return {
    id: `msg-${msgKey}`, msgKey, taskKey, attemptId: null, dir: 'out', type: '추가 지시', toAgent: 'Claude', body: '', delivery: 'Draft', pendingNext: false,
    workState: null, failReason: null, readAt: null, createdAt: '2026-11-01T05:02:00.000Z', updatedAt: '2026-11-01T05:02:00.000Z', ...extra,
  };
}

export const runnerState = (patch: Partial<RunnerState> = {}): RunnerState => ({
  connection: { online: true, runnerId: 'r1', version: '1', lastHeartbeatAt: null, sessionStartedAt: null },
  readiness: null, host: null, hostHistory: [],
  concurrency: {
    mode: 'auto', caps: { total: 4, Claude: 2, Codex: 2 }, memReserveGB: 4, limit: 4, used: { total: 2, Claude: 1, Codex: 1 }, subagentsObserved: 0,
    subagentsHeld: 0, subRatio: 0, heavyJobs: 0, resources: null, parallelWidth: 2, startable: 2, factor: 'cap', pressure: false, conflictWaits: [], adjustments: [],
  },
  sessions: [], unconfirmedHolds: [],
  observation: { budget: { dev: 2, qa: 1 }, profiles: [] },
  usage: [], gaps: [], externalWrite: { state: 'granted', reason: null },
  ...patch,
} as unknown as RunnerState);

export interface ExecState {
  tasks: Summary[];
  attempts: Record<string, Attempt[]>;
  verifications: Record<string, Verification[]>;
  messages: Record<string, Message[]>;
  gates: Record<string, Gate>;
  alerts: Alert[];
  runner: RunnerState;
  liveInject: boolean;
}

/** 원본 Mock과 같은 6개 Task(P demo). TASK-0005가 실행 중, TASK-0007은 QA FAIL 뒤 재작업 대기. */
export function demoState(): ExecState {
  const a0001 = [
    attempt('ATT-0001-1', 'TASK-0001', 'dev', 'completed', '2026-10-28T01:00:00.000Z'),
    attempt('ATT-0001-2', 'TASK-0001', 'qa', 'completed', '2026-10-28T05:00:00.000Z'),
  ];
  const a0004 = [
    attempt('ATT-0004-1', 'TASK-0004', 'dev', 'completed', '2026-10-31T01:00:00.000Z'),
    attempt('ATT-0004-2', 'TASK-0004', 'qa', 'running', '2026-11-03T02:00:00.000Z'),
  ];
  const a0005 = [attempt('ATT-0005-1', 'TASK-0005', 'dev', 'running', '2026-11-03T10:58:00.000Z', {
    summary: 'Route 등록 완료, Service 계층 작성 중.', changedFiles: ['apps/api/src/routes/tasks.ts'], tokens: 150,
  })];
  const a0007 = [
    attempt('ATT-0007-1', 'TASK-0007', 'dev', 'completed', '2026-10-31T00:00:00.000Z', { summary: 'WBS 트리 구현.' }),
    attempt('ATT-0007-2', 'TASK-0007', 'qa', 'completed', '2026-11-01T04:10:00.000Z', {
      summary: '기능 · 성능 QA — 14건 중 2건 FAIL (V-0007-1). 재작업 요청.', endedAt: '2026-11-01T04:35:00.000Z', tokens: 90,
    }),
  ];
  const second = a0007[1];
  if (!second) throw new Error('fixture');
  return {
    tasks: [
      summary('TASK-0001', '1.1.1', 'Monorepo 구성', 'done'),
      summary('TASK-0004', '2.1.2', 'Drizzle Schema 설계', 'qa'),
      summary('TASK-0005', '2.1.1', 'Task CRUD API', 'running'),
      summary('TASK-0006', '2.1.3', 'Dependency 검증', 'ready', { blocked: true, preds: ['TASK-0005'] }),
      summary('TASK-0007', '2.2.1', 'WBS Tree UI', 'rework'),
      summary('TASK-0008', '2.2.2', 'Task Detail UI', 'ready', { blocked: true, preds: ['TASK-0005'] }),
      summary('TASK-0009', '2.2.3', 'Task 편집 저장', 'planning'),
    ],
    attempts: { 'TASK-0001': a0001, 'TASK-0004': a0004, 'TASK-0005': a0005, 'TASK-0007': a0007 },
    verifications: {
      'TASK-0007': [verification('V-0007-1', second, 'FAIL', {
        cmd: 'pnpm --filter web test -- wbs-tree', expected: '14/14 통과, 1,000행 펼치기 100ms 이내', actual: '12/14 통과 — 필터 시 상위 Phase 행 누락, 1,000행 펼치기 412ms',
        defects: [
          { defKey: 'DEF-0007-1', text: '필터 결과에서 상위 노드 누락', blocking: true, resolved: false },
          { defKey: 'DEF-0007-2', text: '대량 펼치기 성능 기준 미달', blocking: true, resolved: false },
        ],
      })],
    },
    messages: {
      'TASK-0007': [
        message('MSG-001', 'TASK-0007', {
          attemptId: second.id, type: '수정 요청', body: 'QA-1 실패 2건을 재작업해 주세요.\n1. 필터 적용 시 매칭 Task의 상위 Phase / Work Package가 항상 표시되어야 합니다.\n2. 1,000행 펼치기 100ms 기준 — 가상 스크롤을 검토하세요.',
          delivery: 'Acknowledged', createdAt: '2026-11-01T05:02:00.000Z',
        }),
        message('MSG-002', 'TASK-0007', {
          attemptId: second.id, dir: 'in', type: '응답', toAgent: null, delivery: null, workState: 'Runner 응답',
          body: '수정 요청을 수신했습니다. 재작업 계획입니다.\n- `withAncestors()` 유틸을 추가하고 필터 파이프라인 마지막 단계에 적용\n- `@tanstack/react-virtual`로 행 가상화',
          createdAt: '2026-11-01T05:09:00.000Z',
        }),
      ],
    },
    gates: {},
    alerts: [],
    runner: runnerState(),
    liveInject: false,
  };
}

export interface ExecApi extends FakeApi {
  state: ExecState;
  /** 화면이 다시 읽게 변경 이벤트를 한 번 보낸다. */
  bump: (topics?: string[]) => void;
}

const page1 = <T>(items: T[]) => ({ items, nextCursor: null });
const taskOf = (url: URL, at: number) => decodeURIComponent(url.pathname.split('/')[at] ?? '');

export async function execApi(page: Page, state: ExecState = demoState()): Promise<ExecApi> {
  const api = await fakeApi(page, { project: ACTIVE_PROJECT });
  let seq = 0;
  let pending: string[] = [];
  api.on('GET /api/changes', (route) => {
    const events = pending.map((topic) => ({ seq: ++seq, topic, kind: 'e2e', key: 'e2e', at: '2026-11-05T11:00:00.000Z' }));
    pending = [];
    return json(route, 200, { events, next: seq, reset: false });
  });
  api.on('GET /api/projects/p1/tasks', (route) => json(route, 200, { nodes: [], tasks: state.tasks }));
  api.on('GET /api/runner-state', (route) => json(route, 200, state.runner));
  api.on('GET /api/alerts', (route) => json(route, 200, { items: state.alerts }));
  api.on('GET /api/evidence', (route) => json(route, 200, { items: [], nextCursor: null }));
  api.on('GET /api/settings/workflow', (route) => json(route, 200, {
    devAgent: 'Claude', qaAgent: 'Codex', liveInject: state.liveInject, heartbeatSeconds: 30, missedHeartbeats: 3, updatedAt: null,
  }));
  await page.route(/\/api\/tasks\/[^/]+\/(attempts|verifications|messages|gate)(\?.*)?$/, async (route: Route) => {
    const url = new URL(route.request().url());
    const key = taskOf(url, 3);
    const what = url.pathname.split('/')[4];
    if (what === 'attempts') return json(route, 200, page1(state.attempts[key] ?? []));
    if (what === 'verifications') return json(route, 200, page1(state.verifications[key] ?? []));
    if (what === 'messages') return json(route, 200, page1(state.messages[key] ?? []));
    const gate = state.gates[key];
    return gate ? json(route, 200, gate) : json(route, 404, errorBody('NOT_FOUND'));
  });
  return { ...api, state, bump: (topics = ['task', 'attempt', 'verification', 'message', 'runner', 'alert']) => { pending.push(...topics); } };
}
