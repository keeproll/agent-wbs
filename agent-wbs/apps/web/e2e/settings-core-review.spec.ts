/**
 * M3-08 독립 리뷰(624c334) 지적 재발 방지 — 설정 덮어쓰기 두 경로, 모델 순서 초기값, 추가 전 불가일 입력, 일정 갱신 실패.
 * 리뷰 재현: ~/.orca/bots/agentwbs/archive/2026-11-26/M3-08-independent-624c334/repro/review-regressions.spec.ts
 */
import { expect, test } from '@playwright/test';
import { errorBody, fakeApi, json } from './support/fake-api.ts';
import { EXEC, MODELS, settingsApi, V1, V2 } from './support/settings-fixtures.ts';

const V3 = '2026-11-05T03:00:00.000Z';
const execCard = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Agent 실행 정책 — 모델 · Effort' });

test('지적 1: 편집 중 다른 탭의 저장이 화면에 다시 읽혀도, 저장은 편집을 시작한 버전으로 보내 충돌 창을 띄운다', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  let current = { ...EXEC };
  let changed = false;
  let gets = 0;
  const sent: Record<string, unknown>[] = [];
  api.on('GET /api/settings/exec-policy', (route) => { gets += 1; return json(route, 200, current); });
  api.on('GET /api/changes', (route) => json(route, 200, { events: changed ? [{ seq: 1, topic: 'settings', ref: null, at: V2 }] : [], next: changed ? 1 : 0, reset: false }));
  api.on('PUT /api/settings/exec-policy', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    return body.updatedAt === current.updatedAt ? json(route, 200, { ...current, ...body, updatedAt: V3 }) : json(route, 409, errorBody('VERSION_CONFLICT'));
  });
  await page.goto('/settings/agent');
  await execCard(page).getByRole('group', { name: '낮춤 기준' }).getByRole('button', { name: '30%' }).click();
  const before = gets;
  current = { ...EXEC, notifyAt: 3, updatedAt: V2 };
  changed = true;
  await expect.poll(() => gets, { timeout: 10_000 }).toBeGreaterThan(before);
  // 내 초안(30%)은 그대로 보인다.
  await expect(execCard(page).getByRole('group', { name: '낮춤 기준' }).getByRole('button', { name: '30%' })).toHaveAttribute('aria-pressed', 'true');
  await execCard(page).getByRole('button', { name: '저장', exact: true }).last().click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]?.updatedAt).toBe(V1);
  await expect(page.getByRole('alertdialog')).toBeVisible();
});

test('지적 2: 다시 적용은 내가 바꾼 항목만 최신 값 위에 얹고, 바꾸지 않은 다른 변경(알림 횟수 3)은 지킨다', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  const sent: Record<string, unknown>[] = [];
  api.on('PUT /api/settings/exec-policy', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    return sent.length === 1 ? json(route, 409, errorBody('VERSION_CONFLICT')) : json(route, 200, { ...body, updatedAt: V3 });
  });
  await page.goto('/settings/agent');
  await execCard(page).getByRole('group', { name: '낮춤 기준' }).getByRole('button', { name: '30%' }).click();
  api.on('GET /api/settings/exec-policy', (route) => json(route, 200, { ...EXEC, notifyAt: 3, updatedAt: V2 }));
  await execCard(page).getByRole('button', { name: '저장', exact: true }).last().click();
  const modal = page.getByRole('alertdialog');
  await modal.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(modal).toHaveCount(0);
  expect(sent[1]).toMatchObject({ updatedAt: V2, lowPct: 30, notifyAt: 3 });
  // 저장 뒤 화면은 합친 결과이고 남은 초안이 없다.
  await expect(execCard(page).getByRole('group', { name: '최상위 등급 재작업 알림' }).getByRole('button', { name: '3회째' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('저장하지 않은 변경이 있습니다.')).toHaveCount(0);
});

