/**
 * 설정 화면(M3-08) E2E용 가짜 API 응답. 모양은 계약 타입(ResponseOf)으로 적어 서버 계약과 어긋나면 typecheck가 실패한다.
 * 값은 원본 Mock(P READY_MOCK·GH_MOCK·SPLIT_MOCK 등)과 owner 기본값(낮춤 기준 20%·가정 가동률 60%·재조정 임계값 1일)을 따른다.
 */
import type { Route } from '@playwright/test';
import type { ResponseOf } from '../../src/shared/api/contract.ts';
import { ACTIVE_PROJECT, json, type FakeApi } from './fake-api.ts';

export const V1 = '2026-11-05T01:00:00.000Z';
export const V2 = '2026-11-05T02:00:00.000Z';

export const WORKFLOW: ResponseOf<'getWorkflowSettings'> = {
  devAgent: 'Claude', qaAgent: 'Codex', liveInject: false, heartbeatSeconds: 60, missedHeartbeats: 3, updatedAt: V1,
};
export const EXEC: ResponseOf<'getExecPolicy'> = {
  onUsage: 'down', lowPct: 20, onRework: 'up1', notifyAt: 2, floors: { verifyGeDev: true, dbHigh: true }, autoRetryLimit: 2, autoReworkLimit: 3, updatedAt: V1,
};
const effort = (keys: string[]) => keys.map((key, i) => ({ key, level: i + 1 }));
export const MODELS: ResponseOf<'getModelSettings'> = {
  updatedAt: V1,
  rankOrder: { Claude: ['claude-sonnet-4-6', 'claude-opus-4-7'], Codex: ['gpt-5.4-mini', 'gpt-5.5'] },
  codexFamilyOrder: ['mini', 'base'],
  claudeModels: ['claude-sonnet-4-6', 'claude-opus-4-7'],
  models: [
    { agent: 'Claude', id: 'claude-opus-4-7', label: 'Opus 4.7', rank: 2, allowed: true, isNew: false, efforts: effort(['low', 'medium', 'high', 'xhigh', 'max']) },
    { agent: 'Claude', id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', rank: 1, allowed: false, isNew: true, efforts: effort(['low', 'medium', 'high', 'xhigh', 'max']) },
    { agent: 'Codex', id: 'gpt-5.5', label: 'GPT-5.5', rank: 2, allowed: true, isNew: false, efforts: effort(['low', 'medium', 'high', 'xhigh']) },
    { agent: 'Codex', id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', rank: 1, allowed: true, isNew: false, efforts: effort(['low', 'medium', 'high', 'xhigh']) },
  ],
};
export const SUBAGENTS: ResponseOf<'getSubagentSettings'> = {
  enabled: true, updatedAt: V1,
  defs: [
    { id: 'db-migration-reviewer', version: 1, agent: 'Claude', role: '검토', tools: 'Read · Grep', sandbox: '읽기 전용', text: 'DB migration의 되돌리기 가능성을 검토한다.', hash: 'a1b2c3d4e5f60718', allowed: true, ref: 'wshobson/agents' },
    { id: 'test-writer', version: 2, agent: 'Codex', role: '테스트', tools: 'Read · Write', sandbox: 'worktree 쓰기', text: 'AC마다 실패하는 테스트를 먼저 쓴다.', hash: 'ffeeddccbbaa9988', allowed: false, ref: null },
  ],
};
export const SPLIT: ResponseOf<'getSplitSettings'> = {
  maxHours: 4, minHours: 0.5, maxFiles: 8, testIn: true, dir: 'layer', updatedAt: V1,
  on: { one: true, domain: true, size: true, verify: true, revert: true, cg: true, contract: true, irrev: true, refactor: true, unknown: true },
};
export const SCHEDULE_POLICY: ResponseOf<'getScheduleSettings'> = {
  autoReplan: true, cpAuto: true, thresholdDays: 1, assumeRate: 0.6, windowDays: 7, minHours: 72, updatedAt: V1,
};
export const BLACKOUTS: ResponseOf<'getBlackouts'> = { days: [{ date: '2026-11-20', note: '사내 점검' }], updatedAt: V1 };
export const CONCURRENCY: ResponseOf<'getConcurrency'> = {
  mode: 'auto', caps: { total: 8, Claude: 8, Codex: 8, heavy: 4 }, memReserveGB: 4, updatedAt: V1,
};
export const OBS_BUDGET: ResponseOf<'getObsBudget'> = { budget: { dev: 2, qa: 3 }, updatedAt: V1 };
export const GITHUB: ResponseOf<'getGithubSettings'> = {
  mode: 'gh', tokenSet: false, status: 'ok', account: 'team-lead (gh)', expiresAt: null, warning: null, updatedAt: V1,
  scopes: { contents: 'verified', pulls: 'verified', statuses: 'verified', metadata: 'verified' },
};

export const RUNNER_FULL: ResponseOf<'getRunnerState'> = {
  connection: { online: true, runnerId: 'r1', version: '1.0.0', lastHeartbeatAt: '2026-11-05T10:59:00.000Z', sessionStartedAt: '2026-11-05T00:00:00.000Z' },
  readiness: {
    at: '2026-11-03T10:58:00.000Z',
    items: [
      { key: 'claude', status: 'ok', detail: '설치됨 · 로그인됨', fix: null },
      { key: 'codex', status: 'warn', detail: '설치됨 · 로그인 만료 7일 전', fix: '만료 전에 `codex login`을 다시 실행하세요.' },
      { key: 'git', status: 'ok', detail: '2.47', fix: null },
      { key: 'pg', status: 'fail', detail: '연결 거부 · localhost:5432', fix: 'PostgreSQL이 실행 중인지 확인하세요.' },
    ],
  },
  host: {
    hostId: 'dev-pc', bootId: 'b1', cpu: 'Intel Core i7-12700H', cores: 20, memGB: 23, swapGB: 6, diskFreeGB: 952, os: 'Ubuntu 24.04 (WSL2)',
    perSessionGB: 1.2, samples: 14, seenAt: '2026-11-03T10:58:00.000Z', recommended: { total: 8, Claude: 8, Codex: 8, heavy: 4 }, warnings: [],
  },
  hostHistory: [{ hostId: 'dev-pc', cpu: 'Intel Core i7-12700H', cores: 20, memGB: 23, seenAt: '2026-11-03T10:58:00.000Z' }],
  concurrency: {
    mode: 'auto', caps: { total: 8, Claude: 8, Codex: 8, heavy: 4 }, memReserveGB: 4, limit: 6,
    used: { total: 3, Claude: 2, Codex: 1 }, subagentsObserved: 1, subagentsHeld: 2, subRatio: 0.5, heavyJobs: 1,
    resources: { cpuPct: 41, memFreeGB: 9.4, swapGB: 0, at: '2026-11-05T10:59:00.000Z' }, parallelWidth: 3, startable: 2,
    factor: 'runner_limit', pressure: false,
    conflictWaits: [{ taskKey: 'TASK-0009', conflictGroup: 'web-shell', by: 'TASK-0008' }],
    adjustments: [{ at: '2026-11-05T09:00:00.000Z', from: 8, to: 6, by: 'Runner', reason: '메모리 여유 4GB 미만' }],
  },
  sessions: [
    { attemptId: 'a1', taskKey: 'TASK-0007', agent: 'Claude', observed: 1, reserved: 2, state: 'ok', grade: 'partial' },
    { attemptId: 'a2', taskKey: 'TASK-0008', agent: 'Codex', observed: 0, reserved: 3, state: 'unconfirmed', grade: 'unverified' },
  ],
  unconfirmedHolds: [],
  observation: {
    budget: { dev: 2, qa: 3 },
    profiles: [
      { agent: 'Claude', version: '2.4.1', model: 'claude-opus-4-7', options: 'depth 1', grade: 'unverified', verifiedVersion: null, verifiedAt: null, notes: '미검증 — 보수 계산' },
      { agent: 'Codex', version: '0.168.0', model: 'gpt-5.5', options: 'max 4', grade: 'unverified', verifiedVersion: '0.167.0', verifiedAt: '2026-11-01T00:00:00.000Z', notes: 'CLI 버전이 바뀌어 재검증 전까지 미검증' },
    ],
  },
  usage: [
    { agent: 'Claude', remainPct: 64, resetAt: '2026-11-05T15:00:00.000Z', at: '2026-11-05T10:58:00.000Z' },
    { agent: 'Codex', remainPct: 12, resetAt: '2026-11-06T00:00:00.000Z', at: '2026-11-05T10:58:00.000Z' },
  ],
  gaps: [{ from: '2026-11-04T13:00:00.000Z', to: '2026-11-04T14:30:00.000Z', reason: 'reboot' }],
  externalWrite: { state: 'granted', reason: null },
};

/** 기록이 하나도 없는 Runner(UAT-EMPTY-11) */
export const RUNNER_EMPTY: ResponseOf<'getRunnerState'> = {
  ...RUNNER_FULL,
  readiness: null, host: null, hostHistory: [], sessions: [], unconfirmedHolds: [], gaps: [], usage: [],
  observation: { budget: { dev: 2, qa: 3 }, profiles: [] },
  concurrency: { ...RUNNER_FULL.concurrency, conflictWaits: [], adjustments: [], used: { total: 0, Claude: 0, Codex: 0 }, subagentsHeld: 0, subagentsObserved: 0, resources: null },
};

const day = (date: string, rate: number) => ({ date, rate });
export const SCHEDULE = {
  calcVersion: 1, at: V1, tasks: [], warnings: [], blackouts: BLACKOUTS.days,
  project: {} as ResponseOf<'getSchedule'>['project'],
  capacity: {
    days: [day('2026-10-30', 0.62), day('2026-10-31', 0.1), day('2026-11-01', 0.55), day('2026-11-02', 0.7), day('2026-11-03', 0.66), day('2026-11-04', 0.48), day('2026-11-05', 0.5)],
    measured: 0.58, enough: true, loggedHours: 97, rate: 0.58, rateLo: 0.45, rateHi: 0.7, todayRate: 0.5,
  },
} as ResponseOf<'getSchedule'>;

export const INTEGRITY: ResponseOf<'getIntegrity'> = {
  checkedAt: '2026-11-05T11:00:00.000Z',
  items: [
    { key: 'task_refs', label: 'Task ID 참조', ok: true, detail: '참조 41건 모두 존재' },
    { key: 'gate', label: 'Completion Gate', ok: false, detail: 'TASK-0004: 완료인데 Gate 미충족 1건' },
  ],
};

/** PUT 요청을 받으면 updatedAt을 V2로 올려 그대로 돌려준다(서버 저장 흉내). 받은 본문은 bodies에 남는다. */
export function echoPut(api: FakeApi, path: string, initial: { updatedAt: string | null }, extra: (body: Record<string, unknown>) => Record<string, unknown> = () => ({})) {
  let current: Record<string, unknown> = { ...initial };
  const bodies: Record<string, unknown>[] = [];
  api.on(`GET ${path}`, (route: Route) => json(route, 200, current));
  api.on(`PUT ${path}`, (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    // 토큰 같은 비밀값은 저장만 하고 응답에 싣지 않는다(서버 계약).
    const rest = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'token'));
    current = { ...current, ...rest, ...extra(body), updatedAt: V2 };
    return json(route, 200, current);
  });
  return { bodies, current: () => current };
}

