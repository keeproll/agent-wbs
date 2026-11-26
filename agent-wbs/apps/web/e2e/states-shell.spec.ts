/** UAT-SHELL-05(404)와 메뉴 잠금(공통). */
import { expect, test } from '@playwright/test';
import { fakeApi, NO_PROJECT } from './support/fake-api.ts';

const nav = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: '주 메뉴' });

test('UAT-SHELL-05 모르는 주소는 404 화면이고 정상 12개 메뉴에 가짜 메뉴를 더하지 않는다', async ({ page }) => {
  await fakeApi(page);
  for (const path of ['/nope', '/phase-c', '/dashboard/extra', '/settings/report/x']) {
    const topLevel = path.split('/').length === 2;
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('페이지를 찾을 수 없습니다');
    await expect(page.getByText('(404)')).toBeVisible();
    await expect(page.getByText(/제작 예정/)).toHaveCount(0);
    await expect(nav(page).getByRole('link')).toHaveCount(12);
    // 메뉴 밖 주소는 어떤 메뉴도 선택 표시하지 않는다(메뉴 아래 주소는 그 메뉴가 선택된 채 404).
    if (topLevel) await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(0);
  }
  // 정상 메뉴 하위 주소는 404가 아니다.
  await page.goto('/wbs/TASK-0007');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('WBS');
});

test('등록 전 잠금: 프로젝트·설정만 열리고 다른 메뉴는 이유를 안내한다', async ({ page }) => {
  await fakeApi(page, { project: NO_PROJECT });
  await page.goto('/project');
  await expect(page.locator('.proj-n')).toHaveText('등록된 프로젝트 없음');
  const wbs = nav(page).getByRole('link', { name: 'WBS', exact: true });
  await expect(wbs).toHaveAttribute('aria-disabled', 'true');
  await expect(wbs).toHaveClass(/off/);
  await expect(nav(page).getByRole('link', { name: '설정', exact: true })).not.toHaveAttribute('aria-disabled');
  // 사람은 잠긴 메뉴도 누를 수 있다. Playwright는 aria-disabled 링크를 기다리므로 force로 누른다.
  await wbs.click({ force: true });
  await expect(page).toHaveURL('/project');
  await expect(page.getByRole('status').filter({ hasText: '먼저 프로젝트를 등록하세요.' })).toBeVisible();

  await page.goto('/wbs');
  await expect(page.getByRole('heading', { level: 1, name: 'WBS' })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('WBS 메뉴는 아직 사용할 수 없습니다');
  await page.getByRole('link', { name: '프로젝트로 이동' }).click();
  await expect(page).toHaveURL('/project');
});

test('초기 분석 중 잠금 문구', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/project', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'boot', id: 'p1', name: '새 프로젝트', epoch: 1, cleanup: 'none' }) }));
  await page.goto('/verify');
  await expect(page.getByRole('note')).toContainText('초기 WBS를 승인하면 검증 메뉴를 사용할 수 있습니다.');
});
