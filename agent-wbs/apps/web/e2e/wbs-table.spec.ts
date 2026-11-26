/**
 * WBS 표·필터 9·정렬·접기·컬럼(UI-03·03A·03B).
 * UAT-WBS-01, UAT-WBS-02, UAT-EMPTY-10, UAT-STATE-02-UI.
 */
import { expect, test, type Page } from '@playwright/test';
import { hold } from './support/fake-api.ts';
import { wbsApi } from './support/wbs-api.ts';
import { PROJECT_ID, type TaskList } from './support/wbs-fixture.ts';

const table = (page: Page) => page.getByRole('table', { name: 'WBS Task 목록' });
/** 표에 보이는 Task ID 순서 */
const taskIds = async (page: Page) => {
  await expect(page.locator('.resbar')).toBeVisible();
  return table(page).locator('.trow.task .td.tcell > .tid').allTextContents();
};
const groupPaths = (page: Page) => table(page).locator('.trow.grp .wbsno').allTextContents();
const filter = (page: Page, label: string) => page.locator('.toolbar label.fsel').filter({ has: page.locator('.fsel-l', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }) }).locator('select');

// 가상 스크롤은 보이는 행만 그리므로, 12건 전체를 한 화면에 담도록 높이를 넉넉히 둔다(폭은 1920 그대로).
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1920, height: 2000 }); });

test('UAT-WBS-01 검색과 8개 선택 필터를 함께 적용하고, 매칭 Task의 상위 Phase·WP를 함께 보이며, 초기화는 검색도 지운다', async ({ page }) => {
  const api = await wbsApi(page);
  await page.goto('/wbs');
  await expect(page.locator('.resbar')).toHaveText('전체 12건');
  await expect.poll(() => taskIds(page)).toHaveLength(12);

  // 담당 Codex
  await filter(page, '담당 Agent').selectOption('Codex');
  await expect(page.locator('.resbar')).toHaveText('필터 결과 3건');
  await expect.poll(() => taskIds(page)).toEqual(['TASK-0003', 'TASK-0010', 'TASK-0012']);
  await expect.poll(() => groupPaths(page)).toEqual(['1', '1.2', '3', '3.1', '3.2']);
  await expect(page.locator('.toolbar label.fsel.on')).toHaveCount(1);

  // 8개 필터 조합: 유형 설계 + 영역 Architecture + 상태 승인 대기 + 우선순위 높음 + Phase 3 + 차단 실행 가능 + 검증 미실시
  await filter(page, '작업 유형').selectOption('Design');
  await filter(page, '기술 영역').selectOption('Architecture');
  await filter(page, '상태').selectOption('approval');
  await filter(page, '우선순위').selectOption('1');
  await filter(page, 'Phase').selectOption('PH-3');
  await filter(page, '선행 차단').selectOption('n');
  await filter(page, '검증 상태').selectOption('none');
  await expect(page.locator('.resbar')).toHaveText('필터 결과 1건');
  await expect.poll(() => taskIds(page)).toEqual(['TASK-0010']);
  await expect.poll(() => groupPaths(page)).toEqual(['3', '3.1']);
  // 상태 한 가지는 서버 조회 조건으로 보낸다(계약의 status).
  expect(api.calls().some((c) => c.startsWith(`GET /api/projects/${PROJECT_ID}/tasks?status=approval`))).toBe(true);

  // 검색(ID·제목)
  await page.getByRole('button', { name: '필터 초기화' }).first().click();
  await page.getByPlaceholder('Task ID 또는 제목 검색').fill('task-000');
  await expect(page.locator('.resbar')).toHaveText('필터 결과 9건');
  await page.getByPlaceholder('Task ID 또는 제목 검색').fill('Drizzle');
  await expect(page.locator('.resbar')).toHaveText('필터 결과 1건');
  await expect.poll(() => groupPaths(page)).toEqual(['1', '1.2']);
  await filter(page, '담당 Agent').selectOption('Claude');

  // 초기화는 검색어와 필터를 모두 지운다.
  const reset = page.locator('.toolbar').getByRole('button', { name: '필터 초기화' });
  await reset.click();
  await expect(page.getByPlaceholder('Task ID 또는 제목 검색')).toHaveValue('');
  await expect(filter(page, '담당 Agent')).toHaveValue('');
  await expect(page.locator('.resbar')).toHaveText('전체 12건');
  await expect(reset).toBeDisabled();
});

test('UAT-EMPTY-10 조건에 맞는 Task 없음과 기록 없음을 구분하고, 초기화로 행을 되살리며 새 Task 생성 진입을 둔다', async ({ page }) => {
  await wbsApi(page);
  await page.goto('/wbs');
  await filter(page, '담당 Agent').selectOption('Codex');
  await filter(page, '기술 영역').selectOption('FE');
  const filtered = page.locator('[data-empty="filtered"]');
  await expect(filtered).toContainText('조건에 맞는 Task가 없습니다.');
  await expect(page.locator('.resbar')).toHaveText('필터 결과 0건');
  await filtered.getByRole('button', { name: '필터 초기화' }).click();
  await expect(page.locator('.resbar')).toHaveText('전체 12건');
  await expect.poll(() => taskIds(page)).toHaveLength(12);

  // Task가 하나도 없는 목록
  const none: TaskList = { nodes: [], tasks: [] };
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await wbsApi(page, { list: none });
  await page.goto('/wbs');
  const empty = page.locator('[data-empty="none"]');
  await expect(empty).toContainText('아직 Task가 없습니다.');
  await expect(page.locator('[data-empty="filtered"]')).toHaveCount(0);
  await empty.getByRole('button', { name: 'Task 생성' }).click();
  await expect(page.getByRole('dialog', { name: 'Task 생성' })).toBeVisible();
});

