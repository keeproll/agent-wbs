/**
 * M3-06 작업 실행 3분할·메시지 E2E(가짜 API·가짜 Runner 보고). 완료 조건: `W e2e -- exec`.
 * UAT: EXEC-UI, EXEC-09, MSG-01, MSG-UI, EMPTY-03, TASK-10(b), SHELL-04-UI(자동 부분).
 * 시나리오(G§12): 7(실행 중 추가 지시 → 다음 실행 대기 → 다음 실행 때 ack → 응답), 8(끊김 → 전달 실패 → 재연결 → 재전송),
 * 6은 Gate 대기까지만(fake 흐름은 실제 병합·완료를 판정하지 않는다).
 */
import { expect, test, type Page } from '@playwright/test';
import { errorBody, json } from './support/fake-api.ts';
import { attempt, execApi, message, runnerState, summary, verification, type ExecApi } from './support/exec-fixtures.ts';

const center = (page: Page) => page.getByLabel('선택 Task 실행');
const rail = (page: Page) => page.getByRole('complementary', { name: 'Task 및 실행 목록' });
const msgs = (page: Page) => page.getByRole('complementary', { name: '연결 메시지' });
const nextBox = (page: Page) => center(page).locator('.next');

async function open(page: Page, path: string, setup?: (api: ExecApi) => void) {
  const api = await execApi(page);
  setup?.(api);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: '작업 실행', level: 1 })).toBeVisible();
  return api;
}

