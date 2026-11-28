/**
 * M7-05 시각 비교 — 빌드·통합(UI-08, 08-01, 08-01A, 08-02, 08-03, 08-04, 08-05)을 원본 스크린샷과 같은 조건에서 찍어 같은 영역을 비교한다.
 * 결과: 기본은 실행마다 새 임시 폴더(support/visual.ts visualOut), 보관하려면 AWBS_VISUAL_OUT_M705=~/.orca/bots/agentwbs/archive/2026-11-27/M7-05/visual/ 로 명시 에 [원본 | 구현 | 차이] 이미지와 summary.md.
 * 조건·차이 기준·예외는 src/features/ci/README.md 「시각 비교」에 적었다. 가짜 API 데이터는 원본 CI_MOCK과 같은 값이다(support/ci-data.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { fakeApi } from './support/fake-api.ts';
import { ciData, installCi } from './support/ci-data.ts';
import { compareRegion, hasBaseline, writeSummary, type Box, type VisualResult, visualOut } from './support/visual.ts';

const OUT = visualOut('AWBS_VISUAL_OUT_M705', 'M7-05-visual-fix1');

test.skip(!hasBaseline(), '원본 스크린샷 폴더가 없다(~/.cache/agent-wbs-baseline).');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const results: VisualResult[] = [];
const NOTE: Record<string, string> = {};
const failures: string[] = [];

async function openAt(page: Page, path: string, ready: string) {
  await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
  const api = await fakeApi(page);
  installCi(api, ciData({ prototypeOrder: true }));
  await page.goto(path);
  await expect(page.getByText(ready, { exact: false }).first()).toBeVisible();
}
async function shot(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1900, 1070);
  return page.screenshot({ animations: 'disabled', caret: 'hide' });
}
/** 원본 「.full」 사진과 같은 방법(본문 안쪽 스크롤 길이만큼 viewport를 늘려 한 장에 담기, visual-m307과 같음) */
async function fullShot(page: Page) {
  const extra = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('.main,.main *')]
    .filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY)).map((e) => e.scrollHeight - e.clientHeight)));
  const size = page.viewportSize() ?? { width: 1920, height: 1080 };
  await page.setViewportSize({ width: size.width, height: Math.min(size.height + extra, 9000) });
  const png = await shot(page);
  await page.setViewportSize(size);
  return png;
}
/** limit: 허용 차이 비율(넘으면 실패), null: 기록만(제품 결정·계약 차이로 글자가 다른 영역) */
function record(name: string, file: string, box: Box, png: Buffer, limit: number | null, note: string, actualBox: Box = box) {
  const r = compareRegion(name, file, box, png, actualBox, OUT);
  results.push(r);
  NOTE[name] = note;
  NOTE[`${name}:limit`] = limit === null ? '기록만' : `≤ ${(limit * 100).toFixed(1)}%`;
  if (limit !== null && r.ratio > limit) failures.push(`${name} ${(r.ratio * 100).toFixed(2)}% > ${(limit * 100).toFixed(1)}%`);
}

const X = 181;
const W = 1739;
const at = (y: number, h: number, x = X, w = W): Box => ({ x, y, width: w, height: h });
const C = 'desktop-clock20261105';

test('UI-08·08-01 실행 기록 목록(1920)', async ({ page }) => {
  await openAt(page, '/ci', 'CI-0126');
  const png = await shot(page);
  const F = `${C}/UI-08.png`;
  record('UI-08-title', F, at(65, 76, X, 1450), png, 0.02, '제목·설명. 같아야 함');
  record('UI-08-mainline', F, at(141, 26, X, 1450), png, 0.02, 'main 배지(Runner 보고 E2E 수·끝난 시각, M7-04 fix2 계약 1)·요약. 같아야 함. 오른쪽 Mock 버튼은 비교 영역 밖(제품에 없음)');
  record('UI-08-tabs', F, at(180, 44), png, 0.02, '탭 5개·배지. 같아야 함');
  record('UI-08-01-filter', F, at(226, 36, X, 700), png, 0.02, '단계 필터와 건수. 같아야 함');
  record('UI-08-01-table', F, at(266, 572), png, 0.03, '실행 표. 같아야 함');
});

test('UI-08-01A 실행 상세(1920)', async ({ page }) => {
  await openAt(page, '/ci/ci-0126', '비교 9화면');
  const png = await shot(page);
  const F = `${C}/UI-08-01A.png`;
  record('UI-08-01A-rail', F, at(229, 851, 204, 262), png, 0.03, '레일(실행 기록 10·펼치기·선택 강조). 같아야 함');
  record('UI-08-01A-head', F, { x: 480, y: 229, width: 1416, height: 270 }, png, 0.02, '대상·계기·시각·GitHub·실행 설명(note, fix2 계약 2). 같아야 함');
  record('UI-08-01A-steps', F, { x: 480, y: 520, width: 1416, height: 230 }, png, 0.03, '단계 표·스크린샷. 같아야 함(시험 자료의 단계 시간은 원본 공식 값)');
});

test('UI-08-02 병합 대기열(1920)', async ({ page }) => {
  await openAt(page, '/ci?tab=queue', 'Drizzle Schema 설계');
  const png = await shot(page);
  const F = `${C}/UI-08-02.png`;
  record('UI-08-02-head', F, at(229, 70), png, 0.02, '제목·안내. 같아야 함');
  record('UI-08-02-table', F, at(296, 160), png, 0.03, '대기열 행(병합됨=실제 병합 시각, 그 밖=대기열 시각, fix2 계약 3). 같아야 함. 시각 칸은 실행 상세 링크');
});

test('UI-08-03 배포 확인(1920)', async ({ page }) => {
  await openAt(page, '/ci?tab=deploy', '「Web Service가');
  const png = await shot(page);
  const F = `${C}/UI-08-03.png`;
  record('UI-08-03-card', F, at(229, 160), png, null, '제품 결정: Mock 버튼 「배포 확인 실패」 없음. 그 밖은 같아야 함(기록만, 차이 원인 확인용)');
  record('UI-08-03-head', F, at(229, 100), png, 0.02, '제목·결과 배지·안내·접속 URL. 같아야 함');
});

test('UI-08-04 파이프라인 정의(1920, 전체 페이지)', async ({ page }) => {
  await openAt(page, '/ci?tab=pipe', '보관하는 것은 커밋 해시와');
  await expect(page.getByText('매일 02:00', { exact: true })).toBeVisible();
  const png = await fullShot(page);
  const F = `${C}/UI-08-04.full.png`;
  record('UI-08-04-def', F, at(229, 920), png, 0.02, '규칙 5개·4단계(실행 조건·통과 조건·단계). 같아야 함');
  record('UI-08-04-settings', F, at(1165, 205), png, 0.02, '실행 설정(서비스 기동 = Runner가 main에서 읽은 구성, fix2 계약 5). 같아야 함');
});

test('UI-08-05 불안정 테스트(1920)', async ({ page }) => {
  await openAt(page, '/ci?tab=flaky', 'wbs-tree.spec.ts');
  const png = await shot(page);
  const F = `${C}/UI-08-05.png`;
  record('UI-08-05-card', F, at(229, 140), png, 0.02, '안내·행(시험·비율·마지막 시각·상태·Task·버튼). 같아야 함');
});

test.afterAll(() => {
  writeSummary(results, NOTE, OUT);
  expect(failures, failures.join('\n')).toEqual([]);
});
