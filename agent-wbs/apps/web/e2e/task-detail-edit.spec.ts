/**
 * Task 상세 편집 — 개요 편집(UAT-TASK-02), 저장 실패 시 입력 유지(UAT-STATE-06), 동시 수정 충돌(UAT-STATE-08),
 * 편집 중 이동 보호(UAT-STATE-09). 시나리오 1의 「읽기/편집 전환」.
 */
import { expect, test, type Page } from '@playwright/test';
import { errorBody, fakeApi, json, type FakeApi } from './support/fake-api.ts';
import { mountTasks, newStore, type TaskStore } from './support/task-api.ts';

async function open(page: Page, url = '/wbs/TASK-0004'): Promise<{ api: FakeApi; s: TaskStore }> {
  const api = await fakeApi(page);
  const s = mountTasks(api, newStore());
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  return { api, s };
}
const body = (page: Page) => page.locator('.dt-body');

test('UAT-TASK-02 개요 편집: 필수 검사·같은 Agent 경고, 취소는 원본 보존, 저장은 두 요청과 이력·명세 공유', async ({ page }) => {
  const { api } = await open(page);
  await page.getByRole('button', { name: '개요 편집' }).click();
  await page.locator('#ov-title').fill('');
  await page.getByLabel('작업 목적').fill(' ');
  await expect(page.getByText('제목을 입력하세요.')).toBeVisible();
  await expect(page.getByText('작업 목적을 입력하세요.')).toBeVisible();
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
  await page.getByLabel('검증 Agent').selectOption('Claude');
  await expect(page.getByText('담당 Agent와 검증 Agent가 같습니다. 교차 검증 원칙에 맞지 않습니다.')).toBeVisible();

  // 취소: 원본 보존, 요청 없음
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Drizzle Schema 설계' })).toBeVisible();
  expect(api.calls().filter((c) => c.startsWith('PATCH'))).toEqual([]);

  // 저장: 제목(PATCH /tasks) + 제외 범위(PATCH /spec). 명세 「구현하지 않을 내용」과 같은 데이터
  await page.getByRole('button', { name: '개요 편집' }).click();
  await page.locator('#ov-title').fill('Drizzle Schema 설계 v2');
  await page.getByLabel('제외 범위').fill('Phase C 테이블\nApproval 테이블');
  await expect(page.locator('.form-acts')).toContainText('변경 2개 — 제목, 제외 범위');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '개요 2개 항목을 저장했습니다.' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Drizzle Schema 설계 v2' })).toBeVisible();
  const patch = api.requests('PATCH /api/tasks/TASK-0004')[0]?.postDataJSON() as { title: string; updatedAt: string };
  expect(patch.title).toBe('Drizzle Schema 설계 v2');
  const spec = api.requests('PATCH /api/tasks/TASK-0004/spec')[0]?.postDataJSON() as { updatedAt: string; overview: { out: string[] } };
  expect(spec.overview.out).toEqual(['Phase C 테이블', 'Approval 테이블']);
  expect(spec.updatedAt).not.toBe(patch.updatedAt); // 두 번째 요청은 첫 저장이 올린 버전으로 보낸다
  await page.getByRole('tab', { name: /^작업 명세/ }).click();
  await expect(page.getByRole('region', { name: '제외 범위' })).toContainText('Approval 테이블');
  await page.getByRole('tab', { name: /^이력/ }).click();
  await expect(page.getByRole('table', { name: '이력' })).toContainText('제목 변경Drizzle Schema 설계 → Drizzle Schema 설계 v2');
});

