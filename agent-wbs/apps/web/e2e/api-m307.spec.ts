/**
 * M3-07 핵심 흐름을 실제 API·전용 DB(demo seed)로 확인한다. `pnpm --filter @awbs/web e2e:api:m307`가 환경을 만든다.
 * 환경 변수가 없으면(일반 `W e2e`) 건너뛴다.
 * 화면 숫자는 같은 세션으로 서버 API를 직접 읽은 값과 비교한다(UAT-VERIFY-01 b, UAT-VERIFY-02 b, UAT-VERIFY-03, UAT-HISTORY-01).
 */
import { expect, test, type Page } from '@playwright/test';

const password = process.env.AWBS_E2E_PASSWORD ?? '';
test.skip(!password || !process.env.AWBS_E2E_API, '실제 API 환경이 없다. pnpm --filter @awbs/web e2e:api:m307로 실행한다.');
test.describe.configure({ mode: 'serial' });

const serverErrors: string[] = [];
test.beforeEach(({ page }) => {
  page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.request().method()} ${new URL(r.url()).pathname} ${String(r.status())}`); });
});
test.afterAll(() => { if (serverErrors.length) console.log(`[실제 API 5xx] ${serverErrors.join(' | ')}`); });

async function login(page: Page, path: string) {
  await page.goto(path);
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(path);
}
/** 같은 세션으로 서버 목록을 끝까지 읽는다. */
const readAll = (page: Page, path: string) => page.evaluate(async (p) => {
  const items: unknown[] = [];
  let cursor: string | null = null;
  do {
    const sep = p.includes('?') ? '&' : '?';
    const res = await fetch(`${p}${sep}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    items.push(...body.items);
    cursor = body.nextCursor;
  } while (cursor);
  return items;
}, path);

test('실제 API: 검증 탭 건수·목록·Gate가 서버 데이터와 같다', async ({ page }) => {
  await login(page, '/verify');
  const verifs = await readAll(page, '/api/verifications') as { id: string; taskKey: string; result: string }[];
  const evidence = await readAll(page, '/api/evidence');
  const gates = await page.evaluate(() => fetch('/api/gates').then((r) => r.json() as Promise<{ items: { taskKey: string; passed: boolean }[] }>));
  const tasks = await page.evaluate(async () => {
    const project = await fetch('/api/project').then((r) => r.json() as Promise<{ id: string }>);
    return fetch(`/api/projects/${project.id}/tasks`).then((r) => r.json() as Promise<{ tasks: { taskKey: string; lifecycleStatus: string }[] }>);
  });
  const cancelled = new Set(tasks.tasks.filter((t) => t.lifecycleStatus === 'cancelled').map((t) => t.taskKey));
  const unpassed = gates.items.filter((g) => !g.passed && !cancelled.has(g.taskKey)).length;
  expect(verifs.length).toBeGreaterThan(0);
  await expect(page.getByRole('group', { name: '검증 화면 탭' }).getByRole('button'))
    .toHaveText([`검증 결과 ${String(verifs.length)}`, `Evidence ${String(evidence.length)}`, `Completion Gate ${String(unpassed)} 미통과`]);
  await expect(page.locator('[data-vrow]')).toHaveCount(verifs.length);
  await expect(page.locator('[data-vrow]').filter({ hasText: 'TASK-0007' })).toContainText('FAIL');
  await page.getByRole('group', { name: '검증 화면 탭' }).getByRole('button', { name: /Completion Gate/ }).click();
  await expect(page.getByRole('table', { name: 'Completion Gate' }).locator('[data-task]')).toHaveCount(unpassed);
});

test('실제 API: Evidence ↔ 체크리스트 연결과 해제가 서버에 저장된다(UAT-VERIFY-02)', async ({ page }) => {
  await login(page, '/verify');
  const verifs = await readAll(page, '/api/verifications') as { id: string; taskKey: string }[];
  const v7 = verifs.find((v) => v.taskKey === 'TASK-0007');
  if (!v7) throw new Error('demo seed에 TASK-0007 검증이 없다');
  await page.goto(`/verify?sel=${v7.id}`);
  const row = page.locator('.evrow').first();
  const chip = row.getByRole('button', { name: 'CL-0007-1', exact: true });
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await chip.click();
  await expect(page.getByText('Evidence 연결을 저장했습니다.')).toBeVisible();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  const linked = await readAll(page, '/api/evidence?taskKey=TASK-0007') as { checklistItemKey: string | null }[];
  expect(linked.map((e) => e.checklistItemKey)).toEqual(['CL-0007-1']);
  await page.reload();
  await expect(page.locator('.evrow').first().getByRole('button', { name: 'CL-0007-1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: '검증 화면 탭' }).getByRole('button', { name: /Evidence/ }).click();
  await expect(page.getByRole('table', { name: 'Evidence' }).getByRole('row').nth(1).getByRole('cell').nth(4)).toHaveText('CL-0007-1');
  await page.goto(`/verify?sel=${v7.id}`);
  await page.locator('.evrow').first().getByRole('button', { name: 'CL-0007-1', exact: true }).click();
  await expect(page.locator('.evrow').first().getByRole('button', { name: 'CL-0007-1', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const unlinked = await readAll(page, '/api/evidence?taskKey=TASK-0007') as { checklistItemKey: string | null }[];
  expect(unlinked.map((e) => e.checklistItemKey)).toEqual([null]);
});

test('실제 API: 이력 건수와 서버 기간 필터 결과가 같다(UAT-HISTORY-01)', async ({ page }) => {
  await login(page, '/history');
  const all = await readAll(page, '/api/history');
  await expect(page.locator('.resbar')).toHaveText(`이력 ${String(all.length)}건`);
  const ranged = await readAll(page, '/api/history?from=2026-11-01&to=2026-11-02') as { at: string }[];
  await page.getByLabel('기간 시작').fill('2026-11-01');
  await page.getByLabel('기간 끝').fill('2026-11-02');
  await expect(page.locator('.resbar')).toHaveText(`이력 ${String(ranged.length)}건`);
  await expect(page.getByRole('table', { name: '이력' }).locator('.gtr:not(.h):not([data-empty])')).toHaveCount(ranged.length);
});

test('실제 API: 대시보드 경고 API는 응답하고, 대시보드 본문 API는 서버 미구현(보고한 결함)', async ({ page }) => {
  await login(page, '/dashboard');
  const alerts = await page.evaluate(() => fetch('/api/alerts').then((r) => r.status));
  expect(alerts).toBe(200);
  const dash = await page.evaluate(() => fetch('/api/dashboard').then((r) => r.status));
  // 서버 후속 2차에서 GET /api/dashboard가 들어오면 이 기대를 200으로 바꾸고 화면 숫자 비교를 더한다.
  expect(dash).toBe(404);
  await expect(page.getByRole('region', { name: '대시보드 화면을 불러오지 못했습니다' })).toBeVisible();
});
