/**
 * Task 상세 흐름 — 착수 승인 요청→승인·반려(UAT-APPROVE-01), 등급 고정·해제(UAT-TASK-03, 시나리오 13),
 * 분할 근거·제안·예외(시나리오 23 일부), 390px 알림 링크 열람(UAT-RESP-02-TASK), 화면 폭(D-28), 생성 직후 명세 탭(UAT-WIZ-03 일부).
 */
import { expect, test, type Page } from '@playwright/test';
import { errorBody, fakeApi, json, SESSION, type FakeApi } from './support/fake-api.ts';
import { detail, mountTasks, newStore, type TaskStore } from './support/task-api.ts';

async function open(page: Page, url: string, store = newStore()): Promise<{ api: FakeApi; s: TaskStore }> {
  const api = await fakeApi(page);
  const s = mountTasks(api, store);
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  return { api, s };
}

test('UAT-APPROVE-01 명세 미완료면 요청 거부(고칠 항목), 채우면 approval → 승인은 ready(실행·완료 안 함), 이력에 주체·시각', async ({ page }) => {
  // 원본 Mock의 TASK-0009는 완료 조건·AC·체크리스트·산출물이 비어 있다.
  const { api, s } = await open(page, '/wbs/TASK-0009');
  const bar = page.locator('.appr-bar');
  await expect(bar).toContainText('계획 중');
  await bar.getByRole('button', { name: '착수 승인 요청' }).click();
  const err = page.getByRole('alert');
  await expect(err).toContainText('400 VALIDATION_FAILED');
  const fix = err.getByRole('list', { name: '고칠 항목' });
  await expect(fix).toContainText('overview.doneCond — 완료 조건이 필요합니다.');
  await expect(fix).toContainText('ac — Acceptance Criteria가 1개 이상 필요합니다.');
  await expect(fix).toContainText('checklist — 체크리스트가 1개 이상 필요합니다.');
  await expect(fix).toContainText('outputs — 필수 산출물이 1개 이상 필요합니다.');
  await expect(page.locator('.summary .st')).toHaveText('계획 중');

  Object.assign(s.tasks.get('TASK-0009'), {
    doneCond: '필수 항목 미완료 시 완료 불가가 테스트로 확인된다.',
    checklist: [{ id: 'CL-0009-1', text: '토글 API', required: true, done: false, method: '', evidence: '', note: '' }],
    outputs: [{ name: 'apps/api/src/checklist.ts', kind: '코드', required: true, verify: '', delivered: false }],
  });
  s.tasks.get('TASK-0009').spec.ac = [{ given: '필수 미완료', when: '완료 요청', then: '409', method: '' }];
  await page.reload();
  await page.locator('.appr-bar').getByRole('button', { name: '착수 승인 요청' }).click();
  await expect(page.locator('.summary .st')).toHaveText('승인 대기');
  await expect(page.locator('.appr-bar')).toContainText('착수 승인 대기 — 승인하면 실행 대기, 반려하면 계획 중으로 돌아갑니다. 착수 승인만으로 실행하거나 완료하지 않습니다.');
  await page.locator('.appr-bar').getByRole('button', { name: '승인', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'TASK-0009 착수를 승인했습니다.' })).toBeVisible();
  await expect(page.locator('.summary .st')).toHaveText('실행 대기');
  await expect(page.locator('.appr-bar')).toHaveCount(0);
  // 승인만으로 실행 요청·완료 요청을 보내지 않는다
  expect(api.calls().filter((c) => /\/runs|\/complete/.test(c))).toEqual([]);
  await page.getByRole('tab', { name: /^이력/ }).click();
  const hist = page.getByRole('table', { name: '이력' });
  await expect(hist).toContainText('팀장승인착수 승인승인 대기 → 실행 대기');
  await expect(hist).toContainText('팀장승인착수 승인 요청계획 중 → 승인 대기');
  await expect(hist).toContainText('2026-11-05 20:00');
});

