/**
 * 설정 초안 규칙 하나를 이벤트·응답 순서를 섞어 고정한다(재리뷰 48a7f7a P2).
 *
 * 규칙: 내가 편집한 칸은 서버 변경 이벤트·자동 갱신·저장 응답이 덮어쓰지 않는다(칸마다 「편집됨」으로 기억).
 *       편집하지 않은 칸만 서버 최신 값을 따르고, 서버가 편집한 칸을 건드리지 않았으면 기준 버전만 새로 받는다.
 *       서버가 내가 편집한 칸을 바꿨으면(다른 탭) 기준 버전을 옮기지 않아 저장 때 409 충돌 창이 뜬다.
 */
import { expect, test, type Page } from '@playwright/test';
import { fakeApi, json } from './support/fake-api.ts';
import { EXEC, settingsApi, V1, V2 } from './support/settings-fixtures.ts';

const V3 = '2026-11-05T03:00:00.000Z';
type Exec = typeof EXEC;

/** 서버 흉내: PUT은 즉시 저장(커밋)하고 응답만 붙잡아 둘 수 있다. 변경 이벤트는 fire()로 보낸다. */
async function setup(page: Page) {
  const api = await fakeApi(page);
  settingsApi(api);
  let current: Exec = { ...EXEC };
  let seq = 0;
  let gets = 0;
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => undefined;
  const sent: Record<string, unknown>[] = [];
  api.on('GET /api/settings/exec-policy', (route) => { gets += 1; return json(route, 200, current); });
  api.on('GET /api/changes', (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0);
    const events = seq > after ? [{ seq, topic: 'settings', ref: null, at: V2 }] : [];
    return json(route, 200, { events, next: seq, reset: false });
  });
  api.on('PUT /api/settings/exec-policy', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    current = { ...current, ...body, updatedAt: sent.length === 1 ? V2 : V3 } as Exec;
    const reply = current;
    await gate;
    await json(route, 200, reply);
  });
  await page.goto('/settings/agent');
  const card = page.getByRole('region', { name: 'Agent 실행 정책 — 모델 · Effort' });
  return {
    card,
    sent,
    pct: card.getByRole('group', { name: '낮춤 기준' }),
    notify: card.getByRole('group', { name: '최상위 등급 재작업 알림' }),
    rework: card.getByRole('group', { name: '재작업 시' }),
    holdResponses: () => { gate = new Promise<void>((resolve) => { open = resolve; }); },
    release: () => { open(); },
    /** 다른 탭 저장 흉내 */
    serverSets: (patch: Partial<Exec>, version: string) => { current = { ...current, ...patch, updatedAt: version }; },
    /** 변경 이벤트를 보내고 화면이 다시 읽을 때까지 기다린다. */
    fire: async () => { const before = gets; seq += 1; await expect.poll(() => gets, { timeout: 10_000 }).toBeGreaterThan(before); },
    save: () => card.getByRole('button', { name: '저장', exact: true }).last().click(),
  };
}

test('재리뷰 순서: 저장 중 되돌림 → 자기 저장 이벤트 먼저 → 다른 칸 편집 → 응답. 20%·3회가 초안으로 남는다', async ({ page }) => {
  const t = await setup(page);
  await t.pct.getByRole('button', { name: '30%' }).click();
  t.holdResponses();
  await t.save();
  await expect(t.card.getByRole('button', { name: '저장 중…' })).toBeVisible();
  await t.pct.getByRole('button', { name: '20%' }).click();
  await t.fire();
  await expect(t.pct.getByRole('button', { name: '20%' })).toHaveAttribute('aria-pressed', 'true');
  await t.notify.getByRole('button', { name: '3회째' }).click();
  t.release();
  await expect(page.getByText('설정을 저장했습니다.')).toBeVisible();
  await expect(t.pct.getByRole('button', { name: '20%' })).toHaveAttribute('aria-pressed', 'true');
  await expect(t.notify.getByRole('button', { name: '3회째' })).toHaveAttribute('aria-pressed', 'true');
  await expect(t.card.getByText('저장하지 않은 변경이 있습니다.')).toBeVisible();
  await t.save();
  await expect.poll(() => t.sent.length).toBe(2);
  expect(t.sent[1]).toMatchObject({ updatedAt: V2, lowPct: 20, notifyAt: 3 });
});

