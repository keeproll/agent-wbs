/**
 * M3-06 실제 API·전용 DB(demo seed) 핵심 흐름 — `pnpm --filter @awbs/web e2e:api-exec`가 환경을 만든다.
 * 환경 변수가 없으면(일반 `W e2e -- exec`) 건너뛴다.
 *
 * 확인하는 것(실제 서버 응답으로):
 * - 3영역·6단계·실행 중 시도·실제 등급(UAT-EXEC-UI a)
 * - QA FAIL 검증과 결함, 수신 확인과 Agent 응답의 분리(UAT-EXEC-UI c, UAT-MSG-01)
 * - 실행할 수 없는 Task(선행 차단 또는 Runner 미연결 — 이 시험 환경에는 Runner가 없다)는 실행 요청을 막고 사유를 보인다(UAT-EXEC-UI b)
 * - 실행 중 Task에 메시지 전송 → 서버가 「다음 실행 대기」로 보관 → 전송 취소(UAT-MSG-UI a·b, 시나리오 7의 앞부분)
 * 실제 Runner가 없으므로 ack·재전송·재개는 가짜 Runner E2E(exec.spec.ts)에서 확인한다.
 */
import { expect, test, type Page } from '@playwright/test';

const password = process.env.AWBS_E2E_PASSWORD ?? '';
test.skip(!password || !process.env.AWBS_E2E_API, '실제 API 환경이 없다. pnpm --filter @awbs/web e2e:api-exec로 실행한다.');
test.describe.configure({ mode: 'serial' });

const serverErrors: string[] = [];
test.beforeEach(({ page }) => {
  page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.request().method()} ${new URL(r.url()).pathname} ${String(r.status())}`); });
});
test.afterAll(() => { if (serverErrors.length) console.log(`[실제 API 5xx] ${serverErrors.join(' | ')}`); });

async function login(page: Page, next: string) {
  await page.goto(next);
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '작업 실행', level: 1 })).toBeVisible();
}
const center = (page: Page) => page.getByLabel('선택 Task 실행');
const rail = (page: Page) => page.getByRole('complementary', { name: 'Task 및 실행 목록' });
const msgs = (page: Page) => page.getByRole('complementary', { name: '연결 메시지' });

test('실제 API: 실행 중 Task의 3영역·6단계·등급, 메시지 전송 → 다음 실행 대기 → 취소', async ({ page }) => {
  await login(page, '/exec/TASK-0005');
  await expect(rail(page).getByRole('button', { name: /TASK-0001/ }).first()).toBeVisible();
  await expect(rail(page).getByText('TASK-0009')).toHaveCount(0);
  await expect(center(page).getByRole('heading', { name: 'Task CRUD API' })).toBeVisible();
  const steps = center(page).getByRole('list', { name: '실행 단계' }).getByRole('listitem');
  await expect(steps).toHaveCount(6);
  await expect(steps.nth(0)).toHaveClass('cur');
  await expect(center(page).locator('.next')).toContainText('실행 중 — Runner 결과 보고를 기다립니다.');

  const pane = msgs(page);
  await pane.getByRole('button', { name: '메시지 작성' }).click();
  await expect(pane.getByRole('button', { name: '전송', exact: true })).toBeDisabled();
  await pane.getByLabel('메시지 내용').fill('M3-06 실제 API 시험: 에러 응답 형식 통일');
  await pane.getByRole('button', { name: '전송', exact: true }).click();
  await expect(page.getByText('메시지를 전달 대기열에 넣었습니다.')).toBeVisible();
  const item = pane.getByRole('article').filter({ hasText: 'M3-06 실제 API 시험' });
  await expect(item).toContainText('Queued · 전달 대기');
  await expect(item).toContainText('다음 실행 대기');
  await expect(pane.getByLabel('메시지 내용')).toHaveValue('');

  await item.getByRole('button', { name: '전송 취소' }).click();
  await page.getByRole('alertdialog', { name: '전송 취소' }).getByRole('button', { name: '전송 취소' }).click();
  await expect(item).toContainText('Cancelled · 전송 취소');
});

test('실제 API: QA FAIL 재작업 대기 Task — 검증·결함, ack와 응답 분리, 실행할 수 없는 Task는 사유와 함께 막음', async ({ page }) => {
  await login(page, '/exec/TASK-0007');
  const steps = center(page).getByRole('list', { name: '실행 단계' }).getByRole('listitem');
  await expect(steps.nth(1)).toHaveClass('fail');
  await expect(steps.nth(2)).toHaveClass('cur');
  // QA 시도를 고르면 연결된 검증 결과가 보인다
  await rail(page).getByRole('button', { name: /ATT-0007-2/ }).click();
  const card = center(page).locator('.card').filter({ has: page.locator('.vbox') });
  await expect(card.locator('.vf.v-fail')).toHaveText('FAIL');
  await expect(card).toContainText('차단 결함');
  const pane = msgs(page);
  await expect(pane).toContainText('Acknowledged · 수신 확인');
  await expect(pane).toContainText('Runner 응답');

  await rail(page).getByRole('button', { name: /TASK-0006/ }).first().click();
  const start = center(page).locator('.next').getByRole('button', { name: /개발 실행 요청/ });
  await expect(start).toBeDisabled();
  await expect(center(page).locator('p.ferr')).toHaveText(/선행 Task 차단|Runner 연결 끊김/);
  // 화면은 스스로 실행 요청을 보내지 않는다
  expect(serverErrors).toEqual([]);
});
