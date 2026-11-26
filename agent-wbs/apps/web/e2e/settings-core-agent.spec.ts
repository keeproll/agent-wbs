/**
 * M3-08 설정 → Agent 탭: UAT-POLICY-01, UAT-POLICY-UI, 기본값 표시(낮춤 기준 20%).
 */
import { expect, test } from '@playwright/test';
import { fakeApi, json } from './support/fake-api.ts';
import { settingsApi } from './support/settings-fixtures.ts';

test('UAT-POLICY-01 b: 기본 담당=검증 Agent 경고, 새 Task에만 적용 안내, Workflow 단계', async ({ page }) => {
  const s = settingsApi(await fakeApi(page));
  await page.goto('/settings/agent');
  const card = page.getByRole('region', { name: 'Agent 역할 · 기본 Workflow' });
  await expect(card.getByText('새 Task 생성 Wizard의 기본값입니다. 기존 Task는 각 Task 개요에서 바꿉니다.')).toBeVisible();
  await expect(card.locator('.flow li')).toHaveText(['1Claude 개발', '2Codex QA', '3Claude 재작업', '4Codex 재검증', '5Completion Gate', '6Task 완료']);
  await card.getByRole('group', { name: '기본 검증 Agent' }).getByRole('button', { name: 'Claude' }).click();
  await expect(card.getByText('개발 Agent와 검증 Agent가 같습니다 — 교차 검증 원칙에 맞지 않습니다.')).toBeVisible();
  await card.getByRole('group', { name: '기본 개발 Agent' }).getByRole('button', { name: 'Codex' }).click();
  await expect(card.getByText(/교차 검증 원칙/)).toHaveCount(0);
  await card.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('기본 Agent를 저장했습니다 — 새 Task부터 적용됩니다.')).toBeVisible();
  // 다른 Workflow 값(실행 중 전달·heartbeat)은 서버 값 그대로 보낸다.
  expect(s.workflow.bodies[0]).toEqual({ updatedAt: '2026-11-05T01:00:00.000Z', devAgent: 'Codex', qaAgent: 'Claude', liveInject: false, heartbeatSeconds: 60, missedHeartbeats: 3 });
  await expect(card.locator('.flow li').first()).toHaveText('1Codex 개발');
});

test('UAT-POLICY-01 a: 마지막 허용 모델 해제는 거부하고, 허용 변경·모델 순서를 저장한다', async ({ page }) => {
  const s = settingsApi(await fakeApi(page));
  await page.goto('/settings/agent');
  const card = page.getByRole('region', { name: 'Agent 실행 정책 — 모델 · Effort' });
  const claude = card.getByRole('region', { name: 'Claude 모델 표' });
  // 위 등급부터: Opus(순위 2) → Sonnet(순위 1)
  await expect(claude.locator('.gtr:not(.h) b')).toHaveText(['Opus 4.7', 'Sonnet 4.6']);
  await expect(claude.getByText('신규 보고 — 미허용')).toBeVisible();
  await expect(card.getByText('Effort 낮음 (low) · 보통 (medium) · 높음 (high) · 매우 높음 (xhigh) · 최대 (max)')).toBeVisible();

  // Claude의 유일한 허용 모델(Opus)을 해제하면 저장하지 않는다.
  await claude.locator('.gtr').filter({ hasText: 'Opus 4.7' }).getByRole('button', { name: '허용 해제' }).click();
  await card.getByRole('button', { name: '저장', exact: true }).first().click();
  await expect(card.getByText('Claude의 마지막 허용 모델은 해제할 수 없습니다 — 최소 1개는 허용해야 합니다.')).toBeVisible();
  expect(s.models.bodies).toHaveLength(0);
  await card.getByRole('button', { name: '변경 취소' }).first().click();

  // 신규 모델 허용 + 순서 바꾸기(Sonnet을 위로)
  await claude.locator('.gtr').filter({ hasText: 'Sonnet 4.6' }).getByRole('button', { name: '허용', exact: true }).click();
  await claude.getByRole('button', { name: 'claude-sonnet-4-6 순위 올리기' }).click();
  await expect(claude.locator('.gtr:not(.h) b')).toHaveText(['Sonnet 4.6', 'Opus 4.7']);
  await card.getByRole('button', { name: '저장', exact: true }).first().click();
  await expect(page.getByText('허용 모델을 저장했습니다 — Planning Agent가 아직 시작하지 않은 Task의 등급을 다시 판단합니다.')).toBeVisible();
  expect(s.models.bodies[0]).toMatchObject({
    rankOrder: { Claude: ['claude-opus-4-7', 'claude-sonnet-4-6'], Codex: ['gpt-5.4-mini', 'gpt-5.5'] },
    models: expect.arrayContaining([{ agent: 'Claude', id: 'claude-sonnet-4-6', allowed: true }]) as unknown,
  });
});

