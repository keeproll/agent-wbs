/**
 * UI-02A 프로젝트 등록 — 시나리오 30, UAT-PROJECT-02, UAT-SHELL-02, UAT-PROJECT-UI a.
 * 저장소 확인은 POST(202 id) → Runner 결과를 GET으로 기다리는 흐름이다. 가짜 API가 Runner 결과를 대신 준다.
 */
import { expect, test, type Page } from '@playwright/test';
import { errorBody, fakeApi, json, NO_PROJECT, RUNNER, type FakeApi } from './support/fake-api.ts';
import { bootProject, GITHUB_OK, REPO_OK, PROJECT_ID, JOB_ID, steps, activeProject } from './support/project-fixtures.ts';

async function openRegister(page: Page): Promise<FakeApi> {
  const api = await fakeApi(page, { project: NO_PROJECT });
  api.on('GET /api/settings/github', (route) => json(route, 200, GITHUB_OK));
  api.on('GET /api/system/resets', (route) => json(route, 200, { items: [] }));
  await page.goto('/project');
  await expect(page.getByRole('heading', { name: '프로젝트 등록', level: 1 })).toBeVisible();
  return api;
}
/** 저장소 확인 요청 → 결과(GET) 한 벌을 등록한다. */
function repoCheck(api: FakeApi, result: Record<string, unknown>) {
  api.on('POST /api/project/repo-checks', (route) => json(route, 202, { id: 'rc-1' }));
  api.on('GET /api/project/repo-checks/rc-1', (route) => json(route, 200, { ...REPO_OK, ...result }));
}

test('UAT-SHELL-02 등록 전: 프로젝트·설정만 열리고 승인 뒤 잠금이 풀린다', async ({ page }) => {
  const api = await openRegister(page);
  const nav = page.getByRole('navigation');
  const wbs = nav.getByRole('link', { name: 'WBS', exact: true });
  await expect(wbs).toHaveAttribute('aria-disabled', 'true');
  await expect(nav.getByRole('link', { name: '설정', exact: true })).not.toHaveAttribute('aria-disabled');
  await wbs.click({ force: true });
  await expect(page.getByRole('status').filter({ hasText: '먼저 프로젝트를 등록하세요.' })).toBeVisible();
  // 초기 분석 중에도 잠금, 승인(active) 뒤에는 열린다.
  api.on('GET /api/project', (route) => json(route, 200, bootProject()));
  await page.goto('/wbs');
  await expect(page.getByRole('note')).toContainText('초기 WBS를 승인하면 WBS 메뉴를 사용할 수 있습니다.');
  api.on('GET /api/project', (route) => json(route, 200, activeProject()));
  await page.goto('/wbs');
  await expect(page.getByText('이 화면은 아직 구현되지 않았습니다.')).toBeVisible();
  await expect(nav.getByRole('link', { name: 'WBS', exact: true })).not.toHaveAttribute('aria-disabled');
});

