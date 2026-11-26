/** 세션 만료 초안 보관·복원(조정자 결정): 화면별 sessionStorage, 재로그인 뒤 같은 화면에서 복원 제안, 비밀값 제외. */
import { expect, test, type Page } from '@playwright/test';
import { errorBody, fakeApi, json, SESSION, type FakeApi } from './support/fake-api.ts';

const V1 = '2026-11-26T01:00:00.000000Z';

async function expireWhileEditing(page: Page): Promise<FakeApi> {
  const api = await fakeApi(page);
  let signedIn = true;
  api.on('GET /api/session', (route) => (signedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  api.on('POST /api/auth/session', (route) => { signedIn = true; return route.fulfill({ status: 204 }); });
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
