/**
 * D-28 화면 폭(M3 공통 완료 조건) — WBS 화면.
 * - 1280·1920: 표·Gantt·레일+상세·Wizard 모두 페이지 가로 스크롤 없음, 표(목록 영역 약 1,000px)도 가로 스크롤 없음(G§4.3).
 * - 1280 미만: 페이지는 넘치지 않고 표 상자 안에서만 가로 스크롤해 마지막 열까지 읽는다(UAT-RESP-01-UI의 WBS 부분).
 */
import { expect, test, type Page } from '@playwright/test';
import { wbsApi } from './support/wbs-api.ts';

async function overflow(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const offenders = [...document.querySelectorAll('.app, .hdr, .nav, .main, .page, .page-h, .toolbar, .split, .list, .detail, .wrail, .modal')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.className);
    return { page: root.scrollWidth > root.clientWidth, offenders };
  });
}
const tableBox = (page: Page) => page.getByRole('table', { name: 'WBS Task 목록' });
const hScroll = (page: Page, name: string) => page.getByRole('table', { name }).evaluate((el) => el.scrollWidth > el.clientWidth);

for (const width of [1280, 1920]) {
  test(`${String(width)}px: 표·Gantt·레일+상세·Wizard 모두 가로 스크롤 없음`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await wbsApi(page);
    await page.goto('/wbs');
    await expect(tableBox(page)).toBeVisible();
    expect(await overflow(page)).toEqual({ page: false, offenders: [] });
    expect(await hScroll(page, 'WBS Task 목록')).toBe(false);
    // 목록 영역 폭: 1280에서 약 1,000px
    if (width === 1280) expect(Math.round((await tableBox(page).boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(1000);

    await page.getByRole('button', { name: '일정 (Gantt)' }).click();
    await expect(page.getByRole('table', { name: 'WBS 일정 (Gantt)' })).toBeVisible();
    expect(await overflow(page)).toEqual({ page: false, offenders: [] });
    expect(await hScroll(page, 'WBS 일정 (Gantt)')).toBe(false);

    await page.getByRole('button', { name: '표', exact: true }).click();
    await tableBox(page).getByRole('button', { name: 'Drizzle Schema 설계' }).click();
    await expect(page.getByRole('region', { name: 'Task 상세' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(await overflow(page)).toEqual({ page: false, offenders: [] });

    await page.locator('.page-h').getByRole('button', { name: 'Task 생성' }).click();
    await expect(page.getByRole('dialog', { name: 'Task 생성' })).toBeVisible();
    expect(await overflow(page)).toEqual({ page: false, offenders: [] });
  });
}

for (const width of [1100, 1024, 768]) {
  test(`${String(width)}px: 페이지는 넘치지 않고 표 상자 안에서만 가로 스크롤해 마지막 열을 읽는다`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await wbsApi(page);
    await page.goto('/wbs');
    const box = tableBox(page);
    await expect(box).toBeVisible();
    const page0 = await overflow(page);
    expect(page0.page).toBe(false);
    // 표 상자(.tbl)만 가로로 넘친다(그 밖의 틀은 넘치지 않음).
    expect(page0.offenders.filter((c) => !c.includes('tbl'))).toEqual([]);
    expect(await box.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await box.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
    await box.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(box.locator('.thead .th').last()).toBeInViewport();
    await expect(box.locator('.thead .th').last()).toHaveText('예상 실행');
  });
}
