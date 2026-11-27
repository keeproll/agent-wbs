import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dirname, join, posix, sep } from 'node:path';
import { atomicWrite } from '../../state/files.ts';
import type { RunCommand } from '../../readiness/command.ts';
import type { ScreenStep, ScreenTarget } from '../pipeline.ts';
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
  /** 화면을 여는 `#…` 라우트. 없으면 빈 문자열. */
  route: string;
  /** 화면까지 가는 제한된 조작(click·waitFor·setViewport). 순서대로 한다. */
  steps?: readonly ScreenStep[];
  /** 화면 준비가 끝났음을 알리는 CSS 선택자. 보일 때까지 기다린 뒤 찍는다. */
  ready: string;
  /** 고정한 main 커밋의 `prototype/uiux/` 파일만 읽는다. 다른 경로는 거부한다. */
  read: (path: string) => Promise<Buffer>;
  /** 고정한 main 커밋의 `prototype/uiux/` 아래 파일 목록. 렌더 전에 Runner 소유 폴더로 꺼내 file://로 연다. */
  files: () => Promise<string[]>;
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

/**
 * Runner 준비 점검용 렌더러 네트워크 차단 방식 확인(M7-03 결정 16).
 * 사용자 네트워크 네임스페이스를 만들 수 있으면 ok, 실행 인자 차단(proxy)만 가능하면 warn이다. warn이어도 화면 비교는 실행한다.
 * 왜: 인자 차단은 Chromium 설정에 기대므로 네임스페이스보다 약하다. 팀장이 그 차이를 준비 점검에서 볼 수 있어야 한다.
 */
export async function checkRendererIsolation(detect: () => Promise<NetworkIsolation> = detectNetworkIsolation): Promise<{ status: 'ok' | 'warn'; detail: string; fix?: string }> {
  return await detect() === 'namespace'
    ? { status: 'ok', detail: '화면 비교 렌더러를 사용자 네트워크 네임스페이스 안에서 실행합니다(네트워크 없음).' }
    : { status: 'warn', detail: '사용자 네트워크 네임스페이스를 만들 수 없어 실행 인자로만 렌더러의 네트워크를 막습니다.',
      fix: 'unshare --user --net이 동작하도록 사용자 네임스페이스를 허용하세요(예: kernel.unprivileged_userns_clone=1).' };
}

/** `prototype/uiux/` 안의 정규화된 경로만 받는다. */
export function prototypePath(path: string): string {
  const normal = posix.normalize(path);
  if (normal !== path || !normal.startsWith(PREFIX) || normal.split('/').some(part => ['', '.', '..'].includes(part))) throw new TypeError(`기준 렌더는 ${PREFIX} 파일만 읽을 수 있습니다: ${path}`);
  return normal;
}

/**
 * 렌더러 브라우저를 네트워크 없이 띄우는 방식(3차 리뷰, 조정자 지시).
 * - namespace: 사용자 네트워크 네임스페이스(`unshare --user --map-current-user --net`, root 불필요) 안에서 Chromium을 띄운다.
 *   그 안에는 꺼진 loopback 하나뿐이라 어떤 소켓도 바깥(이 PC의 다른 서비스 포함)에 닿지 않는다.
 * - proxy: 네임스페이스를 쓸 수 없을 때의 대체. 아래 실행 인자로 모든 소켓을 막는다.
 * 두 방식 모두 아래 차단 인자와 페이지 가로채기(2차 방어)를 함께 쓴다.
 */
export type NetworkIsolation = 'namespace' | 'proxy';
const UNSHARE = ['--user', '--map-current-user', '--net'] as const;
/**
 * 모든 방식에 붙이는 Chromium 차단 인자.
 * - 죽은 프록시(127.0.0.1:9, discard 포트)로 모든 요청을 보낸다. `<-loopback>`은 loopback도 프록시를 거치게 한다(기본 우회 해제).
 * - 이름 해석은 localhost까지 모두 실패시킨다(EXCLUDE 없음).
 * - WebRTC는 프록시를 거치지 않는 UDP를 쓰지 못한다.
 * - 백그라운드 통신(구성요소 갱신·DNS 미리 읽기·핑)을 끈다.
 */
