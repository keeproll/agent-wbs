/**
 * M3-07 Evidence(UI-07-01A·07-02)와 Completion Gate(UI-07-03) — UAT-VERIFY-02, UAT-VERIFY-03, UAT-EMPTY-04(Evidence 부분).
 * Evidence 추가(경로 입력)는 팀장용 API가 계약에 없어 화면에 두지 않는다(조정자 결정) — 「빈/중복 경로 거부」는 시험하지 않고 보고한다.
 */
import { expect, test, type Page } from '@playwright/test';
import { errorBody, fakeApi, json, type FakeApi } from './support/fake-api.ts';
import { installM307, kst, m307Data, taskDetail, type M307Data } from './support/m307-data.ts';

async function open(page: Page, path: string, change: (d: M307Data) => void = () => undefined): Promise<{ api: FakeApi; data: M307Data }> {
  const api = await fakeApi(page);
  const data = m307Data();
  change(data);
  installM307(api, data);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: '검증' })).toBeVisible();
  return { api, data };
}
const tabs = (page: Page) => page.getByRole('group', { name: '검증 화면 탭' }).getByRole('button');

/** PATCH를 받아 가짜 서버 상태(체크리스트·Evidence 연결·updatedAt)를 바꾸고 TaskChanged를 돌려준다. */
function acceptLink(api: FakeApi, data: M307Data, bodies: unknown[]) {
  api.on('PATCH /api/tasks/TASK-0007/checklist/CL-0007-1', async (route, req) => {
    const body = req.postDataJSON() as { updatedAt: string; evidence: string | null };
    bodies.push(body);
    const before = data.details.get('TASK-0007');
    if (!before || body.updatedAt !== before.updatedAt) return json(route, 409, errorBody('VERSION_CONFLICT', { details: { changes: [] } }));
    const items = before.checklistItems.map((c) => ({ itemKey: c.itemKey, content: c.content, evidence: c.itemKey === 'CL-0007-1' ? body.evidence : c.evidence }));
    const next = taskDetail('TASK-0007', items, kst('2026-11-05 20:01'));
    data.details.set('TASK-0007', next);
    for (const e of data.evidence) {
      if (e.taskKey !== 'TASK-0007') continue;
      e.checklistItemKey = items.find((c) => c.evidence === e.id)?.itemKey ?? null;
    }
    await json(route, 200, { task: next, changes: [{ field: 'checklist.CL-0007-1.evidence', before: null, after: body.evidence }] });
  });
}

test('UAT-VERIFY-02: 체크리스트 연결 토글 — 안정 키로 저장하고 Evidence 탭 연결과 건수가 실제 목록과 같다', async ({ page }) => {
  const bodies: unknown[] = [];
  const { api, data } = await open(page, '/verify?sel=v-0007-1');
  acceptLink(api, data, bodies);
  const row = page.locator('.evrow').filter({ hasText: '측정 데이터' });
  await row.getByRole('button', { name: 'CL-0007-1' }).click();
  await expect(page.getByText('Evidence 연결을 저장했습니다.')).toBeVisible();
  await expect(row.getByRole('button', { name: 'CL-0007-1' })).toHaveAttribute('aria-pressed', 'true');
  expect(bodies).toEqual([{ updatedAt: kst('2026-11-03 10:00'), evidence: 'e2' }]);
  await tabs(page).nth(1).click();
  await expect(tabs(page).nth(1)).toHaveText('Evidence 5');
  const evTable = page.getByRole('table', { name: 'Evidence' });
  await expect(evTable.locator('.gtr:not(.h)')).toHaveCount(5);
  await expect(evTable.getByRole('row').filter({ hasText: '측정 데이터' }).getByRole('cell').nth(4)).toHaveText('CL-0007-1');
  // 해제는 evidence null
  await page.goto('/verify?sel=v-0007-1');
  await page.locator('.evrow').filter({ hasText: '측정 데이터' }).getByRole('button', { name: 'CL-0007-1' }).click();
  await expect(page.locator('.evrow').filter({ hasText: '측정 데이터' }).getByRole('button', { name: 'CL-0007-1' })).toHaveAttribute('aria-pressed', 'false');
  expect(bodies.at(-1)).toEqual({ updatedAt: kst('2026-11-05 20:01'), evidence: null });
});

