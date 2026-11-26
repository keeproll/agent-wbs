/**
 * M3-08 설정 → 일정 · Task 탭과 점검 탭: UAT-POLICY-03, UAT-POLICY-04, UAT-STATE-03, UAT-POLICY-05, UAT-EMPTY-11(일정 부분).
 */
import { expect, test } from '@playwright/test';
import { fakeApi, hold, json } from './support/fake-api.ts';
import { BLACKOUTS, SCHEDULE, settingsApi } from './support/settings-fixtures.ts';

test('UAT-POLICY-03: 분할 상한·하한·파일 상한·10규칙 변경을 저장하고, 테스트 포함·계층별 계약 먼저는 고정이다', async ({ page }) => {
  const s = settingsApi(await fakeApi(page));
  await page.goto('/settings/plan');
  const card = page.getByRole('region', { name: 'Task 분할 기준' });
  await expect(card.getByRole('group', { name: '크기 상한' }).getByRole('button', { name: '4h' })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByText('Task에 포함')).toBeVisible();
  await expect(card.getByText('계층별 · 계약 먼저 (A)')).toBeVisible();
  await expect(card.locator('.gtr:not(.h)')).toHaveCount(10);
  await card.getByRole('group', { name: '크기 상한' }).getByRole('button', { name: '3h' }).click();
  await card.getByRole('group', { name: '바뀌는 파일 상한' }).getByRole('button', { name: '12개' }).click();
  await card.getByRole('button', { name: '정리와 기능 변경은 따로 끄기' }).click();
  await expect(card.locator('.gtr').filter({ hasText: '정리와 기능 변경은 따로' }).getByText('꺼짐')).toBeVisible();
  await card.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('분할 기준을 바꿨습니다.')).toBeVisible();
  expect(s.split.bodies[0]).toMatchObject({ maxHours: 3, minHours: 0.5, maxFiles: 12, testIn: true, dir: 'layer', on: { refactor: false, one: true } });
});

test('UAT-POLICY-04: 정책 기본값(임계값 1일·가정 가동률 60%) 표시와 변경, 불가일 형식·중복 거부, 추가·해제 저장', async ({ page }) => {
  const s = settingsApi(await fakeApi(page));
  await page.goto('/settings/plan');
  const card = page.getByRole('region', { name: '일정 재조정 정책 · 작업 불가일' });
  await expect(card.getByRole('group', { name: '재조정 임계값' }).getByRole('button', { name: '1일' })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByRole('group', { name: '초기 가동률 가정' }).getByRole('button', { name: '60%' })).toHaveAttribute('aria-pressed', 'true');
  await card.getByRole('group', { name: '재조정 임계값' }).getByRole('button', { name: '2일' }).click();
  await card.getByRole('group', { name: '일정 재조정' }).getByRole('button', { name: '제안만 생성' }).click();
  await card.getByRole('button', { name: '저장', exact: true }).first().click();
  await expect(page.getByText('설정을 저장했습니다.')).toBeVisible();
  expect(s.schedule.bodies[0]).toEqual({ updatedAt: '2026-11-05T01:00:00.000Z', autoReplan: false, cpAuto: true, thresholdDays: 2, assumeRate: 0.6, windowDays: 7, minHours: 72 });

  const date = card.getByLabel('날짜');
  await card.getByRole('button', { name: '추가' }).click();
  await expect(card.getByText('날짜를 입력하세요.')).toBeVisible();
  await date.fill('2026/12/24');
  await card.getByRole('button', { name: '추가' }).click();
  await expect(card.getByText('날짜 형식이 아닙니다 — YYYY-MM-DD로 입력하세요(예: 2026-12-24).')).toBeVisible();
  await date.fill('2026-11-20');
  await card.getByRole('button', { name: '추가' }).click();
  await expect(card.getByText('2026-11-20는 이미 작업 불가일입니다.')).toBeVisible();
  await date.fill('2026-12-24');
  await card.getByLabel('사유').fill('연차');
  await card.getByRole('button', { name: '추가' }).click();
  await card.getByRole('button', { name: '2026-11-20 해제' }).click();
  await expect(card.locator('.gtr').filter({ hasText: '2026-12-24' })).toContainText('연차');
  await card.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('작업 불가일을 저장했습니다 — 일정을 다시 계산합니다.')).toBeVisible();
  expect(s.blackouts.bodies[0]).toEqual({ updatedAt: '2026-11-05T01:00:00.000Z', days: [{ date: '2026-12-24', note: '연차' }] });
});

