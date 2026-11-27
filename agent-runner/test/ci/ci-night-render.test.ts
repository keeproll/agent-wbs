// 조정자 결정 8: 화면 비교 기준 이미지는 main의 prototype/uiux HTML을 Runner 소유 렌더러가 직접 만든다.
import { lstat, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parsePipeline } from '../../src/ci/pipeline.ts';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { runNightCheck } from '../../src/ci/night/run.ts';
import { BASELINE_RENDER, checkBaselineFont, createPlaywrightRenderer, type BaselineRenderer, type RenderRequest } from '../../src/ci/night/baseline.ts';
import { commit, definition, file, git } from './int-fixture.ts';
import { ciFixture } from './night-fixture.ts';
import { png } from './png.ts';

const NOW = Date.parse('2026-11-27T09:00:00Z');
type F = Awaited<ReturnType<typeof ciFixture>>;
const red = png(2, 2, () => [255, 0, 0, 255]);
const blue = png(2, 2, () => [0, 0, 255, 255]);
const night = (f: F, renderBaseline?: BaselineRenderer) => ({ repo: f.repo, heavy: new HeavySemaphore(1), execute: f.execute, report: f.report, home: f.home,
  quarantined: new Set<string>(), retry: 1, now: () => NOW, ...(renderBaseline && { renderBaseline }) });

const WBS = { page: 'prototype/uiux/Main.dc.html', route: '#wbs', ready: '[data-screen=wbs]' };
async function prototype(f: F, html: string, screens: Record<string, unknown> = { wbs: WBS }) {
  await file(join(f.source, 'prototype/uiux/Main.dc.html'), html);
  await file(join(f.source, 'prototype/uiux/app.css'), 'body{}');
  await file(join(f.source, '.agentwbs/pipeline.yaml'), JSON.stringify({ ...f.pipeline, stages: { ...f.pipeline.stages, night: [{ name: 'visual', argv: ['fake', 'night-visual'], screens }] } }));
  const sha = commit(f.source); git(f.source, 'push', f.remote, 'main'); return sha;
}
/** 시험용 렌더러: main에서 읽은 HTML 내용에 따라 색을 고른다. 호출을 기록한다. */
function renderer() {
  const calls: RenderRequest[] = [];
  const render: BaselineRenderer = async (request) => {
    calls.push(request);
    const html = (await request.read(request.entry)).toString();
    return html.includes('RED') ? red : blue;
  };
  return { calls, render };
}
const shoot = (f: F, image: Buffer) => f.script(async ({ name }) => name === 'visual'
  ? { code: 0, files: { 'app.png': image }, report: { screens: [{ name: 'wbs', actual: 'app.png' }] } } : { code: 0 });

test('screens는 화면마다 prototype/uiux HTML 경로·#라우트·준비 완료 선택자를 둔다', () => {
  const night = (screens: unknown) => JSON.stringify({ ...definition, stages: { ...definition.stages, night: [{ name: 'visual', argv: ['x'], screens }] } });
  expect(parsePipeline(night({ wbs: WBS })).stages.night[0]?.screens).toEqual({ wbs: WBS });
  for (const bad of [
    'prototype/uiux/Main.dc.html#wbs',
    { page: 'prototype/uiux/Main.dc.html', route: '', ready: 'main' },
    { page: 'prototype/uiux/Main.dc.html', route: 'wbs', ready: 'main' },
    { page: 'prototype/uiux/Main.dc.html', route: '#', ready: 'main' },
    { page: 'prototype/uiux/Main.dc.html', route: '#a b', ready: 'main' },
    { page: 'prototype/uiux/Main.dc.html', route: '#wbs' },
    { page: 'prototype/uiux/Main.dc.html', route: '#wbs', ready: '' },
    { page: 'prototype/uiux/Main.dc.html', route: '#wbs', ready: 'a\nb' },
    { page: 'prototype/uiux/Main.dc.html#x', route: '#wbs', ready: 'main' },
    { page: 'prototype/uiux/shots/wbs.png', route: '#wbs', ready: 'main' },
    { page: 'src/index.html', route: '#wbs', ready: 'main' },
    { page: 'prototype/uiux/../x.html', route: '#wbs', ready: 'main' },
    { ...WBS, extra: 1 },
    { ...WBS, steps: [] },
    { ...WBS, steps: [{ evaluate: 'document.body.click()' }] },
    { ...WBS, steps: [{ click: 'a', waitFor: 'b' }] },
    { ...WBS, steps: [{ click: '' }] },
    { ...WBS, steps: [{ setViewport: { width: 100, height: 900 } }] },
    { ...WBS, steps: [{ setViewport: { width: 1440.5, height: 900 } }] },
    { ...WBS, steps: [{ setViewport: { width: 1440, height: 900, scale: 2 } }] },
    { ...WBS, steps: Array.from({ length: 21 }, () => ({ click: 'a' })) },
  ]) expect(() => parsePipeline(night({ wbs: bad })), JSON.stringify(bad)).toThrow();
});