test('지적 2: 다시 적용이 500으로 끝나면 다음 다시 적용은 최신을 다시 읽지 않고 같은 본문으로 보낸다(공통 useSave reapplyRequest)', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  const sent: Record<string, unknown>[] = [];
  const keys: (string | undefined)[] = [];
  api.on('PUT /api/settings/exec-policy', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    keys.push(route.request().headers()['idempotency-key']);
    if (sent.length === 1) return json(route, 409, errorBody('VERSION_CONFLICT'));
    if (sent.length === 2) return json(route, 500, errorBody('INTERNAL'));
    return json(route, 200, { ...body, updatedAt: V3 });
  });
  await page.goto('/settings/agent');
  await execCard(page).getByRole('group', { name: '낮춤 기준' }).getByRole('button', { name: '30%' }).click();
  await execCard(page).getByRole('button', { name: '저장', exact: true }).last().click();
  api.on('GET /api/settings/exec-policy', (route) => json(route, 200, { ...EXEC, updatedAt: V2 }));
  const modal = page.getByRole('alertdialog');
  await modal.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(modal).toContainText('다시 적용하지 못했습니다');
  api.on('GET /api/settings/exec-policy', (route) => json(route, 200, { ...EXEC, updatedAt: V3 }));
  await modal.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]).toEqual(sent[1]);
  expect(keys[2]).toBe(keys[1]);
});

test('지적 2(GitHub 토큰): 토큰 저장 충돌의 다시 적용도 공통 경로로 최신 버전에 토큰을 보낸다', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  const sent: Record<string, unknown>[] = [];
  api.on('PUT /api/settings/github', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    return sent.length === 1 ? json(route, 409, errorBody('VERSION_CONFLICT'))
      : json(route, 200, { mode: 'token', tokenSet: true, status: 'ok', account: 'x', expiresAt: null, warning: null, scopes: null, updatedAt: V3 });
  });
  await page.goto('/settings/runner');
  const card = page.getByRole('region', { name: 'GitHub 연결' });
  await card.getByRole('group', { name: '인증 방식' }).getByRole('button', { name: '토큰 입력' }).click();
  const secret = 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
  await card.getByLabel('새 토큰').fill(secret);
  await card.getByRole('button', { name: '토큰 저장 · 확인' }).click();
  api.on('GET /api/settings/github', (route) => json(route, 200, { mode: 'gh', tokenSet: false, status: 'ok', account: 'y', expiresAt: null, warning: null, scopes: null, updatedAt: V2 }));
  await page.getByRole('alertdialog').getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(sent[1]).toMatchObject({ updatedAt: V2, mode: 'token', token: secret });
  await expect(card.getByLabel('새 토큰')).toHaveValue('');
});

