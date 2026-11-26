/**
 * Task 상세 작업 탭 — 작업 명세(UAT-TASK-05, 시나리오 1), 기술 설계(UAT-TASK-07·08, 시나리오 2),
 * 의존성(시나리오 3), 체크리스트(UAT-TASK-09, 시나리오 4).
 */
import { expect, test, type Page } from '@playwright/test';
import { fakeApi, type FakeApi } from './support/fake-api.ts';
import { mountTasks, newStore, type TaskStore } from './support/task-api.ts';

async function open(page: Page, url: string): Promise<{ api: FakeApi; s: TaskStore }> {
  const api = await fakeApi(page);
  const s = mountTasks(api, newStore());
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  return { api, s };
}
const lastBody = <T>(api: FakeApi, key: string) => api.requests(key).at(-1)?.postDataJSON() as T;

test('UAT-TASK-05 명세: 6그룹 13섹션, 줄 섹션 편집, AC 표 행 추가·삭제·필수 빈칸 거부, 산출물 칸 보존', async ({ page }) => {
  const { api } = await open(page, '/wbs/TASK-0004?tab=spec');
  await expect(page.getByRole('group')).toHaveCount(6);
  await expect(page.locator('.ssec')).toHaveCount(13);
  await expect(page.locator('.pane-hl')).toContainText('작성 13 / 13 섹션');
  await expect(page.getByRole('table', { name: 'Acceptance Criteria' })).toContainText('AC-1');

  // 줄 섹션 편집 → spec 전체를 보내되 바꾼 섹션만 다르다
  await page.getByRole('button', { name: '기술적 제약 편집' }).click();
  await page.getByLabel('기술적 제약 편집').fill('PostgreSQL 16\n`pgEnum` 사용');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '「기술적 제약」을(를) 저장했습니다.' })).toBeVisible();
  const spec = lastBody<{ spec: Record<string, string[]> }>(api, 'PATCH /api/tasks/TASK-0004/spec');
  expect(spec.spec.constraints).toEqual(['PostgreSQL 16', '`pgEnum` 사용']);
  expect(spec.spec.steps).toHaveLength(4);
  await expect(page.getByRole('region', { name: '기술적 제약' }).locator('code')).toHaveText('pgEnum');

  // AC 표: 행 추가 → 필수 빈칸이면 저장 꺼짐·오류 목록, 채우면 저장. 행 삭제
  await page.getByRole('button', { name: 'Acceptance Criteria 편집' }).click();
  const editor = page.getByRole('form', { name: 'Acceptance Criteria 편집' });
  await editor.getByRole('button', { name: '+ 기준 추가' }).click();
  await expect(editor.getByRole('alert')).toContainText('Acceptance Criteria 4행: Given (전제) 필수');
  await expect(editor.getByRole('button', { name: '저장', exact: true }).first()).toBeDisabled();
  await editor.getByLabel('Given (전제) 4행').fill('Task 4건');
  await editor.getByLabel('When (행동) 4행').fill('migrate 2회');
  await editor.getByLabel('Then (기대 결과) 4행').fill('두 번째는 변경 없음');
  await editor.getByLabel('검증 방법 4행').fill('SQL 로그');
  await editor.getByRole('button', { name: '1행 삭제' }).click();
  await editor.getByRole('button', { name: '저장', exact: true }).first().click();
  const ac = lastBody<{ ac: { given: string; when: string; then: string; method: string }[] }>(api, 'PATCH /api/tasks/TASK-0004/spec').ac;
  expect(ac).toHaveLength(3);
  expect(ac.at(-1)).toEqual({ given: 'Task 4건', when: 'migrate 2회', then: '두 번째는 변경 없음', method: 'SQL 로그' });
  await expect(page.getByRole('table', { name: 'Acceptance Criteria' })).toContainText('두 번째는 변경 없음');

  // 산출물: 경로/유형/필수/검증 조건/제출 칸을 그대로 보낸다
  await page.getByRole('button', { name: '산출물 및 검증 조건 편집' }).click();
  const out = page.getByRole('form', { name: '산출물 및 검증 조건 편집' });
  await out.getByLabel('제출 4행').check();
  await out.getByLabel('유형 4행').selectOption('설정');
  await out.getByRole('button', { name: '저장', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: 'Completion Gate가 다시 계산되었습니다.' })).toBeVisible();
  const outputs = lastBody<{ outputs: unknown[] }>(api, 'PATCH /api/tasks/TASK-0004/outputs').outputs;
  expect(outputs[3]).toEqual({ name: 'docs/erd.png', kind: '설정', required: false, verify: 'Schema와 일치', delivered: true });
});

