import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { readPdf } from '../../../e2e/fakes/pdf-inspect.ts';
import { fakeApi, json } from './support/fake-api.ts';

const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/lead.json', import.meta.url), 'utf8')) as { id: string; response: Record<string, unknown> }[];
const report = fixtures.find(f => f.id === 'getReport')?.response ?? {};
const row = Object.fromEntries(Object.entries(report).filter(([key]) => !['snapshot', 'changesSince'].includes(key)));

test('UAT-REPORT-06 · 브라우저 인쇄도 메뉴180px·헤더64px 여백 없이 본문·전체 열·부록을 출력한다', async ({ page }, info) => {
  const api = await fakeApi(page);
  api.on('GET /api/projects/p1/reports', route => json(route, 200, { items: [row], nextCursor: null }));
  api.on(`GET /api/reports/${String(row.id)}`, route => json(route, 200, report));
  api.on('GET /api/mail/log', route => json(route, 200, { items: [], nextCursor: null }));
  await page.goto('/report');
  const doc = page.getByRole('article');
  await expect(doc).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: 'print' });
  const box = await doc.boundingBox();
  expect(box?.x, '인쇄 원점 x').toBe(0);
  expect(box?.y, '인쇄 원점 y').toBe(0);
  const pdf = await page.pdf({ format: 'A4', margin: { top: '14mm', right: '14mm', bottom: '14mm', left: '14mm' }, printBackground: true, preferCSSPageSize: true });
  await info.attach('browser-print.pdf', { body: pdf, contentType: 'application/pdf' });
  const parsed = await readPdf(pdf);
  expect(parsed.pages.length).toBeGreaterThan(1);
  expect(parsed.pages.map(p => p.text).join('')).toContain('부록.전체Task현황');
  const appendix = parsed.pages.find(p => p.text.includes('부록.전체Task현황'));
  for (const header of ['WBS', 'Task', '제목', '상태', '개발/검증', '진행률', '체크리스트', '검증', '완료예상', '기준대비']) {
    expect(appendix?.text, `부록의 ${header} 열`).toContain(header);
  }
  for (const p of parsed.pages) {
    expect(p.width).toBeCloseTo(595, 0);
    for (const item of p.items) {
      expect(item.x, item.str).toBeGreaterThanOrEqual(39);
      expect(item.x + item.width, item.str).toBeLessThanOrEqual(p.width - 38);
    }
  }
});