test('원본에 hash 라우팅이 없으므로 화면까지 가는 제한된 조작 단계(click·waitFor·setViewport)를 둘 수 있다', () => {
  const night = (screens: unknown) => JSON.stringify({ ...definition, stages: { ...definition.stages, night: [{ name: 'visual', argv: ['x'], screens }] } });
  const ci = { page: 'prototype/uiux/Main.dc.html', ready: '.ci-tabs', steps: [{ click: 'nav [data-nav=ci]' }, { waitFor: '.ci-tabs' }, { setViewport: { width: 390, height: 844 } }] };
  expect(parsePipeline(night({ ci })).stages.night[0]?.screens).toEqual({ ci });
  // 라우트도 조작도 없으면 처음 열리는 화면이다.
  const home = { page: 'prototype/uiux/Main.dc.html', ready: 'main' };
  expect(parsePipeline(night({ home })).stages.night[0]?.screens).toEqual({ home });
});

test('기준 이미지는 Runner 렌더러가 main의 HTML을 고정 뷰포트·글꼴로 렌더해 만든다', async () => {
  const f = await ciFixture({ night: ['visual'] });
  try {
    await prototype(f, '<html>RED</html>');
    const r = renderer();
    shoot(f, red);
    const out = await runNightCheck(night(f, r.render), '2026-11-27');
    expect(out).toMatchObject({ status: 'pass', screens: [{ name: 'wbs', status: 'same', ratio: 0 }] });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ entry: 'prototype/uiux/Main.dc.html', route: '#wbs', ready: '[data-screen=wbs]', settings: BASELINE_RENDER });
    expect(BASELINE_RENDER).toMatchObject({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    expect((await r.calls[0]?.read('prototype/uiux/app.css'))?.toString()).toBe('body{}');
    await expect(r.calls[0]?.read('.agentwbs/pipeline.yaml') ?? Promise.resolve()).rejects.toThrow();
    await expect(r.calls[0]?.read('prototype/uiux/../shared') ?? Promise.resolve()).rejects.toThrow();
    const env = f.calls.find(c => c.name === 'visual')?.env;
    expect(env).toMatchObject({ AWBS_SCREEN_WIDTH: '1440', AWBS_SCREEN_HEIGHT: '900' });
  } finally { await f.close(); }
});

test('기준 이미지는 main SHA별로 보관해 다시 렌더하지 않고, main이 바뀌면 새로 렌더한다', async () => {
  const f = await ciFixture({ night: ['visual'] });
  try {
    const first = await prototype(f, '<html>RED</html>');
    const r = renderer();
    shoot(f, red);
    await runNightCheck(night(f, r.render), '2026-11-27');
    await runNightCheck(night(f, r.render), '2026-11-28');
    expect(r.calls).toHaveLength(1);
    expect(await readdir(join(f.home, 'ci', 'baselines'))).toEqual([first]);
    await prototype(f, '<html>BLUE</html>');
    const out = await runNightCheck(night(f, r.render), '2026-11-29');
    expect(r.calls).toHaveLength(2);
    expect(out).toMatchObject({ status: 'pass', screens: [{ name: 'wbs', status: 'diff', ratio: 1 }] });
  } finally { await f.close(); }
});

