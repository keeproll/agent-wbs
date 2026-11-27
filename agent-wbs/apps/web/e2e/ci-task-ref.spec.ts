/**
 * UAT-TASK-10-CI(M7-05): Task 상세 실행 탭의 CI 참조(「Task 검사 … · CI-xxxx」, 원본 P L1310)를 누르면
 * 그 시도가 참조한 CI 실행의 상세로 가고, CI ID·Task·시도 연결이 선택한 기록과 일치한다.
 */
import { expect, test } from '@playwright/test';
import { fakeApi } from './support/fake-api.ts';
import { ciData, installCi } from './support/ci-data.ts';
import { mountTasks } from './support/task-api.ts';

const uuid = (key: string) => `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`;

test('UAT-TASK-10-CI: 실행 탭의 CI 참조는 그 시도의 최신 Task 검사 상세를 연다', async ({ page }) => {
  const api = await fakeApi(page);
  mountTasks(api);
  const data = ciData();
  // TASK-0004의 첫 시도(ATT-0004-1): CI-0124 실패 → CI-0125 통과(최신). 다른 시도·다른 단계 기록은 참조가 아니다.
  for (const r of data.runs) if (r.taskKey === 'TASK-0004' && r.attemptId) r.attemptId = uuid('ATT-0004-1');
  installCi(api, data, { tasks: false });
  await page.goto('/wbs/TASK-0004?tab=exec');
  const att = page.getByRole('article', { name: '실행 ATT-0004-1' });
  const ref = att.getByRole('link', { name: 'Task 검사 통과 · CI-0125' });
  await expect(ref).toHaveAttribute('href', '/ci/ci-0125');
  await expect(ref).toHaveClass(/sc-ok/);
  expect(api.calls().some((c) => c.startsWith('GET /api/projects/p1/ci/runs?') && c.includes('taskKey=TASK-0004'))).toBe(true);
  await ref.click();
  await expect(page).toHaveURL('/ci/ci-0125');
  const detail = page.getByRole('region', { name: 'CI-0125 실행 상세' });
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('CI-0125');
  await expect(detail.getByRole('link', { name: 'TASK-0004' })).toHaveAttribute('href', '/wbs/TASK-0004');
  await expect(detail.getByRole('link', { name: 'ATT-0004-1' })).toHaveAttribute('href', `/exec/TASK-0004?att=${uuid('ATT-0004-1')}`);
});

test('UAT-TASK-10-CI: 최신 Task 검사가 실패면 실패 색, 참조가 없는 시도에는 CI 표시가 없다', async ({ page }) => {
  const api = await fakeApi(page);
  mountTasks(api);
  const data = ciData();
  data.runs = data.runs.filter((r) => r.runKey !== 'CI-0125');
  for (const r of data.runs) if (r.taskKey === 'TASK-0004' && r.attemptId) r.attemptId = uuid('ATT-0004-1');
  installCi(api, data, { tasks: false });
  await page.goto('/wbs/TASK-0004?tab=exec');
  const ref = page.getByRole('article', { name: '실행 ATT-0004-1' }).getByRole('link', { name: 'Task 검사 실패 · CI-0124' });
  await expect(ref).toHaveClass(/sc-bad/);
  await expect(page.getByRole('article', { name: '실행 ATT-0004-2' }).getByRole('link', { name: /Task 검사/ })).toHaveCount(0);
});