test('UAT-POLICY-04: 진행률 가중치(Q-03)·진행률/완료율 설명, 고정 Agent 5개 문구 없음', async ({ page }) => {
  settingsApi(await fakeApi(page));
  await page.goto('/settings/plan');
  const card = page.getByRole('region', { name: '일정 · 진행률 산정 기준' });
  await expect(card.locator('.gtr:not(.h) .gc.mono')).toHaveText(['0%', '0%', '0%', '35%', '20%', '50%', '65%', '80%', '90%', '100%']);
  await expect(card.locator('.gtr:not(.h) .st')).toHaveText(['계획 중', '승인 대기', '실행 대기', '실행 중', '실패', '재작업 필요', 'QA 진행', '검증 진행', 'Gate 대기', '완료']);
  await expect(card.getByText(/완료율/)).toBeVisible();
  await expect(card.getByText(/최대 5/)).toHaveCount(0);
});

test('UAT-STATE-03: 일정에 영향을 주는 저장 뒤 일정을 다시 읽는 동안 흐리게 하고 클릭을 막으며, 끝나면 되돌린다', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  await page.goto('/settings/plan');
  const slow = hold((route) => json(route, 200, { ...SCHEDULE, blackouts: [] }));
  api.on('GET /api/schedule', slow.handler);
  const card = page.getByRole('region', { name: '일정 재조정 정책 · 작업 불가일' });
  await card.getByRole('button', { name: '2026-11-20 해제' }).click();
  await card.getByRole('button', { name: '저장', exact: true }).click();
  const chip = page.getByText('일정 다시 계산 중 — 잠시 후 갱신됩니다');
  await expect(chip).toBeVisible();
  // 흐린 동안 본문 클릭은 막힌다.
  await expect(page.locator('main.main.dim')).toBeVisible();
  const blocked = await page.getByRole('group', { name: '크기 상한' }).getByRole('button', { name: '6h' }).click({ timeout: 800, trial: true }).then(() => false, () => true);
  expect(blocked).toBe(true);
  slow.release();
  await expect(chip).toHaveCount(0);
  await page.getByRole('group', { name: '크기 상한' }).getByRole('button', { name: '6h' }).click();
  await expect(page.getByRole('group', { name: '크기 상한' }).getByRole('button', { name: '6h' })).toHaveAttribute('aria-pressed', 'true');
});

test('UAT-EMPTY-11 (일정): 작업 불가일이 없으면 없음과 추가 방법을 안내한다', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  api.on('GET /api/settings/blackouts', (route) => json(route, 200, { ...BLACKOUTS, days: [] }));
  await page.goto('/settings/plan');
  await expect(page.getByText(/등록된 작업 불가일이 없습니다. 휴가 · 점검처럼 PC를 켤 수 없는 날을 아래에서 추가하면/)).toBeVisible();
});

test('UAT-POLICY-05: 정합성 점검은 누를 때 서버 결과(항목·상세·시각)를 보이고, 제품에는 Prototype 도구가 없다', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  await page.goto('/settings/system');
  await expect(page.getByText('아직 점검하지 않았습니다. 「점검 실행」을 누르세요.')).toBeVisible();
  expect(api.calls().filter((c) => c.startsWith('GET /api/system/integrity'))).toHaveLength(0);
  await page.getByRole('button', { name: '점검 실행' }).click();
  await expect(page.getByText('1 / 2 통과')).toBeVisible();
  await expect(page.getByText('2026-11-05 20:00')).toBeVisible();
  await expect(page.locator('.gtr').filter({ hasText: 'Completion Gate' }).getByText('FAIL')).toBeVisible();
  await expect(page.getByText('TASK-0004: 완료인데 Gate 미충족 1건')).toBeVisible();
  for (const text of ['Prototype 구현 현황', '화면 상태 미리보기', '페이지 로딩 (Mock 지연)', '오류 상태']) {
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText(/Prototype/)).toHaveCount(0);
});
