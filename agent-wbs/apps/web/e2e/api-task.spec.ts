/**
 * M3-03 실제 API(LAN 모드)·실제 DB(demo seed = 원본 Mock 12 Task) — `pnpm --filter @awbs/web e2e:api:task`가 환경을 만든다.
 * UAT-APPROVE-01(요청 거부·승인·반려·이력), UAT-TASK-01(요약), UAT-TASK-02(개요 저장·이력), UAT-TASK-09(체크리스트 추가).
 * 환경 변수가 없으면(일반 `W e2e`) 건너뛴다.
 */
import { expect, test, type Page } from '@playwright/test';

const password = process.env.AWBS_E2E_PASSWORD ?? '';
test.skip(!password || !process.env.AWBS_E2E_API, '실제 API 환경이 없다. pnpm --filter @awbs/web e2e:api:task로 실행한다.');
test.describe.configure({ mode: 'serial' });

const serverErrors: string[] = [];
test.beforeEach(({ page }) => {
  page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.request().method()} ${new URL(r.url()).pathname} ${String(r.status())}`); });
});
test.afterAll(() => { if (serverErrors.length) console.log(`[실제 API 5xx] ${serverErrors.join(' | ')}`); });

async function login(page: Page, path: string) {
  await page.goto(path);
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(path);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
}
const status = (page: Page) => page.locator('.summary .st');

test('UAT-TASK-01 실제 서버 요약·9탭', async ({ page }) => {
  await login(page, '/wbs/TASK-0004');
  await expect(page.getByRole('heading', { level: 2, name: 'Drizzle Schema 설계' })).toBeVisible();
  await expect(page.locator('.idchip')).toHaveText('TASK-0004');
  await expect(page.getByRole('tablist', { name: 'Task 상세 탭' }).getByRole('tab')).toHaveCount(9);
  console.log(`[TASK-0004 요약] ${await page.locator('.summary').innerText()}`.replace(/\n/g, ' | '));
  console.log(`[TASK-0004 탭] ${(await page.getByRole('tablist', { name: 'Task 상세 탭' }).innerText()).replace(/\n/g, ' ')}`);
});

test('UAT-APPROVE-01 실제 서버: 명세 미완료 요청 400 거부, 판단 기록 없는 승인 409 거부, 반려는 planning·사유 이력', async ({ page }) => {
  await login(page, '/wbs/TASK-0009');
  console.log(`[TASK-0009 상태] ${await status(page).innerText()}`);
  const bar = page.locator('.appr-bar');
  if (await bar.getByRole('button', { name: '착수 승인 요청' }).count()) {
    await bar.getByRole('button', { name: '착수 승인 요청' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('400');
    console.log(`[요청 거부] ${(await alert.innerText()).replace(/\n/g, ' | ')}`);
    await expect(status(page)).toHaveText('계획 중');
  }

  // 승인 대기 Task: demo seed에는 분할 기준 판단 기록(규칙 5·7·9)이 없어 서버가 승인을 409 SPLIT_JUDGEMENT_REQUIRED로 막는다(D-33).
  // 판단 기록은 Planning Agent job만 만들 수 있어 이 시험에서는 「거부가 보이고 상태가 그대로」인지 확인한다. 승인 성공 흐름은 가짜 서버 시험(task-detail-flow)이 맡는다.
  await page.goto('/wbs/TASK-0010');
  await expect(status(page)).toHaveText('승인 대기');
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/tasks/TASK-0010/approve')),
    page.locator('.appr-bar').getByRole('button', { name: '승인', exact: true }).click(),
  ]);
  expect(resp.status()).toBe(409);
  const refused = page.getByRole('alert');
  await expect(refused).toContainText('409 SPLIT_JUDGEMENT_REQUIRED');
  await expect(refused).toContainText('대상: TASK-0010 착수 승인');
  await expect(status(page)).toHaveText('승인 대기');
  console.log(`[TASK-0010 승인 거부] ${(await refused.innerText()).replace(/\n/g, ' | ')}`);

  // 승인 대기 Task: 반려(사유) → 계획 중
  await page.goto('/wbs/TASK-0012');
  await expect(status(page)).toHaveText('승인 대기');
  await page.locator('.appr-bar').getByRole('button', { name: '반려' }).click();
  await page.getByRole('dialog', { name: '착수 반려' }).getByLabel('반려 사유').fill('실제 서버 반려 시험');
  await page.getByRole('dialog', { name: '착수 반려' }).getByRole('button', { name: '반려' }).click();
  await expect(status(page)).toHaveText('계획 중');
  await page.getByRole('tab', { name: /^이력/ }).click();
  console.log(`[TASK-0012 이력] ${(await page.getByRole('table', { name: '이력' }).innerText()).replace(/\n/g, ' | ').slice(0, 600)}`);
});

test('UAT-TASK-02·09 실제 서버: 개요 제목 저장·체크리스트 추가가 이력에 남는다', async ({ page }) => {
  await login(page, '/wbs/TASK-0006');
  await page.getByRole('button', { name: '개요 편집' }).click();
  await page.locator('#ov-title').fill('Dependency 검증 (실제 서버 저장)');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Dependency 검증 (실제 서버 저장)' })).toBeVisible();
  await page.getByRole('tab', { name: /^체크리스트/ }).click();
  await page.getByLabel('체크 내용').fill('실제 서버 항목');
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await expect(page.getByRole('table', { name: '체크리스트' })).toContainText('실제 서버 항목');
  await page.getByRole('tab', { name: /^이력/ }).click();
  const hist = page.getByRole('table', { name: '이력' });
  await expect(hist).toContainText('실제 서버 저장');
  await expect(hist).toContainText('실제 서버 항목');
});
