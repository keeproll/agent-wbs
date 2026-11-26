/**
 * 독립 리뷰(M3-02-independent) 지적의 실패 경로 시험.
 * 1. 선행 연결 실패 뒤 다시 눌러도 Task를 두 번 만들지 않는다.
 * 2. Wizard 입력 중 뒤로 가기·새로고침은 확인을 거친다.
 * 3. 선행 연결 충돌(409)의 「다시 적용」·「최신 불러오기」가 실제로 동작한다.
 * 4. 상세 첫 조회 실패(503)는 오류와 다시 시도를 보인다.
 * 5. 목록 필터와 상관없이 선행 선택지는 프로젝트의 모든 Task다.
 * 6. 390px에서 도구 막대가 문서를 넘치게 하지 않는다. 7. Wizard 3단계 제목 순서.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { errorBody, json } from './support/fake-api.ts';
import { wbsApi } from './support/wbs-api.ts';
import { PROJECT_ID } from './support/wbs-fixture.ts';

const wiz = (page: Page) => page.getByRole('dialog', { name: 'Task 생성' });

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1920, height: 1080 }); });

async function fillToStep3(page: Page, title = '부분 실패 시험') {
  await page.locator('.page-h').getByRole('button', { name: 'Task 생성' }).click();
  const w = wiz(page);
  await w.getByLabel('Task 제목').fill(title);
  await w.getByLabel('상위 Work Package').selectOption({ label: '2.1 Task API' });
  await w.getByRole('group', { name: '작업 유형' }).getByRole('button', { name: /구현/ }).click();
  await w.getByRole('group', { name: '주 기술 영역' }).getByRole('button', { name: /^BE/ }).click();
  await w.getByRole('button', { name: '다음' }).click();
  await w.getByLabel('작업 목적').fill('목적');
  await w.getByLabel('완료 조건').fill('완료 조건');
  await w.getByRole('button', { name: '다음' }).click();
  return w;
}
const pred = (page: Page, key: string) => wiz(page).getByRole('group', { name: '선행 Task' }).locator('label').filter({ hasText: key }).getByRole('checkbox');

test('1. 선행 연결이 실패해도 Task는 한 번만 만들고, 이미 만든 Task에 선행만 다시 붙인다', async ({ page }) => {
  const api = await wbsApi(page);
  await page.goto('/wbs');
  // 선택한 선행(TASK-0005)이 그 사이 지워졌다 → 선행 추가 404
  await page.route('**/api/tasks/TASK-0013/dependencies', async (route, request) => {
    const body = request.postDataJSON() as { predTaskKey: string };
    if (body.predTaskKey === 'TASK-0005') { await json(route, 404, errorBody('TASK_NOT_FOUND', { message: 'Task를 찾을 수 없습니다.' })); return; }
    await route.fallback();
  });
  const w = await fillToStep3(page);
  await pred(page, 'TASK-0005').check();
  await w.getByRole('button', { name: 'Task 생성', exact: true }).click();

  const bar = page.getByRole('alert').filter({ hasText: '선행 Task를 연결하지 못했습니다' });
  await expect(bar).toContainText('404 TASK_NOT_FOUND');
  await expect(w).toContainText('TASK-0013을(를) 이미 만들었습니다');
  // 다시 누르는 버튼은 생성이 아니라 선행 연결이다.
  await expect(w.getByRole('button', { name: 'Task 생성', exact: true })).toHaveCount(0);
  await expect(w.getByRole('button', { name: '이전' })).toBeDisabled();
  await w.getByRole('button', { name: '선행 연결', exact: true }).click();
  await expect(bar).toBeVisible();
  // 지워진 선행을 빼고 다른 선행을 고른 뒤 연결
  await pred(page, 'TASK-0005').uncheck();
  await pred(page, 'TASK-0006').check();
  await w.getByRole('button', { name: '선행 연결', exact: true }).click();

  await expect(page).toHaveURL('/wbs/TASK-0013?tab=spec');
  expect(api.requests(`POST /api/projects/${PROJECT_ID}/tasks`)).toHaveLength(1);
  expect(api.list.tasks.filter((t) => t.title === '부분 실패 시험')).toHaveLength(1);
  expect(api.list.tasks.find((t) => t.taskKey === 'TASK-0013')?.preds).toEqual(['TASK-0006']);
});

