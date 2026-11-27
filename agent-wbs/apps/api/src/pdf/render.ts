/**
 * HTML → A4 PDF 변환기. Playwright(브라우저를 코드로 조작하는 도구)의 Chromium을 쓴다(G L410, architecture §3.1).
 *
 * 지키는 것:
 * - 바깥 주소에 접속하지 않는다. 문서와 글꼴은 가짜 주소(`https://report.awbs.invalid`)로 요청하게 하고, 이 파일이 직접 응답한다.
 *   그 밖의 요청은 모두 끊는다. 왜: 보고서 내용이 밖으로 나가거나, 외부 파일 때문에 결과가 바뀌면 안 된다.
 * - 글꼴이 실제로 다 읽혔는지 확인한 뒤에 PDF를 만든다. 하나라도 실패하면 변환 실패로 본다.
 *   왜: 글꼴이 늦게 읽히면 다른 글꼴로 찍힌 PDF가 캐시에 남는다.
 * - 100% 배율로 찍는다. 문서는 인쇄 폭(A4 − 좌우 14mm = 182mm ≈ 688px)에 그대로 배치한다.
 *   왜: 줄여 찍으면 본문(13px = 9.75pt)이 9pt 밑으로 작아진다. 표가 인쇄 폭에 들어가게 하는 것은 PDF 전용 열 너비(html.ts PDF_COLUMNS)가 맡는다.
 * - 브라우저는 처음 쓸 때 한 번 띄워 계속 쓰고, 동시에 2개까지만 변환한다. 한 번 변환은 30초를 넘기지 않는다.
 * - 자원을 남기지 않는다(Codex 리뷰 M6-02 P1).
 *   - 변환마다 작업 공간(context, 다른 변환과 분리된 탭 묶음)을 하나 쓰고, 성공·실패·시간 초과 모든 경로에서 닫는다.
 *   - 시간 초과면 그 작업 공간을 닫아 변환을 강제로 멈춘다. 닫으면 멈춘 탭의 렌더러 프로세스도 끝난다.
 *     작업 공간이 시간 초과 뒤에 늦게 만들어져도 만들어지는 즉시 닫는다.
 *   - 동시 실행 자리는 정리가 끝난 뒤에만 다음 요청에 넘긴다. 왜: 시간 초과만 알리고 정리 전에 자리를 넘기면 「동시에 2개」가 지켜지지 않는다.
 *   - 정리가 정해진 시간(cleanupMs) 안에 끝나지 않거나 브라우저 연결이 끊기면 브라우저 프로세스를 죽이고, 다음 변환이 새로 띄운다.
 *     프로세스를 직접 죽일 수 있도록 브라우저를 서버 방식(launchServer)으로 띄우고 연결한다.
 */
import { chromium, type Browser, type BrowserContext, type BrowserServer } from 'playwright-core';
import { pdfAssets } from './assets.ts';

export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
  close(): Promise<void>;
  /** 지금 열린 브라우저 프로세스 번호와 작업 공간·탭 수(시험·점검용). 브라우저가 없으면 pid는 null. */
  inspect(): Promise<{ pid: number | null; contexts: number; pages: number }>;
}

export interface RendererOptions {
  /** 한 번 변환의 시간 제한(기본 30초) */
  timeoutMs?: number;
  /** 시간 초과 뒤 정리를 기다리는 시간(기본 5초). 넘으면 브라우저를 다시 띄운다. */
  cleanupMs?: number;
  /** 브라우저 띄우기(기본: Chromium 서버 방식). 시험이 시각을 정확히 맞추려고 바꿔 넣는다. */
  launcher?: () => Promise<Launched>;
}

/** 띄운 브라우저 하나: 연결, 프로세스 번호, 프로세스 죽이기 */
export interface Launched { browser: Browser; pid: number | null; kill(): Promise<void> }

/** 기본 브라우저 띄우기. 프로세스를 직접 죽일 수 있도록 서버 방식(launchServer)으로 띄우고 연결한다. */
async function launchChromium(): Promise<Launched> {
  const server: BrowserServer = await chromium.launchServer();
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    return { browser, pid: server.process().pid ?? null, kill: () => server.kill() };
  } catch (error) {
    await server.kill().catch(() => undefined);
    throw error;
  }
}

const ORIGIN = 'https://report.awbs.invalid';
/** A4 210mm − 좌우 여백 14mm×2 = 182mm를 화면 점(px, 1in=96px)으로 */
const PRINTABLE_PX = (182 / 25.4) * 96;
const MARGIN = '14mm';
const MAX_PARALLEL = 2;
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * 띄운 브라우저 인스턴스. gen은 띄운 순서(세대) 번호다.
 * 왜 세대를 두나: 브라우저를 다시 띄운 뒤에 옛 브라우저에서 시작한 변환의 정리가 늦게 끝나면, 그 정리가 새 브라우저를 죽이면 안 된다.
 * 정리는 자기가 쓴 인스턴스만 죽이고, 공용 `running`은 아직 그 인스턴스를 가리킬 때만 비운다.
 */