test('보관한 기준 이미지가 손상되거나 링크면 따라가지 않고 다시 렌더한다', async () => {
  const f = await ciFixture({ night: ['visual'] });
  try {
    const sha = await prototype(f, '<html>RED</html>');
    const r = renderer();
    shoot(f, red);
    await runNightCheck(night(f, r.render), '2026-11-27');
    const dir = join(f.home, 'ci', 'baselines', sha);
    const [name] = await readdir(dir);
    const cached = join(dir, name ?? '');
    await writeFile(cached, 'broken');
    expect((await runNightCheck(night(f, r.render), '2026-11-28')).screens).toEqual([{ name: 'wbs', status: 'same', ratio: 0 }]);
    await rm(cached);
    const fake = join(f.root, 'fake.png'); await writeFile(fake, blue);
    await symlink(fake, cached);
    expect((await runNightCheck(night(f, r.render), '2026-11-29')).screens).toEqual([{ name: 'wbs', status: 'same', ratio: 0 }]);
    expect(r.calls).toHaveLength(3);
    expect((await lstat(cached)).isSymbolicLink()).toBe(false);
  } finally { await f.close(); }
});

test('기준 렌더가 실패하거나 렌더러가 없으면 비교 불가로 실패한다', async () => {
  const f = await ciFixture({ night: ['visual'] });
  try {
    await prototype(f, '<html>RED</html>');
    shoot(f, red);
    const failing: BaselineRenderer = async () => { throw new Error('chromium 없음'); };
    expect(await runNightCheck(night(f, failing), '2026-11-27')).toMatchObject({ status: 'fail', failStep: 'visual', screens: [{ name: 'wbs', status: 'missing' }] });
    expect(f.final().logExcerpt).toContain('기준 이미지를 렌더하지 못했습니다: chromium 없음');
    expect(await runNightCheck(night(f), '2026-11-28')).toMatchObject({ status: 'fail', failStep: 'visual', screens: [{ name: 'wbs', status: 'missing' }] });
    expect(f.final().logExcerpt).toContain('기준 이미지 렌더러가 연결되지 않았습니다');
    const notPng: BaselineRenderer = async () => Buffer.from('not png');
    expect(await runNightCheck(night(f, notPng), '2026-11-29')).toMatchObject({ status: 'fail', screens: [{ name: 'wbs', status: 'missing' }] });
    expect(f.final().logExcerpt).toContain('PNG가 아닙니다');
    const dirs = await readdir(join(f.home, 'ci', 'baselines'));
    for (const dir of dirs) expect(await readdir(join(f.home, 'ci', 'baselines', dir))).toEqual([]);
  } finally { await f.close(); }
});

function fakeChromium(options: { ready?: boolean; fontInstalled?: boolean; failClick?: string } = {}) {
  const log: string[] = [];
  const files: Record<string, string> = { 'prototype/uiux/Main.dc.html': '<html></html>', 'prototype/uiux/app.css': 'body{}' };
  type Handler = (route: { request: () => { url: () => string }; fulfill: (r: { status: number; body: Buffer; contentType: string }) => Promise<void>; abort: () => Promise<void> }) => Promise<void>;
  let handler: Handler | undefined;
  const pageListeners: ((p: { close: () => Promise<void> }) => unknown)[] = [];
  const page = {
    route: async () => { log.push('page.route'); },
    goto: async (url: string) => {
      log.push(`goto ${url}`);
      for (const u of ['http://baseline.invalid/prototype/uiux/app.css', 'https://cdn.example.com/prototype/uiux/app.css', 'http://baseline.invalid/src/secret.ts']) {
        await handler?.({ request: () => ({ url: () => u }),
          fulfill: async r => { log.push(`fulfill ${u} ${r.contentType} ${r.body.toString()}`); },
          abort: async () => { log.push(`abort ${u}`); } });
      }
    },
    click: async (selector: string, o: Record<string, unknown>) => {
      log.push(`click ${selector} ${JSON.stringify(o)}`);
      if (selector === options.failClick) throw new Error('Timeout 10000ms exceeded');
      if (selector === '#popup') {
        // 새 창: 컨텍스트 가로채기가 첫 요청을 받고, 창은 바로 닫혀야 한다.
        await handler?.({ request: () => ({ url: () => 'http://127.0.0.1:43387/popup' }),
          fulfill: async () => { log.push('fulfill popup'); }, abort: async () => { log.push('abort popup'); } });
        const popup = { close: async () => { log.push('popup closed'); } };
        for (const listener of pageListeners) await listener(popup);
      }
    },
    setViewportSize: async (size: { width: number; height: number }) => { log.push(`viewport ${JSON.stringify(size)}`); },
    waitForSelector: async (selector: string, o: Record<string, unknown>) => {
      log.push(`wait ${selector} ${JSON.stringify(o)}`);
      if (options.ready === false && selector === '[data-screen=wbs]') throw new Error('Timeout 10000ms exceeded');
    },
    addStyleTag: async ({ content }: { content: string }) => { log.push(`style ${content}`); },
    evaluate: async (_script: unknown, arg?: unknown) => { log.push(`evaluate ${JSON.stringify(arg ?? null)}`); return arg === undefined ? undefined : options.fontInstalled !== false; },
    screenshot: async (o: Record<string, unknown>) => { log.push(`shot ${JSON.stringify(o)}`); return red; },
  };
  const chromium = { launch: async () => ({
    newContext: async (o: Record<string, unknown>) => {
      log.push(`context ${JSON.stringify(o)}`);
      return { newPage: async () => page, close: async () => undefined,
        route: async (_: string, h: Handler) => { log.push('context.route'); handler = h; },
        routeWebSocket: async () => { log.push('context.routeWebSocket'); },
        on: (event: string, listener: (p: { close: () => Promise<void> }) => unknown) => { log.push(`context.on ${event}`); if (event === 'page') pageListeners.push(listener); } };
    },
    close: async () => { log.push('close'); },
  }) };
  // 렌더러 스스로도 경로를 거른다. read가 무엇이든 내주더라도 prototype/uiux 밖은 막아야 한다.
  const request = { entry: 'prototype/uiux/Main.dc.html', route: '#wbs', ready: '[data-screen=wbs]', settings: BASELINE_RENDER,
    read: async (path: string) => Buffer.from(files[path] ?? `leaked ${path}`) };
  return { log, chromium, request };
}
const WAIT = `wait [data-screen=wbs] ${JSON.stringify({ state: 'visible', timeout: 10_000 })}`;

