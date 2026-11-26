/**
 * M3-03 실제 API(LAN 모드)·실제 DB(demo seed = 원본 Mock 12 Task) — `pnpm --filter @awbs/web e2e:api:task`가 환경을 만든다.
 * UAT-APPROVE-01(요청 거부·승인·반려·이력), UAT-TASK-01(요약), UAT-TASK-02(개요 저장·이력), UAT-TASK-09(체크리스트 추가).
 * 환경 변수가 없으면(일반 `W e2e`) 건너뛴다.
 */
import { expect, test, type Page } from '@playwright/test';

const password = process.env.AWBS_E2E_PASSWORD ?? '';
test.skip(!password || !process.env.AWBS_E2E_API, '실제 API 환경이 없다. pnpm --filter @awbs/web e2e:api:task로 실행한다.');
test.describe.configure({ mode: 'serial' });

const serverErrors: string[] = [];
test.beforeEach(({ page }) => {
  page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.request().method()} ${new URL(r.url()).pathname} ${String(r.status())}`); });
});
test.afterAll(() => { if (serverErrors.length) console.log(`[실제 API 5xx] ${serverErrors.join(' | ')}`); });

/**
 * 서버는 비밀번호 로그인 시도 수를 제한한다(429 RATE_LIMITED). 시험마다 로그인하면 6번째부터 막히므로
 * 첫 시험에서 한 번 로그인하고 그 세션(쿠키)을 다음 시험에 다시 쓴다.
 */
let sessionState: Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>> | null = null;
async function login(page: Page, path: string) {
  if (sessionState) await page.context().addCookies(sessionState.cookies);
  await page.goto(path);
  if (!sessionState) {
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('비밀번호').fill(password);
    await page.getByRole('button', { name: '로그인' }).click();
  }
  await expect(page).toHaveURL(path);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  sessionState = await page.context().storageState();
}
const status = (page: Page) => page.locator('.summary .st');

test('UAT-TASK-01 실제 서버 요약·9탭', async ({ page }) => {
  await login(page, '/wbs/TASK-0004');
  await expect(page.getByRole('heading', { level: 2, name: 'Drizzle Schema 설계' })).toBeVisible();
  await expect(page.locator('.idchip')).toHaveText('TASK-0004');
  await expect(page.getByRole('tablist', { name: 'Task 상세 탭' }).getByRole('tab')).toHaveCount(9);
  console.log(`[TASK-0004 요약] ${await page.locator('.summary').innerText()}`.replace(/\n/g, ' | '));
  console.log(`[TASK-0004 탭] ${(await page.getByRole('tablist', { name: 'Task 상세 탭' }).innerText()).replace(/\n/g, ' ')}`);
});

test('UAT-APPROVE-01 실제 서버: 명세 미완료 요청 400 거부, 판단 기록이 있는 승인은 실행 대기, 반려는 planning·사유 이력', async ({ page }) => {
  await login(page, '/wbs/TASK-0009');
  console.log(`[TASK-0009 상태] ${await status(page).innerText()}`);
  const bar = page.locator('.appr-bar');
  if (await bar.getByRole('button', { name: '착수 승인 요청' }).count()) {
    await bar.getByRole('button', { name: '착수 승인 요청' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('400');
    console.log(`[요청 거부] ${(await alert.innerText()).replace(/\n/g, ' | ')}`);
    await expect(status(page)).toHaveText('계획 중');
  }

  // 승인 대기 Task: 처음에는 demo seed에 분할 기준 판단 기록이 없어 409 SPLIT_JUDGEMENT_REQUIRED였다(D-33).
  // M3 통합: 서버 후속(7788dcc)이 demo seed에 판단 기록(judged_rules)을 넣어 이제 실제 서버도 승인을 받아들인다. 그래서 승인 성공 흐름을 확인한다.
  await page.goto('/wbs/TASK-0010');
  await expect(status(page)).toHaveText('승인 대기');
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/tasks/TASK-0010/approve')),
    page.locator('.appr-bar').getByRole('button', { name: '승인', exact: true }).click(),
  ]);
  expect(resp.status()).toBe(200);
  await expect(status(page)).not.toHaveText('승인 대기');
  console.log(`[TASK-0010 승인] ${await status(page).innerText()}`);

  // 승인 대기 Task: 반려(사유) → 계획 중
  await page.goto('/wbs/TASK-0012');
  await expect(status(page)).toHaveText('승인 대기');
  await page.locator('.appr-bar').getByRole('button', { name: '반려' }).click();
  await page.getByRole('dialog', { name: '착수 반려' }).getByLabel('반려 사유').fill('실제 서버 반려 시험');
  await page.getByRole('dialog', { name: '착수 반려' }).getByRole('button', { name: '반려' }).click();
  await expect(status(page)).toHaveText('계획 중');
  await page.getByRole('tab', { name: /^이력/ }).click();
  console.log(`[TASK-0012 이력] ${(await page.getByRole('table', { name: '이력' }).innerText()).replace(/\n/g, ' | ').slice(0, 600)}`);
});

test('UAT-TASK-02·09 실제 서버: 개요 제목 저장·체크리스트 추가가 이력에 남는다', async ({ page }) => {
  await login(page, '/wbs/TASK-0006');
  await page.getByRole('button', { name: '개요 편집' }).click();
  await page.locator('#ov-title').fill('Dependency 검증 (실제 서버 저장)');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Dependency 검증 (실제 서버 저장)' })).toBeVisible();
  await page.getByRole('tab', { name: /^체크리스트/ }).click();
  await page.getByLabel('체크 내용').fill('실제 서버 항목');
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await expect(page.getByRole('table', { name: '체크리스트' })).toContainText('실제 서버 항목');
  await page.getByRole('tab', { name: /^이력/ }).click();
  const hist = page.getByRole('table', { name: '이력' });
  await expect(hist).toContainText('실제 서버 저장');
  await expect(hist).toContainText('실제 서버 항목');
});

/** 같은 세션으로 서버에 직접 요청한다(다른 사용자의 저장을 흉내 낸다). */
async function apiCall(page: Page, path: string, method = 'GET', data?: unknown): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const session = (await (await page.request.get('/api/session')).json()) as { csrfToken: string };
  const origin = new URL(page.url()).origin;
  const r = await page.request.fetch(`/api/${path}`, { method, headers: { origin, 'x-csrf-token': session.csrfToken, 'idempotency-key': crypto.randomUUID() }, ...(data === undefined ? {} : { data }) });
  return { status: r.status(), body: await r.json().catch(() => null) };
}

test('재리뷰 P1 실제 서버: 설계 충돌 「다시 적용」은 내가 바꾼 블록만 최신 위에 얹고 상대가 고친 테이블 설명을 지키다', async ({ page }) => {
  await login(page, '/wbs/TASK-0004?tab=tech');
  const db = page.getByRole('region', { name: 'DB 설계', exact: true });
  await db.getByRole('button', { name: 'Migration 요구사항 편집', exact: true }).click();
  await page.getByRole('form').getByLabel('Migration 요구사항', { exact: true }).fill('내 Migration 요구사항');
  // 다른 사용자가 같은 DB 설계의 첫 테이블 설명을 저장한다
  const t = (await apiCall(page, 'tasks/TASK-0004')).body;
  const d = t.designs.find((x: { kind: string }) => x.kind === 'DB');
  const changed = structuredClone(d.content);
  changed.ents[0].f.desc = '상대가 고친 테이블 설명';
  expect((await apiCall(page, 'tasks/TASK-0004/design/DB', 'PATCH', { updatedAt: t.updatedAt, content: changed })).status).toBe(200);
  await page.getByRole('button', { name: '저장', exact: true }).first().click();
  const modal = page.getByRole('alertdialog');
  await expect(modal).toContainText('409');
  await modal.getByRole('button', { name: /다시 적용/ }).click();
  await expect(page.getByRole('form')).toHaveCount(0);
  const after = (await apiCall(page, 'tasks/TASK-0004')).body.designs.find((x: { kind: string }) => x.kind === 'DB').content;
  expect(after.b.migration).toEqual(['내 Migration 요구사항']);
  expect(after.ents[0].f.desc).toBe('상대가 고친 테이블 설명');
  expect(after.ents.length).toBe(changed.ents.length);
});

test('재리뷰 P2 실제 서버: 첫 응답 유실 → 새 입력으로 추가 시도(차단) → 이전 요청 다시 시도 성공해도 새 입력은 남는다', async ({ page }) => {
  await login(page, '/wbs/TASK-0006?tab=checklist');
  let lose = true;
  const sent: unknown[] = [];
  await page.route('**/api/tasks/TASK-0006/checklist', async (route) => {
    sent.push(route.request().postDataJSON());
    const r = await route.fetch();
    if (lose) { lose = false; await route.abort(); } else await route.fulfill({ response: r });
  });
  const input = page.getByLabel('체크 내용', { exact: true });
  await input.fill('서버에 저장된 첫 항목');
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('NETWORK_ERROR');
  await input.fill('아직 저장하지 않은 둘째 항목');
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('이전 요청');
  await page.getByRole('alert').getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(page.getByRole('table', { name: '체크리스트', exact: true })).toContainText('서버에 저장된 첫 항목');
  await expect(page.getByRole('button', { name: '추가 중…' })).toHaveCount(0);
  await expect(input).toHaveValue('아직 저장하지 않은 둘째 항목');
  expect(sent.map((x) => (x as { content: string }).content)).toEqual(['서버에 저장된 첫 항목', '서버에 저장된 첫 항목']);
});

test('재리뷰2 P1 실제 서버: 편집 중 서버의 테이블 순서가 바뀌어도 「다시 적용」은 편집을 시작한 그 테이블만 바꾸고 다른 테이블을 덮어쓰지 않는다', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, '/wbs/TASK-0004?tab=tech');
  console.log('[재리뷰2] 열림');
  const before = (await apiCall(page, 'tasks/TASK-0004')).body.designs.find((x: { kind: string }) => x.kind === 'DB').content;
  const names = before.ents.map((e: { f: { name: string } }) => e.f.name) as string[];
  expect(names.slice(0, 2)).toEqual(['wbs_nodes', 'tasks']);
  console.log('[재리뷰2] 이름', names.join(','));
  // 둘째 테이블 tasks의 설명을 바꾼다.
  // M3 통합: 처음에는 테이블 이름을 바꿨다. 이제 서버가 설계의 외래키 대상을 검사해(서버 후속, 설계 서버 검사) 다른 테이블이 참조하는 tasks의 이름 변경은 400이다.
  // 이 시험이 보려는 것(순서가 바뀌어도 편집을 시작한 그 테이블만 바뀜)은 설명 변경으로도 같다.
  await page.getByRole('group', { name: '테이블 tasks' }).getByRole('button', { name: '편집' }).click();
  const renamed = `재리뷰2 설명 ${String(Date.now() % 100000)}`;
  await page.getByRole('form').getByLabel('테이블 설명', { exact: true }).fill(renamed);
  // 다른 사용자가 앞 두 테이블 순서를 바꿔 저장 → 화면 polling이 그 최신 Task를 읽을 때까지 기다린다
  const t = (await apiCall(page, 'tasks/TASK-0004')).body;
  const reordered = structuredClone(t.designs.find((x: { kind: string }) => x.kind === 'DB').content);
  reordered.ents = [reordered.ents[1], reordered.ents[0], ...reordered.ents.slice(2)];
  const polled = page.waitForResponse(async (r) => r.url().endsWith('/api/tasks/TASK-0004') && r.request().method() === 'GET'
    && ((await r.json()) as { designs: { kind: string; content: { ents: { f: { name: string } }[] } }[] }).designs.find((x) => x.kind === 'DB')?.content.ents[0]?.f.name === 'tasks', { timeout: 15_000 });
  expect((await apiCall(page, 'tasks/TASK-0004/design/DB', 'PATCH', { updatedAt: t.updatedAt, content: reordered })).status).toBe(200);
  await polled;
  console.log('[재리뷰2] polling 반영');
  // 편집기 검사도 위치가 아니라 편집 중인 테이블 이름으로 자기 자신을 빼야 한다(순서가 바뀌어도 「이미 정의됨」 오류가 나면 안 됨)
  await expect(page.getByRole('form').getByRole('alert'), '순서 변경 뒤 편집기 검사 오류').toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByRole('button', { name: '저장', exact: true }).first()).toBeEnabled({ timeout: 5_000 });
  await page.getByRole('button', { name: '저장', exact: true }).first().click();
  const modal = page.getByRole('alertdialog');
  await expect(modal).toContainText('409');
  console.log('[재리뷰2] 409');
  await modal.getByRole('button', { name: /다시 적용/ }).click();
  await expect(page.getByRole('form')).toHaveCount(0);
  const ents = (await apiCall(page, 'tasks/TASK-0004')).body.designs.find((x: { kind: string }) => x.kind === 'DB').content.ents as { f: { name: string; desc: string } }[];
  // 편집을 시작한 tasks만 새 설명으로 바뀌고, 순서가 바뀌어 그 위치로 온 wbs_nodes 정의는 그대로 남는다
  expect(ents.map((e) => e.f.name)).toEqual(['tasks', 'wbs_nodes', ...names.slice(2)]);
  expect(ents[0]?.f.desc).toBe(renamed);
  expect(ents[1]?.f.desc).toBe(before.ents[0].f.desc);
});
