/**
 * M3 통합 — 화면 사이 이동(원본 inventory 「정상 메뉴 이동의 연결」)과 알림 링크 주소.
 *
 * 왜 따로 시험하나: 각 화면 시험은 자기 화면만 본다. 보내는 화면이 만든 주소를 받는 화면이 제대로 읽는지는 합쳐 봐야 안다.
 * 주소는 모두 공통 주소 표(src/shared/links.ts)에서 만든다. 받는 규칙은 src/app/router.tsx.
 *
 * 가짜 API는 각 화면 시험의 자료를 그대로 쓴다(support/*). 두 화면의 자료가 같은 요청을 쓰면 뒤에 붙인 쪽이 이긴다.
 */
import { expect, test, type Page } from '@playwright/test';
import { execApi } from './support/exec-fixtures.ts';
import { fakeApi, json } from './support/fake-api.ts';
import { alerts, dashboard, installM307, m307Data } from './support/m307-data.ts';
import { planningServer } from './support/planning-data.ts';
import { mountTasks } from './support/task-api.ts';
import { wbsApi } from './support/wbs-api.ts';
import { MENU, type MenuKey } from '../src/shared/layout/menu.ts';
import { GITHUB_OK } from './support/project-fixtures.ts';
import { settingsApi } from './support/settings-fixtures.ts';

/** 페이지 전체에 가로 스크롤이 없는가(D-28) */
const pageScrollsX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test.describe('대시보드 →', () => {
  test('WBS 필터: 「완료」·「선행 차단」 KPI 주소의 필터가 WBS 표에 그대로 적용된다', async ({ page }) => {
    const api = await wbsApi(page);
    api.on('GET /api/dashboard', (route) => json(route, 200, dashboard()));
    api.on('GET /api/alerts', (route) => json(route, 200, { items: alerts() }));
    await page.goto('/dashboard');
    await page.getByRole('link', { name: /^완료 \d+건 — WBS에서 보기$/ }).click();
    await expect(page).toHaveURL('/wbs?status=done');
    await expect(page.getByRole('heading', { level: 1, name: 'WBS' })).toBeVisible();
    await expect(page.locator('.resbar')).toContainText('필터 결과');
    const done = api.list.tasks.filter((t) => t.lifecycleStatus === 'done' && !t.deletedAt).length;
    await expect(page.locator('.resbar')).toContainText(`필터 결과 ${String(done)}건`);

    await page.goto('/dashboard');
    await page.getByRole('link', { name: /^선행 차단 \d+건 — WBS에서 보기$/ }).click();
    await expect(page).toHaveURL('/wbs?blocked=y');
    const blocked = api.list.tasks.filter((t) => t.blocked && !t.deletedAt).length;
    await expect(page.locator('.resbar')).toContainText(`필터 결과 ${String(blocked)}건`);
  });

  test('일정 카드의 Gantt 주소(view=gantt)는 WBS를 Gantt 보기로 연다', async ({ page }) => {
    const api = await wbsApi(page);
    api.on('GET /api/dashboard', (route) => json(route, 200, dashboard()));
    api.on('GET /api/alerts', (route) => json(route, 200, { items: [] }));
    await page.goto('/wbs?view=gantt');
    await expect(page.getByRole('heading', { level: 1, name: 'WBS' })).toBeVisible();
    await expect(page.locator('.gantt, [class*="gantt"]').first()).toBeVisible();
  });

  test('작업 실행: 「팀장 확인 필요」 알림 링크는 /exec/:taskKey로 그 Task를 연다', async ({ page }) => {
    const api = await execApi(page);
    api.on('GET /api/dashboard', (route) => json(route, 200, dashboard()));
    // 정책 임계 알림(재작업 한도)은 그 Task와 연결된다(UAT-DASH-01 b와 같은 알림).
    const rework = { id: 'al0', key: 'rework-limit:t7', severity: 'warn', taskKey: 'TASK-0007', target: 'TASK-0007', text: '자동 재작업 한도를 넘었습니다.', at: '2026-11-05T10:30:00.000Z' };
    api.on('GET /api/alerts', (route) => json(route, 200, { items: [rework, ...alerts()] }));
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'TASK-0007 실행 보기' }).click();
    await expect(page).toHaveURL('/exec/TASK-0007');
    const rail = page.getByRole('complementary', { name: 'Task 및 실행 목록' });
    await expect(rail.locator('[aria-current="true"]').first()).toContainText('TASK-0007');
  });
});

