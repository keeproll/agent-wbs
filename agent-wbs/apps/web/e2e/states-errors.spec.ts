/** 오류 막대(SYS-02)·충돌 창(MOD-01)·편집 보호·확인창(MOD-08) — UAT-STATE-07 및 공통 동작. */
import { expect, test, type Page } from '@playwright/test';
import { errorBody, fakeApi, json, type FakeApi } from './support/fake-api.ts';

const V1 = '2026-11-26T01:00:00.000000Z';
const V2 = '2026-11-26T01:03:00.000000Z';

async function openEditor(page: Page, title = '원래 제목'): Promise<FakeApi> {
  const api = await fakeApi(page);
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title, updatedAt: V1 }));
  await page.goto('/_states');
  await page.getByRole('button', { name: '편집' }).click();
  return api;
}
const saved = (title: string) => ({ task: { taskKey: 'TASK-0001', title, updatedAt: V2 }, changes: [] });

test('UAT-STATE-07 서버 검증 400: 고칠 항목 안내, 초안 유지, 다시 시도 버튼 없음, 고친 뒤 저장', async ({ page }) => {
  const api = await openEditor(page);
  api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, 400, errorBody('VALIDATION_FAILED', {
    message: '입력값이 규칙에 맞지 않습니다.', fix: '표시된 항목을 고친 뒤 다시 저장하세요.',
    errors: [{ path: 'title', rule: 'minLength', message: '제목은 비울 수 없습니다.' }],
  })));
  await page.getByLabel('제목').fill('   ');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const bar = page.getByRole('alert');
  await expect(bar).toContainText('저장하지 못했습니다 — 서버 검증 실패');
  await expect(bar).toContainText('400 VALIDATION_FAILED');
  await expect(bar.getByRole('list', { name: '고칠 항목' })).toContainText('title — 제목은 비울 수 없습니다.');
  await expect(bar).toContainText('대상: TASK-0001 제목 저장');
  await expect(bar.getByRole('button', { name: '다시 시도' })).toHaveCount(0);
  await expect(page.getByLabel('제목')).toHaveValue('   ');
  await expect(page.getByLabel('제목')).toHaveAttribute('aria-invalid', 'true');

  api.on('PATCH /api/tasks/TASK-0001', (route, request) => json(route, 200, saved((request.postDataJSON() as { title: string }).title)));
  await page.getByLabel('제목').fill('고친 제목');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByTestId('title')).toHaveText('고친 제목');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('저장 500: 데이터 미반영·입력 유지·동작/코드/시각/조치 표시, 다시 시도 성공 때만 편집이 닫힌다', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-26T10:00:00+09:00') });
  const api = await openEditor(page);
  api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, 500, errorBody('INTERNAL', { message: '서버에서 요청을 처리하지 못했습니다.', fix: '잠시 후 다시 시도하세요.' })));
  await page.getByLabel('제목').fill('새 제목');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const bar = page.getByRole('alert');
  await expect(bar).toContainText('저장하지 못했습니다 — 서버 오류');
  await expect(bar).toContainText('500 INTERNAL');
  await expect(bar).toContainText('입력한 내용은 화면에 그대로 남아 있습니다.');
  await expect(bar).toContainText('잠시 후 다시 시도하세요.');
  await expect(bar).toContainText('대상: TASK-0001 제목 저장 · 2026-11-26 10:00');
  await expect(page.getByLabel('제목')).toHaveValue('새 제목');

  api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, 200, saved('새 제목')));
  await bar.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByTestId('title')).toHaveText('새 제목');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('저장 중 네트워크 끊김: NETWORK_ERROR와 다시 시도, 입력 유지', async ({ page }) => {
  const api = await openEditor(page);
  api.on('PATCH /api/tasks/TASK-0001', (route) => route.abort('connectionrefused'));
  await page.getByLabel('제목').fill('네트워크 제목');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const bar = page.getByRole('alert');
  await expect(bar).toContainText('서버에 연결할 수 없음');
  await expect(bar).toContainText('NETWORK_ERROR');
  await expect(bar.getByRole('button', { name: '다시 시도' })).toBeVisible();
  await expect(page.getByLabel('제목')).toHaveValue('네트워크 제목');
  await bar.getByRole('button', { name: '닫기' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('제목')).toHaveValue('네트워크 제목');
});

const conflict = () => errorBody('VERSION_CONFLICT', {
  message: '다른 곳에서 먼저 바뀌어 화면의 내용이 최신이 아닙니다.',
  details: { current: null, changes: [{ at: '2026-11-26T01:02:00.000Z', actor: 'Runner', field: 'title', before: '원래 제목', after: 'Runner가 바꾼 제목' }] },
});

test('409 충돌 창: 같은 Task의 서버 변경·내 변경 표시, 포커스 가두기, Esc는 입력을 지키고 닫기, 최신 위 다시 적용', async ({ page }) => {
  const api = await openEditor(page);
  let version = V1;
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: version === V1 ? '원래 제목' : 'Runner가 바꾼 제목', updatedAt: version }));
  api.on('PATCH /api/tasks/TASK-0001', (route, request) => {
    const body = request.postDataJSON() as { updatedAt: string; title: string };
    version = V2;
    return body.updatedAt === V2 ? json(route, 200, { task: { taskKey: 'TASK-0001', title: body.title, updatedAt: '2026-11-26T01:09:00Z' }, changes: [] }) : json(route, 409, conflict());
  });
  await page.getByLabel('제목').fill('내 제목');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '다른 변경이 먼저 저장되었습니다' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('409 VERSION_CONFLICT');
  await expect(dialog).toContainText('2026-11-26 10:02 · Runner — title: 원래 제목 → Runner가 바꾼 제목');
  await expect(dialog).toContainText('제목: 내 제목');
  await expect(dialog.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('제목')).toHaveValue('내 제목');

  version = V1;
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await dialog.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(page.getByTestId('title')).toHaveText('내 제목');
  const patches = api.requests('PATCH /api/tasks/TASK-0001').map((r) => (r.postDataJSON() as { updatedAt: string }).updatedAt);
  expect(patches).toEqual([V1, V1, V2]);
});