test('Playwright 렌더러는 라우트 URL로 열고 준비 선택자가 보일 때까지 기다린 뒤, main 파일만 내보내며 고정 설정으로 찍는다', async () => {
  const { log, chromium, request } = fakeChromium();
  expect(await createPlaywrightRenderer(chromium)(request)).toBe(red);
  expect(log).toContain(`context ${JSON.stringify({ viewport: BASELINE_RENDER.viewport, deviceScaleFactor: 1, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', javaScriptEnabled: true, serviceWorkers: 'block', acceptDownloads: false })}`);
  // 가로채기는 페이지가 아니라 컨텍스트 전체에 설치한다(새 창의 첫 요청까지 막음). 페이지를 만들기 전에 설치한다.
  expect(log).toContain('context.route');
  expect(log).not.toContain('page.route');
  expect(log.indexOf('context.route')).toBeLessThan(log.indexOf('goto http://baseline.invalid/prototype/uiux/Main.dc.html#wbs'));
  expect(log).toContain('context.routeWebSocket');
  expect(log).toContain('goto http://baseline.invalid/prototype/uiux/Main.dc.html#wbs');
  expect(log).toContain('fulfill http://baseline.invalid/prototype/uiux/app.css text/css body{}');
  expect(log).toContain('abort https://cdn.example.com/prototype/uiux/app.css');
  expect(log).toContain('abort http://baseline.invalid/src/secret.ts');
  expect(log).toContain(WAIT);
  expect(log.some(l => l.startsWith('style') && l.includes(BASELINE_RENDER.font))).toBe(true);
  expect(log).toContain(`evaluate ${JSON.stringify(BASELINE_RENDER.font)}`);
  expect(log.indexOf(WAIT)).toBeLessThan(log.findIndex(l => l.startsWith('shot')));
  expect(log).toContain(`shot ${JSON.stringify({ type: 'png', fullPage: false, animations: 'disabled', caret: 'hide' })}`);
  expect(log.at(-1)).toBe('close');
});

test('준비 선택자가 나타나지 않으면(라우트로 열 수 없는 화면) 렌더 실패다', async () => {
  const { log, chromium, request } = fakeChromium({ ready: false });
  await expect(createPlaywrightRenderer(chromium)(request)).rejects.toThrow('준비 선택자 [data-screen=wbs]');
  expect(log.some(l => l.startsWith('shot'))).toBe(false);
  expect(log.at(-1)).toBe('close');
});

