import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { atomicWrite } from '../../state/files.ts';
import type { RunCommand } from '../../readiness/command.ts';
import type { ScreenTarget } from '../pipeline.ts';
import { decodePng } from './visual.ts';

/**
 * 기준 이미지를 렌더하는 고정 설정(조정자 결정 8).
 * 뷰포트·배율·글꼴·언어·시간대를 Runner가 정한다. 왜: 같은 main이면 언제 렌더해도 같은 기준이 나와야 한다.
 * 단계(앱 화면 촬영)에도 `AWBS_SCREEN_WIDTH`·`AWBS_SCREEN_HEIGHT`로 같은 크기를 알려 준다.
 */
export const BASELINE_RENDER = {
  version: 1,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  font: 'Noto Sans KR',
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
} as const;

export interface RenderRequest {
  /** 시작 HTML의 저장소 경로(예: prototype/uiux/Main.dc.html). */
  entry: string;
  /** 화면을 여는 `#…` 라우트. */
  route: string;
  /** 화면 준비가 끝났음을 알리는 CSS 선택자. 보일 때까지 기다린 뒤 찍는다. */
  ready: string;
  /** 고정한 main 커밋의 `prototype/uiux/` 파일만 읽는다. 다른 경로는 거부한다. */
  read: (path: string) => Promise<Buffer>;
  settings: typeof BASELINE_RENDER;
}
/** Runner 소유 렌더러. 단계(정의의 명령)가 아니라 Runner가 실행하므로 Agent 코드가 기준을 만들 수 없다. */
export type BaselineRenderer = (request: RenderRequest, signal?: AbortSignal) => Promise<Buffer>;

const PREFIX = 'prototype/uiux/';
const READY_TIMEOUT_MS = 10_000;

/**
 * 브라우저 안에서 글꼴 설치 여부를 잰다. 고정 글꼴을 앞세운 글자 폭이 대체 글꼴만 쓴 폭과 모두 같으면 없는 것이다.
 * 왜 document.fonts.check를 쓰지 않나: 없는 글꼴 이름에도 true를 돌려준다.
 */
function fontInstalled(font: string): boolean {
  const doc = (globalThis as unknown as { document: { createElement(tag: 'canvas'): { getContext(type: '2d'): { font: string; measureText(text: string): { width: number } } | null } } }).document;
  const context = doc.createElement('canvas').getContext('2d');
  if (!context) return false;
  const sample = '가나다라마바사 WBS 0123 mmmmmmmmmmlli';
  return ['monospace', 'serif', 'sans-serif'].some(base => {
    context.font = `72px ${base}`; const fallback = context.measureText(sample).width;
    context.font = `72px '${font}', ${base}`; return context.measureText(sample).width !== fallback;
  });
}

/**
 * Runner 준비 점검용 글꼴 확인(결정 12). fontconfig(`fc-list`)로 고정 글꼴이 설치됐는지 본다.
 * 없으면 warn이다. 이때 야간 화면 비교는 「비교 불가」가 된다(통과로 보지 않음).
 */
export async function checkBaselineFont(run: RunCommand): Promise<{ status: 'ok' | 'warn'; detail: string; fix?: string }> {
  const font = BASELINE_RENDER.font;
  const missing = { status: 'warn' as const, detail: `화면 비교 고정 글꼴 ${font}이 없어 야간 화면 비교는 비교 불가로 처리됩니다.`, fix: `${font} 글꼴을 설치하세요(예: fonts-noto-cjk).` };
  try {
    const result = await run('fc-list', [`:family=${font}`, 'family']);
    return result.code === 0 && result.stdout.split('\n').some(line => line.split(',').map(v => v.trim()).includes(font))
      ? { status: 'ok', detail: `화면 비교 고정 글꼴 ${font} 설치됨` } : missing;
  } catch { return missing; }
}
const ORIGIN = 'http://baseline.invalid';
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

/** `prototype/uiux/` 안의 정규화된 경로만 받는다. */
export function prototypePath(path: string): string {
  const normal = posix.normalize(path);
  if (normal !== path || !normal.startsWith(PREFIX) || normal.split('/').some(part => ['', '.', '..'].includes(part))) throw new TypeError(`기준 렌더는 ${PREFIX} 파일만 읽을 수 있습니다: ${path}`);
  return normal;
}

/** Playwright의 필요한 부분만 적은 형태. M7-06이 `(await import('playwright')).chromium`을 넘긴다. */
interface RouteLike { request(): { url(): string }; fulfill(response: { status: number; body: Buffer; contentType: string }): Promise<void>; abort(): Promise<void> }
interface PageLike {
  route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options: { state: 'visible'; timeout: number }): Promise<unknown>;
  addStyleTag(options: { content: string }): Promise<unknown>;
  evaluate<A>(script: (arg: A) => unknown, arg?: A): Promise<unknown>;
  screenshot(options: { type: 'png'; fullPage: boolean; animations: 'disabled'; caret: 'hide' }): Promise<Buffer>;
}
export interface ChromiumLike {
  launch(): Promise<{
    newContext(options: Record<string, unknown>): Promise<{ newPage(): Promise<PageLike>; close(): Promise<void> }>;
    close(): Promise<void>;
  }>;
}

