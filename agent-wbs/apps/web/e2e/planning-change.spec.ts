/**
 * M3-05 변경 제안 화면(UI-09·UI-09A·MOD-07). `W e2e -- planning`에 들어간다.
 * UAT-CP-01·02·03, UAT-TASK-06(D-27 취소 영향), 보류 사유·판단 결과(D-33~35), UAT-STATE-10(모달 키보드).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { errorBody, fakeApi, json, SESSION } from './support/fake-api.ts';
import { CP2, CP3, cp, planningServer, type Proposal } from './support/planning-data.ts';

test('목록·상세: 원본 문구·상태·Diff·영향·승인 이력', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api);
  await page.goto('/change/CP-002');
  await expect(page.getByRole('heading', { level: 1, name: '변경 제안' })).toBeVisible();
  const list = page.getByRole('complementary', { name: '변경 제안 목록' });
  await expect(list.getByRole('button')).toHaveCount(4);
  await expect(list.getByRole('button', { name: /CP-002/ })).toHaveAttribute('aria-current', 'true');
  const detail = page.locator('.cp-detail');
  await expect(detail.getByRole('heading', { level: 2, name: 'Dependency 검증을 Task CRUD API와 병행 착수' })).toBeVisible();
  await expect(detail.getByText('승인 대기 — 승인 후 「WBS 반영」을 실행하기 전까지 실제 WBS에는 반영되지 않습니다.')).toBeVisible();
  const diff = page.getByRole('region', { name: '변경 전 / 후 비교' });
  await expect(diff.locator('.gtr').nth(1)).toContainText('선행 삭제TASK-0006 Dependency 검증선행 TaskTASK-0005 (FS)—');
  await expect(diff.locator('.gtr').nth(2)).toContainText('선행 추가TASK-0006 Dependency 검증선행 Task—TASK-0005 (SS)');
  await expect(page.getByRole('region', { name: '영향 분석' }).locator('.gtr').nth(1))
    .toContainText('선행 삭제 TASK-0005 · 선행 추가 TASK-0005 · 차단 해제 → 실행 가능');
  await expect(detail.locator('.tl li')).toContainText(['팀장 제출']);
});

test('UAT-TASK-06·D-27: 취소 CP 영향 목록이 제거 관계·실제로 풀리는 후속·계속 차단되는 후속을 구분한다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api);
  await page.goto('/change/CP-003');
  const impact = page.getByRole('region', { name: '영향 분석' });
  await expect(impact.locator('.gtr')).toHaveCount(4);
  const freed = impact.locator('.gtr[data-unblocked="true"]');
  await expect(freed).toHaveCount(1);
  await expect(freed).toContainText('TASK-0006');
  await expect(freed).toContainText('선행 관계 제거 TASK-0005 → TASK-0006 (SS, 선행 취소) · 차단 해제 → 실행 가능');
  const still = impact.locator('.gtr[data-unblocked="false"]');
  await expect(still).toContainText('TASK-0007');
  await expect(still).toContainText('계속 차단 — 남은 선행 TASK-0008 (FS, 실행 중)');
  await expect(impact.locator('.gtr').nth(1)).toContainText('TASK-0005Task CRUD API실행 대기취소');
});

test('D-33~35: 보류 사유와 판단 결과를 보이고 승인·재제출을 막는다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api);
  await page.goto('/change/CP-004');
  await expect(page.locator('.cp-detail .cps')).toHaveText('보류');
  const holds = page.getByRole('region', { name: '보류 사유' });
  await expect(holds.locator('li')).toHaveText([
    '판단 불충족(JUDGEMENT_NOT_MET) · TASK-0013 · 규칙 9 refactor — 규칙 9 판단이 불충족입니다.',
    '진행 중 Task 새 차단(ACTIVE_TASK_BLOCKED) · TASK-0008 — 실행 중인 TASK-0008을 새로 차단합니다.',
  ]);
  const judged = page.getByRole('region', { name: '판단 결과' });
  await expect(judged.locator('.gtr').nth(1)).toContainText('TASK-0008규칙 5 revert충족Claude · Codex되돌리기 쉬운 단위');
  await expect(judged.locator('.gtr').nth(2)).toContainText('TASK-0013규칙 9 refactor불충족Claude · Codex리팩터링이 기능 변경과 섞임');
  await expect(page.getByRole('button', { name: '재제출' })).toBeVisible();
});

test('UAT-CP-02: 의견 없이 반려·수정 요청은 막고, 의견을 넣으면 처리하고 이력을 남긴다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api);
  await page.goto('/change/CP-002');
  await page.getByRole('button', { name: '반려' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '반려 사유를 입력하세요.' })).toBeVisible();
  await page.getByRole('button', { name: '수정 요청' }).click();
  await expect(page.getByText('수정 요청 사유를 입력하세요.')).toBeVisible();
  expect(api.requests('POST /api/proposals/' + CP2.id + '/reject')).toHaveLength(0);
  await page.getByLabel('승인 의견').fill('SS 근거 보강 필요');
  await page.getByRole('button', { name: '수정 요청' }).click();
  await expect(page.locator('.cp-detail .cps')).toHaveText('수정 요청');
  const sent = api.requests(`POST /api/proposals/${CP2.id}/request-changes`)[0];
  expect(sent?.postDataJSON()).toEqual({ updatedAt: CP2.updatedAt, comment: 'SS 근거 보강 필요' });
  expect(sent?.headers()['idempotency-key']).toBeTruthy();
  await expect(page.locator('.cp-detail .tl li').first()).toContainText('수정 요청 — SS 근거 보강 필요');
  await expect(page.getByLabel('승인 의견')).toHaveCount(0);
});

test('UAT-CP-02·03: 승인은 미리보기 hash로, 반영은 확인 뒤 서버 재시뮬레이션 결과로 끝난다', async ({ page }) => {
  const api = await fakeApi(page);
  const server = planningServer(api);
  await page.goto('/change/CP-002');
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page.locator('.cp-detail .cps')).toHaveText('승인됨 · 반영 대기');
  expect(api.requests(`POST /api/proposals/${CP2.id}/approve`)[0]?.postDataJSON()).toEqual({ updatedAt: CP2.updatedAt, previewHash: server.previewOf(CP2).previewHash });
  await expect(page.getByText('승인 처리했습니다. 「WBS 반영」을 실행하기 전까지 WBS는 바뀌지 않습니다.')).toBeVisible();
  await page.getByRole('button', { name: 'WBS 반영', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'WBS 반영' });
  await expect(dialog).toContainText('CP-002의 변경 2건을 WBS에 반영합니다.');
  await dialog.getByRole('button', { name: '취소' }).click();
  expect(api.requests(`POST /api/proposals/${CP2.id}/apply`)).toHaveLength(0);
  await page.getByRole('button', { name: 'WBS 반영', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'WBS 반영' }).getByRole('button', { name: 'WBS 반영' }).click();
  await expect(page.locator('.cp-detail .cps')).toHaveText('WBS 반영 완료');
  await expect(page.getByText('WBS 반영 완료 — 완료 Task와 기존 검증 결과는 변경하지 않았습니다.')).toBeVisible();
  await expect(page.getByRole('region', { name: '영향 분석' })).toHaveCount(0);
});

test('보류 409(ACTIVE_TASK_BLOCKED): 오류 막대로 알리고 다시 시도는 없으며 최신 미리보기를 다시 읽는다', async ({ page }) => {
  const api = await fakeApi(page);
  const server = planningServer(api);
  // 화면이 미리보기를 읽은 뒤 서버에서 보류 사유가 생긴 경우(승인 직전 재판정)
  await page.goto('/change/CP-002');
  await expect(page.getByRole('button', { name: '승인', exact: true })).toBeEnabled();
  const hold = [{ code: 'ACTIVE_TASK_BLOCKED', taskKey: 'TASK-0006', message: '실행 중인 Task를 새로 차단합니다.' }];
  server.state.proposals = server.state.proposals.map((p) => (p.id === CP2.id ? { ...p, holdReasons: hold } as unknown as Proposal : p));
  await page.getByRole('button', { name: '승인', exact: true }).click();
  const bar = page.getByRole('alert').filter({ hasText: '승인하지 못했습니다' });
  await expect(bar).toContainText('409 ACTIVE_TASK_BLOCKED');
  await expect(bar.getByRole('button', { name: '다시 시도' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '보류 사유' })).toContainText('진행 중 Task 새 차단(ACTIVE_TASK_BLOCKED) · TASK-0006');
  await expect(page.getByRole('button', { name: '승인', exact: true })).toBeDisabled();
});

test('409 VERSION_CONFLICT: 충돌 창 → 최신 위에 다시 적용은 서버에서 새로 읽은 updatedAt으로 보낸다', async ({ page }) => {
  const api = await fakeApi(page);
  const server = planningServer(api);
  await page.goto('/change/CP-002');
  await page.getByLabel('승인 의견').fill('범위 확인');
  // 다른 곳에서 먼저 바뀜(updatedAt 증가)
  server.state.proposals = server.state.proposals.map((p) => (p.id === CP2.id ? { ...p, updatedAt: '2026-11-05T10:59:00.000Z' } as Proposal : p));
  await page.getByRole('button', { name: '반려' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('VERSION_CONFLICT');
  await expect(page.getByLabel('승인 의견')).toHaveValue('범위 확인');
  await dialog.getByRole('button', { name: /다시 적용/ }).click();
  await expect(page.locator('.cp-detail .cps')).toHaveText('반려');
  const calls = api.requests(`POST /api/proposals/${CP2.id}/reject`);
  expect(calls.at(-1)?.postDataJSON()).toEqual({ updatedAt: '2026-11-05T10:59:00.000Z', comment: '범위 확인' });
});

test('500 뒤 다시 시도는 처음 요청과 같은 멱등 키·같은 내용으로 보낸다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api);
  let n = 0;
  const keys: string[] = [];
  await page.goto('/change/CP-002');
  api.on(`POST /api/proposals/${CP2.id}/approve`, (route, request) => {
    n += 1;
    keys.push(request.headers()['idempotency-key'] ?? '');
    if (n === 1) return json(route, 500, errorBody('INTERNAL'));
    return json(route, 200, { ...CP2, status: 'approved', updatedAt: '2026-11-05T11:00:00.000Z' });
  });
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await page.getByRole('alert').getByRole('button', { name: '다시 시도' }).click();
  await expect.poll(() => n).toBe(2);
  expect(keys[0]).toBe(keys[1]);
});

test('MOD-07·UAT-CP-01: 7가지 행 추가·삭제(행 id 기준)·필수 검사·서버 문제는 제출 차단·정상은 승인 대기', async ({ page }) => {
  const api = await fakeApi(page);
  const server = planningServer(api);
  const created: Record<string, unknown>[] = [];
  api.on('POST /api/proposals', (route, request) => {
    const body = request.postDataJSON() as Record<string, unknown>;
    created.push(body);
    const next = cp(10 + created.length, { ...body, status: 'draft', source: { kind: 'manual', id: null }, events: [{ at: '2026-11-05T11:00:00.000Z', actor: '팀장', action: 'created', comment: '' }] });
    // 두 번째 제출은 서버 미리보기에서 완료 Task 수정 문제가 나온다.
    if (created.length === 1) server.state.previews[next.cpKey] = { issues: [{ index: 0, code: 'TASK_DONE', taskKey: 'TASK-0004', message: '완료된 Task는 바꿀 수 없습니다.' }] };
    server.add(next);
    return json(route, 201, next);
  });
  await page.goto('/change');
  const opener = page.getByRole('button', { name: '새 변경 제안' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Change Proposal 작성' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('제목')).toBeFocused();
  // 필수 누락
  await dialog.getByRole('button', { name: '제출 — 승인 요청' }).click();
  await expect(dialog.getByRole('alert')).toContainText('제목을 입력하세요.');
  await expect(dialog.getByRole('alert')).toContainText('항목 1: 대상 Task (빈 값)이(가) 없습니다.');
  expect(created).toHaveLength(0);
  // 7가지 유형 행 3개 → 가운데 삭제 → 남은 행 수정이 맞는 행에 들어간다
  await dialog.getByLabel('제목').fill('완료 Task 수정 시험');
  await dialog.getByLabel('변경 사유').fill('사유');
  await dialog.getByLabel('항목 1 대상 Task ID').fill('TASK-0004');
  await dialog.getByLabel('항목 1 변경 값').fill('범위 A');
  await dialog.getByRole('button', { name: '+ 항목 추가' }).click();
  await dialog.getByLabel('항목 2 변경 유형').selectOption('priority');
  await dialog.getByLabel('항목 2 변경 값').fill('긴급');
  await dialog.getByRole('button', { name: '+ 항목 추가' }).click();
  await dialog.getByLabel('항목 3 변경 유형').selectOption('depAdd');
  await dialog.getByLabel('항목 3 변경 값').fill('TASK-0005 (SS)');
  await dialog.getByRole('button', { name: '항목 2 삭제' }).click();
  await dialog.getByLabel('항목 2 변경 값').fill('TASK-0009 (FS)');
  await expect(dialog.getByRole('region', { name: '변경 전 / 후 미리보기' }).locator('.gtr')).toHaveCount(3);
  await dialog.getByRole('button', { name: '제출 — 승인 요청' }).click();
  await expect(dialog.getByRole('alert')).toContainText('서버 미리보기에서 문제가 나와 제출하지 않았습니다. 초안 CP-011은(는) 「작성 중」으로 남습니다.');
  await expect(dialog.getByRole('alert')).toContainText('TASK-0004 · 완료된 Task는 바꿀 수 없습니다. (TASK_DONE)');
  expect(created[0]).toEqual({ title: '완료 Task 수정 시험', reason: '사유', source: { kind: 'manual' }, ops: [
    { op: 'modify', task: 'TASK-0004', field: 'scopeAdd', after: '범위 A' },
    { op: 'dep-add', pred: 'TASK-0009', succ: 'TASK-0004', type: 'FS' },
  ] });
  expect(api.calls().filter((c) => c.endsWith('/submit'))).toHaveLength(0);
  // 고쳐서 다시 제출 → review
  await dialog.getByLabel('항목 1 대상 Task ID').fill('TASK-0006');
  await dialog.getByLabel('항목 2 대상 Task ID').fill('TASK-0006');
  await dialog.getByRole('button', { name: '제출 — 승인 요청' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/change\/CP-012$/);
  await expect(page.locator('.cp-detail .cps')).toHaveText('승인 대기');
  await expect(page.getByText('CP-012 변경 제안을 제출했습니다. 승인 전에는 WBS에 반영되지 않습니다.')).toBeVisible();
  // 포커스는 연 버튼으로 돌아온다(UAT-STATE-10)
  await expect(opener).toBeFocused();
});

test('UAT-STATE-10: 작성 모달 Tab 순환·Esc(입력 있으면 확인)·포커스 복원·접근성 위반 없음', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api);
  await page.goto('/change/CP-002');
  const opener = page.getByRole('button', { name: '새 변경 제안' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Change Proposal 작성' });
  const submit = dialog.getByRole('button', { name: '제출 — 승인 요청' });
  await submit.focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '닫기' }).or(dialog.getByLabel('제목'))).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(submit).toBeFocused();
  const axe = await new AxeBuilder({ page }).include('.modal').analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  await dialog.getByLabel('제목').fill('작성 중');
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('alertdialog', { name: '편집 내용 버리기' });
  await confirm.getByRole('button', { name: '취소' }).click();
  await expect(dialog.getByLabel('제목')).toHaveValue('작성 중');
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog', { name: '편집 내용 버리기' }).getByRole('button', { name: '저장하지 않고 이동' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  const full = await new AxeBuilder({ page }).analyze();
  expect(full.violations.map((v) => v.id)).toEqual([]);
});

test('편집 보호: 승인 의견을 쓰다 다른 CP를 누르면 묻고, 취소하면 의견이 남는다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api);
  await page.goto('/change/CP-002');
  await page.getByLabel('승인 의견').fill('검토 중');
  await page.getByRole('complementary', { name: '변경 제안 목록' }).getByRole('button', { name: /CP-003/ }).click();
  await page.getByRole('alertdialog', { name: '편집 내용 버리기' }).getByRole('button', { name: '취소' }).click();
  await expect(page).toHaveURL(/CP-002$/);
  await expect(page.getByLabel('승인 의견')).toHaveValue('검토 중');
});

test('UAT-EMPTY-02: CP가 없으면 비어 있음과 생기는 조건을 안내하고 변경 행을 만들지 않는다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api, { proposals: [] });
  await page.goto('/change');
  await expect(page.getByText('Change Proposal이 없습니다.', { exact: true })).toBeVisible();
  await expect(page.getByText('아직 Change Proposal이 없습니다.')).toBeVisible();
  await expect(page.getByText(/Planning 세션에서 Codex · Claude가 합의한 변경/)).toBeVisible();
  await expect(page.locator('.gtr')).toHaveCount(0);
});

test('알림 링크의 CP가 최근 200건 밖이면 목록을 끝까지 넘겨 찾고, 끝까지 없을 때만 「찾지 못함」', async ({ page }) => {
  const api = await fakeApi(page);
  const many = Array.from({ length: 450 }, (_, i) => cp(500 - i, { title: `CP ${String(500 - i)}`, status: 'applied' }));
  planningServer(api, { proposals: [...many, CP3] });
  await page.goto('/change/CP-003');
  await expect(page.locator('.cp-detail').getByRole('heading', { level: 2, name: 'Task CRUD API 취소' })).toBeVisible();
  expect(api.calls().filter((c) => c.startsWith('GET /api/proposals?')).some((c) => c.includes('cursor=400'))).toBe(true);
  expect(api.calls().filter((c) => c.startsWith('GET /api/proposals?')).every((c) => !c.includes('status='))).toBe(true);
  await page.goto('/change/CP-999');
  await expect(page.getByText('변경 제안 CP-999을(를) 찾지 못했습니다.')).toBeVisible();
});

test('세션 만료(401) 뒤 다시 로그인하면 승인 의견 복원을 제안한다', async ({ page }) => {
  const api = await fakeApi(page);
  planningServer(api);
  let signedIn = true;
  api.on('GET /api/session', (route) => (signedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  api.on('POST /api/auth/session', (route) => { signedIn = true; return route.fulfill({ status: 204 }); });
  await page.goto('/change/CP-002');
  await page.getByLabel('승인 의견').fill('복원할 의견');
  api.on(`POST /api/proposals/${CP2.id}/reject`, (route) => { signedIn = false; return json(route, 401, errorBody('LEAD_UNAUTHORIZED')); });
  await page.getByRole('button', { name: '반려' }).click();
  await expect(page).toHaveURL('/login?next=%2Fchange%2FCP-002');
  await page.getByLabel('비밀번호').fill('pw');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL('/change/CP-002');
  const offer = page.getByRole('region', { name: 'CP-002 승인 의견 — 저장하지 못한 초안' });
  await offer.getByRole('button', { name: '복원' }).click();
  await expect(page.getByLabel('승인 의견')).toHaveValue('복원할 의견');
});