export const NETWORK_DENY_ARGS = [
  '--proxy-server=socks5://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-background-networking',
  '--disable-component-update',
  '--dns-prefetch-disable',
  '--no-pings',
] as const;

/** 이 PC에서 사용자 네트워크 네임스페이스를 만들 수 있는지 실제로 해 본다. 안 되면 proxy 방식이다. */
export function detectNetworkIsolation(): Promise<NetworkIsolation> {
  return new Promise(resolve => {
    execFile('unshare', [...UNSHARE, 'true'], { timeout: 10_000 }, error => { resolve(error ? 'proxy' : 'namespace'); });
  });
}

/** Playwright의 필요한 부분만 적은 형태. M7-06이 `(await import('playwright')).chromium`을 넘긴다. */
interface RouteLike { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }
interface PageLike {
  goto(url: string): Promise<unknown>;
  click(selector: string, options: { timeout: number }): Promise<unknown>;
  setViewportSize(size: { width: number; height: number }): Promise<unknown>;
  waitForSelector(selector: string, options: { state: 'visible'; timeout: number }): Promise<unknown>;
  addStyleTag(options: { content: string }): Promise<unknown>;
  evaluate<A>(script: (arg: A) => unknown, arg?: A): Promise<unknown>;
  screenshot(options: { type: 'png'; fullPage: boolean; animations: 'disabled'; caret: 'hide' }): Promise<Buffer>;
}
export interface ChromiumLike {
  executablePath(): string;
  launch(options: { args: string[]; executablePath?: string }): Promise<{
    newContext(options: Record<string, unknown>): Promise<{
      newPage(): Promise<PageLike>; close(): Promise<void>;
      route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
      routeWebSocket(pattern: RegExp, handler: (ws: { close(): Promise<void> | void }) => unknown): Promise<void>;
      on(event: 'page', listener: (page: { close(): Promise<void> }) => unknown): unknown;
    }>;
    close(): Promise<void>;
  }>;
}
export interface RendererOptions {
  isolation: NetworkIsolation;
  /** Runner 소유 작업 폴더(예: `<AWBS_HOME>/ci/render`). 프로토타입 사본과 실행 래퍼를 여기 만들고 끝나면 지운다. */
  workDir: string;
}
const MAX_PROTOTYPE_BYTES = 200 * 1024 * 1024;

/**
 * 렌더러 브라우저의 실행 설정. 차단 인자는 항상 붙이고, namespace 방식이면 네임스페이스 래퍼를 실행 파일로 쓴다.
 * 래퍼는 dir(Runner 소유 폴더)에 새로 만든다. Playwright는 파이프(fd 3·4)로 브라우저와 이야기하고 exec가 그 fd를 그대로 넘긴다.
 */
