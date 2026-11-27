/**
 * M3-08 설정 → Runner · 실행 환경 탭: UAT-RUNNER-UI, UAT-GITHUB-UI, UAT-EMPTY-11(Runner 부분).
 * 서버 보고(fake Runner의 heartbeat·readiness·usage·PC·보유·CLI 버전)를 계약 모양으로 넣고 화면이 그대로 보이는지 본다.
 */
import { expect, test } from '@playwright/test';
import { fakeApi, json } from './support/fake-api.ts';
import { CONCURRENCY, GITHUB, RUNNER_EMPTY, RUNNER_FULL, settingsApi } from './support/settings-fixtures.ts';

test('Q-07: 실행 중 전달은 원래 자리에서 준비 중으로 보이고 켤 수 없다', async ({ page }) => {
  const s = settingsApi(await fakeApi(page));
  await page.goto('/settings/runner');
  const card = page.getByRole('region', { name: 'Runner 연결' });
  const group = card.getByRole('group', { name: '실행 중 세션 전달' });
  await expect(group.locator('button')).toHaveCount(2);
  await expect(group.getByRole('button', { name: '미지원 — 다음 실행에 전달' })).toHaveAttribute('aria-pressed', 'true');
  await expect(group.getByRole('button', { name: /준비 중/ })).toBeDisabled();
  await expect(group.getByRole('button').first()).toBeDisabled();
  await expect(card.locator('#live-inject-hint')).toContainText('지금은 메시지를 「다음 실행 대기」로 보관합니다');
  await expect(card.getByRole('button', { name: '저장', exact: true })).toHaveCount(0);
  expect(s.workflow.bodies).toEqual([]);
});

test('UAT-RUNNER-UI a: 헤더·설정 연결 상태와 준비 상태 결과·조치·탭 배지가 일치한다', async ({ page }) => {
  settingsApi(await fakeApi(page));
  await page.goto('/settings');
  await expect(page.locator('.hdr').getByText('연결됨')).toBeVisible();
  const conn = page.getByRole('region', { name: 'Runner 연결' });
  await expect(conn.getByText('연결됨', { exact: true })).toBeVisible();
  await expect(conn.getByText('60초 — 3회 미수신 시 오프라인 처리')).toBeVisible();
  const ready = page.getByRole('region', { name: 'Runner 준비 상태' });
  await expect(ready.getByText('문제 1건 — 해당 Agent의 실행이 멈춰 있습니다')).toBeVisible();
  await expect(ready.getByText('PostgreSQL이 실행 중인지 확인하세요.')).toBeVisible();
  await expect(ready.getByText('만료 전에 `codex login`을 다시 실행하세요.')).toBeVisible();
  // 배지 = 정상이 아닌 준비 항목 2(warn 1 + fail 1) + GitHub 문제 0
  await expect(page.locator('a.tab.on .tab-c')).toHaveText('2');
  await expect(page.locator('a.tab.on .tab-c')).toHaveClass(/alert/);
  // Mock 조작 버튼은 제품에 없다(UAT-POLICY-05).
  await expect(page.getByRole('button', { name: /Mock/ })).toHaveCount(0);
});

test('UAT-RUNNER-UI b: 가동률·중단 구간·남은 사용량/리셋을 보이고 유령 슬롯 행이 없다', async ({ page }) => {
  settingsApi(await fakeApi(page));
  await page.goto('/settings/runner');
  const cap = page.getByRole('region', { name: '가용 용량 — 관측값' });
  await expect(cap.getByText('58%', { exact: true })).toBeVisible();
  await expect(cap.getByText('범위 45% ~ 70% · 오늘 지금까지 50%')).toBeVisible();
  await expect(cap.getByText('최근 7일 Runner 가동 기록 (97시간 수집)')).toBeVisible();
  await expect(cap.locator('.cbar')).toHaveCount(7);
  await expect(cap.locator('.cbar.low')).toHaveCount(1);
  await expect(cap.getByText('재부팅')).toBeVisible();
  await expect(cap.getByText('1.5h')).toBeVisible();
  await expect(cap.getByText('여유 적음')).toBeVisible(); // Codex 12% < 20%
  await expect(cap.getByText('12%', { exact: true })).toBeVisible();
  await expect(cap.getByText('2026-11-06 09:00')).toBeVisible(); // 리셋 예정(KST)
  await expect(cap.getByText('실행 중 / 슬롯')).toHaveCount(0); // MM-24 죽은 행 제거
});