test('UAT-APPROVE-01 반려는 사유와 함께 planning으로, 권한 없는 승인(403)은 거부 안내', async ({ page }) => {
  const { api } = await open(page, '/wbs/TASK-0010');
  await expect(page.locator('.summary .st')).toHaveText('승인 대기');
  // 권한 없음
  api.on('POST /api/tasks/TASK-0010/approve', (route) => json(route, 403, errorBody('FORBIDDEN_PRINCIPAL', { message: '이 요청을 보낼 권한이 없습니다.', fix: '팀장 세션으로 다시 로그인하세요.' })));
  await page.locator('.appr-bar').getByRole('button', { name: '승인', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('403 FORBIDDEN_PRINCIPAL');
  await expect(page.locator('.summary .st')).toHaveText('승인 대기');

  await page.locator('.appr-bar').getByRole('button', { name: '반려' }).click();
  const dialog = page.getByRole('dialog', { name: '착수 반려' });
  await dialog.getByLabel('반려 사유').fill('AC 3번 범위가 넓음');
  await dialog.getByRole('button', { name: '반려' }).click();
  await expect(page.locator('.summary .st')).toHaveText('계획 중');
  expect(api.requests('POST /api/tasks/TASK-0010/reject')[0]?.postDataJSON()).toMatchObject({ comment: 'AC 3번 범위가 넓음' });
  await page.getByRole('tab', { name: /^이력/ }).click();
  await expect(page.getByRole('table', { name: '이력' })).toContainText('착수 반려 — AC 3번 범위가 넓음');
});

test('UAT-TASK-03 · 시나리오 13 등급: 모델/Effort·근거·주체·고정 구분, 최저선 미달 경고 후 고정 → 재추정 요청, 해제는 Planning 판단', async ({ page }) => {
  const api = await fakeApi(page);
  const s = mountTasks(api, newStore());
  api.on('GET /api/settings/models', (route) => json(route, 200, {
    rankOrder: { Claude: [], Codex: [] }, codexFamilyOrder: ['gpt'], claudeModels: ['claude-opus-5-5'], updatedAt: null,
    models: [
      { agent: 'Claude', id: 'claude-opus-5-5', label: 'Opus 5.5', rank: 2, allowed: true, isNew: false, efforts: [{ key: 'low', level: 1 }, { key: 'medium', level: 2 }, { key: 'high', level: 3 }, { key: 'max', level: 5 }] },
      { agent: 'Claude', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', rank: 1, allowed: true, isNew: false, efforts: [{ key: 'low', level: 1 }, { key: 'medium', level: 2 }, { key: 'high', level: 3 }] },
    ],
  }));
  api.on('GET /api/settings/exec-policy', (route) => json(route, 200, { floors: { verifyGeDev: true, dbHigh: true }, autoRetryLimit: 2, autoReworkLimit: 3, updatedAt: null }));
  let locked = false;
  api.on('PUT /api/tasks/TASK-0004/grade', async (route, req) => {
    const b = req.postDataJSON() as { modelId: string; effort: string; role: string };
    Object.assign(s.tasks.get('TASK-0004').run, { model: b.modelId, effort: b.effort, locked: true, basis: '팀장 지정' });
    locked = true;
    return json(route, 200, { task: detail(s, 'TASK-0004'), changes: [] });
  });
  api.on('DELETE /api/tasks/TASK-0004/grade', async (route) => {
    Object.assign(s.tasks.get('TASK-0004').run, { model: 'claude-opus-5-5', effort: 'high', locked: false, basis: 'Planning Agent 재판단' });
    return json(route, 200, { task: detail(s, 'TASK-0004'), changes: [] });
  });
  await page.goto('/wbs/TASK-0004');
  const dev = page.locator('.runrow').first();
  await expect(dev).toContainText('개발ClClaude Opus 5.5 · 높음');
  await expect(dev.locator('.tag').nth(1)).toHaveText('Planning Agent 판단');
  await expect(dev).toContainText('근거 — 설계 작업 기본 높음');
  await dev.getByRole('button', { name: '변경 · 고정' }).click();
  await dev.getByRole('group', { name: '개발 모델' }).getByRole('button', { name: 'Sonnet 5.5' }).click();
  await dev.getByRole('group', { name: '개발 Effort' }).getByRole('button', { name: '보통' }).click();
  await expect(dev.getByRole('note')).toContainText('최저선 미달 (DB Task는 Effort 높음 이상) — 저장하면 팀장 예외로 고정되고 이력에 남습니다.');
  await dev.getByRole('button', { name: '저장 · 고정' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'TASK-0004 개발 등급을 고정했습니다. 등급이 바뀌면 작업량을 재추정하고 일정을 자동 재조정합니다.' })).toBeVisible();
  expect(locked).toBe(true);
  expect(api.requests('PUT /api/tasks/TASK-0004/grade')[0]?.postDataJSON()).toMatchObject({ role: 'dev', modelId: 'claude-sonnet-5-5', effort: 'medium' });
  await expect(dev).toContainText('Sonnet 5.5 · 보통');
  await expect(dev.locator('.tag.lock')).toHaveText('팀장 고정');

  await dev.getByRole('button', { name: '고정 해제' }).click();
  await page.getByRole('alertdialog', { name: '등급 고정 해제' }).getByRole('button', { name: '고정 해제' }).click();
  await expect(dev.locator('.tag').nth(1)).toHaveText('Planning Agent 판단');
  const del = api.requests('DELETE /api/tasks/TASK-0004/grade')[0];
  expect(new URL(del?.url() ?? '').searchParams.get('role')).toBe('dev');
});

test('시나리오 23 일부: 분할 근거·점검 표, 시작 전 Task는 「Planning Agent 분할 제안」, 시작한 Task는 예외 사유 기록', async ({ page }) => {
  const { api } = await open(page, '/wbs/TASK-0008');
  api.on('POST /api/tasks/TASK-0008/split', (route) => json(route, 202, { jobId: '00000000-0000-4000-8000-000000000123' }));
  const sec = page.locator('.sec').filter({ hasText: '분할 근거 · 점검' });
  await expect(sec.locator('.gtr')).toHaveCount(10);
  await expect(sec).toContainText('혼자 되돌릴 수 있음판단Agent 판단 기록 없음');
  await sec.getByRole('button', { name: 'Planning Agent 분할 제안' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'TASK-0008 분할 제안을 Planning Agent에 요청했습니다.' })).toBeVisible();
  expect(api.requests('POST /api/tasks/TASK-0008/split')).toHaveLength(1);

  await open(page, '/wbs/TASK-0007');
  const sec7 = page.locator('.sec').filter({ hasText: '분할 근거 · 점검' });
  await expect(sec7).toContainText('이미 시작된 Task는 나누지 않습니다');
  await expect(sec7.getByRole('button', { name: 'Planning Agent 분할 제안' })).toHaveCount(0);
});

test('UAT-RESP-02-TASK 390px: 알림 링크(로그인 필요) → 로그인 → 지정 Task 상세의 핵심 필드·상태·실패 사유·근거를 잘림 없이 읽는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await fakeApi(page, { session: false });
  mountTasks(api, newStore());
  let loggedIn = false;
  api.on('GET /api/session', (route) => (loggedIn ? json(route, 200, SESSION) : json(route, 401, errorBody('LEAD_UNAUTHORIZED'))));
  api.on('POST /api/auth/session', (route) => { loggedIn = true; return route.fulfill({ status: 204 }); });
  await page.goto('/wbs/TASK-0007?tab=verif');
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel('비밀번호').fill('pw');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0007?tab=verif');
  const d = page.getByRole('region', { name: 'Task 상세' });
  await expect(d.getByRole('heading', { level: 2, name: 'WBS Tree UI' })).toBeInViewport();
  await expect(d.locator('.summary .st')).toHaveText('재작업 필요');
  const fail = d.getByRole('article', { name: /FAIL/ });
  await expect(fail).toContainText('결함·재작업 사유');
  await expect(fail).toContainText('DEF-0007-1 필터 결과에서 상위 노드 누락');
  await expect(fail.locator('.ev a').first()).toBeVisible();
  // 잘림 없음: 페이지 가로 넘침 없음, 상세 본문 글자 칸이 화면 안. 원본 열림 효과(0.24초, P L145)가 끝난 뒤 잰다.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
  for (const el of await d.locator('.sum-i, .att-h, .ev, .tabs').all()) {
    const box = await el.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0), `${await el.getAttribute('class') ?? ''} ${JSON.stringify(box)}`).toBeLessThanOrEqual(390);
  }
  await page.screenshot({ path: test.info().outputPath('task-390.png') });
});

