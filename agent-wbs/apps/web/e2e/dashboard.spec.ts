/**
 * M3-07 대시보드(UI-01) — UAT-DASH-01, UAT-STATE-01, UAT-PROJECT-11(대시보드 부분), UAT-EMPTY-04(대시보드 부분), D-28.
 * 가짜 API 데이터는 support/m307-data.ts(원본 Mock과 같은 값).
 */
import { expect, test, type Page } from '@playwright/test';
import { fakeApi, hold, json, type FakeApi } from './support/fake-api.ts';
import { installM307, kst, m307Data, type M307Data } from './support/m307-data.ts';

async function open(page: Page, change: (d: M307Data) => void = () => undefined): Promise<{ api: FakeApi; data: M307Data }> {
  const api = await fakeApi(page);
  const data = m307Data();
  change(data);
  installM307(api, data);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1, name: '대시보드' })).toBeVisible();
  return { api, data };
}

test('UAT-DASH-01 a: KPI 숫자와 WBS 필터 주소가 일치한다', async ({ page }) => {
  await open(page);
  const kpi = (name: string) => page.getByRole('link', { name });
  await expect(kpi('전체 Task 12건 — WBS에서 보기')).toHaveAttribute('href', '/wbs');
  await expect(kpi('완료 3건 — WBS에서 보기')).toHaveAttribute('href', '/wbs?status=done');
  await expect(kpi('진행 중 3건 — WBS에서 보기')).toHaveAttribute('href', '/wbs?status=active');
  await expect(kpi('선행 차단 4건 — WBS에서 보기')).toHaveAttribute('href', '/wbs?blocked=y');
  await expect(kpi('선행 차단 4건 — WBS에서 보기')).toHaveClass(/bad/);
  await kpi('완료 3건 — WBS에서 보기').click();
  await expect(page).toHaveURL('/wbs?status=done');
});

test('UAT-DASH-01 a: 6행동 패널 — 숫자·항목·이동 주소, 빈 패널은 발생 조건 안내', async ({ page }) => {
  await open(page);
  const panel = (name: string) => page.getByRole('region', { name, exact: true });
  await expect(panel('일정 지연')).toContainText('0');
  await expect(panel('일정 지연')).toContainText('지연 예상 Task가 없습니다.');
  await expect(panel('일정 지연')).toContainText('계획 완료일보다 늦어질 것으로 예상되거나 착수가 늦은 Task');
  await expect(panel('Completion Gate 미통과')).toContainText('Gate 대기 Task가 없습니다.');
  await expect(panel('Planning · 승인 대기').locator('.dp-n')).toHaveText('2');
  await expect(panel('Planning · 승인 대기').locator('.dp-n')).toHaveClass(/bad/);
  await expect(panel('Planning · 승인 대기').getByRole('link', { name: /Dependency 검증/ })).toHaveAttribute('href', '/change/CP-002');
  await expect(panel('Planning · 승인 대기').getByRole('link', { name: /Workflow Phase/ })).toHaveAttribute('href', '/planning?session=pln-001');
  await expect(panel('실행 진행 · 대기').locator('.dp-n')).not.toHaveClass(/bad/);
  await expect(panel('실행 진행 · 대기').getByRole('link', { name: /Drizzle Schema 설계/ })).toHaveAttribute('href', '/exec/TASK-0004?att=att-0004-2');
  await expect(panel('QA 실패 · 재작업').getByRole('link', { name: /WBS Tree UI/ })).toContainText('FAIL · 결함 2');
  await expect(panel('메시지 확인 필요').getByRole('link', { name: /MSG-003/ })).toContainText('전달 실패');
  await expect(panel('메시지 확인 필요').getByRole('link', { name: /MSG-002/ })).toHaveAttribute('href', '/wbs/TASK-0007?tab=msg');
});

test('UAT-DASH-01 a: 분포 막대를 누르면 WBS에 그 필터가 걸린다', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('link', { name: '테스트 0건 — WBS에서 보기' })).toHaveClass(/dim/);
  await page.getByRole('link', { name: '구현 6건 — WBS에서 보기' }).click();
  await expect(page).toHaveURL('/wbs?type=Implementation');
  await page.goBack();
  await page.getByRole('link', { name: 'DevOps 2건 — WBS에서 보기' }).click();
  await expect(page).toHaveURL('/wbs?domain=DevOps');
});

