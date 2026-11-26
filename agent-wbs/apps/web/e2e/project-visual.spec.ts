/**
 * M3-04 시각 비교 — 원본 스크린샷과 같은 조건(1920×1080, 배율 1, ko-KR, Asia/Seoul, 시계 2026-11-05 20:00 KST, 애니메이션 끔)으로
 * 프로젝트 화면을 찍어 같은 영역을 잘라 비교한다. 결과: ~/.orca/bots/agentwbs/archive/2026-11-26/M3-04/visual/
 * 차이 기준과 예외는 features/project/README.md 「시각 비교」에 적었다.
 * 데이터는 원본 Mock과 같은 값을 가짜 API로 준다(원본 화면의 글자와 맞추기 위해서다. 제품 데이터는 Runner 보고에서 온다).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fakeApi, json, NO_PROJECT } from './support/fake-api.ts';
import { activeProject, bootProject, decision, GITHUB_OK, MD, PREVIEW, REPO_OK, SHA1, steps } from './support/project-fixtures.ts';
import { compareRegion, hasBaseline, writeSummary, type Box, type VisualResult } from './support/visual.ts';

const OUT = process.env.AWBS_VISUAL_OUT_M304 ?? join(homedir(), '.orca/bots/agentwbs/archive/2026-11-26/M3-04/visual');
test.skip(!hasBaseline(), '원본 스크린샷 폴더가 없다(~/.cache/agent-wbs-baseline).');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const results: VisualResult[] = [];
const NOTE: Record<string, string> = {};
function record(name: string, limit: number | null, note: string, r: VisualResult) {
  results.push(r);
  NOTE[name] = note;
  NOTE[`${name}:limit`] = limit === null ? '기록만' : `≤ ${(limit * 100).toFixed(1)}%`;
  if (limit !== null) expect(r.ratio, `${name} 차이 ${(r.ratio * 100).toFixed(2)}%`).toBeLessThanOrEqual(limit);
}
const cmp = (name: string, file: string, box: Box, png: Buffer, mine: Box = box) => compareRegion(name, file, box, png, mine, OUT);

async function open(page: Page, project: unknown) {
  await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
  const api = await fakeApi(page, { project: project as typeof NO_PROJECT });
  api.on('GET /api/settings/github', (route) => json(route, 200, GITHUB_OK));
  api.on('GET /api/system/resets', (route) => json(route, 200, { items: [] }));
  api.on('GET /api/alerts', (route) => json(route, 200, { items: [] }));
  api.on('GET /api/project/reset-preview', (route) => json(route, 200, PREVIEW));
  api.on('POST /api/project/repo-checks', (route) => json(route, 202, { id: 'rc-1' }));
  api.on('GET /api/project/repo-checks/rc-1', (route) => json(route, 200, { ...REPO_OK, commit: SHA1 }));
  await page.goto('/project');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return api;
}
async function shot(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1900, 1070);
  return page.screenshot({ animations: 'disabled', caret: 'hide' });
}
async function boxOf(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} 없음`);
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}

/** 원본 bootStep 메모(P L4509)와 같은 글자. 제품에서는 Runner가 보고한다. */
const NOTES: Record<string, string> = {
  check: 'verum-sdn/agent-wbs · main @ 2dec2a4 · md 3개',
  unzip: 'prototype/uiux/ HTML 3 · JS 4 · CSS 2 · 이미지 6 · prototype/docs/ md 3개 → 읽기 전용',
  repo: '~/agentwbs/repos/agent-wbs · main @ 2dec2a4 (초기화 기준)',
  codex: '화면 9 · 기능 41 분석 → Task 후보 12',
  claude: '설계 문서 확정 사항 18건 반영 → Task 후보 11',
  cross: '일치 9 · 이견 3 → 조정 (병합 1, 분리 1, 선행 관계 1)',
};
const withNotes = (s: ReturnType<typeof steps>) => s.map((x) => ({ ...x, note: x.status === 'done' ? NOTES[String(x.key)] ?? '' : '' })) as ReturnType<typeof steps>;
const TECH = [
  decision({ id: 'd1', tdKey: 'TD-01', title: '필수 사용', choice: 'PostgreSQL 16', authority: 'lead', level: 'must', status: 'fixed', reason: '프로젝트 등록 시 기술 제약 (필수)' }),
  decision({ id: 'd2', tdKey: 'TD-02', title: '필수 사용', choice: 'Redis 7', authority: 'lead', level: 'must', status: 'fixed', reason: '프로젝트 등록 시 기술 제약 (필수)' }),
];

