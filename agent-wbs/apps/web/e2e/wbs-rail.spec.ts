/**
 * 시나리오 27(가이드 §12) — WBS 목록 ↔ 상세 전환(UI-03D), 없는 Task 링크(UAT-WBS-05 앞부분).
 * 처음에는 전체 표(레일 없음) → Task 클릭 시 260px 레일 + 상세 → 「↓ 다음」·레일 클릭 → 필터(담당 Codex) 뒤 「목록 밖」 → 「펼치기」로 표 복귀.
 */
import { expect, test, type Page } from '@playwright/test';
import { wbsApi } from './support/wbs-api.ts';
import { bulkList } from './support/wbs-fixture.ts';

const rail = (page: Page) => page.getByRole('complementary', { name: 'Task 목록' });
const detail = (page: Page) => page.getByRole('region', { name: 'Task 상세' });
const table = (page: Page) => page.getByRole('table', { name: 'WBS Task 목록' });

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1920, height: 1080 }); });

test('시나리오 27: 표 → 레일+상세 → 다음·레일 이동 → 필터 뒤 목록 밖 → 펼치기로 표 복귀(필터·정렬 유지)', async ({ page }) => {
  await wbsApi(page);
  await page.goto('/wbs');
  // 1. 처음에는 전체 표, 레일 없음
  await expect(table(page)).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
  await expect(detail(page)).toHaveCount(0);

  // 2. Task 클릭 → 260px 레일 + 상세, 주소 /wbs/TASK-0004
  await table(page).locator('.trow.task').filter({ hasText: 'TASK-0004' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0004');
  await expect(rail(page)).toBeVisible();
  await expect(table(page)).toBeHidden();
  // 0.24초 전환 효과(railIn) 뒤 260px
  await expect.poll(async () => Math.round((await rail(page).boundingBox())?.width ?? 0)).toBe(260);
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Drizzle Schema 설계');
  await expect(detail(page)).toContainText('4 / 12');
  await expect(rail(page).locator('[aria-current="true"]')).toContainText('TASK-0004');
  await expect(rail(page).locator('.wr-wp')).toHaveText(['1.1 개발 환경', '1.2 데이터 모델', '2.1 Task API', '2.2 WBS UI', '3.1 Planning · Gate', '3.2 Runner 연동']);

  // 3. ↓ 다음 · 레일 클릭
  await detail(page).getByRole('button', { name: '다음 Task' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0005');
  await expect(detail(page)).toContainText('5 / 12');
  await rail(page).getByRole('button', { name: /TASK-0010/ }).click();
  await expect(page).toHaveURL('/wbs/TASK-0010');
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Planning Workflow');
  // 키보드: ↑(이전), J(다음)
  await page.keyboard.press('ArrowUp');
  await expect(page).toHaveURL('/wbs/TASK-0009');
  await page.keyboard.press('j');
  await expect(page).toHaveURL('/wbs/TASK-0010');
  await page.keyboard.press('ArrowDown');
  await expect(page).toHaveURL('/wbs/TASK-0011');
  // 이전·다음 이동은 기록을 쌓지 않는다(뒤로 가기 한 번이면 표).
  await page.goBack();
  await expect(page).toHaveURL('/wbs');
  await page.goForward();
  await expect(page).toHaveURL('/wbs/TASK-0011');

  // 4. 목록에서 담당 Codex 필터 → 레일은 Codex Task 3개
  await rail(page).getByRole('button', { name: '펼치기' }).click();
  await expect(page).toHaveURL('/wbs');
  await page.locator('.toolbar label.fsel').filter({ hasText: '담당 Agent' }).locator('select').selectOption('Codex');
  await page.locator('.toolbar label.fsel').filter({ hasText: '정렬 (Work Package 내)' }).locator('select').selectOption('priority');
  await expect(page.locator('.resbar')).toHaveText('필터 결과 3건');
  // 필터 밖 Task(TASK-0011, Claude)를 다시 열면(뒤로 가기 = 이전 링크) 「목록 밖」
  await page.goBack();
  await expect(page).toHaveURL('/wbs/TASK-0011');
  await expect(rail(page)).toContainText('목록 필터 1개 적용 중 — 「펼치기」로 목록에서 변경');
  await expect(rail(page).locator('.side-i')).toHaveCount(3);
  await expect(detail(page)).toContainText('목록 밖 (필터에 맞지 않음)');
  await expect(detail(page).getByRole('button', { name: '이전 Task' })).toBeDisabled();
  await expect(detail(page).getByRole('button', { name: '다음 Task' })).toBeDisabled();

  // 5. 펼치기(Esc) → 표 복귀, 필터·정렬 유지
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL('/wbs');
  await expect(rail(page)).toHaveCount(0);
  await expect(page.locator('.toolbar label.fsel').filter({ hasText: '담당 Agent' }).locator('select')).toHaveValue('Codex');
  await table(page).getByRole('button', { name: 'Task 데이터 모델 설계' }).click();
  await expect(detail(page)).toContainText('1 / 3');
  await rail(page).getByRole('button', { name: '펼치기' }).click();
  await expect(page.locator('.toolbar label.fsel').filter({ hasText: '정렬 (Work Package 내)' }).locator('select')).toHaveValue('priority');
  await expect(page.locator('.resbar')).toHaveText('필터 결과 3건');
});

test('펼치기로 돌아오면 표의 스크롤 위치를 유지한다', async ({ page }) => {
  await wbsApi(page, { list: bulkList(200) });
  await page.goto('/wbs');
  const box = table(page);
  await box.evaluate((el) => { el.scrollTop = 3000; });
  await expect(box.locator('.trow.task').first()).toBeVisible();
  // 스크롤 뒤 다시 그려진 행 중 화면 가운데 행을 고른다(클릭이 스크롤을 바꾸지 않게).
  await expect.poll(() => box.locator('.trow').first().getAttribute('data-index')).not.toBe('0');
  /** 표 가운데에 보이는 Task ID — 사용자가 보는 위치 */
  const centerKey = () => box.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + 400, r.top + r.height / 2)?.closest('.trow.task')?.querySelector('.td.tcell > .tid')?.textContent ?? '';
  });
  await expect.poll(centerKey).toMatch(/^TASK-/);
  const key = await centerKey();
  expect(key).toMatch(/^TASK-/);
  await box.locator('.trow.task').filter({ has: page.locator('.td.tcell > .tid', { hasText: key }) }).click();
  await expect(page).toHaveURL(`/wbs/${key}`);
  await rail(page).getByRole('button', { name: '펼치기' }).click();
  await expect(box).toBeVisible();
  // 전환 효과(0.24초) 뒤 같은 Task가 같은 자리(가운데)에 보인다.
  await expect.poll(centerKey).toBe(key);
});

test('UAT-WBS-05 없는 Task 링크: 404 TASK_NOT_FOUND 안내와 닫기, 메뉴·표는 그대로', async ({ page }) => {
  await wbsApi(page);
  await page.goto('/wbs/TASK-9999');
  const banner = page.getByRole('alert').filter({ hasText: 'TASK-9999를 찾을 수 없습니다' });
  await expect(banner).toContainText('404 TASK_NOT_FOUND');
  await expect(banner).toContainText('Change Proposal로 취소되었거나, 프로젝트 초기화로 삭제된 Task일 수 있습니다.');
  await expect(page.getByRole('heading', { level: 1, name: 'WBS' })).toBeVisible();
  await expect(table(page)).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '주 메뉴' }).locator('[aria-current="page"]')).toHaveText('WBS');
  await banner.getByRole('button', { name: '닫기' }).click();
  await expect(page).toHaveURL('/wbs');
  await expect(banner).toHaveCount(0);
});