for (const width of [1920, 1280] as const) {
  test(`D-28 ${String(width)}px: 9탭 모두 페이지 가로 스크롤 없음`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await open(page, '/wbs/TASK-0004');
    for (const tab of await page.getByRole('tablist', { name: 'Task 상세 탭' }).getByRole('tab').all()) {
      await tab.click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, await tab.innerText()).toBe(0);
    }
  });
}

test('D-28 1280 미만(1100px): 페이지는 넘치지 않고 표 상자만 가로 스크롤', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await open(page, '/wbs/TASK-0004?tab=checklist');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  const table = page.getByRole('table', { name: '체크리스트' });
  const scroll = await table.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }));
  expect(scroll.ox).toBe('auto');
  await expect(table.locator('.gtr').first()).toBeVisible();
});

test('UAT-WIZ-03 일부: 생성 직후 planning Task를 명세 탭으로 열면 차단 안내·이력과 함께 작업 명세가 보인다', async ({ page }) => {
  await open(page, '/wbs/TASK-0011?tab=spec');
  await expect(page.getByRole('tab', { name: /^작업 명세/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.summary .st')).toHaveText('계획 중');
  await expect(page.locator('.dt-head .banner.danger')).toContainText('TASK-0009');
  await expect(page.locator('.appr-bar')).toContainText('착수 승인을 요청합니다');
});