export async function prepareLaunch(isolation: NetworkIsolation, chromium: Pick<ChromiumLike, 'executablePath'>, dir: string): Promise<{ args: string[]; executablePath?: string }> {
  const launch: { args: string[]; executablePath?: string } = { args: [...NETWORK_DENY_ARGS] };
  if (isolation === 'namespace') {
    const wrapper = join(dir, 'chromium-netns.sh');
    await writeFile(wrapper, `#!/bin/sh\nexec unshare ${UNSHARE.join(' ')} -- ${shellQuote(chromium.executablePath())} "$@"\n`, { mode: 0o700, flag: 'wx' });
    await chmod(wrapper, 0o700);
    launch.executablePath = wrapper;
  }
  return launch;
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Playwright로 기준 화면을 찍는 렌더러. 네트워크 계층에서 막는다(3차 리뷰).
 * - 브라우저를 네트워크 없는 상태로 띄운다: namespace 방식은 사용자 네트워크 네임스페이스 안에서, proxy 방식은 차단 인자로.
 *   왜: 페이지 안 가로채기는 Worker·SharedWorker의 WebSocket처럼 거치지 않는 경로가 계속 나온다. 소켓 자체가 바깥에 닿지 않아야 끝난다.
 * - 프로토타입은 고정한 main의 `prototype/uiux/` 파일을 Runner 소유 폴더에 꺼내 file://로만 연다.
 * - 2차 방어: 컨텍스트 가로채기(그 폴더의 file://만 통과), WebSocket 닫기, 서비스 워커·다운로드 차단, 새 창 닫기.
 * - 글꼴은 CSS로 고정한다. 애니메이션·커서는 끈다.
 */
export function createPlaywrightRenderer(chromium: ChromiumLike, { isolation, workDir }: RendererOptions): BaselineRenderer {
  const renderer: BaselineRenderer = async ({ entry, route, steps = [], ready, read, files, settings }) => {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    if (!(await lstat(workDir)).isDirectory()) throw new Error('렌더 작업 폴더가 올바르지 않습니다.');
    const root = join(workDir, randomUUID());
    await mkdir(root, { mode: 0o700 });
    try {
      let total = 0;
      for (const file of await files()) {
        const path = prototypePath(file);
        const body = await read(path);
        total += body.length;
        if (total > MAX_PROTOTYPE_BYTES) throw new Error('프로토타입 파일이 너무 큽니다.');
        await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
        await writeFile(join(root, path), body, { mode: 0o600, flag: 'wx' });
      }
      const browser = await chromium.launch(await prepareLaunch(isolation, chromium, root));
      try {
        const context = await browser.newContext({ viewport: settings.viewport, deviceScaleFactor: settings.deviceScaleFactor,
          locale: settings.locale, timezoneId: settings.timezoneId, reducedMotion: 'reduce', javaScriptEnabled: true, serviceWorkers: 'block', acceptDownloads: false });
        try {
          await context.routeWebSocket(/.*/, ws => ws.close());
          const allowed = pathToFileURL(root + sep).href;
          await context.route('**/*', async request => {
            const url = request.request().url();
            if (url.startsWith(allowed)) await request.continue(); else await request.abort();
          });
          let main: unknown = null;
          context.on('page', popup => { if (main !== null && popup !== main) void popup.close().catch(() => undefined); });
          const page = await context.newPage();
          main = page;
          await page.goto(`${pathToFileURL(join(root, prototypePath(entry))).href}${route}`);
          // 정의에 적힌 제한된 조작만 순서대로 한다. 임의 스크립트는 실행하지 않는다(결정 13 보완).
          for (const [index, step] of steps.entries()) {
            const label = 'click' in step ? `click ${step.click}` : 'waitFor' in step ? `waitFor ${step.waitFor}` : `setViewport ${String(step.setViewport.width)}x${String(step.setViewport.height)}`;
            try {
              if ('click' in step) await page.click(step.click, { timeout: READY_TIMEOUT_MS });
              else if ('waitFor' in step) await page.waitForSelector(step.waitFor, { state: 'visible', timeout: READY_TIMEOUT_MS });
              else await page.setViewportSize(step.setViewport);
            } catch (error) { throw new Error(`조작 단계 ${String(index + 1)}(${label})이 실패해 기준 화면을 만들 수 없습니다(비교 불가).`, { cause: error }); }
          }
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
    } finally { await rm(root, { recursive: true, force: true }); }
  };
  return renderer;
}

/**
 * 기준 이미지를 main SHA별로 `<AWBS_HOME>/ci/baselines/<main SHA>/`에 보관한다.
 * - 파일 이름은 화면·대상·렌더 설정의 hash다. 설정이 바뀌면 다시 렌더한다.
 * - 보관본은 링크를 따라가지 않고 읽는다. 손상됐거나 PNG가 아니면 다시 렌더해 바꾼다.
 * - 렌더러가 없거나 실패하면 오류를 던진다. 호출한 쪽은 「비교 불가」로 본다.
 */
export async function baselineImage(home: string, baseSha: string, screen: string, target: ScreenTarget, source: Pick<RenderRequest, 'read' | 'files'>, render: BaselineRenderer | undefined, signal?: AbortSignal): Promise<Buffer> {
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
  try { image = await render({ entry: target.page, route: target.route ?? '', ...(target.steps && { steps: target.steps }), ready: target.ready, read: source.read, files: source.files, settings: BASELINE_RENDER }, signal); }
  catch (error) { throw new Error(`기준 이미지를 렌더하지 못했습니다: ${error instanceof Error ? error.message : ''}`, { cause: error }); }
  try { decodePng(image); } catch { throw new Error('기준 이미지 렌더 결과가 PNG가 아닙니다.'); }
  // rename으로 바꾸므로 같은 이름의 링크가 있어도 따라가지 않고 링크 자체를 바꾼다.
  await atomicWrite(directory, name, image);
  return image;
}