test('1-1. 만든 뒤 선행 연결을 그만두고 닫으면 만든 Task로 이동한다(초안을 버린다고 묻지 않음)', async ({ page }) => {
  const api = await wbsApi(page);
  await page.goto('/wbs');
  await page.route('**/api/tasks/TASK-0013/dependencies', (route) => json(route, 404, errorBody('TASK_NOT_FOUND')));
  const w = await fillToStep3(page);
  await pred(page, 'TASK-0005').check();
  await w.getByRole('button', { name: 'Task 생성', exact: true }).click();
  await expect(w).toContainText('TASK-0013을(를) 이미 만들었습니다');
  await w.getByRole('button', { name: '선행 없이 마치기' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0013?tab=spec');
  await expect(page.locator('.notice')).toContainText('TASK-0013');
  expect(api.requests(`POST /api/projects/${PROJECT_ID}/tasks`)).toHaveLength(1);
});

test('2. Wizard 입력 중 뒤로 가기는 확인창을 띄우고, 취소하면 입력이 남는다. 새로고침은 브라우저 확인을 요구한다', async ({ page }) => {
  await wbsApi(page);
  // 대시보드 → (메뉴) WBS → Task 생성: 앱 안 이력에서 뒤로 가기
  await page.goto('/dashboard');
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: 'WBS', exact: true }).click();
  await expect(page.locator('.resbar')).toHaveText('전체 12건');
  await page.locator('.page-h').getByRole('button', { name: 'Task 생성' }).click();
  await wiz(page).getByLabel('Task 제목').fill('지키고 싶은 제목');
  await page.goBack();
  const confirm = page.getByRole('alertdialog', { name: '편집 내용 버리기' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page).toHaveURL('/wbs');
  await expect(wiz(page).getByLabel('Task 제목')).toHaveValue('지키고 싶은 제목');
  // 새로고침·창 닫기: beforeunload를 막는다.
  expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; })).toBe(true);
  // 확인하면 이동한다.
  await page.goBack();
  await confirm.getByRole('button', { name: '저장하지 않고 이동' }).click();
  await expect(page).toHaveURL('/dashboard');
});

test('2-1. 생성에 성공해 상세로 이동할 때는 묻지 않는다', async ({ page }) => {
  await wbsApi(page);
  await page.goto('/wbs');
  const w = await fillToStep3(page, '성공 이동');
  await w.getByRole('button', { name: 'Task 생성', exact: true }).click();
  await expect(page).toHaveURL('/wbs/TASK-0013?tab=spec');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; })).toBe(false);
});

test('3. 선행 연결 충돌(409)의 「다시 적용」은 최신 버전으로 선행을 다시 붙인다', async ({ page }) => {
  const api = await wbsApi(page);
  await page.goto('/wbs');
  const depCalls: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/tasks/TASK-0013/dependencies')) depCalls.push(r.url()); });
  let conflicts = 1;
  await page.route('**/api/tasks/TASK-0013/dependencies', async (route) => {
    if (conflicts-- > 0) { await json(route, 409, errorBody('VERSION_CONFLICT', { details: { changes: [{ at: '2026-11-05T10:58:00Z', actor: 'Runner', field: 'status', before: 'planning', after: 'planning' }] } })); return; }
    await route.fallback();
  });
  const w = await fillToStep3(page, '충돌 시험');
  await pred(page, 'TASK-0005').check();
  await w.getByRole('button', { name: 'Task 생성', exact: true }).click();
  const modal = page.getByRole('alertdialog').filter({ hasText: 'VERSION_CONFLICT' });
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0013?tab=spec');
  expect(api.list.tasks.find((t) => t.taskKey === 'TASK-0013')?.preds).toEqual(['TASK-0005']);
  expect(api.requests(`POST /api/projects/${PROJECT_ID}/tasks`)).toHaveLength(1);
  // 첫 요청(409) + 다시 적용 1회
  expect(depCalls).toHaveLength(2);
});

