import { expect, test, type Page } from '@playwright/test';
import { startAcceptance, type Acceptance } from '../../../e2e/acceptance/harness.ts';

let h: Acceptance;
test.skip(!process.env.AWBS_ACCEPTANCE_OUT, 'W e2e -- acceptance로 전용 빈 DB와 함께 실행한다.');
test.beforeAll(async () => { h = await startAcceptance(); });
test.afterAll(async () => { await h?.close(); });

const read = <T>(page: Page, path: string): Promise<T> => page.evaluate(async p => {
  const response = await fetch(`/api/${p}`);
  if (!response.ok) throw new Error(`${p}: ${String(response.status)} ${await response.text()}`);
  return response.json();
}, path) as Promise<T>;

const write = <T>(page: Page, path: string, body: object): Promise<T> => page.evaluate(async ({ path, body }) => {
  const session = await (await fetch('/api/session')).json() as { csrfToken: string };
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json',
    'x-csrf-token': session.csrfToken, 'x-project-epoch': '1', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}, { path, body }) as Promise<T>;

test('최초 설치부터 실제 데이터: 빈 DB → 설정·로그인 → 등록·분석 → WBS → 개발·QA FAIL·재작업·재검증 → 통합·병합 → 보고서', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 500) errors.push(`${response.url()} ${String(response.status())}`); });

  await test.step('UAT-AUTH-01 · 최초 DB·LAN 비밀번호 설정 → 로그인 → 미등록 화면', async () => {
    expect(await h.counts()).toEqual({ projects: 0, tasks: 0, attempts: 0, reports: 0 });
    await h.configurePassword();
    await page.goto('/project');
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('비밀번호').fill(h.password);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(page.getByRole('heading', { name: '프로젝트 등록', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation').getByRole('link', { name: 'WBS', exact: true })).toHaveAttribute('aria-disabled', 'true');
  });

  await test.step('UAT-GITHUB-01 · UAT-POLICY-01 · Runner 연결·모델 보고 → 팀장 허용', async () => {
    await h.connect();
    await page.goto('/settings/agent');
    for (const model of ['claude-sonnet-5-5', 'gpt-6.1-sol']) {
      const row = page.locator('.gtr').filter({ has: page.locator('span.mono', { hasText: model }) });
      await expect(row).toHaveCount(1);
      const allow = row.getByRole('button', { name: '허용', exact: true });
      await expect(allow).toHaveCount(1);
      await allow.click();
    }
    const models = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Agent 실행 정책 — 모델 · Effort' }) });
    await models.getByRole('button', { name: '저장', exact: true }).first().click();
    await expect(page.getByText('허용 모델을 저장했습니다', { exact: false })).toBeVisible();
  });

  await test.step('G§12-30(D-05) · UAT-PROJECT-01/02 · GitHub 확인 → 등록', async () => {
    await page.goto('/project');
    await page.getByLabel('프로젝트 이름').fill('처음부터 만드는 인수 프로젝트');
    await page.getByLabel('GitHub 저장소').fill('https://github.com/o/r');
    await page.getByRole('button', { name: '저장소 접근 확인', exact: true }).click();
    await expect(page.getByTestId('check-line')).toContainText('확인 중');
    await h.repoCheck();
    await expect(page.getByTestId('check-line')).toContainText('접근 확인');
    await expect(page.getByRole('table', { name: '필수 구조' })).toContainText('prototype/docs/');
    await page.getByRole('button', { name: '등록 · 초기 분석 시작', exact: true }).click();
    await expect(page.getByRole('heading', { name: /초기 분석/, level: 1 })).toBeVisible();
    expect(await h.counts()).toEqual({ projects: 1, tasks: 0, attempts: 0, reports: 0 });
  });

  await test.step('G§12-29 · UAT-PROJECT-03/04/06 · 분석 보고 → 기술 결정 확정 → WBS 초안 승인', async () => {
    expect(await h.planning()).toMatchObject({ status: 'done', result: { waiting: 'tech' } });
    await page.reload();
    const tech = page.getByRole('region', { name: '기술 결정 확정' });
    await expect(tech).toContainText('PostgreSQL 16');
    await tech.getByRole('button', { name: '승인', exact: true }).click();
    await tech.getByRole('button', { name: '기술 결정 확정', exact: true }).click();
    await expect(page.getByText('기술 결정을 확정했습니다', { exact: false })).toBeVisible();
    expect(await h.planning()).toMatchObject({ status: 'done', result: { revision: 1, disagreements: [] } });
    await page.reload();
    await expect(page.getByRole('button', { name: '초기 WBS 승인', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '초기 WBS 승인', exact: true }).click();
    await expect(page).toHaveURL('/wbs/TASK-0001');
    await expect(page.getByRole('region', { name: 'Task 상세' })).toContainText('인수 결과 파일 구현');
    expect((await h.counts()).tasks).toBe(2);
    expect((await read<{ state: string }>(page, 'project')).state).toBe('active');
  });

  await test.step('G§12-6 · UAT-EXEC-01/04/05/06 · 실제 Runner 시도 실행·증거 수집·QA 실패·등급 상향', async () => {
    await page.goto('/exec/TASK-0001');
    await page.getByRole('button', { name: 'Claude 개발 실행 요청', exact: true }).click();
    await expect.poll(h.queuedAttempts).toBe(1);
    expect(await h.attempt()).toBe('dev');
    expect(await h.attempt()).toBe('qa');
    await page.reload();
    await expect(page.getByLabel('선택 Task 실행')).toContainText('FAIL');
    await h.qaPass();
    expect(await h.attempt()).toBe('rework');
    expect(await h.attempt()).toBe('reverify');
    await page.reload();
    await expect(page.getByLabel('선택 Task 실행')).toContainText('PASS');
    const attempts = await read<{ items: { kind: string; effort: string; status: string }[] }>(page, 'tasks/TASK-0001/attempts?limit=200');
    expect(attempts.items.map(a => a.kind).sort()).toEqual(['dev', 'qa', 'reverify', 'rework']);
    expect(attempts.items.find(a => a.kind === 'rework')?.effort).toBe('xhigh');
    expect(attempts.items.every(a => a.status === 'completed')).toBe(true);
  });

  await test.step('UAT-GATE-01/02 · UAT-CI-02 · ①·②와 실제 fake GitHub 병합 뒤에만 완료', async () => {
    expect((await read<{ lifecycleStatus: string }>(page, 'tasks/TASK-0001')).lifecycleStatus).toBe('gate');
    expect(await h.integrate()).toBe('merged');
    await expect.poll(async () => (await read<{ lifecycleStatus: string }>(page, 'tasks/TASK-0001')).lifecycleStatus).toBe('done');
    await page.goto('/ci');
    await expect(page.getByRole('heading', { level: 1, name: '빌드 · 통합' })).toBeVisible();
    expect(h.merged()).toBe(1);
    expect(await h.openHolds()).toBe(0);
  });

  await test.step('G§12-16 · UAT-REPORT-01/03/06 · 방금 만든 데이터로 보고서·PDF 생성', async () => {
    await page.goto('/report');
    await expect(page.getByText('아직 보고서가 없습니다.', { exact: true })).toBeVisible();
    const form = page.getByRole('region', { name: '기간 지정 보고서' });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    await form.getByLabel('시작일').fill(today);
    await form.getByLabel('종료일').fill(today);
    await form.getByRole('button', { name: '보고서 생성', exact: true }).click();
    const doc = page.getByRole('article');
    await expect(doc).toContainText('인수 결과 파일 구현');
    await expect(doc.locator('.rpt-kpi').first().locator('.rpt-kv')).toHaveText('1건');
    await expect(doc.locator('.rpt-kpi').first().locator('.rpt-ks')).toHaveText('누적 1 / 2건');
    const id = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    const report = await read<{ snapshot: { summary: { doneCount: number; taskCount: number } } }>(page, `reports/${id}`);
    expect(report.snapshot.summary).toMatchObject({ doneCount: 1, taskCount: 2 });
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
    const pdf = await downloaded;
    expect(pdf.suggestedFilename()).toBe('RPT-C-001_팀장용.pdf');
    await pdf.saveAs(h.output('report.pdf'));
    await page.getByRole('group', { name: '보고서 보기' }).getByRole('button', { name: '보고용 (요약)', exact: true }).click();
    await expect(doc.getByRole('heading', { name: '요약', exact: true })).toBeVisible();
    await expect(doc.locator('.rpt-kpi').first().locator('.rpt-kv')).toHaveText('1건');
    await expect(doc.locator('.rpt-kpi').first().locator('.rpt-ks')).toHaveText('누적 1 / 2건');
    await page.screenshot({ path: h.output('first-run-report.png'), fullPage: true });
    expect((await h.counts()).reports).toBe(1);
  });
  await test.step('D-27 · UAT-TASK-06 · 취소 CP 미리보기와 실제 차단 해제가 같고, 다른 선행이 남으면 계속 차단한다', async () => {
    const project = await read<{ id: string }>(page, 'project');
    const list = await read<{ nodes: { id: string; kind: string }[] }>(page, `projects/${project.id}/tasks`);
    const wp = list.nodes.find(n => n.kind === 'work_package');
    expect(wp).toBeDefined();
    const create = (title: string) => write<{ taskKey: string }>(page, `projects/${project.id}/tasks`, { title, wbsNodeId: wp?.id, workType: 'Implementation', primaryDomain: 'BE' });
    const remaining = await create('남은 FS 선행');
    const free = await create('SS 취소 뒤 차단 해제');
    const blocked = await create('다른 FS 선행으로 계속 차단');
    for (const [pred, succ, type] of [['TASK-0002', free.taskKey, 'SS'], ['TASK-0002', blocked.taskKey, 'SS'], [remaining.taskKey, blocked.taskKey, 'FS']] as const) {
      const task = await read<{ updatedAt: string }>(page, `tasks/${succ}`);
      await write(page, `tasks/${succ}/dependencies`, { updatedAt: task.updatedAt, predTaskKey: pred, depType: type });
    }
    expect((await read<{ blocked: boolean }>(page, `tasks/${free.taskKey}`)).blocked).toBe(true);
    const cp = await write<{ id: string; cpKey: string; updatedAt: string }>(page, 'proposals', {
      title: 'D-27 시작 전 SS 선행 취소', reason: '미리보기와 실제 반영 대조', source: { kind: 'manual' }, ops: [{ op: 'remove', task: 'TASK-0002' }],
    });
    await page.goto(`/change/${cp.cpKey}`);
    await expect(page.getByRole('region', { name: '영향 분석' })).toContainText(free.taskKey);
    const stillBlocked = page.getByRole('region', { name: '영향 분석' }).locator('.gtr[data-unblocked="false"]').filter({ hasText: blocked.taskKey });
    await expect(stillBlocked).toContainText(`계속 차단 — 남은 선행 ${remaining.taskKey} (FS, 계획 중)`);
    let version = cp.updatedAt;
    for (const action of ['submit', 'approve', 'apply']) {
      const preview = await read<{ previewHash: string }>(page, `proposals/${cp.id}/preview`);
      const saved = await write<{ updatedAt: string }>(page, `proposals/${cp.id}/${action}`, { updatedAt: version, ...(action !== 'submit' && { previewHash: preview.previewHash }) });
      version = saved.updatedAt;
    }
    const cancelled = await read<{ lifecycleStatus: string }>(page, 'tasks/TASK-0002');
    expect(cancelled.lifecycleStatus).toBe('cancelled');
    const freed = await read<{ blocked: boolean; predecessors: { pred: string; type: string }[] }>(page, `tasks/${free.taskKey}`);
    expect(freed.blocked).toBe(false);
    expect(freed.predecessors).toEqual([]);
    const still = await read<{ blocked: boolean; predecessors: { pred: string; type: string }[] }>(page, `tasks/${blocked.taskKey}`);
    expect(still.blocked).toBe(true);
    expect(still.predecessors.map(p => ({ pred: p.pred, type: p.type }))).toEqual([{ pred: remaining.taskKey, type: 'FS' }]);
    await page.reload();
    await expect(page.locator('.cp-detail .cps')).toHaveText('WBS 반영 완료');
  });
  expect(errors).toEqual([]);
});