test('UI-02A 프로젝트 등록(빈 입력)', async ({ page }) => {
  await open(page, NO_PROJECT);
  const png = await shot(page);
  const head = { x: 181, y: 65, width: 1100, height: 85 };
  record('UI-02A-header', 0.02, '같아야 함(제목·설명). 원본 오른쪽 「Mock: 원래 프로젝트로 돌아가기」는 영역 밖', cmp('UI-02A-header', 'desktop-clock20261105/UI-02A.png', head, png));
  const form = { x: 204, y: 153, width: 1008, height: 220 };
  record('UI-02A-form-top', 0.03, '같아야 함(등록 정보 제목·예시 값 링크·이름·저장소 칸·GitHub 인증 줄·안내)', cmp('UI-02A-form-top', 'desktop-clock20261105/UI-02A.png', form, png));
  const right = { x: 1224, y: 153, width: 672, height: 302 };
  record('UI-02A-right', 0.02, '같아야 함(등록 후 진행·초기화 기록 카드)', cmp('UI-02A-right', 'desktop-clock20261105/UI-02A.png', right, png));
  const whole = { x: 181, y: 65, width: 1739, height: 1015 };
  record('UI-02A-main', null, '기록만: 목표일 date 입력의 자리표시 글자가 브라우저 언어에 따라 다름(원본 mm/dd/yyyy, 시험 ko-KR 연도-월-일), Mock 버튼·안내(toast) 없음',
    cmp('UI-02A-main', 'desktop-clock20261105/UI-02A.png', whole, png));
});

test('UI-02A 예시 값 + 저장소 확인 결과', async ({ page }) => {
  await open(page, NO_PROJECT);
  await page.getByRole('button', { name: '예시 값 채우기' }).click();
  await page.getByRole('button', { name: '저장소 접근 확인' }).click();
  await expect(page.getByRole('table', { name: '필수 구조' })).toBeVisible();
  const png = await shot(page);
  const top = { x: 204, y: 153, width: 1008, height: 180 };
  record('UI-02A-reg-top', 0.03, '같아야 함(채운 이름·주소·인증 줄)', cmp('UI-02A-reg-top', 'desktop-clock20261105/UI-02A-reg.png', top, png));
  const whole = { x: 181, y: 65, width: 1739, height: 1015 };
  record('UI-02A-reg-main', null, '기록만: 구조 표 글자가 Runner 실제 보고값(파일 수·「있음」)이라 원본 고정 숫자(HTML 3 · JS 4…, MM-27)와 다름, date 자리표시',
    cmp('UI-02A-reg-main', 'desktop-clock20261105/UI-02A-reg.png', whole, png));
});

test('UI-02C 초기 분석 · 기술 결정 확정 대기', async ({ page }) => {
  await open(page, bootProject({ steps: withNotes(steps('tech')), decisions: [...TECH, decision({ id: 'd3', tdKey: 'TD-03', title: '조건부 선호', choice: 'QuestDB', authority: 'lead', level: 'cond', condition: '시계열 데이터(시간 순 대량 쓰기 · 구간 집계 · 보관 기간)가 있으면 사용', reason: '조건 충족 판단', alternatives: 'PostgreSQL 시간 파티션' })] }));
  const png = await shot(page);
  const head = { x: 181, y: 65, width: 1100, height: 85 };
  record('UI-02C-header', 0.02, '같아야 함(초기 분석 PL-000·입력·저장소 줄)', cmp('UI-02C-header', 'desktop-clock20261105/UI-02C.png', head, png));
  const stepsBox = await boxOf(page, 'ol.bsteps');
  const base = { x: 221, y: 206, width: stepsBox.width, height: 628 };
  record('UI-02C-steps', 0.03, '같아야 함(9단계 카드·번호·상태 칩·설명·메모)', cmp('UI-02C-steps', 'desktop-clock20261105/UI-02C.png', base, png, { ...stepsBox, height: 628 }));
  const whole = { x: 181, y: 65, width: 1739, height: 1015 };
  record('UI-02C-main', null, '기록만: 「Mock — 단계가 자동으로 진행됩니다」·「일시정지 (Mock)」 없음(Runner 보고로만 진행), 기술 결정 목록·Runner 보고 글자가 시험 데이터',
    cmp('UI-02C-main', 'desktop-clock20261105/UI-02C.png', whole, png));
});

