/**
 * M3 통합 — 서버 후속 2차 API에 새로 연결한 화면을 실제 API·전용 DB(demo seed)로 확인한다.
 * `pnpm --filter @awbs/web e2e:api:m3int`가 환경을 만든다. 환경 변수가 없으면(일반 `W e2e`) 건너뛴다.
 * 화면 결과는 같은 세션으로 서버 API를 직접 읽은 값과 비교한다.
 */
import { expect, test, type Page } from '@playwright/test';

const password = process.env.AWBS_E2E_PASSWORD ?? '';
test.skip(!password || !process.env.AWBS_E2E_API, '실제 API 환경이 없다. pnpm --filter @awbs/web e2e:api:m3int로 실행한다.');
test.describe.configure({ mode: 'serial' });

const serverErrors: string[] = [];
test.beforeEach(({ page }) => {
  page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.request().method()} ${new URL(r.url()).pathname} ${String(r.status())}`); });
});
test.afterAll(() => { expect(serverErrors, '실제 API 5xx').toEqual([]); });

/** 로그인은 한 번만 하고 세션 쿠키를 다시 쓴다(서버의 로그인 횟수 제한, UAT-AUTH-03). */
let cookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> = [];
async function login(page: Page, path: string) {
  if (cookies.length) {
    await page.context().addCookies(cookies);
    await page.goto(path);
    await expect(page).toHaveURL(path);
    return;
  }
  await page.goto(path);
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(path);
  cookies = await page.context().cookies();
}

/** 같은 세션으로 서버에 직접 요청한다(화면 결과와 비교하거나 시험 준비용). */
const apiCall = (page: Page, path: string, method = 'GET', body?: unknown) => page.evaluate(async ({ p, m, b }) => {
  const csrf = (await (await fetch('/api/session')).json() as { csrfToken?: string }).csrfToken ?? '';
  const res = await fetch(`/api/${p}`, {
    method: m,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() },
    ...(b === undefined ? {} : { body: JSON.stringify(b) }),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() as Record<string, unknown> };
}, { p: path, m: method, b: body });

test('UAT-PROJECT-10 실제 서버: 프로젝트 정보 편집이 저장되고 다시 읽어도 같다', async ({ page }) => {
  await login(page, '/project');
  const card = page.getByRole('region', { name: '프로젝트 정보' });
  await card.getByRole('button', { name: '편집' }).click();
  const name = `Agent WBS 통합 확인 ${String(Date.now() % 100000)}`;
  await card.getByLabel('이름').fill(name);
  await card.getByLabel('설명').fill('M3 통합 실제 서버 편집');
  await card.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText('프로젝트 정보를 저장했습니다.')).toBeVisible();
  await expect(card).toContainText(name);
  const p = (await apiCall(page, 'project')).body as { name: string; description: string };
  expect(p.name).toBe(name);
  expect(p.description).toBe('M3 통합 실제 서버 편집');
  await page.reload();
  await expect(page.getByRole('region', { name: '프로젝트 정보' })).toContainText(name);
});

test('UAT-PROJECT-09 b 실제 서버: 「지금 확인」은 202로 접수되고(GitHub 인증이 없으면 버튼이 꺼짐), 확인 시각은 서버 값 그대로다', async ({ page }) => {
  await login(page, '/project');
  const before = (await apiCall(page, 'project')).body as { inputCheckedAt: string | null };
  const gh = (await apiCall(page, 'settings/github')).body as Record<string, unknown>;
  console.log(`[GitHub 상태] ${JSON.stringify(gh)}`);
  const button = page.getByRole('button', { name: '지금 확인' });
  if (await button.isDisabled()) {
    // demo seed에는 GitHub 인증이 없다. 원본처럼 버튼을 끄고 이유를 보인다(원본 inFetch 「GitHub 인증이 없어 확인할 수 없습니다」).
    await expect(button).toHaveAttribute('title', /GitHub 인증이 없어 확인할 수 없습니다/);
    // 서버 계약 자체(202·요청 번호)는 같은 세션으로 직접 확인한다.
    const r = await apiCall(page, 'project/inputs/check', 'POST', { updatedAt: (before as unknown as { updatedAt: string }).updatedAt });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(typeof (r.body as { inputCheckRequest: number }).inputCheckRequest).toBe('number');
  } else {
    const [resp] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/project/inputs/check')), button.click()]);
    expect(resp.status()).toBe(202);
    await expect(page.getByText('main 확인을 요청했습니다', { exact: false })).toBeVisible();
  }
  await page.reload();
  // 요청만으로는 확인 시각이 바뀌지 않는다(Runner 관측 보고 뒤에만 바뀜).
  await expect(page.getByTestId('input-checked-at')).toHaveText(before.inputCheckedAt ? /^Runner 확인 / : 'Runner 확인 기록 없음');
  console.log(`[지금 확인] ${await page.getByTestId('input-checked-at').innerText()}`);
});

test('변경 제안 실제 서버: 표시 키 주소는 단건 조회로 열리고, 수정 요청 중 「제외」가 그 항목만 뺀다', async ({ page }) => {
  await login(page, '/change');
  const created = await apiCall(page, 'proposals', 'POST', {
    title: 'M3 통합 제외 확인', reason: '실제 서버에서 항목 제외를 확인한다', source: { kind: 'manual' },
    ops: [{ op: 'dep-remove', pred: 'TASK-0005', succ: 'TASK-0006' }, { op: 'dep-add', pred: 'TASK-0005', succ: 'TASK-0006', type: 'SS' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const cp = created.body as { id: string; cpKey: string; updatedAt: string };
  const submitted = await apiCall(page, `proposals/${cp.id}/submit`, 'POST', { updatedAt: cp.updatedAt });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  const changes = await apiCall(page, `proposals/${cp.id}/request-changes`, 'POST', { updatedAt: (submitted.body as { updatedAt: string }).updatedAt, comment: '항목 하나를 빼세요' });
  expect(changes.status, JSON.stringify(changes.body)).toBe(200);

  // 최근 목록에 있으면 단건 조회 없이 열린다. 단건 조회(표시 키 그대로)는 아래에서 같은 세션으로 직접 확인한다.
  await page.goto(`/change/${cp.cpKey}`);
  const detail = page.locator('.cp-detail');
  await expect(detail.getByRole('heading', { level: 2, name: 'M3 통합 제외 확인' })).toBeVisible();
  const buttons = page.getByRole('region', { name: '변경 전 / 후 비교' }).getByRole('button', { name: /제외/ });
  await expect(buttons).toHaveCount(2);
  await buttons.nth(1).click();
  await expect(page.getByText(`${cp.cpKey}에서 항목을 제외했습니다.`, { exact: false })).toBeVisible();
  await expect(buttons).toHaveCount(1);
  const after = (await apiCall(page, `proposals/${cp.cpKey}`)).body as { ops: { op: string }[] };
  expect(after.ops.map((o) => o.op)).toEqual(['dep-remove']);
});

test('Planning 실제 서버: 세션 목록은 서버 표시 키(planningKey)를 보인다', async ({ page }) => {
  await login(page, '/planning');
  const list = (await apiCall(page, 'plannings?limit=200')).body as { items: { planningKey: string; title: string }[] };
  test.skip(list.items.length === 0, 'demo seed에 Planning 세션이 없다');
  const first = list.items[0];
  await expect(page.getByRole('complementary', { name: 'Planning 목록' })).toContainText(`${first?.planningKey ?? ''}${first?.title ?? ''}`);
  console.log(`[Planning 키] ${list.items.map((p) => p.planningKey).join(', ')}`);
});
