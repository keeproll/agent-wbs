import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { atomicWrite } from '../../state/files.ts';
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
  /** 화면을 고르는 `#…` 조각. 없으면 빈 문자열. */
  fragment: string;
  /** 고정한 main 커밋의 `prototype/uiux/` 파일만 읽는다. 다른 경로는 거부한다. */
  read: (path: string) => Promise<Buffer>;
  settings: typeof BASELINE_RENDER;
}
/** Runner 소유 렌더러. 단계(정의의 명령)가 아니라 Runner가 실행하므로 Agent 코드가 기준을 만들 수 없다. */
export type BaselineRenderer = (request: RenderRequest, signal?: AbortSignal) => Promise<Buffer>;

const PREFIX = 'prototype/uiux/';
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
  addStyleTag(options: { content: string }): Promise<unknown>;
  evaluate(script: () => unknown): Promise<unknown>;
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
  return async ({ entry, fragment, read, settings }) => {
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
        await page.goto(`${ORIGIN}/${entry}${fragment}`);
        await page.addStyleTag({ content: `*, *::before, *::after { font-family: '${settings.font}' !important; }` });
        await page.evaluate(() => (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready);
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
export async function baselineImage(home: string, baseSha: string, screen: string, target: string, read: RenderRequest['read'], render: BaselineRenderer | undefined, signal?: AbortSignal): Promise<Buffer> {
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
  const [entry = '', fragment = ''] = target.split(/(?=#)/);
  let image: Buffer;
  try { image = await render({ entry, fragment, read, settings: BASELINE_RENDER }, signal); }
  catch (error) { throw new Error(`기준 이미지를 렌더하지 못했습니다: ${error instanceof Error ? error.message : ''}`, { cause: error }); }
  try { decodePng(image); } catch { throw new Error('기준 이미지 렌더 결과가 PNG가 아닙니다.'); }
  // rename으로 바꾸므로 같은 이름의 링크가 있어도 따라가지 않고 링크 자체를 바꾼다.
  await atomicWrite(directory, name, image);
  return image;
}
