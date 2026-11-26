/**
 * M7-05(빌드·통합) E2E용 가짜 API 데이터. 원본 CI_MOCK·CI_PIPE(P L3523–3546)와 같은 값을 계약(M7-04) 모양으로 옮겼다.
 * 시각 비교에도 쓴다. 모양은 계약 타입(ResponseOf)이라 서버 계약과 어긋나면 typecheck가 실패한다.
 *
 * installCi(api, data)로 가짜 API에 붙인다. data를 바꿔(목록 비우기·실패 추가) 빈 상태·기준선 실패·병합 불일치 시험을 만든다.
 */
import type { ResponseOf } from '../../src/shared/api/contract.ts';
import { json, type FakeApi } from './fake-api.ts';
import { kst, tasks } from './m307-data.ts';

type Run = ResponseOf<'getCiRun'>;
type Queue = ResponseOf<'getMergeQueue'>['items'][number];
type Flaky = ResponseOf<'listFlakyTests'>['items'][number];
type Pipeline = ResponseOf<'getPipeline'>;
type Settings = ResponseOf<'getCiSettings'>;

export const MAIN = `c4e81f0${'0'.repeat(33)}`;
const sha = (s: string) => s.padEnd(40, '0');

/** 원본 CI_PIPE.stages(P L3525–3529) */
export const PIPE_STEPS: Record<string, { when: string; gate: string; steps: string[] }> = {
  task: { when: 'Agent 작업 종료 직후 · Task worktree · 무거운 작업 상한 적용', gate: '통과해야 검증 Agent에게 넘어감', steps: ['의존성 설치 (pnpm install --frozen-lockfile)', '보호 경로 검사 — prototype/ · .agentwbs/ 변경 금지 · 빌드 결과물 커밋 금지', '타입 검사 (tsc --noEmit)', 'lint (eslint)', '단위 테스트 — 변경 영향 패키지 (vitest)', '빌드 — 영향 패키지 (src/)', '계약 테스트 — contracts/ 와 대조'] },
  int: { when: '검증 PASS 후 병합 대기열 · 한 번에 하나 · 공용 서비스는 전용 DB 이름', gate: '통과해야 GitHub PR 병합 (main 보호 규칙)', steps: ['main + PR 병합본 checkout', '전체 빌드 (src/)', '전체 단위 · 통합 테스트', '마이그레이션 — 빈 DB에 처음부터 (contracts/db/)', '서비스 기동 — docker compose (PostgreSQL · Redis)', '앱 기동 · health check', 'E2E 핵심 경로 (Playwright)'] },
  night: { when: '매일 02:00 · main', gate: '실패 시 대시보드 알림 · 원인 Task 추적', steps: ['전체 E2E (Playwright)', '화면 스크린샷 ↔ prototype/uiux/ 비교', '주요 API 응답 시간 기준 (p95)', '불안정 테스트 재실행 판정'] },
  deploy: { when: '팀장 요청 또는 Phase 완료 시', gate: '「Web Service 정상 기동 + 브라우저 접속」 = 배포 확인', steps: ['운영 빌드 — Docker 이미지 (src/)', 'docker compose up — 운영 구성', 'health check (/api/health)', '브라우저 접속 확인 — 로그인 · 핵심 화면 · 주요 API (Playwright)', '접속 URL · 스크린샷 기록'] },
};

/** 「3분 02초」 → ms */
const ms = (dur: string) => { const m = /(?:(\d+)분 )?(\d+)초/.exec(dur); return ((Number(m?.[1] ?? 0) * 60) + Number(m?.[2] ?? 0)) * 1000; };

/**
 * 단계 시간: 원본 공식(P L4770 `8 + (i*37 + id.length*13) % 140`초)으로 앞 단계를 채우고, 마지막 단계가 나머지를 가져 합이 원본 소요(dur)와 같다.
 * 실패 실행은 실패 단계까지 보고한다(그 뒤 단계는 Runner가 보내지 않는다).
 */
