/**
 * Task 생성 Wizard(MOD-06) — 시나리오 1의 「Task 생성 Wizard」 부분, UAT-WIZ-01·02·04.
 * (시나리오 1의 「상세 명세 작성 → 읽기/편집 전환」은 Task 상세(M3-03)의 작업 명세 탭이다. 여기서는 생성 뒤 그 탭 주소로 여는 것까지 확인한다.)
 */
import { expect, test, type Page } from '@playwright/test';
import { fillPin } from './support/pin.ts';
import { errorBody, json, SESSION } from './support/fake-api.ts';
import { wbsApi } from './support/wbs-api.ts';
import { PROJECT_ID } from './support/wbs-fixture.ts';

const wiz = (page: Page) => page.getByRole('dialog', { name: 'Task 생성' });
const open = async (page: Page) => {
  await page.goto('/wbs');
  await page.locator('.page-h').getByRole('button', { name: 'Task 생성' }).click();
  await expect(wiz(page)).toBeVisible();
};

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1920, height: 1080 }); });

test('시나리오 1: 3단계 Wizard로 Task를 만들고, 선행(FS)을 붙이고, 새 Task 상세(작업 명세 탭 주소)를 연다', async ({ page }) => {
  const api = await wbsApi(page);
  await open(page);
  const w = wiz(page);
  await expect(w.locator('.steps li.cur')).toHaveText('1기본 정보 · 분류');
  await w.getByLabel('Task 제목').fill('Task 목록 조회 API 페이지네이션');
  await w.getByLabel('상위 Work Package').selectOption({ label: '2.1 Task API' });
  await w.getByRole('group', { name: '작업 유형' }).getByRole('button', { name: /구현/ }).click();
  await w.getByRole('group', { name: '주 기술 영역' }).getByRole('button', { name: /^BE/ }).click();
  await w.getByRole('group', { name: '관련 기술 영역' }).getByRole('button', { name: 'API', exact: true }).click();
  await w.getByLabel('우선순위').selectOption('1');
  await w.getByRole('button', { name: '다음' }).click();
  await expect(w.locator('.steps li.cur')).toHaveText('2목적 · 범위 · 완료 조건');
  await expect(w.locator('.steps li.done')).toHaveCount(1);
  await w.getByLabel('작업 목적').fill('Task 목록을 페이지 단위로 조회한다');
  await w.getByLabel('작업 범위').fill('cursor 기반 페이지\n정렬 유지');
  await w.getByLabel('완료 조건').fill('200건 목록을 50건씩 조회할 수 있다');
  await w.getByRole('button', { name: '다음' }).click();
  await expect(w.locator('.steps li.cur')).toHaveText('3선행 Task · 확인');
  await w.getByRole('group', { name: '선행 Task' }).locator('label').filter({ hasText: 'TASK-0005' }).getByRole('checkbox').check();
  await expect(w).toContainText('선택한 선행 Task 중 미완료가 있어 생성 직후 실행 차단 상태가 됩니다.');
  await expect(w.locator('.kv')).toContainText('Work Package2.1 Task API');
  await expect(w.locator('.kv')).toContainText('AgentClaude → Codex');
  await expect(w.locator('.kv')).toContainText('선행 TaskTASK-0005');
  await expect(w.locator('.kv')).toContainText('BE / API 설계');
  await w.getByRole('button', { name: 'Task 생성', exact: true }).click();

  await expect(wiz(page)).toHaveCount(0);
  await expect(page).toHaveURL('/wbs/TASK-0013?tab=spec');
  await expect(page.locator('.notice')).toContainText('TASK-0013 「Task 목록 조회 API 페이지네이션」을(를) 생성했습니다. 작업 명세를 작성하세요.');
  await expect(page.getByRole('region', { name: 'Task 상세' }).getByRole('heading', { level: 2 })).toHaveText('Task 목록 조회 API 페이지네이션');

  const create = api.requests(`POST /api/projects/${PROJECT_ID}/tasks`);
  expect(create).toHaveLength(1);
  expect(create[0]?.postDataJSON()).toEqual({
    title: 'Task 목록 조회 API 페이지네이션', wbsNodeId: 'WP-03', workType: 'Implementation', primaryDomain: 'BE', relatedDomains: ['API'],
    priority: 1, assigneeAgent: 'Claude', verifierAgent: 'Codex',
    overview: { purpose: 'Task 목록을 페이지 단위로 조회한다', background: '', scope: ['cursor 기반 페이지', '정렬 유지'], out: [], precond: '', doneCond: '200건 목록을 50건씩 조회할 수 있다' },
    // M3 통합: 서버가 받게 된 예상 소요 시간(기본 4)·고정 시작일(빈칸 → null)
    estimate: { estHours: 4 }, fixStart: null,
  });
  expect(create[0]?.headers()['idempotency-key']).toBeTruthy();
  const dep = api.requests('POST /api/tasks/TASK-0013/dependencies');
  expect(dep.map((r) => r.postDataJSON() as { predTaskKey: string; depType: string })).toEqual([expect.objectContaining({ predTaskKey: 'TASK-0005', depType: 'FS' })]);
  // 새 Task가 표(트리)에 자리 잡는다.
  await page.getByRole('button', { name: '펼치기', exact: true }).click();
  await expect(page.getByRole('table', { name: 'WBS Task 목록' }).locator('.trow.task').filter({ has: page.locator('.td.tcell > .tid', { hasText: 'TASK-0013' }) })).toContainText('2.1.3');
});

