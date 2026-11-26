/**
 * M3-07 이력(UI-10) — UAT-HISTORY-01, UAT-EMPTY-04(이력 부분), D-28.
 */
import { expect, test, type Page } from '@playwright/test';
import { fakeApi, type FakeApi } from './support/fake-api.ts';
import { installM307, m307Data, type M307Data } from './support/m307-data.ts';

async function open(page: Page, path = '/history', change: (d: M307Data) => void = () => undefined): Promise<{ api: FakeApi; data: M307Data }> {
  const api = await fakeApi(page);
  const data = m307Data();
  change(data);
  installM307(api, data);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: '이력' })).toBeVisible();
  return { api, data };
}
const table = (page: Page) => page.getByRole('table', { name: '이력' });
const rows = (page: Page) => table(page).locator('.gtr:not(.h):not([data-empty])');
const count = (page: Page) => page.locator('.resbar');

test('UAT-HISTORY-01: 최신순, 전후 값·주체·Task 이동', async ({ page }) => {
  await open(page);
  await expect(count(page)).toHaveText('이력 19건');
  await expect(rows(page).first().getByRole('cell')).toHaveText([
    '2026-11-03 19:58', 'Runner', '실행', 'TASK-0005', 'ATT-0005-1 개발 실행 시작 (Claude) — Runner 재부팅 후 재연결', '실행 대기 → 실행 중',
  ]);
  await expect(rows(page).nth(2).getByRole('cell').nth(5)).toHaveText('— → 승인 대기');
  await expect(rows(page).nth(3).getByRole('cell').nth(5)).toHaveText('');
  await rows(page).nth(8).getByRole('link', { name: 'TASK-0007' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0007?tab=hist');
});

test('UAT-HISTORY-01: 기간은 서버 필터(from·to 요청), 유형·주체·Task·검색은 함께 적용되고 주소에 남는다', async ({ page }) => {
  const { api } = await open(page);
  await page.getByLabel('기간 시작').fill('2026-11-01');
  await page.getByLabel('기간 끝').fill('2026-11-02');
  await expect(count(page)).toHaveText('이력 6건');
  expect(api.calls().some((c) => c.startsWith('GET /api/history?') && c.includes('from=2026-11-01') && c.includes('to=2026-11-02'))).toBe(true);
  await expect(rows(page).first()).toContainText('2026-11-02 17:12');
  await expect(rows(page).last()).toContainText('2026-11-01 10:02');
  await page.getByRole('group', { name: '유형' }).getByRole('button', { name: '실행' }).click();
  await expect(count(page)).toHaveText('이력 2건 (전체 6건 중)');
  await page.getByRole('group', { name: '주체' }).getByRole('button', { name: 'Runner' }).click();
  await page.getByLabel('Task ID').fill('0007');
  await page.getByRole('searchbox', { name: '변경 내용 검색' }).fill('QA 요청');
  await expect(count(page)).toHaveText('이력 1건 (전체 6건 중)');
  await expect(rows(page)).toHaveCount(1);
  await expect(page).toHaveURL(/kind=%EC%8B%A4%ED%96%89/);
  // 새로고침해도 같은 조건
  await page.reload();
  await expect(count(page)).toHaveText('이력 1건 (전체 6건 중)');
  await expect(page.getByLabel('기간 시작')).toHaveValue('2026-11-01');
});

test('UAT-HISTORY-01 / UAT-EMPTY-04 b: 조건 불일치 안내와 필터 초기화로 원래 행 복원', async ({ page }) => {
  await open(page);
  await page.getByLabel('Task ID').fill('TASK-9999');
  await expect(table(page).locator('[data-empty="filtered"]')).toContainText('조건에 맞는 이력이 없습니다. 필터를 바꿔 보세요.');
  await expect(table(page).locator('[data-empty="none"]')).toHaveCount(0);
  await expect(count(page)).toHaveText('이력 0건 (전체 19건 중)');
  await table(page).getByRole('button', { name: '필터 초기화' }).click();
  await expect(rows(page)).toHaveCount(19);
  await expect(page.getByLabel('Task ID')).toHaveValue('');
  await expect(page.locator('.toolbar').getByRole('button', { name: '필터 초기화' })).toBeDisabled();
  // 기간만으로 0건이어도 「조건 불일치」다(기록이 없는 것이 아님).
  await page.getByLabel('기간 시작').fill('2027-01-01');
  await expect(table(page).locator('[data-empty="filtered"]')).toBeVisible();
});

test('UAT-EMPTY-04 a: 이력이 전혀 없으면 기록 없음과 생기는 조건 안내', async ({ page }) => {
  await open(page, '/history', (d) => { d.history = []; });
  await expect(table(page).locator('[data-empty="none"]')).toContainText('아직 이력이 없습니다. Task를 만들거나 상태 · 실행 · 검증 · 승인이 바뀌면 여기에 최신순으로 기록됩니다.');
  await expect(count(page)).toHaveText('이력 0건');
});

test('UAT-HISTORY-01: 끝 날짜가 시작보다 빠르면 요청하지 않고 안내', async ({ page }) => {
  const { api } = await open(page);
  await page.getByLabel('기간 시작').fill('2026-11-05');
  await page.getByLabel('기간 끝').fill('2026-11-01');
  await expect(page.getByRole('alert').filter({ hasText: '끝 날짜가 시작 날짜보다 빠릅니다.' })).toBeVisible();
  expect(api.calls().some((c) => c.includes('to=2026-11-01'))).toBe(false);
});

test('UAT-HISTORY-01: 쪽 나눔 — 250건도 모두 읽어 건수가 맞다', async ({ page }) => {
  await open(page, '/history', (d) => {
    const base = d.history[0];
    if (!base) return;
    for (let i = 0; i < 231; i++) d.history.push({ ...base, id: `extra-${String(i).padStart(3, '0')}`, at: '2026-10-01T00:00:00.000Z' });
  });
  await expect(count(page)).toHaveText('이력 250건');
  await expect(rows(page)).toHaveCount(250);
});

test('D-28 이력: 1280·1920 가로 스크롤 없음, 1280 미만은 표 상자만 스크롤', async ({ page }) => {
  await open(page);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const box = page.getByRole('region', { name: '이력 표' });
  for (const width of [1920, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await overflow()).toBeLessThanOrEqual(0);
    expect(await box.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  }
  await page.setViewportSize({ width: 1024, height: 800 });
  expect(await overflow()).toBeLessThanOrEqual(0);
  expect(await box.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});