function steps(id: string, stage: string, dur: string, status: string, failStep?: number): Run['steps'] {
  const names = PIPE_STEPS[stage]?.steps ?? [];
  const upto = status === 'fail' ? (failStep ?? 0) + 1 : names.length;
  const total = ms(dur);
  let pre = names.slice(0, upto - 1).map((_, i) => (8 + ((i * 37 + id.length * 13) % 140)) * 1000);
  const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
  // 앞 단계 합이 원본 소요를 넘으면(실패 실행) 비율로 줄여 마지막 단계가 최소 1초를 갖게 한다.
  if (total - sum(pre) < 1000 && pre.length) { const f = (total * 0.9) / sum(pre); pre = pre.map((x) => Math.max(1000, Math.round((x * f) / 1000) * 1000)); }
  const durations = [...pre, Math.max(1000, total - sum(pre))];
  return names.slice(0, upto).map((name, i) => ({ name, status: (status === 'fail' && i === upto - 1 ? 'fail' : 'pass') as Run['steps'][number]['status'], durationMs: durations[i] ?? 1000 }));
}

interface Src { id: string; stage: Run['stage']; task?: string; att?: string; ref: string; pr?: number; at: string; dur: string; st: Run['status']; trig: string; failStep?: number; log?: string; url?: string; merged?: string; shots?: string[]; baseline?: boolean }

const run = (s: Src): Run => ({
  id: s.id.toLowerCase(), runKey: s.id, stage: s.stage, status: s.st, taskKey: s.task ?? null, attemptId: s.att ? s.att.toLowerCase() : null,
  ref: s.ref, pr: s.pr ?? null, trigger: s.trig, baseSha: MAIN, headSha: s.stage === 'task' ? sha(s.ref.split('@ ')[1] ?? 'a') : MAIN,
  mergeSha: s.merged ? sha(s.merged) : null, treeSha: null, pipelineSha: sha('9a9a9a9'),
  steps: steps(s.id, s.stage, s.dur, s.st, s.failStep), failStep: s.failStep === undefined ? null : PIPE_STEPS[s.stage]?.steps[s.failStep] ?? null,
  failScope: s.st === 'fail' ? (s.baseline ? 'baseline' : 'task') : null, logExcerpt: s.log ?? null, artifacts: s.shots ?? [], url: s.url ?? null, startedAt: kst(s.at),
});

/** 원본 CI_MOCK.runs(P L3533–3544)를 서버 순서(최근 기록 먼저)로. */
export const runs = (): Run[] => [
  run({ id: 'CI-0101', stage: 'task', task: 'TASK-0001', att: 'ATT-0001-1', ref: 'agent/TASK-0001 @ 3b7d2e1', pr: 3, at: '2026-10-28 15:11', dur: '3분 02초', st: 'pass', trig: 'Agent 작업 종료' }),
  run({ id: 'CI-0102', stage: 'int', task: 'TASK-0001', ref: 'main + #3', pr: 3, at: '2026-10-28 16:24', dur: '7분 40초', st: 'pass', trig: '검증 PASS → 병합 대기열', merged: '4c1a0f7' }),
  run({ id: 'CI-0108', stage: 'int', task: 'TASK-0002', ref: 'main + #5', pr: 5, at: '2026-10-29 17:02', dur: '8분 15초', st: 'pass', trig: '검증 PASS → 병합 대기열', merged: '8e33b1d' }),
  run({ id: 'CI-0112', stage: 'int', task: 'TASK-0003', ref: 'main + #7', pr: 7, at: '2026-10-31 11:40', dur: '8분 51초', st: 'pass', trig: '검증 PASS → 병합 대기열', merged: 'c4e81f0' }),
  run({ id: 'CI-0118', stage: 'task', task: 'TASK-0007', att: 'ATT-0007-1', ref: 'agent/TASK-0007 @ 71f0a3c', pr: 8, at: '2026-11-01 11:44', dur: '3분 48초', st: 'pass', trig: 'Agent 작업 종료' }),
  run({ id: 'CI-0120', stage: 'night', ref: 'main @ c4e81f0', at: '2026-11-02 02:00', dur: '14분 30초', st: 'pass', trig: '야간 일정' }),
  run({ id: 'CI-0121', stage: 'deploy', ref: 'main @ c4e81f0', at: '2026-11-02 18:05', dur: '6분 10초', st: 'pass', trig: '팀장 요청', url: 'http://localhost:8080', shots: ['login.png', 'wbs.png', 'task-detail.png'] }),
  run({
    id: 'CI-0124', stage: 'task', task: 'TASK-0004', att: 'ATT-0004-1', ref: 'agent/TASK-0004 @ 0d9e5a2', pr: 9, at: '2026-11-03 17:40', dur: '4분 05초', st: 'fail', trig: 'Agent 작업 종료', failStep: 6,
    log: 'contract-test › contracts/db/postgres/migrations/0004_tasks.sql\n  ✗ index "tasks_deleted_at_idx" exists in database but not in contracts/\n  1 failed, 38 passed (3.1s)\nexit code 1',
  }),
  run({ id: 'CI-0125', stage: 'task', task: 'TASK-0004', att: 'ATT-0004-1', ref: 'agent/TASK-0004 @ 6a41c77', pr: 9, at: '2026-11-03 17:47', dur: '3분 58초', st: 'pass', trig: '수정 후 재실행' }),
  run({ id: 'CI-0126', stage: 'night', ref: 'main @ c4e81f0', at: '2026-11-03 02:00', dur: '14분 02초', st: 'pass', trig: '야간 일정', shots: ['비교 9화면 — 차이 2 (여백)'] }),
].reverse();

