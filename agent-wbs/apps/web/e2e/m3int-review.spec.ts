/**
 * M3 통합 교차 리뷰(m3-integration-review/REPORT.md) 지적 1~4의 회귀 시험. 고치기 전에 먼저 실패를 확인했다.
 * 1. Task 상세에서 연 생성 창의 입력이 뒤로 가기로 사라진다(보호기 두 개가 겹침).
 * 2. 프로젝트의 Agent 참여·계획 변경·WBS 구조 카드가 없다(UAT-PROJECT-11, 원본 P L2062–2082).
 * 3. 「← 원래 Task로 돌아가기」가 탭 이력을 한 칸 되돌린다.
 * 4. CP 제외 충돌에서 이미 사라진 항목의 이유를 창에 보이지 않는다.
 */
import { expect, test } from '@playwright/test';
import { errorBody, fakeApi, json } from './support/fake-api.ts';
import { CP2, planningServer, type Proposal } from './support/planning-data.ts';
import { activeProject, GITHUB_OK, PROJECT_ID } from './support/project-fixtures.ts';
import { mountTasks } from './support/task-api.ts';
import { wbsApi } from './support/wbs-api.ts';
import { NODES, TASKS } from './support/wbs-fixture.ts';

test('지적 1: Task 상세가 열린 WBS에서 생성 창에 입력한 뒤 뒤로 가기를 누르면 확인을 묻고, 취소하면 입력이 남는다', async ({ page }) => {
  await wbsApi(page);
  await page.goto('/wbs');
  await page.getByRole('table', { name: 'WBS Task 목록' }).getByRole('button', { name: 'Drizzle Schema 설계' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0004');
  await page.locator('.page-h').getByRole('button', { name: 'Task 생성' }).click();
  const wiz = page.getByRole('dialog', { name: 'Task 생성' });
  await wiz.getByLabel('제목').fill('지키는 제목');
  await page.goBack();
  const confirm = page.getByRole('alertdialog', { name: '편집 내용 버리기' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '취소' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0004');
  await expect(wiz.getByLabel('제목')).toHaveValue('지키는 제목');
});

test('지적 1: 상세 편집 중 메뉴 이동도 한 번만 묻는다(보호기 하나)', async ({ page }) => {
  const api = await fakeApi(page);
  mountTasks(api);
  await page.goto('/wbs/TASK-0007');
  await page.getByRole('button', { name: '개요 편집' }).click();
  await page.locator('#ov-title').fill('바꾸는 중');
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '대시보드', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: '편집 내용 버리기' })).toHaveCount(1);
  await page.getByRole('alertdialog').getByRole('button', { name: '취소' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0007');
  await expect(page.locator('#ov-title')).toHaveValue('바꾸는 중');
});

test('지적 2 · UAT-PROJECT-11: 프로젝트의 Agent 참여·계획 변경·WBS 구조 카드와 이동', async ({ page }) => {
  const api = await fakeApi(page, { project: activeProject() as never });
  planningServer(api);
  api.on('GET /api/settings/github', (route) => json(route, 200, GITHUB_OK));
  api.on('GET /api/alerts', (route) => json(route, 200, { items: [] }));
  api.on('GET /api/system/resets', (route) => json(route, 200, { items: [] }));
  api.on(`GET /api/projects/${PROJECT_ID}/tasks`, (route) => json(route, 200, { nodes: NODES, tasks: TASKS }));
  await page.goto('/project');
  const agents = page.getByRole('region', { name: 'Agent 참여 현황' });
  await expect(agents.getByRole('row')).toHaveCount(3); // 머리 + Claude + Codex
  const claudeDev = TASKS.filter((t) => t.assigneeAgent === 'Claude' && !t.deletedAt && String(t.lifecycleStatus) !== 'cancelled').length;
  await expect(agents.getByRole('row', { name: /Claude/ })).toContainText(String(claudeDev));
  const plan = page.getByRole('region', { name: '계획 변경' });
  await expect(plan.getByRole('link', { name: /이견 조정이 필요한 Planning/ })).toHaveAttribute('href', '/planning');
  await expect(plan.getByRole('link', { name: /승인 · 반영 대기 Change Proposal/ })).toHaveAttribute('href', '/change');
  const wbs = page.getByRole('region', { name: 'WBS 구조' });
  await expect(wbs.getByRole('row')).toHaveCount(1 + NODES.length);
  await wbs.getByRole('link', { name: 'Core WBS' }).click();
  await expect(page).toHaveURL('/wbs?phase=PH-2');
  // 받는 WBS 화면이 phase 필터를 적용하는지는 nav-integration(WBS 시험 자료)에서 확인한다.
});

test('지적 3: 참조 링크로 옮긴 뒤 탭을 바꿔도 「돌아가기」는 원래 Task로 간다(탭 유지)', async ({ page }) => {
  const api = await fakeApi(page);
  mountTasks(api);
  await page.goto('/wbs/TASK-0006');
  await page.locator('.dt-head .banner.danger').getByRole('button', { name: 'TASK-0005' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0005');
  await page.getByRole('tab', { name: /^작업 명세/ }).click();
  await expect(page).toHaveURL('/wbs/TASK-0005?tab=spec');
  await page.getByRole('button', { name: '← TASK-0006로 돌아가기' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0006?tab=spec');
  await expect(page.getByRole('region', { name: 'Task 상세' }).locator('.idchip')).toHaveText('TASK-0006');
  await expect(page.getByRole('button', { name: /돌아가기/ })).toHaveCount(0);
});

test('지적 4: CP 제외 충돌의 「다시 적용」에서 그 항목이 이미 없으면 창 안에 이유를 보이고, 최신 불러오기로 회복한다', async ({ page }) => {
  const api = await fakeApi(page);
  const changes = { ...CP2, status: 'changes' } as Proposal;
  const server = planningServer(api, { proposals: [changes] });
  await page.goto('/change/CP-002');
  await expect(page.getByRole('region', { name: '변경 전 / 후 비교' }).getByRole('button', { name: /제외/ })).toHaveCount(2);
  // 다른 창이 같은 항목(2번째)을 먼저 제외했다
  const latest = { ...changes, ops: changes.ops.slice(0, 1), updatedAt: '2026-11-05T12:00:00.000Z' } as Proposal;
  server.state.proposals = [latest];
  api.on(`POST /api/proposals/${CP2.id}/exclude`, (route) => json(route, 409, errorBody('VERSION_CONFLICT', { message: '다른 곳에서 먼저 바뀌었습니다.', details: { changes: [] } })));
  await page.getByRole('region', { name: '변경 전 / 후 비교' }).getByRole('button', { name: /제외/ }).nth(1).click();
  const modal = page.getByRole('alertdialog');
  await expect(modal).toContainText('VERSION_CONFLICT');
  await modal.getByRole('button', { name: /다시 적용/ }).click();
  await expect(modal).toContainText('제외하려던 항목이 최신 변경 제안에 없습니다');
  expect(api.requests(`POST /api/proposals/${CP2.id}/exclude`)).toHaveLength(1);
  await modal.getByRole('button', { name: /최신 내용 불러오기/ }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('region', { name: '변경 전 / 후 비교' }).getByRole('button', { name: /제외/ })).toHaveCount(1);
});
