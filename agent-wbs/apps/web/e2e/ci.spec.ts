/**
 * M7-05 빌드·통합 화면(UI-08) — 완료 조건 `W e2e -- ci`.
 * 가짜 API(support/ci-data.ts, 원본 CI_MOCK 값)로 UAT-CI-01·03·04·05·06, UAT-EMPTY-05, UAT-RESP-01·02, UAT-TG-09(CI 링크)를 판정한다.
 * UAT-TASK-10-CI는 ci-task-ref.spec.ts, 시각 비교는 ci-visual.spec.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { errorBody, fakeApi, json, SESSION, type FakeApi } from './support/fake-api.ts';
import { baselineQueueItem, baselineRun, ciData, guardRun, installCi, mismatchItem, type CiData } from './support/ci-data.ts';

const P = '/api/projects/p1/ci';

async function open(page: Page, path: string, edit: (d: CiData) => void = () => undefined): Promise<{ api: FakeApi; data: CiData }> {
  const api = await fakeApi(page);
  const data = ciData();
  edit(data);
  installCi(api, data);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: '빌드 · 통합' })).toBeVisible();
  return { api, data };
}
const runsTable = (page: Page) => page.getByRole('table', { name: '실행 기록' });
const row = (page: Page, key: string) => runsTable(page).getByRole('row', { name: new RegExp(`^${key} `) });
const detail = (page: Page) => page.getByRole('region', { name: /실행 상세$/ });

test.describe('UAT-CI-01 실행 기록 · 상세', () => {
  test('요약·배지·목록(모든 쪽)·단계 필터가 실제 보고와 일치한다', async ({ page }) => {
    const { api } = await open(page, '/ci');
    // Runner가 보고한 E2E 수와 끝난 시각(M7-04 fix2 계약 1)
    await expect(page.getByText(/^main 정상 · c4e81f0 · E2E 12 \/ 12 · 2026-11-03 02:14$/)).toBeVisible();
    await expect(page.getByText('실행 10 · 실패 미해결 0 · 병합 대기 1 · 마지막 배포 확인 2026-11-02 18:05 통과')).toBeVisible();
    // 모든 쪽을 읽었다(가짜 API는 2쪽으로 나눠 준다)
    expect(api.calls().filter((c) => c.startsWith(`GET ${P}/runs?`))).toHaveLength(2);
    await expect(runsTable(page).getByRole('row')).toHaveCount(11);
    const first = row(page, 'CI-0126');
    await expect(first).toContainText('③ 야간 점검');
    await expect(first).toContainText('통과');
    await expect(first).toContainText('main @ c4e81f0');
    await expect(first).toContainText('2026-11-03 02:00');
    await expect(first).toContainText('14분 02초');
    await expect(first).toContainText('야간 일정');
    await expect(row(page, 'CI-0124')).toContainText('TASK-0004');
    await expect(row(page, 'CI-0124')).toContainText('#9');
    await expect(row(page, 'CI-0124')).toContainText('실패');
    // 탭 배지: 병합 대기열 1, 불안정 테스트 1
    await expect(page.getByRole('tab', { name: '병합 대기열 1' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '불안정 테스트 1' })).toBeVisible();
    // 단계 필터
    const filter = page.getByRole('group', { name: '단계' });
    await expect(filter.getByRole('button')).toHaveText(['전체 10', '① Task 검사 4', '② 통합 확인 3', '③ 야간 점검 2', '④ 배포 확인 1']);
    await filter.getByRole('button', { name: '② 통합 확인 3' }).click();
    await expect(page).toHaveURL('/ci?stage=int');
    await expect(runsTable(page).getByRole('row')).toHaveCount(4);
    await expect(filter.getByRole('button', { name: '② 통합 확인 3' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('선택하면 레일 + 상세, 이전/다음·키보드·펼치기는 해당 실행을 가리킨다', async ({ page }) => {
    await open(page, '/ci?stage=task');
    await row(page, 'CI-0125').click();
    await expect(page).toHaveURL('/ci/ci-0125?stage=task');
    await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('CI-0125');
    await expect(detail(page)).toContainText('1 / 4');
    const rail = page.getByRole('complementary', { name: '실행 기록' });
    await expect(rail.getByRole('button', { name: /CI-0125/ })).toHaveAttribute('aria-current', 'true');
    await detail(page).getByRole('button', { name: '↓ 다음' }).click();
    await expect(page).toHaveURL('/ci/ci-0124?stage=task');
    await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('CI-0124');
    await expect(detail(page)).toContainText('2 / 4');
    await page.keyboard.press('j');
    await expect(page).toHaveURL('/ci/ci-0118?stage=task');
    await page.keyboard.press('k');
    await expect(page).toHaveURL('/ci/ci-0124?stage=task');
    await expect(detail(page).getByRole('button', { name: '↑ 이전' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL('/ci?stage=task');
    await expect(runsTable(page)).toBeVisible();
    // 뒤로 가기로 다시 상세
    await page.goBack();
    await expect(page).toHaveURL('/ci/ci-0124?stage=task');
    await rail.getByRole('button', { name: '펼치기' }).click();
    await expect(page).toHaveURL('/ci?stage=task');
  });

  test('실패 상세: 단계별 시간·실패 로그·근거, 실패 뒤 단계는 건너뜀, Task·시도 링크', async ({ page }) => {
    await open(page, '/ci/ci-0124', (d) => {
      const r = d.runs.find((x) => x.id === 'ci-0124');
      if (r) r.steps.push({ name: '추가 보고된 대기 단계', status: 'queued', durationMs: 0 });
    });
    const d = detail(page);
    await expect(d.getByRole('heading', { level: 2 })).toHaveText('CI-0124');
    await expect(d).toContainText('agent/TASK-0004 @ 0d9e5a2');
    await expect(d).toContainText('Agent 작업 종료');
    await expect(d).toContainText('2026-11-03 17:40 · 4분 05초');
    // 실제 보고(githubStatus)의 검사 이름·상태·보고 시각(M7-04 fix2 계약 6)
    await expect(d).toContainText('GitHub PR #9 검사 상태 보고: agentwbs/task — failure · 2026-11-03 17:44');
    // 실행 설명(note)
    await expect(d).toContainText('Runner가 Agent에게 실패 로그를 전달 → 같은 시도 안에서 수정');
    const steps = d.getByRole('table', { name: '단계' });
    await expect(steps.getByRole('row')).toHaveCount(8);
    await expect(steps.getByRole('row').nth(0)).toContainText('의존성 설치');
    await expect(steps.getByRole('row').nth(0)).toContainText('통과');
    await expect(steps.getByRole('row').nth(0)).toContainText(/^.*통과\d+초$/);
    await expect(steps.getByRole('row').nth(6)).toContainText('계약 테스트 — contracts/ 와 대조');
    await expect(steps.getByRole('row').nth(6)).toContainText('실패');
    await expect(steps.getByRole('row').nth(7)).toContainText('건너뜀');
    await expect(d.getByRole('heading', { name: '실패 로그 (요약)' })).toBeVisible();
    await expect(d.locator('pre.code')).toContainText('tasks_deleted_at_idx');
    await expect(d.getByRole('link', { name: 'TASK-0004' })).toHaveAttribute('href', '/wbs/TASK-0004');
    await expect(d.getByRole('link', { name: 'ATT-0004-1' })).toHaveAttribute('href', '/exec/TASK-0004?att=att-0004-1');
  });

  test('목록 밖(필터가 다른 단계)의 실행을 주소로 열면 「목록 밖」, 이전·다음 비활성', async ({ page }) => {
    await open(page, '/ci/ci-0121?stage=task');
    await expect(detail(page)).toContainText('목록 밖');
    await expect(detail(page).getByRole('button', { name: '↑ 이전' })).toBeDisabled();
    await expect(detail(page).getByRole('button', { name: '↓ 다음' })).toBeDisabled();
    // 배포 확인 결과: 접속 URL·스크린샷 근거
    await expect(detail(page)).toContainText('http://localhost:8080');
    await expect(detail(page)).toContainText('task-detail.png');
  });

  test('없는 실행 주소는 404 안내와 목록으로', async ({ page }) => {
    await open(page, '/ci/nope');
    await expect(page.getByRole('alert')).toContainText('실행 기록을 찾을 수 없습니다 (404)');
    await page.getByRole('button', { name: '목록으로' }).click();
    await expect(page).toHaveURL('/ci');
  });

  test('기준선 실패(failScope=baseline)는 Task 실패와 다르게 보이고 main 깨짐으로 요약한다', async ({ page }) => {
    await open(page, '/ci', (d) => { d.runs.unshift(baselineRun()); });
    await expect(row(page, 'CI-0128')).toContainText('기준선 실패');
    await expect(row(page, 'CI-0128').locator('.vf.v-fail')).toHaveCount(0);
    await expect(page.getByText(/^main 깨짐 · 기준선 검사 실패 · c4e81f0 · 2026-11-05 19:31$/)).toBeVisible();
    await row(page, 'CI-0128').click();
    await expect(detail(page)).toContainText('main 기준 커밋에서도 실패');
  });
});

test.describe('UAT-CI-01A 다시 실행', () => {
  test('실패한 실행만 다시 실행할 수 있고, 요청은 job으로 가며 가짜 통과를 만들지 않는다(MM-07)', async ({ page }) => {
    const { api } = await open(page, '/ci/ci-0125');
    await expect(detail(page).getByRole('button', { name: '다시 실행' })).toHaveCount(0);
    await page.goto('/ci/ci-0124');
    api.on(`POST ${P}/runs/ci-0124/retry`, (route) => json(route, 202, { jobId: 'job-1' }));
    await detail(page).getByRole('button', { name: '다시 실행' }).click();
    await expect(page.getByText('다시 실행을 요청했습니다')).toBeVisible();
    expect(api.requests(`POST ${P}/runs/ci-0124/retry`)).toHaveLength(1);
    // 화면이 스스로 통과 기록을 만들지 않는다
    await expect(page.getByRole('complementary', { name: '실행 기록' }).getByRole('button', { name: /CI-0124|CI-0125/ })).toHaveCount(2);
    await expect(page.getByRole('complementary', { name: '실행 기록' }).getByRole('button')).toHaveCount(11);
  });

  test('외부 쓰기 차단(409)은 오류 막대로 알린다', async ({ page }) => {
    const { api } = await open(page, '/ci/ci-0124');
    api.on(`POST ${P}/runs/ci-0124/retry`, (route) => json(route, 409, errorBody('EXTERNAL_WRITE_BLOCKED', { message: '외부 쓰기가 막혀 있습니다.' })));
    await detail(page).getByRole('button', { name: '다시 실행' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '외부 쓰기가 막혀 있습니다.' })).toBeVisible();
  });
});

test('UAT-CI-04 보호 경로 변경: 첫 보호 검사에서 경로·거부 사유를 남기고 뒤 단계는 건너뜀', async ({ page }) => {
  await open(page, '/ci/ci-0127', (d) => { d.runs.unshift(guardRun()); });
  const d = detail(page);
  const steps = d.getByRole('table', { name: '단계' });
  await expect(steps.getByRole('row')).toHaveCount(2);
  await expect(steps.getByRole('row').nth(1)).toContainText('보호 경로 검사');
  await expect(steps.getByRole('row').nth(1)).toContainText('실패');
  await expect(d.locator('pre.code')).toContainText('M prototype/uiux/js/task-api.js');
  await expect(d.locator('pre.code')).toContainText('M .agentwbs/pipeline.yaml');
  await expect(d.locator('pre.code')).toContainText('Agent가 바꿀 수 없습니다');
  // GitHub 보고가 아직 확인되지 않은 실행은 PASS·FAIL로 꾸미지 않는다
  await expect(d).toContainText('GitHub PR #10 검사 상태 보고 확인 전 (agentwbs/task)');
  await expect(d).toContainText('Task 검사 실패는 Runner가 Agent에게 로그를 전달');
});

test.describe('UAT-CI-03 병합 대기열', () => {
  test('대상 Task/PR·상태·시각, 직렬 통합 안내, Task·실행 링크', async ({ page }) => {
    await open(page, '/ci?tab=queue');
    await expect(page.getByRole('tab', { name: /병합 대기열/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('② 통합 확인을 한 번에 하나씩 거쳐')).toBeVisible();
    const t = page.getByRole('table', { name: '병합 대기열' });
    const rows = t.getByRole('row');
    await expect(rows).toHaveCount(4);
    // 최근 순서(원본처럼 대기열 뒤쪽이 위)
    await expect(rows.nth(0)).toContainText('#9');
    await expect(rows.nth(0)).toContainText('Drizzle Schema 설계');
    await expect(rows.nth(0)).toContainText('검증 대기');
    await expect(rows.nth(1)).toContainText('병합됨');
    // 병합됨은 실제 병합 시각, 검증 대기는 대기열에 들어온 시각(M7-04 fix2 계약 3)
    await expect(rows.nth(1)).toContainText('2026-10-31 11:49');
    await expect(rows.nth(0)).toContainText('2026-11-03 18:22');
    await expect(rows.nth(0).getByRole('link', { name: 'TASK-0004' })).toHaveAttribute('href', '/wbs/TASK-0004');
    await expect(rows.nth(1).getByRole('link', { name: 'CI-0112' })).toHaveAttribute('href', '/ci/ci-0112');
  });

  test('MERGE_MISMATCH: 실제 병합이 검증 근거와 다르면 경고하고 완료 보류로 보인다', async ({ page }) => {
    await open(page, '/ci?tab=queue', (d) => { d.runs.unshift(baselineRun()); d.queue.push(mismatchItem()); });
    const warn = page.getByRole('alert').filter({ hasText: '실제 병합이 검증 근거와 다릅니다' });
    await expect(warn).toContainText('#11');
    await expect(warn).toContainText('TASK-0006');
    await expect(warn).toContainText('dead000');
    await expect(page.getByRole('table', { name: '병합 대기열' }).getByRole('row').nth(0)).toContainText('병합 불일치 — 완료 보류');
  });
});

test.describe('UAT-CI-05 배포 확인', () => {
  test('최근 배포의 시각·결과, 상세 링크는 그 실행을 연다', async ({ page }) => {
    await open(page, '/ci?tab=deploy');
    await expect(page.getByText('http://localhost:8080').first()).toBeVisible();
    const last = page.getByRole('link', { name: '2026-11-02 18:05 · 통과 · CI-0121' });
    await last.click();
    await expect(page).toHaveURL('/ci/ci-0121');
    await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('CI-0121');
  });

  test('배포 확인 요청은 job으로 가고 결과를 꾸며 만들지 않는다', async ({ page }) => {
    const { api } = await open(page, '/ci?tab=deploy');
    api.on(`POST ${P}/deploy-check`, (route) => json(route, 202, { jobId: 'job-2' }));
    await page.getByRole('button', { name: '배포 확인 실행' }).click();
    await expect(page.getByText('배포 확인을 요청했습니다')).toBeVisible();
    expect(api.requests(`POST ${P}/deploy-check`)).toHaveLength(1);
    await expect(page.getByRole('link', { name: '2026-11-02 18:05 · 통과 · CI-0121' })).toBeVisible();
  });

  test('배포 기록이 없으면 「실행한 적이 없습니다」', async ({ page }) => {
    await open(page, '/ci?tab=deploy', (d) => { d.runs = d.runs.filter((r) => r.stage !== 'deploy'); });
    await expect(page.getByText('배포 확인을 실행한 적이 없습니다')).toBeVisible();
  });
});

test.describe('UAT-CI-06 파이프라인 정의 · 불안정 테스트', () => {
  test('4단계·조건·통과 기준·기준 커밋·야간/재시도/URL 설정을 보인다', async ({ page }) => {
    await open(page, '/ci?tab=pipe');
    await expect(page.getByText('.agentwbs/pipeline.yaml · main @ c4e81f0')).toBeVisible();
    for (const s of ['① Task 검사', '② 통합 확인', '③ 야간 점검', '④ 배포 확인']) await expect(page.locator('.dec-h b', { hasText: s })).toBeVisible();
    await expect(page.getByText('통과해야 검증 Agent에게 넘어감')).toBeVisible();
    await expect(page.getByText('2. 보호 경로 검사 — prototype/ · .agentwbs/ 변경 금지 · 빌드 결과물 커밋 금지')).toBeVisible();
    await expect(page.getByText('매일 02:00', { exact: true })).toBeVisible();
    await expect(page.getByText('http://localhost:8080', { exact: true })).toBeVisible();
    await expect(page.getByText('1회 — 재시도로만 통과하면 불안정 후보')).toBeVisible();
    await expect(page.getByText('docker compose — docker-compose.ci.yml', { exact: true })).toBeVisible();
  });

  test('정의 파일을 해석하지 못하면 원인을 보인다', async ({ page }) => {
    await open(page, '/ci?tab=pipe', (d) => { d.pipeline = { ...d.pipeline, status: 'error', error: 'stages[1].steps: 배열이어야 합니다', stages: null, raw: 'stages: x' }; });
    await expect(page.getByRole('alert')).toContainText('stages[1].steps: 배열이어야 합니다');
  });

  test('격리 해제는 절대값(quarantined=false)과 버전으로 저장하고, 담당 Task 링크는 Task 상세', async ({ page }) => {
    const { api } = await open(page, '/ci?tab=flaky');
    const t = page.getByRole('table', { name: '불안정 테스트' });
    await expect(t.getByRole('row').nth(0)).toContainText('wbs-tree.spec.ts › 접힘 상태 유지');
    // 마지막 실패 시각(lastFailedAt, M7-04 fix2 계약 4) — 기록 갱신 시각(02:14)이 아니다
    await expect(t.getByRole('row').nth(0)).toContainText('2026-11-03 02:00');
    await expect(t.getByRole('row').nth(0)).not.toContainText('02:14');
    await expect(t.getByRole('row').nth(0)).toContainText('2 / 20 실패');
    await expect(t.getByRole('row').nth(0)).toContainText('격리');
    await expect(t.getByRole('link', { name: 'TASK-0007' })).toHaveAttribute('href', '/wbs/TASK-0007');
    api.on(`PATCH ${P}/flaky/f1`, (route, request) => json(route, 200, { ...(request.postDataJSON() as object), id: 'f1', testKey: 'wbs-tree.spec.ts › 접힘 상태 유지', rate: '2 / 20 실패', taskKey: 'TASK-0007', updatedAt: '2026-11-05T11:00:00.000000Z' }));
    await t.getByRole('button', { name: '격리 해제' }).click();
    await expect(t.getByRole('button', { name: '다시 격리' })).toBeVisible();
    await expect(t.getByRole('row').nth(0)).toContainText('정상 (격리 해제)');
    const body = api.requests(`PATCH ${P}/flaky/f1`)[0]?.postDataJSON() as unknown;
    expect(body).toEqual({ updatedAt: new Date('2026-11-03T02:14:00+09:00').toISOString(), quarantined: false });
    await expect(page.getByText('불안정 테스트 상태를 바꿨습니다.')).toBeVisible();
  });

  test('격리 변경이 버전 충돌(409)이면 충돌 창을 띄운다', async ({ page }) => {
    const { api } = await open(page, '/ci?tab=flaky');
    api.on(`PATCH ${P}/flaky/f1`, (route) => json(route, 409, errorBody('VERSION_CONFLICT')));
    await page.getByRole('button', { name: '격리 해제' }).click();
    await expect(page.getByRole('alertdialog', { name: '다른 변경이 먼저 저장되었습니다' })).toBeVisible();
    await expect(page.getByRole('alertdialog')).toContainText('격리 해제');
  });
});

test.describe('UAT-EMPTY-05 빈 상태 · 조건 불일치', () => {
  test('기록이 없으면 각 탭에 「없음」과 생기는 조건', async ({ page }) => {
    await open(page, '/ci', (d) => { d.runs = []; d.queue = []; d.flaky = []; });
    await expect(page.getByText('아직 빌드 · 검사 실행 기록이 없습니다.')).toBeVisible();
    await expect(page.getByText('첫 Task의 Agent 작업이 끝나면 ① Task 검사가 자동으로 실행됩니다.', { exact: false })).toBeVisible();
    await expect(page.getByText(/^main 빌드 기록 없음$/)).toBeVisible();
    await page.getByRole('tab', { name: '병합 대기열' }).click();
    await expect(page.getByText('대기열이 비어 있습니다.')).toBeVisible();
    await expect(page.getByText('검증 PASS인 PR만 들어오고', { exact: false })).toBeVisible();
    await page.getByRole('tab', { name: '불안정 테스트' }).click();
    await expect(page.getByText('불안정 테스트가 없습니다.')).toBeVisible();
    await expect(page.getByText('재시도로만 통과한 테스트', { exact: false })).toBeVisible();
  });

  test('실행은 있으나 필터만 불일치하면 조건 불일치로 구분하고 초기화하면 행이 돌아온다', async ({ page }) => {
    await open(page, '/ci?stage=deploy', (d) => { d.runs = d.runs.filter((r) => r.stage !== 'deploy'); });
    await expect(page.getByText('조건에 맞는 실행 기록이 없습니다.', { exact: false })).toBeVisible();
    await expect(page.getByText('아직 빌드 · 검사 실행 기록이 없습니다.')).toHaveCount(0);
    await page.getByRole('button', { name: '필터 초기화' }).click();
    await expect(page).toHaveURL('/ci');
    await expect(runsTable(page).getByRole('row')).toHaveCount(10);
  });
});

test.describe('fix1: 기준선 실패 재통합 · 병합 불일치 보류 · 관측 전 값', () => {
  // 아래 시험은 서버 판정값(M7-04 fix4)을 바꿔 주고 화면이 그 값 그대로 보이는지 본다. 화면은 다시 판정하지 않는다.
  test('fix3: autoReintegrate=pending이면 대기열·상세 모두 「자동 재통합」, 대기열 안내는 기준선 예외', async ({ page }) => {
    await open(page, '/ci?tab=queue', (d) => { d.runs.unshift({ ...baselineRun(), autoReintegrate: 'pending' }); d.queue.push(baselineQueueItem()); });
    await expect(page.getByText('기준선 실패는 예외입니다', { exact: false })).toBeVisible();
    const row = page.getByRole('table', { name: '병합 대기열' }).getByRole('row').nth(0);
    await expect(row).toContainText('기준선 실패 — main 수정 뒤 자동 재통합');
    await expect(row.locator('.vf.v-fail')).toHaveCount(0);
    await row.getByRole('link', { name: /CI-0128/ }).click();
    await expect(page).toHaveURL('/ci/ci-0128');
    await expect(detail(page)).toContainText('main이 바뀌면 서버가 자동으로 다시 통합 확인합니다');
  });

  test('재리뷰 P2-3 재현: 화면이 모르는 reconcile 보류 — 서버가 blocked면 자동 진행을 약속하지 않고 사유를 보인다', async ({ page }) => {
    // 재현: 최신 차수 failed + ① baseline + Task gate + 보이는 불일치 없음. 화면 근사로는 「자동 재통합」이었다.
    await open(page, '/ci?tab=queue', (d) => {
      d.taskStatus['TASK-0006'] = 'gate';
      d.runs.unshift({ ...baselineRun(), taskStatus: 'gate', autoReintegrate: 'blocked', autoReintegrateReason: '이전 통합 작업이 대조 대기(reconcile) 중입니다', retryAllowed: false, retryBlockedReason: '이전 통합 작업이 대조 대기(reconcile) 중입니다' });
      d.queue.push(baselineQueueItem());
    });
    await expect(page.getByRole('table', { name: '병합 대기열' }).getByRole('row').nth(0)).toContainText('기준선 실패 — 자동 재통합 보류');
    await page.goto('/ci/ci-0128');
    await expect(detail(page)).toContainText('자동 재통합 보류 — 이전 통합 작업이 대조 대기(reconcile) 중입니다');
    await expect(detail(page)).not.toContainText('자동으로 다시 통합');
    await expect(detail(page).getByRole('button', { name: '다시 실행' })).toBeDisabled();
    await expect(detail(page)).toContainText('다시 실행할 수 없습니다 — 이전 통합 작업이 대조 대기(reconcile) 중입니다');
  });

  test('재리뷰 P2-4 재현: Gate를 벗어난 Task의 기준선 실패 — 과거 병합 불일치가 남아도 서버가 허용하면 다시 실행', async ({ page }) => {
    const { api } = await open(page, '/ci/ci-0128', (d) => {
      d.runs.unshift({ ...baselineRun(), taskStatus: 'verifying', retryAllowed: true });
      d.queue.push(baselineQueueItem(), { ...mismatchItem(), position: 6 });
    });
    api.on('POST /api/projects/p1/ci/runs/ci-0128/retry', (route) => json(route, 202, { jobId: 'job-4' }));
    await expect(detail(page).getByRole('button', { name: '다시 실행' })).toBeEnabled();
    await detail(page).getByRole('button', { name: '다시 실행' }).click();
    await expect(page.getByText('다시 실행을 요청했습니다')).toBeVisible();
  });

  test('retryAllowed=false면 버튼을 막고 서버 사유를 보인다(요청을 보내지 않음)', async ({ page }) => {
    const { api } = await open(page, '/ci/ci-0128', (d) => {
      d.runs.unshift({ ...baselineRun(), taskStatus: 'gate', retryAllowed: false, retryBlockedReason: '실제 병합이 검증 근거와 달라 완료를 보류 중입니다' });
      d.queue.push(mismatchItem());
    });
    await expect(detail(page).getByRole('button', { name: '다시 실행' })).toBeDisabled();
    await expect(detail(page)).toContainText('다시 실행할 수 없습니다 — 실제 병합이 검증 근거와 달라 완료를 보류 중입니다');
    expect(api.requests('POST /api/projects/p1/ci/runs/ci-0128/retry')).toHaveLength(0);
  });

  test('재리뷰 P2-2 재현 A: 같은 기준·같은 정의의 나중 PASS가 있어도 서버가 미해소(false)면 main 깨짐', async ({ page }) => {
    await open(page, '/ci', (d) => {
      const fail = baselineRun();
      d.runs.unshift({ ...fail, id: 'ci-0129', runKey: 'CI-0129', status: 'pass', failScope: null, failStep: null, logExcerpt: null, baselineResolved: null, retryAllowed: false, startedAt: '2026-11-05T11:00:00.000Z', finishedAt: '2026-11-05T11:02:00.000Z' }, fail);
    });
    await expect(page.getByText(/^main 깨짐 · 기준선 검사 실패 · c4e81f0 · /)).toBeVisible();
  });

  test('재리뷰 P2-2 재현 B: main이 이동해 서버가 해소(true)하면 깨짐을 남기지 않고 상세에 해소를 알린다', async ({ page }) => {
    await open(page, '/ci', (d) => { d.runs.unshift({ ...baselineRun(), baselineResolved: true }); });
    await expect(page.getByText(/^main 정상 · c4e81f0 · E2E 12 \/ 12 · 2026-11-03 02:14$/)).toBeVisible();
    await page.goto('/ci/ci-0128');
    await expect(detail(page)).toContainText('서버가 이 기준선 실패를 해소로 판정했습니다');
  });

  test('main 배지: ② PASS의 서버 대기열 상태가 병합 불일치면 main 정상이라 하지 않는다', async ({ page }) => {
    await open(page, '/ci', (d) => {
      const intRun = { ...baselineRun(), id: 'ci-0129', runKey: 'CI-0129', stage: 'int' as const, status: 'pass' as const, failScope: null, failStep: null, logExcerpt: null, baselineResolved: null, retryAllowed: false,
        mergeSha: 'beef000'.padEnd(40, '0'), mergeStatus: 'checking' as const, actualMergeSha: 'dead000'.padEnd(40, '0'), startedAt: '2026-11-05T11:00:00.000Z', finishedAt: '2026-11-05T11:08:00.000Z' };
      d.runs.unshift(intRun);
      d.queue.push({ ...mismatchItem(), ciRunId: 'ci-0129' });
    });
    await expect(page.getByText(/^main 확인 필요 · 병합 불일치 · dead000 · 2026-11-05 20:08$/)).toBeVisible();
    await expect(page.getByText(/^main 정상/)).toHaveCount(0);
  });

  test('원인 후보: 커밋과 서버가 연결한 Task 링크, 연결이 없으면 「연결된 Task 없음」', async ({ page }) => {
    await open(page, '/ci/ci-0126', (d) => {
      const n = d.runs.find((r) => r.id === 'ci-0126');
      if (n) n.causeCandidates = [{ commit: 'c4e81f0'.padEnd(40, '0'), taskKey: 'TASK-0003' }, { commit: 'abc1234'.padEnd(40, '0'), taskKey: null }];
    });
    await expect(detail(page)).toContainText('원인 후보');
    await expect(detail(page).getByRole('link', { name: 'TASK-0003' })).toHaveAttribute('href', '/wbs/TASK-0003');
    await expect(detail(page)).toContainText('abc1234 연결된 Task 없음');
  });

  test('Runner가 아직 보고하지 않은 값은 꾸미지 않는다(E2E 수·병합 시각·마지막 실패·서비스 구성)', async ({ page }) => {
    await open(page, '/ci', (d) => {
      for (const r of d.runs) { r.e2e = null; }
      for (const q of d.queue) { q.mergedAt = null; }
      for (const f of d.flaky) { f.lastFailedAt = null; }
      d.settings = { ...d.settings, serviceConfig: null };
    });
    await expect(page.getByText(/^main 정상 · c4e81f0 · 2026-11-03 02:14$/)).toBeVisible();
    await page.getByRole('tab', { name: /병합 대기열/ }).click();
    await expect(page.getByRole('table', { name: '병합 대기열' }).getByRole('row').nth(1)).toContainText('병합 시각 미확인');
    await page.getByRole('tab', { name: /불안정 테스트/ }).click();
    await expect(page.getByRole('table', { name: '불안정 테스트' }).getByRole('row').nth(0).getByRole('cell').nth(2)).toHaveText('—');
    await page.getByRole('tab', { name: '파이프라인 정의' }).click();
    await expect(page.getByText('아직 관측되지 않음', { exact: false })).toBeVisible();
  });
});

test.describe('재리뷰(review2-codex) 재현', () => {
  test('P2-1: 병합 불일치 실행의 상세는 「병합됨」이라 하지 않고 서버 상태(mergeStatus·actualMergeSha) 그대로', async ({ page }) => {
    // 리뷰어 재현 그대로: ② PASS(mergeSha c4e81f0) + 대기열 checking·actualMergeSha dead000
    await open(page, '/ci/ci-0112', (d) => {
      const found = d.runs.find((x) => x.id === 'ci-0112');
      if (!found) throw new Error('시험 자료에 ci-0112가 없다');
      d.runs = [{ ...found, startedAt: '2026-11-06T00:00:00Z', mergeStatus: 'checking', actualMergeSha: 'dead000'.padEnd(40, '0'), mergeCompleted: false }];
      d.queue = [{ ...mismatchItem(), taskKey: 'TASK-0003', pr: 7, ciRunId: 'ci-0112' }];
    });
    await expect(page.getByText(/main 확인 필요 · 병합 불일치/)).toBeVisible();
    const d = detail(page);
    await expect(d).not.toContainText('병합됨');
    await expect(d).toContainText('병합 불일치 — 실제 병합 dead000 · 완료 보류 (검사한 병합본 c4e81f0)');
  });

  test('P2-1: 대기열이 병합됨이면 상세도 「병합됨」', async ({ page }) => {
    await open(page, '/ci/ci-0112');
    await expect(detail(page)).toContainText('병합됨 → main @ c4e81f0 · 완료');
  });

  for (const width of [1440, 390]) {
    test(`P3: ${String(width)}px 모든 탭·상세에서 제목 단계를 건너뛰지 않는다(axe heading-order)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, '/ci');
      for (const path of ['/ci', '/ci/ci-0124', '/ci?tab=queue', '/ci?tab=deploy', '/ci?tab=pipe', '/ci?tab=flaky']) {
        await page.goto(path);
        await expect(page.locator('.card').first()).toBeVisible();
        await expect(page.locator('.main [aria-busy="true"], .main [role="status"]')).toHaveCount(0);
        const axe = await new AxeBuilder({ page }).include('.main').withRules(['heading-order']).analyze();
        expect(axe.violations.map((v) => `${path} ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(',')}`), path).toEqual([]);
      }
    });
  }
});

async function pageOverflow(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const offenders = [...document.querySelectorAll('.app, .hdr, .nav, .main, .page, .page-h, .two, .mainc, .card')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto')
      .map((el) => el.className);
    return { page: root.scrollWidth > root.clientWidth, offenders };
  });
}

test.describe('UAT-RESP-01 표 가로 스크롤(1024·768)', () => {
  for (const width of [1024, 768]) {
    test(`${String(width)}px: 페이지는 넘치지 않고 표는 영역 안에서 가로로 밀어 마지막 열까지 읽는다`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, '/ci');
      for (const tab of ['', '?tab=queue', '?tab=flaky', '?tab=pipe', '?tab=deploy']) {
        await page.goto(`/ci${tab}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('.card').first()).toBeVisible();
        expect(await pageOverflow(page), tab).toEqual({ page: false, offenders: [] });
      }
      await page.goto('/ci');
      const box = page.getByRole('region', { name: '실행 기록 표' });
      expect(await box.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
      await box.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
      await expect(row(page, 'CI-0126').getByText('야간 일정')).toBeInViewport();
    });
  }
});

test.describe('390px 휴대폰', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('fix2: main 배지가 길어도(E2E 수·시각) 390px 머리글을 넘지 않는다(글꼴 로딩과 무관)', async ({ page }) => {
    // 재현: 웹 글꼴이 오기 전 대체 글꼴에서 배지가 347px > 머리글 306px로 넘쳤다(review2 1회 실패, fix2 실측). 숫자가 크면 글꼴과 무관하게 넘친다.
    await open(page, '/ci', (d) => { for (const r of d.runs) if (r.stage === 'night') r.e2e = { passed: 1234, total: 1250 }; });
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByText(/E2E 1234 \/ 1250/)).toBeVisible();
    expect(await pageOverflow(page)).toEqual({ page: false, offenders: [] });
  });

  test('UAT-RESP-02 / UAT-TG-09: 알림 링크(/ci/<id>)로 로그인 후 CI 상세를 잘림 없이 열람한다', async ({ page }) => {
    const api = await fakeApi(page);
    const data = ciData();
    installCi(api, data);
    let signedIn = false;
    api.on('GET /api/session', (route) => (signedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
    api.on('POST /api/auth/session', (route) => { signedIn = true; return route.fulfill({ status: 204 }); });
    await page.goto('/ci/ci-0124');
    await expect(page).toHaveURL('/login?next=%2Fci%2Fci-0124');
    await page.getByLabel('비밀번호').fill('pw');
    await page.getByRole('button', { name: '로그인' }).click();
    await expect(page).toHaveURL('/ci/ci-0124');
    expect(await page.evaluate(() => window.innerWidth)).toBe(390);
    const d = detail(page);
    await expect(d.getByRole('heading', { level: 2, name: 'CI-0124' })).toBeInViewport();
    await expect(d.locator('.vf-nav .vf')).toHaveText('실패');
    expect(await pageOverflow(page)).toEqual({ page: false, offenders: [] });
    // 상세가 목록보다 먼저
    const [db, lb] = [await d.boundingBox(), await page.getByRole('complementary', { name: '실행 기록' }).boundingBox()];
    expect(db && lb && db.y < lb.y).toBe(true);
    // 핵심 글자가 잘리지 않는다
    const clipped = await page.evaluate(() => [...document.querySelectorAll('.ci-detail .kv *, .ci-detail h2, .ci-detail .vf-nav *, .ci-detail .gc')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).map((el) => el.textContent?.slice(0, 30)));
    expect(clipped).toEqual([]);
    // 실패 로그는 자체 가로 스크롤로 끝까지
    const log = d.locator('pre.code');
    await expect(log).toContainText('tasks_deleted_at_idx');
    expect(await log.evaluate((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX) || el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(d.getByRole('link', { name: 'TASK-0004' })).toBeVisible();
  });
});
