/**
 * UAT-AUTH-01~03 — 실제 API(LAN 모드)·실제 DB로 확인한다. `pnpm --filter @awbs/web e2e:api`가 환경을 만든다.
 * 환경 변수가 없으면(일반 `W e2e`) 건너뛴다.
 */
import { expect, test } from '@playwright/test';

const token = process.env.AWBS_E2E_LINK_TOKEN ?? '';
const password = process.env.AWBS_E2E_PASSWORD ?? '';
test.skip(!token || !password, '실제 API 환경이 없다. pnpm --filter @awbs/web e2e:api로 실행한다.');
test.describe.configure({ mode: 'serial' });

const sessionCookie = async (page: import('@playwright/test').Page) =>
  (await page.context().cookies()).find((c) => c.name === 'awbs_session');

/** 실제 서버의 5xx를 모아 둔다(서버 결함 보고용). */
const serverErrors: string[] = [];
test.beforeEach(({ page }) => {
  page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.request().method()} ${new URL(r.url()).pathname} ${String(r.status())}`); });
});
test.afterAll(() => { if (serverErrors.length) console.log(`[실제 API 5xx] ${serverErrors.join(' | ')}`); });

test('UAT-AUTH-02 실제 1회용 링크: 주소에서 토큰 제거, 세션 발급, 같은 토큰 재사용은 LOGIN_FAILED', async ({ browser }) => {
  const first = await browser.newPage();
  await first.goto(`/#login-token=${token}`);
  await expect(first).toHaveURL('/dashboard');
  expect(first.url()).not.toContain(token);
  // 실제 DB는 빈 프로젝트 → 등록 전 잠금 안내까지 보인다(보호 API가 세션으로 열림).
  await expect(first.locator('.proj-n')).toHaveText('등록된 프로젝트 없음');
  await expect(first.getByRole('note')).toContainText('먼저 프로젝트를 등록하세요.');
  const cookie = await sessionCookie(first);
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  const session = await first.evaluate(() => fetch('/api/session').then((r) => r.json() as Promise<{ method: string }>));
  expect(session.method).toBe('link');
  await first.close();

  const reuse = await browser.newPage();
  await reuse.goto(`/#login-token=${token}`);
  await expect(reuse).toHaveURL(/\/login\?link=failed/);
  expect(reuse.url()).not.toContain(token);
  await expect(reuse.getByRole('alert')).toContainText('1회용 링크로 로그인하지 못했습니다');
  expect(await sessionCookie(reuse)).toBeUndefined();
  await reuse.close();
});

test('UAT-AUTH-01 실제 LAN 비밀번호: 보호 주소 → 로그인 → 같은 주소로 복귀, password 세션', async ({ page }) => {
  await page.goto('/settings/report');
  await expect(page).toHaveURL('/login?next=%2Fsettings%2Freport');
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL('/settings/report');
  await expect(page.getByRole('heading', { level: 1, name: '설정' })).toBeVisible();
  const session = await page.evaluate(() => fetch('/api/session').then((r) => r.json() as Promise<{ method: string; csrfToken: string }>));
  expect(session.method).toBe('password');
  // 로그아웃하면 세션이 끝나고 로그인 화면으로 간다.
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => fetch('/api/session').then((r) => r.status))).toBe(401);
});

test('UAT-AUTH-03 실제 틀린 비밀번호 반복: LOGIN_FAILED 안내 뒤 429 횟수 제한, 보호 데이터 없음', async ({ page }) => {
  const protectedCalls: string[] = [];
  page.on('request', (r) => { if (/\/api\/(project|runner-state|dashboard)/.test(r.url())) protectedCalls.push(r.url()); });
  await page.goto('/dashboard');
  const alert = page.getByRole('alert');
  let limited = false;
  for (let i = 0; i < 8 && !limited; i++) {
    await page.getByLabel('비밀번호').fill(`wrong-${String(i)}`);
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/auth/session') && r.request().method() === 'POST'),
      page.getByRole('button', { name: '로그인', exact: true }).click(),
    ]);
    await expect(alert).toContainText(/LOGIN_FAILED|RATE_LIMITED/);
    limited = (await alert.textContent())?.includes('429 RATE_LIMITED') ?? false;
    if (!limited) await expect(alert).toContainText('로그인하지 못했습니다. 비밀번호를 확인한 뒤 다시 입력하세요.');
  }
  expect(limited).toBe(true);
  await expect(alert).toContainText('로그인 시도가 너무 많습니다');
  await expect(page.getByRole('button', { name: /초 뒤 다시 시도/ })).toBeDisabled();
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toHaveCount(0);
  expect(protectedCalls).toEqual([]);
});