test('시나리오 2 · UAT-TASK-07 DB 설계: 권장 섹션, 테이블 추가(컬럼·FK·인덱스) → 관계 테이블 계산, 블록 편집, 섹션 제거 확인', async ({ page }) => {
  const { api } = await open(page, '/wbs/TASK-0004?tab=tech');
  await expect(page.locator('.dt-body .fhint').first()).toContainText('기술 영역 DB · BE 기준 권장 섹션: DB 설계, BE / API 설계');
  await expect(page.locator('.secadd')).toContainText('+ BE / API 설계');
  const db = page.getByRole('region', { name: 'DB 설계' });
  await expect(db.getByRole('group', { name: '테이블 tasks' })).toBeVisible();
  await expect(db.getByRole('table', { name: '관계 테이블' })).toContainText('tasks.wbs_node_id');

  await db.getByRole('button', { name: '+ 테이블 추가' }).click();
  const ed = page.getByRole('form', { name: '테이블 추가' });
  await ed.getByLabel('테이블명').fill('task_notes');
  await ed.getByRole('button', { name: '+ 컬럼 추가' }).click();
  await ed.getByLabel('컬럼명 4행').fill('task_id');
  await ed.getByLabel('데이터 타입 4행').fill('uuid');
  await ed.getByLabel('FK 참조 4행').fill('tasks.id');
  await ed.getByRole('button', { name: '+ Index 추가' }).click();
  await ed.getByLabel('Index 이름 1행').fill('task_notes_task_idx');
  await ed.getByLabel('대상 컬럼 (쉼표 구분) 1행').fill('task_id');
  await ed.getByRole('button', { name: '저장', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '테이블 task_notes을(를) 저장했습니다.' })).toBeVisible();
  const content = lastBody<{ content: { ents: { f: { name: string }; b: { columns: { name: string; fk: string }[] } }[] } }>(api, 'PATCH /api/tasks/TASK-0004/design/DB').content;
  expect(content.ents.at(-1)?.f.name).toBe('task_notes');
  expect(content.ents.at(-1)?.b.columns.map((c) => c.name)).toEqual(['id', 'created_at', 'updated_at', 'task_id']);
  await expect(db.getByRole('table', { name: '관계 테이블' })).toContainText('task_notes.task_id');

  // 블록 편집(Migration 요구사항)
  await db.getByRole('button', { name: 'Migration 요구사항 편집' }).click();
  await page.getByRole('form', { name: 'Migration 요구사항 편집' }).getByLabel('Migration 요구사항').fill('0002_notes.sql 추가');
  await page.getByRole('button', { name: '저장', exact: true }).first().click();
  await expect(db.getByRole('region', { name: 'Migration 요구사항' })).toContainText('0002_notes.sql 추가');

  // 섹션 추가(BE/API) 후 제거: 취소는 보존, 확인만 제거
  await page.getByRole('button', { name: '+ BE / API 설계' }).click();
  const apiSec = page.getByRole('region', { name: 'BE / API 설계' });
  await expect(apiSec).toContainText('Endpoint가 없습니다.');
  await apiSec.getByRole('button', { name: '섹션 제거' }).click();
  await page.getByRole('alertdialog', { name: '설계 섹션 제거' }).getByRole('button', { name: '취소' }).click();
  await expect(apiSec).toBeVisible();
  await apiSec.getByRole('button', { name: '섹션 제거' }).click();
  await page.getByRole('alertdialog', { name: '설계 섹션 제거' }).getByRole('button', { name: '섹션 제거' }).click();
  await expect(apiSec).toHaveCount(0);
  expect(lastBody<{ content: object }>(api, 'PATCH /api/tasks/TASK-0004/design/API').content).toEqual({});
});

