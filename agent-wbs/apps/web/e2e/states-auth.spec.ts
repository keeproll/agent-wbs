/** UAT-AUTH-01·02·03(UI-AUTH) — 가짜 API로 화면 흐름을 확인한다. 실제 API 연결 시험은 states-auth-api.spec.ts. */
import { expect, test } from '@playwright/test';
import { fillPin } from './support/pin.ts';
import { errorBody, fakeApi, json, SESSION } from './support/fake-api.ts';
import { LOGIN_LINK_COMMAND } from '../src/features/auth/login-command.ts';

test('UAT-AUTH-01 보호 화면 → 로그인 화면 1개(PIN·새 링크 안내) → 성공 후 요청 화면으로 이동', async ({ page }) => {
  const api = await fakeApi(page, { session: false });
  let loggedIn = false;
  api.on('GET /api/session', (route) => (loggedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  api.on('POST /api/auth/session', (route) => { loggedIn = true; return route.fulfill({ status: 204 }); });

  await page.goto('/wbs/TASK-0007?tab=spec');
  await expect(page).toHaveURL('/login?next=%2Fwbs%2FTASK-0007%3Ftab%3Dspec');
  await expect(page.getByRole('heading', { level: 1, name: '로그인' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'PIN 번호', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '이 PC에서 로그인(1회용 링크)' })).toBeVisible();
  await expect(page.getByText(LOGIN_LINK_COMMAND)).toBeVisible();
  // 보호 데이터 요청을 하지 않는다.
  expect(api.calls().filter((c) => !c.startsWith('GET /api/session'))).toEqual([]);

  await fillPin(page, '261128');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0007?tab=spec');
  await expect(page.getByRole('heading', { level: 1, name: 'WBS' })).toBeVisible();
  const login = api.requests('POST /api/auth/session')[0];
  expect(login?.postDataJSON()).toEqual({ method: 'pin', pin: '261128' });
});

test('PIN 6칸은 모바일 숫자 키패드·자동 이동·백스페이스·붙여넣기를 지원한다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await fakeApi(page, { session: false });
  await page.goto('/login');
  const inputs = page.getByRole('group', { name: 'PIN 번호', exact: true }).getByRole('textbox');
  await expect(inputs).toHaveCount(6);
  await expect(page.getByText('LAN 모드에서는 같은 네트워크 누구나 날짜로 접속 가능합니다.', { exact: false })).toBeVisible();
  for (const input of await inputs.all()) await expect(input).toHaveAttribute('inputmode', 'numeric');
  const submit = page.getByRole('button', { name: '로그인', exact: true });
  await expect(submit).toBeDisabled();
  await inputs.first().focus();
  await page.keyboard.type('26');
  await expect(inputs.nth(2)).toBeFocused();
  await page.keyboard.press('Backspace');
  await expect(inputs.nth(1)).toBeFocused();
  await expect(inputs.nth(1)).toHaveValue('');
  await page.keyboard.type('61128');
  await expect(submit).toBeEnabled();
  await expect(inputs.last()).toBeFocused();
  await page.keyboard.press('Backspace');
  await expect(submit).toBeDisabled();
  await inputs.first().evaluate(input => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text', '261128');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  for (const [index, digit] of [...'261128'].entries()) await expect(inputs.nth(index)).toHaveValue(digit);
  await expect(inputs.last()).toBeFocused();
  await expect(submit).toBeEnabled();
  expect(api.requests('POST /api/auth/session')).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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

test('UAT-AUTH-03 틀린 PIN 반복: 실패 안내, 429는 Retry-After 동안 막고 보호 데이터는 보이지 않는다', async ({ page }) => {
  const api = await fakeApi(page, { session: false });
  let tries = 0;
  api.on('POST /api/auth/session', (route) => {
    tries += 1;
    return tries <= 2 ? json(route, 401, errorBody('LOGIN_FAILED')) : json(route, 429, errorBody('RATE_LIMITED'), { 'Retry-After': '3' });
  });
  await page.goto('/dashboard');

  const submit = page.getByRole('button', { name: /로그인|다시 시도/ });
  for (let i = 0; i < 2; i++) {
    await fillPin(page, '000000');
    await submit.click();
    await expect(page.getByRole('alert')).toContainText('로그인하지 못했습니다. 서버 시간대의 오늘 날짜 PIN을 확인한 뒤 다시 입력하세요.');
    await expect(page.getByRole('alert')).toContainText('401 LOGIN_FAILED');
  }
  await fillPin(page, '000000');
  await submit.click();
  await expect(page.getByRole('alert')).toContainText('로그인 시도가 너무 많습니다');
  await expect(page.getByRole('alert')).toContainText('429 RATE_LIMITED');
  await expect(page.getByRole('button', { name: /초 뒤 다시 시도/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeEnabled({ timeout: 6_000 });
  expect(tries).toBe(3);
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toHaveCount(0);
  expect(api.calls().filter((c) => c.startsWith('GET /api/project') || c.startsWith('GET /api/runner'))).toEqual([]);
});
