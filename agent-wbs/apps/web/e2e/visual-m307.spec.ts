/**
 * M3-07 시각 비교 — 대시보드(UI-01)·검증(UI-07, 07-01A, 07-02, 07-03)·이력(UI-10)을 원본 스크린샷과 같은 조건에서 찍어 같은 영역을 비교한다.
 * 결과: ~/.orca/bots/agentwbs/archive/2026-11-26/M3-07/visual/ 에 [원본 | 구현 | 차이] 이미지와 summary.md.
 * 조건·차이 기준·예외는 src/features/verify/README.md 「시각 비교」에 적었다.
 * 가짜 API 데이터는 원본 Mock과 같은 값이다(support/m307-data.ts).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fakeApi } from './support/fake-api.ts';
import { installM307, m307Data } from './support/m307-data.ts';
import { compareRegion, hasBaseline, writeSummary, type Box, type VisualResult } from './support/visual.ts';

const OUT = process.env.AWBS_VISUAL_OUT_M307 ?? join(homedir(), '.orca/bots/agentwbs/archive/2026-11-26/M3-07/visual');

test.skip(!hasBaseline(), '원본 스크린샷 폴더가 없다(~/.cache/agent-wbs-baseline).');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const results: VisualResult[] = [];
const NOTE: Record<string, string> = {};
const failures: string[] = [];

async function openAt(page: Page, path: string, ready: string) {
  await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
  const api = await fakeApi(page);
  installM307(api, m307Data());
  await page.goto(path);
  await expect(page.getByText(ready, { exact: false }).first()).toBeVisible();
}
async function shot(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1900, 1070);
  return page.screenshot({ animations: 'disabled', caret: 'hide' });
}
/**
 * 원본 「.full」 사진과 같은 방법으로 찍는다(baseline walk.mjs L14): 본문 안쪽 스크롤 길이만큼 viewport를 늘려 한 장에 담는다.
 * 페이지 전체 캡처(fullPage)는 문서가 아니라 본문 상자가 스크롤되는 구조라 아래가 잘린다.
 */
async function fullShot(page: Page) {
  const extra = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('.main,.main *')]
    .filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY)).map((e) => e.scrollHeight - e.clientHeight)));
  const size = page.viewportSize() ?? { width: 1920, height: 1080 };
  await page.setViewportSize({ width: size.width, height: Math.min(size.height + extra, 9000) });
  const png = await shot(page);
  await page.setViewportSize(size);
  return png;
}
/** limit: 허용 차이 비율(넘으면 실패), null: 기록만(제품 결정으로 글자·배치가 다른 영역) */
function record(name: string, file: string, box: Box, png: Buffer, limit: number | null, note: string, actualBox: Box = box) {
  const r = compareRegion(name, file, box, png, actualBox, OUT);
  results.push(r);
  NOTE[name] = note;
  NOTE[`${name}:limit`] = limit === null ? '기록만' : `≤ ${(limit * 100).toFixed(1)}%`;
  if (limit !== null && r.ratio > limit) failures.push(`${name} ${(r.ratio * 100).toFixed(2)}% > ${(limit * 100).toFixed(1)}%`);
}

const MAIN_X = 181;
const W = 1739;

test('UI-01 대시보드(1920, 전체 페이지)', async ({ page }) => {
  await openAt(page, '/dashboard', '다음 행동을 결정하는');
  const png = await fullShot(page);
  const F = 'desktop-clock20261105/UI-01.full.png';
  const at = (y: number, h: number): Box => ({ x: MAIN_X, y, width: W, height: h });
  record('UI-01-head', F, at(65, 120), png, 0.02, '제목·설명·기준 시각·일정 설명 한 줄. 같아야 함');
  record('UI-01-sched', F, at(184, 125), png, 0.02, '일정 카드 4개. 같아야 함');
  record('UI-01-alerts', F, at(326, 115), png, null, '제품 결정: 알림 버튼이 대상별 이름(「프로젝트 보기」 등)이고 「확인」 버튼 없음(닫기 API 없음)');
  record('UI-01-kpis', F, at(455, 140), png, 0.02, 'Task 현황 KPI 4개. 같아야 함');
  record('UI-01-panels', F, at(605, 332), png, null, '서버 계약에 Planning·CP·시도·검증 표시 번호가 없어 왼쪽 칸이 「Planning」「CP」「TASK-…」(원본 PLN-001·CP-002·ATT-…), 재작업 꼬리표에 V-0007-1 없음');
  record('UI-01-dist', F, at(948, 295), png, 0.02, '작업 유형·기술 영역 분포. 같아야 함');
  record('UI-01-grades', F, at(1255, 175), png, 0.03, '등급 표. 같아야 함(모델 이름은 서버 modelId 그대로)');
  record('UI-01-recent', F, at(1455, 362), png, null, '서버 최근 결과에 시도·검증 표시 번호가 없어 3번째 칸이 Task, 4번째 칸이 Agent(원본: ID·Task)');
});

