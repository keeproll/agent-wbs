/**
 * HTML → A4 PDF 변환기. Playwright(브라우저를 코드로 조작하는 도구)의 Chromium을 쓴다(G L410, architecture §3.1).
 *
 * 지키는 것:
 * - 바깥 주소에 접속하지 않는다. 문서와 글꼴은 가짜 주소(`https://report.awbs.invalid`)로 요청하게 하고, 이 파일이 직접 응답한다.
 *   그 밖의 요청은 모두 끊는다. 왜: 보고서 내용이 밖으로 나가거나, 외부 파일 때문에 결과가 바뀌면 안 된다.
 * - 글꼴이 실제로 다 읽혔는지 확인한 뒤에 PDF를 만든다. 하나라도 실패하면 변환 실패로 본다.
 *   왜: 글꼴이 늦게 읽히면 다른 글꼴로 찍힌 PDF가 캐시에 남는다.
 * - 열이 잘리거나 글자 단위로 쪼개지지 않아야 한다(UAT-REPORT-04·05). 문서를 화면 폭(900px)으로 배치하고 PDF에서 줄인다(LAYOUT_PX).
 * - 브라우저는 처음 쓸 때 한 번 띄워 계속 쓰고, 동시에 2개까지만 변환한다. 한 번 변환은 30초를 넘기지 않는다.
 */
import { chromium, type Browser } from 'playwright-core';
import { pdfAssets } from './assets.ts';

export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
  close(): Promise<void>;
}

const ORIGIN = 'https://report.awbs.invalid';
/** A4 210mm − 좌우 여백 14mm×2 = 182mm를 화면 점(px, 1in=96px)으로 */
const PRINTABLE_PX = (182 / 25.4) * 96;
/**
 * 문서를 배치할 폭(px). 화면에서 보고서 문서가 차지하는 폭과 비슷하게 잡고, PDF에는 인쇄 폭에 맞게 줄여(약 0.76배) 넣는다.
 * 왜: 표의 고정 열 너비 합(부록 약 770px)이 인쇄 폭(약 688px)보다 넓다. 인쇄 폭에 그대로 배치하면 남는 폭으로 늘어나는
 * 제목·요약 열이 몇 px로 줄어 한두 글자씩 줄바꿈된다. 잘리지는 않아도 읽을 수 없다(UAT-REPORT-04 「모든 열을 판단」).
 */
const LAYOUT_PX = 900;
const MARGIN = '14mm';
const TIMEOUT_MS = 30_000;
const MAX_PARALLEL = 2;

export function chromiumRenderer(): PdfRenderer {
  let browser: Promise<Browser> | undefined;
  let active = 0;
  const waiting: (() => void)[] = [];

  const launch = () => (browser ??= chromium.launch().then((b) => {
    // 브라우저가 죽으면 다음 변환이 새로 띄운다.
    b.on('disconnected', () => { browser = undefined; });
    return b;
  }, (error: unknown) => { browser = undefined; throw error; }));

  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => { waiting.push(resolve); });
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  }

  async function convert(html: string): Promise<Buffer> {
    const files = pdfAssets().fonts;
    const context = await (await launch()).newContext({ viewport: { width: LAYOUT_PX, height: 1123 } });
    try {
      context.setDefaultTimeout(TIMEOUT_MS);
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin === ORIGIN && url.pathname === '/report') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        const font = url.origin === ORIGIN ? files.get(url.pathname) : undefined;
        if (font) return route.fulfill({ contentType: 'font/woff2', body: font });
        return route.abort();
      });
      const page = await context.newPage();
      await page.emulateMedia({ media: 'print' });
      await page.goto(`${ORIGIN}/report`, { waitUntil: 'load' });
      // 선언한 글꼴을 모두 읽게 하고, 하나라도 실패하면 변환을 멈춘다.
      // api는 브라우저 타입(DOM)을 쓰지 않으므로 브라우저 안에서 실행할 코드를 글자로 넘긴다.
      const loaded = await page.evaluate(`(async () => {
        const faces = [...document.fonts];
        await Promise.allSettled(faces.map((f) => f.load()));
        await document.fonts.ready;
        return faces.length > 0 && faces.every((f) => f.status === 'loaded');
      })()`) as boolean;
      if (!loaded) throw new Error('보고서 글꼴을 읽지 못했습니다.');
      // scale로 배치 폭을 LAYOUT_PX로 정한다(인쇄 배치 폭 = 인쇄 폭 ÷ scale).
      // 잘림·열 쪼개짐이 없는지는 시나리오 시험이 PDF 글자 위치와 조각으로 확인한다(pdf.scenario 「잘림 없음」·「좁은 열」).
      return await page.pdf({ format: 'A4', margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }, printBackground: true, scale: PRINTABLE_PX / LAYOUT_PX });
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  return {
    render: (html) => slot(async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('PDF 변환 시간 초과')); }, TIMEOUT_MS); });
      try { return await Promise.race([convert(html), timeout]); } finally { clearTimeout(timer); }
    }),
    async close() {
      const current = browser;
      browser = undefined;
      if (current) await (await current.catch(() => undefined))?.close();
    },
  };
}
