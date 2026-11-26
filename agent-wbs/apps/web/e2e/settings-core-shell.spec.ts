/**
 * M3-08 설정 화면 — 탭 주소·선택 강조·복원(UAT-SHELL-01), 편집 보호, 충돌 창, 화면 폭(D-28).
 * 완료 명령: `W e2e -- settings-core`
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { errorBody, fakeApi, json, NO_PROJECT, SESSION } from './support/fake-api.ts';
import { EXEC, settingsApi, V2 } from './support/settings-fixtures.ts';

const TABS = [
  ['runner', 'Runner · 실행 환경'], ['agent', 'Agent'], ['plan', '일정 · Task'], ['report', '보고서 · 메일'], ['notify', '알림'], ['system', '점검'],
] as const;

const tabLink = (page: Page, label: string) => page.getByRole('navigation', { name: '설정 영역' }).getByRole('link', { name: new RegExp(`^${label}`) });

test('UAT-SHELL-01 설정 6탭: 주소·선택 강조가 함께 바뀌고 새로고침·뒤로 가기가 같은 탭을 복원한다', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  settingsApi(await fakeApi(page));
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: '설정' })).toBeVisible();
  await expect(tabLink(page, 'Runner · 실행 환경')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: '설정' }).first()).toHaveClass(/on/);
  for (const [key, label] of TABS) {
    await tabLink(page, label).click();
    await expect(page).toHaveURL(`/settings/${key}`);
    await expect(tabLink(page, label)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('a.tab.on')).toHaveCount(1);
  }
  await page.reload();
  await expect(tabLink(page, '점검')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: '데이터 정합성 · 회귀 점검' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('/settings/notify');
  await expect(tabLink(page, '알림')).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page).toHaveURL('/settings/report');
  // 알 수 없는 탭은 기본 탭으로 보낸다.
  await page.goto('/settings/unknown');
  await expect(page).toHaveURL('/settings/runner');
  // 메뉴 폭 180px·헤더 64px(원본 값)
  expect((await page.locator('.nav').boundingBox())?.width).toBe(180);
  expect((await page.locator('.hdr').boundingBox())?.height).toBe(64);
});

test('등록 전에도 설정은 열리고 등록 전 안내를 보인다(P L6878)', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  api.on('GET /api/project', (route) => json(route, 200, NO_PROJECT));
  await page.goto('/settings/agent');
  await expect(page.getByRole('note').filter({ hasText: '프로젝트 등록 전 — 실행 환경 · 정책 설정은 지금 정해 두면 등록 후 그대로 적용됩니다.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Agent 역할 · 기본 Workflow' })).toBeVisible();
});

test('편집 보호: 저장하지 않은 카드가 있으면 탭 이동 전에 묻고, 취소하면 입력이 남는다', async ({ page }) => {
  settingsApi(await fakeApi(page));
  await page.goto('/settings/agent');
  const usage = page.getByRole('group', { name: '사용량 부족 시' });
  await usage.getByRole('button', { name: '리셋까지 대기' }).click();
  await expect(page.getByText('저장하지 않은 변경이 있습니다.')).toBeVisible();
  await tabLink(page, '일정 · Task').click();
  const dialog = page.getByRole('alertdialog', { name: '편집 내용 버리기' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page).toHaveURL('/settings/agent');
  await expect(usage.getByRole('button', { name: '리셋까지 대기' })).toHaveAttribute('aria-pressed', 'true');
  // 변경 취소로 서버 값으로 돌아가면 묻지 않고 이동한다.
  await page.getByRole('button', { name: '변경 취소' }).click();
  await tabLink(page, '일정 · Task').click();
  await expect(page).toHaveURL('/settings/plan');
});

test('충돌 창: 다른 곳에서 먼저 바꾼 실행 정책 — 최신 불러오기는 내 변경을 버리고 서버 값을 보인다', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  let latest = { ...EXEC };
  api.on('GET /api/settings/exec-policy', (route) => json(route, 200, latest));
  api.on('PUT /api/settings/exec-policy', (route) => {
    latest = { ...EXEC, onRework: 'top', updatedAt: V2 };
    return json(route, 409, errorBody('VERSION_CONFLICT', { details: { changes: [{ at: V2, actor: 'lead', field: 'onRework', before: 'up1', after: 'top' }] } }));
  });
  await page.goto('/settings/agent');
  await page.getByRole('group', { name: '재작업 시' }).getByRole('button', { name: '같은 등급 유지' }).click();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /최신 내용 불러오기/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('group', { name: '재작업 시' }).getByRole('button', { name: '최상위로 상향' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('저장하지 않은 변경이 있습니다.')).toHaveCount(0);
});

test('충돌 창: 최신 위에 다시 적용은 새 버전으로 내 변경을 저장한다', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  let latest = { ...EXEC };
  const bodies: Record<string, unknown>[] = [];
  api.on('GET /api/settings/exec-policy', (route) => json(route, 200, latest));
  api.on('PUT /api/settings/exec-policy', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    if (bodies.length === 1) {
      latest = { ...EXEC, notifyAt: 3, updatedAt: V2 };
      return json(route, 409, errorBody('VERSION_CONFLICT'));
    }
    latest = { ...latest, ...body, updatedAt: '2026-11-05T03:00:00.000Z' } as typeof EXEC;
    return json(route, 200, latest);
  });
  await page.goto('/settings/agent');
  await page.getByRole('group', { name: '재작업 시' }).getByRole('button', { name: '같은 등급 유지' }).click();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /다시 적용/ }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(bodies[1]).toMatchObject({ updatedAt: V2, onRework: 'same' });
  await expect(page.getByRole('group', { name: '재작업 시' }).getByRole('button', { name: '같은 등급 유지' })).toHaveAttribute('aria-pressed', 'true');
});

test('저장 실패(500)는 입력을 지키고 다시 시도로 같은 내용을 보낸다', async ({ page }) => {
  const api = await fakeApi(page);
  const s = settingsApi(api);
  let fail = true;
  api.on('PUT /api/settings/split', (route) => {
    s.split.bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (fail) { fail = false; return json(route, 500, errorBody('INTERNAL')); }
    return json(route, 200, { ...s.split.current(), maxHours: 6, updatedAt: V2 });
  });
  await page.goto('/settings/plan');
  await page.getByRole('group', { name: '크기 상한' }).getByRole('button', { name: '6h' }).click();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const bar = page.getByRole('alert').filter({ hasText: 'Task 분할 기준 저장' });
  await expect(bar).toBeVisible();
  await expect(page.getByRole('group', { name: '크기 상한' }).getByRole('button', { name: '6h' })).toHaveAttribute('aria-pressed', 'true');
  await bar.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByText('분할 기준을 바꿨습니다.')).toBeVisible();
  expect(s.split.bodies.map((b) => b.maxHours)).toEqual([6, 6]);
});

for (const width of [1280, 1920]) {
  test(`D-28 ${String(width)}px: 모든 탭에서 페이지 가로 스크롤이 없다`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    settingsApi(await fakeApi(page));
    for (const [key] of TABS) {
      await page.goto(`/settings/${key}`);
      await expect(page.locator('a.tab.on')).toHaveCount(1);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('.page');
        return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, page: main ? main.scrollWidth - main.clientWidth : 0 };
      });
      expect(overflow, `${key} 탭`).toEqual({ doc: 0, page: 0 });
    }
  });
}

test('D-28 1100px: 페이지는 넘치지 않고 표만 상자 안에서 가로로 스크롤한다', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  settingsApi(await fakeApi(page));
  await page.goto('/settings/agent');
  const table = page.getByRole('region', { name: '하위 Agent 정의 표' });
  await expect(table).toBeVisible();
  const box = await table.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(box.scroll).toBeGreaterThan(box.client);
  const doc = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(doc).toBe(0);
});

test('세션 만료: 저장 중 401이면 카드 초안을 보관하고, 다시 로그인하면 같은 탭에서 복원을 제안한다', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  let signedIn = true;
  api.on('GET /api/session', (route) => (signedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  api.on('POST /api/auth/session', (route) => { signedIn = true; return route.fulfill({ status: 204 }); });
  api.on('PUT /api/settings/schedule', (route) => { signedIn = false; return json(route, 401, errorBody('LEAD_UNAUTHORIZED')); });
  await page.goto('/settings/plan');
  await page.getByRole('group', { name: '재조정 임계값' }).getByRole('button', { name: '3일' }).click();
  await page.getByRole('region', { name: '일정 재조정 정책 · 작업 불가일' }).getByRole('button', { name: '저장', exact: true }).click();
  await expect(page).toHaveURL('/login?next=%2Fsettings%2Fplan');
  await page.getByLabel('비밀번호').fill('pw');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL('/settings/plan');
  const offer = page.getByRole('region', { name: '설정 — 일정 재조정 정책 — 저장하지 못한 초안' });
  await offer.getByRole('button', { name: '복원' }).click();
  await expect(page.getByRole('group', { name: '재조정 임계값' }).getByRole('button', { name: '3일' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('저장하지 않은 변경이 있습니다.')).toBeVisible();
});

test('접근성: 설정 탭마다 axe 위반이 없다', async ({ page }) => {
  settingsApi(await fakeApi(page));
  for (const [key] of TABS) {
    await page.goto(`/settings/${key}`);
    await expect(page.locator('a.tab.on')).toHaveCount(1);
    await page.waitForLoadState('networkidle');
    expect((await new AxeBuilder({ page }).analyze()).violations, `${key} 탭`).toEqual([]);
  }
});
