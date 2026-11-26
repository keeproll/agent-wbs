/**
 * UI-02B 초기 분석 · UI-02C 기술 결정 확정 · UI-02D WBS 초안 승인 — 시나리오 29, UAT-PROJECT-06·07, UAT-PROJECT-UI b·c.
 */
import { expect, test, type Page } from '@playwright/test';
import { errorBody, fakeApi, json, RUNNER, type FakeApi } from './support/fake-api.ts';
import { activeProject, bootProject, DECISIONS, PREVIEW, PROJECT_ID, steps, T0 } from './support/project-fixtures.ts';

async function openBoot(page: Page, project: ReturnType<typeof bootProject>): Promise<FakeApi> {
  const api = await fakeApi(page, { project });
  api.on('GET /api/project/reset-preview', (route) => json(route, 200, PREVIEW));
  await page.goto('/project');
  await expect(page.getByRole('heading', { name: /초기 분석/, level: 1 })).toBeVisible();
  return api;
}
const step = (page: Page, key: string) => page.locator(`[data-step="${key}"]`);

test('UAT-PROJECT-UI b: 단계 wait/run/done·보고 로그를 보이고, 시간이 지나도 보고 없이는 넘어가지 않는다', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
  await openBoot(page, bootProject({ steps: steps('codex'), logs: [{ at: T0, text: 'Codex 독립 분석 시작' }] }));
  await expect(step(page, 'repo')).toContainText('완료');
  await expect(step(page, 'codex')).toContainText('진행 중');
  await expect(step(page, 'claude')).toContainText('대기');
  await expect(page.getByText('Codex 독립 분석 시작')).toBeVisible();
  await expect(page.getByText('입력 prototype/ (uiux · docs) (md 3개) @ 2dec2a4 · 저장소 verum-sdn/agent-wbs (main @ 2dec2a4)')).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(step(page, 'codex')).toContainText('진행 중');
  await expect(page.getByRole('button', { name: /일시정지/ })).toHaveCount(0);
});

test('Runner 끊김이면 멈춤 안내, 단계 실패는 원인·조치와 「다시 시도」(실패 단계 요청)', async ({ page }) => {
  const api = await fakeApi(page, { project: bootProject({ steps: steps('unzip', 'fail'), fail: { reason: 'Git LFS 파일 checkout 실패 — Runner에 git-lfs가 없습니다', fix: 'Runner PC에 git-lfs를 설치한 뒤 다시 시도하세요.' } }) });
  api.on('GET /api/runner-state', (route) => json(route, 200, { ...RUNNER, connection: { ...RUNNER.connection, online: false } }));
  await page.goto('/project');
  await expect(page.getByText('Runner 연결이 끊겨 초기 분석이 멈춰 있습니다 — 다시 연결되면 이어서 진행합니다.')).toBeVisible();
  const fail = page.getByTestId('boot-fail');
  await expect(fail).toContainText('입력 자료 checkout 실패 — Git LFS 파일 checkout 실패 — Runner에 git-lfs가 없습니다');
  await expect(fail).toContainText('Runner PC에 git-lfs를 설치한 뒤 다시 시도하세요.');
  await expect(step(page, 'unzip')).toContainText('실패');
  api.on('POST /api/project/bootstrap/retry', (route) => json(route, 202, { jobId: 'j2' }));
  await fail.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByText('실패한 단계부터 다시 시도합니다.')).toBeVisible();
  expect(api.requests('POST /api/project/bootstrap/retry')[0]?.postDataJSON()).toEqual({ revision: null, runNo: 1 });
});

test('UAT-PROJECT-UI c: 「등록 취소 (초기화)」는 초기화 확인 창을 열고, 취소하면 분석을 그대로 둔다', async ({ page }) => {
  const api = await openBoot(page, bootProject({ steps: steps('claude') }));
  await page.getByRole('button', { name: '등록 취소 (초기화)' }).click();
  const dialog = page.getByRole('dialog', { name: /프로젝트 초기화/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /초기 분석/, level: 1 })).toBeVisible();
  expect(api.requests('POST /api/project/reset')).toHaveLength(0);
});