test('3-1. 선행 연결 충돌의 「최신 불러오기」는 선행을 붙이지 않고, 만든 Task 상태를 다시 읽어 선행 선택을 그대로 둔다', async ({ page }) => {
  const api = await wbsApi(page);
  await page.goto('/wbs');
  await page.route('**/api/tasks/TASK-0013/dependencies', (route) => json(route, 409, errorBody('VERSION_CONFLICT', { details: { changes: [] } })));
  const w = await fillToStep3(page, '충돌 불러오기');
  await pred(page, 'TASK-0005').check();
  await w.getByRole('button', { name: 'Task 생성', exact: true }).click();
  const modal = page.getByRole('alertdialog').filter({ hasText: 'VERSION_CONFLICT' });
  const before = api.requests('GET /api/tasks/TASK-0013').length;
  await modal.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' }).click();
  await expect(modal).toHaveCount(0);
  await expect.poll(() => api.requests('GET /api/tasks/TASK-0013').length).toBeGreaterThan(before);
  await expect(w).toContainText('TASK-0013을(를) 이미 만들었습니다');
  await expect(pred(page, 'TASK-0005')).toBeChecked();
});

test('4. 상세 첫 조회가 503이면 상세 자리에 원인과 다시 시도를 보인다', async ({ page }) => {
  const api = await wbsApi(page);
  let fail = true;
  const ok = api.list.tasks.find((t) => t.taskKey === 'TASK-0004');
  await page.route('**/api/tasks/TASK-0004', async (route) => {
    if (fail) { await json(route, 503, errorBody('UNAVAILABLE', { message: 'DB에 연결할 수 없습니다.' })); return; }
    await route.fallback();
  });
  await page.goto('/wbs');
  await page.getByRole('table', { name: 'WBS Task 목록' }).getByRole('button', { name: 'Drizzle Schema 설계' }).click();
  const detail = page.getByRole('region', { name: 'Task 상세' });
  // M3 통합: 상세 자리는 M3-03 TaskDetail이 그린다. 첫 조회 실패는 그 상세 안의 「Task 불러오기 실패」 카드로 보인다(원인 코드·다시 시도).
  const err = detail.getByRole('region', { name: 'Task 불러오기 실패' });
  await expect(err).toContainText('TASK-0004 상세를 불러오지 못했습니다');
  await expect(err).toContainText('503 UNAVAILABLE');
  await expect(detail).not.toHaveAttribute('aria-busy', 'true');
  fail = false;
  await err.getByRole('button', { name: '다시 시도' }).click();
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText(ok?.title ?? '');
});

test('4-1. 목록에 없는 Task 주소를 열었는데 상세 조회가 503이면 WBS 위쪽에 안내와 다시 시도를 보인다', async ({ page }) => {
  await wbsApi(page);
  await page.route('**/api/tasks/TASK-0004', (route) => json(route, 503, errorBody('UNAVAILABLE')));
  // 서버 검색으로 목록에서 TASK-0004가 빠진 상태
  await page.goto('/wbs');
  await page.getByPlaceholder('Task ID 또는 제목 검색').fill('Monorepo');
  await expect(page.locator('.resbar')).toHaveText('필터 결과 1건');
  await page.evaluate(() => { history.pushState({}, '', '/wbs/TASK-0004'); dispatchEvent(new PopStateEvent('popstate')); });
  const banner = page.getByRole('alert').filter({ hasText: 'TASK-0004 상세를 불러오지 못했습니다' });
  await expect(banner).toContainText('503 UNAVAILABLE');
  await expect(banner.getByRole('button', { name: '다시 시도' })).toBeVisible();
  await expect(banner.getByRole('button', { name: '닫기' })).toBeVisible();
});

test('5. 목록을 거른 상태에서도 Wizard의 선행 선택지는 프로젝트의 모든 Task다', async ({ page }) => {
  await wbsApi(page);
  await page.goto('/wbs');
  await page.locator('.toolbar label.fsel').filter({ has: page.locator('.fsel-l', { hasText: /^상태$/ }) }).locator('select').selectOption('done');
  await expect(page.locator('.resbar')).toHaveText('필터 결과 3건');
  await page.getByPlaceholder('Task ID 또는 제목 검색').fill('없는 제목');
  await expect(page.locator('.resbar')).toHaveText('필터 결과 0건');
  await fillToStep3(page, '선택지 시험');
  await expect(wiz(page).getByRole('group', { name: '선행 Task' }).locator('label')).toHaveCount(12);
  await expect(pred(page, 'TASK-0005')).toBeVisible();
});