/** 보호 경로 변경(원본 ciGuard P L4746–4754): 첫 보호 검사에서 거부, 뒤 단계 없음 */
export const guardRun = (): Run => run({
  id: 'CI-0127', stage: 'task', task: 'TASK-0005', att: 'ATT-0005-1', ref: 'agent/TASK-0005 @ 9f2c6d0', pr: 10, at: '2026-11-05 19:00', dur: '0분 41초', st: 'fail', trig: 'Agent 작업 종료', failStep: 1,
  log: 'protected-paths › 이 PR은 수정할 수 없는 경로를 바꿨습니다\n  M prototype/uiux/js/task-api.js\n  M .agentwbs/pipeline.yaml   (unit 단계에서 tests/api/** 제외)\n  → 입력 자료 · 파이프라인 정의는 Agent가 바꿀 수 없습니다. 변경을 되돌리고 src/ 에서 해결하세요.\nexit code 1',
});

/** 기준선 실패: main 기준 커밋 자체가 실패(Task 탓 아님, failScope=baseline) */
export const baselineRun = (): Run => run({
  id: 'CI-0128', stage: 'task', task: 'TASK-0006', att: 'ATT-0006-1', ref: 'agent/TASK-0006 @ 5e5e5e5', pr: 11, at: '2026-11-05 19:30', dur: '1분 10초', st: 'fail', trig: 'Agent 작업 종료', failStep: 4, baseline: true,
  log: 'unit › main 기준 커밋에서도 같은 테스트가 실패합니다\nexit code 1',
});

const q = (id: string, pr: number, taskKey: string, position: number, status: Queue['status'], ciRunId: string | null, actualMergeSha: string | null = null): Queue => ({
  id, pr, taskKey, position, status, qaHeadSha: null, syncedHeadSha: null, baseSha: MAIN, ciRunId, actualMergeSha,
});
/** 원본 CI_MOCK.queue(P L3545) — 서버는 position 순서 */
export const queue = (): Queue[] => [
  q('q3', 3, 'TASK-0001', 1, 'merged', 'ci-0102', sha('4c1a0f7')),
  q('q5', 5, 'TASK-0002', 2, 'merged', 'ci-0108', sha('8e33b1d')),
  q('q7', 7, 'TASK-0003', 3, 'merged', 'ci-0112', sha('c4e81f0')),
  q('q9', 9, 'TASK-0004', 4, 'waiting_verify', null),
];
export const mismatchItem = (): Queue => q('q11', 11, 'TASK-0006', 5, 'checking', 'ci-0128', sha('dead000'));