test('순서 바꿈: 저장 중 되돌림 → 응답 먼저 → 자기 저장 이벤트 → 다른 칸 편집. 같은 결과', async ({ page }) => {
  const t = await setup(page);
  await t.pct.getByRole('button', { name: '30%' }).click();
  t.holdResponses();
  await t.save();
  await t.pct.getByRole('button', { name: '20%' }).click();
  t.release();
  await expect(page.getByText('설정을 저장했습니다.')).toBeVisible();
  await t.fire();
  await t.notify.getByRole('button', { name: '3회째' }).click();
  await expect(t.pct.getByRole('button', { name: '20%' })).toHaveAttribute('aria-pressed', 'true');
  await t.save();
  await expect.poll(() => t.sent.length).toBe(2);
  expect(t.sent[1]).toMatchObject({ updatedAt: V2, lowPct: 20, notifyAt: 3 });
});

test('순서 바꿈: 다른 칸 편집이 이벤트보다 먼저. 편집한 두 칸 모두 남는다', async ({ page }) => {
  const t = await setup(page);
  await t.pct.getByRole('button', { name: '30%' }).click();
  t.holdResponses();
  await t.save();
  await t.pct.getByRole('button', { name: '20%' }).click();
  await t.notify.getByRole('button', { name: '3회째' }).click();
  await t.fire();
  await expect(t.pct.getByRole('button', { name: '20%' })).toHaveAttribute('aria-pressed', 'true');
  await expect(t.notify.getByRole('button', { name: '3회째' })).toHaveAttribute('aria-pressed', 'true');
  t.release();
  await expect(page.getByText('설정을 저장했습니다.')).toBeVisible();
  await expect(t.pct.getByRole('button', { name: '20%' })).toHaveAttribute('aria-pressed', 'true');
  await expect(t.notify.getByRole('button', { name: '3회째' })).toHaveAttribute('aria-pressed', 'true');
});

test('편집하지 않은 칸은 다른 탭 변경을 따라가고, 겹치지 않으면 기준 버전만 새로 받아 충돌 없이 저장한다', async ({ page }) => {
  const t = await setup(page);
  await t.pct.getByRole('button', { name: '30%' }).click();
  t.serverSets({ notifyAt: 3, onRework: 'top' }, V2);
  await t.fire();
  await expect(t.notify.getByRole('button', { name: '3회째' })).toHaveAttribute('aria-pressed', 'true');
  await expect(t.rework.getByRole('button', { name: '최상위로 상향' })).toHaveAttribute('aria-pressed', 'true');
  await expect(t.pct.getByRole('button', { name: '30%' })).toHaveAttribute('aria-pressed', 'true');
  await t.save();
  await expect(page.getByText('설정을 저장했습니다.')).toBeVisible();
  expect(t.sent[0]).toMatchObject({ updatedAt: V2, lowPct: 30, notifyAt: 3, onRework: 'top' });
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('되돌려 서버 값과 같아진 칸도 「편집됨」이라 이후 이벤트가 바꾸지 않는다', async ({ page }) => {
  const t = await setup(page);
  await t.pct.getByRole('button', { name: '30%' }).click();
  await t.pct.getByRole('button', { name: '20%' }).click();
  await t.notify.getByRole('button', { name: '1회째' }).click();
  // 다른 탭이 낮춤 기준을 10%로 바꿨다. 내가 편집한 칸이라 화면은 내 값(20%)을 지키고, 저장은 옛 버전으로 보내 충돌로 알린다.
  t.serverSets({ lowPct: 10 }, V2);
  await t.fire();
  await expect(t.pct.getByRole('button', { name: '20%' })).toHaveAttribute('aria-pressed', 'true');
  await t.save();
  await expect.poll(() => t.sent.length).toBe(1);
  expect(t.sent[0]).toMatchObject({ updatedAt: V1, lowPct: 20, notifyAt: 1 });
});
