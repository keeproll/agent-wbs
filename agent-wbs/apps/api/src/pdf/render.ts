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
 * 브라우저 손잡이 관리자(Codex 재리뷰 3차 P2-1: 땜질 대신 한 곳으로 모음).
 *
 * 규칙은 세 가지뿐이다.
 * 1. 손잡이(current)를 바꾸거나 지우는 일은 모두 serial() 안에서만 한다. serial()은 한 번에 하나씩 차례로 실행한다(뮤텍스).
 * 2. 브라우저를 띄울 때마다 세대 번호(token)를 하나 준다. 띄우기 결과(늦은 성공·늦은 실패), 정리, 연결 끊김은
 *    모두 자기 token을 들고 와서, 손잡이가 아직 그 token일 때만 손잡이를 바꾼다.
 * 3. 손잡이가 아닌 세대의 브라우저(포기한 시작이 늦게 성공한 것 포함)는 반드시 죽인다. 죽이지 않은 브라우저는 live에 남는다.
 * 그래서 손잡이는 언제나 0개 또는 1개이고, 손잡이가 아닌 살아 있는 브라우저는 곧 죽는다.
 * 4. close()는 끝 상태(closed)다. 그 뒤로는 새 세대를 만들지 않는다. 닫은 뒤 들어오거나 기다리던 변환은 바로 거부한다(Codex 4차 P2-1).
 *    왜: 닫은 뒤 늦게 끝난 띄우기를 기다리던 변환이 다시 띄우면, 서버가 꺼진 뒤에도 브라우저가 남는다.
 */
export class RendererClosed extends Error {
  constructor() { super('PDF 변환기가 닫혔습니다'); }
}

class BrowserHandle {
  private lock: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private current: { token: number; starting: Promise<Launched>; instance?: Launched } | null = null;
  private closed = false;
  /** 띄웠고 아직 죽이지 않은 브라우저(세대 → 인스턴스) */
  private readonly live = new Map<number, Launched>();

  private readonly launcher: () => Promise<Launched>;

  constructor(launcher: () => Promise<Launched>) { this.launcher = launcher; }

  private serial<T>(fn: () => T): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /**
   * 쓸 브라우저를 얻는다. 손잡이가 없으면 새 세대를 띄운다. onToken으로 이 변환이 쓰는 세대를 먼저 알린다(정리가 그 세대만 다루게).
   * 기다리는 사이 그 세대가 포기됐으면(손잡이가 바뀜) 쓰지 않고 다시 얻는다.
   */
  async acquire(onToken: (token: number) => void): Promise<Browser> {
    for (;;) {
      const { token, starting } = await this.serial(() => {
        if (this.closed) throw new RendererClosed();
        if (!this.current) {
          const token = ++this.generation;
          const starting = this.launcher();
          this.current = { token, starting };
          // 띄우기 결과는 늦더라도 모두 settle()을 지난다.
          starting.then((instance) => this.settle(token, instance), () => this.settle(token, null));
          return { token, starting };
        }
        return { token: this.current.token, starting: this.current.starting };
      });
      onToken(token);
      const instance = await starting;
      // 다시 확인: 닫혔으면 거부, 그 세대가 아직 손잡이면 사용, 아니면(포기된 세대) 다시 얻는다.
      const state = await this.serial(() => (this.closed ? 'closed' : this.current?.token === token ? 'ok' : 'retry'));
      if (state === 'closed') throw new RendererClosed();
      if (state === 'ok') return instance.browser;
    }
  }

  /** 띄우기 결과 처리. 지금 손잡이 세대면 손잡이에 붙이고, 아니면(포기된 세대) 죽인다. 실패면 손잡이가 그 세대일 때만 비운다. */
  private async settle(token: number, instance: Launched | null): Promise<void> {
    const stale = await this.serial(() => {
      if (!instance) {
        if (this.current?.token === token) this.current = null;
        return false;
      }
      this.live.set(token, instance);
      if (this.current?.token !== token) return true;
      this.current.instance = instance;
      instance.browser.on('disconnected', () => { void this.retire(token); });
      return false;
    });
    if (stale) await this.kill(token);
  }

  /** 그 세대를 끝낸다: 손잡이가 아직 그 세대면 비우고, 그 세대 브라우저를 죽인다(아직 띄우는 중이면 settle이 죽인다). */
  async retire(token: number): Promise<void> {
    await this.serial(() => { if (this.current?.token === token) this.current = null; });
    await this.kill(token);
  }

  private async kill(token: number): Promise<void> {
    const instance = await this.serial(() => {
      const found = this.live.get(token);
      this.live.delete(token);
      return found;
    });
    await instance?.kill().catch(() => undefined);
  }

  /** 모두 끝낸다: 손잡이를 비우고 살아 있는 모든 세대를 죽인다. 띄우는 중인 세대는 settle이 죽인다. */
  async close(): Promise<void> {
    const tokens = await this.serial(() => {
      this.closed = true;
      this.current = null;
      return [...this.live.keys()];
    });
    await Promise.all(tokens.map((token) => this.kill(token)));
  }

  /** 지금 손잡이의 브라우저(준비된 것만) */
  ready(): Promise<Launched | undefined> {
    return this.serial(() => this.current?.instance);
  }
}

/**
 * 한 번의 변환. 시간 초과가 나면 aborted가 켜지고, 그 뒤에 만들어지는 작업 공간은 바로 닫는다.
 * token: 이 변환이 쓰는 브라우저 세대. 정리가 이 세대만 끝내게 한다.
 */
interface Job { context?: BrowserContext; aborted: boolean; token?: number }

class Timeout extends Error {
  constructor() { super('PDF 변환 시간 초과'); }
}

export function chromiumRenderer(options: RendererOptions = {}): PdfRenderer {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cleanupMs = options.cleanupMs ?? 5_000;
  const handle = new BrowserHandle(options.launcher ?? launchChromium);
  let active = 0;
  const waiting: (() => void)[] = [];

  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => { waiting.push(resolve); });
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  }

  async function convert(html: string, job: Job): Promise<Buffer> {
    const files = pdfAssets().fonts;
    const browser = await handle.acquire((token) => { job.token = token; });
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
          if (!settled && job.token !== undefined) await handle.retire(job.token);
          throw new Timeout();
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }),
    async close() {
      await handle.close();
    },
    async inspect() {
      const started = await handle.ready();
      if (!started) return { pid: null, contexts: 0, pages: 0 };
      const contexts = started.browser.contexts();
      return { pid: started.pid, contexts: contexts.length, pages: contexts.reduce((n, c) => n + c.pages().length, 0) };
    },
  };
}
