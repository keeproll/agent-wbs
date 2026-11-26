/**
 * M3-07 검증 결과(UI-07·07-01·07-01A) — UAT-VERIFY-01, UAT-TASK-11(검증 상세 키보드), UAT-EMPTY-04(검증 부분), D-28·390px.
 */
import { expect, test, type Page } from '@playwright/test';
import { fakeApi, json, type FakeApi } from './support/fake-api.ts';
import { attempts, installM307, kst, m307Data, type M307Data } from './support/m307-data.ts';

async function open(page: Page, path = '/verify', change: (d: M307Data) => void = () => undefined): Promise<{ api: FakeApi; data: M307Data }> {
  const api = await fakeApi(page);
  const data = m307Data();
  change(data);
  installM307(api, data);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: '검증' })).toBeVisible();
  return { api, data };
}
const tabs = (page: Page) => page.getByRole('group', { name: '검증 화면 탭' }).getByRole('button');
const table = (page: Page) => page.getByRole('table', { name: '검증 결과' });
const dataRows = (page: Page) => table(page).locator('[data-vrow]');

test('UAT-VERIFY-01 b: 탭 건수가 서버 데이터와 같다(쪽 나눔 끝까지)', async ({ page }) => {
  // 서버가 한 쪽에 200건씩 주므로 250건을 만들어 두 쪽 모두 읽는지 본다.
  await open(page, '/verify', (d) => {
    for (let i = 0; i < 248; i++) {
      d.verifications.push({ ...d.verifications[1], id: `vx-${String(i)}`, at: kst('2026-10-20 09:00') } as never);
    }
  });
  await expect(tabs(page)).toHaveText(['검증 결과 250', 'Evidence 5', 'Completion Gate 9 미통과']);
  await expect(dataRows(page)).toHaveCount(250);
});

test('UAT-VERIFY-01 a: 목록 — 최신순, 표시 번호·실행 시도·Agent·결함·Evidence 수', async ({ page }) => {
  await open(page);
  await expect(tabs(page)).toHaveText(['검증 결과 2', 'Evidence 5', 'Completion Gate 9 미통과']);
  await expect(dataRows(page).nth(0).getByRole('cell')).toHaveText(['V-0007-1', 'TASK-0007', 'WBS Tree UI', 'ATT-0007-2', 'FAIL', 'Codex', '11-01 13:35', '2', '3']);
  await expect(dataRows(page).nth(1).getByRole('cell')).toHaveText(['V-0001-1', 'TASK-0001', 'Monorepo 구성', 'ATT-0001-2', 'PASS', 'Codex', '10-28 16:20', '0', '2']);
});

test('UAT-VERIFY-01 a / UAT-EMPTY-04 b: 판정·Agent 필터, 무매칭은 조건 불일치 안내, 초기화로 원래 행 복원', async ({ page }) => {
  await open(page);
  const judge = page.getByRole('group', { name: '판정' });
  const agent = page.getByRole('group', { name: '검증 Agent' });
  await judge.getByRole('button', { name: 'FAIL' }).click();
  await expect(page).toHaveURL('/verify?result=FAIL');
  await expect(dataRows(page)).toHaveCount(1);
  await judge.getByRole('button', { name: '전체' }).click();
  await agent.getByRole('button', { name: 'Claude' }).click();
  await expect(dataRows(page)).toHaveCount(0);
  await expect(table(page).locator('[data-empty="filtered"]')).toContainText('조건에 맞는 검증 결과가 없습니다. 필터를 바꿔 보세요.');
  await expect(table(page).locator('[data-empty="none"]')).toHaveCount(0);
  await table(page).getByRole('button', { name: '필터 초기화' }).click();
  await expect(dataRows(page)).toHaveCount(2);
  await expect(page).toHaveURL('/verify');
});

test('UAT-EMPTY-04 a / UAT-VERIFY-01 a: 기록 없음은 별도 안내 + 결과 등록은 Runner 보고(작업 실행)로 연결', async ({ page }) => {
  await open(page, '/verify', (d) => { d.verifications = []; d.evidence = []; });
  await expect(tabs(page)).toHaveText(['검증 결과 0', 'Evidence 0', 'Completion Gate 9 미통과']);
  const none = table(page).locator('[data-empty="none"]');
  await expect(none).toContainText('아직 검증 결과가 없습니다. QA · 재검증이 끝나면 여기에 표시됩니다.');
  await expect(none.getByRole('link', { name: '작업 실행 열기' })).toHaveAttribute('href', '/exec');
  await tabs(page).nth(1).click();
  await expect(page.getByText(/^Evidence가 없습니다\. Runner가/)).toBeVisible();
});

