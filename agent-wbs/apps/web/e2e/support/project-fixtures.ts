/**
 * 프로젝트 화면(M3-04) E2E용 계약 모양 데이터. 타입은 계약(ResponseOf)에서 가져와 서버 계약과 어긋나면 typecheck가 실패한다.
 * 값은 원본 시나리오 29·30·31·19(G§12)의 예시를 따른다. 숫자는 고정 기대가 아니라 예시일 뿐이다(MM-27).
 */
import type { ResponseOf } from '../../src/shared/api/contract.ts';

export type ProjectState = ResponseOf<'getProject'>;
type Boot = Extract<ProjectState, { bootstrap: unknown }>;
type Active = Extract<ProjectState, { approvedAt: unknown }>;
type Decision = Boot['bootstrap']['decisions'][number];
type Step = Boot['bootstrap']['steps'][number];

export const T0 = '2026-11-05T11:00:00.000Z';
export const V1 = '2026-11-05T11:00:00.000000Z';
export const V2 = '2026-11-05T11:05:00.000000Z';
export const SHA1 = '2dec2a4f0c1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e';
export const SHA2 = '7b1c9e2a0c1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e';
export const SHA3 = 'a41f03d50c1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e';
export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const JOB_ID = '22222222-2222-4222-8222-222222222222';
export const NAME = 'Verum-SDN Agent WBS — Self Development';
export const MD = ['prototype/docs/Agent-WBS-설계의도-및-구현가이드.md', 'prototype/docs/화면-정의서.md', 'prototype/docs/용어-정의.md'];

const registered = {
  epoch: 1, cleanup: 'none', id: PROJECT_ID, name: NAME,
  repo: { url: 'https://github.com/verum-sdn/agent-wbs', owner: 'verum-sdn', name: 'agent-wbs', branch: 'main', baseCommit: SHA1 },
  targetDate: '2027-02-26', instruction: 'prototype/uiux/ 와 prototype/docs/ 설계 문서를 분석하고 Task 식별을 시작하자.',
  constraints: [
    { id: 'c1', name: 'PostgreSQL 16', level: 'must', condition: '' },
    { id: 'c2', name: 'Redis 7', level: 'must', condition: '' },
    { id: 'c3', name: 'QuestDB', level: 'cond', condition: '시계열 데이터(시간 순 대량 쓰기 · 구간 집계 · 보관 기간)가 있으면 사용' },
    { id: 'c4', name: '외부 클라우드 관리형 서비스', level: 'ban', condition: '' },
  ],
  registeredAt: T0,
  inputs: [{ v: 1, at: T0, commit: SHA1, mdList: MD, changes: [], instruction: '', result: null, taskCount: 0 }],
  changeCommits: [], inputHead: SHA1, inputJob: null, updatedAt: V1,
};

const KEYS = ['check', 'unzip', 'repo', 'codex', 'claude', 'cross', 'tech', 'draft', 'approve'] as const;
/** upTo 앞의 단계는 done, upTo는 status, 뒤는 wait */
export function steps(upTo: (typeof KEYS)[number], status: 'run' | 'fail' | 'done' | 'wait' = 'run'): Step[] {
  const at = KEYS.indexOf(upTo);
  return KEYS.map((key, i) => ({ key, status: i < at ? 'done' : i === at ? status : 'wait', at: i <= at ? T0 : null, note: i < at ? `${key} 완료` : '' })) as unknown as Step[];
}

export const decision = (over: Partial<Decision> & Pick<Decision, 'id' | 'tdKey' | 'title' | 'choice'>): Decision => ({
  area: 'storage', authority: 'agent', level: null, condition: '', status: 'pending', reason: '근거', alternatives: '', by: 'Planning Agent', at: T0, updatedAt: V1,
  constraintId: null, conditionResult: null, ...over,
} as Decision);

export const DECISIONS: Decision[] = [
  decision({ id: 'd1', tdKey: 'TD-01', title: '필수 사용', choice: 'PostgreSQL 16', authority: 'lead', level: 'must', status: 'fixed', reason: '팀장 지정 제약' }),
  decision({ id: 'd3', tdKey: 'TD-03', title: '조건부 선호', choice: 'QuestDB', authority: 'lead', level: 'cond', condition: '시계열 데이터가 있으면 사용', reason: 'Runner 이벤트·사용량이 시간 순 대량 쓰기다', conditionResult: 'met' }),
  decision({ id: 'd5', tdKey: 'TD-05', title: '통신 방식', choice: 'REST + SSE', reason: '화면 갱신은 단방향 push로 충분하다', alternatives: 'WebSocket — 양방향이 필요 없음' }),
];