test('UAT-POLICY-01: 실행 정책 기본값(낮춤 기준 20%)과 변경 저장, 반복 재작업 알림의 Task 링크', async ({ page }) => {
  const api = await fakeApi(page);
  const s = settingsApi(api);
  api.on('GET /api/alerts', (route) => json(route, 200, { items: [
    { id: 'al1', key: 'rework-limit:t7', severity: 'warn', taskKey: 'TASK-0007', target: 'TASK-0007', text: '자동 재작업 한도를 넘었습니다.', at: '2026-11-05T10:00:00.000Z' },
    { id: 'al2', key: 'external-write-blocked', severity: 'warn', taskKey: null, target: null, text: '다른 알림', at: '2026-11-05T10:00:00.000Z' },
  ] }));
  await page.goto('/settings/agent');
  const card = page.getByRole('region', { name: 'Agent 실행 정책 — 모델 · Effort' });
  await expect(card.getByRole('group', { name: '낮춤 기준' }).getByRole('button', { name: '20%' })).toHaveAttribute('aria-pressed', 'true');
  const alert = card.getByRole('note').filter({ hasText: '팀장 확인 필요' });
  await expect(alert.getByText('TASK-0007 — 자동 재작업 한도를 넘었습니다.')).toBeVisible();
  await expect(alert.getByText('다른 알림')).toHaveCount(0);
  // 원본 al.open = goExec(작업 실행). M3 통합에서 WBS 상세 대신 작업 실행 주소로 바로잡았다(공통 LINK.exec).
  await expect(alert.getByRole('link', { name: '실행 보기' })).toHaveAttribute('href', '/exec/TASK-0007');
  await card.getByRole('group', { name: '재작업 시' }).getByRole('button', { name: '같은 등급 유지' }).click();
  await expect(card.getByText(/같은 등급 유지 — 재작업이 반복되어도 등급이 오르지 않습니다/)).toBeVisible();
  await card.getByRole('group', { name: '사용량 부족 시' }).getByRole('button', { name: '리셋까지 대기' }).click();
  await expect(card.getByRole('group', { name: '낮춤 기준' })).toHaveCount(0);
  await card.getByRole('group', { name: '최저선: DB · Migration 작업 Effort 높음 이상' }).getByRole('button', { name: '해제' }).click();
  await card.getByRole('button', { name: '저장', exact: true }).last().click();
  await expect(page.getByText('설정을 저장했습니다.')).toBeVisible();
  expect(s.exec.bodies[0]).toEqual({
    updatedAt: '2026-11-05T01:00:00.000Z', onUsage: 'wait', lowPct: 20, onRework: 'same', notifyAt: 2,
    floors: { verifyGeDev: true, dbHigh: false }, autoRetryLimit: 2, autoReworkLimit: 3,
  });
});

test('UAT-POLICY-UI a·b: 정의·지시문·버전/hash, 전체 끄기 주의, 개별 허용 해제 저장', async ({ page }) => {
  const s = settingsApi(await fakeApi(page));
  await page.goto('/settings/agent');
  const card = page.getByRole('region', { name: '하위 Agent', exact: true });
  await expect(card.getByText('2개 정의 · 허용 1 · Claude 1 · Codex 1')).toBeVisible();
  const row = card.locator('.gtr').filter({ hasText: 'db-migration-reviewer' });
  await expect(row).toContainText('v1a1b2c3d4e5f6');
  await expect(row).toContainText('Read · Grep읽기 전용');
  await card.getByRole('button', { name: '지시문 보기' }).first().click();
  await expect(card.getByText('DB migration의 되돌리기 가능성을 검토한다.')).toBeVisible();
  await expect(card.getByText('참고: wshobson/agents')).toBeVisible();
  await card.getByRole('button', { name: '지시문 닫기' }).click();
  await expect(card.getByText('DB migration의 되돌리기 가능성을 검토한다.')).toHaveCount(0);

  await card.getByRole('group', { name: '하위 Agent 사용' }).getByRole('button', { name: '사용 안 함 (기본 Agent로 실행)' }).click();
  await expect(card.getByText(/Task에 지정된 하위 Agent 기록은 그대로 두고, 새 실행은 기본 Agent만으로 합니다/)).toBeVisible();
  await card.locator('.gtr').filter({ hasText: 'db-migration-reviewer' }).getByRole('button', { name: '허용 해제' }).click();
  await card.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText(/하위 Agent 설정을 저장했습니다 — 허용을 바꾼 정의가 지정된 Task는 Planning Agent가 다시 판단합니다/)).toBeVisible();
  expect(s.subagents.bodies[0]).toEqual({
    updatedAt: '2026-11-05T01:00:00.000Z', enabled: false,
    allowed: [{ id: 'db-migration-reviewer', allowed: false }, { id: 'test-writer', allowed: false }],
  });
  await expect(card.getByText('2개 정의 · 허용 0 · Claude 1 · Codex 1')).toBeVisible();
});
