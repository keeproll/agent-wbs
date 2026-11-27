/**
 * 독립 리뷰 eebac50의 결함 재현 시험(먼저 실패를 확인한 뒤 고쳤다).
 * #1 자동 갱신 실패 때 초안 보존, #3 재시도는 처음 요청 그대로, #4 다시 적용 실패 안내, #6 로그아웃 실패 안내.
 */
import { expect, test } from '@playwright/test';
import { ACTIVE_PROJECT, errorBody, fakeApi, hold, json } from './support/fake-api.ts';

const V1 = '2026-11-26T01:00:00.000000Z';
const V2 = '2026-11-26T01:03:00.000000Z';

test('#1 화면 표시 뒤 프로젝트 갱신이 실패해도 편집 중인 초안을 지우지 않고 오류 막대로 알린다', async ({ page }) => {
  const api = await fakeApi(page);
  let pending: { seq: number; topic: string } | null = null;
  api.on('GET /api/changes', (route, request) => {
    const after = Number(new URL(request.url()).searchParams.get('after'));
    if (pending && after < pending.seq) return json(route, 200, { events: [{ ...pending, ref: null, at: '2026-11-26T01:00:00Z' }], next: pending.seq, reset: false });
    return json(route, 200, { events: [], next: after, reset: false });
  });
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: '원래 제목', updatedAt: V1 }));
  await page.goto('/_states');
  await page.getByRole('button', { name: '편집' }).click();
  await page.getByLabel('제목').fill('사라지면 안 되는 초안');

  api.on('GET /api/project', (route) => json(route, 503, errorBody('UNAVAILABLE', { message: 'DB에 연결할 수 없습니다.', fix: '잠시 후 다시 시도하세요.' })));
  pending = { seq: 5, topic: 'project' };
  const bar = page.getByRole('alert');
  await expect(bar).toContainText('최신 내용을 불러오지 못했습니다', { timeout: 8_000 });
  await expect(bar).toContainText('503 UNAVAILABLE');
  await expect(page.getByLabel('제목')).toHaveValue('사라지면 안 되는 초안');
  await expect(page.getByRole('region', { name: /화면을 불러오지 못했습니다/ })).toHaveCount(0);

  api.on('GET /api/project', (route) => json(route, 200, ACTIVE_PROJECT));
  await bar.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('제목')).toHaveValue('사라지면 안 되는 초안');
});

test('#3 재시도는 처음 요청 내용과 멱등 키를 그대로 보내고, 결과를 모르는 동안 바뀐 입력은 새 저장으로 보내지 않는다', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: '원래 제목', updatedAt: V1 }));
  api.on('POST /api/messages', (route) => json(route, 503, errorBody('UNAVAILABLE')));
  await page.goto('/_states');
  const box = page.getByLabel('메시지');
  await box.fill('첫 입력');
  await page.getByRole('button', { name: '메시지 초안 만들기' }).click();
  const bar = page.getByRole('alert');
  await expect(bar).toContainText('503 UNAVAILABLE');

  await box.fill('수정된 입력');
  // 결과를 모르는 이전 요청이 있으면 새 저장을 보내지 않고 먼저 해결하라고 안내한다.
  await page.getByRole('button', { name: '메시지 초안 만들기' }).click();
  await expect(bar).toContainText('이전 요청의 결과를 아직 모릅니다');
  expect(api.requests('POST /api/messages')).toHaveLength(1);

  api.on('POST /api/messages', (route) => json(route, 201, { id: 'm1' }));
  await bar.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const posts = api.requests('POST /api/messages');
  expect(posts).toHaveLength(2);
  expect(posts.map((r) => (r.postDataJSON() as { body: string }).body)).toEqual(['첫 입력', '첫 입력']);
  expect(posts[1]?.headers()['idempotency-key']).toBe(posts[0]?.headers()['idempotency-key']);

  // 해결된 뒤 바뀐 입력은 새 키로 보낸다.
  await page.getByRole('button', { name: '메시지 초안 만들기' }).click();
  await expect.poll(() => api.requests('POST /api/messages').length).toBe(3);
  const third = api.requests('POST /api/messages')[2];
  expect((third?.postDataJSON() as { body: string }).body).toBe('수정된 입력');
  expect(third?.headers()['idempotency-key']).not.toBe(posts[0]?.headers()['idempotency-key']);
});

