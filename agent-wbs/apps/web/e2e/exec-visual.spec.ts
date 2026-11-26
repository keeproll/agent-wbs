/**
 * M3-06 작업 실행 시각 비교 — 원본 스크린샷(desktop-clock20261105/UI-06*.png, w1280/UI-06.png)과 같은 조건으로 찍어 영역별로 비교한다.
 * 결과: ~/.orca/bots/agentwbs/archive/2026-11-26/M3-06/visual/ ([원본 | 구현 | 차이] PNG + summary.md)
 * 조건·차이 계산·예외는 features/exec/README.md 「시각 비교」에 적었다.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { execApi, runnerState, type ExecApi } from './support/exec-fixtures.ts';
import { compareRegion, hasBaseline, writeSummary, type Box, type VisualResult } from './support/visual.ts';

const OUT = process.env.AWBS_EXEC_VISUAL_OUT ?? join(homedir(), '.orca/bots/agentwbs/archive/2026-11-26/M3-06/visual');

test.skip(!hasBaseline(), '원본 스크린샷 폴더가 없다(~/.cache/agent-wbs-baseline).');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const results: VisualResult[] = [];
const NOTE: Record<string, string> = {};

async function prepare(page: Page, setup?: (api: ExecApi) => void) {
  await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
  const api = await execApi(page);
  setup?.(api);
  return api;
}
async function shot(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1900, 1070);
  return page.screenshot({ animations: 'disabled', caret: 'hide' });
}
function record(name: string, limit: number | null, note: string, r: VisualResult) {
  results.push(r);
  NOTE[name] = note;
  NOTE[`${name}:limit`] = limit === null ? '기록만' : `≤ ${(limit * 100).toFixed(1)}%`;
  if (limit !== null) expect(r.ratio, `${name} 차이 ${(r.ratio * 100).toFixed(2)}%`).toBeLessThanOrEqual(limit);
}
const cmp = (name: string, file: string, box: Box, png: Buffer, actualBox: Box = box) => compareRegion(name, file, box, png, actualBox, OUT);

// 1920×1080 원본 좌표(UI-06.png). 영역 경계는 원본 카드 테두리.
const TITLE: Box = { x: 196, y: 80, width: 120, height: 40 };
const RAIL: Box = { x: 204, y: 153, width: 261, height: 911 };
const FLOW: Box = { x: 481, y: 153, width: 1059, height: 120 };
const NEXT_ROW: Box = { x: 481, y: 273, width: 1059, height: 86 };
const ATT_HEAD: Box = { x: 481, y: 375, width: 1059, height: 114 };
const MSG: Box = { x: 1556, y: 153, width: 340, height: 911 };

test('UI-06 실행 중 Task(TASK-0005·ATT-0005-1) 1920', async ({ page }) => {
  await prepare(page);
  await page.goto('/exec/TASK-0005?att=ATT-0005-1');
  await expect(page.getByLabel('ATT-0005-1 실행 기록')).toBeVisible();
  const png = await shot(page);
  const F = 'desktop-clock20261105/UI-06.png';
  record('UI-06-title', 0.02, '같아야 함(제목 「작업 실행」)', cmp('UI-06-title', F, TITLE, png));
  record('UI-06-rail', 0.03, '같아야 함(Task·시도 목록). 줄바꿈 위치 차이 허용', cmp('UI-06-rail', F, RAIL, png));
  record('UI-06-flow', 0.02, '같아야 함(WBS 번호·제목·상태·6단계)', cmp('UI-06-flow', F, FLOW, png));
  record('UI-06-next', null, '제품 결정: Mock 「결과 등록」 대신 「실행 중단」, 다음 작업 문구에서 Prototype 안내 제거(owner Q-04, G§9.7-3)', cmp('UI-06-next', F, NEXT_ROW, png));
  record('UI-06-attempt', null, '계약 공백: 지정/실제 하위 Agent 태그 없음(Attempt 응답에 필드 없음). 나머지 배치는 같음', cmp('UI-06-attempt', F, ATT_HEAD, png));
  record('UI-06-messages', 0.03, '같아야 함(연결 메시지 제목·「메시지 작성」 버튼). 제목은 h4 대신 h2(제목 순서)지만 같은 13px·600', cmp('UI-06-messages', F, { ...MSG, height: 48 }, png));
  record('UI-06-messages-hint', null, '제품 결정: 안내 문장 11.5px → 12px(MM-28 본문 12px 이상, 리뷰 #10), 빈 상태 안내 한 줄 추가', cmp('UI-06-messages-hint', F, { x: MSG.x, y: MSG.y + 48, width: MSG.width, height: 62 }, png));
});

test('UI-06D 재작업 대기 Task(TASK-0007·ATT-0007-2) — 검증 결과·메시지 1920', async ({ page }) => {
  await prepare(page);
  await page.goto('/exec/TASK-0007?att=ATT-0007-2');
  await expect(page.getByLabel('ATT-0007-2 실행 기록')).toBeVisible();
  const png = await shot(page);
  const F = 'desktop/UI-06D.png';
  record('UI-06D-rail', 0.03, '같아야 함(선택 시도 강조)', cmp('UI-06D-rail', F, RAIL, png));
  record('UI-06D-flow', 0.02, '같아야 함(QA 칸 fail·재작업 cur)', cmp('UI-06D-flow', F, FLOW, png));
  record('UI-06D-next', null, '제품 결정: 재작업은 서버 자동(자동 재작업 n/3회 표시), 버튼은 한도 초과 때만', cmp('UI-06D-next', F, NEXT_ROW, png));
  record('UI-06D-attempt', null, '시도 시각·Evidence 표시 차이: 계약 Evidence는 경로 대신 종류·해시(아래 README 예외)', cmp('UI-06D-attempt', F, { x: 481, y: 375, width: 1059, height: 340 }, png));
  record('UI-06D-messages', null, '보낸 메시지 본문 줄 수·시각 차이(fixture 문구), 「읽음 표시」 버튼 추가', cmp('UI-06D-messages', F, MSG, png));
});

test('UI-06-offline Runner 끊김·중단 재개 대기 1920', async ({ page }) => {
  await prepare(page, (api) => {
    api.state.runner = runnerState({ connection: { online: false, runnerId: null, version: null, lastHeartbeatAt: null, sessionStartedAt: null } });
    const att = api.state.attempts['TASK-0005']?.[0];
    if (att) Object.assign(att, { status: 'interrupted', endedAt: '2026-11-03T11:03:00.000Z', failure: 'Runner 수동 중지 — 실행이 끊겨 재개가 필요합니다' });
    const t = api.state.tasks.find((x) => x.taskKey === 'TASK-0005');
    if (t) t.lifecycleStatus = 'paused';
  });
  await page.goto('/exec/TASK-0005?att=ATT-0005-1');
  await expect(page.getByText('Runner 연결 끊김 — 재연결 후 실행합니다.')).toBeVisible();
  const png = await shot(page);
  const F = 'desktop-clock20261105/UI-06-offline.png';
  record('UI-06-offline-flow', 0.02, '같아야 함(중단 · 재개 대기 상태)', cmp('UI-06-offline-flow', F, FLOW, png));
  record('UI-06-offline-next', null, '다음 작업 문구는 같고 비활성 재개 버튼·사유 줄 위치 비교. 원본 TASK-0004도 중단이라 목록은 다름', cmp('UI-06-offline-next', F, { x: 481, y: 273, width: 1059, height: 112 }, png));
});

test('UI-06 1280×800 3영역 배치', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await prepare(page);
  await page.goto('/exec/TASK-0005?att=ATT-0005-1');
  await expect(page.getByLabel('ATT-0005-1 실행 기록')).toBeVisible();
  const png = await shot(page);
  record('UI-06-1280-main', null, '1280 미만 규칙(P L640): 메시지 영역이 아래로 내려감. 배치 확인용 기록', cmp('UI-06-1280-main', 'w1280/UI-06.png', { x: 181, y: 65, width: 1099, height: 735 }, png));
});

test.afterAll(() => { writeSummary(results, NOTE, OUT); });
