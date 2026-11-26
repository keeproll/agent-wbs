/**
 * 원본 스크린샷과 나란히 비교(M3-01 시각 비교). 결과 이미지·요약: ~/.orca/bots/agentwbs/archive/2026-11-26/M3-01/visual/
 * 조건: 원본과 같은 viewport(1920×1080·1280×800), ko-KR, Asia/Seoul, 시계 2026-11-05 20:00 KST(원본 주시각 자료).
 * 차이 기준과 예외는 apps/web/README.md 「시각 비교」에 적었다.
 */
import { expect, test, type Page } from '@playwright/test';
import { ACTIVE_PROJECT, errorBody, fakeApi, hold, json } from './support/fake-api.ts';
import { installM307, m307Data } from './support/m307-data.ts';
import { compareRegion, hasBaseline, writeSummary, type Box, type VisualResult } from './support/visual.ts';

test.skip(!hasBaseline(), '원본 스크린샷 폴더가 없다(~/.cache/agent-wbs-baseline).');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const results: VisualResult[] = [];
/** 영역별 허용 차이 비율. 넘으면 실패. 글자가 다른 영역은 기록만 한다(null). */
const LIMIT: Record<string, number | null> = {};
const NOTE: Record<string, string> = {};

async function prepare(page: Page) {
  await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
  const api = await fakeApi(page);
  // 대시보드는 M3-07에서 구현됐다. 앱 틀 비교에 쓰는 대시보드 본문 데이터(원본 Mock과 같은 값)를 붙인다.
  installM307(api, m307Data());
  return api;
}
async function shot(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1900, 1070);
  return page.screenshot({ animations: 'disabled', caret: 'hide' });
}
function record(name: string, limit: number | null, note: string, r: VisualResult) {
  results.push(r);
  LIMIT[name] = limit;
  NOTE[name] = note;
  NOTE[`${name}:limit`] = limit === null ? '기록만' : `≤ ${(limit * 100).toFixed(1)}%`;
  if (limit !== null) expect(r.ratio, `${name} 차이 ${(r.ratio * 100).toFixed(2)}%`).toBeLessThanOrEqual(limit);
}

const NAV: Box = { x: 0, y: 64, width: 180, height: 1016 };
const HEADER_LEFT: Box = { x: 0, y: 0, width: 520, height: 64 };
const MAIN: Box = { x: 181, y: 65, width: 1739, height: 1015 };

test('UI-00 앱 틀: 왼쪽 메뉴·헤더 왼쪽(1920)', async ({ page }) => {
  await prepare(page);
  await page.goto('/dashboard');
  await expect(page.getByText('다음 행동을 결정하는 데 필요한 항목만 표시합니다', { exact: false })).toBeVisible();
  const png = await shot(page);
  record('UI-00-nav-1920', 0.01, '같아야 함(메뉴 12개·선택 강조·빈 단계 칸)', compareRegion('UI-00-nav-1920', 'desktop-clock20261105/SYS-01-error.png', NAV, png, NAV));
  record('UI-00-header-left-1920', 0.01, '같아야 함(햄버거·로고·프로젝트명)', compareRegion('UI-00-header-left-1920', 'desktop-clock20261105/SYS-01-error.png', HEADER_LEFT, png, HEADER_LEFT));
  record('UI-00-header-right-1920', null, '제품 결정: Prototype·Mock 표시와 MOCK 칩 없음, 로그아웃 버튼 추가',
    compareRegion('UI-00-header-right-1920', 'desktop-clock20261105/SYS-01-error.png', { x: 1400, y: 0, width: 520, height: 64 }, png, { x: 1400, y: 0, width: 520, height: 64 }));
});

test('UI-00 메뉴 접힘 56px', async ({ page }) => {
  await prepare(page);
  await page.goto('/wbs');
  await page.getByRole('button', { name: '메뉴 접기/펼치기' }).click();
  // 왼쪽 메뉴(56px)만 비교한다. 본문은 WBS 화면(M3-02)이 그리므로 제목이 보일 때까지만 기다린다.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const png = await shot(page);
  const box = { x: 0, y: 64, width: 56, height: 1016 };
  record('UI-00-nav-collapsed', 0.01, '같아야 함', compareRegion('UI-00-nav-collapsed', 'desktop/UI-00-collapsed.png', box, png, box));
});

test('UI-00 1280×800 앱 틀', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await prepare(page);
  await page.goto('/dashboard');
  await expect(page.getByText('다음 행동을 결정하는 데 필요한 항목만 표시합니다', { exact: false })).toBeVisible();
  const png = await shot(page);
  const nav = { x: 0, y: 64, width: 180, height: 736 };
  record('UI-00-nav-1280', 0.01, '같아야 함', compareRegion('UI-00-nav-1280', 'w1280/UI-01.png', nav, png, nav));
  record('UI-00-header-left-1280', 0.01, '같아야 함', compareRegion('UI-00-header-left-1280', 'w1280/UI-01.png', HEADER_LEFT, png, HEADER_LEFT));
});

