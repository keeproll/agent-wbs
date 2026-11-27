/**
 * 보고서 화면 「메일로 보내기」의 다시 시도(M6 통합 Codex 리뷰 P2-1 재현).
 * 응답을 잃은 뒤 받는 사람·보기를 바꾸고 오류 막대의 「다시 시도」를 눌러도, 같은 멱등 키로 **처음 보낸 본문**을 그대로 보내야 한다.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { errorBody, fakeApi, hold, json } from './support/fake-api.ts';

const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/lead.json', import.meta.url), 'utf8')) as { id: string; response: Record<string, unknown> }[];
const report = fixtures.find((x) => x.id === 'getReport')?.response ?? {};
const row = Object.fromEntries(Object.entries(report).filter(([k]) => k !== 'snapshot' && k !== 'changesSince'));
const recipient = (id: string) => ({ id, email: `${id}@example.com`, name: id, active: true, daily: true, weekly: true, view: 'ext', pdf: false, updatedAt: '2026-11-27T00:00:00.000000Z' });

test('메일 다시 시도는 처음 보낸 받는 사람·보기를 같은 멱등 키로 보낸다', async ({ page }) => {
  const api = await fakeApi(page);
  api.on('GET /api/projects/p1/reports', (r) => json(r, 200, { items: [row], nextCursor: null }));
  api.on(`GET /api/reports/${String(row.id)}`, (r) => json(r, 200, report));
  api.on('GET /api/mail/log', (r) => json(r, 200, { items: [], nextCursor: null }));
  api.on('GET /api/settings/mail/recipients', (r) => json(r, 200, { items: [recipient('alice'), recipient('bob')] }));
  api.on('GET /api/settings/mail/smtp', (r) => json(r, 200, { host: 'smtp.test', port: 587, sec: 'starttls', from: 'wbs@example.com', user: '', pwSet: false, updatedAt: null, check: { ok: true, checkedAt: '2026-11-27T00:00:00.000000Z', error: null } }));
  const fail = hold((r) => json(r, 500, errorBody('INTERNAL')));
  api.on(`POST /api/reports/${String(row.id)}/mail`, fail.handler);
  await page.goto('/report');
  await page.getByRole('button', { name: '메일로 보내기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '메일로 보내기' });
  const bob = dialog.getByRole('checkbox', { name: /bob@example.com/ });
  if (await bob.isChecked()) await bob.uncheck();
  const alice = dialog.getByRole('checkbox', { name: /alice@example.com/ });
  if (!(await alice.isChecked())) await alice.check();
  if (await dialog.getByRole('button', { name: '모두 보고용' }).count()) await dialog.getByRole('button', { name: '모두 보고용' }).click();
  await dialog.getByRole('button', { name: '보내기', exact: true }).click();
  const first = await fail.started;
  fail.release();
  await expect(page.locator('.errbar')).toBeVisible();
  // 실패 뒤 선택을 바꾼다
  await bob.check();
  if (await dialog.getByRole('button', { name: '모두 팀장용' }).count()) await dialog.getByRole('button', { name: '모두 팀장용' }).click();
  api.on(`POST /api/reports/${String(row.id)}/mail`, (r) => json(r, 202, { ids: ['queued-1'] }));
  await page.locator('.errbar').getByRole('button', { name: '다시 시도' }).click();
  await expect.poll(() => api.requests(`POST /api/reports/${String(row.id)}/mail`).length).toBe(2);
  const second = api.requests(`POST /api/reports/${String(row.id)}/mail`)[1];
  expect(second?.headers()['idempotency-key']).toBe(first.headers()['idempotency-key']);
  expect(second?.postDataJSON()).toEqual(first.postDataJSON());
  // 건수는 서버 응답(큐에 넣은 1건) 기준
  await expect(page.getByText('메일 1건을 발송 대기열에 넣었습니다.')).toBeVisible();
});
