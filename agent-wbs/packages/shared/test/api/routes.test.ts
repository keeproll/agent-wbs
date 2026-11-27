import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { ERROR_STATUS, OPERATIONS, type Principal } from '../../src/api/index.ts';

const repo = new URL('../../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), 'utf8');

// 파라미터 이름은 문서마다 다르므로 위치만 비교한다.
const key = (method: string, path: string) => `${method} ${path.replaceAll(/:\w+/g, ':')}`;
const routes = new Map(OPERATIONS.map((op) => [key(op.method, op.path), op]));

/** 가이드 §8 표에서 라우트와 주체를 읽는다. */
function guideRoutes(): { route: string; principal: Principal | 'mixed' }[] {
  const docs = readdirSync(new URL('prototype/docs/', repo)).filter((name) => name.endsWith('.md'));
  expect(docs).toHaveLength(1);
  const guide = read(`prototype/docs/${docs[0] ?? ''}`);
  const start = guide.indexOf('\n## 8. ');
  const end = guide.indexOf('\n## 9. ', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);

  const found: { route: string; principal: Principal | 'mixed' }[] = [];
  let heading = '';
  for (const line of guide.slice(start, end).split('\n')) {
    if (line.startsWith('### ')) heading = line;
    const cells = line.replaceAll('\\|', '/').split('|').map((cell) => cell.trim());
    const methods = cells[1]?.split(' · ') ?? [];
    if (!methods.every((method) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) || methods.length === 0) continue;

    // `GET /drifts · POST /:id/resolve`처럼 경로 칸에서 메서드가 바뀔 수 있다.
    const items = [...(cells[2] ?? '').matchAll(/(?:(GET|POST|PUT|PATCH|DELETE) )?`(\/[^`]*)`/g)];
    expect(items.length, line).toBeGreaterThan(0);
    const absolute = (items[0]?.[2] ?? '').replace(/\?.*$/, '');
    const collection = /\/approve$/.test(absolute) ? absolute.replace(/\/approve$/, '') : absolute;
    items.forEach((item, index) => {
      const raw = (item[2] ?? '').replace(/\?.*$/, '');
      let path = raw;
      if (index > 0 && !raw.startsWith('/api/')) {
        path = raw.startsWith('/ci/') ? `/api/projects/:projectId${raw}` : `${collection}${raw}`;
      }
      const principal = /8\.4/.test(heading)
        ? (cells[3] === '팀장' || cells[3] === '팀장 → Runner' ? 'lead' : 'runner')
        : /팀장 세션 · Runner 토큰|Runner 토큰 · 팀장 세션/.test(heading)
          ? 'mixed'
          : /팀장 세션/.test(heading)
            ? 'lead'
            : 'runner';
      // `GET · PATCH | /flaky · /:id`는 순서대로 짝이다.
      const paired = methods.length > 1 && methods.length === items.length ? [methods[index] ?? ''] : methods;
      for (const method of item[1] ? [item[1]] : paired) found.push({ route: key(method, path), principal });
    });
  }
  return found;
}

/** 프로토타입 Task 기술 설계의 Endpoint */
function prototypeRoutes(): string[] {
  return [...read('prototype/uiux/Main.dc.html').matchAll(/E\(\{method:'(\w+)', path:'([^']+)'/g)].map((m) =>
    key(m[1] ?? '', m[2] ?? ''),
  );
}

/** contracts.md의 ★ 보강 경로(표기가 자유 형식이라 옮겨 적었다. 아래 테스트가 원문에 있는지 확인한다). */
const SUPPLEMENTS = `
PATCH /api/tasks/:k/spec
PATCH /api/tasks/:k/design/:kind
PATCH /api/tasks/:k/checklist/:itemKey
PATCH /api/tasks/:k/outputs
POST /api/tasks/:k/checklist
DELETE /api/tasks/:k/checklist/:itemKey
POST /api/tasks/:k/request-approval
POST /api/tasks/:k/approve
POST /api/tasks/:k/reject
GET /api/tasks/:k/gate
POST /api/tasks/:k/complete
GET /api/tasks/:k/history
GET /api/tasks/:k/attempts
GET /api/tasks/:k/verifications
GET /api/tasks/:k/messages
PUT /api/tasks/:k/grade
DELETE /api/tasks/:k/grade
POST /api/tasks/:k/split
POST /api/tasks/:k/split-exceptions
POST /api/tasks/:k/runs
POST /api/attempts/:id/stop
POST /api/attempts/:id/resume
GET /api/messages
POST /api/messages
PATCH /api/messages/:id
POST /api/messages/:id/send
POST /api/messages/:id/cancel
POST /api/messages/:id/resend
POST /api/messages/:id/read
GET /api/plannings
POST /api/plannings
POST /api/plannings/:id/reviews/:rid/choice
POST /api/plannings/:id/proposals
GET /api/proposals
POST /api/proposals
GET /api/proposals/:id/preview
POST /api/proposals/:id/submit
POST /api/proposals/:id/approve
POST /api/proposals/:id/reject
POST /api/proposals/:id/request-changes
POST /api/proposals/:id/apply
GET /api/dashboard
GET /api/schedule
GET /api/replans
POST /api/replans/run
GET /api/verifications
GET /api/evidence
GET /api/evidence/:id/content
GET /api/gates
GET /api/history
GET /api/settings/workflow
PUT /api/settings/workflow
GET /api/settings/exec-policy
PUT /api/settings/exec-policy
GET /api/settings/models
PUT /api/settings/models
GET /api/settings/split
PUT /api/settings/split
GET /api/settings/schedule
PUT /api/settings/schedule
GET /api/settings/blackouts
PUT /api/settings/blackouts
GET /api/settings/concurrency
PUT /api/settings/concurrency
GET /api/settings/obs-budget
PUT /api/settings/obs-budget
GET /api/settings/subagents
PUT /api/settings/subagents
GET /api/settings/ci
PUT /api/settings/ci
GET /api/runner-state
GET /api/alerts
GET /api/system/integrity
POST /api/auth/session
DELETE /api/auth/session
GET /api/session
GET /api/project/repo-checks/:id
GET /api/project
POST /api/project/bootstrap/retry
POST /api/project/inputs/retry
POST /api/project/inputs/recheck
GET /api/project/reset-preview
GET /api/project/export
POST /api/settings/github/check
GET /api/projects/:p/ci/pipeline
GET /api/projects/:p/ci/settings
PATCH /api/projects/:p/ci/settings
POST /api/runner/messages/:id/response
POST /api/runner/attempts/:id/evidence
POST /api/runner/attempts/:id/subagent-usage
POST /api/runner/ci/queue
POST /api/runner/github/status
POST /api/runner/github/key
GET /api/runner/github/credential
GET /api/runner/policy
POST /api/runner/commands/:id/result
POST /api/runner/jobs/claim
POST /api/runner/jobs/:id/renew
POST /api/runner/jobs/:id/start
POST /api/runner/jobs/:id/process
POST /api/runner/jobs/:id/slots/release
POST /api/runner/jobs/:id/slots/acquire
POST /api/runner/jobs/:id/release
POST /api/runner/jobs/:id/reconcile
POST /api/runner/jobs/:id/finish
POST /api/planning/bootstrap/:jobId/tech
POST /api/planning/sessions
POST /api/planning/sessions/:id/analyses
POST /api/planning/sessions/:id/reviews
POST /api/planning/proposals
POST /api/planning/proposals/:id/judgements
POST /api/planning/tasks/:k/plan
GET /api/changes
`
  .trim()
  .split('\n');

test('가이드 §8의 모든 경로가 있고 주체가 같다', () => {
  const guide = guideRoutes();
  // 절별 행이 파서에서 빠지면 대조가 헛통과한다.
  expect(new Set(guide.map(({ route }) => route)).size).toBe(91);
  for (const { route, principal } of guide) {
    const op = routes.get(route);
    expect(op, route).toBeDefined();
    // 혼합 절(§8.5-1·§8.6)에서 /design/decisions POST는 용도가 「Agent 제안」이라 Runner다(G L978).
    const expected = principal === 'mixed'
      ? (/ \/api\/(runner|planning)\//.test(route) || route === 'POST /api/projects/:/design/decisions' ? 'runner' : 'lead')
      : principal;
    expect(op?.principal, route).toBe(expected);
  }
});

test('프로토타입 Endpoint가 모두 있다', () => {
  const endpoints = prototypeRoutes();
  expect(endpoints).toHaveLength(23);
  for (const route of endpoints) expect(routes.has(route), route).toBe(true);
});

test('계획의 보강 경로가 모두 있고 원문에 근거가 있다', () => {
  const contracts = read('docs/plan/contracts.md');
  for (const line of SUPPLEMENTS) {
    const [method = '', path = ''] = line.split(' ');
    expect(routes.has(key(method, path)), line).toBe(true);
    const segment = path.split('/').filter((part) => !part.startsWith(':')).at(-1) ?? '';
    expect(contracts.includes(segment), line).toBe(true);
  }
});

test('원본·계획에 없는 경로를 만들지 않았다', () => {
  // 서버 후속 2: UAT-PROJECT-10·09b, UAT-CP-01·02와 계획 §2.1의 「초안은 팀장이 다듬은 뒤 제출」.
  // 원본의 편집·확인·모달 취소·항목 제외를 서버에 연결한다. 이력 삭제는 허용하지 않는다.
  expect(read('docs/ui/acceptance.md')).toContain('UAT-PROJECT-10');
  expect(read('prototype/uiux/Main.dc.html')).toContain('cpRemoveOp(cpId, i)');
  // 서버 후속 3: G§5.2-1·§7.4와 P의 분할 목록·사용 현황·알림 확인·준비 상태 재점검을 연결한다.
  for (const text of ['기준을 벗어난 Task', '팀장 고정 Task', '지정 Task', 'cfg.rd.recheck', 'al.done']) {
    expect(read('prototype/uiux/Main.dc.html')).toContain(text);
  }
  const followup = ['PATCH /api/project', 'POST /api/project/inputs/check', 'GET /api/proposals/:id',
    'PATCH /api/proposals/:id', 'DELETE /api/proposals/:id', 'POST /api/proposals/:id/exclude',
    'POST /api/verifications/:id/evidence', 'GET /api/settings/split/violations', 'GET /api/settings/agent-usage',
    'POST /api/alerts/:id/ack', 'POST /api/settings/readiness/check',
    // 조정자 승인(2026-11-27, M5-02): contracts §3.4-3의 재시작 전 보유 대조에 필요하다.
    'GET /api/runner/holds',
    // M7-06 조정자 결정 2: 실제 CI 작업의 소유권·QA·재실행 근거를 Runner가 읽는다.
    'GET /api/runner/ci/jobs/:id',
    // M6 통합: M6-07 남은 연결 「브랜치 목록 API 없음」(coordinator 지시). 계획 문서(contracts §2.3 설계)에 아직 없어 보고서에 반영 문구를 적었다.
    'GET /api/projects/:projectId/design/refs'];
  const known = new Set([
    'GET /health',
    'GET /health/db',
    ...guideRoutes().map(({ route }) => route),
    ...prototypeRoutes(),
    ...SUPPLEMENTS.map((line) => key(line.split(' ')[0] ?? '', line.split(' ')[1] ?? '')),
    ...followup.map((line) => key(line.split(' ')[0] ?? '', line.split(' ')[1] ?? '')),
  ]);
  expect([...routes.keys()].filter((route) => !known.has(route))).toEqual([]);
  expect(routes.size).toBe(OPERATIONS.length);
  expect(new Set(OPERATIONS.map((op) => op.id)).size).toBe(OPERATIONS.length);
});

test('오류 코드는 계획 §1.1 표·본문과 상태가 같다', () => {
  const contracts = read('docs/plan/contracts.md');
  const table = contracts.slice(contracts.indexOf('### 1.1'), contracts.indexOf('### 1.2'));
  const listed: Record<string, number> = {};
  for (const [, statuses = '', cell = ''] of table.matchAll(/^\| ([\d/]+) \| ([^|]+) \|/gm)) {
    const codes = [...cell.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1] ?? '');
    if (codes.length === 0) continue;
    const list = statuses.split('/').map(Number);
    codes.forEach((code, i) => (listed[code] = list[Math.min(i, list.length - 1)] ?? 0));
  }
  expect(Object.keys(listed)).toHaveLength(36);
  expect(ERROR_STATUS).toMatchObject(listed);

  // §1·§2.3·§2.4 본문에만 있는 코드
  const inText: Record<string, number> = {};
  for (const [, status, code = ''] of contracts.matchAll(/(400|401|403|503) `([A-Z]+_[A-Z_]+)`/g)) inText[code] = Number(status);
  expect(inText).toMatchObject({ IDEMPOTENCY_KEY_REQUIRED: 400, LOGIN_FAILED: 401, PDF_FAILED: 503 });
  expect(Object.keys(ERROR_STATUS).sort()).toEqual([...new Set([...Object.keys(listed), ...Object.keys(inText)])].sort());
});

test('프로토타입 Endpoint가 정한 오류 코드·상태를 선언한다', () => {
  const html = read('prototype/uiux/Main.dc.html');
  let checked = 0;
  for (const line of html.split('\n')) {
    const endpoint = /E\(\{method:'(\w+)', path:'([^']+)'/.exec(line);
    if (!endpoint) continue;
    const op = routes.get(key(endpoint[1] ?? '', endpoint[2] ?? ''));
    for (const [, code = '', http] of line.matchAll(/\{code:'([A-Z_]+)', http:'(\d+)'/g)) {
      checked += 1;
      expect((op?.errors as string[] | undefined) ?? [], `${line.slice(0, 80)} ${code}`).toContain(code);
      expect(ERROR_STATUS[code as keyof typeof ERROR_STATUS]).toBe(Number(http));
    }
  }
  expect(checked).toBe(30);
});
