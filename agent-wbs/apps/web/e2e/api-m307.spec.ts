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

/** 같은 세션의 CSRF로 변경 요청을 보낸다(시험 준비용). */
const send = (page: Page, method: string, path: string, body: unknown) => page.evaluate(async ({ method, path, body }) => {
  const session = await fetch('/api/session').then((r) => r.json() as Promise<{ csrfToken: string }>);
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as unknown };
}, { method, path, body });

test('실제 API: 대시보드 숫자·패널·경고가 서버 응답과 같다(UAT-DASH-01)', async ({ page }) => {
  await login(page, '/dashboard');
  const d = await page.evaluate(() => fetch('/api/dashboard').then(async (r) => ({ status: r.status, body: await r.json() as {
    tasks: { total: number; done: number; active: number; blocked: number };
    panels: Record<string, unknown[]>; recent: unknown[]; grades: unknown[];
  } })));
  expect(d.status).toBe(200);
  const t = d.body.tasks;
  for (const [label, n] of [['전체 Task', t.total], ['완료', t.done], ['진행 중', t.active], ['선행 차단', t.blocked]] as const) {
    await expect(page.getByRole('link', { name: `${label} ${String(n)}건 — WBS에서 보기` })).toBeVisible();
  }
  const panelNames: [string, string][] = [['late', '일정 지연'], ['approvals', 'Planning · 승인 대기'], ['executions', '실행 진행 · 대기'], ['rework', 'QA 실패 · 재작업'], ['gate', 'Completion Gate 미통과'], ['messages', '메시지 확인 필요']];
  for (const [key, name] of panelNames) {
    await expect(page.getByRole('region', { name, exact: true }).locator('.dp-n')).toHaveText(String(d.body.panels[key]?.length ?? 0));
  }
  await expect(page.getByRole('region', { name: '최근 실행 · 검증 결과', exact: true }).locator('.dl-i')).toHaveCount(Math.min(8, d.body.recent.length));
  await expect(page.getByRole('table', { name: '실행 등급별 결과' }).locator('.gtr:not(.h)')).toHaveCount(d.body.grades.length);
  const alerts = await page.evaluate(() => fetch('/api/alerts').then((r) => r.json() as Promise<{ items: unknown[] }>));
  await expect(page.getByRole('region', { name: '팀장 확인 필요' }).locator('.al-row')).toHaveCount(alerts.items.length);
});

test('실제 API: Evidence 경로 추가 — 빈 경로 막기, 잘못된 경로·중복은 서버 사유, 추가 후 건수 일치(UAT-VERIFY-02)', async ({ page }) => {
  await login(page, '/verify');
  const verifs = await readAll(page, '/api/verifications') as { id: string; taskKey: string }[];
  const v7 = verifs.find((v) => v.taskKey === 'TASK-0007');
  if (!v7) throw new Error('demo seed에 TASK-0007 검증이 없다');
  // 서버 자체도 빈 경로·중복을 거부하는지(화면 우회 요청)
  expect((await send(page, 'POST', `/api/verifications/${v7.id}/evidence`, { path: '   ' })).status).toBe(400);
  await page.goto(`/verify?sel=${v7.id}`);
  const input = page.getByLabel('Evidence 경로');
  const add = page.getByRole('button', { name: 'Evidence 추가' });
  await expect(add).toBeDisabled();
  await input.fill('../secret.txt');
  await add.click();
  await expect(page.getByText('저장소 상대 경로나 HTTP(S) 링크를 입력하세요.')).toBeVisible();
  const before = (await readAll(page, '/api/evidence')).length;
  await input.fill('evidence/TASK-0007/qa-1/perf.json');
  await add.click();
  await expect(page.getByText('Evidence를 추가했습니다.')).toBeVisible();
  await expect(page.locator('.evrow').filter({ hasText: 'evidence/TASK-0007/qa-1/perf.json' })).toContainText('측정 데이터');
  await expect(page.getByRole('group', { name: '검증 화면 탭' }).getByRole('button').nth(1)).toHaveText(`Evidence ${String(before + 1)}`);
  // 화면은 같은 검증의 중복을 보내지 않고, 서버도 중복을 거부한다.
  await input.fill('evidence/TASK-0007/qa-1/perf.json');
  await add.click();
  await expect(page.getByText('이미 이 검증에 연결된 Evidence 경로입니다.')).toBeVisible();
  const dup = await send(page, 'POST', `/api/verifications/${v7.id}/evidence`, { path: 'evidence/TASK-0007/qa-1/perf.json' });
  expect(dup.status).toBe(400);
  expect((await readAll(page, '/api/evidence')).length).toBe(before + 1);
});

test('실제 API: 체크리스트가 검증에 없는 증거를 가리키면 Evidence 탭이 경고한다(리뷰 3, P L6354)', async ({ page }) => {
  await login(page, '/verify');
  const task = await page.evaluate(() => fetch('/api/tasks/TASK-0007').then((r) => r.json() as Promise<{ updatedAt: string }>));
  const res = await send(page, 'PATCH', '/api/tasks/TASK-0007/checklist/CL-0007-2', { updatedAt: task.updatedAt, evidence: 'review-orphan/path.txt' });
  expect(res.status).toBe(200);
  await page.goto('/verify?tab=evidence');
  await expect(page.getByRole('status').filter({ hasText: '검증 결과에 없는 체크리스트 Evidence' })).toContainText('TASK-0007 CL-0007-2 → review-orphan/path.txt');
});