test('6. 390px: 표·Gantt 화면의 도구 막대가 문서를 가로로 넘치게 하지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await wbsApi(page);
  await page.goto('/wbs');
  await expect(page.locator('.resbar')).toHaveText('전체 12건');
  const over = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(await over()).toBe(false);
  await page.getByRole('button', { name: '일정 (Gantt)' }).click();
  expect(await over()).toBe(false);
});

test('7. Wizard 3단계 제목 순서가 접근성 검사를 통과한다', async ({ page }) => {
  await wbsApi(page);
  await page.goto('/wbs');
  await fillToStep3(page, '접근성');
  const result = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
});

test('F1. 고른 선행이 실제로 지워져 목록에서 빠져도, 선택에 남은 것을 해제하고 남은 유효한 선행을 연결할 수 있다', async ({ page }) => {
  const api = await wbsApi(page);
  await page.goto('/wbs');
  const w = await fillToStep3(page, '삭제된 선행 복구');
  await pred(page, 'TASK-0012').check();
  await pred(page, 'TASK-0005').check();
  // 다른 곳에서 TASK-0012를 삭제했다: 선행 추가는 404, 목록에서도 빠진다(새 Task 번호가 겹치지 않게 생성 뒤에 지운다).
  await page.route('**/api/tasks/TASK-0013/dependencies', async (route, request) => {
    if ((request.postDataJSON() as { predTaskKey: string }).predTaskKey === 'TASK-0012') {
      api.list.tasks = api.list.tasks.filter((t) => t.taskKey !== 'TASK-0012');
      await json(route, 404, errorBody('TASK_NOT_FOUND'));
      return;
    }
    await route.fallback();
  });
  await w.getByRole('button', { name: 'Task 생성', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '선행 Task를 연결하지 못했습니다' })).toBeVisible();
  // 목록을 다시 읽어도 고른 TASK-0012는 「목록에 없음」으로 남아 해제할 수 있다.
  const gone = wiz(page).getByRole('group', { name: '선행 Task' }).locator('label').filter({ hasText: 'TASK-0012' });
  await expect(gone).toContainText('목록에 없음');
  // 해제하면 그 줄이 사라진다(uncheck는 사라진 요소의 상태를 기다리므로 click).
  await gone.getByRole('checkbox').click();
  await expect(gone).toHaveCount(0);
  await expect(pred(page, 'TASK-0005')).toBeChecked();
  await w.getByRole('button', { name: '선행 연결', exact: true }).click();
  await expect(page).toHaveURL('/wbs/TASK-0013?tab=spec');
  expect(api.list.tasks.find((t) => t.taskKey === 'TASK-0013')?.preds).toEqual(['TASK-0005']);
  expect(api.requests(`POST /api/projects/${PROJECT_ID}/tasks`)).toHaveLength(1);
});

test('F2. 충돌창의 「최신 불러오기」가 실패(503)하면 창을 닫지 않고 이유를 보이며, 다시 누르면 불러온다', async ({ page }) => {
  await wbsApi(page);
  await page.goto('/wbs');
  await page.route('**/api/tasks/TASK-0013/dependencies', (route) => json(route, 409, errorBody('VERSION_CONFLICT', { details: { changes: [] } })));
  const w = await fillToStep3(page, '불러오기 실패');
  await pred(page, 'TASK-0005').check();
  // 충돌 이후의 최신 조회만 실패시킨다(선행 추가 전 조회는 성공).
  let failReload = false;
  await page.route('**/api/tasks/TASK-0013', async (route) => {
    if (failReload) { await json(route, 503, errorBody('UNAVAILABLE', { message: 'DB에 연결할 수 없습니다.' })); return; }
    await route.fallback();
  });
  await w.getByRole('button', { name: 'Task 생성', exact: true }).click();
  const modal = page.getByRole('alertdialog').filter({ hasText: 'VERSION_CONFLICT' });
  await expect(modal).toBeVisible();
  failReload = true;
  await modal.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' }).click();
  await expect(modal).toContainText('503 UNAVAILABLE');
  await expect(modal).toBeVisible();
  await expect(page.locator('.notice')).toHaveCount(0);
  failReload = false;
  await modal.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.notice')).toContainText('최신 내용을 불러왔습니다');
  await expect(w).toContainText('TASK-0013을(를) 이미 만들었습니다');
});