test('UAT-DASH-01 a·b: 등급별 시도·판정·FAIL·재작업률·상향·토큰', async ({ page }) => {
  await open(page, (d) => {
    d.dashboard.grades.push({ agent: 'Codex', modelId: 'gpt-5.5', effort: 'max', attempts: 2, judged: 0, fails: 0, reworkRatePct: null, escalations: 1, tokens: 90_000 } as never);
  });
  const table = page.getByRole('table', { name: '실행 등급별 결과' });
  await expect(table.getByRole('columnheader')).toHaveText(['Agent', '모델 · Effort', '시도', '판정', 'FAIL', '재작업률', '상향', '토큰']);
  const rows = table.getByRole('row');
  await expect(rows.nth(1).getByRole('cell')).toHaveText(['ClClaude', 'Opus 5.5 · 높음', '3', '1', '1', '100%', '0', '1050K']);
  await expect(rows.nth(1).getByText('100%')).toHaveClass(/sc-bad/);
  await expect(rows.nth(2).getByText('0%')).toHaveClass(/sc-ok/);
  await expect(rows.nth(3).getByRole('cell')).toHaveText(['CxCodex', 'gpt-5.5 · 최대', '2', '0', '0', '판정 전', '1', '90K']);
});

test('UAT-DASH-01 b: 경고는 GET /api/alerts에서 읽고, 정책 임계 알림은 해당 Task로 연결한다', async ({ page }) => {
  const { api } = await open(page, (d) => {
    d.alerts.unshift({ id: 'al0', key: 'rework-limit:t7', severity: 'warn', taskKey: 'TASK-0007', target: 'TASK-0007', text: '자동 재작업 한도를 넘었습니다.', at: kst('2026-11-05 19:30') });
  });
  expect(api.calls()).toContain('GET /api/alerts');
  const banner = page.getByRole('region', { name: '팀장 확인 필요' });
  await expect(banner.locator('.al-row')).toHaveCount(3);
  await expect(banner).toContainText('2026-11-05 19:30');
  await expect(banner.getByRole('link', { name: 'TASK-0007 실행 보기' })).toHaveAttribute('href', '/exec/TASK-0007');
  await expect(banner.getByRole('link', { name: '프로젝트 보기' })).toHaveAttribute('href', '/project');
  await expect(banner.getByRole('link', { name: '설계 보기' })).toHaveAttribute('href', '/design');
  // M3 통합: 서버 후속 3차 ackAlert로 알림마다 「확인」 버튼이 있다(원본 P L1865). 누르면 확인 처리하고 목록을 다시 읽는다.
  await expect(banner.getByRole('button', { name: /알림 확인$/ })).toHaveCount(3);
  api.on('POST /api/alerts/al0/ack', (route) => route.fulfill({ status: 204 }));
  await banner.getByRole('button', { name: '자동 재작업 한도를 넘었습니다. 알림 확인' }).click();
  await expect(page.getByText('알림을 확인 처리했습니다.')).toBeVisible();
  expect(api.requests('POST /api/alerts/al0/ack')[0]?.headers()['idempotency-key']).toBeTruthy();
});

test('UAT-DASH-01: 알림이 없으면 경고 막대가 없고, 알림 불러오기 실패는 다시 시도로 알린다', async ({ page }) => {
  const api = await fakeApi(page);
  const data = m307Data();
  installM307(api, data);
  let fail = true;
  api.on('GET /api/alerts', (route) => (fail ? json(route, 503, { error: { code: 'UNAVAILABLE', message: 'x', action: 'y', fix: 'z', errors: [], details: {}, requestId: 'r' } }) : json(route, 200, { items: [] })));
  await page.goto('/dashboard');
  await expect(page.getByText('알림을 불러오지 못했습니다.')).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByText('알림을 불러오지 못했습니다.')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '팀장 확인 필요' })).toHaveCount(0);
});

test('UAT-DASH-01: 최근 결과 8건 — 실행은 작업 실행, 검증은 검증 상세로', async ({ page }) => {
  await open(page);
  const recent = page.getByRole('region', { name: '최근 실행 · 검증 결과', exact: true });
  await expect(recent.locator('.dl-i')).toHaveCount(8);
  await expect(recent.locator('.dl-i').first()).toContainText('2026-11-03 19:58');
  await recent.getByRole('link', { name: /종료 코드 0/ }).click();
  await expect(page).toHaveURL('/verify?sel=v-0001-1');
  await expect(page.getByRole('region', { name: '검증 결과 V-0001-1 상세' })).toBeVisible();
});

