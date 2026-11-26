/**
 * MOD-05 프로젝트 초기화 — 시나리오 19, UAT-RESET-01·02, UAT-RESET-UI.
 * 실제 GitHub 정리 성공은 이 시험으로 인정하지 않는다(UAT-RESET-UI c). 화면은 서버가 준 정리 상태만 보인다.
 */
import { expect, test, type Page } from '@playwright/test';
import { errorBody, fakeApi, json, NO_PROJECT, RUNNER, type FakeApi } from './support/fake-api.ts';
import { activeProject, GITHUB_OK, NAME, PREVIEW, T0 } from './support/project-fixtures.ts';

const OFFLINE = { ...RUNNER, connection: { ...RUNNER.connection, online: false } };
async function openReset(page: Page, online = true): Promise<FakeApi> {
  const api = await fakeApi(page, { project: activeProject() });
  api.on('GET /api/settings/github', (route) => json(route, 200, GITHUB_OK));
  api.on('GET /api/alerts', (route) => json(route, 200, { items: [] }));
  api.on('GET /api/project/reset-preview', (route) => json(route, 200, PREVIEW));
  api.on('GET /api/system/resets', (route) => json(route, 200, { items: [] }));
  if (!online) api.on('GET /api/runner-state', (route) => json(route, 200, OFFLINE));
  await page.goto('/project');
  await page.getByRole('button', { name: '프로젝트 초기화…' }).click();
  await expect(page.getByRole('dialog', { name: `프로젝트 초기화 — 「${NAME}」` })).toBeVisible();
  return api;
}