test('시나리오 29 · UAT-PROJECT-06 a: 기술 결정 확정 대기 — 미결이면 확정 거부, 모두 정하면 결정 id·버전으로 확정', async ({ page }) => {
  const api = await openBoot(page, bootProject({ steps: steps('tech'), decisions: DECISIONS }));
  const panel = page.getByRole('region', { name: '기술 결정 확정' });
  await expect(panel.getByText('팀장 확인 대기')).toBeVisible();
  await expect(step(page, 'tech')).toContainText('진행 중');
  // 팀장 지정(필수)은 고를 수 없고, 조건부 선호의 조건 판단과 Agent 제안은 근거·대안과 함께 고른다.
  await expect(panel.locator('[data-td="TD-01"]')).toContainText('확정');
  await expect(panel.locator('[data-td="TD-01"]').getByRole('button', { name: '승인' })).toHaveCount(0);
  await expect(panel.locator('[data-td="TD-03"]')).toContainText('조건 시계열 데이터가 있으면 사용');
  await expect(panel.locator('[data-td="TD-05"]')).toContainText('대안 WebSocket — 양방향이 필요 없음');
  await expect(panel.getByText('아직 정하지 않은 Agent 제안 2건')).toBeVisible();

  await panel.locator('[data-td="TD-05"]').getByRole('button', { name: '승인' }).click();
  await panel.getByRole('button', { name: '기술 결정 확정' }).click();
  await expect(page.getByTestId('tech-err')).toHaveText('승인 · 반려를 정하지 않은 제안이 있습니다. 모든 「Agent 제안」 항목을 정한 뒤 확정하세요.');
  expect(api.requests('POST /api/projects/' + PROJECT_ID + '/boot/tech/confirm')).toHaveLength(0);

  await panel.locator('[data-td="TD-03"]').getByRole('button', { name: '반려' }).click();
  await expect(panel.locator('[data-td="TD-03"]')).toHaveClass(/off/);
  await expect(panel.getByText('모두 정했습니다 — 확정하면 WBS 초안 작성을 시작합니다.')).toBeVisible();
  api.on(`POST /api/projects/${PROJECT_ID}/boot/tech/confirm`, (route) => {
    api.on('GET /api/project', (r) => json(r, 200, bootProject({ steps: steps('draft'), decisions: DECISIONS.map((d) => ({ ...d, status: d.id === 'd3' ? 'rejected' : d.id === 'd5' ? 'approved' : d.status })) })));
    return json(route, 200, { decisions: [] });
  });
  await panel.getByRole('button', { name: '기술 결정 확정' }).click();
  await expect(page.getByText('기술 결정을 확정했습니다. 이 결정을 기준으로 WBS 초안을 작성합니다.')).toBeVisible();
  await expect(step(page, 'draft')).toContainText('진행 중');
  await expect(panel.getByText('확정됨')).toBeVisible();
  expect(api.requests(`POST /api/projects/${PROJECT_ID}/boot/tech/confirm`)[0]?.postDataJSON()).toEqual({
    decisions: [{ id: 'd3', choice: 'reject', updatedAt: DECISIONS[1]?.updatedAt }, { id: 'd5', choice: 'approve', updatedAt: DECISIONS[2]?.updatedAt }],
  });
});

test('서버가 DECISIONS_PENDING으로 거부하면 이유를 보이고 다시 읽는다', async ({ page }) => {
  const api = await openBoot(page, bootProject({ steps: steps('tech'), decisions: DECISIONS }));
  const panel = page.getByRole('region', { name: '기술 결정 확정' });
  await panel.locator('[data-td="TD-03"]').getByRole('button', { name: '승인' }).click();
  await panel.locator('[data-td="TD-05"]').getByRole('button', { name: '승인' }).click();
  api.on(`POST /api/projects/${PROJECT_ID}/boot/tech/confirm`, (route) => json(route, 409, errorBody('DECISIONS_PENDING', { message: '정하지 않은 결정이 있습니다: TD-06', fix: '모든 제안을 승인 또는 반려하세요.' })));
  await panel.getByRole('button', { name: '기술 결정 확정' }).click();
  await expect(page.getByRole('alert')).toContainText('409 DECISIONS_PENDING');
  await expect(page.getByRole('alert')).toContainText('정하지 않은 결정이 있습니다: TD-06');
});

test('UAT-PROJECT-07: 재분석은 지시와 본 초안 revision을 보내고, 확정 기술 결정은 유지된다', async ({ page }) => {
  const done = DECISIONS.map((d) => ({ ...d, status: d.status === 'pending' ? 'approved' : d.status }));
  const api = await openBoot(page, bootProject({ steps: steps('approve'), decisions: done, draft: true, revision: 2 }));
  await expect(page.getByText('Phase 2 · Work Package 2 · Task 3 · 의존성 2 · 예상 작업량 12.5h (Agent 실행 시간)')).toBeVisible();
  const tree = page.getByRole('tree', { name: 'WBS 초안' });
  await expect(tree).toContainText('1.1.2 Task API');
  await expect(tree).toContainText('구현 / API · Claude 개발 · Codex 검증 · 4.5h (3h~7h) · 선행 1.1.1');
  await expect(page.getByText('분할 점검 — 통과 2 · 의심 1 · 위반 0')).toBeVisible();

  await page.getByRole('button', { name: '재분석 요청' }).click();
  await expect(page.getByText('재분석 지시를 적어 주세요.', { exact: false })).toBeVisible();
  api.on('POST /api/project/bootstrap/rerun', (route) => {
    api.on('GET /api/project', (r) => json(r, 200, bootProject({ steps: steps('codex'), decisions: done, runNo: 2 })));
    return json(route, 202, { jobId: 'j3' });
  });
  await page.getByLabel('재분석 지시').fill('메시지 기능을 별도 Work Package로 분리해줘');
  await page.getByRole('button', { name: '재분석 요청' }).click();
  await expect(page.getByText('재분석을 요청했습니다. Codex 독립 분석부터 다시 진행합니다.')).toBeVisible();
  expect(api.requests('POST /api/project/bootstrap/rerun')[0]?.postDataJSON()).toEqual({ revision: 2, instruction: '메시지 기능을 별도 Work Package로 분리해줘' });
  await expect(page.getByText('재분석 1회')).toBeVisible();
  await expect(page.locator('[data-td="TD-05"]')).toContainText('승인됨');
  await expect(page.getByText('분석이 끝나면 WBS 초안이 여기에 표시됩니다.')).toBeVisible();
});

