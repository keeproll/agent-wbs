/**
 * M3-08 설정 화면 — 원본 스크린샷과 나란히 비교(시각 비교).
 * 조건은 M3-01 visual.spec.ts와 같다: viewport 1920×1080, 기기 배율 1, ko-KR, Asia/Seoul, 시계 2026-11-05 20:00 KST, 애니메이션 끔, 마우스는 화면 구석.
 * 원본: ~/.cache/agent-wbs-baseline/desktop-clock20261105/UI-12*.png(설정 탭별 첫 화면).
 * 결과: ~/.orca/bots/agentwbs/archive/2026-11-26/M3-08/visual/ 에 [원본 | 구현 | 차이] 이미지와 summary.md.
 * 차이 기준과 예외는 features/settings/README.md 「시각 비교」에 적었다.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fakeApi } from './support/fake-api.ts';
import { RUNNER_FULL, settingsApi } from './support/settings-fixtures.ts';
import { compareRegion, hasBaseline, type Box, type VisualResult } from './support/visual.ts';

test.skip(!hasBaseline(), '원본 스크린샷 폴더가 없다(~/.cache/agent-wbs-baseline).');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const OUT = process.env.AWBS_SETTINGS_VISUAL_OUT ?? join(homedir(), '.orca/bots/agentwbs/archive/2026-11-26/M3-08/visual');
const rows: { r: VisualResult; limit: number | null; note: string }[] = [];

/** 공용 비교 도구(support/visual.ts)는 M3-01 폴더에 쓰므로, 결과 이미지를 M3-08 폴더로 옮긴다. */
function record(name: string, limit: number | null, note: string, r: VisualResult) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, basename(r.file));
  renameSync(r.file, file);
  rows.push({ r: { ...r, file }, limit, note });
  if (limit !== null) expect(r.ratio, `${name} 차이 ${(r.ratio * 100).toFixed(2)}%`).toBeLessThanOrEqual(limit);
}

async function open(page: Page, path: string) {
  await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
  settingsApi(await fakeApi(page), RUNNER_FULL);
  await page.goto(path);
  await expect(page.locator('a.tab.on')).toHaveCount(1);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1900, 1070);
  return page.screenshot({ animations: 'disabled', caret: 'hide' });
}

const NAV: Box = { x: 0, y: 64, width: 180, height: 1016 };
const TITLE: Box = { x: 181, y: 65, width: 900, height: 50 };
const SUB: Box = { x: 181, y: 115, width: 1739, height: 30 };
const TABS: Box = { x: 181, y: 150, width: 1739, height: 70 };
const MAIN: Box = { x: 181, y: 65, width: 1739, height: 1015 };

test('UI-12 Runner 탭(첫 화면)', async ({ page }) => {
  const png = await open(page, '/settings/runner');
  const base = 'desktop-clock20261105/UI-12.png';
  record('UI-12-nav', 0.01, '같아야 함(설정 선택 강조)', compareRegion('UI-12-nav', base, NAV, png, NAV));
  record('UI-12-title', 0.01, '같아야 함(제목 「설정」 위치·크기)', compareRegion('UI-12-title', base, TITLE, png, TITLE));
  record('UI-12-sub', null, '제품 결정: 설명에서 「Prototype」·「(Mock)」·「구현 현황」 제거(UAT-POLICY-05)', compareRegion('UI-12-sub', base, SUB, png, SUB));
  record('UI-12-tabs', null, '제품 결정: 탭 「점검 · Prototype」→「점검」, 일정 탭 분할 위반 배지 없음(서버 API 없음, 보고). 탭 높이·간격·선택 밑줄은 같음', compareRegion('UI-12-tabs', base, TABS, png, TABS));
  record('UI-12-main', null, 'Mock 데이터와 값이 다르고 Mock 버튼(인증 만료·복구·다시 점검 등) 없음, 확인 시각 대신 상태만. 카드 순서·카드 머리·표 열 폭은 같음', compareRegion('UI-12-main', base, MAIN, png, MAIN));
});

test('UI-12-02 Agent 탭(첫 화면)', async ({ page }) => {
  const png = await open(page, '/settings/agent');
  const base = 'desktop-clock20261105/UI-12-02.png';
  record('UI-12-02-title', 0.01, '같아야 함', compareRegion('UI-12-02-title', base, TITLE, png, TITLE));
  // Agent 역할 카드: 같은 값(Claude 개발·Codex 검증)이면 같은 모양이어야 한다.
  const card: Box = { x: 204, y: 230, width: 1692, height: 250 };
  record('UI-12-02-workflow-card', 0.01, '같아야 함: 같은 값(Claude 개발·Codex 검증)·같은 문구', compareRegion('UI-12-02-workflow-card', base, card, png, card));
  record('UI-12-02-main', null, '모델 목록·하위 Agent 정의가 Mock과 다름. 모델 순서 버튼(▲▼) 추가, 팀장 고정 Task 행 없음(서버 API 없음)', compareRegion('UI-12-02-main', base, MAIN, png, MAIN));
});

test('UI-12-03 일정 · Task 탭(첫 화면)', async ({ page }) => {
  const png = await open(page, '/settings/plan');
  const base = 'desktop-clock20261105/UI-12-03.png';
  record('UI-12-03-title', 0.01, '같아야 함', compareRegion('UI-12-03-title', base, TITLE, png, TITLE));
  // 분할 기준 카드의 폼·10규칙 표(원본 SPLIT_MOCK과 같은 값). 카드 머리 오른쪽 요약(sumL)은 서버 API가 없어 없다.
  const split: Box = { x: 204, y: 285, width: 1692, height: 615 };
  record('UI-12-03-split', 0.01, '같아야 함: 원본 SPLIT_MOCK과 같은 값·문구(규칙 표 「끄기」 버튼은 접근 이름만 다름)', compareRegion('UI-12-03-split', base, split, png, split));
  record('UI-12-03-main', null, '「기준을 벗어난 Task」 목록 없음(서버 API 없음, 보고)', compareRegion('UI-12-03-main', base, MAIN, png, MAIN));
});

test('UI-12-06 점검 탭', async ({ page }) => {
  const png = await open(page, '/settings/system');
  const base = 'desktop-clock20261105/UI-12-06.png';
  record('UI-12-06-title', 0.01, '같아야 함', compareRegion('UI-12-06-title', base, TITLE, png, TITLE));
  record('UI-12-06-main', null, '제품 결정: 「Prototype 구현 현황」·「화면 상태 미리보기」 카드 없음, 설명 문구에서 Mock 제거(UAT-POLICY-05)', compareRegion('UI-12-06-main', base, MAIN, png, MAIN));
});

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  const lines = [
    '# M3-08 설정 화면 시각 비교',
    '',
    '조건: 1920×1080, 배율 1, ko-KR, Asia/Seoul, 시계 2026-11-05 20:00 KST, 애니메이션 끔. 차이: pixelmatch threshold 0.1, 안티에일리어싱 제외.',
    '',
    '| 영역 | 크기 | 차이 픽셀 | 비율 | 기준 | 차이 원인 |', '|---|---|---:|---:|---|---|',
    ...rows.map(({ r, limit, note }) => `| ${r.name} | ${r.size} | ${String(r.diffPixels)} | ${(r.ratio * 100).toFixed(2)}% | ${limit === null ? '기록만' : `≤ ${(limit * 100).toFixed(1)}%`} | ${note} |`),
  ];
  writeFileSync(join(OUT, 'summary.md'), `${lines.join('\n')}\n`);
});
