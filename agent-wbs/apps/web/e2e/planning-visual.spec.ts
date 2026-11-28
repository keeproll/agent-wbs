/**
 * M3-05 시각 비교 — 원본 스크린샷(desktop-clock20261105/UI-05·UI-05-02·UI-09, desktop/MOD-07)과 같은 조건으로 찍어 같은 영역을 비교한다.
 * 조건·차이 계산은 M3-01과 같다(apps/web/README.md §5): 1920×1080, 배율 1, ko-KR, Asia/Seoul, 시계 2026-11-05 20:00 KST, 애니메이션 끔.
 * 결과: 기본은 실행마다 새 임시 폴더(support/visual.ts visualOut), 보관하려면 AWBS_VISUAL_OUT_M305=~/.orca/bots/agentwbs/archive/2026-11-26/M3-05/visual/ 로 명시 (영역별 [원본 | 구현 | 차이] PNG와 summary.md)
 * 기준과 예외는 features/planning/README.md 「시각 비교」에 적었다.
 */
import { expect, test, type Page } from '@playwright/test';
import { fakeApi } from './support/fake-api.ts';
import { CP1, CP2, PLANNING0, PLANNING1, planningServer, RP1 } from './support/planning-data.ts';
import { compareRegion, hasBaseline, writeSummary, type Box, type VisualResult, visualOut } from './support/visual.ts';

const OUT = visualOut('AWBS_VISUAL_OUT_M305', 'M3-05-visual');

test.skip(!hasBaseline(), '원본 스크린샷 폴더가 없다(~/.cache/agent-wbs-baseline).');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const results: VisualResult[] = [];
const NOTE: Record<string, string> = {};

async function prepare(page: Page) {
  await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
  const api = await fakeApi(page);
  planningServer(api, { proposals: [CP2, CP1], plannings: [PLANNING1, PLANNING0], replans: [RP1] });
  return api;
}
async function shot(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1900, 1070);
  return page.screenshot({ animations: 'disabled', caret: 'hide' });
}
function record(name: string, limit: number | null, note: string, base: string, box: Box, png: Buffer, actualBox: Box = box) {
  const r = compareRegion(name, base, box, png, actualBox, OUT);
  results.push(r);
  NOTE[name] = note;
  NOTE[`${name}:limit`] = limit === null ? '기록만' : `≤ ${(limit * 100).toFixed(1)}%`;
  if (limit !== null) expect(r.ratio, `${name} 차이 ${(r.ratio * 100).toFixed(2)}%`).toBeLessThanOrEqual(limit);
}

const PAGE_HEAD: Box = { x: 181, y: 65, width: 1739, height: 86 };

test('UI-09 변경 제안(CP-002 승인 대기)', async ({ page }) => {
  await prepare(page);
  await page.goto('/change/CP-002');
  await expect(page.getByRole('region', { name: '영향 분석' }).locator('.gtr')).toHaveCount(2);
  const png = await shot(page);
  record('UI-09-page-head', 0.02, '같아야 함(제목·설명·새 변경 제안 버튼)', 'desktop-clock20261105/UI-09.png', PAGE_HEAD, png);
  record('UI-09-list', null, '목록 모양은 같음. 출처는 원본처럼 「Planning PLN-000」(M3 통합: 서버 표시 키 planningKey). 남은 차이는 기록만', 'desktop-clock20261105/UI-09.png', { x: 204, y: 153, width: 260, height: 195 }, png);
  record('UI-09-detail-top', null, '제목·배너·사유·Diff 위치 같음. 차이: 「작성 팀장」 줄은 같고, Diff 마지막 빈 열(제외 버튼 자리) 폭 동일, 승인 이력은 서버 이벤트 「제출」', 'desktop-clock20261105/UI-09.png', { x: 481, y: 154, width: 1414, height: 400 }, png);
  record('UI-09-detail-all', null, '전체 상세 카드. 영향 분석·승인 상자·승인 이력 배치 비교', 'desktop-clock20261105/UI-09.png', { x: 481, y: 154, width: 1414, height: 829 }, png);
});

test('MOD-07 Change Proposal 작성 모달', async ({ page }) => {
  await prepare(page);
  await page.goto('/change/CP-002');
  await page.getByRole('button', { name: '새 변경 제안' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change Proposal 작성' });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  const box = await dialog.boundingBox();
  const png = await shot(page);
  if (!box) throw new Error('모달 없음');
  expect(Math.round(box.width)).toBe(1080);
  record('MOD-07-modal', null, '폭 1080·제목·안내·입력 칸·표·버튼 배치 같음. 차이: 원본은 첫 행 대상 Task에 선택된 Task(TASK-0001)를 미리 채움, 제품은 빈 칸(이 화면에는 선택된 Task가 없음)',
    'desktop/MOD-07.png', { x: 420, y: 266, width: 1080, height: 548 }, png, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) });
});

test('UI-05 Planning 세션(PLN-001 이견 조정 중)', async ({ page }) => {
  await prepare(page);
  await page.goto('/planning');
  await expect(page.locator('.cmp > .card')).toHaveCount(2);
  const png = await shot(page);
  record('UI-05-page-head', 0.02, '같아야 함(제목·설명·탭 2개)', 'desktop-clock20261105/UI-05.png', { x: 181, y: 65, width: 1739, height: 128 }, png);
  record('UI-05-list', null, '원본처럼 첫 줄 세션 ID(PLN-001)를 보인다(M3 통합: 서버 표시 키 planningKey)', 'desktop-clock20261105/UI-05.png', { x: 204, y: 199, width: 260, height: 213 }, png);
  record('UI-05-session-card', null, '단계 7개·현재 단계 강조 같음. 첫 줄은 원본처럼 세션 ID(M3 통합: planningKey)', 'desktop-clock20261105/UI-05.png', { x: 481, y: 200, width: 1414, height: 150 }, png);
  record('UI-05-main', null, '독립 분석·교차 검토 배치 비교(글자는 같은 자료)', 'desktop-clock20261105/UI-05.png', { x: 465, y: 199, width: 1455, height: 881 }, png);
});

test('UI-05-02 일정 재조정 이력', async ({ page }) => {
  await prepare(page);
  await page.goto('/planning?tab=replans');
  await expect(page.getByRole('group', { name: '재조정 RP-001' })).toBeVisible();
  const png = await shot(page);
  record('UI-05-02-page-head', 0.02, '같아야 함(제목·설명·탭)', 'desktop-clock20261105/UI-05-02.png', { x: 181, y: 65, width: 1739, height: 128 }, png);
  record('UI-05-02-summary', null, '차이: 버튼 「Planning Agent 재조정 실행 (Mock)」→「재조정 실행」(실제 API), 태그는 정책 값', 'desktop-clock20261105/UI-05-02.png', { x: 204, y: 199, width: 1692, height: 99 }, png);
  record('UI-05-02-rp', null, 'RP 카드: 기준·초기·시각·주체·계기·4칸 값 같은 배치', 'desktop-clock20261105/UI-05-02.png', { x: 204, y: 326, width: 1692, height: 131 }, png);
});

test.afterAll(() => { writeSummary(results, NOTE, OUT); });
