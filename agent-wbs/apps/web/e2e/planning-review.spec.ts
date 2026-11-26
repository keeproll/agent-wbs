/**
 * M3-05 독립 리뷰(ca3902d) 지적 재현 시험. `W e2e -- planning`에 들어간다.
 * 1 [P1] 오래된 출처 링크가 다른 세션을 염 · 2 [P1] 연결 CP가 최근 200건 밖이면 잠금이 풀려 중복 CP 작성
 * 3 [P2] 메모를 지워 저장해도 서버에 남음 · 4 [P2] 수정 요청 CP의 항목 제외(서버 API 없음 → 자리만)
 * 5 [P2] 재조정 이력 첫 조회 실패가 계속 로딩으로 남음
 */
import { expect, test } from '@playwright/test';
import { errorBody, fakeApi, hold, json } from './support/fake-api.ts';
import { CP2, PLANNING0, PLANNING1, cp, planningServer, RP1, SCHEDULE, type Planning, type Proposal } from './support/planning-data.ts';

/** 더 새로운 세션 n개(최근 목록 200건을 밀어낸다) */
const newerSessions = (n: number) => Array.from({ length: n }, (_, i) => ({
  ...PLANNING0, id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, title: `나중 세션 ${String(n - i)}`, proposalId: null,
}) as unknown as Planning);
const newerCps = (n: number) => Array.from({ length: n }, (_, i) => cp(600 - i, { title: `나중 CP ${String(600 - i)}`, status: 'applied' }));

test('1: 출처 링크의 세션이 최근 200건 밖이어도 그 세션을 연다(다른 세션으로 바꾸지 않는다)', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api, { plannings: [...newerSessions(201), PLANNING1] });
  await page.goto(`/planning?session=${PLANNING1.id}`);
  await expect(page.locator('.mainc').getByRole('heading', { level: 2 })).toHaveText(PLANNING1.title);
  expect(api.calls().some((c) => c.startsWith('GET /api/plannings?') && c.includes('cursor=200'))).toBe(true);
});

test('1: 주소의 세션이 끝까지 없으면 「찾지 못함」을 알리고 최신 세션으로 바꾸지 않는다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api);
  await page.goto('/planning?session=99999999-0000-4000-8000-000000000000');
  await expect(page.getByText('Planning 세션을 찾지 못했습니다.', { exact: false })).toBeVisible();
  await expect(page.locator('.mainc').getByRole('heading', { level: 2, name: PLANNING1.title })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change Proposal 작성', exact: true })).toHaveCount(0);
});