test('UI-07 검증 결과 목록(1920)', async ({ page }) => {
  await openAt(page, '/verify', 'V-0007-1');
  const png = await shot(page);
  record('UI-07-01-list', 'desktop-clock20261105/UI-07-01.png', { x: MAIN_X, y: 65, width: W, height: 300 }, png, 0.02, '탭·필터·표. 같아야 함');
});

test('UI-07-01A 검증 상세(1920)', async ({ page }) => {
  await openAt(page, '/verify?sel=v-0007-1', '12/14 통과');
  await expect(page.getByRole('group', { name: /체크리스트 연결/ }).first()).toBeVisible();
  const png = await shot(page);
  record('UI-07-01A-rail', 'desktop/UI-07-01A.png', { x: 204, y: 199, width: 262, height: 222 }, png, 0.02, '레일(검증 결과 2·펼치기·선택 강조). 같아야 함');
  record('UI-07-01A-detail', 'desktop/UI-07-01A.png', { x: 480, y: 199, width: 1416, height: 480 }, png, null,
    'Evidence는 계약에 경로가 없어 「종류 · 지문 앞 12자리」와 「원본 내려받기」로 보임. 팀장용 Evidence 추가 API가 없어 경로 입력 칸 없음(조정자 결정). 명령·결함 문구는 시험 데이터 차이');
});

test('UI-07-02 Evidence(1920)', async ({ page }) => {
  await openAt(page, '/verify?tab=evidence', '모든 Evidence는');
  const png = await shot(page);
  record('UI-07-02-head', 'desktop-clock20261105/UI-07-02.png', { x: MAIN_X, y: 65, width: W, height: 158 }, png, 0.02, '탭·안내 문구. 같아야 함');
  record('UI-07-02-table', 'desktop-clock20261105/UI-07-02.png', { x: MAIN_X, y: 223, width: W, height: 340 }, png, null,
    'Evidence 이름이 파일 경로가 아니라 「종류 · 지문」. 원본의 경고 막대는 원본 데이터의 고아 체크리스트 경로 목록이라 다름(제품은 검증 없는 Evidence만)');
});

test('UI-07-03 Completion Gate(1920)', async ({ page }) => {
  await openAt(page, '/verify?tab=gate', '상태를 Completed로');
  const png = await shot(page);
  record('UI-07-03-gate', 'desktop-clock20261105/UI-07-03.png', { x: MAIN_X, y: 65, width: W, height: 570 }, png, 0.02, '탭·표시 필터·Task×5조건 표. 같아야 함');
});

test('UI-10 이력(1920)', async ({ page }) => {
  await openAt(page, '/history', 'ATT-0005-1 개발 실행 시작');
  const png = await shot(page);
  record('UI-10-toolbar', 'desktop-clock20261105/UI-10.png', { x: MAIN_X, y: 65, width: W, height: 240 }, png, null, '제품 추가: 기간 시작·끝 입력(MM-18, G L336)');
  record('UI-10-table', 'desktop-clock20261105/UI-10.png', { x: MAIN_X, y: 305, width: W, height: 775 }, png, 0.03, '건수 막대·이력 표. 같아야 함');
});

test('1280×800: 대시보드·검증·이력', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const main: Box = { x: MAIN_X, y: 65, width: 1099, height: 735 };
  await openAt(page, '/dashboard', '다음 행동을 결정하는');
  record('w1280-UI-01', 'w1280/UI-01.png', main, await shot(page), null, '알림 버튼 이름 차이(위 UI-01-alerts)가 화면 안에 있어 기록만');
  await page.goto('/verify');
  await expect(page.getByText('V-0007-1').first()).toBeVisible();
  record('w1280-UI-07', 'w1280/UI-07.png', main, await shot(page), 0.02, '같아야 함');
  await page.goto('/history');
  await expect(page.getByText('ATT-0005-1 개발 실행 시작').first()).toBeVisible();
  record('w1280-UI-10', 'w1280/UI-10.png', main, await shot(page), null, '제품 추가: 기간 시작·끝 입력(같은 줄에 들어가 아래 표 위치는 같음)');
});

test.afterAll(() => {
  writeSummary(results, NOTE, OUT);
  expect(failures, failures.join('\n')).toEqual([]);
});
