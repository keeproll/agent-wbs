/**
 * M3-06 재리뷰(fix1 188c9bf) 지적 재현 시험. 고치기 전에는 실패해야 한다.
 * 리뷰: ~/.orca/bots/agentwbs/archive/2026-11-26/M3-06/fix1/REPORT.md
 * - P1: 충돌 창 「최신 내용 불러오기」 중 Esc로 닫은 뒤 늦게 온 조회 결과가 새로 쓴 초안을 지운다.
 * - P2: 지시는 보냈고 실행 요청에서 세션이 만료(401)되면, 재로그인·복원 뒤 같은 지시를 다시 만든다.
 */
import { expect, test, type Page } from '@playwright/test';
import { errorBody, hold, json, SESSION } from './support/fake-api.ts';
import { execApi, message, type ExecApi } from './support/exec-fixtures.ts';

const center = (page: Page) => page.getByLabel('선택 Task 실행');
const msgs = (page: Page) => page.getByRole('complementary', { name: '연결 메시지' });
const nextBox = (page: Page) => center(page).locator('.next');
const REWORK_ALERT = { id: 'al2', key: 'rework-limit:id-TASK-0007', severity: 'warn', taskKey: 'TASK-0007', target: null, text: '자동 재작업 한도를 넘었습니다.', at: '2026-11-04T01:00:00.000Z' };