test('UAT-RUNNER-UI c·d: 상한 권장 초과 경고·자원·변경 이력, CLI 미검증은 보수 계산 안내이고 고정/하향 버튼이 없다', async ({ page }) => {
  const api = await fakeApi(page);
  const s = settingsApi(api);
  await page.goto('/settings/runner');
  const cc = page.getByRole('region', { name: '동시 실행 — 상한 · Runner 조절' });
  await expect(cc.getByText('권장: 전체 8 · Claude 8 · Codex 8 · 무거운 작업 4')).toBeVisible();
  // 자동 모드에서는 값을 고를 수 없다.
  await expect(cc.getByRole('group', { name: '전체 상한' }).getByRole('button', { name: '12' })).toBeDisabled();
  await cc.getByRole('group', { name: '상한 결정 방식' }).getByRole('button', { name: '직접 지정' }).click();
  await cc.getByRole('group', { name: '전체 상한' }).getByRole('button', { name: '12' }).click();
  await expect(cc.getByText(/직접 지정 상한이 이 PC 권장값보다 큼 — 전체 12 > 권장 8/)).toBeVisible();
  await cc.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('설정을 저장했습니다.')).toBeVisible();
  expect(s.concurrency.bodies[0]).toEqual({ ...CONCURRENCY, mode: 'manual', caps: { ...CONCURRENCY.caps, total: 12 } });
  await expect(cc.getByText('CPU 41% · 메모리 여유 9.4 / 23GB · swap 0GB')).toBeVisible();
  await expect(cc.getByText('8 → 6')).toBeVisible();
  await expect(cc.getByText('메모리 여유 4GB 미만')).toBeVisible();
  await expect(cc.getByText('dev-pc', { exact: true })).toBeVisible();
  await expect(cc.getByRole('link', { name: 'TASK-0009' })).toHaveAttribute('href', '/wbs/TASK-0009');
  // CLI 버전이 검증 버전과 다르면 미검증·보수 계산 안내, 고정·하향 버튼은 없다.
  await expect(cc.getByText('검증 버전과 다름')).toBeVisible();
  await expect(cc.getByText(/미검증 CLI 세션은 보수 계산하고, 재검증 전까지 최신 버전을 그대로 씁니다/)).toBeVisible();
  await expect(cc.getByRole('button', { name: /고정|하향|업데이트/ })).toHaveCount(0);
});

test('UAT-RUNNER-UI e: 예산 변경 응답으로 보유 계산을 갱신하되 관측 미확인 세션은 보유를 줄이지 않는다', async ({ page }) => {
  const api = await fakeApi(page);
  const s = settingsApi(api);
  let runner = RUNNER_FULL;
  api.on('GET /api/runner-state', (route) => json(route, 200, runner));
  await page.goto('/settings/runner');
  const cc = page.getByRole('region', { name: '동시 실행 — 상한 · Runner 조절' });
  await expect(cc.getByText('관측 미확인 세션 1개 — 하위 Agent 수를 줄이지 않고 보유, 새 실행 보류 중')).toBeVisible();
  await expect(cc.getByText('미확인 — 마지막 관측 이상 보유')).toBeVisible();
  await cc.getByRole('group', { name: '개발 · 재작업 세션 예산' }).getByRole('button', { name: '4' }).click();
  // 서버가 저장 뒤 다시 계산한 Runner 상태(보유 합계 2 → 4)를 보낸다. 미확인 세션의 보유 3은 그대로다.
  runner = { ...RUNNER_FULL, concurrency: { ...RUNNER_FULL.concurrency, subagentsHeld: 4, used: { total: 5, Claude: 3, Codex: 2 } } };
  await cc.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('설정을 저장했습니다.')).toBeVisible();
  expect(s.budget.bodies[0]).toMatchObject({ budget: { dev: 4, qa: 3 } });
  // 서버는 저장 뒤 runner 변경 이벤트를 낸다(contracts §7). 앱 틀의 polling이 runner topic query를 다시 읽는다.
  api.on('GET /api/changes', (route) => json(route, 200, { events: [{ seq: 1, topic: 'runner', ref: null, at: '2026-11-05T02:00:00.000Z' }], next: 1, reset: false }));
  await expect(cc.getByText('세션 1 + 하위 Agent 4 (관측 1 · 보유 계산 4)')).toBeVisible();
  const row = cc.locator('.gtr.orow').filter({ hasText: 'TASK-0008' });
  await expect(row.locator('b.mono')).toHaveText('3');
  await expect(row.getByText('관측 끊김')).toBeVisible();
});

