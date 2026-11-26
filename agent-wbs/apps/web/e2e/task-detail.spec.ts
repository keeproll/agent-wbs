/**
 * Task 상세 — 요약·9탭·이동(UAT-TASK-01, UAT-WBS-03 상세 부분, UAT-EMPTY-01, 시나리오 1 읽기).
 * 데이터는 원본 Mock(fixtures/prototype-mock.json)을 계약 모양으로 바꾼 가짜 서버다(support/task-api.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { fakeApi } from './support/fake-api.ts';
import { mountTasks, newStore, type TaskStore } from './support/task-api.ts';

async function open(page: Page, url: string, store?: TaskStore) {
  const api = await fakeApi(page);
  const s = mountTasks(api, store);
  await page.goto(url);
  return { api, s };
}
const summary = (page: Page) => page.locator('.summary');

test('UAT-TASK-01 요약: ID·WBS·제목·분류·담당→검증·우선순위·선행·체크·검증·Gate·일정·진척이 서버 값과 같고 상태는 색+글자', async ({ page }) => {
  await open(page, '/wbs/TASK-0004');
  const detail = page.getByRole('region', { name: 'Task 상세' });
  await expect(detail.getByRole('heading', { level: 2, name: 'Drizzle Schema 설계' })).toBeVisible();
  await expect(detail.locator('.dt-crumbs')).toContainText('WBS 1.2.2');
  await expect(detail.locator('.idchip')).toHaveText('TASK-0004');
  await expect(detail.locator('.dt-crumbs')).toContainText('Work Package 1.2 데이터 모델');
  const s = summary(page);
  await expect(s).toContainText('설계DB+BE');
  const st = s.locator('.st.s-qa');
  await expect(st).toHaveText('QA 진행');
  await expect(st).toHaveAttribute('title', /Verification: 검증 Agent QA 진행 중/);
  await expect(s).toContainText('ClClaude→CxCodex');
  await expect(s.locator('.pri.p0')).toHaveText('긴급');
  await expect(s).toContainText('모두 충족 (2건)');
  await expect(s).toContainText('3/5· 필수 1건 남음');
  await expect(s.locator('.vf.v-run')).toHaveText('검증 중');
  await expect(s.getByRole('button', { name: '미통과 2/5 ▾' })).toBeVisible();
  await expect(s).toContainText('일정 (예상 실행 4h)');
  await expect(s).toContainText('11-05 예상');
  await expect(s.locator('.sc.sc-ok')).toHaveText('진행 · 기준 일정');
  await expect(s).toContainText('65%');

  // 탭 9개와 건수(서버 값)
  const tabs = page.getByRole('tablist', { name: 'Task 상세 탭' }).getByRole('tab');
  await expect(tabs).toHaveText(['개요', '작업 명세13/13', '의존성3', '기술 설계1', '체크리스트3/5', '실행2', '검증·Evidence0', '이력3', '메시지0']);
  await expect(tabs.nth(4).locator('.tab-c')).toHaveClass(/alert/);

  // Gate 펼침: 5조건과 사유, 완료 처리 버튼은 미충족이라 꺼짐
  await s.getByRole('button', { name: '미통과 2/5 ▾' }).click();
  const gate = page.locator('.gate');
  await expect(gate.locator('.gate-r')).toHaveCount(5);
  await expect(gate).toContainText('필수 Checklist 완료FAIL필수 항목 1건 미완료');
  await expect(gate).toContainText('필요한 승인 완료PASS팀장 승인 완료');
  await expect(gate).toContainText('완료 불가 — 필수 항목 1건 미완료');
  await expect(gate.getByRole('button', { name: 'Task 완료 처리' })).toBeDisabled();
});

test('UAT-TASK-01 차단 배너: 미충족 선행 링크와 FS 사유, 링크는 선행 Task로 이동하고 「돌아가기」로 복귀(G§4.4 복귀 스택)', async ({ page }) => {
  await open(page, '/wbs/TASK-0006');
  const banner = page.locator('.dt-head .banner.danger');
  await expect(banner).toContainText('실행 차단 — 선행 조건이 충족되지 않아 Runner 실행 요청을 할 수 없습니다.');
  await expect(banner).toContainText('TASK-0005 Task CRUD API (실행 중, 완료 필요)');
  await expect(summary(page).locator('.blk')).toContainText('차단 1건');
  await banner.getByRole('button', { name: 'TASK-0005' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0005');
  await expect(page.getByRole('heading', { level: 2, name: 'Task CRUD API' })).toBeVisible();
  await page.getByRole('button', { name: '← TASK-0006로 돌아가기' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0006');
  await expect(page.getByRole('button', { name: /돌아가기/ })).toHaveCount(0);
});

test('UAT-WBS-03 상세: 260px 레일 순서로 위치·이전/다음, 검색으로 빠지면 「목록 밖」, 펼치기는 표(/wbs)로', async ({ page }) => {
  await open(page, '/wbs/TASK-0004');
  const rail = page.getByRole('complementary', { name: 'Task 목록' });
  await expect(rail).toHaveCSS('width', '260px');
  await expect(rail.locator('.side-i.on')).toContainText('TASK-0004');
  await expect(page.locator('.dt-acts')).toContainText('4 / 12');
  await page.getByRole('button', { name: '다음 Task' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0005');
  await expect(page.locator('.dt-acts')).toContainText('5 / 12');
  await page.keyboard.press('ArrowUp');
  await expect(page).toHaveURL('/wbs/TASK-0004');
  await rail.getByRole('button', { name: /TASK-0007/ }).click();
  await expect(page).toHaveURL('/wbs/TASK-0007');
  await rail.getByRole('searchbox').fill('Schema');
  await expect(page.locator('.dt-acts')).toContainText('목록 밖 (필터에 맞지 않음)');
  await rail.getByRole('button', { name: '펼치기' }).click();
  await expect(page).toHaveURL('/wbs');
});

test('탭은 주소(?tab=)에 남아 새로고침·공유해도 같은 탭이 열린다', async ({ page }) => {
  await open(page, '/wbs/TASK-0004?tab=spec');
  await expect(page.getByRole('tab', { name: /작업 명세/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { level: 3, name: '작업 명세' })).toBeVisible();
  await page.getByRole('tab', { name: /이력/ }).click();
  await expect(page).toHaveURL('/wbs/TASK-0004?tab=hist');
  await page.reload();
  await expect(page.getByRole('table', { name: '이력' })).toContainText('ATT-0004-1 완료 — Seed 스크립트 미제출');
});

test('9탭 읽기 내용: 개요·명세·의존성·설계·체크리스트·실행·검증·이력·메시지', async ({ page }) => {
  await open(page, '/wbs/TASK-0007');
  const body = page.locator('.dt-body');
  await expect(body.locator('.kv').first()).toContainText('상위 Work Package2.2 WBS UI');
  await expect(body).toContainText('실행 등급 (모델 · Effort)');
  for (const [tab, text] of [
    ['작업 명세', '6그룹'], ['의존성', '선행 Task'], ['기술 설계', 'FE 설계'], ['체크리스트', '항목 추가'],
    ['실행', 'Execution Attempt'], ['검증·Evidence', 'FAIL'], ['이력', '최신순'], ['메시지', '수신 확인'],
  ] as const) {
    await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    if (text === '6그룹') await expect(body.getByRole('group')).toHaveCount(6);
    else await expect(body).toContainText(text);
  }
  // 실행 탭: 시도·실제 모델·실패 사유·변경 파일
  await page.getByRole('tab', { name: /^실행/ }).click();
  await expect(body.getByRole('article').first()).toContainText('ATT-0007-1');
  // 메시지: 코드 블록·전달 상태
  await page.getByRole('tab', { name: /^메시지/ }).click();
  await expect(body.locator('pre.code').first()).toBeVisible();
  await expect(body).toContainText('Acknowledged · 수신 확인');
});

test('UAT-EMPTY-01 기록 없는 Task: 모든 탭을 열 수 있고 「기록 없음」 문구, 없는 수치를 만들지 않는다', async ({ page }) => {
  const store = newStore();
  await open(page, '/wbs/TASK-0012', store);
  const body = page.locator('.dt-body');
  await expect(page.getByRole('tablist', { name: 'Task 상세 탭' }).getByRole('tab')).toHaveText(['개요', /작업 명세\d+\/13/, /의존성\d+/, /기술 설계/, /체크리스트/, '실행0', '검증·Evidence0', /이력\d+/, '메시지0']);
  await expect(body).toContainText('아직 실행 기록이 없습니다.');
  await page.getByRole('tab', { name: /^실행/ }).click();
  await expect(body).toContainText('실행 기록이 없습니다.');
  await page.getByRole('tab', { name: /^검증·Evidence/ }).click();
  await expect(body).toContainText('검증 결과가 없습니다.');
  await page.getByRole('tab', { name: /^메시지/ }).click();
  await expect(body).toContainText('이 Task의 메시지가 없습니다.');
  // 이력 없는 Task
  store.hist = store.hist.filter((h: { task: string }) => h.task !== 'TASK-0012');
  await page.getByRole('tab', { name: /^이력/ }).click();
  await page.reload();
  await expect(page.getByRole('table', { name: '이력' })).toContainText('이 Task의 이력이 없습니다.');
});

test('없는 Task 주소: 404 TASK_NOT_FOUND 안내(취소·초기화 가능성)', async ({ page }) => {
  await open(page, '/wbs/TASK-0999');
  await expect(page.getByRole('alert')).toContainText('TASK-0999를 찾을 수 없습니다 404 TASK_NOT_FOUND — Change Proposal로 취소되었거나');
});