test('시나리오 30: 예시 값 → 저장소 접근 확인 → 구조 표·md 3개 → 등록하면 초기 분석으로 이동', async ({ page }) => {
  const api = await openRegister(page);
  await expect(page.getByTestId('gh-line')).toContainText('GitHub 인증: gh 로그인 · team-lead (gh)');
  await page.getByRole('button', { name: '예시 값 채우기' }).click();
  await expect(page.getByLabel('프로젝트 이름')).toHaveValue('Verum-SDN Agent WBS — Self Development');
  await expect(page.getByTestId('tech-row')).toHaveCount(4);
  await expect(page.getByLabel('조건', { exact: true })).toHaveValue('시계열 데이터(시간 순 대량 쓰기 · 구간 집계 · 보관 기간)가 있으면 사용');

  repoCheck(api, {});
  await page.getByRole('button', { name: '저장소 접근 확인' }).click();
  await expect(page.getByTestId('check-line')).toContainText('접근 확인 private · main @ 2dec2a4');
  const table = page.getByRole('table', { name: '필수 구조' });
  for (const p of ['prototype/uiux/', 'prototype/docs/', 'src/', 'contracts/', '.agentwbs/']) await expect(table).toContainText(p);
  await expect(table).toContainText('md 3개');
  await expect(page.getByText('설계 문서: prototype/docs/Agent-WBS-설계의도-및-구현가이드.md')).toBeVisible();
  expect(api.requests('POST /api/project/repo-checks')[0]?.postDataJSON()).toEqual({ url: 'https://github.com/verum-sdn/agent-wbs' });

  api.on('POST /api/project', (route) => {
    api.on('GET /api/project', (r) => json(r, 200, bootProject({ steps: steps('check') })));
    return json(route, 201, { project: { id: PROJECT_ID, name: 'x' }, jobId: JOB_ID });
  });
  await page.getByRole('button', { name: '등록 · 초기 분석 시작' }).click();
  await expect(page.getByRole('heading', { name: /초기 분석/, level: 1 })).toBeVisible();
  await expect(page.getByText('프로젝트를 등록했습니다. Runner가 초기 분석을 시작합니다.')).toBeVisible();
  const req = api.requests('POST /api/project')[0];
  expect(req?.headers()['idempotency-key']).toBeTruthy();
  expect(req?.postDataJSON()).toEqual({
    name: 'Verum-SDN Agent WBS — Self Development', url: 'https://github.com/verum-sdn/agent-wbs', targetDate: '2027-02-26',
    instruction: 'prototype/uiux/ 와 prototype/docs/ 설계 문서를 분석하고 Task 식별을 시작하자.', repoCheckId: 'rc-1',
    constraints: [
      { name: 'PostgreSQL 16', level: 'must' }, { name: 'Redis 7', level: 'must' },
      { name: 'QuestDB', level: 'cond', condition: '시계열 데이터(시간 순 대량 쓰기 · 구간 집계 · 보관 기간)가 있으면 사용' },
      { name: '외부 클라우드 관리형 서비스', level: 'ban' },
    ],
  });
});

