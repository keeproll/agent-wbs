/**
 * M3-05 Planning 화면(UI-05·UI-05-01·UI-05-02). `W e2e -- planning`.
 * 시나리오 5(Planning 분석 비교 → 이견 조정 → CP 작성 → 제출 → 승인 → WBS 반영), UAT-PLAN-UI·UAT-PLAN-02·UAT-EMPTY-02.
 */
import { expect, test } from '@playwright/test';
import { errorBody, fakeApi, json } from './support/fake-api.ts';
import { cp, PLANNING1, planningServer, POLICY, RP1, type Planning } from './support/planning-data.ts';

/** 이견 선택 API: 검토 updatedAt이 다르면 409, 맞으면 선택·메모를 저장하고 새 updatedAt을 준다. */
function chooseServer(api: Awaited<ReturnType<typeof fakeApi>>, server: ReturnType<typeof planningServer>) {
  for (const review of PLANNING1.reviews) {
    api.on(`POST /api/plannings/${PLANNING1.id}/reviews/${review.id}/choice`, (route, request) => {
      const body = request.postDataJSON() as { updatedAt: string; choice: string; memo?: string };
      const p = server.state.plannings.find((x) => x.id === PLANNING1.id);
      const r = p?.reviews.find((x) => x.id === review.id);
      if (!p || !r) return json(route, 404, errorBody('NOT_FOUND'));
      if (body.updatedAt !== r.updatedAt) return json(route, 409, errorBody('VERSION_CONFLICT', { details: { changes: [] } }));
      const next = { ...p, reviews: p.reviews.map((x) => (x.id === review.id ? { ...x, choice: body.choice, memo: body.memo ?? x.memo, updatedAt: `2026-11-05T11:0${String(Math.floor(Math.random() * 9))}:00.000Z` } : x)) } as Planning;
      server.state.plannings = server.state.plannings.map((x) => (x.id === p.id ? next : x));
      return json(route, 200, next);
    });
  }
}