test('409 충돌 창: 최신 내용 불러오기는 내 변경을 버리고 서버 값을 보인다', async ({ page }) => {
  const api = await openEditor(page);
  api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, 409, conflict()));
  await page.getByLabel('제목').fill('내 제목');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: 'Runner가 바꾼 제목', updatedAt: V2 }));
  await page.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' }).click();
  await expect(page.getByTestId('title')).toHaveText('Runner가 바꾼 제목');
  await expect(page.getByRole('status').filter({ hasText: '최신 내용을 불러왔습니다. 내 변경은 적용되지 않았습니다.' })).toBeVisible();
  expect(api.requests('PATCH /api/tasks/TASK-0001')).toHaveLength(1);
});

test('편집 보호: 저장 안 한 입력이 있으면 메뉴 이동 전에 묻고, 취소는 입력과 화면 유지, 확인만 이동', async ({ page }) => {
  await openEditor(page);
  await page.getByLabel('제목').fill('저장 안 한 제목');
  const menu = page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: 'WBS', exact: true });
  await menu.click();
  const dialog = page.getByRole('alertdialog', { name: '편집 내용 버리기' });
  await expect(dialog).toContainText('저장하지 않은 편집 내용이 있습니다. 저장하지 않고 이동할까요?');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page).toHaveURL('/_states');
  await expect(page.getByLabel('제목')).toHaveValue('저장 안 한 제목');
  await expect(menu).toBeFocused();

  await menu.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL('/_states');

  // 화면 안 동작(편집 취소)도 같은 확인을 거친다.
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByLabel('제목')).toHaveValue('저장 안 한 제목');

  await menu.click();
  await dialog.getByRole('button', { name: '저장하지 않고 이동' }).click();
  await expect(page).toHaveURL('/wbs');
});

test('공용 확인창(MOD-08): Esc·취소는 아무것도 바꾸지 않고, 제목 ID는 겹치지 않는다', async ({ page }) => {
  await fakeApi(page);
  await page.goto('/_states');
  const open = page.getByRole('button', { name: '확인창 열기' });
  await open.click();
  const dialog = page.getByRole('alertdialog', { name: 'Task 생성 취소' });
  await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('confirm-answer')).toHaveText('답: 취소');
  await expect(open).toBeFocused();
  await open.click();
  await dialog.getByRole('button', { name: '생성 취소' }).click();
  await expect(page.getByTestId('confirm-answer')).toHaveText('답: 확인');
  const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((el) => el.id));
  expect(new Set(ids).size).toBe(ids.length);
});

test('빈 상태 두 가지를 구분한다', async ({ page }) => {
  await fakeApi(page);
  await page.goto('/_states');
  await expect(page.locator('[data-empty="filtered"]')).toContainText('조건에 맞는 Task가 없습니다.');
  await page.getByRole('button', { name: '필터 초기화' }).click();
  await expect(page.locator('[data-empty="none"]')).toContainText('아직 실행 기록이 없습니다.');
  await expect(page.locator('[data-empty="none"]')).toContainText('Task를 실행하면 여기에 시도 기록이 표시됩니다.');
});