interface Instance extends Launched { gen: number }

/**
 * 한 번의 변환. 시간 초과가 나면 aborted가 켜지고, 그 뒤에 만들어지는 작업 공간은 바로 닫는다.
 * launching: 이 변환이 쓰는 브라우저(띄우는 중일 수도 있다). 정리가 이 브라우저만 다시 띄우게 한다.
 */
interface Job { context?: BrowserContext; aborted: boolean; launching?: Promise<Instance> }

class Timeout extends Error {
  constructor() { super('PDF 변환 시간 초과'); }
}

export function chromiumRenderer(options: RendererOptions = {}): PdfRenderer {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cleanupMs = options.cleanupMs ?? 5_000;
  const launcher = options.launcher ?? launchChromium;
  let running: Promise<Instance> | undefined;
  let generation = 0;
  let active = 0;
  const waiting: (() => void)[] = [];

  /** 브라우저를 띄운다(이미 있으면 그것). 연결이 끊기면 그 인스턴스를 잊고 다음 변환이 새로 띄운다. */
  const launch = (): Promise<Instance> => (running ??= (async () => {
    const instance: Instance = { ...(await launcher()), gen: ++generation };
    const mine = running;
    instance.browser.on('disconnected', () => {
      if (running === mine) running = undefined;
      void instance.kill().catch(() => undefined);
    });
    return instance;
  })().catch((error: unknown) => { running = undefined; throw error; }));

  /**
   * 한 인스턴스를 죽이고 잊는다. 공용 running은 아직 그 인스턴스일 때만 비운다(새로 띄운 브라우저는 건드리지 않는다).
   * 띄우는 중이면 다 뜬 뒤에 죽인다. 다음 변환은 새 인스턴스를 띄운다.
   */
  async function retire(target: Promise<Instance> | undefined) {
    if (!target) return;
    if (running === target) running = undefined;
    const instance = await Promise.race([target.catch(() => undefined), sleep(cleanupMs).then(() => 'pending' as const)]);
    if (instance === 'pending') { void target.then((i) => i.kill(), () => undefined); return; }
    await instance?.kill().catch(() => undefined);
  }

  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => { waiting.push(resolve); });
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  }

  async function convert(html: string, job: Job): Promise<Buffer> {
    const files = pdfAssets().fonts;
    job.launching = launch();
    const { browser } = await job.launching;
    const context = await browser.newContext({ viewport: { width: Math.floor(PRINTABLE_PX), height: 1123 } });
    job.context = context;
    try {
      // 시간 초과 뒤에 늦게 만들어진 작업 공간이면 바로 멈춘다(finally가 닫는다).
      if (job.aborted) throw new Timeout();
      // Playwright 자체 기다림 한도는 예비 장치다. 강제 중단(시간 초과 → 작업 공간 닫기)이 먼저 일하도록 정리 한도만큼 더 길게 둔다.
      context.setDefaultTimeout(timeoutMs + cleanupMs);
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
      // 배율을 주지 않는다(100%). 표가 넘치면 Chromium이 줄여 찍으므로, 넘치지 않는지는 시나리오 시험이 확인한다.
      return await page.pdf({ format: 'A4', margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }, printBackground: true });
    } finally {
      // 성공·실패·시간 초과 모두 작업 공간을 닫는다. 작업 공간을 닫으면 그 안의 탭도 닫힌다.
      await context.close().catch(() => undefined);
    }
  }

  return {
    render: (html) => slot(async () => {
      const job: Job = { aborted: false };
      const work = convert(html, job);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { job.aborted = true; reject(new Timeout()); }, timeoutMs);
      });
      try {
        return await Promise.race([work, timeout]);
      } catch (error) {
        if (job.aborted) {
          // 강제 중단: 작업 공간을 닫으면 멈춘 탭과 그 렌더러 프로세스가 끝나고, 진행 중이던 변환 호출이 실패로 돌아온다.
          void job.context?.close().catch(() => undefined);
          // 변환이 정리까지 끝나기를 기다린다. 정해진 시간 안에 끝나지 않으면 브라우저가 비정상이므로 다시 띄운다.
          const settled = await Promise.race([work.then(() => true, () => true), sleep(cleanupMs).then(() => false)]);
          if (!settled) await retire(job.launching);
          throw new Timeout();
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }),
    async close() {
      await retire(running);
    },
    async inspect() {
      const started = await running?.catch(() => undefined);
      if (!started) return { pid: null, contexts: 0, pages: 0 };
      const contexts = started.browser.contexts();
      return { pid: started.pid, contexts: contexts.length, pages: contexts.reduce((n, c) => n + c.pages().length, 0) };
    },
  };
}
