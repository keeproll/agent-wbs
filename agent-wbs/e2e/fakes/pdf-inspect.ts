/**
 * PDF 검사 도우미(M6-02 시험 전용). 만든 PDF 파일을 열어 쪽 크기·글자·글꼴을 읽는다.
 *
 * - 글자: pdfjs-dist(PDF를 읽는 라이브러리)로 쪽마다 글자 조각과 위치를 꺼낸다.
 * - 글꼴: PDF 안의 글꼴 사전(/BaseFont, /FontFile2 등)을 직접 센다.
 *   Chromium이 만든 PDF는 글꼴 사전을 압축하지 않고 평문으로 적기 때문에 그대로 찾을 수 있다.
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** x·y: 글자 조각의 왼쪽 아래 위치(pt, 쪽 왼쪽 아래가 0). size: 글자 크기(pt). */
export interface PdfItem { str: string; x: number; y: number; width: number; size: number }
/** lines: 같은 높이(y)의 조각을 왼쪽부터 이은 줄(공백 제거). 글자 사이 간격(kerning) 때문에 조각이 「AT T」처럼 나뉘어도 한 줄로 본다. */
export interface PdfPage { width: number; height: number; items: PdfItem[]; text: string; lines: string[] }
export interface PdfFonts { baseFonts: string[]; embeddedFiles: number; descriptors: number; type3: number }

/** 공백·줄바꿈을 지운 글자. 한 줄이 PDF에서 여러 조각으로 나뉘어도 비교할 수 있게 한다. */
export const squash = (text: string) => text.replace(/\s+/g, '');

export async function readPdf(data: Uint8Array): Promise<{ pages: PdfPage[]; fonts: PdfFonts }> {
  const task = getDocument({ data: new Uint8Array(data), verbosity: 0 });
  const doc = await task.promise;
  const pages: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [, , width = 0, height = 0] = page.view;
    const content = await page.getTextContent();
    const items = content.items.flatMap((item) => ('str' in item && item.str.trim() ? [{ str: item.str, x: item.transform[4] as number, y: item.transform[5] as number, width: item.width, size: Math.hypot(item.transform[0] as number, item.transform[1] as number) }] : []));
    const rows = new Map<number, PdfItem[]>();
    for (const i of items) rows.set(Math.round(i.y), [...(rows.get(Math.round(i.y)) ?? []), i]);
    const lines = [...rows.values()].map((row) => squash(row.sort((a, b) => a.x - b.x).map((i) => i.str).join('')));
    pages.push({ width, height, items, text: squash(items.map((i) => i.str).join('')), lines });
  }
  await task.destroy();
  const raw = Buffer.from(data).toString('latin1');
  const all = (re: RegExp) => [...raw.matchAll(re)].map((m) => m[1] ?? '');
  return {
    pages,
    fonts: {
      baseFonts: [...new Set(all(/\/BaseFont\s*\/([^\s/>\]]+)/g))],
      embeddedFiles: all(/\/(FontFile[23]?)\s/g).length,
      descriptors: all(/\/Type\s*\/(FontDescriptor)/g).length,
      type3: all(/\/Subtype\s*\/(Type3)/g).length,
    },
  };
}

/** 쪽 번호와 위치가 붙은 글자 조각 */
export interface Placed { page: number; x: number; y: number; width: number; str: string }

/**
 * 읽는 순서로 늘어놓는다: 쪽 → 위에서 아래 줄 → 줄 안에서 왼쪽에서 오른쪽.
 * 같은 줄 = 높이 차 3pt 이내(배지처럼 글자 크기가 달라 기준선이 조금 다른 조각도 같은 줄로 본다).
 */
export function readingOrder(pages: PdfPage[]): Placed[] {
  const out: Placed[] = [];
  pages.forEach((page, n) => {
    const lines: PdfItem[][] = [];
    for (const item of [...page.items].sort((a, b) => b.y - a.y)) {
      const line = lines.find((l) => Math.abs((l[0]?.y ?? 0) - item.y) < 3);
      if (line) line.push(item); else lines.push([item]);
    }
    for (const line of lines) for (const i of line.sort((a, b) => a.x - b.x)) out.push({ page: n, x: i.x, y: i.y, width: i.width, str: i.str });
  });
  return out;
}

/** 제목 조각(start) 다음부터 끝 조각(end를 만족하는 첫 조각) 앞까지. 제목이 없으면 실패한다. */
export function between(flow: Placed[], start: string, end: (s: string) => boolean): Placed[] {
  const s = flow.findIndex((i) => squash(i.str) === squash(start));
  if (s < 0) throw new Error(`제목을 찾지 못했다: ${start}`);
  const e = flow.findIndex((i, k) => k > s && end(squash(i.str)));
  return flow.slice(s + 1, e < 0 ? flow.length : e);
}
export const text = (items: Placed[]) => squash(items.map((i) => i.str).join(''));

/**
 * 표를 칸으로 나눈다. 열 위치는 머리글 첫 줄 조각의 x다(칸 안 줄바꿈이 있어도 칸은 위쪽 정렬이라 첫 줄에 모든 열이 있다).
 * 행 = 첫 열에서 key를 만족하는 조각부터 다음 행 앞까지(칸 안에서 줄이 바뀐 조각도 같은 행이다).
 * 돌려주는 값: 머리글 칸 글자들과 행마다 칸 글자들(공백 제거).
 */
export function table(region: Placed[], headers: readonly string[], key: (s: string) => boolean): { head: string[]; rows: string[][] } {
  const first = region[0];
  if (!first) throw new Error('표가 비었다');
  // 머리글 첫 줄 조각들. 글자 간격 때문에 한 머리글이 두 조각이 되면 붙인다(간격 4pt 미만).
  const headLine = region.filter((i) => i.page === first.page && Math.abs(i.y - first.y) < 3);
  const cols: number[] = [];
  let prevEnd = -Infinity;
  for (const i of headLine) { if (i.x - prevEnd >= 4) cols.push(i.x); prevEnd = i.x + i.width; }
  const colOf = (x: number) => cols.findLastIndex((c) => x >= c - 2);
  const firstRow = region.findIndex((i) => i !== first && Math.abs(i.x - (cols[0] ?? 0)) < 3 && key(squash(i.str)) && !(i.page === first.page && Math.abs(i.y - first.y) < 3));
  const cellsOf = (items: Placed[]) => cols.map((_, j) => text(items.filter((i) => colOf(i.x) === j)));
  const head = cellsOf(region.slice(0, firstRow < 0 ? region.length : firstRow));
  const rows: string[][] = [];
  let start = firstRow;
  while (start >= 0 && start < region.length) {
    const next = region.findIndex((i, k) => k > start && Math.abs(i.x - (cols[0] ?? 0)) < 3 && key(squash(i.str)));
    rows.push(cellsOf(region.slice(start, next < 0 ? region.length : next)));
    start = next;
  }
  if (cols.length !== headers.length) throw new Error(`열 수가 다르다: ${String(cols.length)} ≠ ${String(headers.length)} (${head.join('|')})`);
  return { head, rows };
}
