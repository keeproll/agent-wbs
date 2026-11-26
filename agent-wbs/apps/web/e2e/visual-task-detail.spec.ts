/**
 * Task 상세 시각 비교(M3-03) — 원본 스크린샷 desktop-clock20261105/UI-03-0N·UI-03E와 같은 조건으로 찍어 같은 영역을 비교한다.
 * 결과: ~/.orca/bots/agentwbs/archive/2026-11-26/M3-03/visual/ ([원본 | 구현 | 차이] 이미지 + summary.md)
 *
 * 조건: 1920×1080, 기기 배율 1, ko-KR, Asia/Seoul, 시계 2026-11-05 20:00 KST, 애니메이션 끔, 마우스는 구석.
 * 데이터: 원본 화면에서 꺼낸 Mock(fixtures/prototype-mock.json)을 계약 모양으로 바꾼 가짜 서버.
 * 영역: 원본 화면의 요소 위치(원본을 같은 조건으로 열어 잰 값)와 구현 화면의 같은 요소 위치를 맞춰 자른다.
 *   왜 요소 기준인가: 상세 위 WBS 제목 줄은 M3-02 몫이라 높이가 달라, 화면 좌표를 그대로 쓰면 전부 어긋난다.
 * 기준·예외는 features/task/README.md §6.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fakeApi, json } from './support/fake-api.ts';
import { mountTasks, newStore } from './support/task-api.ts';
import { compareRegion, hasBaseline, writeSummary, type Box, type VisualResult } from './support/visual.ts';

const OUT = process.env.AWBS_VISUAL_OUT_M303 ?? join(homedir(), '.orca/bots/agentwbs/archive/2026-11-26/M3-03/visual');

test.skip(!hasBaseline(), '원본 스크린샷 폴더가 없다(~/.cache/agent-wbs-baseline).');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const results: VisualResult[] = [];
const NOTE: Record<string, string> = {};
test.afterAll(() => { writeSummary(results, NOTE, OUT); });

/** 원본(1920×1080, TASK-0004 선택)에서 잰 위치. measure: 원본 .dt-head·.dt-body .pane·.gate의 getBoundingClientRect */
const BASE = {
  head: { x: 481, y: 174, width: 1414, height: 263 },
  pane: { x: 501, y: 456 },
  gate: { x: 501, y: 393, width: 1374, height: 229 },
  /** 원본 상세가 끝나는 y(173+892). 그 아래는 화면 밖 */
  bottom: 1063,
};

async function openTask(page: Page, tab = '') {
  await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
  const api = await fakeApi(page);
  mountTasks(api, newStore());
  // 실제 서버처럼 설정의 모델 이름을 준다(등급 표시 「Opus 5.5 · 높음」).
  const models = [['Claude', 'claude-opus-5-5', 'Opus 5.5'], ['Claude', 'claude-sonnet-5-5', 'Sonnet 5.5'], ['Codex', 'codex-large', 'Codex Large'], ['Codex', 'codex-mini', 'Codex Mini']]
    .map(([agent, id, label]) => ({ agent, id, label, rank: 1, allowed: true, isNew: false, efforts: null }));
  api.on('GET /api/settings/models', (route) => json(route, 200, { models, rankOrder: { Claude: [], Codex: [] }, codexFamilyOrder: ['codex'], claudeModels: [], updatedAt: null }));
  api.on('GET /api/settings/exec-policy', (route) => json(route, 200, { floors: { verifyGeDev: true, dbHigh: true }, updatedAt: null }));
  await page.goto(`/wbs/TASK-0004${tab ? `?tab=${tab}` : ''}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Drizzle Schema 설계' })).toBeVisible();
}
async function shot(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1910, 1075);
  return page.screenshot({ animations: 'disabled', caret: 'hide' });
}
async function boxOf(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} 없음`);
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}
function record(name: string, limit: number | null, note: string, r: VisualResult) {
  results.push(r);
  NOTE[name] = note;
  NOTE[`${name}:limit`] = limit === null ? '기록만' : `≤ ${(limit * 100).toFixed(1)}%`;
  if (limit !== null) expect(r.ratio, `${name} 차이 ${(r.ratio * 100).toFixed(2)}%`).toBeLessThanOrEqual(limit);
}

