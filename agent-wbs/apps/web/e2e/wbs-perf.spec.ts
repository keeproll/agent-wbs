/**
 * UAT-WBS-05 대량 목록 — 200행·1,000행 측정 기록(가상 스크롤).
 * 측정: 첫 행이 보일 때까지(목록 응답 포함), 그려진 DOM 행 수, 맨 아래까지 스크롤해 마지막 Task 도달, 필터 적용 뒤 결과 표시까지.
 * 응답은 가짜 API(브라우저 안에서 즉시 응답)라 화면 그리기 시간을 잰다. 결과: 기본은 실행마다 새 임시 폴더(support/visual.ts visualOut), 보관하려면 AWBS_PERF_OUT=~/.orca/bots/agentwbs/archive/2026-11-26/M3-02/perf/ 로 명시
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { visualOut } from './support/visual.ts';
import { wbsApi } from './support/wbs-api.ts';
import { bulkList } from './support/wbs-fixture.ts';

const OUT = visualOut('AWBS_PERF_OUT', 'M3-02-perf');
const results: Record<string, unknown>[] = [];
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 } });

for (const count of [200, 1000]) {
  test(`${String(count)}행: 가상 스크롤로 모든 행에 접근하고 측정값을 남긴다`, async ({ page }) => {
    const list = bulkList(count);
    const api = await wbsApi(page, { list });
    const bytes = JSON.stringify(list).length;
    await page.goto('/wbs');
    const box = page.getByRole('table', { name: 'WBS Task 목록' });
    await expect(box.locator('.trow.task').first()).toBeVisible();
    const firstRowMs = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const list = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).find((r) => r.name.includes('/tasks'));
      return { sinceNavigation: Math.round(performance.now() - (nav?.startTime ?? 0)), listResponseMs: list ? Math.round(list.responseEnd - list.startTime) : null };
    });
    await expect(page.locator('.resbar')).toHaveText(`전체 ${String(count)}건`);
    expect(await box.getAttribute('aria-rowcount')).toBe(String(count + 25 + 1));
    const domRows = await box.locator('.trow:not(.thead)').count();
    expect(domRows).toBeLessThan(60);

    // 맨 아래까지 스크롤 → 마지막 Task 도달
    const scrollMs = await page.evaluate(async () => {
      const el = document.querySelector<HTMLElement>('.wbs .tbl');
      if (!el) return -1;
      const t0 = performance.now();
      el.scrollTop = el.scrollHeight;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      el.scrollTop = el.scrollHeight;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return Math.round(performance.now() - t0);
    });
    const last = `TASK-${String(count).padStart(4, '0')}`;
    await expect(box.locator('.td.tcell > .tid', { hasText: last })).toBeInViewport();
    const domRowsBottom = await box.locator('.trow:not(.thead)').count();

    // 필터 적용(화면에서 거름) → 결과 표시
    const filterMs = await page.evaluate(async () => {
      const select = [...document.querySelectorAll<HTMLSelectElement>('.toolbar label.fsel select')].find((s) => s.closest('label')?.textContent?.startsWith('담당 Agent'));
      if (!select) return -1;
      const t0 = performance.now();
      select.value = 'Codex';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (document.querySelector('.resbar')?.textContent?.startsWith('필터 결과')) break;
      }
      return Math.round(performance.now() - t0);
    });
    await expect(page.locator('.resbar')).toContainText('필터 결과');

    // 상세를 열고 레일에서 다음 Task로
    await box.locator('.trow.task').first().click();
    await expect(page.getByRole('complementary', { name: 'Task 목록' })).toBeVisible();
    const railItems = await page.getByRole('complementary', { name: 'Task 목록' }).locator('.side-i').count();

    results.push({
      rows: count, listBytes: bytes, listResponseMs: firstRowMs.listResponseMs, firstRowSinceNavigationMs: firstRowMs.sinceNavigation,
      domRowsTop: domRows, domRowsBottom, scrollToBottomMs: scrollMs, filterApplyMs: filterMs, railItemsAfterFilter: railItems,
      listCalls: api.calls().filter((c) => c.includes('/tasks')).length,
    });
  });
}

test.afterAll(() => {
  if (!results.length) return;
  mkdirSync(OUT, { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(join(OUT, 'wbs-perf.json'), `${JSON.stringify({ at, env: 'Playwright Chromium headless, 1920×1080, 가짜 API(즉시 응답), vite preview(e2e 빌드)', results }, null, 2)}\n`);
  const lines = [
    `# WBS 대량 목록 측정 (${at})`, '',
    '- 환경: Playwright Chromium headless, 1920×1080, 가짜 API(브라우저 안 즉시 응답), vite preview(e2e 모드 빌드).',
    '- 무엇을 쟀나: 첫 행 표시(페이지 이동부터), 그려진 DOM 행 수(가상 스크롤), 맨 아래 스크롤, 필터 적용, 레일 항목 수.', '',
    '| 행 수 | 목록 응답 크기(byte) | 목록 응답(ms) | 첫 행 표시(ms) | DOM 행(위) | DOM 행(아래) | 맨 아래 스크롤(ms) | 필터 적용(ms) | 레일 항목 |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map((r) => `| ${String(r.rows)} | ${String(r.listBytes)} | ${String(r.listResponseMs)} | ${String(r.firstRowSinceNavigationMs)} | ${String(r.domRowsTop)} | ${String(r.domRowsBottom)} | ${String(r.scrollToBottomMs)} | ${String(r.filterApplyMs)} | ${String(r.railItemsAfterFilter)} |`),
  ];
  writeFileSync(join(OUT, 'wbs-perf.md'), `${lines.join('\n')}\n`);
});
