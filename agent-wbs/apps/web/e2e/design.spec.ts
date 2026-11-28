/**
 * M6-07 설계 화면 6탭·Task 연결 — UAT-DESIGN-01~04, UAT-EMPTY-09, 가이드 §12 시나리오 28·29(설계 메뉴 부분).
 * 데이터는 원본 Mock과 같은 값의 가짜 설계 원장(support/design-data.ts)이고, M6-05 서버 규칙(409·202·결정 ID)을 흉내 낸다.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { delay, fakeApi, hold, json, type FakeApi } from './support/fake-api.ts';
import { designData, emptyDesign, installDesign, type DesignData } from './support/design-data.ts';
import { mountTasks } from './support/task-api.ts';

async function open(page: Page, path = '/design', change: (d: DesignData) => void = () => undefined, heading = '설계') {
  const api = await fakeApi(page);
  mountTasks(api);
  const data = designData();
  change(data);
  const { writes } = installDesign(api, data);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  return { api, data, writes };
}
const tabs = (page: Page) => page.getByRole('tablist', { name: '설계 영역' }).getByRole('tab');
const tab = (page: Page, name: RegExp | string) => page.getByRole('tablist', { name: '설계 영역' }).getByRole('tab', { name });
const listRows = (page: Page) => page.locator('[data-row]');
const decRow = (page: Page, td: string) => page.locator(`[data-dec="${td}"]`);
const driftRow = (page: Page, key: string) => page.locator(`[data-drift="${key}"]`);

test('UAT-DESIGN-01 b / 시나리오 28: 요약 줄·탭 배지·승인 대기 배너가 실제 상태와 같다', async ({ page }) => {
  await open(page);
  await expect(page.locator('.page-sub.mono')).toHaveText('설계 v3 · 기술 결정 11 (승인 대기 1) · 인터페이스 27 · 데이터 항목 16 · 불일치 2');
  await expect(tabs(page)).toHaveText(['구성도 · 계약 파일', '기술 결정1', '인터페이스27', '데이터16', '소유권 · 흐름', '변경 · 불일치2']);
  await expect(tab(page, /기술 결정/).locator('.tab-c')).toHaveClass(/alert/);
  await expect(tab(page, /구성도/)).toHaveAttribute('aria-selected', 'true');
  const banner = page.locator('.banner.warn');
  await expect(banner).toContainText('팀장 승인이 필요한 기술 결정 1건 — 승인 전까지 관련 계약 · Task는 진행하지 않습니다.');
  await banner.getByRole('button', { name: '기술 결정 보기' }).click();
  await expect(page).toHaveURL('/design?tab=dec');
  await expect(tab(page, /기술 결정/)).toHaveAttribute('aria-selected', 'true');
});

test('UAT-DESIGN-01 a: 구성도(계층·승인 대기 점선·반려 취소선)·연결·계약 파일(형식·커밋·상태)', async ({ page }) => {
  await open(page, '/design', (d) => { const x = d.decisions.find((y) => y.tdKey === 'TD-05'); if (x) x.status = 'rejected'; });
  const layers = page.locator('.ds-layer');
  await expect(layers.locator('.ds-lay-l')).toHaveText(['클라이언트', '서버', '팀장 PC', '데이터']);
  const q = page.locator('.ds-comp', { hasText: 'QuestDB' });
  await expect(q).toHaveClass('ds-comp pend');
  await expect(q).toContainText('TD-03 승인 대기');
  const neo = page.locator('.ds-comp', { hasText: 'Neo4j 5' });
  await expect(neo).toHaveClass('ds-comp off');
  // 반려된 구성 요소(Neo4j)의 연결은 숨긴다(원본 live 규칙)
  const links = page.getByRole('table', { name: '연결' }).locator('[data-link]');
  await expect(links).toHaveCount(8);
  await expect(links.first()).toHaveText(['Web (FE)', 'API 서버', 'REST', 'contracts/api/openapi.yaml'].join(''));
  const files = page.getByRole('table', { name: '계약 파일' }).locator('[data-file]');
  await expect(files).toHaveCount(6);
  await expect(files.nth(0)).toContainText('contracts/api/openapi.yaml');
  await expect(files.nth(0)).toContainText('OpenAPI 3.1');
  await expect(files.nth(0)).toContainText('a41f0c2');
  await expect(files.nth(0).locator('.vf')).toHaveText('읽음');
  await expect(files.nth(4).locator('.vf')).toHaveText('브랜치 초안');
});

test('UAT-DESIGN-01 a: 계약 스냅샷·결정 없음 — 빈 안내, 탭 없음', async ({ page }) => {
  const api = await fakeApi(page);
  mountTasks(api);
  installDesign(api, emptyDesign());
  await page.goto('/design');
  await expect(page.getByText('아직 확정된 기술 결정이 없습니다.')).toBeVisible();
  await expect(page.getByText(/초기 분석의 「기술 결정 확정」 단계/)).toBeVisible();
  await expect(page.getByRole('tablist', { name: '설계 영역' })).toHaveCount(0);
});

test('UAT-DESIGN-01 a: 읽기 실패 — 마지막 성공 버전·원인 배너, 다시 읽기는 서버가 성공을 보고한 뒤에만 해제', async ({ page }) => {
  const { data, api } = await open(page, '/design', (d) => {
    const f = d.files.find((x) => x.kind === 'Neo4j');
    if (f) { f.status = 'error'; f.error = "42행: Invalid input 'REQUIRE'"; }
  });
  const banner = page.locator('.banner.danger');
  await expect(banner).toContainText("계약 파일 읽기 실패 — contracts/db/neo4j/model.cypher + migrations/ — 42행: Invalid input 'REQUIRE' · 마지막 성공 버전(3be19d0)으로 표시합니다.");
  const files = page.getByRole('table', { name: '계약 파일' }).locator('[data-file]');
  await expect(files.nth(3).locator('.vf')).toHaveText('읽기 실패');
  await expect(files.nth(3)).toContainText('3be19d0 (마지막 성공)');
  // 서버가 아직 실패를 주면 다시 읽어도 배너가 남는다
  const before = api.requests('GET /api/projects/p1/design').length;
  await banner.getByRole('button', { name: '다시 읽기' }).click();
  await expect.poll(() => api.requests('GET /api/projects/p1/design').length).toBeGreaterThan(before);
  await expect(banner).toBeVisible();
  // Runner가 다시 해석해 성공을 보고한 뒤에만 사라진다
  const f = data.files.find((x) => x.kind === 'Neo4j');
  if (f) { f.status = 'ok'; f.error = null; }
  await banner.getByRole('button', { name: '다시 읽기' }).click();
  await expect(page.locator('.banner.danger')).toHaveCount(0);
  await expect(files.nth(3).locator('.vf')).toHaveText('읽음');
});

test('UAT-DESIGN-02 / 시나리오 28: TD-03 승인 → 버전 v4·배너 해제, 요청은 버전·멱등 키를 싣는다', async ({ page }) => {
  const { writes } = await open(page, '/design?tab=dec');
  const row = decRow(page, 'TD-03');
  await expect(row).toContainText('조건 시계열 데이터(시간 순 대량 쓰기 · 구간 집계 · 보관 기간)가 있으면 QuestDB 사용');
  await expect(row).toContainText('대안 PostgreSQL 시간 파티션');
  await expect(row).toContainText('Planning Agent · 2026-11-06 14:20');
  await expect(row.locator('.sc').first()).toHaveText('팀장 지정 · 조건부 선호');
  await row.getByRole('button', { name: '승인' }).click();
  await expect(page.getByText('TD-03 승인 — 설계 버전이 올라갔습니다.')).toBeVisible();
  await expect(row.locator('.vf')).toHaveText('승인됨');
  await expect(page.locator('.page-sub.mono')).toContainText('설계 v4 · 기술 결정 11 · 인터페이스');
  await expect(page.locator('.banner.warn')).toHaveCount(0);
  expect(writes[0]?.path).toBe('approve d0000000-0000-4000-8000-000000000003');
  expect(writes[0]?.body).toEqual({ updatedAt: new Date('2026-11-06T14:20:00+09:00').toISOString() });
  expect(writes[0]?.key).toBeTruthy();
});

test('UAT-DESIGN-02: 팀장 지정 필수·금지·재량은 변경 제안 없음, 변경 제안 → 승인 전 기존 결정 유지 → 반려로 복구', async ({ page }) => {
  const { writes } = await open(page, '/design?tab=dec');
  await expect(decRow(page, 'TD-01').getByRole('button', { name: '변경 제안' })).toHaveCount(0);
  await expect(decRow(page, 'TD-04').getByRole('button', { name: '변경 제안' })).toHaveCount(0);
  await expect(decRow(page, 'TD-10').getByRole('button', { name: '변경 제안' })).toHaveCount(0);
  const row = decRow(page, 'TD-05');
  await row.getByRole('button', { name: '변경 제안' }).click();
  const dlg = page.getByRole('dialog', { name: 'TD-05 기술 결정 변경 제안' });
  await dlg.getByLabel('새 선택').fill('PostgreSQL 재귀 CTE');
  await dlg.getByLabel('변경 이유').fill('그래프 규모가 작아 별도 DB가 과함');
  await dlg.getByRole('button', { name: '변경 제안 올리기' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(row.locator('.vf')).toHaveText('변경 제안 — 승인 대기');
  await expect(row.locator('.dec-c')).toHaveText('Neo4j 5');
  await expect(row).toContainText('변경 제안 Neo4j 5 → PostgreSQL 재귀 CTE — 그래프 규모가 작아 별도 DB가 과함');
  await expect(tab(page, /기술 결정/)).toHaveText('기술 결정2');
  await row.getByRole('button', { name: '반려' }).click();
  await expect(row.locator('.vf')).toHaveText('승인됨');
  await expect(row.locator('.dec-c')).toHaveText('Neo4j 5');
  expect(writes.map((w) => w.path.split(' ')[0])).toEqual(['change', 'reject']);
  expect(writes[0]?.body).toMatchObject({ choice: 'PostgreSQL 재귀 CTE', reason: '그래프 규모가 작아 별도 DB가 과함' });
});

test('UAT-DESIGN-02: 다른 곳에서 먼저 바뀌면 충돌 창, 최신 불러오기로 닫는다', async ({ page }) => {
  const { data } = await open(page, '/design?tab=dec');
  const x = data.decisions.find((y) => y.tdKey === 'TD-03');
  if (x) x.updatedAt = new Date('2026-11-06T15:00:00+09:00').toISOString();
  await decRow(page, 'TD-03').getByRole('button', { name: '승인' }).click();
  const dlg = page.getByRole('alertdialog');
  await expect(dlg).toContainText('409 VERSION_CONFLICT');
  await dlg.getByRole('button', { name: /최신 내용 불러오기/ }).click();
  await expect(dlg).toHaveCount(0);
  await decRow(page, 'TD-03').getByRole('button', { name: '승인' }).click();
  await expect(decRow(page, 'TD-03').locator('.vf')).toHaveText('승인됨');
});

test('UAT-DESIGN-03 / 시나리오 28: 방식 필터·행 선택 → 레일+상세, 이전·다음, 읽고 쓰는 테이블 ↔ 사용하는 API, 담당 Task 이동', async ({ page }) => {
  await open(page, '/design?tab=iface');
  const seg = page.getByRole('group', { name: '방식' });
  await expect(seg.getByRole('button')).toHaveText(['전체 27', 'REST 23', 'WebSocket 1', 'SSE 1', '이벤트 (Kafka) 2']);
  await seg.getByRole('button', { name: 'REST 23' }).click();
  await expect(page).toHaveURL('/design?tab=iface&kind=REST');
  await expect(listRows(page)).toHaveCount(23);
  const patch = listRows(page).filter({ hasText: 'PATCH /api/tasks/:taskKey' });
  await expect(patch.locator('.sc.sc-bad')).toHaveText('불일치');
  await expect(patch).toContainText('구현 중 · 브랜치');
  await patch.click();
  const detail = page.getByRole('region', { name: 'PATCH /api/tasks/:taskKey 상세' });
  await expect(detail).toContainText('4 / 23');
  await expect(detail).toContainText('contracts/api/openapi.yaml');
  await expect(detail).toContainText('팀장 세션');
  await expect(detail.locator('pre.code').first()).toContainText('"updatedAt": string');
  await expect(detail).toContainText('VERSION_CONFLICT');
  await expect(detail.locator('.banner.warn')).toContainText('미해결 코드 응답에 `updatedBy` 필드가 있으나');
  await expect(page.getByRole('complementary', { name: '인터페이스 목록' }).locator('.side-i.on')).toContainText('PATCH /api/tasks/:taskKey');
  await detail.getByRole('button', { name: '↓ 다음' }).click();
  await expect(page.getByRole('region', { name: 'POST /api/projects/:projectId/tasks 상세' })).toContainText('5 / 23');
  await page.getByRole('button', { name: '↑ 이전' }).click();
  // 읽고 쓰는 테이블 tasks → 데이터 탭 테이블 상세 → 사용하는 API
  await page.getByRole('region', { name: 'PATCH /api/tasks/:taskKey 상세' }).getByRole('button', { name: 'tasks', exact: true }).click();
  await expect(page).toHaveURL(/tab=data&store=postgres&sel=postgres%3Atasks/);
  const table = page.getByRole('region', { name: 'tasks 상세' });
  await expect(table).toContainText('task_key');
  await expect(table).toContainText('UNIQUE · NOT NULL');
  await expect(table).toContainText('wbs_nodes.id');
  await table.getByRole('button', { name: 'GET /api/projects/:projectId/tasks' }).click();
  await expect(page.getByRole('region', { name: 'GET /api/projects/:projectId/tasks 상세' })).toBeVisible();
  // 펼치기 → 목록
  await page.getByRole('button', { name: '펼치기', exact: true }).click();
  await expect(listRows(page)).toHaveCount(27);
  // 담당 Task 링크는 Task 상세로
  await listRows(page).filter({ hasText: 'PATCH /api/tasks/:taskKey' }).click();
  await page.getByRole('region', { name: 'PATCH /api/tasks/:taskKey 상세' }).getByRole('link', { name: 'TASK-0005' }).click();
  await expect(page).toHaveURL('/wbs/TASK-0005');
});

test('UAT-DESIGN-03: WebSocket·SSE·Kafka와 Neo4j·QuestDB·Redis 각 필드', async ({ page }) => {
  await open(page, '/design?tab=iface&kind=Kafka&sel=runner.attempt.events');
  const k = page.getByRole('region', { name: 'runner.attempt.events 상세' });
  for (const t of ['AttemptProgress', 'Runner → 토픽', 'taskKey (같은 Task 이벤트 순서 보장)', '3개 · 7일', '최소 1회 — 소비자는 eventId로 중복 제거', 'runner.attempt.events.dlq', 'schedule-replanner, report-builder, graph-sync']) await expect(k).toContainText(t);
  await page.goto('/design?tab=iface&kind=WebSocket&sel=WS%20%2Frunner%2Fws');
  const ws = page.getByRole('region', { name: '/runner/ws 상세' });
  await expect(ws).toContainText('Runner 토큰 (등록 시 발급)');
  await expect(ws).toContainText('연결 끊김 30초 → Runner 오프라인 처리');
  await page.goto('/design?tab=data&store=neo4j');
  await expect(page.getByRole('group', { name: '저장소' }).getByRole('button')).toHaveText(['PostgreSQL 4', 'Neo4j 7', 'QuestDB 1', 'Redis 4']);
  await listRows(page).filter({ has: page.locator('.ds-name', { hasText: /^:Task$/ }) }).click();
  await expect(page.getByRole('region', { name: ':Task 상세' })).toContainText('CREATE CONSTRAINT task_key FOR (t:Task) REQUIRE t.taskKey IS UNIQUE');
  await listRowsRail(page, '(:Task)-[:DEPENDS_ON]->(:Task)').click();
  await expect(page.getByRole('region', { name: '(:Task)-[:DEPENDS_ON]->(:Task) 상세' })).toContainText('type (FS | SS)');
  await page.goto('/design?tab=data&store=questdb&sel=questdb%3Arunner_samples');
  const qd = page.getByRole('region', { name: 'runner_samples 상세' });
  for (const t of ['ts (기준 타임스탬프)', 'DAY', '14일 (TTL)', 'ts, runner_id, session_id', 'ILP (Runner → QuestDB 9009)']) await expect(qd).toContainText(t);
  await page.goto('/design?tab=data&store=redis&sel=redis%3Alock%3Atask%3A%7BtaskKey%7D');
  const rd = page.getByRole('region', { name: 'lock:task:{taskKey} 상세' });
  for (const t of ['실행 잠금 (같은 Task 동시 실행 방지)', 'attemptId', '15분 (갱신)', '실행 종료 시 삭제', '불필요']) await expect(rd).toContainText(t);
});
const listRowsRail = (page: Page, name: string) => page.getByRole('complementary').getByRole('button', { name: new RegExp(name.replace(/[()[\]:>-]/g, '\\$&')) });

test('UAT-EMPTY-09: 검색 무매칭은 조건 불일치 안내, 초기화는 검색어도 지운다 / 정의 없음은 생성 조건 안내', async ({ page }) => {
  await open(page, '/design?tab=iface');
  await page.getByRole('searchbox', { name: '검색' }).fill('없는이름');
  await expect(listRows(page)).toHaveCount(0);
  const none = page.locator('[data-empty="filtered"]');
  await expect(none).toContainText('조건에 맞는 인터페이스가 없습니다.');
  await none.getByRole('button', { name: '필터 초기화' }).click();
  await expect(page.getByRole('searchbox', { name: '검색' })).toHaveValue('');
  await expect(listRows(page)).toHaveCount(27);
  await expect(page).toHaveURL('/design?tab=iface');

  await page.unrouteAll();
  const api: FakeApi = await fakeApi(page);
  mountTasks(api);
  const d = designData();
  d.items = []; d.ownership = []; d.drifts = [];
  installDesign(api, d);
  await page.goto('/design?tab=iface');
  await expect(page.locator('[data-empty="none"]')).toContainText('아직 인터페이스 계약이 없습니다. 계약 설계 Task가 계약 파일을 main에 병합하면 여기에 나타납니다.');
  await page.goto('/design?tab=data');
  await expect(page.locator('[data-empty="none"]')).toContainText('아직 데이터 계약이 없습니다.');
  await page.goto('/design?tab=own');
  await expect(page.getByText('아직 정의가 없습니다.')).toBeVisible();
  await page.goto('/design?tab=chg');
  await expect(page.getByText('불일치가 없습니다.')).toBeVisible();
});

test('UAT-DESIGN-04 a: 소유권 · 흐름(원본·복제·동기화·지연 허용)', async ({ page }) => {
  await open(page, '/design?tab=own');
  const rows = page.getByRole('table', { name: '데이터 소유권 · 흐름' }).locator('[data-own]');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toHaveText(['Task · 의존성 · 체크리스트', 'PostgreSQL', 'Neo4j (Task · DEPENDS_ON)', 'design.item.changed / task 변경 이벤트 → graph-sync', '수 초'].join(''));
});

test('UAT-DESIGN-04 a: 계약에 반영은 job만 만들고 결과 커밋 전에는 해결로 바꾸지 않는다 / 코드 수정 요청은 메시지로', async ({ page }) => {
  const { writes } = await open(page, '/design?tab=chg');
  const r1 = driftRow(page, 'PATCH /api/tasks/:taskKey');
  await expect(r1.locator('.vf')).toHaveText('미해결');
  await expect(r1.locator('.sc')).toHaveText('호환');
  await r1.getByRole('button', { name: '계약에 반영' }).click();
  await expect(page.getByText('계약 반영을 요청했습니다. Runner가 결과 커밋을 보고하면 해결로 바뀝니다.')).toBeVisible();
  await expect(r1.locator('.vf')).toHaveText('계약 반영 대기');
  await expect(r1).toContainText('결과 커밋을 보고하고 대조가 일치해야 해결됩니다');
  await expect(r1.getByRole('button', { name: '계약에 반영' })).toHaveCount(0);
  await expect(tab(page, /변경 · 불일치/)).toHaveText('변경 · 불일치2');
  const r2 = driftRow(page, 'postgres:tasks');
  await r2.getByRole('button', { name: '코드 수정 요청' }).click();
  await expect(r2.locator('.vf')).toHaveText('해결됨');
  await expect(r2).toContainText('처리: 코드 수정 요청 → TASK-0004 메시지로 전달');
  expect(writes.map((w) => [w.path.split(' ')[0], w.body.how, w.body.decisionId])).toEqual([['resolve', 'contract', undefined], ['resolve', 'code', undefined]]);
  await expect(driftRow(page, 'runner.attempt.events').locator('.vf')).toHaveText('해결됨');
  await expect(driftRow(page, 'runner.attempt.events')).toContainText('처리: 계약에 반영 — 결과 커밋 a41f0c2');
});

const D1 = 'r0000000-0000-4000-8000-000000000001';
const TD = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('UAT-DESIGN-04 a / coord 2: 호환 깨짐은 같은 itemKey·같은 driftId의 승인 결정만 고를 수 있고 그 ID로 반영 요청', async ({ page }) => {
  const { writes } = await open(page, '/design?tab=chg', (d) => {
    const x = d.drifts[0]; if (x) x.compat = 'breaking';
    const td7 = d.decisions.find((y) => y.tdKey === 'TD-07'); if (td7) { td7.itemKey = 'PATCH /api/tasks/:taskKey'; td7.driftId = D1; }
    // 같은 항목이지만 옛 불일치, 다른 항목의 같은 불일치 — 고를 수 없어야 한다
    const td8 = d.decisions.find((y) => y.tdKey === 'TD-08'); if (td8) { td8.itemKey = 'PATCH /api/tasks/:taskKey'; td8.driftId = 'r0000000-0000-4000-8000-000000000099'; }
    const td9 = d.decisions.find((y) => y.tdKey === 'TD-09'); if (td9) { td9.itemKey = 'GET /api/tasks/:taskKey'; td9.driftId = D1; }
  });
  const r1 = driftRow(page, 'PATCH /api/tasks/:taskKey');
  await expect(r1.locator('.sc')).toHaveText('호환 깨짐');
  await r1.getByRole('button', { name: '계약에 반영' }).click();
  const dlg = page.getByRole('dialog', { name: '호환을 깨는 변경 — 계약에 반영' });
  await expect(dlg).toContainText('DR-01');
  await expect(dlg).toContainText('이 불일치에 연결해 승인한 기술 결정이 필요합니다');
  const select = dlg.getByLabel('승인된 기술 결정');
  await expect(select.locator('option')).toHaveText(['결정을 고르세요', 'TD-07 Runner ↔ 서버 제어 채널 — WebSocket']);
  const submit = dlg.getByRole('button', { name: '반영 요청' });
  await expect(submit).toBeDisabled();
  await select.selectOption({ label: 'TD-07 Runner ↔ 서버 제어 채널 — WebSocket' });
  await submit.click();
  await expect(dlg).toHaveCount(0);
  await expect(r1.locator('.vf')).toHaveText('계약 반영 대기');
  expect(writes[0]?.body).toMatchObject({ how: 'contract', decisionId: TD(7) });
});

test('UAT-DESIGN-04 a: 연결된 승인 결정이 없으면 반영을 막고(다른 항목의 승인은 안 됨) 기술 결정 탭으로 안내', async ({ page }) => {
  const { writes } = await open(page, '/design?tab=chg', (d) => { const x = d.drifts[0]; if (x) x.compat = 'breaking'; });
  await driftRow(page, 'PATCH /api/tasks/:taskKey').getByRole('button', { name: '계약에 반영' }).click();
  const dlg = page.getByRole('dialog', { name: '호환을 깨는 변경 — 계약에 반영' });
  await expect(dlg).toContainText('이 불일치(DR-01)에 연결된 승인 결정이 없습니다');
  await expect(dlg.getByLabel('승인된 기술 결정')).toHaveCount(0);
  await expect(dlg.getByRole('button', { name: '반영 요청' })).toBeDisabled();
  await dlg.getByRole('button', { name: '기술 결정 보기' }).click();
  await expect(page).toHaveURL('/design?tab=dec');
  expect(writes).toEqual([]);
});

test('coord 2 흐름: 팀장이 변경 제안에 불일치를 연결 → 승인 → 그 결정으로 호환 깨짐 반영', async ({ page }) => {
  const { writes } = await open(page, '/design?tab=dec', (d) => { const x = d.drifts[0]; if (x) x.compat = 'breaking'; });
  const row = decRow(page, 'TD-05');
  await row.getByRole('button', { name: '변경 제안' }).click();
  const dlg = page.getByRole('dialog', { name: 'TD-05 기술 결정 변경 제안' });
  await dlg.getByLabel('새 선택').fill('Neo4j 5 + 응답 필드 변경');
  await dlg.getByLabel('변경 이유').fill('PATCH 응답 계약을 바꾼다');
  await dlg.getByLabel('연결할 불일치').selectOption({ label: 'DR-01 PATCH /api/tasks/:taskKey' });
  await dlg.getByRole('button', { name: '변경 제안 올리기' }).click();
  await expect(row).toContainText('연결 PATCH /api/tasks/:taskKey · DR-01');
  // 연결된 승인 대기 결정이 있으면 반영 창이 그 결정을 승인하라고 안내한다
  await tab(page, /변경 · 불일치/).click();
  await driftRow(page, 'PATCH /api/tasks/:taskKey').getByRole('button', { name: '계약에 반영' }).click();
  await expect(page.getByRole('dialog', { name: '호환을 깨는 변경 — 계약에 반영' })).toContainText('승인 대기 중인 연결 결정 TD-05');
  await page.getByRole('dialog').getByRole('button', { name: '기술 결정 보기' }).click();
  await decRow(page, 'TD-05').getByRole('button', { name: '승인' }).click();
  await expect(decRow(page, 'TD-05').locator('.vf')).toHaveText('승인됨');
  await tab(page, /변경 · 불일치/).click();
  await driftRow(page, 'PATCH /api/tasks/:taskKey').getByRole('button', { name: '계약에 반영' }).click();
  const br = page.getByRole('dialog', { name: '호환을 깨는 변경 — 계약에 반영' });
  await br.getByLabel('승인된 기술 결정').selectOption({ index: 1 });
  await br.getByRole('button', { name: '반영 요청' }).click();
  await expect(driftRow(page, 'PATCH /api/tasks/:taskKey').locator('.vf')).toHaveText('계약 반영 대기');
  expect(writes.map((w) => w.path.split(' ')[0])).toEqual(['change', 'approve', 'resolve']);
  expect(writes[0]?.body).toMatchObject({ itemKey: 'PATCH /api/tasks/:taskKey', driftId: D1 });
  expect(writes[2]?.body).toMatchObject({ how: 'contract', decisionId: TD(5) });
});

test('반영 job 진행(resolution.jobStatus): 대기·진행 중에는 다시 요청 없음, 실패면 실패 표시와 다시 요청·코드 수정 요청', async ({ page }) => {
  const { data } = await open(page, '/design?tab=chg', (d) => {
    const x = d.drifts[0]; if (x) x.resolution = { how: 'contract', jobId: 'job-7', jobStatus: 'running' };
  });
  const r1 = driftRow(page, 'PATCH /api/tasks/:taskKey');
  await expect(r1.locator('.vf')).toHaveText('계약 반영 중');
  await expect(r1.getByRole('button', { name: '코드 수정 요청' })).toHaveCount(0);
  await expect(r1.getByRole('button', { name: '계약 반영 다시 요청' })).toHaveCount(0);
  const x = data.drifts[0]; if (x) x.resolution = { how: 'contract', jobId: 'job-7', jobStatus: 'failed' };
  await page.reload();
  await expect(r1.locator('.vf')).toHaveText('계약 반영 실패');
  await expect(r1).toContainText('계약 반영 작업이 실패했습니다');
  await expect(r1.getByRole('button', { name: '계약 반영 다시 요청' })).toBeVisible();
  await expect(r1.getByRole('button', { name: '코드 수정 요청' })).toBeVisible();
  await r1.getByRole('button', { name: '계약 반영 다시 요청' }).click();
  await expect(r1.locator('.vf')).toHaveText('계약 반영 대기');
});

test('M6-05 fix1 표시: 항목 설명, 불일치 표시 번호(DR-01), 메시지 인터페이스의 기술 결정(TD-07)', async ({ page }) => {
  await open(page, '/design?tab=iface&kind=REST');
  const patch = listRows(page).filter({ hasText: 'PATCH /api/tasks/:taskKey' });
  await expect(patch).toContainText('부분 수정 + 변경 이력 기록');
  await page.getByRole('searchbox', { name: '검색' }).fill('변경 이력');
  await expect(listRows(page)).toHaveCount(1);
  await page.goto('/design?tab=iface&kind=WebSocket&sel=WS%20%2Frunner%2Fws');
  const ws = page.getByRole('region', { name: '/runner/ws 상세' });
  await expect(ws).toContainText('Runner ↔ 서버 제어 채널');
  await ws.getByRole('link', { name: 'TD-07' }).click();
  await expect(page).toHaveURL('/design?tab=dec');
  await page.goto('/design?tab=chg');
  await expect(driftRow(page, 'PATCH /api/tasks/:taskKey')).toContainText('DR-01');
  await expect(driftRow(page, 'runner.attempt.events')).toContainText('DR-03');
});

test('브랜치 조회(ref 규칙): agent/TASK-0005 초안은 ref를 붙여 읽고 처리 버튼이 없다, 형식이 틀린 ref는 main으로', async ({ page }) => {
  const { api } = await open(page, '/design', (d) => {
    d.branch = {
      ref: 'agent/TASK-0005', files: d.files.slice(0, 1).map((f) => ({ ...f, status: 'draft' as const })),
      items: d.items.filter((x) => x.taskKey === 'TASK-0005'),
      drifts: [{ ...d.drifts[0], id: 'r0000000-0000-4000-8000-000000000050', displayKey: 'DR-50', where: 'agent/TASK-0005', resolution: { ref: 'agent/TASK-0005' } } as DesignData['drifts'][number]],
    };
  });
  const files = page.getByRole('table', { name: '계약 파일' }).locator('[data-file]');
  await expect(files).toHaveCount(6);
  await page.getByRole('combobox').selectOption('agent/TASK-0005');
  await expect(page).toHaveURL('/design?ref=agent%2FTASK-0005');
  await expect(page.locator('.banner.info')).toContainText('브랜치 agent/TASK-0005 초안을 보고 있습니다');
  await expect(files).toHaveCount(1);
  await expect(files.nth(0).locator('.vf')).toHaveText('브랜치 초안');
  await tab(page, /인터페이스/).click();
  await expect(page).toHaveURL('/design?tab=iface&ref=agent%2FTASK-0005');
  await expect(listRows(page)).toHaveCount(5);
  await listRows(page).first().click();
  await expect(page.getByRole('region', { name: /상세$/ })).toBeVisible();
  expect(api.calls().filter((c) => c.includes('/design/interfaces/')).every((c) => c.includes('ref=agent%2FTASK-0005'))).toBe(true);
  await tab(page, /변경 · 불일치/).click();
  const r = driftRow(page, 'PATCH /api/tasks/:taskKey');
  await expect(r).toContainText('DR-50');
  await expect(r).toContainText('브랜치 초안의 불일치입니다');
  await expect(r.getByRole('button', { name: '계약에 반영' })).toHaveCount(0);
  await page.locator('.banner.info').getByRole('button', { name: 'main 보기' }).click();
  await expect(page).toHaveURL('/design?tab=chg');
  await expect(driftRow(page, 'PATCH /api/tasks/:taskKey').getByRole('button', { name: '계약에 반영' })).toBeVisible();
  await page.goto('/design?ref=refs%2Fheads%2Fmain');
  await expect(page.locator('.banner.warn').first()).toContainText('refs/heads/main');
  await expect(files).toHaveCount(6);
  expect(api.calls().some((c) => c.includes('ref=refs'))).toBe(false);
});

test('대조 안 함(unchecked)은 「대조 안 함」으로 보이고 불일치 0건이나 호환으로 보이지 않는다', async ({ page }) => {
  await open(page, '/design?tab=chg', (d) => {
    d.drifts = d.drifts.filter((x) => x.status === 'done');
    d.drifts.push({ id: 'r0000000-0000-4000-8000-000000000009', displayKey: 'DR-09', itemKey: 'file:contracts/cache/redis-keys.yaml', kind: 'Redis', where: 'main', text: '키 카탈로그에서 명세를 추출하지 못함', taskKey: null, compat: 'unchecked', status: 'open', updatedAt: '2026-11-05T09:00:00.000Z', resolution: {} });
  });
  await expect(page.locator('.page-sub.mono')).toHaveText('설계 v3 · 기술 결정 11 (승인 대기 1) · 인터페이스 27 · 데이터 항목 16 · 대조 안 함 1');
  await expect(tab(page, /변경 · 불일치/)).toHaveText('변경 · 불일치1');
  const r = driftRow(page, 'file:contracts/cache/redis-keys.yaml');
  await expect(r.locator('.vf')).toHaveText('대조 안 함');
  await expect(r.locator('.sc')).toHaveText('대조 안 함');
  await expect(r).toContainText('불일치 0건이 아닙니다');
  await expect(r.getByRole('button', { name: '계약에 반영' })).toHaveCount(0);
  await tab(page, /구성도/).click();
  const redis = page.getByRole('table', { name: '계약 파일' }).locator('[data-file]').filter({ hasText: 'redis-keys.yaml' });
  await expect(redis).toContainText('대조 안 함');
});

test('UAT-DESIGN-04 b: 설계 버전별 변경 주체·시각·호환 깨짐', async ({ page }) => {
  await open(page, '/design?tab=chg', (d) => { d.versions.unshift({ v: 4, at: '2026-11-05T10:00:00.000Z', by: '팀장 승인 (TD-08)', note: '화면 갱신 SSE → WebSocket 로 변경', breaking: true }); });
  const rows = page.getByRole('table', { name: '설계 버전' }).locator('[data-ver]');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('v4');
  await expect(rows.nth(0)).toContainText('2026-11-05 19:00');
  await expect(rows.nth(0)).toContainText('팀장 승인 (TD-08)');
  await expect(rows.nth(0).locator('.sc.sc-bad')).toHaveText('호환 깨짐');
  await expect(rows.nth(1).locator('.sc.sc-bad')).toHaveCount(0);
});

test('Task 연결 / 시나리오 28: Task 상세 기술 설계 「제품 전체 설계에서 보기」 → 설계 상세, 담당 Task로 되돌아간다', async ({ page }) => {
  await open(page, '/wbs/TASK-0005?tab=tech', undefined, 'WBS');
  const link = page.locator('.ds-link').getByRole('link', { name: 'PATCH /api/tasks/:taskKey' });
  await expect(link).toHaveAttribute('href', '/design?tab=iface&sel=PATCH+%2Fapi%2Ftasks%2F%3AtaskKey');
  await link.click();
  await expect(page.getByRole('region', { name: 'PATCH /api/tasks/:taskKey 상세' })).toBeVisible();
  await page.goto('/wbs/TASK-0004?tab=tech');
  await page.locator('.ds-link').getByRole('link', { name: 'tasks', exact: true }).click();
  await expect(page.getByRole('region', { name: 'tasks 상세' })).toContainText('task_key');
});

test('시나리오 29(설계 메뉴 부분): 기술 결정 확정 직후 — 확정 결정과 계획 상태 인터페이스', async ({ page }) => {
  await open(page, '/design?tab=iface', (d) => {
    d.decisions = d.decisions.filter((x) => x.status !== 'pending');
    d.drifts = [];
  });
  await expect(page.locator('.banner.warn')).toHaveCount(0);
  const ws = listRows(page).filter({ hasText: '/runner/ws' });
  await expect(ws.locator('.vf')).toHaveText('계획');
  await tab(page, /기술 결정/).click();
  await expect(decRow(page, 'TD-01').locator('.vf')).toHaveText('확정');
});

test('불러오기 실패는 오류 카드와 다시 시도', async ({ page }) => {
  const api = await fakeApi(page);
  mountTasks(api);
  installDesign(api, designData());
  api.on('GET /api/projects/p1/design/drifts', (route) => json(route, 503, { error: { code: 'UNAVAILABLE', message: '잠시 후', action: '조회', fix: '다시', errors: [], details: {}, requestId: 'r' } }));
  await page.goto('/design');
  await expect(page.getByRole('button', { name: '다시 시도' })).toBeVisible();
});

test('자동 접근성 검사: 탭마다·상세·창에서 axe 위반 0건', async ({ page }) => {
  await open(page);
  for (const path of ['/design', '/design?tab=dec', '/design?tab=iface', '/design?tab=iface&sel=PATCH+%2Fapi%2Ftasks%2F%3AtaskKey', '/design?tab=data&store=postgres&sel=postgres%3Atasks', '/design?tab=own', '/design?tab=chg']) {
    await page.goto(path);
    await expect(page.getByRole('tablist', { name: '설계 영역' })).toBeVisible();
    await expect(page.locator('.skeleton, .area-loading')).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations, path).toEqual([]);
  }
  await page.goto('/design?tab=dec');
  await decRow(page, 'TD-05').getByRole('button', { name: '변경 제안' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

/* ---- Codex fix2 리뷰 지적(review-codex-fix2.md) ---- */
const BRANCH = (d: DesignData) => {
  d.branch = {
    ref: 'agent/TASK-0005', files: d.files.slice(0, 1).map((f) => ({ ...f, status: 'draft' as const })),
    items: d.items.filter((x) => x.taskKey === 'TASK-0005'),
    drifts: [{ ...d.drifts[0], id: 'r0000000-0000-4000-8000-000000000050', displayKey: 'DR-50', where: 'agent/TASK-0005', resolution: { ref: 'agent/TASK-0005' } } as DesignData['drifts'][number]],
  };
};