test('UAT-WIZ-01 단계별 필수값·시간 0/400 초과·날짜 형식 오류는 다음을 막고, 이전으로 가도 입력을 보존한다', async ({ page }) => {
  await wbsApi(page);
  await open(page);
  const w = wiz(page);
  await w.getByLabel('예상 소요 시간').fill('0');
  await w.getByLabel('고정 시작일').fill('2026/11/05');
  await w.getByRole('button', { name: '다음' }).click();
  await expect(w.locator('.steps li.cur')).toHaveText('1기본 정보 · 분류');
  await expect(w).toContainText('제목을 입력하세요.');
  await expect(w).toContainText('작업 유형을 하나 선택하세요.');
  await expect(w).toContainText('주 기술 영역을 선택하세요.');
  await expect(w).toContainText('0보다 크고 400 이하인 숫자를 입력하세요.');
  await expect(w).toContainText('YYYY-MM-DD 형식으로 입력하세요.');
  await expect(w.locator('.modal-f .ferr')).toHaveText('필수 항목을 입력하세요: 제목, 작업 유형, 주 기술 영역, 예상 소요 시간(숫자), 고정 시작일 형식');
  await expect(w.getByLabel('Task 제목')).toHaveClass(/bad/);

  await w.getByLabel('Task 제목').fill('검증 시험');
  await w.getByRole('group', { name: '작업 유형' }).getByRole('button', { name: /테스트/ }).click();
  await w.getByRole('group', { name: '주 기술 영역' }).getByRole('button', { name: /^QA/ }).click();
  await w.getByLabel('예상 소요 시간').fill('400.5');
  await w.getByLabel('고정 시작일').fill('2026-11-05');
  await w.getByRole('button', { name: '다음' }).click();
  await expect(w.locator('.modal-f .ferr')).toHaveText('필수 항목을 입력하세요: 예상 소요 시간(숫자)');
  await w.getByLabel('예상 소요 시간').fill('400');
  await w.getByRole('button', { name: '다음' }).click();

  await expect(w.locator('.steps li.cur')).toHaveText('2목적 · 범위 · 완료 조건');
  await w.getByRole('button', { name: '다음' }).click();
  await expect(w).toContainText('작업 목적을 입력하세요.');
  await expect(w).toContainText('완료 조건을 입력하세요.');
  await w.getByLabel('작업 목적').fill('목적');

  // 이전 단계로 가도 입력 보존
  await w.getByRole('button', { name: '이전' }).click();
  await expect(w.getByLabel('Task 제목')).toHaveValue('검증 시험');
  await expect(w.getByLabel('예상 소요 시간')).toHaveValue('400');
  await expect(w.getByRole('group', { name: '작업 유형' }).getByRole('button', { name: /테스트/ })).toHaveAttribute('aria-pressed', 'true');
  await w.getByRole('button', { name: '다음' }).click();
  await expect(w.getByLabel('작업 목적')).toHaveValue('목적');
  await expect(w.locator('.ferr').filter({ hasText: '작업 목적을 입력하세요.' })).toHaveCount(0);
});

test('UAT-WIZ-02 Work Package는 서버의 실제 목록만 고르고, 그 사이 지워진 WP는 서버가 4xx로 거부해 부분 생성·화면 오류가 없다', async ({ page }) => {
  const api = await wbsApi(page);
  // 현재 목록에 WP-06(3.2 Runner 연동)이 없다.
  api.list.nodes = api.list.nodes.filter((n) => n.id !== 'WP-06');
  api.list.tasks = api.list.tasks.filter((t) => t.wbsNodeId !== 'WP-06');
  await open(page);
  const w = wiz(page);
  const options = await w.getByLabel('상위 Work Package').locator('option').allTextContents();
  expect(options).toEqual(['1.1 개발 환경', '1.2 데이터 모델', '2.1 Task API', '2.2 WBS UI', '3.1 Planning · Gate']);

  // 고른 뒤 서버에서 WP가 지워졌다면 → 404 WBS_NODE_NOT_FOUND
  await w.getByLabel('Task 제목').fill('지워진 WP');
  await w.getByLabel('상위 Work Package').selectOption({ label: '3.1 Planning · Gate' });
  await w.getByRole('group', { name: '작업 유형' }).getByRole('button', { name: /설계/ }).click();
  await w.getByRole('group', { name: '주 기술 영역' }).getByRole('button', { name: /^API/ }).click();
  await w.getByRole('button', { name: '다음' }).click();
  await w.getByLabel('작업 목적').fill('p');
  await w.getByLabel('완료 조건').fill('d');
  await w.getByRole('button', { name: '다음' }).click();
  api.on(`POST /api/projects/${PROJECT_ID}/tasks`, (route) => json(route, 404, errorBody('WBS_NODE_NOT_FOUND', { message: '상위 Work Package를 찾을 수 없습니다.', fix: '목록을 다시 불러와 실제 Work Package를 고르세요.' })));
  const before = api.calls().filter((c) => c.startsWith(`GET /api/projects/${PROJECT_ID}/tasks`)).length;
  await w.getByRole('button', { name: 'Task 생성', exact: true }).click();
  const bar = page.getByRole('alert').filter({ hasText: 'Task를 생성하지 못했습니다' });
  await expect(bar).toContainText('WBS_NODE_NOT_FOUND');
  await expect(bar.getByRole('button', { name: '다시 시도' })).toHaveCount(0);
  // 입력은 남고, 화면 전체 오류 없이 목록을 다시 읽는다. 부분 생성(선행 추가 등)도 없다.
  await expect(wiz(page)).toBeVisible();
  await expect(w.locator('.kv')).toContainText('지워진 WP');
  await expect.poll(() => api.calls().filter((c) => c.startsWith(`GET /api/projects/${PROJECT_ID}/tasks`)).length).toBeGreaterThan(before);
  expect(api.calls().filter((c) => c.includes('/dependencies'))).toEqual([]);
  expect(api.list.tasks).toHaveLength(11);
});