test('UAT-RESET-01: 삭제 건수·Runner 정리·제외 경로·설정 유지를 보이고, 이름이 다르면 실행할 수 없다', async ({ page }) => {
  await openReset(page);
  const dialog = page.getByRole('dialog');
  const counts = dialog.getByTestId('reset-counts');
  await expect(counts).toContainText('Task');
  await expect(counts).toContainText('Evidence 파일');
  await expect(counts).toContainText('입력 자료 버전');
  const runner = dialog.getByTestId('reset-runner');
  await expect(runner).toContainText('실행 중 Agent 세션 1개 종료 (하위 Agent 2개 포함)');
  await expect(runner).toContainText('Agent 브랜치 2개 삭제 (agent/TASK-0001, agent/TASK-0002)');
  await expect(runner).toContainText('기준 커밋 2dec2a4 상태로');
  await expect(runner).toContainText('강제 push는 하지 않고');
  await expect(dialog).toContainText('삭제하지 않음: 입력 자료(prototype/ (uiux · docs) — GitHub에 그대로)');
  await expect(dialog).not.toContainText('zip · 설계 문서');
  await expect(dialog.getByRole('button', { name: '함께 삭제 (기본)' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: '설정 유지' }).click();
  await expect(dialog).toContainText('유지: 동시 실행 상한');

  const run = dialog.getByRole('button', { name: '모두 삭제하고 초기화' });
  await expect(run).toBeDisabled();
  await dialog.getByLabel('확인 입력').fill('다른 이름');
  await expect(dialog.getByText('프로젝트 이름을 정확히 입력해야 초기화됩니다.')).toBeVisible();
  await expect(run).toBeDisabled();
  await dialog.getByLabel('확인 입력').fill(NAME);
  await expect(run).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('UAT-RESET-02: 내보내기는 zip 내려받기 주소이고(비밀값·수신자 제외 안내), 받지 않아도 초기화할 수 있다', async ({ page }) => {
  const api = await openReset(page);
  const dialog = page.getByRole('dialog');
  const link = dialog.getByRole('link', { name: '데이터 내보내기 (선택)' });
  await expect(link).toHaveAttribute('href', '/api/project/export');
  await expect(link).toHaveAttribute('download', '');
  await expect(dialog).toContainText('zip 파일(데이터 JSON · 보고서 PDF · Evidence)로 받습니다. 비밀값과 메일 받는 사람은 들어가지 않습니다.');
  api.on('POST /api/project/reset', (route) => {
    api.on('GET /api/project', (r) => json(r, 200, { ...NO_PROJECT, epoch: 2 }));
    return json(route, 200, { epoch: 2 });
  });
  await dialog.getByLabel('확인 입력').fill(NAME);
  await dialog.getByRole('button', { name: '모두 삭제하고 초기화' }).click();
  await expect(page.getByRole('heading', { name: '프로젝트 등록', level: 1 })).toBeVisible();
  expect(api.requests('POST /api/project/reset')[0]?.postDataJSON()).toEqual({ confirmName: NAME, keepSettings: false, epoch: 1 });
  expect(api.requests('GET /api/project/export')).toHaveLength(0);
});

test('시나리오 19 · UAT-RESET-UI a: Runner 끊김에서 초기화 → 등록 화면·정리 대기, 저장소 확인 불가 → 연결 뒤 「정리 완료」', async ({ page }) => {
  const api = await openReset(page, false);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Runner가 연결되어 있지 않습니다. Agent WBS 데이터는 바로 삭제되고, Runner 정리는 다시 연결될 때 실행됩니다.');
  const pendingReset = { epoch: 2, at: T0, actor: '팀장', deletedTaskCount: 3, keepSettings: false, runnerCleanupStatus: 'pending', finishedAt: null };
  api.on('POST /api/project/reset', (route) => {
    api.on('GET /api/project', (r) => json(r, 200, { ...NO_PROJECT, epoch: 2, cleanup: 'pending' }));
    api.on('GET /api/system/resets', (r) => json(r, 200, { items: [pendingReset] }));
    return json(route, 200, { epoch: 2 });
  });
  await dialog.getByLabel('확인 입력').fill(NAME);
  await dialog.getByRole('button', { name: '모두 삭제하고 초기화' }).click();
  await expect(page.getByText('Runner가 연결되어 있지 않아 Runner 정리는 다시 연결될 때 실행됩니다.', { exact: false })).toBeVisible();
  await expect(page.getByTestId('cleanup-banner')).toContainText('Runner 정리 대기 — 초기화 번호 2.');
  await expect(page.getByTestId('reset-row')).toContainText('초기화 번호 1 → 2 · Task 3건 삭제 · 설정 삭제');
  await expect(page.getByTestId('reset-row')).toContainText('Runner 정리 대기 — 다시 연결되면 실행');

  // 정리 전에는 저장소 확인(=새 분석 준비)을 막는다.
  await page.getByLabel('GitHub 저장소').fill('https://github.com/verum-sdn/agent-wbs');
  await page.getByRole('button', { name: '저장소 접근 확인' }).click();
  await expect(page.getByTestId('reg-err')).toHaveText('이전 초기화의 Runner 정리가 끝나야 저장소를 확인할 수 있습니다 — Runner를 연결하세요.');
  expect(api.requests('POST /api/project/repo-checks')).toHaveLength(0);

  // Runner가 다시 연결돼 정리 결과를 보고하면(서버 상태) 배너가 사라지고 기록에 「정리 완료」.
  api.on('GET /api/runner-state', (r) => json(r, 200, RUNNER));
  api.on('GET /api/project', (r) => json(r, 200, { ...NO_PROJECT, epoch: 2 }));
  api.on('GET /api/system/resets', (r) => json(r, 200, { items: [{ ...pendingReset, runnerCleanupStatus: 'done', finishedAt: '2026-11-05T11:30:00.000Z' }] }));
  api.on('GET /api/changes', (r) => json(r, 200, { events: [], next: 1, reset: true }));
  await expect(page.getByTestId('cleanup-banner')).toHaveCount(0, { timeout: 8_000 });
  await expect(page.getByTestId('reset-row')).toContainText('Runner 정리 완료 (2026-11-05 20:30)');
});

test('UAT-RESET-UI b: 정리 전 등록은 서버가 CLEANUP_PENDING으로 막고, 낡은 초기화 번호는 EPOCH_MISMATCH를 보인다', async ({ page }) => {
  const api = await openReset(page);
  api.on('POST /api/project/reset', (route) => json(route, 409, errorBody('EPOCH_MISMATCH', { message: '초기화 번호가 바뀌었습니다. 화면을 다시 읽으세요.' })));
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('확인 입력').fill(NAME);
  await dialog.getByRole('button', { name: '모두 삭제하고 초기화' }).click();
  const bar = page.getByRole('alert');
  await expect(bar).toContainText('초기화하지 못했습니다');
  await expect(bar).toContainText('409 EPOCH_MISMATCH');
  await expect(dialog.getByTestId('reset-fail')).toContainText('초기화 번호가 바뀌었습니다.');
  await expect(dialog.getByTestId('reset-fail').getByRole('button', { name: '다시 시도' })).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

test('초기화 500: 모달 안에 원인과 「다시 시도」(같은 키), 창은 열려 있고 입력이 남는다', async ({ page }) => {
  const api = await openReset(page);
  api.on('POST /api/project/reset', (route) => json(route, 500, errorBody('INTERNAL')));
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('확인 입력').fill(NAME);
  await dialog.getByRole('button', { name: '모두 삭제하고 초기화' }).click();
  await expect(page.getByRole('alert')).toContainText('500 INTERNAL');
  const fail = dialog.getByTestId('reset-fail');
  await expect(fail).toContainText('초기화하지 못했습니다 — 서버 오류 500 INTERNAL');
  await expect(dialog.getByLabel('확인 입력')).toHaveValue(NAME);
  api.on('POST /api/project/reset', (route) => {
    api.on('GET /api/project', (r) => json(r, 200, { ...NO_PROJECT, epoch: 2 }));
    return json(route, 200, { epoch: 2 });
  });
  await fail.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByRole('heading', { name: '프로젝트 등록', level: 1 })).toBeVisible();
  const [a, b] = api.requests('POST /api/project/reset');
  expect(a?.headers()['idempotency-key']).toBe(b?.headers()['idempotency-key']);
});
