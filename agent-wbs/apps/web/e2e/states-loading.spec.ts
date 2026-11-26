/** 로딩 5종·SYS-01(UAT-STATE-04·05) — 0.2초 생략·0.3초 유지·10초 실패 전환·재시도 복구·움직임 줄이기. */
import { expect, test, type Page } from '@playwright/test';
import { ACTIVE_PROJECT, delay, errorBody, fakeApi, hold, json } from './support/fake-api.ts';

const TASK = { taskKey: 'TASK-0001', title: '원래 제목', updatedAt: '2026-11-26T01:00:00.000000Z' };

/** 화면에 한 번이라도 나타난 요소 기록 */
async function watchAppear(page: Page, selector: string) {
  await page.addInitScript((sel) => {
    const w = window as unknown as { __seen: number };
    w.__seen = 0;
    new MutationObserver(() => { if (document.querySelector(sel)) w.__seen += 1; }).observe(document, { subtree: true, childList: true });
  }, selector);
  return () => page.evaluate(() => (window as unknown as { __seen: number }).__seen);
}

test('UAT-STATE-04 응답 없음 10초 → 메뉴 제목·원인·마지막 성공 시각·다시 시도, 재시도 성공 시 복구', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-26T10:00:00+09:00') });
  const api = await fakeApi(page);
  const silent = hold((route) => json(route, 200, ACTIVE_PROJECT));
  api.on('GET /api/project', silent.handler);
  await page.goto('/dashboard');
  await expect(page.getByRole('status', { name: '대시보드 불러오는 중' })).toBeVisible();
  await page.clock.fastForward(9_000);
  await expect(page.getByRole('status', { name: '대시보드 불러오는 중' })).toBeVisible();
  await page.clock.fastForward(1_100);
  await expect(page.getByRole('heading', { level: 1, name: '대시보드' })).toBeVisible();
  const card = page.getByRole('region', { name: '대시보드 화면을 불러오지 못했습니다' });
  await expect(card).toContainText('Agent WBS 서버가 응답하지 않습니다 (응답 없음 · 10초 초과)');
  await expect(card).toContainText('마지막으로 불러온 시각 2026-11-26 10:00');

  api.on('GET /api/project', (route) => json(route, 200, ACTIVE_PROJECT));
  await card.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByText('이 화면은 아직 구현되지 않았습니다.')).toBeVisible();
  await expect(card).toHaveCount(0);
});

test('UAT-STATE-04 서버 503이면 503 원인을 보이고, 6초 고정 타이머로 실패 처리하지 않는다', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-26T10:00:00+09:00') });
  const api = await fakeApi(page);
  const slow = hold((route) => json(route, 503, errorBody('UNAVAILABLE', { message: 'DB에 연결할 수 없습니다.', fix: 'PostgreSQL 상태를 확인하세요.' })));
  api.on('GET /api/project', slow.handler);
  await page.goto('/wbs');
  await page.clock.fastForward(7_000);
  // 원본은 6초 뒤 실패로 바꾸지만(MM-17) 제품은 실제 응답/10초 기준이다.
  await expect(page.getByRole('status', { name: 'WBS 불러오는 중' })).toBeVisible();
  slow.release();
  const card = page.getByRole('region', { name: 'WBS 화면을 불러오지 못했습니다' });
  await expect(card).toContainText('(503 UNAVAILABLE)');
  await expect(card.getByRole('button', { name: '다시 시도' })).toBeVisible();
});

test('0.2초 안에 온 응답은 skeleton을 보이지 않고, 늦은 응답은 skeleton 뒤 실제 화면으로 바뀐다', async ({ page }) => {
  const seen = await watchAppear(page, '.skp');
  const api = await fakeApi(page);
  api.on('GET /api/project', delay(50, (route) => json(route, 200, ACTIVE_PROJECT)));
  await page.goto('/history');
  await expect(page.getByText('이 화면은 아직 구현되지 않았습니다.')).toBeVisible();
  expect(await seen()).toBe(0);

});