test('UAT-VERIFY-02: 버전 충돌이면 충돌 창, 다시 적용은 최신 버전으로 같은 연결을 보낸다', async ({ page }) => {
  const bodies: unknown[] = [];
  const { api, data } = await open(page, '/verify?sel=v-0007-1');
  acceptLink(api, data, bodies);
  // 다른 곳에서 먼저 저장해 버전이 바뀐 상황
  data.details.set('TASK-0007', taskDetail('TASK-0007', [
    { itemKey: 'CL-0007-1', content: '필터 시 상위 행 유지', evidence: null },
    { itemKey: 'CL-0007-2', content: '1,000행 300ms 이내', evidence: null },
  ], kst('2026-11-05 19:59')));
  await page.locator('.evrow').filter({ hasText: '스크린샷' }).getByRole('button', { name: 'CL-0007-1' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /다시 적용/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('저장하지 않은 연결 변경')).toHaveCount(0);
  expect(bodies).toEqual([
    { updatedAt: kst('2026-11-03 10:00'), evidence: 'e3' },
    { updatedAt: kst('2026-11-05 19:59'), evidence: 'e3' },
  ]);
  await expect(page.locator('.evrow').filter({ hasText: '스크린샷' }).getByRole('button', { name: 'CL-0007-1' })).toHaveAttribute('aria-pressed', 'true');
});

test('UAT-VERIFY-02: 저장 실패(500)면 연결 변경을 남기고 이동 전에 묻는다', async ({ page }) => {
  const { api } = await open(page, '/verify?sel=v-0007-1');
  api.on('PATCH /api/tasks/TASK-0007/checklist/CL-0007-2', (route) => json(route, 500, errorBody('INTERNAL')));
  await page.locator('.evrow').filter({ hasText: '로그' }).getByRole('button', { name: 'CL-0007-2' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '500' })).toBeVisible();
  await expect(page.getByText('저장하지 않은 연결 변경')).toBeVisible();
  await page.getByRole('link', { name: '이력' }).first().click();
  await expect(page.getByRole('alertdialog', { name: '편집 내용 버리기' })).toBeVisible();
  await page.getByRole('button', { name: '취소' }).click();
  await expect(page).toHaveURL('/verify?sel=v-0007-1');
  await page.getByRole('button', { name: '변경 버리기' }).click();
  await page.getByRole('link', { name: '이력' }).first().click();
  await expect(page).toHaveURL('/history');
});

test('UAT-VERIFY-02: Evidence 행을 누르면 소속 검증 결과로 이동, 검증에 없는 체크 증거는 따로 경고', async ({ page }) => {
  await open(page, '/verify?tab=evidence', (d) => {
    d.evidence.push({ id: 'e9', taskKey: 'TASK-0004', attemptId: 'att-0004-1', verificationId: null, checklistItemKey: 'CL-0004-2', kind: 'SQL', sha256: '9'.repeat(64), size: 5 });
    // 고아 판정은 체크리스트 참조 기준이다: TASK-0004 체크리스트가 검증 없는 Evidence e9를 가리킨다.
    const t4 = d.tasks.find((t) => t.taskKey === 'TASK-0004');
    if (t4) t4.checklist = { done: 0, total: 1 };
    d.details.set('TASK-0004', taskDetail('TASK-0004', [{ itemKey: 'CL-0004-2', content: 'Seed 검증', evidence: 'e9' }]));
  });
  await expect(tabs(page).nth(1)).toHaveText('Evidence 6');
  const evTable = page.getByRole('table', { name: 'Evidence' });
  await expect(evTable.getByRole('row').filter({ hasText: 'SQL' }).getByRole('cell').nth(2)).toHaveText('검증 없음');
  await expect(page.getByRole('status').filter({ hasText: '검증 결과에 없는 체크리스트 Evidence' })).toContainText('TASK-0004 CL-0004-2 → SQL · 999999999999');
  await evTable.getByRole('button', { name: '로그 · aaaaaaaaaaaa' }).click();
  await expect(page).toHaveURL('/verify?sel=v-0007-1');
  await expect(page.getByRole('region', { name: '검증 결과 V-0007-1 상세' })).toBeVisible();
});

test('UAT-EMPTY-04 a: 연결 Evidence 없음·체크리스트 없음 안내', async ({ page }) => {
  await open(page, '/verify?sel=v-0001-1', (d) => { d.evidence = d.evidence.filter((e) => e.taskKey !== 'TASK-0001'); });
  const detail = page.getByRole('region', { name: '검증 결과 V-0001-1 상세' });
  await expect(detail).toContainText('연결된 Evidence가 없습니다. Runner가 이 검증 결과와 함께 Evidence를 올리거나, 아래에서 경로를 추가하면 여기에 표시됩니다.');
  await expect(detail).toContainText('이 Task에는 체크리스트가 없어 Evidence를 항목에 연결할 수 없습니다.');
});