test.describe('UAT-EXEC-UI 3영역·6단계·다음 작업', () => {
  test('a) 왼쪽 Task·시도 / 가운데 다음 작업·기록 / 오른쪽 메시지, 6단계와 현재 단계, 실제 등급', async ({ page }) => {
    await open(page, '/exec/TASK-0005');
    await expect(rail(page).getByRole('button', { name: /TASK-0001 완료 Monorepo 구성/ })).toBeVisible();
    await expect(rail(page).getByRole('button', { name: /ATT-0005-1 개발 · Claude 실행 중/ })).toBeVisible();
    // 계획 중 Task는 실행 목록에 없다(P exVM L6022)
    await expect(rail(page).getByText('TASK-0009')).toHaveCount(0);
    await expect(center(page).getByRole('heading', { name: 'Task CRUD API' })).toBeVisible();
    const steps = center(page).getByRole('list', { name: '실행 단계' }).getByRole('listitem');
    await expect(steps).toHaveText(['1Claude 개발', '2Codex QA', '3Claude 재작업', '4Codex 재검증', '5Completion Gate', '6Task 완료']);
    await expect(steps.nth(0)).toHaveClass('cur');
    await expect(nextBox(page)).toContainText('ATT-0005-1 개발 실행 중 — Runner 결과 보고를 기다립니다.');
    const card = page.getByLabel('ATT-0005-1 실행 기록');
    await expect(card).toContainText('Opus 5.5 · 높음');
    await expect(card).toContainText('2026-11-03 19:58 – 진행 중');
    await expect(card).toContainText('apps/api/src/routes/tasks.ts');
    await expect(msgs(page)).toContainText('TASK-0005 전체 메시지');
    await expect(msgs(page)).toContainText('연결된 메시지가 없습니다.');
  });

  test('a) 등급 조정 근거(상향)를 보고값대로 표시', async ({ page }) => {
    await open(page, '/exec/TASK-0007?att=ATT-0007-3', (api) => {
      api.state.attempts['TASK-0007']?.push(attempt('ATT-0007-3', 'TASK-0007', 'rework', 'running', '2026-11-02T00:00:00.000Z', {
        modelId: 'Opus 5.5', effort: '최고', gradeAdjust: { kind: 'up', from: { model: 'Opus 5.5', effort: '높음' }, to: { model: 'Opus 5.5', effort: '최고' }, reason: '재작업 정책 「최상위로 상향」' },
      }));
    });
    const card = page.getByLabel('ATT-0007-3 실행 기록');
    await expect(card).toContainText('등급 상향 Opus 5.5 · 높음 → Opus 5.5 · 최고 — 재작업 정책 「최상위로 상향」');
    await expect(center(page).getByRole('list', { name: '실행 단계' }).getByRole('listitem').nth(2)).toHaveClass('cur');
  });

  test('b) 첫 시작은 팀장 요청으로만 — 선행 차단이면 막고, 요청은 kind=dev, API 보류 사유를 그대로 보인다', async ({ page }) => {
    const api = await open(page, '/exec/TASK-0006');
    const start = nextBox(page).getByRole('button', { name: 'Claude 개발 실행 요청' });
    await expect(start).toBeDisabled();
    await expect(center(page)).toContainText('선행 Task 차단 — 선행 조건이 충족되어야 실행할 수 있습니다.');
    // 화면을 연 것만으로 실행 요청을 보내지 않는다
    expect(api.calls().filter((c) => c.startsWith('POST'))).toEqual([]);

    const t6 = api.state.tasks.find((t) => t.taskKey === 'TASK-0006');
    if (t6) t6.blocked = false;
    api.on('POST /api/tasks/TASK-0006/runs', (route) => json(route, 409, errorBody('CLAIM_REJECTED', { message: 'Codex 사용량 한도로 새 실행을 보류합니다.', fix: '리셋 뒤 다시 요청하세요.' })));
    await page.reload();
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page.getByRole('alert')).toContainText('Codex 사용량 한도로 새 실행을 보류합니다.');
    const body = api.requests('POST /api/tasks/TASK-0006/runs')[0]?.postDataJSON() as unknown;
    expect(body).toEqual({ updatedAt: '2026-11-03T10:58:00.000Z', kind: 'dev' });

    api.on('POST /api/tasks/TASK-0006/runs', (route) => json(route, 202, { jobId: 'job-1' }));
    await start.click();
    await expect(page.getByText('실행을 요청했습니다.', { exact: false })).toBeVisible();
  });

  test('b) Runner 끊김이면 버튼을 막고 이유를 보인다(UI-06-offline)', async ({ page }) => {
    await open(page, '/exec/TASK-0006', (api) => {
      api.state.runner = runnerState({ connection: { online: false, runnerId: null, version: null, lastHeartbeatAt: null, sessionStartedAt: null } });
      const t = api.state.tasks.find((x) => x.taskKey === 'TASK-0006');
      if (t) t.blocked = false;
    });
    await expect(nextBox(page).getByRole('button', { name: 'Claude 개발 실행 요청' })).toBeDisabled();
    await expect(center(page)).toContainText('Runner 연결 끊김 — 재연결 후 실행합니다.');
  });

  test('c) 실패 사유·FAIL 검증의 명령/결과/Evidence/결함, 이전 시도 보존', async ({ page }) => {
    await open(page, '/exec/TASK-0007?att=ATT-0007-2', (api) => {
      api.on('GET /api/evidence', (route) => json(route, 200, { items: [
        { id: 'ev1', taskKey: 'TASK-0007', attemptId: 'att-ATT-0007-2', verificationId: 'V-0007-1', checklistItemKey: null, kind: 'vitest.txt', sha256: 'b'.repeat(64), size: 10 },
      ], nextCursor: null }));
    });
    const card = page.getByLabel('ATT-0007-2 실행 기록');
    await expect(card.locator('.vbox')).toContainText('V-0007-1');
    await expect(card.locator('.vf.v-fail')).toHaveText('FAIL');
    await expect(card).toContainText('pnpm --filter web test -- wbs-tree');
    await expect(card).toContainText('12/14 통과');
    await expect(card.getByRole('link', { name: /vitest.txt · bbbbbbbbbbbb/ })).toHaveAttribute('href', '/api/evidence/ev1/content');
    await expect(card).toContainText('DEF-0007-1 필터 결과에서 상위 노드 누락 (차단 결함)');
    await expect(center(page).getByRole('list', { name: '실행 단계' }).getByRole('listitem').nth(1)).toHaveClass('fail');
    // 이전 시도도 그대로 고를 수 있다
    await rail(page).getByRole('button', { name: /ATT-0007-1/ }).click();
    await expect(page).toHaveURL(/att=ATT-0007-1/);
    await expect(page.getByLabel('ATT-0007-1 실행 기록')).toContainText('WBS 트리 구현.');
  });

  test('c) 실행 실패: 자동 재시도 중은 버튼 없음, 한도 초과(failed)면 재실행 1회 버튼', async ({ page }) => {
    const api = await open(page, '/exec/TASK-0008', (a) => {
      const t = a.state.tasks.find((x) => x.taskKey === 'TASK-0008');
      if (t) { t.blocked = false; t.lifecycleStatus = 'running'; }
      a.state.attempts['TASK-0008'] = [attempt('ATT-0008-1', 'TASK-0008', 'dev', 'failed', '2026-11-04T00:00:00.000Z', { failure: 'CLI 종료 코드 1' })];
    });
    await expect(nextBox(page)).toContainText('ATT-0008-1 개발 실패 — CLI 종료 코드 1. 서버가 자동으로 다시 시도합니다 (연속 실패 1/3회).');
    await expect(nextBox(page).getByRole('button')).toHaveCount(0);
    await expect(page.getByLabel('ATT-0008-1 실행 기록')).toContainText('실패 사유 — CLI 종료 코드 1');

    const t = api.state.tasks.find((x) => x.taskKey === 'TASK-0008');
    if (t) t.lifecycleStatus = 'failed';
    api.state.alerts = [{ id: 'al1', key: 'retry:att-ATT-0008-1', severity: 'warn', taskKey: 'TASK-0008', target: null, text: '실행 실패의 자동 재시도 한도를 넘었습니다.', at: '2026-11-04T01:00:00.000Z' }];
    api.on('POST /api/tasks/TASK-0008/runs', (route) => json(route, 202, { jobId: 'job-2' }));
    await page.reload();
    await expect(center(page).getByRole('note')).toContainText('팀장 확인 필요');
    await expect(center(page).getByRole('note')).toContainText('실행 실패의 자동 재시도 한도를 넘었습니다.');
    await nextBox(page).getByRole('button', { name: '개발 재실행 요청' }).click();
    await expect.poll(() => api.requests('POST /api/tasks/TASK-0008/runs').length).toBe(1);
  });

  test('c) BLOCKED는 자동 반복하지 않고 팀장 QA 요청', async ({ page }) => {
    const api = await open(page, '/exec/TASK-0004', (a) => {
      const list = a.state.attempts['TASK-0004'];
      const qa = list?.[1];
      if (!qa) throw new Error('fixture');
      qa.status = 'completed';
      a.state.verifications['TASK-0004'] = [verification('V-0004-1', qa, 'BLOCKED', { actual: 'DB 컨테이너 기동 실패' })];
    });
    await expect(nextBox(page)).toContainText('V-0004-1 BLOCKED — 차단 원인을 해결한 뒤 Codex QA를 요청합니다.');
    api.on('POST /api/tasks/TASK-0004/runs', (route) => json(route, 202, { jobId: 'job-3' }));
    await nextBox(page).getByRole('button', { name: 'Codex QA 요청' }).click();
    await expect.poll(() => api.requests('POST /api/tasks/TASK-0004/runs')[0]?.postDataJSON() as unknown).toEqual({ updatedAt: '2026-11-03T10:58:00.000Z', kind: 'qa' });
  });

  test('d) 자동 재작업 카운터, 한도 초과 알림 → 재작업 지시(메시지 기록 + 재작업 실행)', async ({ page }) => {
    const api = await open(page, '/exec/TASK-0007');
    await expect(nextBox(page)).toContainText('V-0007-1 FAIL — 서버가 실패 항목을 Claude에게 전달하고 재작업을 새 시도로 자동 실행합니다 (자동 재작업 1/3회)');
    await expect(nextBox(page).getByRole('button')).toHaveCount(0);

    api.state.alerts = [{ id: 'al2', key: 'rework-limit:id-TASK-0007', severity: 'warn', taskKey: 'TASK-0007', target: null, text: '자동 재작업 한도를 넘었습니다.', at: '2026-11-04T01:00:00.000Z' }];
    api.on('POST /api/messages', (route) => json(route, 201, message('MSG-010', 'TASK-0007', { type: '수정 요청', body: '필터 상위 노드 유지', updatedAt: '2026-11-05T11:00:00.000Z' })));
    api.on('POST /api/messages/msg-MSG-010/send', (route) => json(route, 200, message('MSG-010', 'TASK-0007', { type: '수정 요청', delivery: 'Queued' })));
    api.on('POST /api/tasks/TASK-0007/runs', (route) => json(route, 202, { jobId: 'job-4' }));
    await page.reload();
    await nextBox(page).getByRole('button', { name: '재작업 지시 작성' }).click();
    const send = page.getByRole('button', { name: '지시 전송 후 재작업 실행' });
    await expect(send).toBeDisabled();
    await page.getByLabel('재작업 지시 내용').fill('필터 상위 노드 유지');
    await send.click();
    await expect(page.getByText('재작업 지시를 보내고 재작업 실행을 요청했습니다.')).toBeVisible();
    expect(api.requests('POST /api/messages')[0]?.postDataJSON()).toEqual({ taskKey: 'TASK-0007', type: '수정 요청', toAgent: 'Claude', body: '필터 상위 노드 유지', attemptId: 'att-ATT-0007-2' });
    expect(api.requests('POST /api/tasks/TASK-0007/runs')[0]?.postDataJSON()).toEqual({ updatedAt: '2026-11-03T10:58:00.000Z', kind: 'rework' });
    // 같은 바탕 키에서 나온 서로 다른 멱등 키
    const keys = [api.requests('POST /api/messages')[0], api.requests('POST /api/messages/msg-MSG-010/send')[0], api.requests('POST /api/tasks/TASK-0007/runs')[0]]
      .map((r) => r?.headers()['idempotency-key'] ?? '');
    expect(new Set(keys).size).toBe(3);
    expect(keys.map((k) => k.split('.')[0])).toEqual([keys[0]?.split('.')[0], keys[0]?.split('.')[0], keys[0]?.split('.')[0]]);
  });

  test('d) 재작업 지시 편집 보호·409 충돌 창', async ({ page }) => {
    const api = await open(page, '/exec/TASK-0007', (a) => {
      a.state.alerts = [{ id: 'al2', key: 'rework-limit:id-TASK-0007', severity: 'warn', taskKey: 'TASK-0007', target: null, text: '자동 재작업 한도를 넘었습니다.', at: '2026-11-04T01:00:00.000Z' }];
    });
    await nextBox(page).getByRole('button', { name: '재작업 지시 작성' }).click();
    await page.getByLabel('재작업 지시 내용').fill('다시');
    await rail(page).getByRole('button', { name: /TASK-0005/ }).first().click();
    await expect(page.getByRole('alertdialog', { name: '편집 내용 버리기' })).toBeVisible();
    await page.getByRole('button', { name: '취소' }).last().click();
    await expect(page.getByLabel('재작업 지시 내용')).toHaveValue('다시');

    api.on('POST /api/messages', (route) => json(route, 201, message('MSG-011', 'TASK-0007', { type: '수정 요청', body: '다시' })));
    api.on('POST /api/messages/msg-MSG-011/send', (route) => json(route, 200, message('MSG-011', 'TASK-0007', { delivery: 'Queued' })));
    api.on('POST /api/tasks/TASK-0007/runs', (route) => json(route, 409, errorBody('VERSION_CONFLICT', { message: '다른 곳에서 먼저 바뀌었습니다.' })));
    await page.getByRole('button', { name: '지시 전송 후 재작업 실행' }).click();
    await expect(page.getByRole('alertdialog').filter({ hasText: '최신' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('재작업 지시 내용')).toHaveValue('다시');
  });

  test('e) fake 흐름은 Gate 대기에서 멈춘다 — 서버 판정 전에는 완료를 만들지 않는다', async ({ page }) => {
    const api = await open(page, '/exec/TASK-0007', (a) => {
      const list = a.state.attempts['TASK-0007'] ?? [];
      const rw = attempt('ATT-0007-3', 'TASK-0007', 'rework', 'completed', '2026-11-02T00:00:00.000Z');
      const rv = attempt('ATT-0007-4', 'TASK-0007', 'reverify', 'completed', '2026-11-02T03:00:00.000Z');
      list.push(rw, rv);
      a.state.verifications['TASK-0007']?.push(verification('V-0007-2', rv, 'PASS'));
      const t = a.state.tasks.find((x) => x.taskKey === 'TASK-0007');
      if (t) t.lifecycleStatus = 'gate';
      a.state.gates['TASK-0007'] = { taskKey: 'TASK-0007', passed: false, conditions: [
        { key: 'checklist', result: 'PASS', reason: '필수 항목 모두 완료' },
        { key: 'outputs', result: 'PASS', reason: '필수 산출물 2건 제출' },
        { key: 'verification', result: 'PASS', reason: '최근 검증 PASS' },
        { key: 'defects', result: 'FAIL', reason: '차단 결함 1건 미해결' },
        { key: 'approval', result: 'PASS', reason: '착수 승인 완료' },
      ] };
    });
    const steps = center(page).getByRole('list', { name: '실행 단계' }).getByRole('listitem');
    await expect(steps.nth(4)).toHaveClass('cur');
    await expect(steps.nth(5)).toHaveClass('');
    await expect(center(page)).toContainText('미해결 차단 결함 없음');
    await expect(center(page)).toContainText('차단 결함 1건 미해결');
    await expect(center(page).getByRole('button', { name: '완료 판정 다시 요청' })).toBeDisabled();
    await expect(center(page).locator('.st').first()).toHaveText('Gate 대기');
    expect(api.calls().filter((c) => c.includes('/complete'))).toEqual([]);
  });
});

test.describe('UAT-EXEC-09 중단·재개', () => {
  test('중단 시도 보존·paused, 보유 미해제면 재개 거부 사유, 해제 뒤 같은 단계·등급의 새 시도', async ({ page }) => {
    const api = await open(page, '/exec/TASK-0005', (a) => {
      const att = a.state.attempts['TASK-0005']?.[0];
      if (!att) throw new Error('fixture');
      Object.assign(att, { status: 'interrupted', endedAt: '2026-11-03T11:03:00.000Z', failure: 'Runner 수동 중지 — 실행이 끊겨 재개가 필요합니다' });
      const t = a.state.tasks.find((x) => x.taskKey === 'TASK-0005');
      if (t) t.lifecycleStatus = 'paused';
      a.state.runner = runnerState({ unconfirmedHolds: [{ jobId: 'j1', taskKey: 'TASK-0005', hostId: 'h1', slots: 1 }] });
    });
    await expect(center(page).locator('.st').first()).toHaveText('중단 · 재개 대기');
    await expect(page.getByLabel('ATT-0005-1 실행 기록')).toContainText('중단 사유 — Runner 수동 중지');
    await expect(rail(page).getByRole('button', { name: /ATT-0005-1 개발 · Claude 중단/ })).toBeVisible();
    await expect(nextBox(page)).toContainText('ATT-0005-1 개발 중단 — Runner 수동 중지 — 실행이 끊겨 재개가 필요합니다. 같은 작업을 새 실행 시도로 이어서 진행합니다 (기존 시도 기록 보존).');
    await expect(center(page)).toContainText('프로세스 종료를 확인하지 못했습니다');

    api.on('POST /api/attempts/att-ATT-0005-1/resume', (route) => json(route, 409, errorBody('CLAIM_REJECTED', { message: '이전 실행의 프로세스 종료가 확인되지 않아 재개할 수 없습니다.' })));
    const resume = nextBox(page).getByRole('button', { name: 'Claude 개발 재개 요청' });
    await resume.click();
    await expect(page.getByRole('alert')).toContainText('이전 실행의 프로세스 종료가 확인되지 않아 재개할 수 없습니다.');

    // 해제 보고 뒤 재개: 서버가 새 시도를 만든다
    api.state.runner = runnerState();
    api.on('POST /api/attempts/att-ATT-0005-1/resume', (route) => {
      api.state.attempts['TASK-0005']?.push(attempt('ATT-0005-2', 'TASK-0005', 'dev', 'running', '2026-11-05T10:00:00.000Z', { resumedFrom: 'att-ATT-0005-1' }));
      const t = api.state.tasks.find((x) => x.taskKey === 'TASK-0005');
      if (t) t.lifecycleStatus = 'running';
      return json(route, 202, { jobId: 'job-5' });
    });
    await page.getByRole('alert').getByRole('button', { name: '닫기' }).click();
    await resume.click();
    await expect(page.getByText('재개를 요청했습니다.', { exact: false })).toBeVisible();
    await expect(rail(page).getByRole('button', { name: /ATT-0005-2 개발 · Claude 실행 중/ })).toBeVisible();
    await expect(rail(page).getByRole('button', { name: /ATT-0005-1 개발 · Claude 중단/ })).toBeVisible();
    const card = page.getByLabel('ATT-0005-2 실행 기록');
    await expect(card).toContainText('Opus 5.5 · 높음');
    await expect(card).toContainText('중단은 재시도 · 재작업 횟수에 넣지 않습니다');
  });

  test('실행 중단은 확인 뒤에만 보낸다(시도·Task 버전 함께)', async ({ page }) => {
    const api = await open(page, '/exec/TASK-0005');
    api.on('POST /api/attempts/att-ATT-0005-1/stop', (route) => json(route, 202, { jobId: 'job-6' }));
    await nextBox(page).getByRole('button', { name: '실행 중단' }).click();
    await page.getByRole('alertdialog', { name: '실행 중단' }).getByRole('button', { name: '취소' }).click();
    expect(api.requests('POST /api/attempts/att-ATT-0005-1/stop')).toHaveLength(0);
    await nextBox(page).getByRole('button', { name: '실행 중단' }).click();
    await page.getByRole('alertdialog', { name: '실행 중단' }).getByRole('button', { name: '중단 요청' }).click();
    await expect.poll(() => api.requests('POST /api/attempts/att-ATT-0005-1/stop')[0]?.postDataJSON() as unknown)
      .toEqual({ updatedAt: '2026-11-03T10:58:00.000Z', attemptUpdatedAt: '2026-11-03T10:58:00.000Z' });
  });
});

test.describe('UAT-MSG-01·MSG-UI 메시지', () => {
  test('MSG-01: Task별 초안 유지·빈 본문 거부·유형/Agent/시도 선택·전송, 전달 상태와 응답 분리', async ({ page }) => {
    const api = await open(page, '/exec/TASK-0007?att=ATT-0007-2');
    const pane = msgs(page);
    await expect(pane).toContainText('ATT-0007-2에 연결된 메시지');
    const out = pane.getByRole('article', { name: /MSG-001/ });
    await expect(out).toContainText('팀장→Claude수정 요청Acknowledged · 수신 확인');
    const reply = pane.getByRole('article', { name: /MSG-002/ });
    await expect(reply).toContainText('Runner 응답');
    await expect(reply).toContainText('작업 상태: Runner 응답');
    await expect(reply.locator('.newtag')).toHaveText('새 응답');
    await expect(reply).toHaveClass('msg in new');

    await pane.getByRole('button', { name: '메시지 작성' }).click();
    const send = pane.getByRole('button', { name: '전송', exact: true });
    await expect(send).toBeDisabled();
    await expect(pane).toContainText('보낼 내용을 입력하세요.');
    // 고른 시도가 기본으로 연결된다
    await expect(pane.getByRole('group', { name: '관련 실행 시도' }).getByRole('button', { name: 'ATT-0007-2' })).toHaveAttribute('aria-pressed', 'true');
    await pane.getByRole('group', { name: '메시지 유형' }).getByRole('button', { name: '질문' }).click();
    await pane.getByRole('group', { name: '대상 Agent' }).getByRole('button', { name: 'Codex' }).click();
    await pane.getByLabel('메시지 내용').fill('가상 스크롤 기준은?');
    await expect(pane).toContainText('공식 명세를 바꾸지 않습니다');

    // 다른 Task로 옮겼다 와도 초안 유지(편집 보호 창 없이)
    await rail(page).getByRole('button', { name: /TASK-0005/ }).first().click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(pane).toContainText('TASK-0005 전체 메시지');
    await expect(pane.getByLabel('메시지 내용')).toHaveCount(0);
    await rail(page).getByRole('button', { name: /TASK-0007/ }).first().click();
    await expect(pane.getByLabel('메시지 내용')).toHaveValue('가상 스크롤 기준은?');

    api.on('POST /api/messages', (route) => json(route, 201, message('MSG-003', 'TASK-0007', { type: '질문', toAgent: 'Codex', body: '가상 스크롤 기준은?', updatedAt: '2026-11-05T11:00:00.000Z' })));
    api.on('POST /api/messages/msg-MSG-003/send', (route) => {
      api.state.messages['TASK-0007']?.push(message('MSG-003', 'TASK-0007', { type: '질문', toAgent: 'Codex', body: '가상 스크롤 기준은?', delivery: 'Queued', attemptId: 'att-ATT-0007-2' }));
      return json(route, 200, message('MSG-003', 'TASK-0007', { delivery: 'Queued' }));
    });
    await pane.getByRole('button', { name: '전송', exact: true }).click();
    await expect(page.getByText('메시지를 전달 대기열에 넣었습니다.')).toBeVisible();
    expect(api.requests('POST /api/messages')[0]?.postDataJSON()).toEqual({ taskKey: 'TASK-0007', type: '질문', toAgent: 'Codex', body: '가상 스크롤 기준은?', attemptId: 'att-ATT-0007-2' });
    expect(api.requests('POST /api/messages/msg-MSG-003/send')[0]?.postDataJSON()).toEqual({ updatedAt: '2026-11-05T11:00:00.000Z' });
    await expect(pane.getByRole('article', { name: /MSG-003/ })).toContainText('Queued · 전달 대기');
    // 메시지 화면은 Task 명세를 바꾸는 요청을 보내지 않는다
    expect(api.calls().filter((c) => /PATCH \/api\/tasks|\/spec/.test(c))).toEqual([]);
  });

  test('MSG-UI a: running·qa·verifying 모두 다음 실행 대기로 안내·표시', async ({ page }) => {
    for (const status of ['running', 'qa', 'verifying'] as const) {
      const api = await execApi(page);
      api.state.tasks.push(summary('TASK-0020', '3.1.1', `상태 ${status}`, status));
      api.state.messages['TASK-0020'] = [message('MSG-020', 'TASK-0020', { delivery: 'Queued', pendingNext: true, body: '추가 지시' })];
      await page.goto('/exec/TASK-0020');
      const pane = msgs(page);
      await expect(pane.getByRole('article', { name: /MSG-020/ })).toContainText('다음 실행 대기');
      await pane.getByRole('button', { name: '메시지 작성' }).click();
      await expect(pane.locator('.compose')).toContainText('전송하면 다음 실행 대기 메시지로 보관됩니다');
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });

  test('MSG-UI b: Queued 취소는 확인 뒤 전달 대상에서 제거', async ({ page }) => {
    const api = await open(page, '/exec/TASK-0005', (a) => {
      a.state.messages['TASK-0005'] = [message('MSG-030', 'TASK-0005', { delivery: 'Queued', body: '추가 지시', updatedAt: '2026-11-05T10:00:00.000Z' })];
    });
    api.on('POST /api/messages/msg-MSG-030/cancel', (route) => {
      const m = api.state.messages['TASK-0005']?.[0];
      if (m) m.delivery = 'Cancelled';
      return json(route, 200, m);
    });
    const item = msgs(page).getByRole('article', { name: /MSG-030/ });
    await item.getByRole('button', { name: '전송 취소' }).click();
    await page.getByRole('alertdialog', { name: '전송 취소' }).getByRole('button', { name: '전송 취소' }).click();
    await expect(item).toContainText('Cancelled · 전송 취소');
    await expect(item.getByRole('button', { name: '전송 취소' })).toHaveCount(0);
    expect(api.requests('POST /api/messages/msg-MSG-030/cancel')[0]?.postDataJSON()).toEqual({ updatedAt: '2026-11-05T10:00:00.000Z' });
  });
});

test.describe('G§12 시나리오 7·8', () => {
  test('7: 실행 중 추가 지시 → 다음 실행 대기 → 다음 실행 때 전달·ack → 응답(ack는 완료가 아님)', async ({ page }) => {
    const api = await open(page, '/exec/TASK-0005');
    api.on('POST /api/messages', (route) => json(route, 201, message('MSG-040', 'TASK-0005', { body: '에러 응답 형식 통일', updatedAt: '2026-11-05T11:00:00.000Z' })));
    api.on('POST /api/messages/msg-MSG-040/send', (route) => {
      api.state.messages['TASK-0005'] = [message('MSG-040', 'TASK-0005', { body: '에러 응답 형식 통일', delivery: 'Queued', pendingNext: true })];
      return json(route, 200, api.state.messages['TASK-0005'][0]);
    });
    const pane = msgs(page);
    await pane.getByRole('button', { name: '메시지 작성' }).click();
    await expect(pane.locator('.compose')).toContainText('이 Task는 실행 중입니다.');
    await pane.getByLabel('메시지 내용').fill('에러 응답 형식 통일');
    await pane.getByRole('button', { name: '전송', exact: true }).click();
    const item = pane.getByRole('article', { name: /MSG-040/ });
    await expect(item).toContainText('Queued · 전달 대기');
    await expect(item).toContainText('다음 실행 대기');

    // 다음 실행 시작 때 Runner가 가져가 ack, 이어서 Agent 응답
    api.state.messages['TASK-0005'] = [
      message('MSG-040', 'TASK-0005', { body: '에러 응답 형식 통일', delivery: 'Acknowledged', workState: 'Agent 응답 대기' }),
      message('MSG-041', 'TASK-0005', { dir: 'in', type: '응답', toAgent: null, delivery: null, body: '반영하겠습니다.', attemptId: 'att-ATT-0005-1', createdAt: '2026-11-05T11:05:00.000Z' }),
    ];
    api.bump(['message']);
    await expect(item).toContainText('Acknowledged · 수신 확인', { timeout: 10_000 });
    await expect(item).toContainText('작업 상태: Agent 응답 대기');
    await expect(item).not.toContainText('다음 실행 대기');
    const reply = pane.getByRole('article', { name: /MSG-041/ });
    // 받은 응답에는 발신 Agent 필드가 없어 「Agent」로 보인다(리뷰 #9, 계약 공백).
    await expect(reply).toContainText('Agent→팀장');
    await expect(reply.locator('.newtag')).toBeVisible();
    // ack만으로 Task를 완료하지 않는다
    await expect(center(page).locator('.st').first()).toHaveText('실행 중');
  });

  test('8: Runner 끊김 → 전달 실패(원인) → 재연결 → 재전송', async ({ page }) => {
    const api = await open(page, '/exec/TASK-0005', (a) => {
      a.state.runner = runnerState({ connection: { online: false, runnerId: null, version: null, lastHeartbeatAt: null, sessionStartedAt: null } });
      a.state.messages['TASK-0005'] = [message('MSG-050', 'TASK-0005', { delivery: 'Failed', failReason: 'Runner 연결 불가 — heartbeat 응답 없음', body: '추가 지시', updatedAt: '2026-11-05T10:00:00.000Z' })];
    });
    const pane = msgs(page);
    await pane.getByRole('button', { name: '메시지 작성' }).click();
    await expect(pane.locator('.compose')).toContainText('Runner 연결 끊김 — 지금 전송하면 전달 실패로 기록되고');
    const item = pane.getByRole('article', { name: /MSG-050/ });
    await expect(item).toContainText('Failed · 전달 실패');
    await expect(item).toContainText('전달 실패 — Runner 연결 불가 — heartbeat 응답 없음');

    api.state.runner = runnerState();
    api.on('POST /api/messages/msg-MSG-050/resend', (route) => {
      api.state.messages['TASK-0005'] = [message('MSG-050', 'TASK-0005', { delivery: 'Queued', body: '추가 지시' })];
      return json(route, 200, api.state.messages['TASK-0005'][0]);
    });
    api.bump(['runner']);
    await expect(pane.locator('.compose')).not.toContainText('Runner 연결 끊김', { timeout: 10_000 });
    await item.getByRole('button', { name: '재전송' }).click();
    await expect(item).toContainText('Queued · 전달 대기');
    expect(api.requests('POST /api/messages/msg-MSG-050/resend')[0]?.postDataJSON()).toEqual({ updatedAt: '2026-11-05T10:00:00.000Z' });
  });
});

test.describe('UAT-EMPTY-03·TASK-10 b', () => {
  test('시도·체크리스트·메시지가 없는 Task: 각 영역 안내, 없는 시도는 고르지 않음', async ({ page }) => {
    await open(page, '/exec/TASK-0030?att=ATT-9999', (api) => {
      api.state.tasks.push(summary('TASK-0030', '3.2.1', '빈 Task', 'ready', { checklist: { done: 0, total: 0 } }));
    });
    await expect(center(page)).toContainText('이 Task에는 아직 실행 시도가 없습니다.');
    await expect(center(page)).toContainText('첫 실행은 위 「다음 작업」의 실행 요청으로 시작합니다.');
    await expect(center(page)).toContainText('체크리스트가 없습니다');
    await expect(msgs(page)).toContainText('연결된 메시지가 없습니다.');
    await expect(msgs(page)).toContainText('「메시지 작성」으로 추가 지시 · 질문을 보낼 수 있습니다.');
    await expect(msgs(page)).toContainText('TASK-0030 전체 메시지');
    await expect(page.locator('.ex-a.on')).toHaveCount(0);
  });

  test('Task 실행 탭의 링크 주소(/exec/:taskKey)는 그 Task를 연다', async ({ page }) => {
    await open(page, '/exec/TASK-0007');
    await expect(center(page).getByRole('heading', { name: 'WBS Tree UI' })).toBeVisible();
    await expect(rail(page).getByRole('button', { name: /TASK-0007/ }).first()).toHaveClass(/on/);
    await expect(center(page).getByRole('link', { name: 'Task 상세 열기' })).toHaveAttribute('href', '/wbs/TASK-0007');
  });

  test('메뉴로 열면 첫 Task를 보인다', async ({ page }) => {
    await open(page, '/exec');
    await expect(center(page).getByRole('heading', { name: 'Monorepo 구성' })).toBeVisible();
    await expect(nextBox(page)).toContainText('완료된 Task입니다.');
  });
});

test.describe('D-28 화면 폭(UAT-SHELL-04-UI 자동 부분)', () => {
  for (const width of [1920, 1280]) {
    test(`${String(width)}px: 3영역 모두 보이고 페이지 가로 스크롤 없음`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, '/exec/TASK-0007?att=ATT-0007-2');
      for (const region of [rail(page), center(page), msgs(page)]) await expect(region).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const body = await page.evaluate(() => getComputedStyle(document.querySelector('.msg-sm') ?? document.body).fontSize);
      expect(parseFloat(body)).toBeGreaterThanOrEqual(12);
    });
  }

  test('390px: 알림 링크로 연 실행 상세를 잘림 없이 읽는다', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, '/exec/TASK-0007?att=ATT-0007-2');
    await expect(center(page).getByRole('heading', { name: 'WBS Tree UI' })).toBeVisible();
    await expect(page.getByLabel('ATT-0007-2 실행 기록')).toContainText('DEF-0007-2');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