/** 로그인 상태를 바꿀 수 있는 가짜 세션. expire()를 부르면 그 뒤 요청이 401이 된다. */
function sessionSwitch(api: ExecApi) {
  let signedIn = true;
  api.on('GET /api/session', (route) => (signedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  api.on('POST /api/auth/session', (route) => { signedIn = true; return route.fulfill({ status: 204 }); });
  return { expire: () => { signedIn = false; } };
}
async function relogin(page: Page) {
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  await page.getByLabel('비밀번호').fill('pw');
  await page.getByRole('button', { name: '로그인' }).click();
}

test('P1 재작업 지시: 최신 불러오기 중 Esc로 닫고 새로 쓴 지시는 늦게 온 조회 결과에 지워지지 않는다', async ({ page }) => {
  const api = await execApi(page);
  api.state.alerts = [REWORK_ALERT];
  api.on('POST /api/messages', (route) => json(route, 201, message('MSG-010', 'TASK-0007', { type: '수정 요청', body: 'A', updatedAt: '2026-11-05T11:00:00.000Z' })));
  api.on('POST /api/messages/msg-MSG-010/send', (route) => json(route, 200, message('MSG-010', 'TASK-0007', { delivery: 'Queued' })));
  api.on('POST /api/tasks/TASK-0007/runs', (route) => json(route, 409, errorBody('VERSION_CONFLICT')));
  await page.goto('/exec/TASK-0007');
  await nextBox(page).getByRole('button', { name: '재작업 지시 작성' }).click();
  await page.getByLabel('재작업 지시 내용').fill('A');
  await page.getByRole('button', { name: '지시 전송 후 재작업 실행' }).click();
  const dialog = page.getByRole('alertdialog').filter({ hasText: '다시 적용' });
  await expect(dialog).toBeVisible();

  // 최신 조회(Task 목록)를 붙잡아 둔다
  const slow = hold((route) => json(route, 200, { nodes: [], tasks: api.state.tasks }));
  api.on('GET /api/projects/p1/tasks', slow.handler);
  await dialog.getByRole('button', { name: /최신 내용 불러오기/ }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('재작업 지시 내용').fill('B 새로 쓴 지시');
  slow.release();
  await page.waitForTimeout(500);
  await expect(page.getByLabel('재작업 지시 내용')).toHaveValue('B 새로 쓴 지시');
  await expect(page.getByText('최신 내용을 불러왔습니다.', { exact: false })).toHaveCount(0);
});

test('P2 재작업 지시: 지시는 보냈고 실행 요청이 401이면, 재로그인·복원 뒤 지시를 다시 만들지 않고 실행 요청만 보낸다', async ({ page }) => {
  const api = await execApi(page);
  api.state.alerts = [REWORK_ALERT];
  const session = sessionSwitch(api);
  api.on('POST /api/messages', (route) => json(route, 201, message('MSG-010', 'TASK-0007', { type: '수정 요청', body: '지시', updatedAt: '2026-11-05T11:00:00.000Z' })));
  api.on('POST /api/messages/msg-MSG-010/send', (route) => json(route, 200, message('MSG-010', 'TASK-0007', { delivery: 'Queued' })));
  let runs = 0;
  api.on('POST /api/tasks/TASK-0007/runs', (route) => {
    runs++;
    if (runs === 1) { session.expire(); return json(route, 401, errorBody('LEAD_UNAUTHORIZED')); }
    return json(route, 202, { jobId: 'job-1' });
  });
  await page.goto('/exec/TASK-0007');
  await nextBox(page).getByRole('button', { name: '재작업 지시 작성' }).click();
  await page.getByLabel('재작업 지시 내용').fill('지시');
  await page.getByRole('button', { name: '지시 전송 후 재작업 실행' }).click();
  await relogin(page);
  await expect(page).toHaveURL(/\/exec\/TASK-0007/);
  await nextBox(page).getByRole('button', { name: '재작업 지시 작성' }).click();
  const offer = page.getByRole('region', { name: /TASK-0007 재작업 지시 — 저장하지 못한 초안/ });
  await offer.getByRole('button', { name: '복원' }).click();
  await expect(page.getByLabel('재작업 지시 내용')).toHaveValue('지시');
  await expect(center(page)).toContainText('MSG-010');
  await page.getByRole('button', { name: '지시 전송 후 재작업 실행' }).click();
  await expect(page.getByText('재작업 지시를 보내고 재작업 실행을 요청했습니다.')).toBeVisible();
  expect(api.requests('POST /api/messages')).toHaveLength(1);
  expect(api.requests('POST /api/messages/msg-MSG-010/send')).toHaveLength(1);
  expect(api.requests('POST /api/tasks/TASK-0007/runs')).toHaveLength(2);
});

test('P2 메시지 작성: 만들기는 됐고 전송이 401이면, 재로그인·복원 뒤 메시지를 다시 만들지 않고 전송만 한다', async ({ page }) => {
  const api = await execApi(page);
  const session = sessionSwitch(api);
  api.on('POST /api/messages', (route) => {
    api.state.messages['TASK-0005'] = [message('MSG-020', 'TASK-0005', { body: '추가 지시', delivery: 'Draft', updatedAt: '2026-11-05T11:00:00.000Z' })];
    return json(route, 201, api.state.messages['TASK-0005'][0]);
  });
  let sends = 0;
  api.on('POST /api/messages/msg-MSG-020/send', (route) => {
    sends++;
    if (sends === 1) { session.expire(); return json(route, 401, errorBody('LEAD_UNAUTHORIZED')); }
    return json(route, 200, message('MSG-020', 'TASK-0005', { body: '추가 지시', delivery: 'Queued' }));
  });
  await page.goto('/exec/TASK-0005');
  await msgs(page).getByRole('button', { name: '메시지 작성' }).click();
  await msgs(page).getByLabel('메시지 내용').fill('추가 지시');
  await msgs(page).getByRole('button', { name: '전송', exact: true }).click();
  await relogin(page);
  await expect(page).toHaveURL(/\/exec\/TASK-0005/);
  await msgs(page).getByRole('button', { name: '메시지 작성' }).click();
  const offer = page.getByRole('region', { name: /TASK-0005 메시지 작성 — 저장하지 못한 초안/ });
  await offer.getByRole('button', { name: '복원' }).click();
  await expect(msgs(page).getByLabel('메시지 내용')).toHaveValue('추가 지시');
  await msgs(page).getByRole('button', { name: '전송', exact: true }).click();
  await expect(page.getByText('메시지를 전달 대기열에 넣었습니다.')).toBeVisible();
  expect(api.requests('POST /api/messages')).toHaveLength(1);
  expect(api.requests('POST /api/messages/msg-MSG-020/send')).toHaveLength(2);
});