test('리뷰 1: 반영 job 상태가 바뀌면 새로고침 없이 따라간다(진행 중 job이 있는 동안 다시 읽기)', async ({ page }) => {
  const { data } = await open(page, '/design?tab=chg', (d) => { const x = d.drifts[0]; if (x) x.resolution = { how: 'contract', jobId: 'job-7', jobStatus: 'queued' }; });
  const r1 = driftRow(page, 'PATCH /api/tasks/:taskKey');
  await expect(r1.locator('.vf')).toHaveText('계약 반영 대기');
  const x = data.drifts[0]; if (x) x.resolution = { how: 'contract', jobId: 'job-7', jobStatus: 'failed' };
  await expect(r1.locator('.vf')).toHaveText('계약 반영 실패', { timeout: 12_000 });
  await expect(r1.getByRole('button', { name: '계약 반영 다시 요청' })).toBeVisible();
});

test('리뷰 2: 브랜치 → main 전환 중 늦게 오는 main 응답 동안 브랜치 불일치에 처리 버튼이 없다', async ({ page }) => {
  const { api, data } = await open(page, '/design?tab=chg&ref=agent%2FTASK-0005', BRANCH);
  await expect(driftRow(page, 'PATCH /api/tasks/:taskKey')).toContainText('DR-50');
  const gate = hold((route) => json(route, 200, { items: data.drifts }));
  api.on('GET /api/projects/p1/design/drifts', (route, req) => (new URL(req.url()).searchParams.get('ref') ? json(route, 200, { items: data.branch?.drifts ?? [] }) : gate.handler(route, req)));
  await page.locator('.banner.info').getByRole('button', { name: 'main 보기' }).click();
  await expect(page).toHaveURL('/design?tab=chg');
  await gate.started;
  await expect(page.getByText('DR-50')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '계약에 반영' })).toHaveCount(0);
  gate.release();
  await expect(driftRow(page, 'PATCH /api/tasks/:taskKey')).toContainText('DR-01');
  await expect(driftRow(page, 'PATCH /api/tasks/:taskKey').getByRole('button', { name: '계약에 반영' })).toBeVisible();
});