test('UAT-WBS-02 정렬은 WP 안에서만, 캐럿은 선택을 바꾸지 않고, 모두 접기/펼치기·컬럼 설정(기본 8 + 최근 변경)', async ({ page }) => {
  await wbsApi(page);
  await page.goto('/wbs');
  // 정렬: 우선순위 — WP 2.2 안에서만 바뀌고 WP 순서는 그대로
  await expect(page.locator('.resbar')).toHaveText('전체 12건');
  await filter(page, '정렬 (Work Package 내)').selectOption('status');
  await expect(table(page).locator('.trow.task').nth(6).locator('.td.tcell > .tid')).toHaveText('TASK-0009');
  await expect.poll(async () => (await taskIds(page)).slice(6, 9)).toEqual(['TASK-0009', 'TASK-0008', 'TASK-0007']);
  await expect.poll(() => groupPaths(page)).toEqual(['1', '1.1', '1.2', '2', '2.1', '2.2', '3', '3.1', '3.2']);

  // 캐럿: WP 1.1 접기 → 그 Task만 숨고, 주소(선택)는 그대로
  await page.getByRole('button', { name: '접기: 개발 환경' }).click();
  await expect(page).toHaveURL('/wbs');
  await expect.poll(() => taskIds(page)).not.toContain('TASK-0001');
  await expect(page.locator('.resbar')).toHaveText('전체 12건');
  await page.getByRole('button', { name: '펼치기: 개발 환경' }).click();
  await expect.poll(() => taskIds(page)).toContain('TASK-0001');

  // 모두 접기 → Phase 행 3개만
  await page.getByRole('button', { name: '모두 접기' }).click();
  await expect.poll(() => groupPaths(page)).toEqual(['1', '2', '3']);
  await expect.poll(() => taskIds(page)).toEqual([]);
  await page.getByRole('button', { name: '모두 펼치기' }).click();
  await expect.poll(() => taskIds(page)).toHaveLength(12);

  // 컬럼: 기본 8개, WBS·Task는 항상
  const heads = () => table(page).locator('.thead .th').allTextContents();
  await expect.poll(heads).toEqual(['WBS', 'Task', '유형 · 영역', '담당', '상태 · 검증', '우선순위', '선행 Task', '진행 · 체크리스트', '완료 예상 · 기준 대비', '예상 실행']);
  await page.getByRole('button', { name: '컬럼' }).click();
  const menu = page.getByRole('group', { name: '표시할 컬럼' });
  await expect(menu).toContainText('표시할 컬럼 · WBS 번호와 Task 제목은 항상 표시');
  await expect(menu.getByRole('checkbox')).toHaveCount(9);
  await menu.getByLabel('최근 변경').check();
  await menu.getByLabel('담당 Agent').uncheck();
  await expect.poll(heads).toEqual(['WBS', 'Task', '유형 · 영역', '상태 · 검증', '우선순위', '선행 Task', '진행 · 체크리스트', '완료 예상 · 기준 대비', '예상 실행', '최근 변경']);
  await expect(table(page).locator('.trow.task').first().locator('.upd')).toHaveText('10-28 07:20');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('UAT-STATE-02-UI 필터 응답이 늦으면 이전 목록과 상단 진행 막대를 유지하고, 응답 뒤 새 조건으로 바꾼다', async ({ page }) => {
  const api = await wbsApi(page);
  await page.goto('/wbs');
  await expect(page.locator('.resbar')).toHaveText('전체 12건');
  await expect.poll(() => taskIds(page)).toHaveLength(12);
  const slow = hold(api.serveList);
  api.onList(slow.handler);
  await filter(page, '상태').selectOption('done');
  await expect(page.locator('.topbar')).toBeVisible();
  // 응답 전: 이전 목록(12건) 그대로
  await page.waitForTimeout(400);
  await expect.poll(() => taskIds(page)).toHaveLength(12);
  await expect(page.locator('.skp')).toHaveCount(0);
  slow.release();
  await expect(page.locator('.resbar')).toHaveText('필터 결과 3건');
  await expect.poll(() => taskIds(page)).toEqual(['TASK-0001', 'TASK-0002', 'TASK-0003']);
  await expect(page.locator('.topbar')).toHaveCount(0);
});

test('Task 행 표시: 차단 선행·충족·일정 문구·진행률(원본 taskRow)', async ({ page }) => {
  await wbsApi(page);
  await page.goto('/wbs');
  const row = (id: string) => table(page).locator('.trow.task').filter({ has: page.locator('.td.tcell > .tid', { hasText: id }) });
  await expect(row('TASK-0006')).toContainText('차단 · TASK-0005');
  await expect(row('TASK-0008')).toContainText('차단 · TASK-0005 외 1');
  await expect(row('TASK-0004')).toContainText('충족 2건');
  await expect(row('TASK-0001')).toContainText('없음');
  await expect(row('TASK-0001')).toContainText('10-28 완료기준 내 완료실제');
  await expect(row('TASK-0004')).toContainText('11-05진행 · 기준 일정범위 11-05 ~ 11-06');
  await expect(row('TASK-0004')).toContainText('검증 검증 중');
  await expect(page.locator('.page-sub').first()).toHaveText('12 Tasks · 완료 3 · 차단 4 · Task ID는 고정, WBS 번호는 위치에 따라 자동 계산');
  await expect(page.locator('.sch-sub')).toHaveText('완료 예상 11-06 (범위 11-06 ~ 11-10) · 기준 v1 11-06 대비 0일 · 진행률 30% · 관측 가동률 69% · 동시 실행 한도 10 (하위 Agent 포함)');
});
