/**
 * UI-02E 입력 변경·버전·차이 분석 — 시나리오 31, UAT-PROJECT-09, UAT-PROJECT-UI d,
 * 입력 이력 재작성 경고의 「복구 확인 · 입력 확인 다시 시도」(POST /api/project/inputs/recheck, 조정자 결정 2026-11-26).
 */
import { expect, test, type Page } from '@playwright/test';
import { errorBody, fakeApi, hold, json, type FakeApi } from './support/fake-api.ts';
import { activeProject, GITHUB_OK, PENDING, SHA1, SHA3, MD, T0, V1, V2 } from './support/project-fixtures.ts';

async function openProject(page: Page, project = activeProject({ changeCommits: PENDING, inputHead: SHA3 })): Promise<FakeApi> {
  const api = await fakeApi(page, { project });
  api.on('GET /api/settings/github', (route) => json(route, 200, GITHUB_OK));
  api.on('GET /api/alerts', (route) => json(route, 200, { items: [] }));
  await page.goto('/project');
  await expect(page.getByRole('heading', { name: '프로젝트', level: 1 })).toBeVisible();
  return api;
}

test('시나리오 31 · UAT-PROJECT-UI d: 변경 커밋 2개·파일 4개를 영역(프로토타입/설계 문서)·추가·삭제로 보인다', async ({ page }) => {
  await openProject(page);
  const box = page.getByTestId('input-pending');
  await expect(box).toContainText('분석하지 않은 입력 변경 커밋 2개 — 파일 4개 (프로토타입 1 · 설계 문서 3)');
  await expect(box.getByRole('table', { name: '변경 커밋' })).toContainText('7b1c9e2');
  const files = box.getByRole('table', { name: '변경 파일' });
  await expect(files.getByRole('row').filter({ hasText: 'prototype/docs/알림-정의.md' })).toContainText('설계 문서');
  await expect(files.getByRole('row').filter({ hasText: 'prototype/docs/알림-정의.md' })).toContainText('추가');
  await expect(files.getByRole('row').filter({ hasText: 'prototype/docs/용어-정의.md' })).toContainText('삭제');
  await expect(files.getByRole('row').filter({ hasText: 'prototype/uiux/task-detail.html' })).toContainText('프로토타입');
  await expect(files.getByRole('row').filter({ hasText: 'prototype/uiux/task-detail.html' })).toContainText('+52 −8');
  await expect(files).not.toContainText('src/');
});

test('「이 버전으로 분석」: 입력 사슬 끝 커밋과 확인한 커밋 목록·지시를 보내고 차이 분석 단계를 보인다', async ({ page }) => {
  const api = await openProject(page);
  api.on('POST /api/project/inputs', (route) => {
    api.on('GET /api/project', (r) => json(r, 200, activeProject({
      inputHead: SHA3, updatedAt: V2,
      changeCommits: PENDING.map((c) => ({ ...c, state: 'analyzed' })) as typeof PENDING,
      inputs: [
        { v: 1, at: T0, commit: SHA1, mdList: MD, changes: [], instruction: '', result: '초기 WBS', taskCount: 3 },
        { v: 2, at: T0, commit: SHA3, mdList: MD, changes: [{ path: 'prototype/uiux/task-detail.html', change: 'modified' }], instruction: '수정 Task로 분리', result: '차이 분석 중', taskCount: 0 },
      ] as never,
      inputJob: { jobId: 'j9', runNo: 1, status: 'running', version: 2, proposalId: null, logs: [], fail: null,
        steps: [{ key: 'check', status: 'done', at: T0, note: 'v2 main @ a41f03d' }, { key: 'unzip', status: 'run', at: T0, note: '' }, { key: 'diff', status: 'wait', at: null, note: '' }, { key: 'impact', status: 'wait', at: null, note: '' }, { key: 'cp', status: 'wait', at: null, note: '' }] } as never,
    })));
    return json(route, 202, { jobId: 'j9' });
  });
  await page.getByLabel('팀장 지시').fill('수정 Task로 분리');
  await page.getByRole('button', { name: '이 버전으로 분석' }).click();
  await expect(page.getByText('입력 자료 v2 (main @ a41f03d)으로 고정했습니다.', { exact: false })).toBeVisible();
  expect(api.requests('POST /api/project/inputs')[0]?.postDataJSON()).toEqual({ updatedAt: V1, commit: SHA3, commits: PENDING.map((c) => c.sha), instr: '수정 Task로 분리' });
  const job = page.getByTestId('input-job');
  await expect(job).toContainText('입력 자료 v2 차이 분석');
  await expect(job.locator('[data-step="unzip"]')).toContainText('진행 중');
  await expect(page.getByRole('table', { name: '입력 자료 버전' })).toContainText('v2');
  await expect(page.getByTestId('input-none')).toBeVisible();
});