export const DRAFT = {
  phases: [{ ref: 'P1', title: '기반' }, { ref: 'P2', title: '화면' }],
  wps: [{ ref: 'W1', phaseRef: 'P1', title: 'DB · API' }, { ref: 'W2', phaseRef: 'P2', title: 'WBS 화면' }],
  tasks: [
    { ref: 'T1', wpRef: 'W1', title: 'Drizzle Schema 설계', workType: 'Design', primaryDomain: 'DB', assigneeAgent: 'Codex', verifierAgent: 'Claude', estimate: { estHours: 3, loHours: 2, hiHours: 5 } },
    { ref: 'T2', wpRef: 'W1', title: 'Task API', workType: 'Implementation', primaryDomain: 'API', assigneeAgent: 'Claude', verifierAgent: 'Codex', estimate: { estHours: 4.5, loHours: 3, hiHours: 7 } },
    { ref: 'T3', wpRef: 'W2', title: 'WBS 표', workType: 'Implementation', primaryDomain: 'FE', assigneeAgent: 'Claude', verifierAgent: 'Codex', estimate: { estHours: 5, loHours: 3.5, hiHours: 8 } },
  ],
  deps: [{ predRef: 'T1', succRef: 'T2', depType: 'FS' }, { predRef: 'T2', succRef: 'T3', depType: 'FS' }],
  splitCheck: { pass: 2, suspect: 1, violation: 0 },
};

export function bootProject(over: { steps?: Step[]; decisions?: Decision[]; draft?: boolean; revision?: number; runNo?: number; fail?: { reason: string; fix: string } | null; cleanup?: string; logs?: { at: string; text: string }[] } = {}): ProjectState {
  return {
    state: 'boot', ...registered, cleanup: over.cleanup ?? 'none',
    bootstrap: {
      jobId: JOB_ID, runNo: over.runNo ?? 1, status: over.fail ? 'failed' : 'running', steps: over.steps ?? steps('check'),
      logs: over.logs ?? [{ at: T0, text: '프로젝트 등록 — Runner의 초기 분석을 기다립니다' }], fail: over.fail ?? null,
      decisions: over.decisions ?? [], revision: over.draft ? (over.revision ?? 1) : null, draft: over.draft ? DRAFT : null,
    },
  } as unknown as ProjectState;
}

export function activeProject(over: Partial<Active> = {}): ProjectState {
  return {
    state: 'active', ...registered, approvedAt: T0, approvedTaskCount: 3,
    inputs: [{ v: 1, at: T0, commit: SHA1, mdList: MD, changes: [], instruction: '', result: '초기 분석 → 초기 WBS 3건 팀장 승인', taskCount: 3 }],
    ...over,
  } as unknown as ProjectState;
}

/** 시나리오 31: 입력 변경 커밋 2개 · 파일 4개(그중 src/ 변경은 Runner가 걸러 보내지 않는다) */
export const PENDING = [
  { sha: SHA2, at: '2026-11-05T11:40:00.000Z', author: 'team-lead', message: 'prototype: Task 상세 메시지 첨부파일', state: 'pending',
    files: [{ path: 'prototype/uiux/task-detail.html', change: 'modified', added: 52, deleted: 8 }, { path: 'prototype/docs/화면-정의서.md', change: 'modified', added: 14, deleted: 2 }] },
  { sha: SHA3, at: '2026-11-05T11:45:00.000Z', author: 'team-lead', message: 'docs: 알림 정의 추가 · 옛 용어 문서 삭제', state: 'pending',
    files: [{ path: 'prototype/docs/알림-정의.md', change: 'added', added: 40, deleted: 0 }, { path: 'prototype/docs/용어-정의.md', change: 'deleted', added: 0, deleted: 31 }] },
] as unknown as Active['changeCommits'];

export const REPO_OK = {
  id: 'rc-1', url: 'https://github.com/verum-sdn/agent-wbs', status: 'done', private: true, commit: SHA1,
  structure: { uiux: true, uiuxFiles: 15, docs: MD, src: true, contracts: true, agentwbs: true }, error: null,
} satisfies ResponseOf<'getRepoCheck'>;

export const PREVIEW = {
  epoch: 1, projectName: NAME,
  counts: { tasks: 3, running: 1, subagents: 2, attempts: 4, verifications: 2, evidence: 5, proposals: 1, messages: 6, history: 20, reports: 1, baselines: 1, inputs: 1 },
  runner: { branches: ['agent/TASK-0001', 'agent/TASK-0002'], worktrees: 2, mergedTasks: 1 },
  repo: registered.repo,
} as unknown as ResponseOf<'previewReset'>;

export const GITHUB_OK = {
  mode: 'gh', tokenSet: false, status: 'ok', account: 'team-lead (gh)',
  scopes: { contents: 'verified', pulls: 'verified', statuses: 'verified', metadata: 'verified' }, warning: null, expiresAt: null, updatedAt: V1,
};
