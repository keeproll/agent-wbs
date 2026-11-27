/**
 * M6-01 보고서 화면 — 실제 API·전용 DB(demo seed)로 확인한다(G§12 시나리오 16의 화면 부분).
 * `pnpm --filter @awbs/web e2e:api:report`가 환경을 만든다. 환경 변수가 없으면(일반 `W e2e`) 건너뛴다.
 * 화면 숫자는 같은 세션으로 서버 API를 직접 읽은 스냅샷과 비교한다.
 */
import { expect, test, type Page } from '@playwright/test';
import { internalTerms } from '@awbs/shared';

const password = process.env.AWBS_E2E_PASSWORD ?? '';
const shots = process.env.AWBS_E2E_SHOTS ?? '';
test.skip(!password || !process.env.AWBS_E2E_API, '실제 API 환경이 없다. pnpm --filter @awbs/web e2e:api:report로 실행한다.');
test.describe.configure({ mode: 'serial' });

const serverErrors: string[] = [];
test.beforeEach(({ page }) => {
  page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.request().method()} ${new URL(r.url()).pathname} ${String(r.status())}`); });
});
test.afterAll(() => { expect(serverErrors, '실제 API 5xx').toEqual([]); });

let cookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> = [];
async function login(page: Page, path: string) {
  if (cookies.length) { await page.context().addCookies(cookies); await page.goto(path); return; }
  await page.goto(path);
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(path);
  cookies = await page.context().cookies();
}
const api = (page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/api/${p}`)).json() as Promise<Record<string, unknown>>, path);

test('보고서 없음 → 기간 지정 오류 → 생성 → 팀장용 12섹션 → 보고용 전환(내부 용어 0건, 같은 숫자)', async ({ page }) => {
  await login(page, '/report');
  await expect(page.getByText('아직 보고서가 없습니다.')).toBeVisible();
  const form = page.getByRole('region', { name: '기간 지정 보고서' });
  await form.getByRole('button', { name: '보고서 생성' }).click();
  await expect(form.getByRole('alert')).toHaveText('시작일과 종료일을 모두 입력하세요.');
  await form.getByLabel('시작일').fill('2026-11-01');
  await form.getByLabel('종료일').fill('2026-10-26');
  await form.getByRole('button', { name: '보고서 생성' }).click();
  await expect(form.getByRole('alert')).toHaveText('시작일이 종료일보다 늦습니다.');
  await form.getByLabel('시작일').fill('2026-10-26');
  await form.getByLabel('종료일').fill('2026-11-01');
  await form.getByRole('button', { name: '보고서 생성' }).click();
  await expect(page).toHaveURL(/\/report\/[0-9a-f-]{36}\?view=int/);

  const doc = page.getByRole('article', { name: /RPT-C-001 보고서/ });
  await expect(doc).toBeVisible();
  for (const h of ['팀장 확인 필요', '일별 추세', '1. 완료한 Task', '2. 진행 중 · 확인 필요 Task', '3. QA 실패 · 결함 상세', '4. 실행 기록', '5. 일정 재조정', '6. 작업 환경 중단', '7. 팀장 지시 · Runner 응답', '8. 다음 주 예정', '부록. 전체 Task 현황 (기간 끝 시점)']) {
    await expect(doc.getByRole('heading', { name: h, exact: true })).toBeVisible();
  }
  const id = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  const server = await api(page, `reports/${id}`) as { snapshot: { done: unknown[]; summary: { doneCount: number; taskCount: number; workPct: number } } };
  const kpis = doc.locator('.rpt-kpi');
  await expect(kpis.nth(0)).toContainText(`${String(server.snapshot.done.length)}건`);
  await expect(kpis.nth(0)).toContainText(`누적 ${String(server.snapshot.summary.doneCount)} / ${String(server.snapshot.summary.taskCount)}건`);
  await expect(kpis.nth(1)).toContainText(`${String(server.snapshot.summary.workPct)}%`);
  await expect(doc.getByRole('table', { name: '전체 Task 현황' }).getByRole('row')).toHaveCount(server.snapshot.summary.taskCount + 1);
  expect(internalTerms(await doc.innerText()).length).toBeGreaterThan(0);
  if (shots) await page.screenshot({ path: `${shots}/report-int-1440.png`, fullPage: true });

  await page.getByRole('group', { name: '보고서 보기' }).getByRole('button', { name: '보고용 (요약)' }).click();
  await expect(page).toHaveURL(/view=ext/);
  await expect(doc.getByRole('heading', { name: '요약' })).toBeVisible();
  await expect(doc.locator('.rpt-kpi').nth(0)).toContainText(`${String(server.snapshot.done.length)}건`);
  await expect(doc.locator('.rpt-kpi').nth(1)).toContainText(`${String(server.snapshot.summary.workPct)}%`);
  expect(internalTerms((await doc.innerText()).replace(/RPT-C-\d+/g, ''))).toEqual([]);
  if (shots) await page.screenshot({ path: `${shots}/report-ext-1440.png`, fullPage: true });

  // 목록 필터와 빈 상태
  await page.getByRole('group', { name: '보고서 종류' }).getByRole('button', { name: /^일간/ }).click();
  await expect(page.getByText('해당 종류의 보고서가 없습니다.')).toBeVisible();
});