test('UAT-PROJECT-09 a: 「분석 안 함」은 확인 기록을 남기고, 이미 분석한 커밋은 INPUT_UNCHANGED로 거부를 보인다', async ({ page }) => {
  const api = await openProject(page);
  api.on('POST /api/project/inputs', (route) => json(route, 409, errorBody('INPUT_UNCHANGED', { message: '이미 분석한 입력 커밋입니다.' })));
  await page.getByRole('button', { name: '이 버전으로 분석' }).click();
  await expect(page.getByRole('alert')).toContainText('409 INPUT_UNCHANGED');
  await page.getByRole('alert').getByRole('button', { name: '닫기' }).click();

  api.on('POST /api/project/inputs/skip', (route) => {
    api.on('GET /api/project', (r) => json(r, 200, activeProject({ inputHead: SHA3, changeCommits: PENDING.map((c) => ({ ...c, state: 'skipped' })) as typeof PENDING })));
    return json(route, 204, null);
  });
  await page.getByRole('button', { name: '분석 안 함' }).click();
  await expect(page.getByText('변경 커밋을 「확인함 · 분석 안 함」으로 남겼습니다. 다음 분석 때 이 변경도 함께 비교됩니다.')).toBeVisible();
  expect(api.requests('POST /api/project/inputs/skip')[0]?.postDataJSON()).toEqual({ updatedAt: V1, commits: PENDING.map((c) => c.sha) });
  await expect(page.getByTestId('input-none')).toContainText('확인함 · 분석 안 함 2개 — 다음 분석 때 함께 비교.');
});

test('UAT-PROJECT-09 b: 입력 버전의 출처 Task 수를 누르면 그 버전으로 거른 WBS로 간다', async ({ page }) => {
  await openProject(page, activeProject());
  await page.getByRole('link', { name: 'v1 출처 Task 3건 WBS에서 보기' }).click();
  await expect(page).toHaveURL('/wbs?srcV=1');
});

test('차이 분석 실패: 원인·조치와 「다시 시도」(실패한 입력 버전)', async ({ page }) => {
  const api = await openProject(page, activeProject({
    inputJob: { jobId: 'j9', runNo: 1, status: 'failed', version: 2, proposalId: null, logs: [], fail: { reason: 'Agent 응답 없음 — Codex 세션이 10분 동안 출력이 없었습니다', fix: 'Runner 상태를 확인한 뒤 다시 시도하세요.' },
      steps: [{ key: 'check', status: 'done', at: T0, note: '' }, { key: 'unzip', status: 'done', at: T0, note: '' }, { key: 'diff', status: 'done', at: T0, note: '' }, { key: 'impact', status: 'fail', at: T0, note: '' }, { key: 'cp', status: 'wait', at: null, note: '' }] } as never,
  }));
  const job = page.getByTestId('input-job');
  await expect(job).toContainText('Planning — Codex · Claude 영향 분석 실패 — Agent 응답 없음');
  api.on('POST /api/project/inputs/retry', (route) => json(route, 202, { jobId: 'j10' }));
  await job.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByText('차이 분석을 실패한 단계부터 다시 시도합니다.')).toBeVisible();
  expect(api.requests('POST /api/project/inputs/retry')[0]?.postDataJSON()).toEqual({ updatedAt: V1, version: 2 });
});