test('UAT-GITHUB-UI a·b: 형식 오류 거부, 권한 누락·복구와 배지, 토큰을 다시 보이지 않음', async ({ page }) => {
  const api = await fakeApi(page);
  const s = settingsApi(api);
  let github: typeof GITHUB = { ...GITHUB, scopes: { contents: 'verified', pulls: 'verified', statuses: 'missing', metadata: 'verified' } };
  api.on('GET /api/settings/github', (route) => json(route, 200, github));
  await page.goto('/settings/runner');
  const card = page.getByRole('region', { name: 'GitHub 연결' });
  await expect(card.getByText('실패', { exact: true })).toBeVisible();
  await expect(card.locator('.gtr').filter({ hasText: 'Commit statuses' }).getByText('없음')).toBeVisible();
  await expect(card.getByText(/필요한 권한이 없습니다/)).toBeVisible();
  await expect(page.locator('a.tab.on .tab-c')).toHaveText('3'); // 준비 2 + GitHub 1

  await card.getByRole('group', { name: '인증 방식' }).getByRole('button', { name: '토큰 입력' }).click();
  const input = card.getByLabel('새 토큰');
  await input.fill('not-a-token');
  await card.getByRole('button', { name: '토큰 저장 · 확인' }).click();
  await expect(card.getByText('토큰 형식이 아닙니다 — github_pat_… (fine-grained) 또는 ghp_… 로 시작합니다.')).toBeVisible();
  expect(s.github.bodies).toHaveLength(0);

  const secret = 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
  await input.fill(secret);
  github = { ...github, mode: 'token', tokenSet: true, account: 'team-lead (토큰)', scopes: { contents: 'verified', pulls: 'verified', statuses: 'verified', metadata: 'verified' } };
  api.on('PUT /api/settings/github', (route) => { s.github.bodies.push(route.request().postDataJSON() as Record<string, unknown>); return json(route, 200, { ...github, updatedAt: '2026-11-05T02:00:00.000Z' }); });
  await card.getByRole('button', { name: '토큰 저장 · 확인' }).click();
  await expect(page.getByText('토큰을 저장했습니다 — 서버에 암호화해 보관하고 다시 표시하지 않습니다.')).toBeVisible();
  expect(s.github.bodies[0]).toMatchObject({ mode: 'token', token: secret });
  await expect(input).toHaveValue('');
  await expect(card.getByText(/●●●● 저장됨/)).toBeVisible();
  await expect(card.getByText('연결됨', { exact: true })).toBeVisible();
  await expect(page.locator('a.tab.on .tab-c')).toHaveText('2');
  expect(await page.content()).not.toContain(secret);
  // 토큰은 초안 보관에도 들어가지 않는다.
  expect(JSON.stringify(await page.evaluate(() => ({ ...sessionStorage })))).not.toContain(secret);
});

test('UAT-GITHUB-UI b: 연결 확인 요청과 미확인 권한 경고', async ({ page }) => {
  const api = await fakeApi(page);
  settingsApi(api);
  api.on('GET /api/settings/github', (route) => json(route, 200, { ...GITHUB, scopes: { ...GITHUB.scopes, pulls: 'unverified' }, warning: 'Pull requests 쓰기 권한은 첫 PR 생성 때 확인됩니다.' }));
  let checks = 0;
  api.on('POST /api/settings/github/check', (route) => { checks += 1; return json(route, 202, { jobId: 'j1' }); });
  await page.goto('/settings/runner');
  const card = page.getByRole('region', { name: 'GitHub 연결' });
  await expect(card.locator('.gtr').filter({ hasText: 'Pull requests' }).getByText('미확인')).toBeVisible();
  await expect(card.getByText('Pull requests 쓰기 권한은 첫 PR 생성 때 확인됩니다.')).toBeVisible();
  await card.getByRole('button', { name: '연결 확인' }).click();
  await expect(page.getByText('연결 확인을 요청했습니다 — Runner가 확인해 보고하면 결과가 바뀝니다.')).toBeVisible();
  expect(checks).toBe(1);
});

test('UAT-EMPTY-11 (Runner): 기록이 없으면 각 영역이 없음과 생기는 조건을 안내하고 임의 세션·경고를 만들지 않는다', async ({ page }) => {
  settingsApi(await fakeApi(page), RUNNER_EMPTY);
  await page.goto('/settings/runner');
  await expect(page.getByText('아직 준비 상태 보고가 없습니다. Runner가 시작하면 스스로 점검해 여기에 보고합니다.')).toBeVisible();
  await expect(page.getByText('최근 7일 중단 기록이 없습니다. Runner가 끊겼다가 다시 연결되면 여기에 남습니다.')).toBeVisible();
  await expect(page.getByText(/실행 중인 세션이 없습니다/)).toBeVisible();
  await expect(page.getByText('조절 기록이 없습니다. Runner가 한도를 바꾸면 여기에 남습니다.')).toBeVisible();
  await expect(page.getByText('아직 실행 PC 보고가 없습니다. Runner가 연결되면 사양을 스스로 보고합니다.')).toBeVisible();
  await expect(page.getByText('없음', { exact: true }).first()).toBeVisible(); // 충돌 대기 없음
  await expect(page.locator('.gtr.orow:not(.h)')).toHaveCount(0);
  await expect(page.getByText(/관측 미확인 세션/)).toHaveCount(0);
  await expect(page.locator('a.tab.on .tab-c')).toHaveCount(0);
});