test('PDF 다운로드: 서버 PDF를 받고, 생성 실패면 본문은 그대로 두고 다시 시도·기간 분리 안내를 보인다(M6-02, UAT-REPORT-05)', async ({ page }) => {
  await login(page, '/report');
  await page.getByRole('button', { name: /RPT-C-001/ }).click();
  const doc = page.getByRole('article', { name: /RPT-C-001 보고서/ });
  await expect(doc).toBeVisible();

  // 성공: 실제 서버가 만든 PDF를 G L410 이름으로 저장한다.
  const ok = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF 다운로드' }).click();
  const file = await ok;
  expect(file.suggestedFilename()).toBe('RPT-C-001_팀장용.pdf');
  const head = await (await file.createReadStream()).take(1).toArray() as Buffer[];
  expect(Buffer.concat(head).subarray(0, 5).toString()).toBe('%PDF-');

  // 실패: 서버가 503 PDF_FAILED(계약 모양)를 준다. 이 응답은 시험이 만든 것이라 5xx 목록에서 뺀다.
  const before = serverErrors.length;
  await page.route('**/api/reports/*/pdf?*', (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'PDF_FAILED', message: 'PDF를 만들지 못했습니다. 화면의 보고서는 계속 볼 수 있습니다.', action: '보고서 PDF 다운로드',
      fix: '잠시 후 다시 시도하세요. 계속 실패하면 기간을 나눠 보고서를 생성하세요.', errors: [], details: {}, requestId: 'e2e' } }),
  }));
  let downloads = 0;
  page.on('download', () => { downloads++; });
  await page.getByRole('button', { name: 'PDF 다운로드' }).click();
  const bar = page.locator('.errbar');
  await expect(bar).toContainText('PDF를 만들지 못했습니다');
  await expect(bar).toContainText('503 PDF_FAILED');
  await expect(bar).toContainText('기간을 나눠 보고서를 생성하세요');
  await expect(bar).toContainText('대상: PDF 생성 (RPT-C-001_팀장용.pdf)');
  // 본문은 그대로이고, 오류 본문을 파일로 저장하지 않는다.
  await expect(doc).toBeVisible();
  expect(downloads).toBe(0);
  if (shots) await page.screenshot({ path: `${shots}/report-pdf-fail-1440.png` });
  serverErrors.splice(before);

  // 다시 시도: 서버가 정상이면 받는다.
  await page.unroute('**/api/reports/*/pdf?*');
  const retried = page.waitForEvent('download');
  await bar.getByRole('button', { name: '다시 시도' }).click();
  expect((await retried).suggestedFilename()).toBe('RPT-C-001_팀장용.pdf');
  await expect(bar).toHaveCount(0);
});

test('390px: 가로 넘침 없이 보고서 목록과 문서를 본다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, '/report');
  await expect(page.getByRole('article')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // 화면 안의 카드(목록·문서)가 오른쪽 끝을 넘지 않는다.
  for (const box of [await page.getByRole('region', { name: '보고서 목록' }).boundingBox(), await page.getByRole('article').boundingBox()]) {
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  }
  if (shots) await page.screenshot({ path: `${shots}/report-390.png`, fullPage: true });
  // 리뷰 4: 핵심 지표 값끼리 겹치지 않는다(페이지 폭 검사만으로는 못 잡는다). 팀장용·보고용 모두.
  for (const view of ['팀장용 (상세)', '보고용 (요약)']) {
    await page.getByRole('group', { name: '보고서 보기' }).getByRole('button', { name: view }).click();
    await expect(page.getByRole('article').getByRole('heading', { name: view.startsWith('팀장') ? '팀장 확인 필요' : '요약', exact: true })).toBeVisible();
    const boxes = await page.locator('.rpt-kpi .rpt-kv, .rpt-kpi .rpt-ks, .rpt-kpi .rpt-kl').evaluateAll((els) => els.map((e) => {
      const range = document.createRange(); range.selectNodeContents(e); const r = range.getBoundingClientRect();
      return { x: r.left, y: r.top, r: r.right, b: r.bottom, t: e.textContent };
    }));
    const hits = boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5).map((b) => `${String(a.t)} ↔ ${String(b.t)}`));
    expect(hits, view).toEqual([]);
    for (const k of boxes) expect(k.r, `${String(k.t)} 오른쪽 끝`).toBeLessThanOrEqual(390);
    if (shots) await page.locator('.rpt-kpis').screenshot({ path: `${shots}/fix1-kpis-390-${view.startsWith('팀장') ? 'int' : 'ext'}.png` });
  }
});