/** 설정 화면에 필요한 GET을 모두 기본값으로 건다. */
export function settingsApi(api: FakeApi, runner: ResponseOf<'getRunnerState'> = RUNNER_FULL) {
  api.on('GET /api/project', (route) => json(route, 200, { ...ACTIVE_PROJECT, repo: { url: 'https://github.com/verum-sdn/agent-wbs', owner: 'verum-sdn', name: 'agent-wbs', branch: 'main', baseCommit: null } }));
  api.on('GET /api/runner-state', (route) => json(route, 200, runner));
  api.on('GET /api/schedule', (route) => json(route, 200, SCHEDULE));
  api.on('GET /api/alerts', (route) => json(route, 200, { items: [] }));
  api.on('GET /api/system/integrity', (route) => json(route, 200, INTEGRITY));
  // 서버 후속 3차(M3 통합): 분할 위반 목록·사용 현황. 기본은 비어 있다. 시험마다 api.on으로 바꾼다.
  api.on('GET /api/settings/split/violations', (route) => json(route, 200, { count: 0, items: [] }));
  api.on('GET /api/settings/agent-usage', (route) => json(route, 200, { lockedTasks: [], models: [], subagents: [] }));
  return {
    workflow: echoPut(api, '/api/settings/workflow', WORKFLOW),
    exec: echoPut(api, '/api/settings/exec-policy', EXEC),
    models: echoPut(api, '/api/settings/models', MODELS, (body) => ({
      models: MODELS.models.map((m) => ({ ...m, allowed: (body.models as { agent: string; id: string; allowed: boolean }[]).find((x) => x.agent === m.agent && x.id === m.id)?.allowed ?? m.allowed })),
    })),
    subagents: echoPut(api, '/api/settings/subagents', SUBAGENTS, (body) => ({
      defs: SUBAGENTS.defs.map((d) => ({ ...d, allowed: (body.allowed as { id: string; allowed: boolean }[]).find((x) => x.id === d.id)?.allowed ?? d.allowed })),
      allowed: undefined,
    })),
    split: echoPut(api, '/api/settings/split', SPLIT),
    schedule: echoPut(api, '/api/settings/schedule', SCHEDULE_POLICY),
    blackouts: echoPut(api, '/api/settings/blackouts', BLACKOUTS),
    concurrency: echoPut(api, '/api/settings/concurrency', CONCURRENCY),
    budget: echoPut(api, '/api/settings/obs-budget', OBS_BUDGET),
    github: echoPut(api, '/api/settings/github', GITHUB, (body) => (typeof body.token === 'string' ? { tokenSet: true, mode: 'token' } : {})),
  };
}