test('지적 4: Runner 보고 전에도 설정된 모델 순서를 보이고 바꿀 수 있다(허용 모델은 추가하지 않음)', async ({ page }) => {
  const api = await fakeApi(page);
  const s = settingsApi(api);
  const order = { Claude: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'], Codex: ['gpt-6.2-astra', 'gpt-6.2-sol'] };
  api.on('GET /api/settings/models', (route) => json(route, 200, { ...MODELS, models: [], rankOrder: order }));
  api.on('PUT /api/settings/models', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    s.models.bodies.push(body);
    return json(route, 200, { ...MODELS, models: [], rankOrder: body.rankOrder ?? order, updatedAt: V2 });
  });
  await page.goto('/settings/agent');
  const claude = page.getByRole('region', { name: 'Claude 모델 표' });
  await expect(claude.locator('.gtr:not(.h) .mono.muted')).toHaveText(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  await expect(claude.getByText('보고 전').first()).toBeVisible();
  await expect(claude.getByRole('button', { name: '허용' })).toHaveCount(0);
  await claude.getByRole('button', { name: 'claude-haiku-5-5 순위 올리기' }).click();
  await execCard(page).getByRole('button', { name: '저장', exact: true }).first().click();
  await expect.poll(() => s.models.bodies.length).toBe(1);
  expect(s.models.bodies[0]).toEqual({ updatedAt: V1, models: [], rankOrder: { ...order, Claude: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-fable-5-2'] } });
});

test('지적 5: 추가 전 불가일 날짜·사유도 편집 보호 대상이다', async ({ page }) => {
  settingsApi(await fakeApi(page));
  await page.goto('/settings/plan');
  await page.getByLabel('날짜', { exact: true }).fill('2026-12-24');
  await page.getByLabel('사유', { exact: true }).fill('입력 중인 휴가');
  await page.getByRole('navigation', { name: '설정 영역' }).getByRole('link', { name: 'Agent', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '편집 내용 버리기' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page.getByLabel('날짜', { exact: true })).toHaveValue('2026-12-24');
});

test('지적 5: 추가 전 불가일 입력도 세션 만료 때 보관해 같은 화면에서 복원한다', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  await page.goto('/settings/plan');
  await page.getByLabel('날짜', { exact: true }).fill('2026-12-24');
  await page.getByLabel('사유', { exact: true }).fill('입력 중인 휴가');
  // 다른 카드 저장에서 세션 만료(401)가 나면 등록된 초안을 모두 보관한다.
  api.on('GET /api/session', (route) => json(route, 401, errorBody('LEAD_UNAUTHORIZED')));
  api.on('PUT /api/settings/split', (route) => json(route, 401, errorBody('LEAD_UNAUTHORIZED')));
  await page.getByRole('group', { name: '크기 상한' }).getByRole('button', { name: '6h' }).click();
  await page.getByRole('region', { name: 'Task 분할 기준' }).getByRole('button', { name: '저장', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
  expect(stored).toContain('입력 중인 휴가');
});

test('지적 6: 설정 저장 뒤 일정 다시 읽기가 실패하면 오류 막대와 다시 시도로 알린다', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  let fail = true;
  api.on('GET /api/schedule', (route) => (fail ? json(route, 500, errorBody('INTERNAL')) : json(route, 200, {})));
  await page.goto('/settings/plan');
  const card = page.getByRole('region', { name: '일정 재조정 정책 · 작업 불가일' });
  await card.getByRole('group', { name: '재조정 임계값' }).getByRole('button', { name: '3일' }).click();
  await card.getByRole('button', { name: '저장', exact: true }).first().click();
  await expect(page.getByText('설정을 저장했습니다.')).toBeVisible();
  const bar = page.getByRole('alert').filter({ hasText: '일정' });
  await expect(bar).toContainText('최신 일정을 불러오지 못했습니다');
  fail = false;
  await bar.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '최신 일정을 불러오지 못했습니다' })).toHaveCount(0);
});

test('재리뷰 c7f1bdb P2: 저장을 기다리는 동안 원래 값으로 되돌린 입력은 앞선 저장이 성공해도 남고, 성공 결과를 기준으로 다시 저장된다', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sent: Record<string, unknown>[] = [];
  api.on('PUT /api/settings/exec-policy', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    if (sent.length === 1) await gate;
    await json(route, 200, { ...EXEC, ...body, updatedAt: sent.length === 1 ? V2 : V3 });
  });
  await page.goto('/settings/agent');
  const card = execCard(page);
  const pct = card.getByRole('group', { name: '낮춤 기준' });
  await pct.getByRole('button', { name: '30%' }).click();
  await card.getByRole('button', { name: '저장', exact: true }).last().click();
  await expect(card.getByRole('button', { name: '저장 중…' })).toBeVisible();
  await pct.getByRole('button', { name: '20%' }).click();
  await expect(pct.getByRole('button', { name: '20%' })).toHaveAttribute('aria-pressed', 'true');
  release();
  await expect(page.getByText('설정을 저장했습니다.')).toBeVisible();
  // 서버는 이제 30%(V2)다. 나중에 고른 20%는 미저장 초안으로 남는다.
  await expect(pct.getByRole('button', { name: '20%' })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByText('저장하지 않은 변경이 있습니다.')).toBeVisible();
  await card.getByRole('button', { name: '저장', exact: true }).last().click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ updatedAt: V2, lowPct: 20 });
  await expect(card.getByText('저장하지 않은 변경이 있습니다.')).toHaveCount(0);
});