test('늦은 첫 응답: 메뉴 배치 모양 skeleton → 실제 화면', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/project', delay(900, (route) => json(route, 200, ACTIVE_PROJECT)));
  await page.goto('/dashboard');
  const skeleton = page.getByRole('status', { name: '대시보드 불러오는 중' });
  await expect(skeleton).toBeVisible();
  // 대시보드 배치: 지표 카드 4 + 패널 6 + 큰 카드 1
  await expect(skeleton.locator('.sk-c.card')).toHaveCount(11);
  await expect(page.getByText('이 화면은 아직 구현되지 않았습니다.')).toBeVisible();
  await expect(skeleton).toHaveCount(0);
});

test('이미 본 화면으로 다시 오면 이전 화면을 유지하고 상단 진행 막대를 보인다', async ({ page }) => {
  const api = await fakeApi(page);
  await page.goto('/dashboard');
  await expect(page.getByText('이 화면은 아직 구현되지 않았습니다.')).toBeVisible();
  const slow = hold((route) => json(route, 200, ACTIVE_PROJECT));
  api.on('GET /api/project', slow.handler);
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '이력', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: '불러오는 중' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '이력' })).toBeVisible();
  await expect(page.locator('.skp')).toHaveCount(0);
  slow.release();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
});

test('UAT-STATE-05 저장 연타 → 요청 1번·처리 중 문구·비활성, 완료 후 실제 결과와 status 안내', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, TASK));
  api.on('PATCH /api/tasks/TASK-0001', delay(800, (route, request) => {
    const body = request.postDataJSON() as { title: string };
    return json(route, 200, { task: { ...TASK, title: body.title, updatedAt: '2026-11-26T01:05:00.000000Z' }, changes: [] });
  }));
  await page.goto('/_states');
  await page.getByRole('button', { name: '편집' }).click();
  await page.getByLabel('제목').fill('새 제목');
  const save = page.getByRole('button', { name: '저장', exact: true });
  await save.click();
  await page.getByRole('button', { name: '저장 중…' }).click({ force: true }).catch(() => undefined);
  await page.getByRole('button', { name: '저장 중…' }).dblclick({ force: true }).catch(() => undefined);
  await expect(page.getByRole('button', { name: '저장 중…' })).toBeDisabled();
  await expect(page.getByTestId('title')).toHaveText('새 제목');
  expect(api.requests('PATCH /api/tasks/TASK-0001')).toHaveLength(1);
  expect(api.requests('PATCH /api/tasks/TASK-0001')[0]?.headers()['x-csrf-token']).toBe('password.csrf-test');
  await expect(page.getByRole('status').filter({ hasText: 'TASK-0001 제목을 저장했습니다.' })).toBeVisible();
});

test('UAT-STATE-05 움직임 줄이기: skeleton·상단 막대·스피너 회전이 멈춘다', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fakeApi(page);
  await page.goto('/_states');
  const animations = await page.evaluate(() => {
    const probe = (cls: string, parent?: string) => {
      const host = document.createElement('div');
      host.innerHTML = parent ? `<div class="${parent}"><span></span></div>` : `<span class="${cls}"></span>`;
      document.body.append(host);
      const el = parent ? host.querySelector(`.${parent} span`) : host.firstElementChild;
      const name = el ? getComputedStyle(el).animationName : 'missing';
      host.remove();
      return name;
    };
    return { sk: probe('sk'), bspin: probe('bspin'), topbar: probe('', 'topbar') };
  });
  expect(animations).toEqual({ sk: 'none', bspin: 'none', topbar: 'none' });
});

test('일정 재계산 중에는 본문을 흐리게 하고 클릭을 막는다', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, TASK));
  const slow = hold((route) => json(route, 202, { jobId: 'j1' }));
  api.on('POST /api/replans/run', slow.handler);
  await page.goto('/_states');
  await page.getByRole('button', { name: '일정 다시 계산' }).click();
  await expect(page.getByRole('status').filter({ hasText: '일정 다시 계산 중 — 잠시 후 갱신됩니다' })).toBeVisible();
  await expect(page.locator('main.main.dim')).toBeVisible();
  expect(await page.locator('.main.dim .page').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  slow.release();
  await expect(page.locator('main.main.dim')).toHaveCount(0);
});
