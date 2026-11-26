/**
 * D-28(M3 공통 완료 조건) — 프로젝트 화면 4종(등록·초기 분석·진행 중·초기화 창)을 1920·1280·1024·390px에서 연다.
 * 1280·1920: 페이지 가로 스크롤 없음. 1280 미만: 페이지는 넘치지 않고 표(.gtb)만 자기 상자 안에서 가로 스크롤한다.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fakeApi, json, NO_PROJECT } from './support/fake-api.ts';
import { activeProject, bootProject, DECISIONS, GITHUB_OK, PENDING, PREVIEW, REPO_OK, SHA3, steps } from './support/project-fixtures.ts';

async function overflow(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const offenders = [...document.querySelectorAll('.app, .hdr, .main, .page, .card, .modal')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.className);
    // 표 상자가 넘치면 그 상자는 가로 스크롤(overflow-x:auto)이어야 한다.
    const badTables = [...document.querySelectorAll('.gtb')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto').length;
    return { page: root.scrollWidth > root.clientWidth, offenders, badTables };
  });
}

const SCREENS: { name: string; project: unknown; open?: (page: Page) => Promise<void> }[] = [
  { name: '등록(UI-02A) + 구조 표', project: NO_PROJECT, open: async (page) => {
    await page.getByRole('button', { name: '예시 값 채우기' }).click();
    await page.getByRole('button', { name: '저장소 접근 확인' }).click();
    await expect(page.getByRole('table', { name: '필수 구조' })).toBeVisible();
  } },
  { name: '초기 분석·기술 결정(UI-02B·C)', project: bootProject({ steps: steps('tech'), decisions: DECISIONS }) },
  { name: 'WBS 초안(UI-02D)', project: bootProject({ steps: steps('approve'), draft: true }) },
  { name: '진행 중·입력 변경(UI-02·02E)', project: activeProject({ changeCommits: PENDING, inputHead: SHA3 }) },
  { name: '초기화 창(MOD-05)', project: activeProject(), open: async (page) => {
    await page.getByRole('button', { name: '프로젝트 초기화…' }).click();
    await expect(page.getByTestId('reset-counts')).toBeVisible();
  } },
];

for (const width of [1920, 1280, 1024]) {
  for (const s of SCREENS) {
    test(`${String(width)}px ${s.name}: 페이지 가로 스크롤 없음`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const api = await fakeApi(page, { project: s.project as typeof NO_PROJECT });
      api.on('GET /api/settings/github', (route) => json(route, 200, GITHUB_OK));
      api.on('GET /api/system/resets', (route) => json(route, 200, { items: [] }));
      api.on('GET /api/alerts', (route) => json(route, 200, { items: [] }));
      api.on('GET /api/project/reset-preview', (route) => json(route, 200, PREVIEW));
      api.on('POST /api/project/repo-checks', (route) => json(route, 202, { id: 'rc-1' }));
      api.on('GET /api/project/repo-checks/rc-1', (route) => json(route, 200, REPO_OK));
      await page.goto('/project');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await s.open?.(page);
      expect(await overflow(page)).toEqual({ page: false, offenders: [], badTables: 0 });
    });
  }
}

for (const s of SCREENS) {
  test(`접근성 자동 검사 위반 0건: ${s.name}`, async ({ page }) => {
    const api = await fakeApi(page, { project: s.project as typeof NO_PROJECT });
    api.on('GET /api/settings/github', (route) => json(route, 200, GITHUB_OK));
    api.on('GET /api/system/resets', (route) => json(route, 200, { items: [] }));
    api.on('GET /api/alerts', (route) => json(route, 200, { items: [] }));
    api.on('GET /api/project/reset-preview', (route) => json(route, 200, PREVIEW));
    api.on('POST /api/project/repo-checks', (route) => json(route, 202, { id: 'rc-1' }));
    api.on('GET /api/project/repo-checks/rc-1', (route) => json(route, 200, REPO_OK));
    await page.goto('/project');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await s.open?.(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

test.describe('390px 휴대폰', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  test('진행 중 프로젝트의 입력 변경을 열람할 수 있고 페이지가 넘치지 않는다', async ({ page }) => {
    const api = await fakeApi(page, { project: activeProject({ changeCommits: PENDING, inputHead: SHA3 }) });
    api.on('GET /api/settings/github', (route) => json(route, 200, GITHUB_OK));
    api.on('GET /api/alerts', (route) => json(route, 200, { items: [] }));
    await page.goto('/project');
    await expect(page.getByTestId('input-pending')).toBeVisible();
    const o = await overflow(page);
    expect(o.page).toBe(false);
    expect(o.badTables).toBe(0);
  });
});