test('재리뷰 #2 오류 막대를 닫아도 결과 모르는 요청은 남는다: 같은 입력은 같은 키로, 다른 입력은 막는다', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: '원래 제목', updatedAt: V1 }));
  // 서버는 처리했지만 응답만 잃은 상황
  const processed = new Set<string>();
  api.on('POST /api/messages', (route, request) => {
    processed.add(request.headers()['idempotency-key'] ?? '');
    return route.abort('connectionreset');
  });
  await page.goto('/_states');
  await page.getByLabel('메시지').fill('첫 입력');
  await page.getByRole('button', { name: '메시지 초안 만들기' }).click();
  await expect(page.getByRole('alert')).toContainText('NETWORK_ERROR');
  await page.getByRole('alert').getByRole('button', { name: '닫기' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // 입력을 바꾸지 않고 다시 만들기 → 같은 키(서버가 중복으로 처리하지 않는다)
  api.on('POST /api/messages', (route, request) => { processed.add(request.headers()['idempotency-key'] ?? ''); return json(route, 201, { id: 'm1' }); });
  await page.getByLabel('메시지').fill('바뀐 입력');
  await page.getByRole('button', { name: '메시지 초안 만들기' }).click();
  await expect(page.getByRole('alert')).toContainText('이전 요청의 결과를 아직 모릅니다');
  expect(api.requests('POST /api/messages')).toHaveLength(1);
  await page.getByLabel('메시지').fill('첫 입력');
  await page.getByRole('button', { name: '메시지 초안 만들기' }).click();
  await expect.poll(() => api.requests('POST /api/messages').length).toBe(2);
  expect(processed.size).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('재리뷰 #1 이전 요청의 재시도가 성공해도 그 뒤에 고친 초안은 지우지 않는다', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: '원래 제목', updatedAt: V1 }));
  api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, 500, errorBody('INTERNAL')));
  await page.goto('/_states');
  await page.getByRole('button', { name: '편집' }).click();
  await page.getByLabel('제목').fill('첫 입력 A');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('500 INTERNAL');
  await page.getByLabel('제목').fill('나중 입력 B');

  api.on('PATCH /api/tasks/TASK-0001', (route, request) => {
    const body = request.postDataJSON() as { title: string };
    return json(route, 200, { task: { taskKey: 'TASK-0001', title: body.title, updatedAt: V2 }, changes: [] });
  });
  await page.getByRole('alert').getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(api.requests('PATCH /api/tasks/TASK-0001').map((r) => (r.postDataJSON() as { title: string }).title)).toEqual(['첫 입력 A', '첫 입력 A']);
  // 새 초안은 그대로, 편집도 열린 채다. 다시 저장하면 최신 버전 위에 B를 보낸다.
  await expect(page.getByLabel('제목')).toHaveValue('나중 입력 B');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByTestId('title')).toHaveText('나중 입력 B');
  const last = api.requests('PATCH /api/tasks/TASK-0001').at(-1)?.postDataJSON() as { title: string; updatedAt: string };
  expect(last).toEqual({ title: '나중 입력 B', updatedAt: V2 });
});