test('UAT-VERIFY-01 a: 행 선택 → 레일+상세, 이전·다음, 펼치기, Task·실행 시도 이동', async ({ page }) => {
  await open(page);
  await dataRows(page).nth(0).click();
  await expect(page).toHaveURL('/verify?sel=v-0007-1');
  const detail = page.getByRole('region', { name: '검증 결과 V-0007-1 상세' });
  await expect(detail).toContainText('1 / 2');
  await expect(detail).toContainText('pnpm --filter web test -- tree');
  await expect(detail).toContainText('필터 적용 시 상위 Phase 행이 사라짐 (차단)');
  await expect(page.getByRole('complementary', { name: '검증 결과 목록' }).locator('.side-i.on')).toContainText('V-0007-1');
  await detail.getByRole('button', { name: '↓ 다음' }).click();
  await expect(page).toHaveURL('/verify?sel=v-0001-1');
  await expect(page.getByRole('region', { name: '검증 결과 V-0001-1 상세' })).toContainText('2 / 2');
  await expect(page.getByRole('button', { name: '↓ 다음' })).toBeDisabled();
  await page.getByRole('button', { name: '↑ 이전' }).click();
  await expect(page).toHaveURL('/verify?sel=v-0007-1');
  await detail.getByRole('button', { name: '실행 ATT-0007-2' }).click();
  await expect(page).toHaveURL('/exec?task=TASK-0007&attempt=att-0007-2');
  await page.goBack();
  await page.locator('.pane-h').getByRole('button', { name: 'TASK-0007 WBS Tree UI' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0007?tab=verif');
  await page.goBack();
  await page.getByRole('button', { name: '펼치기', exact: true }).click();
  await expect(page).toHaveURL('/verify');
  await expect(dataRows(page)).toHaveCount(2);
});

test('UAT-VERIFY-01 a: 필터 밖 선택은 「목록 밖」이고 이전·다음이 없다. 없는 id는 404 안내', async ({ page }) => {
  await open(page, '/verify?result=FAIL&sel=v-0001-1');
  const detail = page.getByRole('region', { name: '검증 결과 V-0001-1 상세' });
  await expect(detail).toContainText('목록 밖 (필터에 맞지 않음)');
  await expect(detail.getByRole('button', { name: '↑ 이전' })).toBeDisabled();
  await expect(detail.getByRole('button', { name: '↓ 다음' })).toBeDisabled();
  await page.goto('/verify?sel=nope');
  await expect(page.getByRole('alert')).toContainText('검증 결과를 찾을 수 없습니다 (404)');
  await page.getByRole('button', { name: '목록으로' }).click();
  await expect(page).toHaveURL('/verify');
});

test('UAT-TASK-11: 목록 ↑↓·Enter로 열고, 상세 J/K·↑↓로 이동, Esc로 펼치기. 입력 중에는 동작 안 함', async ({ page }) => {
  await open(page);
  await dataRows(page).nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(dataRows(page).nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  // 키마다 상세가 바뀐 것을 확인한 뒤 다음 키를 누른다(사람이 화면을 보고 누르는 속도).
  const shown = (key: string) => expect(page.getByRole('region', { name: `검증 결과 ${key} 상세` })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/verify?sel=v-0007-1');
  await shown('V-0007-1');
  await page.keyboard.press('j');
  await expect(page).toHaveURL('/verify?sel=v-0001-1');
  await shown('V-0001-1');
  await page.keyboard.press('k');
  await expect(page).toHaveURL('/verify?sel=v-0007-1');
  await shown('V-0007-1');
  await page.keyboard.press('ArrowDown');
  await expect(page).toHaveURL('/verify?sel=v-0001-1');
  // 입력 칸에서는 j·Esc가 탐색하지 않는다(초안 보호).
  await page.goto('/verify?sel=v-0007-1');
  await expect(page.getByRole('region', { name: '검증 결과 V-0007-1 상세' })).toBeVisible();
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.setAttribute('aria-label', '시험 입력');
    document.querySelector('.mainc .card')?.appendChild(input);
  });
  await page.getByLabel('시험 입력').fill('jjj');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL('/verify?sel=v-0007-1');
  await page.getByLabel('시험 입력').blur();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL('/verify');
});

test('D-28 검증: 1280·1920 가로 스크롤 없음, 1280 미만은 표 상자만 스크롤, 390px 알림 링크로 상세 열람', async ({ page }) => {
  await open(page);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  for (const width of [1920, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await overflow()).toBeLessThanOrEqual(0);
    expect(await page.getByRole('region', { name: '검증 결과 표' }).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  }
  await page.setViewportSize({ width: 1100, height: 800 });
  expect(await overflow()).toBeLessThanOrEqual(0);
  expect(await page.getByRole('region', { name: '검증 결과 표' }).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/verify?sel=v-0007-1');
  const detail = page.getByRole('region', { name: '검증 결과 V-0007-1 상세' });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('12/14 통과');
  expect(await overflow()).toBeLessThanOrEqual(0);
});

test('리뷰 4: 실행 시도 조회가 실패하면 오류와 다시 시도를 보이고, Agent 필터는 「조건 불일치」로 단정하지 않는다', async ({ page }) => {
  const api = await fakeApi(page);
  const data = m307Data();
  installM307(api, data);
  let fail = true;
  for (const k of ['TASK-0001', 'TASK-0007']) {
    api.on(`GET /api/tasks/${k}/attempts`, (route) => (fail
      ? json(route, 500, { error: { code: 'INTERNAL', message: '서버 오류', action: 'x', fix: 'y', errors: [], details: {}, requestId: 'r' } })
      : json(route, 200, { items: attempts(k), nextCursor: null })));
  }
  await page.goto('/verify?agent=Codex');
  const alert = page.getByRole('alert').filter({ hasText: '실행 시도 정보를 불러오지 못했습니다' });
  await expect(alert).toBeVisible();
  await expect(page.getByRole('table', { name: '검증 결과' }).locator('[data-empty="filtered"]')).toHaveCount(0);
  await expect(page.getByRole('table', { name: '검증 결과' }).locator('[data-empty="agent-unknown"]')).toContainText('2건');
  fail = false;
  await alert.getByRole('button', { name: '다시 시도' }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.locator('[data-vrow]')).toHaveCount(2);
});

test('리뷰 5: 390px Completion Gate 탭도 페이지 가로 넘침 없이 표 상자만 스크롤', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/verify?tab=gate');
  await expect(page.getByRole('table', { name: 'Completion Gate' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await page.getByRole('region', { name: 'Completion Gate 표' }).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});