/**
 * Playwright로 기준 화면을 찍는 렌더러.
 * - 모든 요청을 가로채 고정한 main의 `prototype/uiux/` 파일로만 응답한다. 바깥 주소(CDN 등)는 막는다.
 *   왜: 네트워크에서 받은 글꼴·스크립트가 바뀌면 같은 main이라도 기준이 달라진다.
 * - 글꼴은 CSS로 고정한다. 애니메이션·커서는 끈다.
 */
export function createPlaywrightRenderer(chromium: ChromiumLike): BaselineRenderer {
  return async ({ entry, route, ready, read, settings }) => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: settings.viewport, deviceScaleFactor: settings.deviceScaleFactor,
        locale: settings.locale, timezoneId: settings.timezoneId, reducedMotion: 'reduce', javaScriptEnabled: true });
      try {
        const page = await context.newPage();
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== ORIGIN) { await route.abort(); return; }
          try {
            const path = prototypePath(decodeURIComponent(url.pathname.slice(1)));
            await route.fulfill({ status: 200, body: await read(path), contentType: TYPES[posix.extname(path).toLowerCase()] ?? 'application/octet-stream' });
          } catch { await route.abort(); }
        });
        await page.goto(`${ORIGIN}/${entry}${route}`);
        // 화면이 다 그려졌다는 표시가 보일 때까지 기다린다. 안 보이면 그 라우트로 열 수 없는 화면이다(결정 13).
        try { await page.waitForSelector(ready, { state: 'visible', timeout: READY_TIMEOUT_MS }); }
        catch (error) { throw new Error(`준비 선택자 ${ready}가 ${String(READY_TIMEOUT_MS)}ms 안에 보이지 않습니다(라우트 ${route}로 열 수 없는 화면).`, { cause: error }); }
        await page.addStyleTag({ content: `*, *::before, *::after { font-family: '${settings.font}' !important; }` });
        await page.evaluate(() => (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready);
        // 고정 글꼴이 없으면 브라우저가 다른 글꼴로 바꿔 그린다. 그런 기준은 비교 근거가 될 수 없다(결정 12).
        if (await page.evaluate(fontInstalled, settings.font) !== true) throw new Error(`고정 글꼴 ${settings.font}이 설치되어 있지 않아 기준 화면을 만들 수 없습니다(비교 불가).`);
        return await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', caret: 'hide' });
      } finally { await context.close(); }
    } finally { await browser.close(); }
  };
}

/**
 * 기준 이미지를 main SHA별로 `<AWBS_HOME>/ci/baselines/<main SHA>/`에 보관한다.
 * - 파일 이름은 화면·대상·렌더 설정의 hash다. 설정이 바뀌면 다시 렌더한다.
 * - 보관본은 링크를 따라가지 않고 읽는다. 손상됐거나 PNG가 아니면 다시 렌더해 바꾼다.
 * - 렌더러가 없거나 실패하면 오류를 던진다. 호출한 쪽은 「비교 불가」로 본다.
 */
export async function baselineImage(home: string, baseSha: string, screen: string, target: ScreenTarget, read: RenderRequest['read'], render: BaselineRenderer | undefined, signal?: AbortSignal): Promise<Buffer> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha)) throw new TypeError('main SHA가 올바르지 않습니다.');
  const directory = join(home, 'ci', 'baselines', baseSha);
  for (const path of [join(home, 'ci'), join(home, 'ci', 'baselines'), directory]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!(await lstat(path)).isDirectory()) throw new Error('기준 이미지 폴더가 올바르지 않습니다.');
  }
  const name = `${createHash('sha256').update(JSON.stringify({ screen, target, settings: BASELINE_RENDER })).digest('hex')}.png`;
  try {
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if ((await file.stat()).isFile()) { const cached = await file.readFile(); decodePng(cached); return cached; }
    } finally { await file.close(); }
  } catch { /* 없거나 손상됐거나 링크면 다시 렌더한다. */ }
  if (!render) throw new Error('기준 이미지 렌더러가 연결되지 않았습니다.');
  let image: Buffer;
  try { image = await render({ entry: target.page, route: target.route, ready: target.ready, read, settings: BASELINE_RENDER }, signal); }
  catch (error) { throw new Error(`기준 이미지를 렌더하지 못했습니다: ${error instanceof Error ? error.message : ''}`, { cause: error }); }
  try { decodePng(image); } catch { throw new Error('기준 이미지 렌더 결과가 PNG가 아닙니다.'); }
  // rename으로 바꾸므로 같은 이름의 링크가 있어도 따라가지 않고 링크 자체를 바꾼다.
  await atomicWrite(directory, name, image);
  return image;
}
