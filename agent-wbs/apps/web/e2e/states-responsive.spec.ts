/** D-28 화면 폭: 1280·1920은 페이지 가로 스크롤 없음, 1280 미만은 표 상자만 가로 스크롤, 390px viewport 일치. */
import { expect, test, type Page } from '@playwright/test';
import { fakeApi } from './support/fake-api.ts';
import { MENU } from '../src/shared/layout/menu.ts';

async function pageOverflow(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const offenders = [...document.querySelectorAll('.app, .hdr, .nav, .main, .page, .login')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.className);
    return { page: root.scrollWidth > root.clientWidth, offenders };
  });
}

for (const width of [1280, 1920]) {
  test(`${String(width)}px: 12개 메뉴·견본·404·로그인 화면 모두 페이지 가로 스크롤 없음`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fakeApi(page);
    for (const path of [...MENU.map((m) => `/${m.key}`), '/_states', '/nope']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await pageOverflow(page), path).toEqual({ page: false, offenders: [] });
    }
    const table = page.locator('.tbl-x');
    await page.goto('/_states');
    expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  });
}

for (const width of [1024, 768]) {
  test(`${String(width)}px: 페이지는 넘치지 않고 표 상자 안에서만 가로 스크롤해 마지막 열을 읽는다`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fakeApi(page);
    await page.goto('/_states');
    expect(await pageOverflow(page)).toEqual({ page: false, offenders: [] });
    const box = page.getByRole('region', { name: '견본 표' });
    expect(await box.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await box.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
    const last = box.getByText('예상 실행');
    await box.focus();
    await page.keyboard.press('End');
    await box.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(last).toBeInViewport();
  });
}

test.describe('390px 휴대폰', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  test('viewport meta로 CSS 폭이 기기 폭과 같고 로그인 화면이 넘치지 않는다', async ({ page }) => {
    await fakeApi(page, { session: false });
    await page.goto('/wbs/TASK-0007');
    await expect(page.getByRole('heading', { level: 1, name: '로그인' })).toBeVisible();
    expect(await page.evaluate(() => window.innerWidth)).toBe(390);
    expect(await pageOverflow(page)).toEqual({ page: false, offenders: [] });
  });
});
