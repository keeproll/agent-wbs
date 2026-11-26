/**
 * 독립 리뷰(M3-03-REVIEW.md) 화면 결함 회귀 시험 — R1 동시 편집 유실, R2 390px 본문 가림, R4 잘못된 설계 데이터,
 * R5 체크리스트 입력 유실, R6 읽기 실패 안내, R7 표·탭 접근성 구조.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { errorBody, fakeApi, hold, json, SESSION, type FakeApi } from './support/fake-api.ts';
import { detail, mountTasks, newStore, type TaskStore } from './support/task-api.ts';

async function open(page: Page, url: string, store = newStore()): Promise<{ api: FakeApi; s: TaskStore }> {
  const api = await fakeApi(page);
  const s = mountTasks(api, store);
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  return { api, s };
}

test('R1 다른 사용자가 저장한 뒤 변경 polling으로 캐시가 최신이 되어도, 편집을 시작한 버전으로 보내 409 충돌 창이 열리고 상대 변경을 덮어쓰지 않는다', async ({ page }) => {
  const { api, s } = await open(page, '/wbs/TASK-0004');
  let changed = false;
  api.on('GET /api/changes', (route) => json(route, 200, { events: [], next: changed ? 2 : 1, reset: changed }));
  await page.getByRole('button', { name: '개요 편집' }).click();
  await page.locator('#ov-title').fill('내가 고친 제목');
  // 다른 사용자가 목적을 저장한다
  s.tasks.get('TASK-0004').purpose = '다른 사용자가 저장한 새 목적';
  s.version.set('TASK-0004', '2026-11-05T10:50:00.000000Z');
  s.hist.push({ id: 'H-R1', at: '2026-11-05 19:58', actor: '다른 팀장', task: 'TASK-0004', kind: '개요 수정', text: '작업 목적 변경', before: '옛 목적', after: '다른 사용자가 저장한 새 목적' });
  changed = true;
  // 변경 polling이 최신 Task를 다시 읽을 때까지 기다린다(실제 화면 경로)
  await page.waitForRequest((r) => r.url().endsWith('/api/tasks/TASK-0004') && r.method() === 'GET', { timeout: 8_000 });
  changed = false;
  await expect(page.locator('#ov-title')).toHaveValue('내가 고친 제목');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const modal = page.getByRole('alertdialog');
  await expect(modal).toContainText('409 VERSION_CONFLICT');
  await modal.getByRole('button', { name: /다시 적용/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: '내가 고친 제목' })).toBeVisible();
  // 상대가 저장한 목적은 그대로, 내가 건드리지 않은 목적을 옛 값으로 되돌리지 않는다
  expect(s.tasks.get('TASK-0004').purpose).toBe('다른 사용자가 저장한 새 목적');
  expect(api.requests('PATCH /api/tasks/TASK-0004/spec')).toHaveLength(0);
});

test('R2 390px: 머리가 커도 본문(FAIL 결함·Evidence)을 세로로 스크롤해 실제로 읽을 수 있다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/wbs/TASK-0007?tab=verif');
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const defects = page.getByRole('article', { name: /FAIL/ }).locator('.ev');
  await defects.scrollIntoViewIfNeeded();
  await expect(defects).toBeInViewport({ ratio: 0.9 });
  await page.getByRole('button', { name: /미통과/ }).click();
  await defects.scrollIntoViewIfNeeded();
  await expect(defects).toBeInViewport({ ratio: 0.9 });
});

test('R4 잘못된 설계 데이터(빈 엔티티·배열 아닌 블록)도 앱이 죽지 않고 읽을 수 있는 부분과 안내를 보인다', async ({ page }) => {
  const store = newStore();
  const s = store;
  const api = await fakeApi(page);
  mountTasks(api, s);
  api.on('GET /api/tasks/TASK-0004', (route) => {
    const d = detail(s, 'TASK-0004');
    return json(route, 200, { ...d, designs: [
      { kind: 'DB', content: { ents: [{}, { f: { name: 'ok_table', change: '신규' }, b: { columns: 'x', indexes: [null] } }, 'bad'], b: { migration: 'not-array' } } },
      { kind: 'API', content: { ents: 'nope', b: null } },
    ] });
  });
  await page.goto('/wbs/TASK-0004?tab=tech');
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(page.getByText('Unexpected Application Error')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'DB 설계' })).toContainText('ok_table');
  await expect(page.getByRole('region', { name: 'DB 설계' }).getByRole('note')).toContainText('저장된 설계 내용 중 읽을 수 없는 항목');
  await expect(page.getByRole('region', { name: 'BE / API 설계' })).toBeVisible();
});

test('R4 탭 하나가 그리다 실패해도 앱 전체가 아니라 그 탭에만 안내·다시 시도를 보인다', async ({ page }) => {
  const s = newStore();
  const api = await fakeApi(page);
  mountTasks(api, s);
  // 계약 모양이 아닌 응답(배열 자리에 문자열)
  api.on('GET /api/tasks/TASK-0004/history', (route) => json(route, 200, { items: 'broken', nextCursor: null }));
  await page.goto('/wbs/TASK-0004?tab=hist');
  await expect(page.getByRole('heading', { level: 2, name: 'Drizzle Schema 설계' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '이 탭을 표시하지 못했습니다' })).toBeVisible();
  await page.getByRole('tab', { name: '개요' }).click();
  await expect(page.getByRole('heading', { level: 3, name: '개요' })).toBeVisible();
});

test('R5 체크리스트 새 항목 입력: 탭 이동은 확인을 묻고, 세션 만료에도 보관·복원된다', async ({ page }) => {
  const { api } = await open(page, '/wbs/TASK-0004?tab=checklist');
  await page.getByLabel('체크 내용').fill('아직 저장 안 한 항목');
  await page.getByRole('tab', { name: '개요' }).click();
  const dialog = page.getByRole('alertdialog', { name: '편집 내용 버리기' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page.getByLabel('체크 내용')).toHaveValue('아직 저장 안 한 항목');

  let loggedIn = true;
  api.on('GET /api/session', (route) => (loggedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  api.on('POST /api/auth/session', (route) => { loggedIn = true; return route.fulfill({ status: 204 }); });
  api.on('POST /api/tasks/TASK-0004/checklist', (route) => { loggedIn = false; return json(route, 401, errorBody('LEAD_UNAUTHORIZED')); });
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('비밀번호').fill('pw');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0004?tab=checklist');
  await page.getByRole('region', { name: /저장하지 못한 초안/ }).getByRole('button', { name: '복원' }).click();
  await expect(page.getByLabel('체크 내용')).toHaveValue('아직 저장 안 한 항목');
});

test('R5 첫 추가 응답을 기다리는 동안 입력한 다음 항목은 첫 요청이 성공해도 지워지지 않는다', async ({ page }) => {
  const { api, s } = await open(page, '/wbs/TASK-0004?tab=checklist');
  const real = s;
  const slow = hold(async (route, req) => {
    const b = req.postDataJSON() as { content: string; required: boolean };
    real.tasks.get('TASK-0004').checklist.push({ id: 'CL-0004-6', text: b.content, required: b.required, done: false, method: '', evidence: '', note: '' });
    real.version.set('TASK-0004', '2026-11-05T11:40:00.000000Z');
    return json(route, 201, { task: detail(real, 'TASK-0004'), changes: [] });
  });
  api.on('POST /api/tasks/TASK-0004/checklist', slow.handler);
  await page.getByLabel('체크 내용').fill('첫 항목');
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await page.getByLabel('체크 내용').fill('다음 항목');
  slow.release();
  await expect(page.getByRole('table', { name: '체크리스트' })).toContainText('첫 항목');
  await expect(page.getByLabel('체크 내용')).toHaveValue('다음 항목');
});

for (const [path, label] of [
  ['attempts', '실행 기록'], ['verifications', '검증 결과'], ['history', '이력'], ['messages', '메시지'],
] as const) {
  test(`R6 ${label} 읽기 실패(503): 로딩에 머물지 않고 원인과 「다시 시도」, 다시 시도 성공 후 목록`, async ({ page }) => {
    const { api } = await open(page, '/wbs/TASK-0007');
    let fail = true;
    const original = `GET /api/tasks/TASK-0007/${path}`;
    api.on(original, async (route) => {
      if (fail) return json(route, 503, errorBody('UNAVAILABLE', { message: '서버가 응답하지 않습니다.' }));
      const { attempts, verifications, history, messages } = await import('./support/task-api.ts');
      const st = newStore();
      const items = path === 'attempts' ? attempts(st, 'TASK-0007') : path === 'verifications' ? verifications(st, 'TASK-0007').vs : path === 'history' ? history(st, 'TASK-0007') : messages(st, 'TASK-0007');
      return json(route, 200, { items, nextCursor: null });
    });
    await page.reload();
    await page.getByRole('tab', { name: new RegExp(`^${label === '실행 기록' ? '실행' : label === '검증 결과' ? '검증·Evidence' : label}`) }).click();
    const card = page.locator('.dt-body').getByRole('alert');
    await expect(card).toContainText(`${label}을(를) 불러오지 못했습니다`);
    await expect(card).toContainText('503 UNAVAILABLE');
    fail = false;
    await card.getByRole('button', { name: '다시 시도' }).click();
    await expect(page.locator('.dt-body').getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.dt-body')).not.toContainText('불러오는 중');
  });
}

test('R6 Evidence 읽기 실패는 「없음」이 아니라 실패로 보인다', async ({ page }) => {
  const { api } = await open(page, '/wbs/TASK-0007?tab=verif');
  api.on('GET /api/evidence', (route) => json(route, 503, errorBody('UNAVAILABLE')));
  await page.reload();
  await expect(page.getByRole('article', { name: /FAIL/ })).toContainText('Evidence를 불러오지 못했습니다');
});

test('R7 접근성: 9탭과 기술 설계 표에 ARIA 구조 위반이 없고, 탭은 패널과 연결되며 방향키로 옮긴다', async ({ page }) => {
  await open(page, '/wbs/TASK-0004');
  const tabs = page.getByRole('tablist', { name: 'Task 상세 탭' }).getByRole('tab');
  for (const tab of await tabs.all()) {
    await tab.click();
    const name = await tab.innerText();
    const r = await new AxeBuilder({ page }).include('.detail').analyze();
    expect(r.violations.map((v) => `${name} ${v.id}`), name).toEqual([]);
  }
  const first = tabs.first();
  await first.click();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', (await first.getAttribute('id')) ?? 'x');
  await first.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
});

test('R3 등급 고정 API가 서버에 아직 없으면(404) 「서버 기능 대기」를 분명히 알리고 등급은 바뀐 것처럼 보이지 않는다', async ({ page }) => {
  const { api } = await open(page, '/wbs/TASK-0004');
  api.on('PUT /api/tasks/TASK-0004/grade', (route) => json(route, 404, errorBody('NOT_FOUND', { message: '요청한 경로가 없습니다.' })));
  const dev = page.locator('.runrow').first();
  await dev.getByRole('button', { name: '변경 · 고정' }).click();
  await dev.getByRole('button', { name: '저장 · 고정' }).click();
  await expect(dev.getByRole('note')).toContainText('등급 변경 · 고정은 서버 기능이 준비되면 사용할 수 있습니다');
  await expect(dev.locator('.tag').nth(1)).toHaveText('Planning Agent 판단');
});

test('R8 개요 편집: 작업량·토큰·고정 시작일은 서버 계약 확장 전까지 읽기 전용 자리와 안내를 둔다', async ({ page }) => {
  await open(page, '/wbs/TASK-0004');
  await page.getByRole('button', { name: '개요 편집' }).click();
  const row = page.locator('.frow').filter({ hasText: '예상 실행 시간' });
  await expect(row).toContainText('4h');
  await expect(row).toContainText('서버 계약이 확장되면 여기서 편집합니다');
});