test('리뷰 3: 브랜치에서 메시지 상세의 TD 링크로 가도 ref가 남는다', async ({ page }) => {
  await open(page, '/design?tab=iface&ref=agent%2FTASK-0005', (d) => { BRANCH(d); d.branch?.items.push(...d.items.filter((x) => x.key === 'WS /runner/ws')); });
  await page.goto('/design?tab=iface&ref=agent%2FTASK-0005&kind=WebSocket&sel=WS%20%2Frunner%2Fws');
  await page.getByRole('region', { name: '/runner/ws 상세' }).getByRole('link', { name: 'TD-07' }).click();
  await expect(page).toHaveURL('/design?tab=dec&ref=agent%2FTASK-0005');
  await expect(page.locator('.banner.info')).toContainText('agent/TASK-0005');
});

test('리뷰 4: 연결된 결정을 다른 불일치로 바꾸는 변경 제안은 현재 연결과 승인 후 연결을 함께 보인다', async ({ page }) => {
  await open(page, '/design?tab=dec', (d) => {
    for (const x of d.drifts.slice(0, 2)) x.compat = 'breaking';
    const td5 = d.decisions.find((y) => y.tdKey === 'TD-05');
    if (td5) {
      td5.itemKey = 'PATCH /api/tasks/:taskKey'; td5.driftId = D1; td5.status = 'change';
      td5.change = { choice: 'X', reason: 'Y', previousStatus: 'approved', itemKey: 'postgres:tasks', driftId: 'r0000000-0000-4000-8000-000000000002' };
    }
  });
  const row = decRow(page, 'TD-05');
  await expect(row).toContainText('연결 PATCH /api/tasks/:taskKey · DR-01');
  await expect(row).toContainText('승인 후 연결 postgres:tasks · DR-02');
});