test('UI-03E 상세 머리(위치·제목·요약 10칸·탭 9개)', async ({ page }) => {
  await openTask(page);
  const png = await shot(page);
  const ours = await boxOf(page, '.dt-head');
  record('UI-03E-head', LIMITS['UI-03E-head'] ?? null, NOTES['UI-03E-head'] ?? '', compareRegion('UI-03E-head', 'desktop-clock20261105/UI-03-01.png', BASE.head, png, ours, OUT));
});

test('UI-03E Gate 펼침(5조건·완료 처리)', async ({ page }) => {
  await openTask(page, 'msg');
  await page.getByRole('button', { name: /미통과 2\/5/ }).click();
  const png = await shot(page);
  record('UI-03E-gate', LIMITS['UI-03E-gate'] ?? null, NOTES['UI-03E-gate'] ?? '', compareRegion('UI-03E-gate', 'desktop-clock20261105/UI-03E.png', BASE.gate, png, await boxOf(page, '.gate'), OUT));
});

const TABS = [
  ['UI-03-01', 'overview'], ['UI-03-02', 'spec'], ['UI-03-03', 'deps'], ['UI-03-04', 'tech'], ['UI-03-05', 'checklist'],
  ['UI-03-06', 'exec'], ['UI-03-07', 'verif'], ['UI-03-08', 'hist'], ['UI-03-09', 'msg'],
] as const;

for (const [id, tab] of TABS) {
  test(`${id} 탭 본문(보이는 부분)`, async ({ page }) => {
    await openTask(page, tab === 'overview' ? '' : tab);
    const png = await shot(page);
    const ours = await boxOf(page, '.dt-body .pane');
    // 화면 안에 보이는 높이만 비교한다(원본·구현 중 짧은 쪽).
    const height = Math.min(BASE.bottom - BASE.pane.y, 1080 - ours.y - 18, ours.height);
    const width = 1160;
    record(id, LIMITS[id] ?? null, NOTES[id] ?? '', compareRegion(id, `desktop-clock20261105/${id}.png`, { ...BASE.pane, width, height }, png, { x: ours.x, y: ours.y, width, height }, OUT));
  });
}

/** 영역별 허용 차이(넘으면 실패). null은 기록만(차이 원인이 제품 결정·계약 차이). README §6과 같게 유지한다. */
const SAME = '같아야 함(원본 마크업·클래스 그대로)';
const LIMITS: Record<string, number | null> = {
  'UI-03E-head': 0.01, 'UI-03E-gate': 0.01, 'UI-03-02': 0.01, 'UI-03-03': 0.01, 'UI-03-04': 0.01, 'UI-03-05': 0.01,
  'UI-03-07': 0.01, 'UI-03-08': 0.01, 'UI-03-09': 0.01, 'UI-03-01': null, 'UI-03-06': null,
};
const NOTES: Record<string, string> = {
  'UI-03E-head': SAME, 'UI-03E-gate': SAME, 'UI-03-02': SAME, 'UI-03-03': SAME, 'UI-03-04': SAME, 'UI-03-05': SAME,
  'UI-03-07': SAME, 'UI-03-08': SAME, 'UI-03-09': SAME,
  'UI-03-01': '계약 차이: TaskDetail에 예상 토큰·추정 주체/신뢰도/근거·실제 실행·고정 시작일이 없어 작업량·일정 칸이 줄어 아래가 위로 당겨짐(보고함)',
  'UI-03-06': '계약 차이: Attempt에 CI 참조(M7-05)·지정/실제 하위 Agent 태그가 없음. 등급·시각 표기는 원본과 같음',
};