test('#4 충돌 뒤 다시 적용이 실패하면 창을 닫지 않고 실패 이유를 보이며, 성공해야 닫힌다', async ({ page }) => {
  const api = await fakeApi(page);
  let version = V1;
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: '서버 제목', updatedAt: version }));
  api.on('PATCH /api/tasks/TASK-0001', (route) => { version = V2; return json(route, 409, errorBody('VERSION_CONFLICT', { details: { changes: [] } })); });
  await page.goto('/_states');
  await page.getByRole('button', { name: '편집' }).click();
  await page.getByLabel('제목').fill('내 제목');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '다른 변경이 먼저 저장되었습니다' });
  await expect(dialog).toBeVisible();

  api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, 500, errorBody('INTERNAL', { message: '서버에서 요청을 처리하지 못했습니다.', fix: '잠시 후 다시 시도하세요.' })));
  await dialog.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('다시 적용하지 못했습니다');
  await expect(dialog.getByRole('alert')).toContainText('500 INTERNAL');
  await expect(page.getByLabel('제목')).toHaveValue('내 제목');

  api.on('PATCH /api/tasks/TASK-0001', (route, request) => json(route, 200, { task: { taskKey: 'TASK-0001', title: (request.postDataJSON() as { title: string }).title, updatedAt: '2026-11-26T01:09:00Z' }, changes: [] }));
  await dialog.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('내 제목');
  const sent = api.requests('PATCH /api/tasks/TASK-0001').map((r) => (r.postDataJSON() as { updatedAt: string }).updatedAt);
  expect(sent).toEqual([V1, V2, V2]);
});

test('#4 다시 적용 중 최신 내용을 읽지 못해도 창 안에서 알린다', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: '서버 제목', updatedAt: V1 }));
  api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, 409, errorBody('VERSION_CONFLICT')));
  await page.goto('/_states');
  await page.getByRole('button', { name: '편집' }).click();
  await page.getByLabel('제목').fill('내 제목');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  api.on('GET /api/tasks/TASK-0001', (route) => route.abort('connectionrefused'));
  const dialog = page.getByRole('alertdialog', { name: '다른 변경이 먼저 저장되었습니다' });
  await dialog.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(dialog.getByRole('alert')).toContainText('NETWORK_ERROR');
  await expect(dialog).toBeVisible();
});

test('#6 로그아웃이 실패하면 화면에 실패와 다시 시도를 보이고, 처리 중에는 버튼을 막는다', async ({ page }) => {
  const api = await fakeApi(page);
  const slow = hold((route) => json(route, 500, errorBody('INTERNAL', { message: '세션을 지우지 못했습니다.', fix: '잠시 후 다시 시도하세요.' })));
  api.on('DELETE /api/auth/session', slow.handler);
  await page.goto('/dashboard');
  const logout = page.getByRole('button', { name: /로그아웃/ });
  await logout.click();
  await expect(logout).toBeDisabled();
  slow.release();
  const bar = page.getByRole('alert');
  await expect(bar).toContainText('로그아웃하지 못했습니다 — 서버 오류');
  await expect(bar).toContainText('500 INTERNAL');
  await expect(page).toHaveURL('/dashboard');

  let loggedOut = false;
  api.on('DELETE /api/auth/session', (route) => { loggedOut = true; return route.fulfill({ status: 204 }); });
  api.on('GET /api/session', (route) => (loggedOut ? json(route, 401, errorBody('LEAD_UNAUTHORIZED')) : json(route, 200, { principal: 'lead', method: 'password', expiresAt: '2026-11-26T13:00:00.000Z', csrfToken: 'x' })));
  await bar.getByRole('button', { name: '다시 시도' }).click();
  await expect(page).toHaveURL(/\/login/);
});

// M3-04 보고 6: 오류 막대가 모달 overlay 아래에 깔리면 「다시 시도」를 누를 수 없다.
test('모달 안 저장이 실패하면 오류 막대가 모달 위에 떠서 「다시 시도」를 누를 수 있고 키보드로도 닿는다', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: '원래 제목', updatedAt: V1 }));
  api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, 500, errorBody('INTERNAL')));
  await page.goto('/_states');
  await page.getByRole('button', { name: '창에서 제목 저장' }).click();
  const dialog = page.getByRole('dialog', { name: '창에서 저장' });
  await dialog.getByLabel('창 제목').fill('창에서 고친 제목');
  await dialog.getByRole('button', { name: '창에서 저장' }).click();
  const bar = page.getByRole('alert').filter({ hasText: '500 INTERNAL' });
  await expect(bar).toBeVisible();
  // 맨 위에 있는 요소가 오류 막대의 버튼이어야 한다(overlay에 가려지지 않음).
  const retry = bar.getByRole('button', { name: '다시 시도' });
  const onTop = await retry.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  expect(onTop).toBe(true);
  // 키보드: 모달 안에서 Tab을 돌면 오류 막대 버튼에도 닿는다.
  let reached = false;
  for (let i = 0; i < 8 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await retry.evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);

  api.on('PATCH /api/tasks/TASK-0001', (route, request) => json(route, 200, { task: { taskKey: 'TASK-0001', title: (request.postDataJSON() as { title: string }).title, updatedAt: V2 }, changes: [] }));
  await retry.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('창에서 고친 제목');
});