test('입력 이력 재작성 경고: 「복구 확인 · 입력 확인 다시 시도」는 프로젝트 버전으로 recheck를 요청하고, 경고는 서버가 풀 때만 사라진다', async ({ page }) => {
  const api = await openProject(page, activeProject());
  const alert = { id: 'al1', key: 'input_history_rewritten', severity: 'error', taskKey: null, target: null, text: `main 이력이 바뀌었습니다: 마지막 입력 커밋 ${SHA1}가 새 main ${SHA3}의 조상이 아닙니다. 입력 변경을 받지 않습니다.`, at: T0 };
  api.on('GET /api/alerts', (route) => json(route, 200, { items: [alert] }));
  await page.reload();
  const box = page.getByTestId('rewrite-alert');
  await expect(box).toContainText('입력 이력 재작성 감지');
  await expect(box).toContainText('의 조상이 아닙니다');
  api.on('POST /api/project/inputs/recheck', (route) => json(route, 202, { inputRecheck: 1 }));
  await box.getByRole('button', { name: '복구 확인 · 입력 확인 다시 시도' }).click();
  await expect(page.getByText('입력 확인을 다시 요청했습니다 (1번째).', { exact: false })).toBeVisible();
  const req = api.requests('POST /api/project/inputs/recheck')[0];
  expect(req?.postDataJSON()).toEqual({ updatedAt: V1 });
  expect(req?.headers()['idempotency-key']).toBeTruthy();
  // 요청만으로 경고를 지우지 않는다. Runner의 유효한 보고로 서버가 해소해야 사라진다.
  await expect(box).toBeVisible();
  api.on('GET /api/alerts', (route) => json(route, 200, { items: [] }));
  await page.reload();
  await expect(page.getByTestId('rewrite-alert')).toHaveCount(0);
});

test('재작성 경고가 이미 풀렸으면(409 INVALID_TRANSITION) 이유를 보이고 다시 읽는다', async ({ page }) => {
  const api = await openProject(page, activeProject());
  api.on('GET /api/alerts', (route) => json(route, 200, { items: [{ id: 'al1', key: 'input_history_rewritten', severity: 'error', taskKey: null, target: null, text: '이력 재작성', at: T0 }] }));
  await page.reload();
  api.on('POST /api/project/inputs/recheck', (route) => {
    api.on('GET /api/alerts', (r) => json(r, 200, { items: [] }));
    return json(route, 409, errorBody('INVALID_TRANSITION', { message: '열린 입력 이력 재작성 경고가 없습니다.' }));
  });
  await page.getByRole('button', { name: '복구 확인 · 입력 확인 다시 시도' }).click();
  await expect(page.getByRole('alert')).toContainText('409 INVALID_TRANSITION');
  await expect(page.getByTestId('rewrite-alert')).toHaveCount(0);
});

test('recheck 409 VERSION_CONFLICT: 충돌 창에서 다시 적용하면 최신 프로젝트 버전으로 보낸다', async ({ page }) => {
  const api = await openProject(page, activeProject());
  api.on('GET /api/alerts', (route) => json(route, 200, { items: [{ id: 'al1', key: 'input_history_rewritten', severity: 'error', taskKey: null, target: null, text: '이력 재작성', at: T0 }] }));
  await page.reload();
  api.on('POST /api/project/inputs/recheck', (route) => json(route, 409, errorBody('VERSION_CONFLICT', { details: { current: null, changes: [] } })));
  await page.getByRole('button', { name: '복구 확인 · 입력 확인 다시 시도' }).click();
  const modal = page.getByRole('alertdialog');
  await expect(modal).toBeVisible();
  api.on('GET /api/project', (r) => json(r, 200, activeProject({ updatedAt: V2 })));
  api.on('POST /api/project/inputs/recheck', (route) => json(route, 202, { inputRecheck: 2 }));
  await modal.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(modal).toHaveCount(0);
  expect(api.requests('POST /api/project/inputs/recheck').at(-1)?.postDataJSON()).toEqual({ updatedAt: V2 });
});

test('GitHub 권한 부족이면 입력 변경 확인이 멈춘 것을 알린다', async ({ page }) => {
  const api = await openProject(page, activeProject());
  api.on('GET /api/settings/github', (route) => json(route, 200, { ...GITHUB_OK, scopes: { ...GITHUB_OK.scopes, contents: 'missing' } }));
  await page.reload();
  await expect(page.getByText('GitHub 인증 실패 — 입력 변경 확인이 멈춰 있습니다.', { exact: false })).toBeVisible();
});

