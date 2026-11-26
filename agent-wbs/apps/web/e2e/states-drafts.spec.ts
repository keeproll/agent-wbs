/** 세션 만료 초안 보관·복원(조정자 결정): 화면별 sessionStorage, 재로그인 뒤 같은 화면에서 복원 제안, 비밀값 제외. */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { errorBody, fakeApi, json, SESSION, type FakeApi } from './support/fake-api.ts';

const V1 = '2026-11-26T01:00:00.000000Z';

async function expireWhileEditing(page: Page, context?: BrowserContext): Promise<FakeApi> {
  const api = await fakeApi(context ?? page);
  let signedIn = true;
  api.on('GET /api/session', (route) => (signedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  api.on('POST /api/auth/session', (route) => { signedIn = true; return route.fulfill({ status: 204 }); });
  api.on('DELETE /api/auth/session', (route) => { signedIn = false; return route.fulfill({ status: 204 }); });
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: '원래 제목', updatedAt: V1 }));
  api.on('PATCH /api/tasks/TASK-0001', (route) => { signedIn = false; return json(route, 401, errorBody('LEAD_UNAUTHORIZED')); });
  await page.goto('/_states');
  await page.getByRole('button', { name: '편집' }).click();
  await page.getByLabel('제목').fill('만료 전에 쓴 제목');
  await page.getByLabel('메시지').fill('보내지 못한 메시지');
  await page.getByLabel('봇 토큰(비밀값)').fill('secret-token-123');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page).toHaveURL('/login?next=%2F_states');
  return api;
}

test('세션이 끊기면 화면별 초안을 sessionStorage에 남기되 비밀값은 빼고, 재로그인 뒤 같은 화면에서 복원을 제안한다', async ({ page }) => {
  await expireWhileEditing(page);
  const stored = await page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).filter((k) => k.startsWith('awbs.draft:')).map((k) => [k, sessionStorage.getItem(k)])));
  expect(Object.keys(stored).sort()).toEqual(['awbs.draft:sandbox:message', 'awbs.draft:task:TASK-0001:title']);
  expect(JSON.stringify(stored)).not.toContain('secret-token-123');
  expect(JSON.stringify(stored)).toContain('보내지 못한 메시지');

  await page.getByLabel('비밀번호').fill('pw');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL('/_states');
  const offer = page.getByRole('region', { name: 'TASK-0001 제목 편집 — 저장하지 못한 초안' });
  await expect(offer).toContainText('로그인이 끊겨 저장하지 못한 편집 내용이 있습니다');
  await offer.getByRole('button', { name: '복원' }).click();
  await expect(page.getByLabel('제목')).toHaveValue('만료 전에 쓴 제목');
  await expect(offer).toHaveCount(0);

  const msgOffer = page.getByRole('region', { name: '메시지 초안 — 저장하지 못한 초안' });
  await msgOffer.getByRole('button', { name: '복원' }).click();
  await expect(page.getByLabel('메시지')).toHaveValue('보내지 못한 메시지');
  // 비밀값은 복원하지 않는다. 다시 입력해야 한다.
  await expect(page.getByLabel('봇 토큰(비밀값)')).toHaveValue('');
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('awbs.draft:')))).toEqual([]);
});

test('복원 제안을 버리면 초안을 지우고 다시 묻지 않는다', async ({ page }) => {
  await expireWhileEditing(page);
  await page.getByLabel('비밀번호').fill('pw');
  await page.getByRole('button', { name: '로그인' }).click();
  const offer = page.getByRole('region', { name: 'TASK-0001 제목 편집 — 저장하지 못한 초안' });
  await offer.getByRole('button', { name: '버리기' }).click();
  await expect(offer).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('원래 제목');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '공통 컴포넌트 견본' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'TASK-0001 제목 편집 — 저장하지 못한 초안' })).toHaveCount(0);
});

const draftKeys = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('awbs.draft:')));
async function relogin(page: Page) {
  await page.getByLabel('비밀번호').fill('pw');
  await page.getByRole('button', { name: '로그인' }).click();
}

// 재리뷰 622c334 #1
test('명시적으로 로그아웃하면 보관 초안을 즉시 지우고 다음 로그인에서 복원을 제안하지 않는다', async ({ page }) => {
  await expireWhileEditing(page);
  await relogin(page);
  await expect(page.getByRole('region', { name: 'TASK-0001 제목 편집 — 저장하지 못한 초안' })).toBeVisible();
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await draftKeys(page)).toEqual([]);
  await relogin(page);
  await page.goto('/_states');
  await expect(page.getByRole('heading', { level: 1, name: '공통 컴포넌트 견본' })).toBeVisible();
  await expect(page.getByRole('region', { name: /저장하지 못한 초안/ })).toHaveCount(0);
});