test('UAT-TASK-08 설계 편집기: 중복 테이블·없는 FK·nullable PK·없는 인덱스 컬럼·중복 Endpoint·잘못된 HTTP/환경변수는 막고 초안 유지, 비밀 값 가림', async ({ page }) => {
  const { api } = await open(page, '/wbs/TASK-0004?tab=tech');
  const db = page.getByRole('region', { name: 'DB 설계' });
  await db.getByRole('button', { name: '+ 테이블 추가' }).click();
  const ed = page.getByRole('form', { name: '테이블 추가' });
  await ed.getByLabel('테이블명').fill('tasks');
  await ed.getByLabel('Null 1행').check();
  await ed.getByRole('button', { name: '+ 컬럼 추가' }).click();
  await ed.getByLabel('컬럼명 4행').fill('ghost_id');
  await ed.getByLabel('데이터 타입 4행').fill('uuid');
  await ed.getByLabel('FK 참조 4행').fill('ghosts.id');
  await ed.getByRole('button', { name: '+ Index 추가' }).click();
  await ed.getByLabel('Index 이름 1행').fill('ix');
  await ed.getByLabel('대상 컬럼 (쉼표 구분) 1행').fill('nope');
  const errs = ed.getByRole('alert');
  await expect(errs).toContainText('테이블 tasks은(는) 이미 TASK-0004에서 정의되어 있습니다.');
  await expect(errs).toContainText('컬럼 정의 1행: PK 컬럼은 Null을 허용할 수 없습니다');
  await expect(errs).toContainText('FK 대상 테이블 ghosts이(가) 어떤 Task에도 정의되어 있지 않습니다');
  await expect(errs).toContainText('Index ix: 컬럼 nope이(가) 테이블에 없습니다');
  await expect(ed.getByLabel('FK 참조 4행')).toHaveAttribute('aria-invalid', 'true');
  await expect(ed.getByRole('button', { name: '저장', exact: true }).first()).toBeDisabled();
  await expect(ed.getByLabel('컬럼명 4행')).toHaveValue('ghost_id');
  await ed.getByRole('button', { name: '취소' }).first().click();
  expect(api.calls().filter((c) => c.startsWith('PATCH'))).toEqual([]);

  // API: 중복 Endpoint·HTTP 3자리
  await open(page, '/wbs/TASK-0005?tab=tech');
  const apiSec = page.getByRole('region', { name: 'BE / API 설계' });
  await apiSec.getByRole('button', { name: '+ Endpoint 추가' }).click();
  const ep = page.getByRole('form', { name: 'Endpoint 추가' });
  await ep.getByLabel('Path').fill('/api/projects/:projectId/tasks');
  await ep.getByRole('group', { name: 'HTTP Method' }).getByRole('button', { name: 'POST' }).click();
  await ep.getByRole('button', { name: '+ 오류 추가' }).click();
  await ep.getByLabel('오류 코드 1행').fill('X');
  await ep.getByLabel('HTTP 1행').fill('40');
  await expect(ep.getByRole('alert')).toContainText('POST /api/projects/:projectId/tasks Endpoint가 이미 있습니다.');
  await expect(ep.getByRole('alert')).toContainText('Error Response 1행: HTTP 상태는 3자리 숫자');
  await ep.getByRole('button', { name: '취소' }).first().click();

  // DevOps 환경 변수: 이름 규칙, 비밀 값은 읽기에서 가림
  await open(page, '/wbs/TASK-0002?tab=tech');
  const ops = page.getByRole('region', { name: 'DevOps 설계' });
  await expect(ops.getByRole('table', { name: '환경 변수' })).toContainText('••••••');
  await ops.getByRole('button', { name: '환경 변수 편집' }).click();
  const env = page.getByRole('form', { name: '환경 변수 편집' });
  await env.getByLabel('변수명 1행').fill('database_url');
  await expect(env.getByRole('alert')).toContainText('환경 변수 1행: 변수명은 대문자 · 숫자 · _ 만 사용');
});

