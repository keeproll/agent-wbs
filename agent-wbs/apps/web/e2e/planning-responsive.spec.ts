/**
 * M3-05 화면 폭(D-28): 1280·1920 페이지 가로 스크롤 없음, 1024·768 표는 상자 안에서만 가로 스크롤,
 * 390px 휴대폰은 알림 링크로 CP 상세를 잘림 없이 연다(UAT-RESP-01-UI·UAT-RESP-02-UI). `W e2e -- planning`.
 */
import { expect, test, type Page } from '@playwright/test';
import { fillPin } from './support/pin.ts';
import { errorBody, fakeApi, json, SESSION } from './support/fake-api.ts';
import { planningServer } from './support/planning-data.ts';

async function pageOverflow(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const offenders = [...document.querySelectorAll('.app, .hdr, .nav, .main, .page, .two, .mainc, .cp-detail, .card')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto')
      .map((el) => el.className);
    return { page: root.scrollWidth > root.clientWidth, offenders };
  });
}

const PATHS = ['/planning', '/planning?tab=replans', '/change/CP-002', '/change/CP-003', '/change/CP-004'];

for (const width of [1280, 1920]) {
  test(`${String(width)}px: Planning·변경 제안 화면 모두 페이지 가로 스크롤 없음, 표도 넘치지 않음`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await fakeApi(page);
    planningServer(api);
    for (const path of PATHS) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('.gtb, .card').first()).toBeVisible();
      expect(await pageOverflow(page), path).toEqual({ page: false, offenders: [] });
    }
    await page.goto('/change/CP-002');
    const diff = page.getByRole('region', { name: '변경 전 / 후 비교' });
    await expect(diff).toBeVisible();
    expect(await diff.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
  });
}

for (const width of [1024, 768]) {
  test(`${String(width)}px: 페이지는 넘치지 않고 CP 표는 상자 안 가로 스크롤로 마지막 열까지 읽는다`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await fakeApi(page);
    planningServer(api);
    await page.goto('/change/CP-003');
    await expect(page.getByRole('region', { name: '영향 분석' })).toBeVisible();
    expect(await pageOverflow(page)).toEqual({ page: false, offenders: [] });
    const box = page.getByRole('region', { name: '변경 전 / 후 비교' });
    expect(await box.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
    await box.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(box.getByText('취소됨')).toBeInViewport();
  });
}

test.describe('390px 휴대폰', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('UAT-RESP-02-UI: 알림 링크로 CP 상세를 열면(로그인 복귀 포함) 핵심 필드·상태·Diff·근거를 잘림 없이 읽는다', async ({ page }) => {
    const api = await fakeApi(page);
    planningServer(api);
    let signedIn = false;
    api.on('GET /api/session', (route) => (signedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
    api.on('POST /api/auth/session', (route) => { signedIn = true; return route.fulfill({ status: 204 }); });
    await page.goto('/change/CP-004');
    await expect(page).toHaveURL('/login?next=%2Fchange%2FCP-004');
    await fillPin(page, '261128');
    await page.getByRole('button', { name: '로그인' }).click();
    await expect(page).toHaveURL('/change/CP-004');
    expect(await page.evaluate(() => window.innerWidth)).toBe(390);
    const detail = page.locator('.cp-detail');
    await expect(detail.getByRole('heading', { level: 2, name: 'Runner 메시지 처리 분할' })).toBeInViewport();
    await expect(detail.locator('.cps')).toHaveText('보류');
    expect(await pageOverflow(page)).toEqual({ page: false, offenders: [] });
    // 상세가 목록보다 먼저 나온다
    const [d, l] = [await detail.boundingBox(), await page.getByRole('complementary', { name: '변경 제안 목록' }).boundingBox()];
    expect(d && l && d.y < l.y).toBe(true);
    // 핵심 글자가 잘리지 않는다: 각 글 요소의 오른쪽 끝이 화면 안
    const clipped = await page.evaluate(() => [...document.querySelectorAll('.cp-detail .pane-h *, .cp-detail .banner-b, .cp-detail .sec p, .cp-detail .lst li')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).map((el) => el.textContent?.slice(0, 30)));
    expect(clipped).toEqual([]);
    await expect(page.getByRole('region', { name: '보류 사유' })).toContainText('JUDGEMENT_NOT_MET');
    // 표(Diff·판단 결과)는 자체 가로 스크롤로 마지막 열까지
    for (const name of ['변경 전 / 후 비교', '판단 결과']) {
      const box = page.getByRole('region', { name });
      expect(await box.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
      await box.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    }
    await expect(page.getByRole('region', { name: '판단 결과' }).getByText('리팩터링이 기능 변경과 섞임')).toBeVisible();
    await expect(detail.getByRole('link', { name: /출처: Planning/ })).toBeVisible();
  });
});