for (const failure of ['500', 'network'] as const) {
  test(`UAT-STATE-06 저장 ${failure}: 데이터 미반영·입력 유지·동작/코드/시각/조치 표시, 다시 시도 성공 때만 편집이 닫힌다`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
    const { api, s } = await open(page);
    const real = api;
    let fail = true;
    const original = s.tasks.get('TASK-0004').title as string;
    real.on('PATCH /api/tasks/TASK-0004', async (route, req) => {
      if (fail) return failure === '500' ? json(route, 500, errorBody('INTERNAL', { message: '서버에서 요청을 처리하지 못했습니다.', fix: '잠시 후 다시 시도하세요.' })) : route.abort('connectionrefused');
      const b = req.postDataJSON() as { title: string };
      s.tasks.get('TASK-0004').title = b.title;
      s.version.set('TASK-0004', '2026-11-05T11:30:00.000000Z');
      const { detail } = await import('./support/task-api.ts');
      return json(route, 200, { task: detail(s, 'TASK-0004'), changes: [] });
    });
    await page.getByRole('button', { name: '개요 편집' }).click();
    await page.locator('#ov-title').fill('새 제목');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    const bar = page.getByRole('alert');
    await expect(bar).toContainText(failure === '500' ? '500 INTERNAL' : 'NETWORK_ERROR');
    await expect(bar).toContainText('입력한 내용은 화면에 그대로 남아 있습니다.');
    await expect(bar).toContainText('대상: TASK-0004 개요 저장 · 2026-11-05 20:00');
    await expect(page.locator('#ov-title')).toHaveValue('새 제목');
    expect(s.tasks.get('TASK-0004').title).toBe(original);
    fail = false;
    await bar.getByRole('button', { name: '다시 시도' }).click();
    await expect(page.getByRole('heading', { level: 2, name: '새 제목' })).toBeVisible();
    await expect(page.locator('#ov-title')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('UAT-STATE-08 같은 Task 두 세션: 낡은 버전 저장은 409, 이 Task의 최신 변경·내 변경 표시, 버림/재적용이 각 선택대로', async ({ page }) => {
  const { api, s } = await open(page);
  await page.getByRole('button', { name: '개요 편집' }).click();
  await page.locator('#ov-title').fill('내 제목');
  // 다른 세션이 먼저 저장
  s.tasks.get('TASK-0004').title = '다른 세션 제목';
  s.version.set('TASK-0004', '2026-11-05T10:59:00.000000Z');
  s.hist.push({ id: 'H-OTHER', at: '2026-11-05 19:59', actor: '팀장(다른 창)', task: 'TASK-0004', kind: '개요 수정', text: '제목 변경', before: 'Drizzle Schema 설계', after: '다른 세션 제목' });
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const modal = page.getByRole('alertdialog');
  await expect(modal).toContainText('409 VERSION_CONFLICT');
  await expect(modal).toContainText('TASK-0004');
  await expect(modal).toContainText('다른 세션 제목');
  await expect(modal).toContainText('제목: 내 제목');
  await expect(modal).not.toContainText('TASK-0007');

  // 최신 위에 다시 적용 → 최신 버전으로 내 변경 저장
  await modal.getByRole('button', { name: /다시 적용/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: '내 제목' })).toBeVisible();
  const reqs = api.requests('PATCH /api/tasks/TASK-0004');
  expect((reqs.at(-1)?.postDataJSON() as { updatedAt: string }).updatedAt).toBe('2026-11-05T10:59:00.000000Z');

  // 다시 충돌 → 최신 불러오기(내 변경 버림)
  await page.getByRole('button', { name: '개요 편집' }).click();
  await page.locator('#ov-title').fill('버려질 제목');
  s.tasks.get('TASK-0004').title = '또 다른 제목';
  s.version.set('TASK-0004', '2026-11-05T10:58:00.000000Z');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /최신 내용 불러오기/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: '또 다른 제목' })).toBeVisible();
  await expect(page.locator('#ov-title')).toHaveCount(0);
});

test('UAT-STATE-09 편집 중 이동: 탭·다른 Task·메뉴 이동은 확인을 묻고, 취소는 입력·화면 유지, 확인만 버리고 이동', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '개요 편집' }).click();
  await page.getByLabel('작업 배경').fill('바꾸는 중');
  const dialog = page.getByRole('alertdialog', { name: '편집 내용 버리기' });

  await page.getByRole('tab', { name: /^체크리스트/ }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page.getByLabel('작업 배경')).toHaveValue('바꾸는 중');
  await expect(page.getByRole('tab', { name: '개요' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: '다음 Task' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0004');
  await expect(page.getByLabel('작업 배경')).toHaveValue('바꾸는 중');

  await page.getByRole('link', { name: '대시보드' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0004');

  await page.getByRole('tab', { name: /^체크리스트/ }).click();
  await dialog.getByRole('button', { name: '저장하지 않고 이동' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0004?tab=checklist');
  await page.getByRole('tab', { name: '개요' }).click();
  await expect(body(page)).toContainText('Task CRUD API와 Dependency 검증이');
  await expect(page.getByLabel('작업 배경')).toHaveCount(0);
});

test('UAT-STATE-09 삭제 확인을 취소하면 원본을 보존한다(선행 관계)', async ({ page }) => {
  const { api } = await open(page, '/wbs/TASK-0004?tab=deps');
  await page.getByRole('button', { name: 'TASK-0003 선행 관계 삭제' }).click();
  const dialog = page.getByRole('alertdialog', { name: '선행 관계 삭제' });
  await expect(dialog).toContainText('TASK-0003 → TASK-0004 선행 관계를 삭제합니다.');
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page.getByRole('table', { name: '선행 Task' })).toContainText('TASK-0003');
  expect(api.calls().filter((c) => c.startsWith('DELETE'))).toEqual([]);
});