export const flaky = (): Flaky[] => [
  { id: 'f1', testKey: 'wbs-tree.spec.ts › 접힘 상태 유지', rate: '2 / 20 실패', quarantined: true, taskKey: 'TASK-0007', updatedAt: kst('2026-11-03 02:00') },
];

export const pipeline = (): Pipeline => ({
  path: '.agentwbs/pipeline.yaml', commit: MAIN, status: 'ok', error: null, raw: null,
  stages: (['task', 'int', 'night', 'deploy'] as const).map((stage) => ({ stage, when: PIPE_STEPS[stage]?.when ?? '', gate: PIPE_STEPS[stage]?.gate ?? '', steps: PIPE_STEPS[stage]?.steps ?? [] })),
});

export const settings = (): Settings => ({ nightAt: '02:00', retry: 1, deployUrl: 'http://localhost:8080', updatedAt: kst('2026-10-27 09:00') });

export interface CiData { runs: Run[]; queue: Queue[]; flaky: Flaky[]; pipeline: Pipeline; settings: Settings }
export const ciData = (): CiData => ({ runs: runs(), queue: queue(), flaky: flaky(), pipeline: pipeline(), settings: settings() });

const P = '/api/projects/p1/ci';
/** 가짜 API에 빌드·통합 경로를 붙인다. 실행 목록은 cursor로 2쪽에 나눠 준다(모든 쪽을 읽는지 확인). */
export function installCi(api: FakeApi, data: CiData, options: { tasks?: boolean } = {}): void {
  // tasks=false: Task 화면 시험이 자기 Task 목록·시도(task-api.ts)를 쓸 때. 아래 시도 응답도 붙이지 않는다.
  // 대기열 제목은 원본 Mock Task 제목(P TASKS)과 같게 맞춘다(시각 비교).
  const TITLE: Record<string, string> = { 'TASK-0002': 'PostgreSQL 연결', 'TASK-0003': 'Task 데이터 모델 설계' };
  if (options.tasks !== false) api.on('GET /api/projects/p1/tasks', (route) => json(route, 200, { tasks: tasks().map((t) => ({ ...t, title: TITLE[t.taskKey] ?? t.title })), nextCursor: null }));
  api.on(`GET ${P}/runs`, (route, request) => {
    const url = new URL(request.url());
    const cursor = url.searchParams.get('cursor');
    const taskKey = url.searchParams.get('taskKey');
    const all = data.runs.filter((r) => !taskKey || r.taskKey === taskKey);
    const cut = taskKey ? all.length : Math.ceil(all.length / 2);
    return cursor === 'page2' ? json(route, 200, { items: all.slice(cut), nextCursor: null }) : json(route, 200, { items: all.slice(0, cut), nextCursor: cut < all.length ? 'page2' : null });
  });
  for (const r of data.runs) api.on(`GET ${P}/runs/${r.id}`, (route) => json(route, 200, r));
  // 상세의 「Task · 시도」 칸이 시도 번호(ATT-…)를 보이도록 실행이 가리키는 시도를 준다.
  const atts = new Map<string, { id: string; attemptKey: string }[]>();
  for (const r of data.runs) if (r.taskKey && r.attemptId) {
    const list = atts.get(r.taskKey) ?? [];
    if (!list.some((a) => a.id === r.attemptId)) list.push({ id: r.attemptId, attemptKey: r.attemptId.toUpperCase() });
    atts.set(r.taskKey, list);
  }
  if (options.tasks !== false) for (const [taskKey, items] of atts) api.on(`GET /api/tasks/${taskKey}/attempts`, (route) => json(route, 200, { items, nextCursor: null }));
  api.on(`GET ${P}/queue`, (route) => json(route, 200, { items: data.queue }));
  api.on(`GET ${P}/flaky`, (route) => json(route, 200, { items: data.flaky }));
  api.on(`GET ${P}/pipeline`, (route) => json(route, 200, data.pipeline));
  api.on(`GET ${P}/settings`, (route) => json(route, 200, data.settings));
}