test('리뷰 5: 저장 응답을 기다리는 동안 연결을 바꾸면 성공 뒤에도 창과 바꾼 연결이 남는다', async ({ page }) => {
  const { api, data } = await open(page, '/design?tab=dec', (d) => { for (const x of d.drifts.slice(0, 2)) x.compat = 'breaking'; });
  const gate = hold((route) => {
    const x = data.decisions.find((y) => y.tdKey === 'TD-05');
    if (x) { x.status = 'change'; x.change = { choice: 'A', reason: 'B', previousStatus: 'approved', itemKey: 'PATCH /api/tasks/:taskKey', driftId: D1 }; x.updatedAt = '2026-11-05T11:00:00.000Z'; }
    return json(route, 200, x);
  });
  api.on(`POST /api/design/decisions/${TD(5)}/change`, gate.handler);
  await decRow(page, 'TD-05').getByRole('button', { name: '변경 제안' }).click();
  const dlg = page.getByRole('dialog', { name: 'TD-05 기술 결정 변경 제안' });
  await dlg.getByLabel('새 선택').fill('A');
  await dlg.getByLabel('변경 이유').fill('B');
  await dlg.getByLabel('연결할 불일치').selectOption({ label: 'DR-01 PATCH /api/tasks/:taskKey' });
  await dlg.getByRole('button', { name: '변경 제안 올리기' }).click();
  await dlg.getByLabel('연결할 불일치').selectOption({ label: 'DR-02 postgres:tasks' });
  gate.release();
  await expect(page.getByText('TD-05 변경 제안을 올렸습니다')).toBeVisible();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel('연결할 불일치')).toHaveValue('r0000000-0000-4000-8000-000000000002');
});

