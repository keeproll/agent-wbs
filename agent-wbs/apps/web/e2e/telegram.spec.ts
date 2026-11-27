import { expect, test, type Page } from '@playwright/test';
import { fakeApi, json, errorBody, type FakeApi, type Handler } from './support/fake-api.ts';
import { settingsApi } from './support/settings-fixtures.ts';
import { join } from 'node:path';
import { copyFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const initial = { enabled: false, targetName: '', chatId: null, tokenSet: false, tokenLast4: null, bot: null, chat: null, test: null, updatedAt: null };
const paths = ['/wbs/TASK-0001', '/change/CP-0001', '/ci/CI-0127', '/settings/runner', '/project', '/design'];
const history = [...paths, '/settings/notify'].map((path, index) => ({ id: `log-${index}`, at: '2026-11-27T01:00:00Z',
  projectName: '시나리오 프로젝트', kind: index === 6 ? 'test' : 'biz', event: index === 6 ? null : 'admin', target: `대상 ${index}`,
  path, targetName: '팀장 개인 알림', chatId: '512345678', state: index === 0 ? 'sending' : index === 2 ? 'failed' : index === 3 ? 'retry_wait' : 'accepted', attempts: 1, duplicates: 0,
  error: index === 1 ? '중복 도착 가능' : index === 2 ? '전송 권한 없음 · 봇 차단(403)' : index === 3 ? '요청 제한(429) — 재시도 대기' : null, message: `실제로 보낸 메시지 ${index}\n대상: ${path}` }));
function historyApi(api: FakeApi) {
  api.on('GET /api/projects/p1/notify/log', (route, request) => {
    const kind = new URL(request.url()).searchParams.get('kind');
    return json(route, 200, { items: history.filter(row => !kind || row.kind === kind), nextCursor: null });
  });
  for (const row of history) api.on(`GET /api/projects/p1/notify/log/${row.id}`, route => json(route, 200, row));
}

// 본문 상자가 스크롤되므로 원본 캡처와 같이 본문 길이만큼 화면을 늘린다.
async function fullCapture(page: Page, name: string) {
  const size = page.viewportSize();
  if (!size) throw new Error('화면 크기 없음');
  const extra = await page.evaluate(() => Math.max(0, ...Array.from(document.querySelectorAll('.main,.main *'))
    .filter(e => /auto|scroll/.test(getComputedStyle(e).overflowY)).map(e => e.scrollHeight - e.clientHeight)));
  await page.setViewportSize({ width: size.width, height: size.height + extra });
  const historyBox = await page.getByRole('region', { name: '전송 이력', exact: true }).boundingBox();
  expect(historyBox).not.toBeNull();
  expect((historyBox?.y ?? 0) + (historyBox?.height ?? 0)).toBeLessThanOrEqual(size.height + extra);
  expect(extra).toBeGreaterThan(0);
  if (process.env.AWBS_TEST_ARTIFACT_DIR) {
    await page.screenshot({ path: join(process.env.AWBS_TEST_ARTIFACT_DIR, name), animations: 'disabled', caret: 'hide' });
    await writeFile(join(process.env.AWBS_TEST_ARTIFACT_DIR, `${name}.json`), JSON.stringify({ width: size.width, height: size.height + extra, historyBox }));
  }
  await page.setViewportSize(size);
}
function telegramApi(api: FakeApi) {
  settingsApi(api);
  api.on('GET /api/notify/telegram', route => json(route, 200, initial));
  api.on('GET /api/projects/p1/notify/rules', route => json(route, 200, { done: false, fail: true, admin: true, approve: true, buildOk: false, buildFail: true, updatedAt: null }));
  api.on('GET /api/settings/app-url', route => json(route, 200, { appUrl: null, updatedAt: null }));
  api.on('GET /api/projects/p1/notify/preview', route => json(route, 200, { text: '[Agent WBS] Task 완료\n상태: WBS 최종 완료 (예시)' }));
  api.on('GET /api/projects/p1/notify/log', route => json(route, 200, { items: [], nextCursor: null }));
  api.on('POST /api/notify/telegram/check-bot', route => json(route, 200, { ok: true, error: null, retryAfter: null, bot: { id: 123, username: 'test_bot', name: '시험 봇' } }));
  api.on('POST /api/notify/telegram/test', route => json(route, 200, { ok: true, error: null, retryAfter: null }));
  api.on('POST /api/notify/telegram/find-chats', route => json(route, 200, { ok: true, error: null, retryAfter: null,
    candidates: [{ chatId: '-4123456789', title: '개발 그룹', type: 'group', lastAt: '2026-11-27T01:00:00Z' }] }));
}

test('telegram UAT-TG-01/02/03: 테스트 후 활성화, 저장 실패 초안 유지, 토큰은 브라우저 저장소에 없다', async ({ page }) => {
  const api = await fakeApi(page); telegramApi(api);
  api.on('PUT /api/notify/telegram', route => json(route, 500, errorBody('INTERNAL')));
  await page.goto('/settings/notify');
  const card = page.getByRole('region', { name: 'Telegram 연결 설정' });
  await expect(card.getByRole('button', { name: '켜기', exact: true })).toBeDisabled();
  const token = `123456789:${'fake_only_'.repeat(4)}abcd`;
  await card.getByLabel('Bot Token', { exact: true }).fill(token);
  await expect(card.locator('.dp-h')).toContainText('봇 확인 필요');
  await card.getByRole('button', { name: '봇 확인', exact: true }).click();
  await expect(card.locator('.dp-h')).toContainText('수신 대상 테스트 필요');
  await expect(card.getByText('시험 봇 · @test_bot')).toBeVisible();
  await card.getByLabel('수신 대상 이름').fill('팀장');
  await card.getByLabel('Chat ID', { exact: true }).fill('-4123456789');
  await expect(card.getByText('시험 봇 · @test_bot')).toBeVisible();
  await card.getByRole('button', { name: '테스트 알림 보내기', exact: true }).click();
  await expect(card.getByText(/전송 요청 수락/)).toBeVisible();
  await card.getByRole('button', { name: '켜기', exact: true }).click();
  await card.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '저장하지 못했습니다' })).toBeVisible();
  await expect(card.getByLabel('수신 대상 이름')).toHaveValue('팀장');
  await expect(card.getByLabel('Bot Token', { exact: true })).toHaveValue(token);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(token);
  await card.getByLabel('Chat ID', { exact: true }).fill('512345678');
  await expect(card.getByRole('button', { name: '켜기', exact: true })).toBeDisabled();
});