test('UAT-WIZ-04 입력 뒤 닫기: 확인창의 취소는 입력 유지, 「생성 취소」만 초안을 버리고 Task를 만들지 않는다', async ({ page }) => {
  const api = await wbsApi(page);
  await open(page);
  const w = wiz(page);
  // 빈 상태면 묻지 않고 닫힌다.
  await w.getByRole('button', { name: 'Task 생성 닫기' }).click();
  await expect(wiz(page)).toHaveCount(0);

  await page.locator('.page-h').getByRole('button', { name: 'Task 생성' }).click();
  await w.getByLabel('Task 제목').fill('초안 제목');
  await w.getByRole('button', { name: '취소' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Task 생성 취소' });
  await expect(confirm).toContainText('입력한 내용이 저장되지 않습니다. 생성을 취소할까요?');
  await confirm.getByRole('button', { name: '취소', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(w.getByLabel('Task 제목')).toHaveValue('초안 제목');

  // Esc도 같은 확인을 거친다. 확인창의 Esc는 확인창만 닫는다.
  await w.getByLabel('Task 제목').press('Escape');
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(w.getByLabel('Task 제목')).toHaveValue('초안 제목');

  await w.getByRole('button', { name: 'Task 생성 닫기' }).click();
  await confirm.getByRole('button', { name: '생성 취소' }).click();
  await expect(wiz(page)).toHaveCount(0);
  expect(api.requests(`POST /api/projects/${PROJECT_ID}/tasks`)).toHaveLength(0);
  // 다시 열면 빈 초안
  await page.locator('.page-h').getByRole('button', { name: 'Task 생성' }).click();
  await expect(w.getByLabel('Task 제목')).toHaveValue('');
});

test('세션이 끊기면 Wizard 초안을 이 탭에 보관하고, 다시 로그인하면 WBS 화면에서 복원을 제안한다(M3-01 useSessionDraft)', async ({ page }) => {
  const api = await wbsApi(page);
  let signedIn = true;
  api.on('GET /api/session', (route) => (signedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  api.on('POST /api/auth/session', (route) => { signedIn = true; return route.fulfill({ status: 204 }); });
  api.on(`POST /api/projects/${PROJECT_ID}/tasks`, (route) => { signedIn = false; return json(route, 401, errorBody('LEAD_UNAUTHORIZED')); });
  await open(page);
  const w = wiz(page);
  await w.getByLabel('Task 제목').fill('만료 전에 쓴 Task');
  await w.getByRole('group', { name: '작업 유형' }).getByRole('button', { name: /분석/ }).click();
  await w.getByRole('group', { name: '주 기술 영역' }).getByRole('button', { name: /^DB/ }).click();
  await w.getByRole('button', { name: '다음' }).click();
  await w.getByLabel('작업 목적').fill('보관할 목적');
  await w.getByLabel('완료 조건').fill('보관할 완료 조건');
  await w.getByRole('button', { name: '다음' }).click();
  await w.getByRole('button', { name: 'Task 생성', exact: true }).click();
  await expect(page).toHaveURL('/login?next=%2Fwbs');
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('awbs.draft:')))).toEqual(['awbs.draft:wbs:task-create']);

  await fillPin(page, '261128');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL('/wbs');
  const offer = page.getByRole('region', { name: 'Task 생성 「만료 전에 쓴 Task」 — 저장하지 못한 초안' });
  await offer.getByRole('button', { name: '복원' }).click();
  await expect(w).toBeVisible();
  await expect(w.getByLabel('Task 제목')).toHaveValue('만료 전에 쓴 Task');
  await w.getByRole('button', { name: '다음' }).click();
  await expect(w.getByLabel('작업 목적')).toHaveValue('보관할 목적');
});
