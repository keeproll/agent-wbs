import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fakeApi } from './support/fake-api.ts';

// M3-01부터 모든 화면은 로그인 뒤에 열린다. 가짜 API가 로그인된 세션을 준다.
test.beforeEach(async ({ page }) => { await fakeApi(page); });

const MENU = [
  ['대시보드', '/dashboard'],
  ['프로젝트', '/project'],
  ['WBS', '/wbs'],
  ['설계', '/design'],
  ['Planning', '/planning'],
  ['작업 실행', '/exec'],
  ['검증', '/verify'],
  ['빌드 · 통합', '/ci'],
  ['변경 제안', '/change'],
  ['이력', '/history'],
  ['보고서', '/report'],
  ['설정', '/settings'],
] as const;

const nav = (page: Page) => page.getByRole('navigation', { name: '주 메뉴' });

async function expectNoHorizontalScroll(page: Page) {
  const overflowing = await page.evaluate(() =>
    [document.documentElement, ...document.querySelectorAll('.app, .nav, .main')]
      .filter((el) => el.scrollWidth > el.clientWidth)
      .map((el) => el.className || el.tagName),
  );
  expect(overflowing).toEqual([]);
}

for (const width of [1280, 1920]) {
  test.describe(`${String(width)}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test('Header 64px, 메뉴 180px/56px', async ({ page }) => {
      await page.goto('/');
      const header = await page.getByRole('banner').boundingBox();
      expect(header).toMatchObject({ x: 0, y: 0, width, height: 64 });
      expect((await nav(page).boundingBox())?.width).toBe(180);

      const toggle = page.getByRole('button', { name: '메뉴 접기/펼치기' });
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect((await nav(page).boundingBox())?.width).toBe(56);
      // 접어도 이름으로 찾을 수 있다.
      await expect(nav(page).getByRole('link', { name: '보고서', exact: true })).toBeVisible();
    });

    test('메뉴 12개 이동, 가로 스크롤 없음', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL('/dashboard');
      await expect(nav(page).getByRole('link')).toHaveText(MENU.map(([label]) => label));
      for (const collapsed of [false, true]) {
        if (collapsed) await page.getByRole('button', { name: '메뉴 접기/펼치기' }).click();
        for (const [label, path] of MENU) {
          const link = nav(page).getByRole('link', { name: label, exact: true });
          await link.click();
          await expect(page).toHaveURL(path);
          await expect(page.getByRole('heading', { level: 1, name: label, exact: true })).toBeVisible();
          await expect(page).toHaveTitle(`${label} — Agent WBS`);
          await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
          await expect(link).toHaveAttribute('aria-current', 'page');
          await expectNoHorizontalScroll(page);
        }
      }
    });
  });
}

test('주소로 바로 열고 뒤로 갈 수 있다', async ({ page }) => {
  await page.goto('/wbs/TASK-0007');
  await expect(nav(page).locator('[aria-current="page"]')).toHaveText('WBS');
  await page.goto('/settings/report');
  await expect(nav(page).locator('[aria-current="page"]')).toHaveText('설정');
  await page.goBack();
  await expect(page).toHaveURL('/wbs/TASK-0007');
  await page.goto('/nope');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('페이지를 찾을 수 없습니다');
});

test('모든 글자가 번들에 포함된 Pretendard GOV를 쓴다', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:')) external.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const result = await page.evaluate(async () => {
    await document.fonts.ready;
    const families = ['body', 'h1', 'button', 'a'].map((selector) => {
      const el = document.querySelector(selector);
      return el ? getComputedStyle(el).fontFamily.split(',')[0] : null;
    });
    for (const tag of ['code', 'input', 'textarea', 'pre']) {
      const el = document.body.appendChild(document.createElement(tag));
      families.push(getComputedStyle(el).fontFamily.split(',')[0] ?? null);
      el.remove();
    }
    return {
      families,
      loaded: [...document.fonts].map((font) => [font.family.replaceAll('"', ''), font.status]),
      numeric: getComputedStyle(document.body).fontVariantNumeric,
    };
  });
  expect(new Set(result.families)).toEqual(new Set(['"Pretendard GOV Variable"']));
  expect(result.loaded).toEqual([['Pretendard GOV Variable', 'loaded']]);
  expect(result.numeric).toBe('tabular-nums');
  expect(external).toEqual([]);
});

test('키보드로 본문에 건너뛰고 메뉴를 연다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: '본문으로 건너뛰기' });
  await expect(skip).toBeFocused();
  expect((await skip.boundingBox())?.height).toBeGreaterThan(20);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();

  await nav(page).getByRole('link', { name: 'WBS', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/wbs');
});

test('자동 접근성 검사 위반 0건', async ({ page }) => {
  for (const [label, path] of MENU) {
    await page.goto(path);
    // 로그인 확인·API 응답 뒤 화면이 그려진 다음 검사한다(독립 리뷰 eebac50 #7).
    await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
  await page.getByRole('button', { name: '메뉴 접기/펼치기' }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('움직임 줄이기 설정을 따른다', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const duration = await page
    .getByRole('button', { name: '메뉴 접기/펼치기' })
    .evaluate((el) => {
      el.style.transition = 'background 1s';
      return getComputedStyle(el).transitionDuration;
    });
  expect(Number.parseFloat(duration)).toBeLessThan(0.001);
});

// 원본 L644: 760px 이하에서 펼친 메뉴는 60px(글자 숨김), 접으면 56px(L50).
test('760px 이하에서는 메뉴가 60px(접으면 56px)이고 가로 스크롤이 없다', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto('/');
  await expect(nav(page).getByRole('link', { name: 'WBS', exact: true })).toBeVisible();
  expect((await nav(page).boundingBox())?.width).toBe(60);
  await expect(nav(page).locator('.nav-l').first()).toBeHidden();
  await page.getByRole('button', { name: '메뉴 접기/펼치기' }).click();
  expect((await nav(page).boundingBox())?.width).toBe(56);
  await expectNoHorizontalScroll(page);
});

test('로그인·불러오기 실패·공통 부품 견본 화면도 자동 접근성 검사 위반 0건', async ({ page }) => {
  await page.goto('/_states');
  await expect(page.getByRole('heading', { level: 1, name: '공통 컴포넌트 견본' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.route('**/api/project', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto('/wbs');
  await expect(page.getByRole('region', { name: 'WBS 화면을 불러오지 못했습니다' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.route('**/api/session', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1, name: '로그인' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