for (const failure of ['400', '500', 'network']) test(`telegram UAT-TG-03: 세 폼의 ${failure} 저장 실패도 초안을 보존한다`, async ({ page }) => {
  const api = await fakeApi(page); telegramApi(api);
  const reject: Handler = route => failure === 'network' ? route.abort('failed') : json(route, Number(failure), errorBody(failure === '400' ? 'VALIDATION_FAILED' : 'INTERNAL'));
  api.on('PUT /api/notify/telegram', reject);
  api.on('PUT /api/projects/p1/notify/rules', reject);
  api.on('PUT /api/settings/app-url', reject);
  await page.goto('/settings/notify');
  const connection = page.getByRole('region', { name: 'Telegram 연결 설정' });
  await connection.getByLabel('Bot Token', { exact: true }).fill(`123456789:${'fake_only_'.repeat(4)}abcd`);
  await connection.getByLabel('Chat ID', { exact: true }).fill('-4123456789');
  await connection.getByLabel('수신 대상 이름', { exact: true }).fill('초안 수신 대상');
  await connection.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '저장하지 못했습니다' })).toBeVisible();
  await expect(connection.getByLabel('수신 대상 이름')).toHaveValue('초안 수신 대상');
  const rules = page.getByRole('region', { name: '알림 규칙', exact: true });
  await rules.getByRole('checkbox', { name: /Task 완료/ }).check();
  await rules.getByRole('button', { name: '저장', exact: true }).click();
  await expect(rules.getByRole('checkbox', { name: /Task 완료/ })).toBeChecked();
  await rules.getByRole('button', { name: '변경 취소', exact: true }).click();
  await expect(rules.getByRole('checkbox', { name: /Task 완료/ })).not.toBeChecked();
  const url = page.getByRole('region', { name: 'Agent WBS 접속 주소', exact: true });
  await url.getByLabel('접속 주소', { exact: true }).fill('http://127.0.0.1:3100');
  await expect(url.getByText(/이 PC에서만 열림/)).toBeVisible();
  await url.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '저장하지 못했습니다' })).toBeVisible();
  await expect(url.getByLabel('접속 주소', { exact: true })).toHaveValue('http://127.0.0.1:3100');
});

