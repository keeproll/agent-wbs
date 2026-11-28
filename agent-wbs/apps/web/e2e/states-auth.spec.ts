/** UAT-AUTH-01·02·03(UI-AUTH) — 가짜 API로 화면 흐름을 확인한다. 실제 API 연결 시험은 states-auth-api.spec.ts. */
import { expect, test } from '@playwright/test';
import { errorBody, fakeApi, json, SESSION } from './support/fake-api.ts';
import { LOGIN_LINK_COMMAND } from '../src/features/auth/login-command.ts';

test('UAT-AUTH-01 보호 화면 → 로그인 화면 1개(비밀번호·새 링크 안내) → 성공 후 요청 화면으로 이동', async ({ page }) => {
  const api = await fakeApi(page, { session: false });
  let loggedIn = false;
  api.on('GET /api/session', (route) => (loggedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  api.on('POST /api/auth/session', (route) => { loggedIn = true; return route.fulfill({ status: 204 }); });

  await page.goto('/wbs/TASK-0007?tab=spec');
  await expect(page).toHaveURL('/login?next=%2Fwbs%2FTASK-0007%3Ftab%3Dspec');
  await expect(page.getByRole('heading', { level: 1, name: '로그인' })).toBeVisible();
  await expect(page.getByLabel('비밀번호')).toBeVisible();
  await expect(page.getByRole('heading', { name: '이 PC에서 로그인(1회용 링크)' })).toBeVisible();
  await expect(page.getByText(LOGIN_LINK_COMMAND)).toBeVisible();
  // 보호 데이터 요청을 하지 않는다.
  expect(api.calls().filter((c) => !c.startsWith('GET /api/session'))).toEqual([]);

  await page.getByLabel('비밀번호').fill('correct horse');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0007?tab=spec');
  await expect(page.getByRole('heading', { level: 1, name: 'WBS' })).toBeVisible();
  const login = api.requests('POST /api/auth/session')[0];
  expect(login?.postDataJSON()).toEqual({ method: 'password', password: 'correct horse' });
});

test('UAT-AUTH-02 1회용 링크: 주소에서 토큰을 즉시 지우고 최초만 성공, 재사용은 LOGIN_FAILED 안내', async ({ page }) => {
  const api = await fakeApi(page, { session: false });
  const used = new Set<string>();
  let loggedIn = false;
  api.on('GET /api/session', (route) => (loggedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  api.on('POST /api/auth/session', (route, request) => {
    const { token } = request.postDataJSON() as { token: string };
    if (used.has(token)) return json(route, 401, errorBody('LOGIN_FAILED'));
    used.add(token);
    loggedIn = true;
    return route.fulfill({ status: 204 });
  });

  await page.goto('/#login-token=tok-123');
  await expect(page).toHaveURL('/dashboard');
  expect(page.url()).not.toContain('tok-123');
  await expect(page.getByRole('heading', { level: 1, name: '대시보드' })).toBeVisible();
  expect(api.requests('POST /api/auth/session').map((r) => r.postDataJSON() as unknown)).toEqual([{ method: 'link', token: 'tok-123' }]);
  expect(await page.evaluate(() => history.length)).toBeGreaterThan(0);

  // 같은 링크 재사용(새 창·세션 만료 상황)
  loggedIn = false;
  await page.context().clearCookies();
  await page.goto('/#login-token=tok-123');
  await expect(page).toHaveURL(/\/login\?link=failed/);
  expect(page.url()).not.toContain('tok-123');
  await expect(page.getByRole('alert')).toContainText('1회용 링크로 로그인하지 못했습니다');
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toHaveCount(0);
});

test('UAT-AUTH-03 틀린 비밀번호 반복: 실패 안내, 429는 Retry-After 동안 막고 보호 데이터는 보이지 않는다', async ({ page }) => {
  // 실제 PC의 벽시계 역행 대신 시험용 시계로 Retry-After 경과를 재현한다.
  await page.clock.install({ time: new Date('2026-11-28T00:00:00.000Z') });
  const api = await fakeApi(page, { session: false });
  let tries = 0;
  api.on('POST /api/auth/session', (route) => {
    tries += 1;
    return tries <= 2 ? json(route, 401, errorBody('LOGIN_FAILED')) : json(route, 429, errorBody('RATE_LIMITED'), { 'Retry-After': '3' });
  });
  await page.goto('/dashboard');
  const password = page.getByLabel('비밀번호');
  const submit = page.getByRole('button', { name: /로그인|다시 시도/ });
  for (let i = 0; i < 2; i++) {
    await password.fill(`wrong-${String(i)}`);
    await submit.click();
    await expect(page.getByRole('alert')).toContainText('로그인하지 못했습니다. 비밀번호를 확인한 뒤 다시 입력하세요.');
    await expect(page.getByRole('alert')).toContainText('401 LOGIN_FAILED');
  }
  await password.fill('wrong-3');
  await submit.click();
  await expect(page.getByRole('alert')).toContainText('로그인 시도가 너무 많습니다');
  await expect(page.getByRole('alert')).toContainText('429 RATE_LIMITED');
  await expect(page.getByRole('button', { name: /초 뒤 다시 시도/ })).toBeDisabled();
  await page.clock.runFor(3_250);
  await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeEnabled({ timeout: 6_000 });
  expect(tries).toBe(3);
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toHaveCount(0);
  expect(api.calls().filter((c) => c.startsWith('GET /api/project') || c.startsWith('GET /api/runner'))).toEqual([]);
});