const REWRITE = { id: 'al1', key: 'input_history_rewritten', severity: 'error', taskKey: null, target: null, text: '이력 재작성', at: T0 };
test('리뷰 P2: recheck 충돌 재적용의 응답을 잃으면 최신을 다시 읽지 않고 같은 키·같은 본문으로 다시 보낸다', async ({ page }) => {
  const api = await openProject(page, activeProject());
  api.on('GET /api/alerts', (route) => json(route, 200, { items: [REWRITE] }));
  await page.reload();
  const url = 'POST /api/project/inputs/recheck';
  api.on(url, (route) => json(route, 409, errorBody('VERSION_CONFLICT', { details: { current: null, changes: [] } })));
  await page.getByRole('button', { name: '복구 확인 · 입력 확인 다시 시도' }).click();
  const modal = page.getByRole('alertdialog');
  await expect(modal).toBeVisible();
  api.on('GET /api/project', (r) => json(r, 200, activeProject({ updatedAt: V2 })));
  let n = 0;
  api.on(url, (route) => (++n === 1 ? route.abort('failed') : json(route, 202, { inputRecheck: 2 })));
  await modal.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(modal).toContainText('NETWORK_ERROR');
  // 그사이 프로젝트 버전이 또 바뀌어도 결과를 모르는 요청을 먼저 그대로 끝낸다.
  api.on('GET /api/project', (r) => json(r, 200, activeProject({ updatedAt: '2026-11-05T11:09:00.000000Z' })));
  await modal.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(modal).toHaveCount(0);
  const [, a, b] = api.requests(url);
  expect(b?.headers()['idempotency-key']).toBe(a?.headers()['idempotency-key']);
  expect(a?.postDataJSON()).toEqual({ updatedAt: V2 });
  expect(b?.postDataJSON()).toEqual({ updatedAt: V2 });
});

for (const c of [
  { name: '이 버전으로 분석', url: 'POST /api/project/inputs', ok: (route: Parameters<Parameters<FakeApi['on']>[1]>[0]) => json(route, 202, { jobId: 'j1' }) },
  { name: '분석 안 함', url: 'POST /api/project/inputs/skip', ok: (route: Parameters<Parameters<FakeApi['on']>[1]>[0]) => json(route, 204, null) },
]) {
  test(`리뷰 P2: 「${c.name}」 충돌 재적용 재시도는 같은 키`, async ({ page }) => {
    const api = await openProject(page);
    api.on(c.url, (route) => json(route, 409, errorBody('VERSION_CONFLICT', { details: { current: null, changes: [] } })));
    await page.getByRole('button', { name: c.name, exact: true }).click();
    const modal = page.getByRole('alertdialog');
    await expect(modal).toBeVisible();
    let n = 0;
    api.on(c.url, (route) => (++n === 1 ? route.abort('failed') : c.ok(route)));
    await modal.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
    await expect(modal).toContainText('NETWORK_ERROR');
    await modal.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
    await expect(modal).toHaveCount(0);
    const [, a, b] = api.requests(c.url);
    expect(b?.headers()['idempotency-key']).toBe(a?.headers()['idempotency-key']);
    expect(b?.postDataJSON()).toEqual(a?.postDataJSON());
  });
}

test('UAT-PROJECT-10: 프로젝트 정보 편집 — 필수·날짜 형식 검사, 저장은 PATCH /api/project(버전·멱등 키), 응답으로 다시 그린다', async ({ page }) => {
  const api = await openProject(page, activeProject());
  const card = page.getByRole('region', { name: '프로젝트 정보' });
  await expect(card).toContainText('2026-10-27 ~ 2027-02-26');
  await expect(card.getByTestId('pj-desc')).toHaveText('Agent WBS를 Agent WBS로 개발한다.');
  await card.getByRole('button', { name: '편집' }).click();
  await card.getByLabel('시작일').fill('2026/11/01');
  await card.getByRole('button', { name: '저장' }).click();
  await expect(card.getByRole('alert')).toHaveText('시작일은 필수이며, 날짜는 YYYY-MM-DD 형식이어야 합니다. 시작일을 바꾸면 전체 계획 일정이 다시 계산됩니다.');
  expect(api.requests('PATCH /api/project')).toHaveLength(0);
  await card.getByLabel('시작일').fill('2026-11-02');
  await card.getByLabel('이름').fill('Agent WBS 2차');
  await card.getByLabel('목표일').fill('');
  const saved = activeProject({ name: 'Agent WBS 2차', startDate: '2026-11-02', targetDate: null, updatedAt: '2026-11-05T13:00:00.000000Z' } as never);
  api.on('PATCH /api/project', (route) => { api.on('GET /api/project', (r) => json(r, 200, saved)); return json(route, 200, saved); });
  await card.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText('프로젝트 정보를 저장했습니다.')).toBeVisible();
  const req = api.requests('PATCH /api/project')[0];
  // PATCH는 계약상 멱등 키 없이 버전(updatedAt)으로 충돌을 막는다.
  expect(req?.postDataJSON()).toEqual({ updatedAt: (activeProject() as { updatedAt: string }).updatedAt, name: 'Agent WBS 2차', description: 'Agent WBS를 Agent WBS로 개발한다.', startDate: '2026-11-02', targetDate: null });
  await expect(card).toContainText('2026-11-02 ~ —');
  await expect(card.getByRole('button', { name: '편집' })).toBeVisible();
});

