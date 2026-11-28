/**
 * UAT-TASK-10 「지정/실제 하위 Agent 표시」 — 시도 머리의 지정 · 실제 태그(원본 P L1310·L1822·L1084).
 * 값은 계약 Attempt.subagents에서만 온다(가짜 서버는 원본 Mock 같은 시도의 값을 계약 모양으로 준다).
 */
import { expect, test } from '@playwright/test';
import { fakeApi } from './support/fake-api.ts';
import { execApi } from './support/exec-fixtures.ts';
import { mountTasks, newStore } from './support/task-api.ts';

test('UAT-TASK-10 실행 탭: 끝난 시도는 지정·실제(세션 기록 확인), 실행 중 시도는 관측 수(추정)', async ({ page }) => {
  const api = await fakeApi(page);
  mountTasks(api, newStore());
  await page.goto('/wbs/TASK-0004?tab=exec');
  const done = page.getByRole('article', { name: '실행 ATT-0004-1' });
  await expect(done.locator('.tag.sub')).toHaveText('지정 db-migrator v2');
  const used = done.getByText(/^실제 /);
  await expect(used).toHaveText('실제 db-migrator v2 ×2, Explore ×1 · 세션 기록 확인');
  await expect(used).toHaveClass('tag new');
  await expect(done.getByText(/지정 미사용/)).toHaveCount(0);
  const running = page.getByRole('article', { name: '실행 ATT-0004-2' });
  await expect(running.locator('.tag.sub')).toHaveText('지정 qa-verifier v4');
  await expect(running.getByText(/^실제 /)).toHaveText('실제 실행 중 · 관측 1개 (추정)');
});

test('UAT-TASK-10 실행 탭: 확인된 보고에 없는 지정은 「지정 미사용」, 일부 관측은 노란 태그', async ({ page }) => {
  const api = await fakeApi(page);
  mountTasks(api, newStore());
  await page.goto('/wbs/TASK-0007?tab=exec');
  const dev = page.getByRole('article', { name: '실행 ATT-0007-1' });
  await expect(dev.getByText(/^실제 /)).toHaveText('실제 Explore ×1 · 세션 기록 확인');
  await expect(dev.locator('.sc.sc-warn', { hasText: '지정 미사용' })).toHaveText('지정 미사용 — fe-implementer');
  const qa = page.getByRole('article', { name: '실행 ATT-0007-2' });
  await expect(qa.getByText(/^실제 /)).toHaveText('실제 qa-verifier v4 ×1 · 일부 관측');
  await expect(qa.getByText(/^실제 /)).toHaveClass('tag chg');
});

test('UAT-TASK-10 값이 없으면 태그를 그리지 않는다(지정 없음·보고 없음)', async ({ page }) => {
  const api = await fakeApi(page);
  mountTasks(api, newStore());
  await page.goto('/wbs/TASK-0001?tab=exec');
  const first = page.getByRole('article', { name: '실행 ATT-0001-1' });
  await expect(first).toBeVisible();
  await expect(first.locator('.tag.sub')).toHaveCount(0);
  await expect(first.getByText(/^실제 /)).toHaveCount(0);
});

test('UAT-TASK-10 개요 탭: 실행 기록 줄에 그 시도의 지정 하위 Agent', async ({ page }) => {
  const api = await fakeApi(page);
  mountTasks(api, newStore());
  await page.goto('/wbs/TASK-0004');
  await expect(page.locator('.dt-body .ev', { hasText: 'ATT-0004-1' }).locator('.tag.sub')).toHaveText('하위 Agent db-migrator v2');
  await expect(page.locator('.dt-body .ev', { hasText: 'ATT-0004-2' }).locator('.tag.sub')).toHaveText('하위 Agent qa-verifier v4');
});

test('UAT-TASK-10 작업 실행: 시도 카드 태그, 관측이 끊기면 미확인 · 보유(노란 태그)', async ({ page }) => {
  const exec = await execApi(page);
  await page.goto('/exec/TASK-0005?att=ATT-0005-1');
  const card = page.getByLabel('ATT-0005-1 실행 기록');
  await expect(card.locator('.tag.sub')).toHaveText('지정 be-implementer v3');
  await expect(card.getByText(/^실제 /)).toHaveText('실제 실행 중 · 관측 2개 (추정)');
  const att = exec.state.attempts['TASK-0005']?.[0];
  if (!att) throw new Error('fixture');
  att.subagents = { ...att.subagents, observed: { count: 3, state: 'unconfirmed' } };
  exec.bump();
  await expect(card.getByText(/^실제 /)).toHaveText('실제 실행 중 · 관측 3개 (추정 — 미확인 · 보유)');
  await expect(card.getByText(/^실제 /)).toHaveClass('tag chg');
});