test('UAT-PROJECT-11(대시보드): 진행률/완료율·기간 범위·최초/최신 기준을 구분해 보이고 각 화면으로 연결', async ({ page }) => {
  await open(page);
  await expect(page.getByText(/^일정 · 진행/)).toContainText('프로젝트 2026-10-27 시작 · 관측 가동률 · 동시 실행 한도 10 (상한 16, 하위 Agent 포함)');
  const card = (name: RegExp) => page.getByRole('link', { name });
  await expect(card(/^진행률 \(공수 가중\) 30%/)).toContainText('계획 54% 대비 -24%p');
  await expect(card(/^완료율 25%/)).toContainText('Task 3/12 · 공수 기준 13% (5.5h/42h)');
  await expect(card(/^예상 완료일 \(기준 v1\) 11-06/)).toContainText('범위 11-06 ~ 11-10 · 기준 11-06 이내 · 목표 12-18까지 여유 42일');
  await expect(card(/^Agent 작업량/)).toContainText('최초 기준 v1 11-06');
  await expect(card(/^진행률/)).toHaveAttribute('href', '/wbs?view=gantt');
  await expect(card(/^Agent 작업량/)).toHaveAttribute('href', '/settings');
  await expect(page.getByText('기준 2026-11-05 20:00')).toBeVisible();
});

test('UAT-EMPTY-04(대시보드): 최근 결과·등급 시도·패널이 비면 각 영역에 발생 조건 안내', async ({ page }) => {
  await open(page, (d) => {
    d.dashboard.recent = [];
    d.dashboard.grades = [];
    d.dashboard.schedule = null;
    d.dashboard.panels = { late: [], approvals: [], executions: [], rework: [], gate: [], messages: [] };
    d.alerts = [];
  });
  await expect(page.getByText('아직 실행 · 검증 결과가 없습니다. Runner가 Task를 실행하면 여기에 최근 결과가 표시됩니다.')).toBeVisible();
  await expect(page.getByText(/^등급이 기록된 실행 시도가 없습니다\./)).toBeVisible();
  await expect(page.getByText(/^아직 일정이 계산되지 않았습니다\./)).toBeVisible();
  for (const t of ['승인 대기 항목이 없습니다.', '실행 중이거나 대기 중인 Task가 없습니다.', 'QA 실패 Task가 없습니다.', '확인할 메시지가 없습니다.']) {
    await expect(page.getByText(t)).toBeVisible();
  }
});

test('UAT-STATE-01: 첫 응답이 늦으면 대시보드 배치 skeleton 뒤 실제 내용으로 바뀐다', async ({ page }) => {
  const api = await fakeApi(page);
  const data = m307Data();
  installM307(api, data);
  const slow = hold((route) => json(route, 200, data.dashboard));
  api.on('GET /api/dashboard', slow.handler);
  await page.goto('/dashboard');
  const sk = page.getByRole('status', { name: '대시보드 불러오는 중' });
  await expect(sk).toBeVisible();
  slow.release();
  await expect(page.getByRole('heading', { level: 1, name: '대시보드' })).toBeVisible();
  await expect(sk).toHaveCount(0);
});

test('UAT-STATE-01: 0.2초 안에 오는 응답은 skeleton을 보이지 않는다', async ({ page }) => {
  const api = await fakeApi(page);
  installM307(api, m307Data());
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('.skp')) (window as unknown as { sawSkeleton: boolean }).sawSkeleton = true;
    }).observe(document, { subtree: true, childList: true });
  });
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1, name: '대시보드' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { sawSkeleton?: boolean }).sawSkeleton ?? false)).toBe(false);
});

test('D-28 대시보드: 1280·1920 페이지 가로 스크롤 없음, 1280 미만은 표 상자만 가로 스크롤', async ({ page }) => {
  await open(page);
  const pageOverflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  for (const width of [1920, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await pageOverflow()).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1024, height: 800 });
  expect(await pageOverflow()).toBeLessThanOrEqual(0);
  const box = page.getByRole('region', { name: '최근 실행 · 검증 결과 목록' });
  await expect(box).toBeVisible();
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await pageOverflow()).toBeLessThanOrEqual(0);
  expect(await box.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test('리뷰 2: 대시보드 본문 조회가 실패해도 받은 경고는 보이고, 본문은 다시 시도할 수 있다', async ({ page }) => {
  const api = await fakeApi(page);
  const data = m307Data();
  installM307(api, data);
  let fail = true;
  api.on('GET /api/dashboard', (route) => (fail
    ? json(route, 404, { error: { code: 'NOT_FOUND', message: '요청한 자원을 찾을 수 없습니다.', action: 'x', fix: 'y', errors: [], details: {}, requestId: 'r' } })
    : json(route, 200, data.dashboard)));
  await page.goto('/dashboard');
  await expect(page.getByRole('region', { name: '대시보드 화면을 불러오지 못했습니다' })).toBeVisible();
  const banner = page.getByRole('region', { name: '팀장 확인 필요' });
  await expect(banner.locator('.al-row')).toHaveCount(2);
  await expect(banner.getByRole('link', { name: '프로젝트 보기' })).toHaveAttribute('href', '/project');
  fail = false;
  await page.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByRole('link', { name: '전체 Task 12건 — WBS에서 보기' })).toBeVisible();
  await expect(banner.locator('.al-row')).toHaveCount(2);
});
