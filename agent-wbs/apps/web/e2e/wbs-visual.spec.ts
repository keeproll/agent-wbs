/**
 * WBS 화면을 원본 스크린샷과 나란히 비교한다(M3-02 시각 비교).
 * 조건: 원본과 같은 viewport(1920×1080·1280×800), 기기 배율 1, ko-KR, Asia/Seoul, 시계 2026-11-05 20:00 KST, 애니메이션 끔, 마우스는 구석.
 * 자료: e2e/support/wbs-fixture.ts(원본 기본 Mock 12건과 같은 구성).
 * 결과: 기본은 실행마다 새 임시 폴더(support/visual.ts visualOut), 보관하려면 AWBS_VISUAL_OUT_M302=~/.orca/bots/agentwbs/archive/2026-11-26/M3-02/visual/ 로 명시 에 [원본 | 구현 | 차이] PNG와 summary.md.
 * 차이 기준·예외는 src/features/wbs/README.md 「시각 비교」에 적었다.
 */
import { expect, test, type Page } from '@playwright/test';
import { compareRegion, hasBaseline, writeSummary, type Box, type VisualResult, visualOut } from './support/visual.ts';
import { wbsApi } from './support/wbs-api.ts';

const OUT = visualOut('AWBS_VISUAL_OUT_M302', 'M3-02-visual');
test.skip(!hasBaseline(), '원본 스크린샷 폴더가 없다(~/.cache/agent-wbs-baseline).');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const results: VisualResult[] = [];
const NOTE: Record<string, string> = {};

async function prepare(page: Page) {
  await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
  return wbsApi(page);
}
async function shot(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1910, 1075);
  return page.screenshot({ animations: 'disabled', caret: 'hide' });
}
function record(name: string, limit: number | null, note: string, base: string, box: Box, png: Buffer, actualBox: Box = box) {
  const r = compareRegion(name, base, box, png, actualBox, OUT);
  results.push(r);
  NOTE[name] = note;
  NOTE[`${name}:limit`] = limit === null ? '기록만' : `≤ ${(limit * 100).toFixed(1)}%`;
  if (limit !== null) expect(r.ratio, `${name} 차이 ${(r.ratio * 100).toFixed(2)}%`).toBeLessThanOrEqual(limit);
}

/** 1920 화면의 영역(원본 UI-03.png 좌표) */
const PAGE_HEAD: Box = { x: 181, y: 65, width: 1739, height: 105 };
const TOOLBAR: Box = { x: 204, y: 174, width: 1692, height: 138 };
const TABLE_HEAD_AND_GROUPS: Box = { x: 204, y: 312, width: 1692, height: 148 };
const TABLE: Box = { x: 204, y: 312, width: 1692, height: 750 };
const MAIN: Box = { x: 181, y: 65, width: 1739, height: 1015 };

test('UI-03 표(1920): 제목·도구 막대·머리 행·그룹 행·Task 행', async ({ page }) => {
  await prepare(page);
  await page.goto('/wbs');
  await expect(page.locator('.resbar')).toHaveText('전체 12건');
  const png = await shot(page);
  const base = 'desktop-clock20261105/UI-03.png';
  record('UI-03-head', 0.02, '같아야 함(제목·Task 수·일정 요약·Task 생성 버튼)', base, PAGE_HEAD, png);
  record('UI-03-toolbar', 0.02, '같아야 함(검색·필터 8·초기화·보기·정렬·펼치기/접기·컬럼·결과 수)', base, TOOLBAR, png);
  record('UI-03-thead-groups', 0.02, '같아야 함(머리 행·Phase 1·WP 1.1 집계 막대·완료 예상)', base, TABLE_HEAD_AND_GROUPS, png);
  record('UI-03-table', null, '배치·색은 같고 글자 일부가 다름: 예상 실행의 토큰 수(· 180K) 없음(계약에 토큰 추정 없음), 「충족 1 건」→「충족 1건」(원본 바인딩 공백), 시험 자료의 진행률(Phase 2) 차이', base, TABLE, png);
  record('UI-03-main', null, '화면 본문 전체(참고)', base, MAIN, png);
});