test('리뷰 6: 실패한 호환 깨짐 반영의 다시 요청은 지금 유효한 연결 승인 결정을 다시 고르게 한다', async ({ page }) => {
  const { writes } = await open(page, '/design?tab=chg', (d) => {
    const x = d.drifts[0];
    if (x) { x.compat = 'breaking'; x.resolution = { how: 'contract', jobId: 'job-7', jobStatus: 'failed', decisionId: TD(7) }; }
    const td7 = d.decisions.find((y) => y.tdKey === 'TD-07');
    if (td7) { td7.itemKey = 'PATCH /api/tasks/:taskKey'; td7.driftId = D1; td7.status = 'change'; td7.change = { choice: 'Q', reason: 'R', previousStatus: 'approved' }; }
    const td8 = d.decisions.find((y) => y.tdKey === 'TD-08');
    if (td8) { td8.itemKey = 'PATCH /api/tasks/:taskKey'; td8.driftId = D1; }
  });
  await driftRow(page, 'PATCH /api/tasks/:taskKey').getByRole('button', { name: '계약 반영 다시 요청' }).click();
  const dlg = page.getByRole('dialog', { name: '호환을 깨는 변경 — 계약에 반영' });
  await expect(dlg.getByLabel('승인된 기술 결정').locator('option')).toHaveText(['결정을 고르세요', 'TD-08 화면 실시간 갱신 — SSE (Server-Sent Events)']);
  await dlg.getByLabel('승인된 기술 결정').selectOption({ index: 1 });
  await dlg.getByRole('button', { name: '반영 요청' }).click();
  await expect(driftRow(page, 'PATCH /api/tasks/:taskKey').locator('.vf')).toHaveText('계약 반영 대기');
  expect(writes[0]?.body).toMatchObject({ how: 'contract', decisionId: TD(8) });
});

