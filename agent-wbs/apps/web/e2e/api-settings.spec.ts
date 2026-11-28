/**
 * M3-08 설정 화면 — 실제 API(LAN 모드)·전용 DB로 핵심 흐름을 확인한다. `pnpm --filter @awbs/web e2e:api-settings`가 환경을 만든다.
 * 환경 변수가 없으면(일반 `W e2e`) 건너뛴다.
 *
 * 확인하는 것:
 * - system seed 기본값이 화면에 그대로 보인다(낮춤 기준 20%·재작업 「한 단계 상향」 등, 모델 순서).
 * - 실행 정책을 바꿔 저장하면 서버에 남고, 새로고침해도 같은 값이다(useSave + updatedAt).
 * - 같은 버전으로 다시 저장하면 서버가 409 VERSION_CONFLICT를 주고 충돌 창이 뜬다.
 * - 정합성 점검이 서버 결과를 보인다.
 * - 설정 조회 API가 모두 응답하는지 기록한다(구현되지 않은 API는 결함 보고용으로 남긴다).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fillPin, todayPin } from './support/pin.ts';
import { visualOut } from './support/visual.ts';

const apiAvailable = !!process.env.AWBS_E2E_API;
test.skip(!apiAvailable, '실제 API 환경이 없다. pnpm --filter @awbs/web e2e:api-settings로 실행한다.');
test.describe.configure({ mode: 'serial' });

const OUT = visualOut('AWBS_REPORT_DIR', 'M3-08');
const serverErrors: string[] = [];
test.beforeEach(({ page }) => {
  page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.request().method()} ${new URL(r.url()).pathname} ${String(r.status())}`); });
});
test.afterAll(() => { if (serverErrors.length) console.log(`[실제 API 5xx] ${serverErrors.join(' | ')}`); });

async function login(page: Page, path: string) {
  await page.goto(path);
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(path)}`);
  await fillPin(page, todayPin());
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(path);
}

test('설정 조회 API 응답 기록(구현 여부)', async ({ page }) => {
  await login(page, '/settings/system');
  const paths = [
    '/api/settings/workflow', '/api/settings/exec-policy', '/api/settings/models', '/api/settings/subagents',
    '/api/settings/split', '/api/settings/schedule', '/api/settings/blackouts', '/api/settings/concurrency',
    '/api/settings/obs-budget', '/api/settings/github', '/api/runner-state', '/api/schedule', '/api/alerts', '/api/system/integrity',
  ];
  const result = await page.evaluate(async (list) => Promise.all(list.map(async (p) => {
    const r = await fetch(p);
    const text = await r.text();
    return { path: p, status: r.status, body: text.slice(0, 300) };
  })), paths);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'api-settings-probe.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(result.map((r) => `${r.path} ${String(r.status)}`).join('\n'));
  // 화면 핵심 흐름이 쓰는 API는 반드시 응답해야 한다.
  for (const p of ['/api/settings/workflow', '/api/settings/exec-policy', '/api/settings/models', '/api/settings/subagents', '/api/runner-state', '/api/system/integrity']) {
    expect(result.find((r) => r.path === p)?.status, p).toBe(200);
  }
});

test('Q-07: 실제 API도 실행 중 전달 켜기를 거부하고 화면은 준비 중이다', async ({ page }) => {
  await login(page, '/settings/runner');
  const card = page.getByRole('region', { name: 'Runner 연결' });
  await expect(card.getByRole('button', { name: /준비 중/ })).toBeDisabled();
  const result = await page.evaluate(async () => {
    const session = await fetch('/api/session').then((r) => r.json() as Promise<{ csrfToken: string }>);
    const current = await fetch('/api/settings/workflow').then((r) => r.json() as Promise<Record<string, unknown>>);
    const res = await fetch('/api/settings/workflow', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ ...current, liveInject: true }),
    });
    return { status: res.status, body: await res.json() as { error: { code: string } }, current };
  });
  expect(result.current.liveInject).toBe(false);
  expect(result.status).toBe(400);
  expect(result.body.error.code).toBe('VALIDATION_FAILED');
});

test('실행 정책: seed 기본값 표시 → 변경 저장 → 새로고침해도 유지, 낡은 버전 저장은 충돌 창', async ({ page }) => {
  await login(page, '/settings/agent');
  const card = page.getByRole('region', { name: 'Agent 실행 정책 — 모델 · Effort' });
  const usage = card.getByRole('group', { name: '사용량 부족 시' });
  await expect(usage).toBeVisible();
  const before = await page.evaluate(() => fetch('/api/settings/exec-policy').then((r) => r.json() as Promise<{ lowPct: number; onRework: string; onUsage: string; updatedAt: string | null }>));
  expect(before.lowPct).toBe(20); // owner 2026-11-26 기본값
  if (before.onUsage !== 'down') await usage.getByRole('button', { name: '낮춰서 진행' }).click();
  await expect(card.getByRole('group', { name: '낮춤 기준' }).getByRole('button', { name: '20%' })).toHaveAttribute('aria-pressed', 'true');
  await card.getByRole('group', { name: '낮춤 기준' }).getByRole('button', { name: '30%' }).click();
  await card.getByRole('group', { name: '재작업 시' }).getByRole('button', { name: '최상위로 상향' }).click();
  await card.getByRole('button', { name: '저장', exact: true }).last().click();
  await expect(page.getByText('설정을 저장했습니다.')).toBeVisible();
  const after = await page.evaluate(() => fetch('/api/settings/exec-policy').then((r) => r.json() as Promise<{ lowPct: number; onRework: string; onUsage: string; updatedAt: string | null }>));
  expect(after).toMatchObject({ lowPct: 30, onRework: 'top', onUsage: 'down' });
  expect(after.updatedAt).not.toBe(before.updatedAt);
  await page.reload();
  await expect(card.getByRole('group', { name: '낮춤 기준' }).getByRole('button', { name: '30%' })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByRole('group', { name: '재작업 시' }).getByRole('button', { name: '최상위로 상향' })).toHaveAttribute('aria-pressed', 'true');

  // 다른 탭(같은 세션)이 먼저 저장한 것처럼 서버 값을 바꾼 뒤, 화면이 가진 옛 버전으로 저장하면 충돌 창이 뜬다.
  await card.getByRole('group', { name: '재작업 시' }).getByRole('button', { name: '같은 등급 유지' }).click();
  const status = await page.evaluate(async () => {
    const session = await fetch('/api/session').then((r) => r.json() as Promise<{ csrfToken: string }>);
    const current = await fetch('/api/settings/exec-policy').then((r) => r.json() as Promise<Record<string, unknown>>);
    const { updatedAt, ...rest } = current;
    const r = await fetch('/api/settings/exec-policy', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ ...rest, updatedAt, notifyAt: 3 }),
    });
    return r.status;
  });
  expect(status).toBe(200);
  await card.getByRole('button', { name: '저장', exact: true }).last().click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('VERSION_CONFLICT');
  await dialog.getByRole('button', { name: /최신 내용 불러오기/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole('group', { name: '최상위 등급 재작업 알림' }).getByRole('button', { name: '3회째' })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByRole('group', { name: '재작업 시' }).getByRole('button', { name: '최상위로 상향' })).toHaveAttribute('aria-pressed', 'true');
});

test('모델 순서·하위 Agent: seed 값이 보이고 하위 Agent 전체 끄기를 저장한다', async ({ page }) => {
  await login(page, '/settings/agent');
  const models = await page.evaluate(() => fetch('/api/settings/models').then((r) => r.json() as Promise<{ rankOrder: { Claude: string[]; Codex: string[] } }>));
  console.log(`[seed 모델 순서] ${JSON.stringify(models.rankOrder)}`);
  const sa = page.getByRole('region', { name: '하위 Agent', exact: true });
  const group = sa.getByRole('group', { name: '하위 Agent 사용' });
  await expect(group).toBeVisible();
  await group.getByRole('button', { name: '사용 안 함 (기본 Agent로 실행)' }).click();
  await sa.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText(/하위 Agent 설정을 저장했습니다/)).toBeVisible();
  const saved = await page.evaluate(() => fetch('/api/settings/subagents').then((r) => r.json() as Promise<{ enabled: boolean }>));
  expect(saved.enabled).toBe(false);
});

test('Runner 탭은 실제 Runner 상태(연결 없음)를 보이고, 점검 탭은 서버 정합성 결과를 보인다', async ({ page }) => {
  await login(page, '/settings/runner');
  await expect(page.getByRole('region', { name: 'Runner 연결' }).getByText('연결 끊김')).toBeVisible();
  await expect(page.getByText('아직 준비 상태 보고가 없습니다. Runner가 시작하면 스스로 점검해 여기에 보고합니다.')).toBeVisible();
  await page.getByRole('navigation', { name: '설정 영역' }).getByRole('link', { name: '점검' }).click();
  await page.getByRole('button', { name: '점검 실행' }).click();
  await expect(page.getByText(/\d+ \/ \d+ 통과/)).toBeVisible();
  await expect(page.locator('.gtr:not(.h)').filter({ has: page.locator('.vf') }).first()).toBeVisible();
});