test('시나리오 5: 독립 분석 비교 → 미조정은 CP 작성 차단 → 이견 조정 → CP 작성·제출·승인·WBS 반영', async ({ page }) => {
  const api = await fakeApi(page);
  const server = planningServer(api);
  chooseServer(api, server);
  api.on(`POST /api/plannings/${PLANNING1.id}/proposals`, (route, request) => {
    const body = request.postDataJSON() as { title: string; reason: string };
    const p = server.state.plannings.find((x) => x.id === PLANNING1.id);
    const ops = (p?.reviews ?? []).flatMap((r) => (r.choice === 'codex' ? r.codexOps : r.choice === 'claude' ? r.claudeOps : r.ops));
    const created = cp(20, { ...body, status: 'draft', source: { kind: 'planning', id: PLANNING1.id }, ops, events: [{ at: '2026-11-05T11:00:00.000Z', actor: '팀장', action: 'created', comment: '' }] });
    server.add(created);
    server.state.plannings = server.state.plannings.map((x) => (x.id === PLANNING1.id ? { ...x, proposalId: created.id } as Planning : x));
    return json(route, 201, created);
  });

  await page.goto('/planning');
  await expect(page.getByRole('heading', { level: 1, name: 'Planning' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Planning 세션' })).toHaveAttribute('aria-pressed', 'true');
  // 독립 분석 두 개를 나란히
  const analyses = page.locator('.cmp > .card');
  await expect(analyses).toHaveCount(2);
  const [a, b] = [await analyses.nth(0).boundingBox(), await analyses.nth(1).boundingBox()];
  expect(a && b && Math.abs(a.y - b.y) < 1 && b.x > a.x).toBe(true);
  await expect(page.locator('.flow li.cur')).toContainText('이견 식별 · 조정');
  await expect(page.locator('.sh').filter({ hasText: '교차 검토' })).toContainText('일치 2 · 이견 3 · 미조정 3');
  // 미조정이면 CP 작성 불가
  const make = page.getByRole('button', { name: 'Change Proposal 작성', exact: true });
  await expect(make).toBeDisabled();
  await expect(page.getByText('미조정 이견 3건을 조정해야 Change Proposal을 작성할 수 있습니다.')).toBeVisible();

  // 이견 조정: 메모를 쓰고 Claude 안 채택 → 선택·메모가 함께 저장된다
  const r3 = page.getByRole('group', { name: '검토: Message 상태 머신 설계 위치' });
  await r3.getByLabel('「Message 상태 머신 설계 위치」 조정 메모').fill('계약 범위가 작음');
  await r3.getByRole('button', { name: 'Claude 안 채택' }).click();
  await expect(r3.getByRole('button', { name: 'Claude 안 채택' })).toHaveAttribute('aria-pressed', 'true');
  const sent = api.requests(`POST /api/plannings/${PLANNING1.id}/reviews/rv-3/choice`)[0];
  expect(sent?.postDataJSON()).toEqual({ updatedAt: '2026-11-03T03:00:00.000Z', choice: 'claude', memo: '계약 범위가 작음' });
  await expect(r3.locator('.rv-ops')).toContainText('TASK-0012 작업 범위 추가: Message 상태 머신(Draft~Cancelled) 정의');
  await page.getByRole('group', { name: '검토: TASK-0011 선행 관계' }).getByRole('button', { name: 'Codex 안 채택' }).click();
  await page.getByRole('group', { name: '검토: TASK-0010 우선순위' }).getByRole('button', { name: 'Claude 안 채택' }).click();
  await expect(page.locator('.sh').filter({ hasText: '교차 검토' })).toContainText('미조정 0');

  // 최종 Diff = 일치 2건 + 고른 안(Claude 범위 추가, Codex 유지=변경 없음, Claude 우선순위)
  const diff = page.getByRole('region', { name: '최종 제안 Diff' });
  await expect(diff.locator('.gtr')).toHaveCount(5);
  await expect(diff.locator('.gtr').nth(4)).toContainText('수정TASK-0010 Runner API 계약우선순위—긴급');
  await expect(make).toBeEnabled();
  await make.click();
  await expect(page).toHaveURL(/\/change\/CP-020$/);
  const created = api.requests(`POST /api/plannings/${PLANNING1.id}/proposals`)[0];
  expect(created?.postDataJSON()).toEqual({
    title: PLANNING1.title,
    reason: `Planning ${PLANNING1.title} 교차 검토 결과 — Runner 응답 수신 처리 Task 추가: 일치 / TASK-0012 완료 조건 보강: 일치 / Message 상태 머신 설계 위치: Claude 안 (계약 범위가 작음) / TASK-0011 선행 관계: Codex 안 / TASK-0010 우선순위: Claude 안`,
  });
  expect(created?.headers()['idempotency-key']).toBeTruthy();
  // 같은 Diff가 CP에 들어간다
  await expect(page.getByRole('region', { name: '변경 전 / 후 비교' }).locator('.gtr')).toHaveCount(5);
  await expect(page.locator('.cp-detail .cps')).toHaveText('작성 중');
  await page.getByRole('button', { name: '제출 — 승인 요청' }).click();
  await expect(page.locator('.cp-detail .cps')).toHaveText('승인 대기');
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page.locator('.cp-detail .cps')).toHaveText('승인됨 · 반영 대기');
  await page.getByRole('button', { name: 'WBS 반영', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'WBS 반영' }).getByRole('button', { name: 'WBS 반영' }).click();
  await expect(page.locator('.cp-detail .cps')).toHaveText('WBS 반영 완료');
  // 출처 버튼으로 Planning 세션에 돌아가면 완료 단계와 잠긴 조정을 보인다
  await page.getByRole('link', { name: /출처: Planning/ }).click();
  await expect(page.locator('.flow li.cur')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'CP-020 · WBS 반영 완료' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change Proposal 작성', exact: true })).toBeDisabled();
  await expect(page.getByText('조정 메모: 계약 범위가 작음')).toBeVisible();
});

test('이견 선택 409 VERSION_CONFLICT는 충돌 창, 최신 불러오기는 메모 초안을 버린다', async ({ page }) => {
  const api = await fakeApi(page);
  const server = planningServer(api);
  chooseServer(api, server);
  // 화면이 읽은 뒤 다른 곳에서 먼저 바뀐 경우: 첫 요청은 409, 서버의 검토 updatedAt은 새 값
  api.on(`POST /api/plannings/${PLANNING1.id}/reviews/rv-5/choice`, (route) => {
    server.state.plannings = server.state.plannings.map((p) => (p.id === PLANNING1.id ? { ...p, reviews: p.reviews.map((r) => (r.id === 'rv-5' ? { ...r, updatedAt: '2026-11-05T10:00:00.000Z' } : r)) } as Planning : p));
    return json(route, 409, errorBody('VERSION_CONFLICT', { details: { changes: [] } }));
  });
  await page.goto('/planning');
  const card = page.getByRole('group', { name: '검토: TASK-0010 우선순위' });
  await card.getByLabel('「TASK-0010 우선순위」 조정 메모').fill('메모');
  await card.getByRole('button', { name: 'Codex 안 채택' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('VERSION_CONFLICT');
  await dialog.getByRole('button', { name: /최신 내용 불러오기/ }).click();
  await expect(card.getByLabel('「TASK-0010 우선순위」 조정 메모')).toHaveValue('');
});

test('편집 보호: 조정 메모를 쓰다 탭을 바꾸면 묻는다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api);
  await page.goto('/planning');
  await page.getByLabel('「TASK-0010 우선순위」 조정 메모').fill('작성 중');
  await page.getByRole('button', { name: '일정 재조정 이력' }).click();
  const confirm = page.getByRole('alertdialog', { name: '편집 내용 버리기' });
  await confirm.getByRole('button', { name: '취소' }).click();
  await expect(page.getByLabel('「TASK-0010 우선순위」 조정 메모')).toHaveValue('작성 중');
  await page.getByRole('button', { name: '일정 재조정 이력' }).click();
  await page.getByRole('alertdialog', { name: '편집 내용 버리기' }).getByRole('button', { name: '저장하지 않고 이동' }).click();
  await expect(page).toHaveURL(/tab=replans/);
});

test('UAT-PLAN-02: 재조정 이력 — 기록 내용·변경 Task 펼침·재조정 실행(POST /api/replans/run)', async ({ page }) => {
  const api = await fakeApi(page);
  const rp2 = {
    ...RP1, replanId: 'RP-002', baselineVersion: 2, projectEnd: '2026-11-09', range: { lo: '2026-11-08', hi: '2026-11-11' }, trigger: 'CP-001 반영', actor: '팀장', at: '2026-11-04T01:00:00.000Z',
    moved: [{ taskKey: 'TASK-0007', kind: 'delayed', before: '2026-11-05', after: '2026-11-07', deltaDays: 2 }],
  };
  const server = planningServer(api, { replans: [rp2, RP1] });
  api.on('POST /api/replans/run', (route) => {
    const rp3 = { ...RP1, replanId: 'RP-003', baselineVersion: 3, projectEnd: '2026-11-08', trigger: '재조정 실행', actor: '팀장', at: '2026-11-05T11:00:00.000Z' };
    server.state.replans = [rp3, ...server.state.replans];
    return json(route, 201, { replanId: 'RP-003', baselineVersion: 3, projectEnd: '2026-11-08', range: RP1.range, moved: [] });
  });
  await page.goto('/planning?tab=replans');
  await expect(page.getByText('현재 기준 v1 · 완료 예상 11-06 (범위 11-06 ~ 11-10) · 기준 대비 0일 · 최초 기준 v1 11-06 · 재조정 2회')).toBeVisible();
  const card = page.getByRole('group', { name: '재조정 RP-002' });
  await expect(card).toContainText('기준 v2');
  await expect(card).toContainText('+3일 밀림');
  await expect(card).toContainText('CP-001 반영');
  await expect(card.locator('.ev')).toContainText('완료 예상11-06 → 11-09범위11-08 ~ 11-11적용 가동률85%변경 Task1건');
  await card.getByRole('button', { name: '변경 Task 1건 보기' }).click();
  await expect(card.getByRole('region', { name: 'RP-002 변경 Task' }).locator('.gtr').nth(1)).toContainText('TASK-0007Gantt 화면밀림11-0511-07+2일');
  await card.getByRole('link', { name: 'TASK-0007' }).isVisible();
  await page.getByRole('button', { name: '재조정 실행' }).click();
  await expect(page.getByRole('group', { name: '재조정 RP-003' })).toContainText('1일 당겨짐');
  expect(api.requests('POST /api/replans/run')[0]?.headers()['idempotency-key']).toBeTruthy();
});

test('UAT-PLAN-02: 자동 재조정이 꺼져 있으면 pending은 「반영 대기」로만 보이고 실행해야 반영된다고 안내한다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api, { replans: [{ ...RP1, replanId: 'RP-002', baselineVersion: null, status: 'pending', trigger: '재추정' }, RP1] });
  api.on('GET /api/settings/schedule', (route) => json(route, 200, { ...POLICY, autoReplan: false }));
  await page.goto('/planning?tab=replans');
  await expect(page.getByText('자동 반영 꺼짐 — 실행해야 반영')).toBeVisible();
  await expect(page.getByRole('group', { name: '재조정 RP-002' })).toContainText('반영 대기');
  await expect(page.getByText(/「반영 대기」로만 기록되고 기준 일정은 바뀌지 않습니다/)).toBeVisible();
});

test('UAT-EMPTY-02: 세션·재조정이 없으면 각각 비어 있음과 생기는 조건을 안내하고 제안·행을 만들지 않는다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api, { plannings: [], replans: [], proposals: [] });
  await page.goto('/planning');
  await expect(page.getByText('Planning 세션이 없습니다. 입력 자료를 갱신하거나 팀장 지시가 있으면 Planning Agent가 세션을 만듭니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change Proposal 작성' })).toHaveCount(0);
  await page.getByRole('button', { name: '일정 재조정 이력' }).click();
  await expect(page.getByText('재조정 기록이 없습니다. 초기 WBS를 승인하면 기준 v1이 생기고, 일정이 바뀌면 여기에 기록됩니다.')).toBeVisible();
  await expect(page.locator('.gtr')).toHaveCount(0);
});

test('독립 분석·검토가 아직 없는 세션은 각 영역에 안내를 보이고 CP 작성을 막는다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api, { plannings: [{ ...PLANNING1, analyses: [], reviews: [] } as Planning] });
  await page.goto('/planning');
  await expect(page.getByText('아직 독립 분석이 없습니다.', { exact: false })).toBeVisible();
  await expect(page.getByText('아직 교차 검토가 없습니다.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change Proposal 작성', exact: true })).toBeDisabled();
});