test('UAT-PROJECT-10: 편집 중에는 메뉴 이동을 확인하고, 400은 입력을 지킨 채 오류 막대로 알린다', async ({ page }) => {
  const api = await openProject(page, activeProject());
  const card = page.getByRole('region', { name: '프로젝트 정보' });
  await card.getByRole('button', { name: '편집' }).click();
  await card.getByLabel('이름').fill('바꾼 이름');
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '설정', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page).toHaveURL('/project');
  api.on('PATCH /api/project', (route) => json(route, 400, errorBody('VALIDATION_FAILED', { errors: [{ path: '/startDate', rule: 'format', message: '날짜 형식이 아닙니다.' }] })));
  await card.getByRole('button', { name: '저장' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '저장하지 못했습니다' })).toBeVisible();
  await expect(card.getByLabel('이름')).toHaveValue('바꾼 이름');
});

test('UAT-PROJECT-09 b: 감지 확인 시각은 서버 inputCheckedAt, 「지금 확인」은 POST /api/project/inputs/check(202)만 보내고 시각을 꾸며 내지 않는다', async ({ page }) => {
  const api = await openProject(page, activeProject());
  await expect(page.getByTestId('input-checked-at')).toHaveText('Runner 확인 2026-11-05 21:45');
  api.on('POST /api/project/inputs/check', (route) => json(route, 202, { inputCheckRequest: 3 }));
  await page.getByRole('button', { name: '지금 확인' }).click();
  await expect(page.getByText('main 확인을 요청했습니다 — Runner가 확인해 보고하면 확인 시각과 변경 목록이 바뀝니다.')).toBeVisible();
  const req = api.requests('POST /api/project/inputs/check')[0];
  expect(req?.postDataJSON()).toEqual({ updatedAt: (activeProject() as { updatedAt: string }).updatedAt });
  expect(req?.headers()['idempotency-key']).toBeTruthy();
  await expect(page.getByTestId('input-checked-at')).toHaveText('Runner 확인 2026-11-05 21:45');
});

test('UAT-PROJECT-09 b: 관측 보고가 아직 없으면 「확인 기록 없음」', async ({ page }) => {
  await openProject(page, activeProject({ inputCheckedAt: null } as never));
  await expect(page.getByTestId('input-checked-at')).toHaveText('Runner 확인 기록 없음');
});

test('GitHub 연결 상태를 읽지 못하면(서버 404) 상태를 모른다고 알린다', async ({ page }) => {
  const api = await openProject(page, activeProject());
  api.on('GET /api/settings/github', (route) => json(route, 404, errorBody('NOT_FOUND')));
  await page.reload();
  await expect(page.getByTestId('gh-unknown')).toContainText('GitHub 연결 상태를 확인하지 못했습니다');
});