test('UI-03C Gantt(1920)', async ({ page }) => {
  await prepare(page);
  await page.goto('/wbs');
  await page.getByRole('button', { name: '일정 (Gantt)' }).click();
  await expect(page.getByRole('table', { name: 'WBS 일정 (Gantt)' })).toBeVisible();
  const png = await shot(page);
  const base = 'desktop-clock20261105/UI-03C.png';
  record('UI-03C-gantt-head', 0.03, '같아야 함(날짜 눈금·작업 불가일 빗금·목표일 선 위치)', base, { x: 204, y: 340, width: 1692, height: 34 }, png);
  record('UI-03C-gantt', null, '막대 위치는 같은 일정 자료라 거의 같고, 시험 자료의 진행률(Phase 2·2.2) 글자만 다름', base, { x: 204, y: 312, width: 1692, height: 730 }, png);
  record('UI-03C-legend', 0.02, '같아야 함(범례)', base, { x: 204, y: 1042, width: 1692, height: 30 }, png);
});

test('UI-03D 레일 + 상세 머리(1920)', async ({ page }) => {
  await prepare(page);
  await page.goto('/wbs');
  await page.getByRole('table', { name: 'WBS Task 목록' }).getByRole('button', { name: 'Drizzle Schema 설계' }).click();
  await expect(page.getByRole('region', { name: 'Task 상세' }).getByRole('heading', { level: 2 })).toHaveText('Drizzle Schema 설계');
  const png = await shot(page);
  const base = 'desktop-clock20261105/UI-03-01.png';
  record('UI-03D-rail', 0.03, '같아야 함(260px 레일: 펼치기·검색·WP 구분선·상태·선택 강조)', base, { x: 204, y: 174, width: 260, height: 890 }, png);
  record('UI-03D-detail-top', 0.03, '같아야 함(WBS 번호·ID·상위 WP·위치 4/12·이전·다음·제목)', base, { x: 481, y: 174, width: 1415, height: 80 }, png);
  record('UI-03E-summary', null, '요약 10칸 배치는 같고, 체크리스트 「필수 1건 남음」·Gate 「미통과 2/5 ▾」 펼침 버튼·선행 「모두 충족 (2건)」 문구는 상세 데이터가 필요해 M3-03에서 맞춘다', base, { x: 500, y: 262, width: 1376, height: 122 }, png);
});

test('MOD-06A Task 생성 Wizard 1단계(1920)', async ({ page }) => {
  await prepare(page);
  await page.goto('/wbs');
  await page.locator('.page-h').getByRole('button', { name: 'Task 생성' }).click();
  const dialog = page.getByRole('dialog', { name: 'Task 생성' });
  await expect(dialog).toBeVisible();
  // 원본 캡처와 같은 기본 Work Package(2.1 Task API)로 맞춘다(원본은 WP-03 고정, 제품은 실제 목록의 첫 WP).
  await dialog.getByLabel('상위 Work Package').selectOption({ label: '2.1 Task API' });
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  const box = await dialog.boundingBox();
  const png = await shot(page);
  if (!box) throw new Error('Wizard 없음');
  expect(Math.round(box.width)).toBe(1080);
  record('MOD-06A-wizard', 0.03, '같아야 함(단계 표시·필수/선택 표시·선택 버튼 격자·도움말·버튼). 원본 desktop/MOD-06A.png', 'desktop/MOD-06A.png',
    { x: 420, y: 129, width: 1080, height: 822 }, png, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) });
});

test('UI-03 표(1280×800)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await prepare(page);
  await page.goto('/wbs');
  await expect(page.locator('.resbar')).toHaveText('전체 12건');
  const png = await shot(page);
  const base = 'w1280/UI-03.png';
  record('UI-03-1280-head', null, '배치 같음. 원본 w1280 캡처는 시계가 달라(11-26) 일정 날짜 글자가 다름', base, { x: 181, y: 65, width: 1099, height: 105 }, png);
  record('UI-03-1280-toolbar', 0.03, '같아야 함(1280에서 필터가 두 줄로 접힘)', base, { x: 204, y: 174, width: 1052, height: 138 }, png);
  record('UI-03-1280-table', null, '열 폭·줄바꿈 같음(가로 스크롤 없음). 일정 날짜·토큰 글자 차이', base, { x: 204, y: 312, width: 1052, height: 470 }, png);
});

test.afterAll(() => { writeSummary(results, NOTE, OUT); });
