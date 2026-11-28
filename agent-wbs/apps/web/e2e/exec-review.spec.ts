/**
 * M3-06 독립 리뷰(eb947ae) 지적 재현 시험. 고치기 전에는 실패해야 한다.
 * 리뷰: ~/.orca/bots/agentwbs/archive/2026-11-26/M3-06-독립리뷰-eb947ae.md (번호는 리뷰의 지적 번호)
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { errorBody, json, SESSION } from './support/fake-api.ts';
import { attempt, execApi, message, verification } from './support/exec-fixtures.ts';

const center = (page: Page) => page.getByLabel('선택 Task 실행');
const rail = (page: Page) => page.getByRole('complementary', { name: 'Task 및 실행 목록' });
const msgs = (page: Page) => page.getByRole('complementary', { name: '연결 메시지' });
const nextBox = (page: Page) => center(page).locator('.next');
const REWORK_ALERT = { id: 'al2', key: 'rework-limit:id-TASK-0007', severity: 'warn', taskKey: 'TASK-0007', target: null, text: '자동 재작업 한도를 넘었습니다.', at: '2026-11-04T01:00:00.000Z' };

test('#1 Task를 여러 번 바꿔도 가운데·오른쪽 패널은 하나씩이고 명령은 현재 Task의 것', async ({ page }) => {
  await execApi(page);
  await page.goto('/exec/TASK-0005');
  await expect(nextBox(page).getByRole('button', { name: '실행 중단' })).toBeVisible();
  await rail(page).getByRole('button', { name: /TASK-0007/ }).first().click();
  await expect(center(page).getByRole('heading', { name: 'WBS Tree UI' })).toBeVisible();
  await rail(page).getByRole('button', { name: /TASK-0001/ }).first().click();
  await expect(center(page).getByRole('heading', { name: 'Monorepo 구성' })).toBeVisible();
  await rail(page).getByRole('button', { name: /TASK-0007/ }).first().click();
  await expect(center(page)).toHaveCount(1);
  await expect(msgs(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: '실행 중단' })).toHaveCount(0);
  await expect(center(page).getByRole('heading', { level: 2 })).toHaveText(['WBS Tree UI']);
});

test('#2 재작업 실행만 버전 충돌이면 다시 적용은 실행 요청만 최신 버전으로 다시 보낸다(지시 메시지는 한 번)', async ({ page }) => {
  const api = await execApi(page);
  api.state.alerts = [REWORK_ALERT];
  api.on('POST /api/messages', (route) => json(route, 201, message('MSG-010', 'TASK-0007', { type: '수정 요청', body: '지시', updatedAt: '2026-11-05T11:00:00.000Z' })));
  api.on('POST /api/messages/msg-MSG-010/send', (route) => json(route, 200, message('MSG-010', 'TASK-0007', { delivery: 'Queued' })));
  let runs = 0;
  api.on('POST /api/tasks/TASK-0007/runs', (route) => {
    runs++;
    if (runs === 1) {
      const t = api.state.tasks.find((x) => x.taskKey === 'TASK-0007');
      if (t) t.updatedAt = '2026-11-05T11:30:00.000Z';
      return json(route, 409, errorBody('VERSION_CONFLICT'));
    }
    return json(route, 202, { jobId: 'job-9' });
  });
  await page.goto('/exec/TASK-0007');
  await nextBox(page).getByRole('button', { name: '재작업 지시 작성' }).click();
  await page.getByLabel('재작업 지시 내용').fill('지시');
  await page.getByRole('button', { name: '지시 전송 후 재작업 실행' }).click();
  const dialog = page.getByRole('alertdialog').filter({ hasText: '다시 적용' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /다시 적용/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => api.requests('POST /api/tasks/TASK-0007/runs').length).toBe(2);
  expect(api.requests('POST /api/messages')).toHaveLength(1);
  expect(api.requests('POST /api/messages/msg-MSG-010/send')).toHaveLength(1);
  expect(api.requests('POST /api/tasks/TASK-0007/runs')[1]?.postDataJSON()).toEqual({ updatedAt: '2026-11-05T11:30:00.000Z', kind: 'rework' });
});

test('#2 재작업 실행만 충돌한 뒤 「최신 불러오기(내 변경 버림)」를 골라도 이미 보낸 지시는 보냈다고 알린다', async ({ page }) => {
  const api = await execApi(page);
  api.state.alerts = [REWORK_ALERT];
  api.on('POST /api/messages', (route) => json(route, 201, message('MSG-010', 'TASK-0007', { type: '수정 요청', body: '지시', updatedAt: '2026-11-05T11:00:00.000Z' })));
  api.on('POST /api/messages/msg-MSG-010/send', (route) => json(route, 200, message('MSG-010', 'TASK-0007', { delivery: 'Queued' })));
  api.on('POST /api/tasks/TASK-0007/runs', (route) => json(route, 409, errorBody('VERSION_CONFLICT')));
  await page.goto('/exec/TASK-0007');
  await nextBox(page).getByRole('button', { name: '재작업 지시 작성' }).click();
  await page.getByLabel('재작업 지시 내용').fill('지시');
  await page.getByRole('button', { name: '지시 전송 후 재작업 실행' }).click();
  const dialog = page.getByRole('alertdialog').filter({ hasText: '다시 적용' });
  await expect(dialog).toContainText('MSG-010');
});

test('#3 시도 조회 실패는 「시도 없음」·새 실행 버튼이 아니라 오류와 다시 시도', async ({ page }) => {
  const api = await execApi(page);
  let fail = true;
  await page.route(/\/api\/tasks\/TASK-0005\/attempts/, (route) => (fail ? json(route, 503, errorBody('UNAVAILABLE')) : route.fallback()));
  await page.goto('/exec/TASK-0005');
  await expect(center(page)).toContainText('실행 기록을 불러오지 못했습니다');
  await expect(center(page)).not.toContainText('아직 실행 시도가 없습니다');
  await expect(center(page).getByRole('button', { name: /개발 실행 요청/ })).toHaveCount(0);
  fail = false;
  await center(page).getByRole('button', { name: '다시 시도' }).click();
  await expect(nextBox(page).getByRole('button', { name: '실행 중단' })).toBeVisible();
  expect(api.calls().filter((c) => c.startsWith('POST'))).toEqual([]);
});

test('#3 메시지 조회 실패는 「연결된 메시지가 없습니다」가 아니라 오류와 다시 시도', async ({ page }) => {
  await execApi(page);
  let fail = true;
  await page.route(/\/api\/tasks\/TASK-0007\/messages/, (route) => (fail ? json(route, 503, errorBody('UNAVAILABLE')) : route.fallback()));
  await page.goto('/exec/TASK-0007');
  await expect(msgs(page)).toContainText('메시지를 불러오지 못했습니다');
  await expect(msgs(page)).not.toContainText('연결된 메시지가 없습니다');
  fail = false;
  await msgs(page).getByRole('button', { name: '다시 시도' }).click();
  await expect(msgs(page).getByRole('article', { name: /MSG-001/ })).toBeVisible();
});

test('#3 검증 조회 실패면 단계·다음 작업을 계산하지 않는다', async ({ page }) => {
  await execApi(page);
  await page.route(/\/api\/tasks\/TASK-0007\/verifications/, (route) => json(route, 503, errorBody('UNAVAILABLE')));
  await page.goto('/exec/TASK-0007');
  await expect(center(page)).toContainText('검증 기록을 불러오지 못했습니다');
  await expect(nextBox(page)).toHaveCount(0);
});

test('#4 없는 Task 주소는 다른 Task를 열지 않고 「없음」 안내', async ({ page }) => {
  await execApi(page);
  await page.goto('/exec/TASK-DOES-NOT-EXIST');
  await expect(page.getByText('TASK-DOES-NOT-EXIST를 찾을 수 없습니다.')).toBeVisible();
  await expect(center(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '실행 중단' })).toHaveCount(0);
});

test('#4 없는 시도 키는 알리고 고르지 않는다', async ({ page }) => {
  await execApi(page);
  await page.goto('/exec/TASK-0005?att=ATT-9999');
  await expect(center(page)).toContainText('ATT-9999 시도를 찾을 수 없습니다');
  await expect(page.locator('.ex-a.on')).toHaveCount(0);
});

test('#6 다른 Task로 옮긴 뒤에도 보관 중인 초안이 있으면 창 닫기·새로고침 때 묻고, 세션 만료면 모든 Task 초안을 보관한다', async ({ page }) => {
  const api = await execApi(page);
  await page.goto('/exec/TASK-0005');
  await msgs(page).getByRole('button', { name: '메시지 작성' }).click();
  await msgs(page).getByLabel('메시지 내용').fill('보관할 지시');
  await rail(page).getByRole('button', { name: /TASK-0007/ }).first().click();
  await expect(center(page).getByRole('heading', { name: 'WBS Tree UI' })).toBeVisible();
  const asked = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const dialog = await asked;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();

  // 세션 만료(401) → 모든 Task 초안을 보관한다
  let signedIn = true;
  api.on('GET /api/session', (route) => (signedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  api.on('POST /api/auth/session', (route) => { signedIn = true; return route.fulfill({ status: 204 }); });
  api.on('GET /api/projects/p1/tasks', (route) => (signedIn ? json(route, 200, { nodes: [], tasks: api.state.tasks }) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  signedIn = false;
  api.bump(['task']);
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  const keys = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('awbs.draft:')));
  expect(keys).toContain('awbs.draft:exec:TASK-0005:message');
  await page.getByLabel('비밀번호').fill('pw');
  await page.getByRole('button', { name: '로그인' }).click();
  await rail(page).getByRole('button', { name: /TASK-0005/ }).first().click();
  const offer = page.getByRole('region', { name: /TASK-0005 메시지 작성 — 저장하지 못한 초안/ });
  await offer.getByRole('button', { name: '복원' }).click();
  await expect(msgs(page).getByLabel('메시지 내용')).toHaveValue('보관할 지시');
});

test('#7 검증·시도는 서버 순번으로 본다(API의 id 순서도 시각도 아님) — 최신 FAIL과 그 시도에 지시를 연결', async ({ page }) => {
  const api = await execApi(page);
  const list = api.state.attempts['TASK-0007'] ?? [];
  const qa = list[1];
  if (!qa) throw new Error('fixture');
  // PC 시계가 뒤로 간 경우: 나중 시도(번호 3·4)의 시작 시각이 QA 시도(번호 2, 11-01 04:10)보다 이르다.
  const rw = attempt('ATT-0007-3', 'TASK-0007', 'rework', 'completed', '2026-11-01T04:09:58.000Z');
  const rv = attempt('ATT-0007-4', 'TASK-0007', 'reverify', 'completed', '2026-11-01T04:09:59.000Z');
  list.push(rw, rv);
  // API는 id 순서: 최신(저장 순번 2) 검증의 id가 더 작아 먼저 온다. 그 시각도 옛 검증보다 2.3초 이르다.
  api.state.verifications['TASK-0007'] = [
    verification('V-a-latest', rv, 'FAIL', { seq: 2, at: '2026-11-01T05:00:00.000Z' }),
    verification('V-z-oldest', qa, 'FAIL', { seq: 1, at: '2026-11-01T05:00:02.300Z' }),
  ];
  api.state.alerts = [REWORK_ALERT];
  api.on('POST /api/messages', (route) => json(route, 201, message('MSG-010', 'TASK-0007', { updatedAt: '2026-11-05T11:00:00.000Z' })));
  api.on('POST /api/messages/msg-MSG-010/send', (route) => json(route, 200, message('MSG-010', 'TASK-0007', { delivery: 'Queued' })));
  api.on('POST /api/tasks/TASK-0007/runs', (route) => json(route, 202, { jobId: 'j' }));
  await page.goto('/exec/TASK-0007');
  await expect(nextBox(page)).toContainText('V-a-latest FAIL');
  await nextBox(page).getByRole('button', { name: '재작업 지시 작성' }).click();
  await page.getByLabel('재작업 지시 내용').fill('지시');
  await page.getByRole('button', { name: '지시 전송 후 재작업 실행' }).click();
  await expect.poll(() => (api.requests('POST /api/messages')[0]?.postDataJSON() as { attemptId?: string } | undefined)?.attemptId).toBe('att-ATT-0007-4');
});

test('#8 시도·메시지는 다음 쪽(nextCursor)까지 읽는다', async ({ page }) => {
  const api = await execApi(page);
  const first = attempt('ATT-0005-1', 'TASK-0005', 'dev', 'interrupted', '2026-11-03T10:58:00.000Z');
  const second = attempt('ATT-0005-2', 'TASK-0005', 'dev', 'running', '2026-11-04T10:58:00.000Z');
  api.state.attempts['TASK-0005'] = [];
  await page.route(/\/api\/tasks\/TASK-0005\/attempts/, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    return json(route, 200, cursor === 'c2' ? { items: [second], nextCursor: null } : { items: [first], nextCursor: 'c2' });
  });
  await page.route(/\/api\/tasks\/TASK-0005\/messages/, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    return json(route, 200, cursor === 'm2'
      ? { items: [message('MSG-099', 'TASK-0005', { body: '두 번째 쪽', delivery: 'Queued' })], nextCursor: null }
      : { items: [message('MSG-098', 'TASK-0005', { body: '첫 쪽', delivery: 'Queued' })], nextCursor: 'm2' });
  });
  await page.goto('/exec/TASK-0005');
  await expect(nextBox(page)).toContainText('ATT-0005-2 개발 실행 중');
  await expect(rail(page).getByRole('button', { name: /ATT-0005-2 개발 · Claude 실행 중/ })).toBeVisible();
  await expect(msgs(page).getByRole('article', { name: /MSG-099/ })).toBeVisible();
});

test('#9 받은 응답의 발신 Agent를 연결 시도로 추측하지 않는다', async ({ page }) => {
  await execApi(page);
  await page.goto('/exec/TASK-0007?att=ATT-0007-2');
  const reply = msgs(page).getByRole('article', { name: /MSG-002/ });
  await expect(reply.locator('.msg-who').first()).toHaveText('Agent');
});

test('#10 #12 안내 문장 12px 이상, 제목 순서 위반 없음', async ({ page }) => {
  await execApi(page);
  await page.goto('/exec/TASK-0007?att=ATT-0007-2');
  await msgs(page).getByRole('button', { name: '메시지 작성' }).click();
  const sizes = await page.locator('.three .fhint').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
  expect(sizes.length).toBeGreaterThan(0);
  for (const s of sizes) expect(s).toBeGreaterThanOrEqual(12);
  const result = await new AxeBuilder({ page }).withRules(['heading-order']).analyze();
  expect(result.violations).toEqual([]);
});

test('#3 알림·Runner 상태 조회 실패도 숨기지 않는다', async ({ page }) => {
  const api = await execApi(page);
  api.on('GET /api/alerts', (route) => json(route, 503, errorBody('UNAVAILABLE')));
  api.on('GET /api/runner-state', (route) => json(route, 503, errorBody('UNAVAILABLE')));
  const t = api.state.tasks.find((x) => x.taskKey === 'TASK-0006');
  if (t) t.blocked = false;
  await page.goto('/exec/TASK-0006');
  await expect(center(page)).toContainText('팀장 확인 알림을 불러오지 못했습니다');
  await expect(center(page)).toContainText('Runner 상태를 불러오지 못해');
});