test('시나리오 3 의존성: 선행 지정 → 실행 차단 표시, 순환 추가는 경로와 함께 저장 차단, 삭제는 확인 후', async ({ page }) => {
  const { api } = await open(page, '/wbs/TASK-0010?tab=deps');
  await expect(page.locator('.dt-body .banner.ok')).toContainText('실행 가능');
  await page.getByRole('button', { name: '+ 선행 Task 추가' }).click();
  // 순환: TASK-0011은 TASK-0010의 후속이다
  await page.getByRole('searchbox', { name: '선행 Task 검색' }).fill('TASK-0011');
  await page.getByRole('listitem').filter({ hasText: 'TASK-0011' }).click();
  const block = page.locator('.addbox').getByRole('alert');
  await expect(block).toContainText('저장 차단 — 이 선행 관계를 추가하면 순환 의존성이 생깁니다.');
  await expect(block).toContainText('TASK-0010 → TASK-0011 → TASK-0010');
  await expect(page.getByRole('table', { name: '선행 Task' })).not.toContainText('TASK-0011');
  // 자기 참조
  await page.getByRole('searchbox', { name: '선행 Task 검색' }).fill('TASK-0010');
  await page.getByRole('listitem').filter({ hasText: '(현재 Task)' }).click();
  await expect(block).toContainText('자기 자신을 선행으로 지정할 수 없습니다.');

  // 미완료 선행 추가 → 실행 차단
  await page.getByRole('searchbox', { name: '선행 Task 검색' }).fill('TASK-0005');
  await page.getByRole('group', { name: '의존성 유형' }).getByRole('button', { name: '완료 → 시작 (FS)' }).click();
  await page.getByRole('listitem').filter({ hasText: 'TASK-0005' }).click();
  await expect(page.getByRole('status').filter({ hasText: '선행 관계 TASK-0005 → TASK-0010를 추가했습니다.' })).toBeVisible();
  await expect(page.locator('.dt-head .banner.danger')).toContainText('TASK-0005 Task CRUD API (실행 중, 완료 필요)');
  await expect(page.getByRole('tab', { name: /^의존성/ })).toHaveText('의존성3');
  expect(lastBody<{ predTaskKey: string; depType: string }>(api, 'POST /api/tasks/TASK-0010/dependencies')).toMatchObject({ predTaskKey: 'TASK-0005', depType: 'FS' });

  // 삭제(확인)
  await page.getByRole('button', { name: 'TASK-0005 선행 관계 삭제' }).click();
  await page.getByRole('alertdialog', { name: '선행 관계 삭제' }).getByRole('button', { name: '삭제' }).click();
  await expect(page.getByRole('status').filter({ hasText: '선행 관계 TASK-0005 → TASK-0010를 삭제했습니다.' })).toBeVisible();
  await expect(page.locator('.dt-head .banner.danger')).toHaveCount(0);
});

test('시나리오 4 · UAT-TASK-09 체크리스트: 빈 내용 추가 거부, 필수/선택·방법·Evidence·비고 표시, 완료 토글 → 진행률·Gate·이력 갱신', async ({ page }) => {
  const { api } = await open(page, '/wbs/TASK-0004?tab=checklist');
  const table = page.getByRole('table', { name: '체크리스트' });
  await expect(table).toContainText('CL-0004-1');
  await expect(table.locator('.req').first()).toHaveText('필수');
  await expect(page.locator('.dt-body .banner.warn')).toContainText('필수 항목 1건이 미완료라 완료 처리할 수 없습니다.');
  await expect(page.getByRole('button', { name: '추가', exact: true })).toBeDisabled();

  // 필수 미완료 항목 완료 → 요약 체크 4/5, 필수 완료, Gate 3/5
  const pending = table.getByRole('checkbox', { name: /미완료$/ }).first();
  const label = await pending.getAttribute('aria-label');
  await pending.click();
  await expect(page.locator('.summary')).toContainText('4/5· 필수 완료');
  await expect(page.locator('.dt-body .banner.ok')).toContainText('필수 항목 모두 완료');
  await expect(page.getByRole('button', { name: /3\/5 ▾/ })).toBeVisible();
  expect(lastBody<{ done: boolean }>(api, `PATCH /api/tasks/TASK-0004/checklist/${label?.split(' ')[0] ?? ''}`)).toMatchObject({ done: true });
  // Gate는 여전히 미통과(검증 진행 중) — 필수 완료만으로 자동 완료하지 않는다
  await expect(page.locator('.summary .st')).toHaveText('QA 진행');

  // 항목 추가(선택, 검증 방법)
  await page.getByLabel('체크 내용').fill('ERD 이미지 갱신');
  await page.getByLabel('검증 방법').fill('문서 검토');
  await page.getByRole('group', { name: '필수 여부' }).getByRole('button', { name: '선택' }).click();
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await expect(table).toContainText('CL-0004-6ERD 이미지 갱신선택문서 검토');
  await expect(page.getByLabel('체크 내용')).toHaveValue('');
  await page.getByRole('tab', { name: /^이력/ }).click();
  await expect(page.getByRole('table', { name: '이력' })).toContainText('CL-0004-6 항목 추가 (선택)');
});