test('리뷰 7: 가짜 API도 서버처럼 닫힌 불일치·항목이 다른 연결을 거부한다', async ({ page }) => {
  await open(page, '/design?tab=dec');
  const post = (driftId: string, itemKey: string) => page.evaluate(async ([id, dr, ik]) => {
    const r = await fetch(`/api/design/decisions/${id}/change`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updatedAt: '2026-10-27T01:05:00.000Z', choice: 'a', reason: 'b', itemKey: ik, driftId: dr }) });
    const body = (await r.json()) as { error?: { code: string; errors: { path: string }[] } };
    return r.status === 200 ? { status: 200 } : { status: r.status, code: body.error?.code, path: body.error?.errors[0]?.path };
  }, [TD(5), driftId, itemKey] as const);
  // 실제 서버는 400 VALIDATION_FAILED + driftId 필드 오류다(apps/api/src/design/service.ts invalid, r2 리뷰 P3).
  expect(await post('r0000000-0000-4000-8000-000000000003', 'runner.attempt.events')).toEqual({ status: 400, code: 'VALIDATION_FAILED', path: 'driftId' });
  expect(await post(D1, 'postgres:tasks')).toEqual({ status: 400, code: 'VALIDATION_FAILED', path: 'driftId' });
  expect((await post(D1, 'PATCH /api/tasks/:taskKey')).status).toBe(200);
});