test('SYS-01 대시보드 skeleton', async ({ page }) => {
  const api = await prepare(page);
  api.on('GET /api/project', hold((route) => json(route, 200, ACTIVE_PROJECT)).handler);
  await page.goto('/dashboard');
  await expect(page.getByRole('status', { name: '대시보드 불러오는 중' })).toBeVisible();
  const png = await shot(page);
  record('SYS-01-loading', 0.02, '같은 SKELETON 배치·색. 원본은 shimmer 애니메이션 중간 프레임이라 회색 농도가 조금 다를 수 있음',
    compareRegion('SYS-01-loading', 'desktop-clock20261105/SYS-01-loading.png', MAIN, png, MAIN));
});

test('SYS-01 불러오기 실패 카드', async ({ page }) => {
  const api = await prepare(page);
  api.on('GET /api/project', (route) => json(route, 503, errorBody('UNAVAILABLE', { message: 'x', fix: 'y' })));
  await page.goto('/dashboard');
  await expect(page.getByRole('region', { name: '대시보드 화면을 불러오지 못했습니다' })).toBeVisible();
  const png = await shot(page);
  record('SYS-01-error', null, '문구 차이: 「503 SERVICE_UNAVAILABLE · 10초 초과」→ 계약 코드 「503 UNAVAILABLE」, 마지막 시각 표시. 카드 위치·크기·버튼은 같아야 함',
    compareRegion('SYS-01-error', 'desktop-clock20261105/SYS-01-error.png', { x: 181, y: 65, width: 800, height: 300 }, png, { x: 181, y: 65, width: 800, height: 300 }));
});

async function openEditorWithError(page: Page, status: number, body: unknown) {
  const api = await prepare(page);
  api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, { taskKey: 'TASK-0001', title: 'Drizzle Schema 설계', updatedAt: '2026-11-05T10:00:00Z' }));
  api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, status, body));
  await page.goto('/_states');
  await page.getByRole('button', { name: '편집' }).click();
  await page.getByLabel('제목').fill('변경 사항');
  await page.getByRole('button', { name: '저장', exact: true }).click();
}

test('SYS-02 저장 오류 막대', async ({ page }) => {
  await openEditorWithError(page, 500, errorBody('INTERNAL', { message: '서버에서 요청을 처리하지 못했습니다.', fix: '잠시 후 다시 시도하세요. 계속 실패하면 서버 로그를 확인해야 합니다.' }));
  const bar = page.getByRole('alert');
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  const png = await shot(page);
  if (!box) throw new Error('오류 막대 없음');
  record('SYS-02-errbar', null, '모양(테두리·왼쪽 4px 빨강·아이콘·버튼 위치)은 같고 문구가 다름: 코드 「500 INTERNAL_ERROR」→「500 INTERNAL」, 대상 문구',
    compareRegion('SYS-02-errbar', 'desktop/SYS-02.png', { x: 204, y: 76, width: 1692, height: 89 }, png, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }));
});

test('MOD-01 충돌 창', async ({ page }) => {
  await openEditorWithError(page, 409, errorBody('VERSION_CONFLICT', { details: { changes: [{ at: '2026-11-03T10:58:00Z', actor: 'Runner', field: 'status', before: 'running', after: 'paused' }] } }));
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  const box = await dialog.boundingBox();
  const png = await shot(page);
  if (!box) throw new Error('충돌 창 없음');
  record('MOD-01-modal', null, '폭 620px·제목·버튼 2개 배치는 같고, 먼저 저장된 변경이 서버 목록(MM-20)이라 본문 문구·높이가 다름',
    compareRegion('MOD-01-modal', 'desktop/MOD-01.png', { x: 650, y: 377, width: 620, height: 326 }, png, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }));
  expect(Math.round(box.width)).toBe(620);
});

test('MOD-08 공용 확인창', async ({ page }) => {
  await prepare(page);
  await page.goto('/_states');
  await page.getByRole('button', { name: '확인창 열기' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Task 생성 취소' });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  const box = await dialog.boundingBox();
  const png = await shot(page);
  if (!box) throw new Error('확인창 없음');
  record('MOD-08-confirm', 0.02, '같은 문구로 열어 같아야 함(배경 overlay 아래 화면만 다름 — 창 안만 비교)',
    compareRegion('MOD-08-confirm', 'desktop/MOD-08.png', { x: 720, y: 449, width: 480, height: 183 }, png, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }));
  expect(Math.round(box.width)).toBe(480);
});

test('SYS-03 안내(toast)', async ({ page }) => {
  await openEditorWithError(page, 200, { task: { taskKey: 'TASK-0001', title: 'x', updatedAt: '2026-11-05T11:00:00Z' }, changes: [] });
  const notice = page.locator('.notice');
  await expect(notice).toBeVisible();
  const box = await notice.boundingBox();
  const png = await shot(page);
  if (!box) throw new Error('안내 없음');
  record('SYS-03-notice', null, '위치(오른쪽·아래 24px)·색·반경 같음, 문구 길이가 달라 폭이 다름',
    compareRegion('SYS-03-notice', 'desktop/SYS-03.png', { x: 1436, y: 999, width: 460, height: 57 }, png, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }));
  expect(Math.round(1920 - box.x - box.width)).toBe(24);
  expect(Math.round(1080 - box.y - box.height)).toBe(24);
});

test.afterAll(() => { writeSummary(results, NOTE); });