test.describe('작업 실행 주소', () => {
  test('?att=는 시도 키와 시도 id를 모두 받는다(대시보드·검증은 id로 링크한다)', async ({ page }) => {
    await execApi(page);
    const missing = page.getByText(/시도를 찾을 수 없습니다/);
    await page.goto('/exec/TASK-0007?att=att-ATT-0007-1');
    await expect(page.getByRole('heading', { level: 1, name: '작업 실행' })).toBeVisible();
    await expect(page.getByText('ATT-0007-1').first()).toBeVisible();
    await expect(missing).toHaveCount(0);
    await page.goto('/exec/TASK-0007?att=ATT-0007-1');
    await expect(page.getByText('ATT-0007-1').first()).toBeVisible();
    await expect(missing).toHaveCount(0);
    // 없는 시도는 고르지 않고 알린다(M3-06 규칙 그대로)
    await page.goto('/exec/TASK-0007?att=ATT-9999');
    await expect(missing).toBeVisible();
  });
});

test.describe('WBS·Task 상세 →', () => {
  test('레일 + 상세: 레일에서 다른 Task로 옮겨도 탭(?tab=)이 유지된다', async ({ page }) => {
    const api = await fakeApi(page);
    mountTasks(api);
    await page.goto('/wbs/TASK-0007?tab=deps');
    const detail = page.getByRole('region', { name: 'Task 상세' });
    await expect(detail.getByRole('tab', { name: /^의존성/ })).toHaveAttribute('aria-selected', 'true');
    // 레일에서 다른 Task를 골라도 의존성 탭 그대로
    await page.getByRole('complementary', { name: 'Task 목록' }).getByRole('button', { name: /TASK-0006/ }).click();
    await expect(page).toHaveURL('/wbs/TASK-0006?tab=deps');
    await expect(detail.getByRole('tab', { name: /^의존성/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('실행 탭의 「작업 실행 화면에서 진행」은 /exec/:taskKey로 간다', async ({ page }) => {
    const api = await fakeApi(page);
    mountTasks(api);
    await page.goto('/wbs/TASK-0007?tab=exec');
    await expect(page.getByRole('link', { name: '작업 실행 화면에서 진행' })).toHaveAttribute('href', '/exec/TASK-0007');
  });
});

test.describe('Planning ↔ 변경 제안', () => {
  test('변경 제안의 「출처: Planning」은 /planning?session=으로 그 세션을 연다', async ({ page }) => {
    const api = await fakeApi(page);
    planningServer(api);
    await page.goto('/change/CP-001'); // 출처가 Planning 세션인 CP(planning-data.ts)
    const source = page.getByRole('link', { name: /출처: Planning/ });
    await expect(source).toHaveAttribute('href', /^\/planning\?session=/);
    await source.click();
    await expect(page).toHaveURL(/\/planning\?session=/);
    await expect(page.getByRole('heading', { level: 1, name: 'Planning' })).toBeVisible();
  });
});

test.describe('검증·이력 →', () => {
  test('Gate 표의 Task 링크는 Task 상세 체크리스트 탭, 이력의 Task 링크는 이력 탭 주소다', async ({ page }) => {
    const api = await fakeApi(page);
    installM307(api, m307Data());
    await page.goto('/verify?tab=gate&gate=all');
    const link = page.getByRole('link', { name: 'TASK-0007' }).first();
    await expect(link).toHaveAttribute('href', '/wbs/TASK-0007?tab=checklist');
    await page.goto('/history');
    await expect(page.getByRole('link', { name: 'TASK-0007' }).first()).toHaveAttribute('href', '/wbs/TASK-0007?tab=hist');
  });
});

test.describe('390px 알림 링크 상세 열람(D-28)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('/wbs/:taskKey — Task 상세 제목·요약을 읽을 수 있고 페이지 가로 스크롤이 없다', async ({ page }) => {
    const api = await fakeApi(page);
    mountTasks(api);
    await page.goto('/wbs/TASK-0007');
    const detail = page.getByRole('region', { name: 'Task 상세' });
    await expect(detail.getByRole('heading', { level: 2 })).toBeVisible();
    await expect(detail.locator('.summary')).toBeVisible();
    expect(await pageScrollsX(page)).toBe(false);
  });

  test('/change/:cpRef — 변경 제안 상세를 읽을 수 있고 페이지 가로 스크롤이 없다', async ({ page }) => {
    const api = await fakeApi(page);
    planningServer(api);
    await page.goto('/change/CP-002');
    await expect(page.locator('.cp-detail').getByRole('heading', { level: 2 })).toBeVisible();
    expect(await pageScrollsX(page)).toBe(false);
  });

  test('/exec/:taskKey — 그 Task의 실행 화면을 읽을 수 있고 페이지 가로 스크롤이 없다', async ({ page }) => {
    await execApi(page);
    await page.goto('/exec/TASK-0007');
    await expect(page.getByRole('heading', { level: 1, name: '작업 실행' })).toBeVisible();
    await expect(page.getByText('TASK-0007').first()).toBeVisible();
    expect(await pageScrollsX(page)).toBe(false);
  });
});

/**
 * 메뉴마다 그 화면 시험의 가짜 자료를 붙인다(여러 화면 자료를 섞으면 계약 모양이 어긋난다).
 * 화면 안의 자세한 폭 시험(표 컨테이너 가로 스크롤 등)은 각 화면의 *-responsive 시험에 있다. 여기서는 주소 ↔ 메뉴 ↔ 폭을 한 번에 본다.
 */
const SETUP: Record<MenuKey, (page: Page) => Promise<unknown>> = {
  dashboard: async (page) => { installM307(await fakeApi(page), m307Data()); },
  project: async (page) => {
    const api = await fakeApi(page);
    api.on('GET /api/settings/github', (route) => json(route, 200, GITHUB_OK));
    api.on('GET /api/system/resets', (route) => json(route, 200, { items: [] }));
    api.on('GET /api/alerts', (route) => json(route, 200, { items: [] }));
  },
  wbs: (page) => wbsApi(page),
  design: (page) => fakeApi(page),
  planning: async (page) => { planningServer(await fakeApi(page)); },
  exec: (page) => execApi(page),
  verify: async (page) => { installM307(await fakeApi(page), m307Data()); },
  ci: (page) => fakeApi(page),
  change: async (page) => { planningServer(await fakeApi(page)); },
  history: async (page) => { installM307(await fakeApi(page), m307Data()); },
  report: (page) => fakeApi(page),
  settings: async (page) => { settingsApi(await fakeApi(page)); },
};

test.describe('메뉴 12개 주소(D-28 폭)', () => {
  for (const width of [1280, 1920]) {
    for (const item of MENU) {
      test(`${String(width)}px /${item.key}: 메뉴가 열리고 강조되며 페이지 가로 스크롤이 없다`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await SETUP[item.key](page);
        await page.goto(`/${item.key}`);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        // 메뉴 강조가 그 메뉴로 옮겨졌다(주소 ↔ 메뉴 일치)
        await expect(page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: item.label, exact: true })).toHaveAttribute('aria-current', 'page');
        expect(await pageScrollsX(page)).toBe(false);
      });
    }
  }
});