test('승인 중 새 초안이 오면(409 충돌) 본 적 없는 초안을 자동 승인하지 않는다', async ({ page }) => {
  const api = await openBoot(page, bootProject({ steps: steps('approve'), draft: true, revision: 1 }));
  api.on('POST /api/project/bootstrap/approve', (route) => json(route, 409, errorBody('VERSION_CONFLICT', { details: { current: { revision: 2 }, changes: [] } })));
  await page.getByRole('button', { name: '초기 WBS 승인' }).click();
  const modal = page.getByRole('alertdialog');
  await expect(modal).toBeVisible();
  api.on('GET /api/project', (r) => json(r, 200, bootProject({ steps: steps('approve'), draft: true, revision: 2 })));
  await modal.getByRole('button', { name: '최신 내용에 내 변경 다시 적용' }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByText('새 초안을 불러왔습니다. 새 초안을 확인한 뒤 다시 진행하세요.')).toBeVisible();
  await expect(page.getByText('r2')).toBeVisible();
  expect(api.requests('POST /api/project/bootstrap/approve')).toHaveLength(1);
});

test('UAT-PROJECT-06 b: 초기 WBS 승인 → 기준 v1 안내 후 첫 Task 상세로 이동하고 잠금이 풀린다', async ({ page }) => {
  const api = await openBoot(page, bootProject({ steps: steps('approve'), draft: true, revision: 1 }));
  api.on('POST /api/project/bootstrap/approve', (route) => {
    api.on('GET /api/project', (r) => json(r, 200, activeProject()));
    return json(route, 200, { baselineVersion: 1, taskCount: 3 });
  });
  api.on(`GET /api/projects/${PROJECT_ID}/tasks`, (route) => json(route, 200, { nodes: [], tasks: [{ taskKey: 'TASK-0002' }, { taskKey: 'TASK-0001' }, { taskKey: 'TASK-0003' }] }));
  await page.getByRole('button', { name: '초기 WBS 승인' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0001');
  await expect(page.getByText('초기 WBS 3건을 승인했습니다. 기준 일정 v1이 만들어졌고, 선행 조건이 없는 Task부터 Runner가 실행할 수 있습니다.')).toBeVisible();
  expect(api.requests('POST /api/project/bootstrap/approve')[0]?.postDataJSON()).toEqual({ revision: 1 });
  await expect(page.getByRole('navigation').getByRole('link', { name: 'WBS', exact: true })).not.toHaveAttribute('aria-disabled');
});

test('승인 거부 409 SPLIT_JUDGEMENT_REQUIRED: 오류 막대로 이유를 보이고 다시 시도 버튼은 없다', async ({ page }) => {
  const api = await openBoot(page, bootProject({ steps: steps('approve'), draft: true, revision: 1 }));
  api.on('POST /api/project/bootstrap/approve', (route) => json(route, 409, errorBody('SPLIT_JUDGEMENT_REQUIRED', { message: '분할 판단이 끝나지 않은 Task가 있습니다.' })));
  await page.getByRole('button', { name: '초기 WBS 승인' }).click();
  const bar = page.getByRole('alert');
  await expect(bar).toContainText('승인하지 못했습니다');
  await expect(bar).toContainText('409 SPLIT_JUDGEMENT_REQUIRED');
  await expect(bar.getByRole('button', { name: '다시 시도' })).toHaveCount(0);
});

test('승인 500 → 같은 멱등 키로 다시 시도', async ({ page }) => {
  const api = await openBoot(page, bootProject({ steps: steps('approve'), draft: true, revision: 1 }));
  api.on('POST /api/project/bootstrap/approve', (route) => json(route, 500, errorBody('INTERNAL')));
  await page.getByRole('button', { name: '초기 WBS 승인' }).click();
  await expect(page.getByRole('alert')).toContainText('500 INTERNAL');
  api.on('POST /api/project/bootstrap/approve', (route) => {
    api.on('GET /api/project', (r) => json(r, 200, activeProject()));
    return json(route, 200, { baselineVersion: 1, taskCount: 3 });
  });
  api.on(`GET /api/projects/${PROJECT_ID}/tasks`, (route) => json(route, 200, { nodes: [], tasks: [{ taskKey: 'TASK-0001' }] }));
  await page.getByRole('alert').getByRole('button', { name: '다시 시도' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0001');
  const [a, b] = api.requests('POST /api/project/bootstrap/approve');
  expect(a?.headers()['idempotency-key']).toBe(b?.headers()['idempotency-key']);
});