test('UI-02D WBS 초안 · 승인 대기', async ({ page }) => {
  await open(page, bootProject({ steps: withNotes(steps('approve')), decisions: TECH, draft: true }));
  const png = await shot(page);
  const head = { x: 181, y: 65, width: 1100, height: 85 };
  record('UI-02D-header', 0.02, '같아야 함', cmp('UI-02D-header', 'desktop-clock20261105/UI-02D.png', head, png));
  const whole = { x: 181, y: 65, width: 1739, height: 1015 };
  record('UI-02D-main', null, '기록만: 초안 내용(Task 수 등)은 실제 초안(원본 11건 고정 아님, MM-27), 분할 점검의 상한 시간은 응답에 없어 뺌', cmp('UI-02D-main', 'desktop-clock20261105/UI-02D.png', whole, png));
});

test('UI-02E 입력 변경 감지', async ({ page }) => {
  const sha = (s: string) => s.padEnd(40, '0');
  await open(page, activeProject({
    repo: { url: 'https://github.com/verum-sdn/agent-wbs', owner: 'verum-sdn', name: 'agent-wbs', branch: 'main', baseCommit: sha('a1b2c3d') },
    registeredAt: '2026-10-27T00:40:00.000Z', instruction: 'GitHub 저장소의 prototype/uiux/ 와 prototype/docs/ 설계 문서를 분석하고 Task 식별을 시작하자.',
    inputs: [{ v: 1, at: '2026-10-27T00:40:00.000Z', commit: sha('a1b2c3d'), mdList: MD, changes: [], instruction: '', result: '초기 분석 PL-000 → 초기 WBS 11건 팀장 승인 (2026-10-27 10:20)', taskCount: 11 }],
    changeCommits: [
      { sha: sha('e7d41b0'), at: '2026-11-05T12:12:00.000Z', author: 'team-lead', message: '설계 문서: 보고서 메일 발송 요구사항 추가', state: 'pending', files: [{ path: 'prototype/docs/Agent-WBS-설계의도-및-구현가이드.md', change: 'modified', added: 42, deleted: 3 }] },
      { sha: sha('9c03f2e'), at: '2026-11-05T12:40:00.000Z', author: 'team-lead', message: 'prototype: 설정 화면 탭 구성 · 보고서 메일 탭', state: 'pending', files: [
        { path: 'prototype/uiux/settings.html', change: 'modified', added: 118, deleted: 64 }, { path: 'prototype/uiux/js/settings.js', change: 'modified', added: 86, deleted: 12 }, { path: 'prototype/uiux/mail-preview.html', change: 'added', added: 74, deleted: 0 }] },
    ] as never,
    inputHead: sha('9c03f2e'),
  }));
  const png = await shot(page);
  const head = { x: 181, y: 65, width: 1100, height: 85 };
  record('UI-02E-header', 0.02, '같아야 함(제목·설명). 원본 오른쪽 Mock 버튼은 영역 밖', cmp('UI-02E-header', 'desktop-clock20261105/UI-02E.png', head, png));
  const kv = { x: 204, y: 153, width: 1692, height: 190 };
  record('UI-02E-repo', null, '기록만: 「Mock: 새 커밋 push」 없음, 「지금 확인」은 있음(M3 통합: checkInputs), Runner clone 경로는 응답에 없어 뺌', cmp('UI-02E-repo', 'desktop-clock20261105/UI-02E.png', kv, png));
  const whole = { x: 181, y: 65, width: 1739, height: 1015 };
  record('UI-02E-main', null, '기록만: 파일 영역은 prototype/docs/ 기준으로 바로잡음(원본은 설계 문서를 「프로토타입」으로 잘못 분류, MM-04), 확인 시각은 응답에 없어 문구만, 버전 표 「커밋 메시지」 열은 응답에 없어 「팀장 지시」',
    cmp('UI-02E-main', 'desktop-clock20261105/UI-02E.png', whole, png));
});

test('MOD-05 프로젝트 초기화 창', async ({ page }) => {
  await open(page, activeProject());
  await page.getByRole('button', { name: '프로젝트 초기화…' }).click();
  await expect(page.getByTestId('reset-counts')).toBeVisible();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  const modal = await boxOf(page, '.modal');
  const png = await shot(page);
  const base = { x: 550, y: 183, width: 820, height: 714 };
  record('MOD-05-modal', null, `창 위치·크기: 원본 820×714 @ (550,183), 구현 ${String(modal.width)}×${String(modal.height)} @ (${String(modal.x)},${String(modal.y)})`, cmp('MOD-05-modal', 'desktop/MOD-05.png', base, png, modal));
  const header = { x: 550, y: 183, width: 820, height: 160 };
  record('MOD-05-top', 0.04, '같아야 함(제목·닫기·위험 안내 배너)', cmp('MOD-05-top', 'desktop/MOD-05.png', header, png, { x: modal.x, y: modal.y, width: 820, height: 160 }));
});

test.afterAll(() => { writeSummary(results, NOTE, OUT); });