// M3-02 7cddacd를 공통으로: 충돌 창 「최신 내용 불러오기」는 끝날 때까지 기다리고, 실패하면 창을 열어 둔 채 이유를 보인다.
test('충돌 창의 최신 불러오기가 실패하면 창을 닫지 않고 이유를 보이며, 다시 누르면 불러온다', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: '원래 제목', updatedAt: V1 }));
  api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, 409, errorBody('VERSION_CONFLICT')));
  await page.goto('/_states');
  await page.getByRole('button', { name: '편집' }).click();
  await page.getByLabel('제목').fill('내 제목');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '다른 변경이 먼저 저장되었습니다' });
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 503, errorBody('UNAVAILABLE')));
  await dialog.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' }).click();
  await expect(dialog.getByRole('alert')).toContainText('최신 내용을 불러오지 못했습니다');
  await expect(dialog.getByRole('alert')).toContainText('503 UNAVAILABLE');
  await expect(page.getByLabel('제목')).toHaveValue('내 제목');
  await expect(page.locator('.notice')).toHaveCount(0);

  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: '서버 제목', updatedAt: V2 }));
  await dialog.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.notice')).toContainText('최신 내용을 불러왔습니다');
  await expect(page.getByTestId('title')).toHaveText('서버 제목');
});

// 재리뷰 63d2a25: 최신 불러오기 중 Esc로 창을 닫으면 진행 중 불러오기를 취소하고 결과를 화면에 적용하지 않는다.
test('최신 불러오기 대기 중 Esc로 닫으면 불러오기가 취소되고, 그 뒤 쓴 입력은 늦은 응답에 지워지지 않는다', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: '원래 제목', updatedAt: V1 }));
  api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, 409, errorBody('VERSION_CONFLICT')));
  await page.goto('/_states');
  await page.getByRole('button', { name: '편집' }).click();
  await page.getByLabel('제목').fill('내 변경 A');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '다른 변경이 먼저 저장되었습니다' });
  await expect(dialog).toBeVisible();

  const slow = hold((route) => json(route, 200, { taskKey: 'TASK-0001', title: '최신 서버 제목', updatedAt: V2 }).catch(() => undefined));
  api.on('GET /api/tasks/TASK-0001', slow.handler);
  await dialog.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' }).click();
  await expect(dialog.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' })).toBeDisabled();
  const loading = await slow.started;
  const cancelled = page.waitForEvent('requestfailed', { predicate: request => request === loading });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('제목').fill('창을 닫은 뒤 새로 작성한 B');
  slow.release();
  // 늦은 응답이 와도 입력·편집 상태는 그대로이고 「불러왔습니다」 안내도 없다.
  await cancelled;
  await expect(page.getByLabel('제목')).toHaveValue('창을 닫은 뒤 새로 작성한 B');
  await expect(page.locator('.notice')).toHaveCount(0);
});

test('다시 적용(저장) 진행 중에는 Esc로 창이 닫히지 않는다(서버 저장은 되돌릴 수 없으므로)', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: '원래 제목', updatedAt: V1 }));
  api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, 409, errorBody('VERSION_CONFLICT')));
  await page.goto('/_states');
  await page.getByRole('button', { name: '편집' }).click();
  await page.getByLabel('제목').fill('내 제목');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '다른 변경이 먼저 저장되었습니다' });
  const slow = hold((route) => json(route, 200, { task: { taskKey: 'TASK-0001', title: '내 제목', updatedAt: V2 }, changes: [] }));
  api.on('PATCH /api/tasks/TASK-0001', slow.handler);
  await dialog.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(dialog.getByRole('button', { name: '다시 적용 중…' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  slow.release();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('title')).toHaveText('내 제목');
});