test('기술 제약은 안정 키로 고친다: 가운데 행을 지워도 다른 행의 입력·수준이 그대로', async ({ page }) => {
  await openRegister(page);
  await page.getByRole('button', { name: '예시 값 채우기' }).click();
  await page.getByRole('button', { name: 'Redis 7 삭제' }).click();
  const rows = page.getByTestId('tech-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1).getByLabel('기술')).toHaveValue('QuestDB');
  await expect(rows.nth(1).getByRole('button', { name: '조건부 선호' })).toHaveAttribute('aria-pressed', 'true');
  await rows.nth(1).getByRole('button', { name: '금지' }).click();
  await expect(rows.nth(1).getByLabel('조건', { exact: true })).toHaveCount(0);
  await expect(rows.nth(0).getByRole('button', { name: '필수' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '+ 기술 제약 추가' }).click();
  await expect(rows).toHaveCount(4);
});

test('UAT-PROJECT-02 주소 형식: 브랜치·폴더 주소는 보내지 않고 이유를 보이며, 서버 400은 칸 아래에 보인다', async ({ page }) => {
  const api = await openRegister(page);
  await page.getByLabel('GitHub 저장소').fill('https://github.com/a/b/tree/main');
  await page.getByRole('button', { name: '저장소 접근 확인' }).click();
  await expect(page.getByText('저장소 주소까지만 입력하세요 — 브랜치 · 폴더 · 파일 주소(/tree/…, /blob/…)는 받지 않습니다.')).toBeVisible();
  await expect(page.getByLabel('GitHub 저장소')).toHaveAttribute('aria-invalid', 'true');
  expect(api.requests('POST /api/project/repo-checks')).toHaveLength(0);

  api.on('POST /api/project/repo-checks', (route) => json(route, 400, errorBody('VALIDATION_FAILED', { errors: [{ path: 'url', rule: 'pattern', message: '저장소 주소는 https://github.com/<owner>/<repo> 형식이어야 합니다.' }] })));
  await page.getByLabel('GitHub 저장소').fill('http://gitlab.com/a/b');
  await page.getByRole('button', { name: '저장소 접근 확인' }).click();
  await expect(page.locator('#reg-url-err')).toHaveText('저장소 주소는 https://github.com/<owner>/<repo> 형식이어야 합니다.');
  await expect(page.getByRole('alert')).toContainText('400 VALIDATION_FAILED');
});

for (const c of [
  { name: '권한 없음(missing-repo)', url: 'https://github.com/a/missing-repo', result: { status: 'failed', private: null, commit: null, structure: null, error: '저장소를 찾을 수 없거나 접근 권한이 없습니다 (a/missing-repo) — private 저장소는 토큰의 저장소 범위를 확인하세요.' }, shows: '저장소를 찾을 수 없거나 접근 권한이 없습니다', missing: null },
  { name: 'prototype/uiux/ 없음(repo-noproto)', url: 'https://github.com/a/repo-noproto', result: { status: 'failed', structure: { uiux: false, uiuxFiles: 0, docs: ['prototype/docs/a.md'], src: true, contracts: true, agentwbs: true }, error: 'prototype/uiux/ 에 프로토타입 파일이 없습니다' }, shows: 'prototype/uiux/ 에 프로토타입 파일이 없습니다', missing: '프로토타입 폴더가 없습니다' },
  { name: 'prototype/docs/ md 없음(repo-nodocs)', url: 'https://github.com/a/repo-nodocs', result: { status: 'failed', structure: { uiux: true, uiuxFiles: 4, docs: [], src: true, contracts: true, agentwbs: true }, error: 'prototype/docs/ 에 md 문서가 없습니다' }, shows: 'prototype/docs/ 에 md 문서가 없습니다', missing: 'md 파일이 없습니다' },
]) {
  test(`UAT-PROJECT-02 ${c.name}: 원인과 없는 경로를 보이고 등록하지 않는다`, async ({ page }) => {
    const api = await openRegister(page);
    await page.getByLabel('프로젝트 이름').fill('새 프로젝트');
    await page.getByLabel('GitHub 저장소').fill(c.url);
    repoCheck(api, { url: c.url, ...c.result });
    await page.getByRole('button', { name: '저장소 접근 확인' }).click();
    await expect(page.getByTestId('check-line')).toContainText(`실패 ${c.shows}`);
    if (c.missing) await expect(page.getByRole('table', { name: '필수 구조' })).toContainText(c.missing);
    await page.getByRole('button', { name: '등록 · 초기 분석 시작' }).click();
    await expect(page.getByTestId('reg-err')).toContainText(`저장소 확인에 실패했습니다 — ${c.shows}`);
    expect(api.requests('POST /api/project')).toHaveLength(0);
  });
}

test('새 저장소(new-empty): src/·contracts/·.agentwbs/ 없음은 「첫 커밋에서 생성」으로 보이고 등록할 수 있다', async ({ page }) => {
  const api = await openRegister(page);
  await page.getByLabel('GitHub 저장소').fill('https://github.com/a/new-empty');
  repoCheck(api, { url: 'https://github.com/a/new-empty', structure: { uiux: true, uiuxFiles: 3, docs: ['prototype/docs/README.md'], src: false, contracts: false, agentwbs: false } });
  await page.getByRole('button', { name: '저장소 접근 확인' }).click();
  const table = page.getByRole('table', { name: '필수 구조' });
  await expect(table).toContainText('첫 커밋에서 생성합니다');
  await expect(table).toContainText('계약 설계 Task가 생성합니다');
  await expect(table).toContainText('첫 커밋에서 생성합니다 (pipeline.yaml)');
  await expect(page.getByTestId('check-line')).toContainText('접근 확인');
});

test('이름 없음·확인 안 함·권한 부족이면 등록 요청을 보내지 않는다', async ({ page }) => {
  const api = await openRegister(page);
  await page.getByRole('button', { name: '등록 · 초기 분석 시작' }).click();
  await expect(page.getByTestId('reg-err')).toHaveText('프로젝트 이름을 입력하세요.');
  await page.getByLabel('프로젝트 이름').fill('이름');
  await page.getByRole('button', { name: '등록 · 초기 분석 시작' }).click();
  await expect(page.getByTestId('reg-err')).toHaveText('먼저 「저장소 접근 확인」을 실행하세요.');
  // 권한 부족(MM-12): 연결은 있어도 statuses 쓰기 권한이 없으면 정상으로 보이지 않고 등록하지 않는다.
  api.on('GET /api/settings/github', (route) => json(route, 200, { ...GITHUB_OK, scopes: { ...GITHUB_OK.scopes, statuses: 'missing' } }));
  await page.reload();
  await expect(page.getByTestId('gh-line')).toContainText('권한 부족: statuses');
  await page.getByLabel('프로젝트 이름').fill('이름');
  await page.getByLabel('GitHub 저장소').fill('https://github.com/verum-sdn/agent-wbs');
  repoCheck(api, {});
  await page.getByRole('button', { name: '저장소 접근 확인' }).click();
  await expect(page.getByTestId('check-line')).toContainText('접근 확인');
  await page.getByRole('button', { name: '등록 · 초기 분석 시작' }).click();
  await expect(page.getByTestId('reg-err')).toHaveText('필수 GitHub 권한이 없어 등록할 수 없습니다 — statuses');
  expect(api.requests('POST /api/project')).toHaveLength(0);
});

test('주소를 바꾸면 이전 확인 결과를 버린다', async ({ page }) => {
  const api = await openRegister(page);
  await page.getByLabel('GitHub 저장소').fill('https://github.com/verum-sdn/agent-wbs');
  repoCheck(api, {});
  await page.getByRole('button', { name: '저장소 접근 확인' }).click();
  await expect(page.getByTestId('check-line')).toContainText('접근 확인');
  await page.getByLabel('GitHub 저장소').fill('https://github.com/verum-sdn/other');
  await expect(page.getByTestId('check-line')).toHaveCount(0);
  await expect(page.getByRole('table', { name: '필수 구조' })).toHaveCount(0);
});

test('Runner 끊김: 저장소 확인 대신 연결 안내, 결과를 기다리는 동안 「Runner 확인 중…」', async ({ page }) => {
  const api = await openRegister(page);
  api.on('GET /api/runner-state', (route) => json(route, 200, { ...RUNNER, connection: { ...RUNNER.connection, online: false } }));
  await page.reload();
  await page.getByLabel('GitHub 저장소').fill('https://github.com/verum-sdn/agent-wbs');
  await page.getByRole('button', { name: '저장소 접근 확인' }).click();
  await expect(page.getByTestId('reg-err')).toHaveText('Runner가 연결되어 있지 않아 저장소를 확인할 수 없습니다. Runner를 연결하세요.');
  expect(api.requests('POST /api/project/repo-checks')).toHaveLength(0);

  api.on('GET /api/runner-state', (route) => json(route, 200, RUNNER));
  await page.reload();
  await page.getByLabel('GitHub 저장소').fill('https://github.com/verum-sdn/agent-wbs');
  repoCheck(api, { status: 'queued', commit: null, structure: null, private: null });
  await page.getByRole('button', { name: '저장소 접근 확인' }).click();
  await expect(page.getByRole('button', { name: 'Runner 확인 중…' })).toBeDisabled();
  await expect(page.getByTestId('check-line')).toContainText('확인 중');
  api.on('GET /api/project/repo-checks/rc-1', (route) => json(route, 200, REPO_OK));
  await expect(page.getByTestId('check-line')).toContainText('접근 확인', { timeout: 5_000 });
});

test('편집 보호·세션 초안: 입력 중 다른 메뉴로 가면 묻고, 취소하면 입력이 남는다', async ({ page }) => {
  await openRegister(page);
  await page.getByLabel('프로젝트 이름').fill('작성 중');
  await page.getByRole('navigation').getByRole('link', { name: '설정', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '편집 내용 버리기' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page.getByLabel('프로젝트 이름')).toHaveValue('작성 중');
});

test('등록 409 CLEANUP_PENDING: 오류 막대로 이유를 보이고 입력은 그대로', async ({ page }) => {
  const api = await openRegister(page);
  await page.getByRole('button', { name: '예시 값 채우기' }).click();
  repoCheck(api, {});
  await page.getByRole('button', { name: '저장소 접근 확인' }).click();
  await expect(page.getByTestId('check-line')).toContainText('접근 확인');
  api.on('POST /api/project', (route) => json(route, 409, errorBody('CLEANUP_PENDING', { message: '이전 초기화의 Runner 정리가 끝나지 않았습니다.', fix: 'Runner를 연결해 정리를 마친 뒤 등록하세요.' })));
  await page.getByRole('button', { name: '등록 · 초기 분석 시작' }).click();
  const bar = page.getByRole('alert');
  await expect(bar).toContainText('등록하지 못했습니다');
  await expect(bar).toContainText('409 CLEANUP_PENDING');
  await expect(bar.getByRole('button', { name: '다시 시도' })).toHaveCount(0);
  await expect(page.getByLabel('프로젝트 이름')).toHaveValue('Verum-SDN Agent WBS — Self Development');
});