// 재리뷰 622c334 #2
test('opener로 연 새 탭은 sessionStorage 사본을 받아도 초안을 복원하지 않고 사본을 지운다', async ({ page, context }) => {
  await expireWhileEditing(page, context);
  await relogin(page);
  await expect(page.getByRole('region', { name: 'TASK-0001 제목 편집 — 저장하지 못한 초안' })).toBeVisible();
  const [popup] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => { window.open('/_states', '_blank'); })]);
  await expect(popup.getByRole('heading', { level: 1, name: '공통 컴포넌트 견본' })).toBeVisible();
  expect(await popup.evaluate(() => window.opener !== null)).toBe(true);
  await expect(popup.getByRole('region', { name: /저장하지 못한 초안/ })).toHaveCount(0);
  expect(await draftKeys(popup)).toEqual([]);
  // 원래 탭은 그대로 복원할 수 있다.
  await page.reload();
  await page.getByRole('region', { name: 'TASK-0001 제목 편집 — 저장하지 못한 초안' }).getByRole('button', { name: '복원' }).click();
  await expect(page.getByLabel('제목')).toHaveValue('만료 전에 쓴 제목');
});

// 재리뷰 622c334 #3
test('대상 id가 바뀌면 새 대상의 초안만 제안하고, 복원·삭제도 그 대상에만 한다', async ({ page }) => {
  await fakeApi(page);
  await page.goto('/_states');
  await expect(page.getByRole('heading', { level: 1, name: '공통 컴포넌트 견본' })).toBeVisible();
  await page.evaluate(() => {
    const tabId = sessionStorage.getItem('awbs.tab') ?? '';
    for (const [t, text] of [['A', 'A의 전용 초안'], ['B', 'B의 전용 초안']] as const) {
      sessionStorage.setItem(`awbs.draft:sandbox:target:${t}`, JSON.stringify({ tabId, label: `대상 ${t} 메모`, path: '/_states', savedAt: 1, data: { text } }));
    }
  });
  await page.reload();
  await expect(page.getByRole('region', { name: '대상 A 메모 — 저장하지 못한 초안' })).toBeVisible();
  await page.getByLabel('대상', { exact: true }).selectOption('B');
  await expect(page.getByRole('region', { name: '대상 A 메모 — 저장하지 못한 초안' })).toHaveCount(0);
  const offerB = page.getByRole('region', { name: '대상 B 메모 — 저장하지 못한 초안' });
  await offerB.getByRole('button', { name: '복원' }).click();
  await expect(page.getByLabel('대상 메모')).toHaveValue('B의 전용 초안');
  expect((await draftKeys(page)).sort()).toEqual(['awbs.draft:sandbox:target:A']);
  // A로 돌아가면 A 초안 제안이 다시 보인다.
  await page.getByLabel('대상', { exact: true }).selectOption('A');
  await expect(page.getByRole('region', { name: '대상 A 메모 — 저장하지 못한 초안' })).toBeVisible();
});

// 재리뷰 a9d5acd: 다른 탭의 명시적 로그아웃
test('한 탭에서 로그아웃하면 다른 탭의 보관 초안도 바로 지우고, 다음 로그인에서 제안하지 않는다', async ({ page, context }) => {
  await expireWhileEditing(page, context);
  await relogin(page);
  await expect(page.getByRole('region', { name: 'TASK-0001 제목 편집 — 저장하지 못한 초안' })).toBeVisible();

  const other = await context.newPage();
  await other.goto('/dashboard');
  await expect(other.getByRole('heading', { level: 1, name: '대시보드' })).toBeVisible();
  await other.getByRole('button', { name: '로그아웃' }).click();
  await expect(other).toHaveURL(/\/login/);

  // 알림을 받은 탭: 복원 제안이 사라지고 저장소도 비었다.
  await expect(page.getByRole('region', { name: /저장하지 못한 초안/ })).toHaveCount(0);
  expect(await draftKeys(page)).toEqual([]);
  await page.reload();
  await relogin(page);
  await page.goto('/_states');
  await expect(page.getByRole('heading', { level: 1, name: '공통 컴포넌트 견본' })).toBeVisible();
  await expect(page.getByRole('region', { name: /저장하지 못한 초안/ })).toHaveCount(0);
});

test('로그아웃 알림을 못 받은 탭도 로그아웃 시각 이전에 보관된 초안은 버린다', async ({ page }) => {
  await fakeApi(page);
  await page.goto('/_states');
  await expect(page.getByRole('heading', { level: 1, name: '공통 컴포넌트 견본' })).toBeVisible();
  await page.evaluate(() => {
    const tabId = sessionStorage.getItem('awbs.tab') ?? '';
    sessionStorage.setItem('awbs.draft:sandbox:target:A', JSON.stringify({ tabId, label: '대상 A 메모', path: '/_states', savedAt: 1_000, data: { text: '오래된 초안' } }));
    sessionStorage.setItem('awbs.draft:sandbox:target:B', JSON.stringify({ tabId, label: '대상 B 메모', path: '/_states', savedAt: 3_000, data: { text: '새 초안' } }));
    // 다른 탭이 로그아웃했지만 알림(BroadcastChannel)은 받지 못한 상황: 기록만 남아 있다.
    localStorage.setItem('awbs.logoutAt', '2000');
  });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '공통 컴포넌트 견본' })).toBeVisible();
  await expect(page.getByRole('region', { name: '대상 A 메모 — 저장하지 못한 초안' })).toHaveCount(0);
  expect(await draftKeys(page)).not.toContain('awbs.draft:sandbox:target:A');
  await page.getByLabel('대상', { exact: true }).selectOption('B');
  await expect(page.getByRole('region', { name: '대상 B 메모 — 저장하지 못한 초안' })).toBeVisible();
});