test('UAT-VERIFY-03: Task×5조건·사유·합계가 서버 Gate와 같고, 미통과만/전체, Task 선택은 상세로', async ({ page }) => {
  await open(page, '/verify?tab=gate');
  const gate = page.getByRole('table', { name: 'Completion Gate' });
  const rows = gate.locator('[data-task]');
  await expect(rows).toHaveCount(9);
  const t7 = gate.locator('[data-task="TASK-0007"]');
  await expect(t7.locator('[data-gate] .vf')).toHaveText(['FAIL', 'FAIL', 'FAIL', 'FAIL', 'PASS']);
  await expect(t7.locator('[data-gate="defects"] .vf')).toHaveAttribute('title', '차단 결함 — TASK-0007 defects 사유 F');
  await expect(t7.locator('.gc').last()).toHaveText('1/5');
  await expect(gate.locator('[data-task="TASK-0010"] .gc').last()).toHaveText('3/5');
  await page.getByRole('group', { name: '표시' }).getByRole('button', { name: '전체' }).click();
  await expect(page).toHaveURL('/verify?tab=gate&gate=all');
  await expect(rows).toHaveCount(12);
  await expect(gate.locator('[data-task="TASK-0001"] .gc').last()).toHaveText('5/5');
  await gate.getByRole('link', { name: 'TASK-0007' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0007?tab=checklist');
});

test('UAT-VERIFY-03: 미통과 Task가 없으면 안내', async ({ page }) => {
  await open(page, '/verify?tab=gate', (d) => { d.gates = d.gates.filter((g) => g.passed); });
  await expect(page.getByText('미통과 Task가 없습니다.')).toBeVisible();
  await expect(tabs(page).nth(2)).toHaveText('Completion Gate 0 미통과');
});

test('리뷰 3: 체크리스트가 가리키는 증거가 검증 결과에 없으면(문자열 참조 포함) 경고한다', async ({ page }) => {
  await open(page, '/verify?tab=evidence', (d) => {
    d.details.set('TASK-0007', taskDetail('TASK-0007', [
      { itemKey: 'CL-0007-1', content: '필터 시 상위 행 유지', evidence: 'e1' },
      { itemKey: 'CL-0007-2', content: '1,000행 300ms 이내', evidence: 'review-orphan/path.txt' },
    ]));
  });
  const warn = page.getByRole('status').filter({ hasText: '검증 결과에 없는 체크리스트 Evidence' });
  await expect(warn).toContainText('TASK-0007 CL-0007-2 → review-orphan/path.txt');
  await expect(warn).not.toContainText('CL-0007-1');
});

test('리뷰 3: 체크리스트를 읽지 못하면 고아 판정을 못 한다고 알리고 다시 시도할 수 있다', async ({ page }) => {
  const { api, data } = await open(page, '/verify?tab=evidence');
  void data;
  await expect(page.getByRole('table', { name: 'Evidence' })).toBeVisible();
  await page.goto('about:blank');
  let fail = true;
  api.on('GET /api/tasks/TASK-0007', (route) => (fail ? json(route, 500, errorBody('INTERNAL')) : json(route, 200, taskDetail('TASK-0007', [{ itemKey: 'CL-0007-1', content: 'x', evidence: 'gone.txt' }]))));
  await page.goto('/verify?tab=evidence');
  const alert = page.getByRole('alert').filter({ hasText: '체크리스트를 불러오지 못해' });
  await expect(alert).toBeVisible();
  fail = false;
  await alert.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByRole('status').filter({ hasText: '검증 결과에 없는 체크리스트 Evidence' })).toContainText('TASK-0007 CL-0007-1 → gone.txt');
});

test('UAT-VERIFY-02: Evidence 추가 — 빈 경로는 막고, 같은 검증의 중복 경로는 보내지 않으며, 서버 거부 사유를 보인다', async ({ page }) => {
  const { api, data } = await open(page, '/verify?sel=v-0007-1');
  const posts: { body: unknown; key: string | undefined }[] = [];
  api.on('POST /api/verifications/v-0007-1/evidence', async (route, req) => {
    const body = req.postDataJSON() as { path: string };
    posts.push({ body, key: req.headers()['idempotency-key'] });
    if (body.path.startsWith('/')) return json(route, 400, errorBody('VALIDATION_FAILED', { details: { reasons: ['저장소 상대 경로나 HTTP(S) 링크를 입력하세요.'] } }));
    const e = { id: 'e-new', taskKey: 'TASK-0007', attemptId: 'att-0007-2', verificationId: 'v-0007-1', checklistItemKey: null, kind: 'reference', path: body.path, sha256: null, size: null };
    data.evidence.push(e);
    await json(route, 201, e);
  });
  const input = page.getByLabel('Evidence 경로');
  const add = page.getByRole('button', { name: 'Evidence 추가' });
  await expect(add).toBeDisabled();
  await input.fill('   ');
  await expect(add).toBeDisabled();
  await input.fill('/etc/passwd');
  await add.click();
  await expect(page.getByText('저장소 상대 경로나 HTTP(S) 링크를 입력하세요.')).toBeVisible();
  await expect(input).toHaveValue('/etc/passwd');
  await input.fill('evidence/TASK-0007/qa-1/vitest.txt');
  await add.click();
  await expect(page.getByText('Evidence를 추가했습니다.')).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(page.locator('.evrow').filter({ hasText: 'evidence/TASK-0007/qa-1/vitest.txt' })).toBeVisible();
  await expect(page.getByRole('group', { name: '검증 화면 탭' }).getByRole('button').nth(1)).toHaveText('Evidence 6');
  // 같은 검증에 같은 경로는 보내지 않는다
  await input.fill(' evidence/TASK-0007/qa-1/vitest.txt ');
  await add.click();
  await expect(page.getByText('이미 이 검증에 연결된 Evidence 경로입니다.')).toBeVisible();
  expect(posts.map((p) => p.body)).toEqual([{ path: '/etc/passwd' }, { path: 'evidence/TASK-0007/qa-1/vitest.txt' }]);
  expect(posts.every((p) => typeof p.key === 'string' && p.key.length > 0)).toBe(true);
});
