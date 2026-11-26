/**
 * PDF 검사 도우미(M6-02 시험 전용). 만든 PDF 파일을 열어 쪽 크기·글자·글꼴을 읽는다.
 *
 * - 글자: pdfjs-dist(PDF를 읽는 라이브러리)로 쪽마다 글자 조각과 위치를 꺼낸다.
 * - 글꼴: PDF 안의 글꼴 사전(/BaseFont, /FontFile2 등)을 직접 센다.
 *   Chromium이 만든 PDF는 글꼴 사전을 압축하지 않고 평문으로 적기 때문에 그대로 찾을 수 있다.
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** x·y: 글자 조각의 왼쪽 아래 위치(pt, 쪽 왼쪽 아래가 0). */
export interface PdfItem { str: string; x: number; y: number; width: number }
export interface PdfPage { width: number; height: number; items: PdfItem[]; text: string }
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
    const items = content.items.flatMap((item) => ('str' in item && item.str.trim() ? [{ str: item.str, x: item.transform[4] as number, y: item.transform[5] as number, width: item.width }] : []));
    pages.push({ width, height, items, text: squash(items.map((i) => i.str).join('')) });
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