test('리뷰 r2-P3: 제안 뒤 연결한 불일치가 닫히면 승인은 400 VALIDATION_FAILED(driftId)로 거부되고 입력 오류로 보인다', async ({ page }) => {
  const { data } = await open(page, '/design?tab=dec', (d) => {
    const td5 = d.decisions.find((y) => y.tdKey === 'TD-05');
    if (td5) { td5.status = 'change'; td5.change = { choice: 'X', reason: 'Y', previousStatus: 'approved', itemKey: 'PATCH /api/tasks/:taskKey', driftId: D1 }; }
  });
  const x = data.drifts[0]; if (x) x.status = 'done';
  await decRow(page, 'TD-05').getByRole('button', { name: '승인' }).click();
  await expect(page.locator('.errbar')).toContainText('VALIDATION_FAILED');
  await expect(decRow(page, 'TD-05').locator('.vf')).toHaveText('변경 제안 — 승인 대기');
});

test('리뷰 r2-P2: 다시 읽기 간격(4초)보다 느린 응답도 취소하지 않고 기다려 실패를 보인다', async ({ page }) => {
  const { api, data } = await open(page, '/design?tab=chg', (d) => { const x = d.drifts[0]; if (x) x.resolution = { how: 'contract', jobId: 'job-7', jobStatus: 'queued' }; });
  const r1 = driftRow(page, 'PATCH /api/tasks/:taskKey');
  await expect(r1.locator('.vf')).toHaveText('계약 반영 대기');
  const x = data.drifts[0]; if (x) x.resolution = { how: 'contract', jobId: 'job-7', jobStatus: 'failed' };
  api.on('GET /api/projects/p1/design/drifts', delay(5_000, (route) => json(route, 200, { items: data.drifts })));
  await expect(r1.locator('.vf')).toHaveText('계약 반영 실패', { timeout: 20_000 });
});