test('telegram UAT-TG-04/06/EMPTY-08: 후보 선택은 입력만 변경, 모달 초점 복원, 꺼진 미리보기/빈 이력', async ({ page }) => {
  const api = await fakeApi(page); telegramApi(api);
  await page.goto('/settings/notify');
  const card = page.getByRole('region', { name: 'Telegram 연결 설정' });
  await card.getByLabel('Bot Token', { exact: true }).fill(`123456789:${'fake_only_'.repeat(4)}abcd`);
  const opener = card.getByRole('button', { name: '수신 대상 찾기' });
  await opener.click();
  const modal = page.getByRole('dialog', { name: '수신 대상 찾기' });
  const titleId = await modal.getAttribute('aria-labelledby');
  expect(titleId).toBeTruthy();
  await expect(page.locator(`[id="${titleId}"]`)).toHaveCount(1);
  await expect(modal.getByRole('button', { name: '최근 대화 조회' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(modal.getByRole('button', { name: '취소', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(modal.getByRole('button', { name: '최근 대화 조회' })).toBeFocused();
  await modal.getByRole('button', { name: '최근 대화 조회' }).click();
  await expect(modal.getByRole('button', { name: '이 대화 선택' })).toBeDisabled();
  await modal.getByRole('radio', { name: /개발 그룹/ }).check();
  await modal.getByRole('button', { name: '이 대화 선택' }).click();
  await expect(card.getByLabel('Chat ID', { exact: true })).toHaveValue('-4123456789');
  await expect(opener).toBeFocused();
  expect(api.calls().filter(c => c.startsWith('PUT /api/notify'))).toHaveLength(0);
  await expect(page.getByText('현재 알림 규칙에서 꺼져 있어 이 이벤트는 보내지 않습니다.')).toBeVisible();
  await expect(page.getByText('전송 이력이 없습니다. 연결을 설정하고 테스트 알림을 보내 보세요.')).toBeVisible();
  await opener.click(); await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
});

test('telegram UI-12-05: 원본 클래스의 연결/규칙/미리보기/주소/이력 배치와 1280px 가로 넘침', async ({ page }) => {
  const api = await fakeApi(page); telegramApi(api);
  historyApi(api);
  api.on('GET /api/notify/telegram', route => json(route, 200, { ...initial, enabled: true, targetName: '팀장 개인 알림', chatId: '512345678', tokenSet: true, tokenLast4: 'xxxx',
    bot: { id: 123, username: 'test_bot', name: 'Agent WBS 알림' }, chat: { chatId: '512345678', title: '팀장 개인', type: 'private' }, test: { ok: true, error: null, at: '2026-11-27T01:00:00Z' } }));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/settings/notify');
  await expect(page.getByText('●●●● 등록됨 (끝 xxxx)')).toBeVisible();
  const connection = page.getByRole('region', { name: 'Telegram 연결 설정' });
  await expect(connection.getByText('알림 켜짐', { exact: true })).toBeVisible();
  await expect(connection.getByText('Agent WBS 알림 · @test_bot', { exact: true })).toBeVisible();
  await expect(connection.getByText('팀장 개인 · 개인', { exact: true })).toBeVisible();
  const badges = await connection.locator('.dp-h .vf').all();
  const firstBadge = await badges[0]?.boundingBox(), secondBadge = await badges[1]?.boundingBox();
  expect(firstBadge?.y).toBe(secondBadge?.y);
  expect((secondBadge?.x ?? 0) - (firstBadge?.x ?? 0) - (firstBadge?.width ?? 0)).toBeLessThan(12);
  await expect(page.getByRole('cell', { name: '대기', exact: true })).toHaveCount(1);
  await expect(page.getByRole('cell', { name: '팀장 개인 알림 (512345678)', exact: true })).toHaveCount(7);
  await expect(page.getByRole('region', { name: '메시지 미리보기', exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  if (process.env.AWBS_TEST_ARTIFACT_DIR) {
    await copyFile(join(homedir(), '.cache/agent-wbs-baseline/desktop/UI-12-05.full.png'), join(process.env.AWBS_TEST_ARTIFACT_DIR, 'telegram-prototype-1920.png'));
  }
  await fullCapture(page, 'telegram-settings-1920.png');
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await fullCapture(page, 'telegram-settings-1280.png');
  const card = page.getByRole('region', { name: 'Telegram 연결 설정' });
  await card.getByRole('button', { name: '토큰 교체', exact: true }).click();
  await card.getByLabel('Bot Token', { exact: true }).fill(`123456789:${'replacement_only_'.repeat(3)}abcd`);
  await card.getByRole('button', { name: '교체 취소', exact: true }).click();
  await expect(card.getByRole('button', { name: '켜기', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByText('●●●● 등록됨 (끝 xxxx)')).toBeVisible();
});

test('telegram UAT-TG-09: 빈 주소·localhost 경고·저장한 공용 주소와 실제 이력 필터', async ({ page }) => {
  const api = await fakeApi(page); telegramApi(api); historyApi(api);
  let appUrl: string | null = null;
  api.on('GET /api/settings/app-url', route => json(route, 200, { appUrl, updatedAt: null }));
  api.on('PUT /api/settings/app-url', (route, request) => { appUrl = (request.postDataJSON() as { appUrl: string | null }).appUrl; return json(route, 200, { appUrl, updatedAt: null }); });
  api.on('GET /api/projects/p1/notify/preview', route => json(route, 200, { text: `[Agent WBS] Task 완료${appUrl ? `\nWBS에서 확인: ${appUrl}/wbs/TASK-0001` : ''}` }));
  await page.goto('/settings/notify');
  const preview = page.getByRole('region', { name: '메시지 미리보기', exact: true });
  await expect(preview.locator('.tg-bubble')).not.toContainText('WBS에서 확인:');
  const card = page.getByRole('region', { name: 'Agent WBS 접속 주소', exact: true });
  await card.getByLabel('접속 주소', { exact: true }).fill('http://localhost:3100');
  await expect(card.getByText(/이 PC에서만 열림/)).toBeVisible();
  await card.getByLabel('접속 주소', { exact: true }).fill('http://192.168.0.10:3100');
  await card.getByRole('button', { name: '저장', exact: true }).click();
  await page.reload();
  await expect(preview.locator('.tg-bubble')).toContainText('WBS에서 확인: http://192.168.0.10:3100/wbs/TASK-0001');
  await card.getByLabel('접속 주소', { exact: true }).fill('');
  await card.getByRole('button', { name: '저장', exact: true }).click();
  await page.reload();
  await expect(preview.locator('.tg-bubble')).not.toContainText('WBS에서 확인:');
  const logs = page.getByRole('region', { name: '전송 이력', exact: true });
  await expect(logs.locator('tbody tr')).toHaveCount(7);
  await logs.getByRole('button', { name: '업무', exact: true }).click();
  await expect(logs.locator('tbody tr')).toHaveCount(6);
  await logs.getByRole('button', { name: '테스트', exact: true }).click();
  await expect(logs.locator('tbody tr')).toHaveCount(1);
  await logs.getByRole('button', { name: '전체', exact: true }).click();
  await expect(logs.locator('tbody tr')).toHaveCount(7);
});

for (const [index, path] of paths.entries()) test(`telegram UAT-TG-09: 실제 메시지와 ${path} 화면 이동`, async ({ page }) => {
  const api = await fakeApi(page); telegramApi(api); historyApi(api);
  await page.goto('/settings/notify');
  const logs = page.getByRole('region', { name: '전송 이력', exact: true });
  await logs.getByRole('button', { name: `대상 ${index}`, exact: true }).click();
  await expect(logs.locator('.tg-det .tg-bubble')).toHaveText(`실제로 보낸 메시지 ${index}\n대상: ${path}`);
  await logs.getByRole('link', { name: 'WBS에서 확인', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
});

test('telegram UAT-TG-08: 서버 자동 재시도 성공이 저장된 테스트 실패 표시를 해소한다', async ({ page }) => {
  const api = await fakeApi(page); telegramApi(api);
  let successful = true;
  api.on('GET /api/notify/telegram', route => json(route, 200, { ...initial, enabled: true, targetName: '팀장', chatId: '512345678', tokenSet: true, tokenLast4: 'abcd',
    test: { ok: successful, error: successful ? null : 'rate_limited', at: successful ? '2026-11-27T01:00:20Z' : '2026-11-27T01:00:00Z' } }));
  api.on('POST /api/notify/telegram/test', route => { successful = false; return json(route, 200, { ok: false, error: 'rate_limited', retryAfter: 15 }); });
  await page.goto('/settings/notify');
  const card = page.getByRole('region', { name: 'Telegram 연결 설정' });
  await card.getByRole('button', { name: '테스트 알림 보내기', exact: true }).click();
  await expect(card.getByText(/요청 제한\(429\)/)).toBeVisible();
  successful = true;
  api.on('GET /api/changes', (route, request) => {
    const first = new URL(request.url()).searchParams.get('after') === '0';
    return json(route, 200, { events: first ? [{ seq: 1, topic: 'notify', ref: 'telegram', at: '2026-11-27T01:00:20Z' }] : [], next: 1, reset: false });
  });
  await expect(card.getByText(/전송 요청 수락/)).toBeVisible();
  await expect(card.getByText(/요청 제한\(429\)/)).toHaveCount(0);
});

test('telegram UAT-TG-08: 저장 전 새 토큰의 429 테스트도 재시도 성공 뒤 켜기를 허용한다', async ({ page }) => {
  const api = await fakeApi(page); telegramApi(api);
  let successful = false;
  const testId = '11111111-1111-4111-8111-111111111111';
  api.on('GET /api/notify/telegram', (route, request) => json(route, 200, new URL(request.url()).searchParams.has('testId')
    ? { ...initial, test: { ok: successful, error: successful ? null : 'rate_limited', at: '2026-11-27T01:00:20Z' } } : initial));
  api.on('POST /api/notify/telegram/test', route => json(route, 200, { ok: false, error: 'rate_limited', retryAfter: 15, testId }));
  await page.goto('/settings/notify');
  const card = page.getByRole('region', { name: 'Telegram 연결 설정' });
  await card.getByLabel('Bot Token', { exact: true }).fill(`123456789:${'fake_only_'.repeat(4)}abcd`);
  await card.getByLabel('Chat ID', { exact: true }).fill('-4123456789');
  await card.getByLabel('수신 대상 이름').fill('저장 전 초안');
  await card.getByRole('button', { name: '테스트 알림 보내기', exact: true }).click();
  await expect(card.getByText(/요청 제한\(429\)/)).toBeVisible();
  successful = true;
  api.on('GET /api/changes', (route, request) => json(route, 200, {
    events: new URL(request.url()).searchParams.get('after') === '0' ? [{ seq: 1, topic: 'notify', ref: testId, at: '2026-11-27T01:00:20Z' }] : [], next: 1, reset: false,
  }));
  await expect(card.getByText(/전송 요청 수락/)).toBeVisible();
  await expect(card.getByRole('button', { name: '켜기', exact: true })).toBeEnabled();
});