test('2: 연결 CP가 최근 200건 밖이어도 상태를 찾아 완료 세션을 잠그고 CP 작성을 막는다', async ({ page }) => {
  const api = await fakeApi(page);
  const linked = cp(9, { title: PLANNING1.title, status: 'applied', source: { kind: 'planning', id: PLANNING1.id } });
  const done = { ...PLANNING1, proposalId: linked.id, reviews: PLANNING1.reviews.map((r) => ({ ...r, choice: r.kind === 'diff' ? 'claude' : null })) } as unknown as Planning;
  planningServer(api, { plannings: [done], proposals: [...newerCps(201), linked] });
  await page.goto(`/planning?session=${PLANNING1.id}`);
  await expect(page.getByRole('link', { name: 'CP-009 · WBS 반영 완료' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change Proposal 작성', exact: true })).toBeDisabled();
  await expect(page.locator('.rv-act')).toHaveCount(0);
});

test('2: 연결 CP 상태를 아직 모르거나 조회가 실패하면 작성·조정을 잠그고 이유를 보인다', async ({ page }) => {
  const api = await fakeApi(page);
  const done = { ...PLANNING1, proposalId: CP2.id } as unknown as Planning;
  planningServer(api, { plannings: [done] });
  api.on('GET /api/proposals', (route) => json(route, 503, errorBody('UNAVAILABLE')));
  await page.goto(`/planning?session=${PLANNING1.id}`);
  await expect(page.getByText('연결된 변경 제안의 상태를 확인하지 못했습니다', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change Proposal 작성', exact: true })).toBeDisabled();
  await expect(page.locator('.rv-act')).toHaveCount(0);
  expect(api.calls().filter((c) => c.startsWith('POST /api/plannings'))).toEqual([]);
});

test('3: 조정 메모를 모두 지우고 「메모 저장」하면 빈 메모를 보낸다(생략하면 서버가 옛 메모를 유지)', async ({ page }) => {
  const api = await fakeApi(page);
  const chosen = { ...PLANNING1, reviews: PLANNING1.reviews.map((r) => (r.id === 'rv-5' ? { ...r, choice: 'claude', memo: '나중에 지울 메모' } : r)) } as unknown as Planning;
  const server = planningServer(api, { plannings: [chosen] });
  api.on(`POST /api/plannings/${PLANNING1.id}/reviews/rv-5/choice`, (route, request) => {
    const body = request.postDataJSON() as { memo?: string };
    const next = { ...chosen, reviews: chosen.reviews.map((r) => (r.id === 'rv-5' ? { ...r, memo: body.memo ?? r.memo, updatedAt: '2026-11-05T11:00:00.000Z' } : r)) } as Planning;
    server.state.plannings = [next];
    return json(route, 200, next);
  });
  await page.goto('/planning');
  const card = page.getByRole('group', { name: '검토: TASK-0010 우선순위' });
  const memo = card.getByLabel('「TASK-0010 우선순위」 조정 메모');
  await expect(memo).toHaveValue('나중에 지울 메모');
  await memo.fill('');
  await card.getByRole('button', { name: '메모 저장' }).click();
  await expect.poll(() => api.requests(`POST /api/plannings/${PLANNING1.id}/reviews/rv-5/choice`).length).toBe(1);
  expect(api.requests(`POST /api/plannings/${PLANNING1.id}/reviews/rv-5/choice`)[0]?.postDataJSON()).toMatchObject({ choice: 'claude', memo: '' });
  await expect(memo).toHaveValue('');
});

test('4: 수정 요청 CP의 「제외」는 POST /api/proposals/:id/exclude로 그 항목 순번과 버전을 보낸다(서버 후속 2차)', async ({ page }) => {
  const api = await fakeApi(page);
  const changes = { ...CP2, status: 'changes' } as Proposal;
  planningServer(api, { proposals: [changes] });
  await page.goto('/change/CP-002');
  const buttons = page.getByRole('region', { name: '변경 전 / 후 비교' }).getByRole('button', { name: /제외/ });
  await expect(buttons).toHaveCount(2);
  const after = { ...changes, ops: changes.ops.slice(0, 1), updatedAt: '2026-11-05T12:00:00.000Z' } as Proposal;
  api.on(`POST /api/proposals/${CP2.id}/exclude`, (route) => {
    api.on('GET /api/proposals', (r) => json(r, 200, { items: [after], nextCursor: null }));
    return json(route, 200, after);
  });
  await buttons.nth(1).click();
  await expect(page.getByText('CP-002에서 항목을 제외했습니다. 확인한 뒤 재제출하세요.')).toBeVisible();
  const req = api.requests(`POST /api/proposals/${CP2.id}/exclude`)[0];
  expect(req?.postDataJSON()).toEqual({ updatedAt: CP2.updatedAt, index: 1 });
  await expect(buttons).toHaveCount(1);
});

test('5: 재조정 이력 첫 조회가 실패하면 오류와 「다시 시도」를 보이고, 다시 시도로 회복한다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api, { replans: [RP1] });
  let fail = true;
  api.on('GET /api/replans', (route) => (fail ? json(route, 503, errorBody('UNAVAILABLE')) : json(route, 200, { items: [RP1], nextCursor: null })));
  api.on('GET /api/schedule', (route) => (fail ? json(route, 503, errorBody('UNAVAILABLE')) : json(route, 200, SCHEDULE)));
  await page.goto('/planning?tab=replans');
  const card = page.getByRole('region', { name: '재조정 이력을 불러오지 못했습니다' });
  await expect(card).toContainText('503 UNAVAILABLE');
  await expect(page.getByText('재조정 이력 불러오는 중')).toHaveCount(0);
  await expect(page.getByText('현재 일정을 불러오지 못했습니다', { exact: false })).toBeVisible();
  fail = false;
  await card.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByRole('group', { name: '재조정 RP-001' })).toBeVisible();
});

test('충돌 창: 최신 불러오기 중에 창을 닫으면(Esc) 늦게 온 결과가 승인 의견을 지우지 않는다(M3-01 79c2cc1 signal)', async ({ page }) => {
  const api = await fakeApi(page);
  const server = planningServer(api);
  await page.goto('/change/CP-002');
  await page.getByLabel('승인 의견').fill('지키는 의견');
  server.state.proposals = server.state.proposals.map((p) => (p.id === CP2.id ? { ...p, updatedAt: '2026-11-05T10:59:00.000Z' } as Proposal : p));
  await page.getByRole('button', { name: '반려' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('VERSION_CONFLICT');
  const slow = hold((route) => json(route, 200, { items: server.state.proposals, nextCursor: null }));
  api.on('GET /api/proposals', slow.handler);
  await dialog.getByRole('button', { name: /최신 내용 불러오기/ }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  slow.release();
  await page.waitForTimeout(300);
  await expect(page.getByLabel('승인 의견')).toHaveValue('지키는 의견');
});