test('고정 글꼴이 설치되어 있지 않으면 렌더 실패(비교 불가)다', async () => {
  const { log, chromium, request } = fakeChromium({ fontInstalled: false });
  await expect(createPlaywrightRenderer(chromium)(request)).rejects.toThrow('고정 글꼴 Noto Sans KR');
  expect(log.some(l => l.startsWith('shot'))).toBe(false);
});

test('준비 점검용 글꼴 확인은 fontconfig로 고정 글꼴 설치 여부를 본다', async () => {
  const calls: string[][] = [];
  const run = (stdout: string, code = 0) => async (cmd: string, args: readonly string[]) => { calls.push([cmd, ...args]); return { code, stdout, stderr: '' }; };
  expect(await checkBaselineFont(run('Noto Sans KR\n'))).toEqual({ status: 'ok', detail: '화면 비교 고정 글꼴 Noto Sans KR 설치됨' });
  expect(calls[0]).toEqual(['fc-list', ':family=Noto Sans KR', 'family']);
  expect(await checkBaselineFont(run(''))).toMatchObject({ status: 'warn', detail: expect.stringContaining('비교 불가') });
  expect(await checkBaselineFont(run('', 127))).toMatchObject({ status: 'warn' });
  expect(await checkBaselineFont(run('Noto Sans KR\n', 1))).toMatchObject({ status: 'warn' });
  expect(await checkBaselineFont(async () => { throw new Error('ENOENT'); })).toMatchObject({ status: 'warn' });
});

test('렌더러는 정의한 조작 단계를 순서대로 한 뒤 준비 선택자를 기다려 찍는다', async () => {
  const { log, chromium, request } = fakeChromium();
  const steps = [{ click: 'nav [data-nav=ci]' }, { waitFor: '.ci-tabs' }, { setViewport: { width: 390, height: 844 } }];
  expect(await createPlaywrightRenderer(chromium)({ ...request, route: '', steps })).toBe(red);
  const order = ['goto http://baseline.invalid/prototype/uiux/Main.dc.html', `click nav [data-nav=ci] ${JSON.stringify({ timeout: 10_000 })}`,
    `wait .ci-tabs ${JSON.stringify({ state: 'visible', timeout: 10_000 })}`, `viewport ${JSON.stringify({ width: 390, height: 844 })}`, WAIT];
  expect(order.map(line => log.indexOf(line))).toEqual([...order.map(line => log.indexOf(line))].sort((a, b) => a - b));
  expect(order.every(line => log.includes(line))).toBe(true);
  expect(log.indexOf(WAIT)).toBeLessThan(log.findIndex(l => l.startsWith('shot')));
});

test('조작 단계가 실패하면 렌더 실패(비교 불가)이고 찍지 않는다', async () => {
  const { log, chromium, request } = fakeChromium({ failClick: 'nav [data-nav=ci]' });
  await expect(createPlaywrightRenderer(chromium)({ ...request, route: '', steps: [{ click: 'nav [data-nav=ci]' }] })).rejects.toThrow('조작 단계 1(click nav [data-nav=ci])');
  expect(log.some(l => l.startsWith('shot'))).toBe(false);
  expect(log.at(-1)).toBe('close');
});

test('조작 단계는 기준 이미지 보관 키에 들어가 바뀌면 다시 렌더한다', async () => {
  const f = await ciFixture({ night: ['visual'] });
  try {
    await prototype(f, '<html>RED</html>', { wbs: { ...WBS, steps: [{ click: 'a' }] } });
    const r = renderer();
    shoot(f, red);
    await runNightCheck(night(f, r.render), '2026-11-27');
    expect(r.calls[0]?.steps).toEqual([{ click: 'a' }]);
    await prototype(f, '<html>RED</html>', { wbs: { ...WBS, steps: [{ click: 'b' }] } });
    await runNightCheck(night(f, r.render), '2026-11-28');
    expect(r.calls).toHaveLength(2);
  } finally { await f.close(); }
});

test('새 창은 첫 요청부터 컨텍스트 가로채기로 막고 바로 닫는다', async () => {
  const { log, chromium, request } = fakeChromium();
  await createPlaywrightRenderer(chromium)({ ...request, route: '', steps: [{ click: '#popup' }] });
  expect(log).toContain('abort popup');
  expect(log).not.toContain('fulfill popup');
  expect(log).toContain('popup closed');
});
