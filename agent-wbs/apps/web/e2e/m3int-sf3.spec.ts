/**
 * M3 통합 — 서버 후속 3차(srv-followup3, origin/main 4b1de9e) API에 연결한 화면(가짜 API).
 * 실제 서버 확인은 api-m3int.spec.ts(e2e:api:m3int).
 */
import { expect, test } from '@playwright/test';
import { fakeApi, json } from './support/fake-api.ts';
import { execApi } from './support/exec-fixtures.ts';
import { installM307, m307Data } from './support/m307-data.ts';
import { GITHUB, settingsApi } from './support/settings-fixtures.ts';

const VIOLATIONS = {
  count: 2,
  items: [
    { taskKey: 'TASK-0005', title: 'Task CRUD API', wbs: '2.1.1', violations: 1, suspicions: 0, cautions: 0, exceptions: 0, approvalHolds: [],
      items: [{ rule: 'maxH', label: '최대 시간', mode: 'auto', status: '위반', detail: '6h > 4h', judgement: null }, { rule: 'files', label: '파일 수', mode: 'auto', status: '통과', detail: '', judgement: null }] },
    { taskKey: 'TASK-0007', title: 'WBS Tree UI', wbs: '2.2.1', violations: 0, suspicions: 1, cautions: 0, exceptions: 0, approvalHolds: [],
      items: [{ rule: 'contract', label: '계약 분리', mode: 'judge', status: '의심', detail: '', judgement: 'missing' }] },
  ],
};

test('일정 · Task 탭: 「기준을 벗어난 Task」 목록과 탭 배지는 GET /api/settings/split/violations 값 그대로(원본 P L2470·L6660)', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  api.on('GET /api/settings/split/violations', (route) => json(route, 200, VIOLATIONS));
  await page.goto('/settings/plan');
  await expect(page.getByRole('navigation', { name: '설정 영역' }).getByRole('link', { name: /일정 · Task/ })).toContainText('2');
  const rows = page.locator('.rpt-li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('위반 1TASK-00052.1.1Task CRUD API위반 · 최대 시간');
  await expect(rows.nth(1)).toContainText('의심 1');
  await expect(rows.nth(0).getByRole('link', { name: 'TASK-0005' })).toHaveAttribute('href', '/wbs/TASK-0005?tab=overview');
});

test('일정 · Task 탭: 위반이 없으면 원본 안내 문구', async ({ page }) => {
  settingsApi(await fakeApi(page));
  await page.goto('/settings/plan');
  await expect(page.getByText('없습니다 — 모든 Task가 분할 기준을 지킵니다 (예외 기록 포함).')).toBeVisible();
});

test('Agent 탭: 팀장 고정 Task·모델별 사용 Task·하위 Agent 지정/마지막 사용/재작업률(GET /api/settings/agent-usage)', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  api.on('GET /api/settings/agent-usage', (route) => json(route, 200, {
    lockedTasks: [
      { taskKey: 'TASK-0004', title: 'Drizzle Schema 설계', role: 'dev', agent: 'Claude', modelId: 'claude-opus-4-7', effort: 'high' },
      { taskKey: 'TASK-0004', title: 'Drizzle Schema 설계', role: 'qa', agent: 'Codex', modelId: 'gpt-5.5', effort: 'high' },
    ],
    models: [{ agent: 'Claude', modelId: 'claude-opus-4-7', taskKeys: ['TASK-0004', 'TASK-0005'] }],
    subagents: [{ id: 'db-migration-reviewer', defKey: 'db-migration-reviewer', version: 1, taskKeys: ['TASK-0004'], lastTaskKey: 'TASK-0004', lastAttemptKey: 'ATT-0004-1', lastUsedAt: '2026-11-03T06:00:00.000Z', decisions: 3, failures: 1, reworkRate: 1 / 3 }],
  }));
  await page.goto('/settings/agent');
  const locked = page.locator('.frow').filter({ hasText: '팀장 고정 Task' });
  await expect(locked.getByRole('link')).toHaveCount(1);
  await expect(locked.getByRole('link', { name: 'TASK-0004 Drizzle Schema 설계' })).toHaveAttribute('href', '/wbs/TASK-0004?tab=overview');
  await expect(page.getByRole('region', { name: 'Claude 모델 표' })).toContainText('사용 중 Task 2건');
  const sa = page.getByRole('region', { name: '하위 Agent 정의 표' });
  await expect(sa).toContainText('1건');
  await expect(sa).toContainText('ATT-0004-1');
  await expect(sa).toContainText('33% (1/3)');
  await expect(sa).toContainText('판정 전');
});

test('Runner 탭: 「다시 점검」은 POST /api/settings/readiness/check(202)만 보내고, GitHub 확인 시각은 서버 checkedAt', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  api.on('GET /api/settings/github', (route) => json(route, 200, { ...GITHUB, checkedAt: '2026-11-05T10:30:00.000Z' }));
  api.on('POST /api/settings/readiness/check', (route) => json(route, 202, { readinessCheckRequest: 4 }));
  await page.goto('/settings/runner');
  await expect(page.getByTestId('gh-checked-at')).toHaveText('마지막 확인 2026-11-05 19:30');
  await page.getByRole('button', { name: '다시 점검' }).click();
  await expect(page.getByText('다시 점검을 요청했습니다 — Runner가 점검해 보고하면 결과와 점검 시각이 바뀝니다.')).toBeVisible();
  expect(api.requests('POST /api/settings/readiness/check')[0]?.headers()['idempotency-key']).toBeTruthy();
});

test('작업 실행: 자동 재시도·재작업 한도 안내는 설정(autoRetryLimit·autoReworkLimit)을 따른다', async ({ page }) => {
  const api = await execApi(page);
  api.on('GET /api/settings/exec-policy', (route) => json(route, 200, { autoRetryLimit: 4, autoReworkLimit: 5, floors: { verifyGeDev: true, dbHigh: true }, onUsage: 'wait', lowPct: 20, onRework: 'up1', notifyAt: 2, updatedAt: '2026-11-05T01:00:00.000Z' }));
  await page.goto('/exec/TASK-0007');
  await expect(page.getByText(/자동 재작업 \d+\/5회|자동 재작업 한도\(5회\)/)).toBeVisible();
});

test('대시보드: 서버 표시 번호(planningKey·cpKey·attemptKey·verificationKey)가 있으면 원본처럼 번호를 보인다', async ({ page }) => {
  const api = await fakeApi(page);
  const data = m307Data();
  const dash = data.dashboard as unknown as { panels: { approvals: Record<string, unknown>[]; executions: Record<string, unknown>[] }; recent: Record<string, unknown>[] };
  dash.panels.approvals = dash.panels.approvals.map((a) => (a.kind === 'planning' ? { ...a, planningKey: 'PLN-001' } : { ...a, cpKey: 'CP-002' }));
  dash.panels.executions = dash.panels.executions.map((x) => (x.kind === 'running' ? { ...x, attemptKey: 'ATT-0004-2' } : x));
  dash.recent = dash.recent.map((r) => (r.kind === 'attempt' ? { ...r, attemptKey: 'ATT-0007-2' } : { ...r, verificationKey: 'V-0007-1' }));
  installM307(api, data);
  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: /PLN-001/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /CP-002/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /ATT-0004-2/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /V-0007-1/ }).first()).toBeVisible();
});
