/**
 * M6-07 시각 비교 — 설계(UI-04, 04-02, 04-03, 04-03A, 04-04A, 04-05, 04-06)를 원본 스크린샷과 같은 조건에서 찍어 같은 영역을 비교한다.
 * 결과: ~/.orca/bots/agentwbs/archive/2026-11-27/M6-07/visual/ 에 [원본 | 구현 | 차이] 이미지와 summary.md.
 * 조건·차이 기준·예외는 src/features/design/README.md 「시각 비교」에 적었다. 가짜 원장 데이터는 원본 Mock과 같은 값이다(support/design-data.ts).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fakeApi } from './support/fake-api.ts';
import { designData, installDesign } from './support/design-data.ts';
import { mountTasks } from './support/task-api.ts';
import { compareRegion, hasBaseline, writeSummary, type Box, type VisualResult } from './support/visual.ts';

const OUT = process.env.AWBS_VISUAL_OUT_M607 ?? join(homedir(), '.orca/bots/agentwbs/archive/2026-11-27/M6-07/visual');

test.skip(!hasBaseline(), '원본 스크린샷 폴더가 없다(~/.cache/agent-wbs-baseline).');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const results: VisualResult[] = [];
const NOTE: Record<string, string> = {};
const failures: string[] = [];

async function openAt(page: Page, path: string, ready: string) {
  await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
  const api = await fakeApi(page);
  mountTasks(api);
  installDesign(api, designData());
  await page.goto(path);
  await expect(page.getByText(ready, { exact: false }).first()).toBeVisible();
}
async function shot(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1900, 1070);
  return page.screenshot({ animations: 'disabled', caret: 'hide' });
}
function record(name: string, file: string, box: Box, png: Buffer, limit: number | null, note: string, actualBox: Box = box) {
  const r = compareRegion(name, file, box, png, actualBox, OUT);
  results.push(r);
  NOTE[name] = note;
  NOTE[`${name}:limit`] = limit === null ? '기록만' : `≤ ${(limit * 100).toFixed(1)}%`;
  if (limit !== null && r.ratio > limit) failures.push(`${name} ${(r.ratio * 100).toFixed(2)}% > ${(limit * 100).toFixed(1)}%`);
}

const X = 181;
const W = 1739;
const B = 'desktop-clock20261105';
const at = (y: number, h: number): Box => ({ x: X, y, width: W, height: h });

test('UI-04 구성도 · 계약 파일(1920)', async ({ page }) => {
  await openAt(page, '/design', '시스템 구성');
  const png = await shot(page);
  record('UI-04-head', `${B}/UI-04.png`, at(65, 215), png, 0.02, '제목·설명·요약 줄·승인 대기 배너·탭 6개와 배지. 같아야 함');
  record('UI-04-layers', `${B}/UI-04.png`, at(330, 470), png, 0.03, '계층별 구성 요소(승인 대기 점선). 카드 머리 오른쪽 글자만 다름(원본 「Prototype Mock — …」 → 「확정 · 승인된 기술 결정과 main 계약 파일 기준」)');
  record('UI-04-cardhead', `${B}/UI-04.png`, at(290, 40), png, null, '카드 머리 오른쪽 안내 문구가 제품 문구로 바뀜(Mock 표시 제거)');
});

test('UI-04-02 기술 결정(1920)', async ({ page }) => {
  await openAt(page, '/design?tab=dec', '결정 권한 3단계');
  const png = await shot(page);
  record('UI-04-02-head', `${B}/UI-04-02.png`, at(65, 215), png, 0.02, '머리·배너·탭. 같아야 함');
  record('UI-04-02-body', `${B}/UI-04-02.png`, at(280, 800), png, null,
    '결정 행 모양은 같음. 「변경 제안 (Mock)」 버튼 이름이 「변경 제안」, 시각은 서버 ISO를 KST로 바꾼 같은 값');
});

test('UI-04-03 인터페이스 목록(1920)', async ({ page }) => {
  await openAt(page, '/design?tab=iface', 'PATCH /api/tasks/:taskKey');
  const png = await shot(page);
  record('UI-04-03-bar', `${B}/UI-04-03.png`, at(280, 50), png, 0.03, '방식 필터 건수·검색. 같아야 함');
  record('UI-04-03-table', `${B}/UI-04-03.png`, at(330, 750), png, null,
    '목록은 원본처럼 Task 순이나 같은 Task 안은 항목 key 순(원본은 Task 설계 순서). 설명 칸은 계약에 설명 필드가 없어 「—」(보고함). 상태는 담당 Task 상태로 같은 규칙');
});

test('UI-04-03A REST 상세(1920)', async ({ page }) => {
  await openAt(page, '/design?tab=iface&sel=GET%20%2Fapi%2Fprojects%2F%3AprojectId%2Ftasks', 'includeDeleted?: boolean');
  const png = await shot(page);
  record('UI-04-03A-detail', `${B}/UI-04-03A.png`, { x: 480, y: 285, width: 1416, height: 700 }, png, null,
    '상세 모양(요청·응답 코드 상자, 검증 규칙, 오류 코드, 읽고 쓰는 테이블)은 같음. 설명 대신 항목 key가 없으면 빈 줄, 계약 파일 칸에 기준 커밋을 덧붙임, 위치 번호는 Task 순 · 같은 Task 안 key 순 기준');
  record('UI-04-03A-rail', `${B}/UI-04-03A.png`, { x: 204, y: 285, width: 262, height: 44 }, png, 0.03, '레일 머리(제목·건수·펼치기). 같아야 함. 레일 항목 순서는 같은 Task 안 key 순이라 첫 항목은 비교하지 않음');
});

test('UI-04-05 소유권 · 흐름(1920)', async ({ page }) => {
  await openAt(page, '/design?tab=own', '데이터 소유권 · 흐름');
  const png = await shot(page);
  record('UI-04-05-body', `${B}/UI-04-05.png`, at(280, 330), png, 0.03, '표·안내 문구. 같아야 함');
});

test('UI-04-06 변경 · 불일치(1920)', async ({ page }) => {
  await openAt(page, '/design?tab=chg', '설계와 실제 코드의 불일치');
  const png = await shot(page);
  record('UI-04-06-drifts', `${B}/UI-04-06.png`, at(280, 360), png, null,
    '계약에 없는 표시 번호(DR-01) 없음, 이름은 서버 고정 키(postgres:tasks), 호환 판정 배지(호환·호환 깨짐·대조 안 함) 추가, 처리 결과 줄 추가(결과 커밋)');
  // 위 불일치 카드는 처리 결과 줄(해결된 DR-03)이 더해져 높아진다. 설계 버전 카드는 실제 위치에서 잘라 모양만 비교한다.
  const card = await page.locator('section.card', { hasText: '설계 버전' }).boundingBox();
  const y = Math.round(card?.y ?? 658);
  record('UI-04-06-versions-head', `${B}/UI-04-06.png`, { x: 204, y: 658, width: 1692, height: 80 }, png, 0.03, '설계 버전 카드 머리와 첫 줄. 같아야 함(세로 위치만 실제 카드 위치로 맞춤)', { x: 204, y, width: 1692, height: 80 });
  record('UI-04-06-versions', `${B}/UI-04-06.png`, { x: 204, y: 658, width: 1692, height: 170 }, png, null, '설계 버전 표 전체. 구현 행 높이가 35.75px(원본 36px)라 아래 줄이 1px씩 밀림 — 기록만', { x: 204, y, width: 1692, height: 170 });
});

test.afterAll(() => {
  writeSummary(results, NOTE, OUT);
  expect(failures, failures.join('\n')).toEqual([]);
});