test('재리뷰 P2-1: 재적용 응답 유실 뒤 Esc로 닫아도 결과 모르는 요청이 남고, 일반 버튼은 새 키로 보내지 않으며 같은 키·본문으로만 다시 보낸다', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
  const api = await openProject(page, activeProject());
  api.on('GET /api/alerts', (route) => json(route, 200, { items: [REWRITE] }));
  await page.reload();
  const url = 'POST /api/project/inputs/recheck';
  api.on(url, (route) => json(route, 409, errorBody('VERSION_CONFLICT', { details: { current: null, changes: [] } })));
  await page.getByRole('button', { name: '복구 확인 · 입력 확인 다시 시도' }).click();
  const modal = page.getByRole('alertdialog');
  api.on('GET /api/project', (r) => json(r, 200, activeProject({ updatedAt: V2 })));
  api.on(url, (route) => route.abort('failed'));
  await modal.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(modal).toContainText('NETWORK_ERROR');
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  // 창을 닫아도 결과 모르는 요청은 오류 막대에 남는다.
  await expect(page.getByRole('alert')).toContainText('NETWORK_ERROR');
  // 그사이 변경 이벤트로 프로젝트 버전이 바뀐다.
  api.on('GET /api/project', (r) => json(r, 200, activeProject({ updatedAt: '2026-11-05T11:10:00.000000Z' })));
  let once = true;
  api.on('GET /api/changes', (r) => json(r, 200, { events: once ? [(once = false, { id: 1, topic: 'project', refs: [] })] : [], next: 1, reset: false }));
  await page.clock.runFor(3_100);
  await expect.poll(() => api.requests('GET /api/project').length).toBeGreaterThan(2);
  let n = 0;
  api.on(url, (route) => json(route, 202, { inputRecheck: ++n }));
  await page.getByTestId('rewrite-alert').getByRole('button', { name: '복구 확인 · 입력 확인 다시 시도' }).click();
  await expect(page.getByRole('alert')).toContainText('이전 요청의 결과를 아직 모릅니다.');
  expect(n).toBe(0);
  await page.getByRole('alert').getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByText('입력 확인을 다시 요청했습니다 (1번째).', { exact: false })).toBeVisible();
  const [, lost, again] = api.requests(url);
  expect(again?.headers()['idempotency-key']).toBe(lost?.headers()['idempotency-key']);
  expect(again?.postDataJSON()).toEqual({ updatedAt: V2 });
  expect(api.requests(url)).toHaveLength(3);
});

test('재리뷰 P2-2: 입력 분석 충돌 창의 최신 불러오기가 실패하면 창을 열어 둔 채 이유를 보이고 지시를 지우지 않는다', async ({ page }) => {
  const api = await openProject(page);
  api.on('POST /api/project/inputs', (route) => json(route, 409, errorBody('VERSION_CONFLICT', { details: { current: null, changes: [] } })));
  await page.getByLabel('팀장 지시').fill('유지할 지시');
  await page.getByRole('button', { name: '이 버전으로 분석' }).click();
  const modal = page.getByRole('alertdialog');
  api.on('GET /api/project', (r) => json(r, 503, errorBody('UNAVAILABLE')));
  await modal.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' }).click();
  await expect(modal).toContainText('최신 내용을 불러오지 못했습니다');
  await expect(modal).toContainText('503 UNAVAILABLE');
  await expect(page.getByText('최신 내용을 불러왔습니다. 내 변경은 적용되지 않았습니다.')).toHaveCount(0);
  await expect(page.getByLabel('팀장 지시')).toHaveValue('유지할 지시');
});

test('M3-08 재리뷰 P2: 입력 분석 충돌의 최신 불러오기 중 Esc로 닫으면 늦은 응답을 화면에 적용하지 않는다(signal)', async ({ page }) => {
  const api = await openProject(page);
  api.on('POST /api/project/inputs', (route) => json(route, 409, errorBody('VERSION_CONFLICT', { details: { current: null, changes: [] } })));
  await page.getByRole('button', { name: '이 버전으로 분석' }).click();
  const modal = page.getByRole('alertdialog');
  await expect(modal).toBeVisible();
  // 늦게 오는 응답은 대기 커밋이 없는 프로젝트다. 적용되면 「입력 자료 변경 감지」 상자가 사라진다.
  const slow = hold((route) => json(route, 200, activeProject({ updatedAt: V2 })).catch(() => undefined));
  api.on('GET /api/project', slow.handler);
  await modal.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' }).click();
  await expect.poll(() => api.requests('GET /api/project').length).toBeGreaterThan(1);
  const loading = await slow.started;
  const cancelled = page.waitForEvent('requestfailed', { predicate: request => request === loading });
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await page.getByLabel('팀장 지시').fill('닫은 뒤 새로 쓴 지시');
  slow.release();
  await cancelled;
  await expect(page.getByTestId('input-pending')).toBeVisible();
  await expect(page.getByLabel('팀장 지시')).toHaveValue('닫은 뒤 새로 쓴 지시');
  await expect(page.getByText('최신 내용을 불러왔습니다. 내 변경은 적용되지 않았습니다.')).toHaveCount(0);
});
