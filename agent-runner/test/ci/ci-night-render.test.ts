// 조정자 결정 8: 화면 비교 기준 이미지는 main의 prototype/uiux HTML을 Runner 소유 렌더러가 직접 만든다.
import { lstat, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parsePipeline } from '../../src/ci/pipeline.ts';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { runNightCheck } from '../../src/ci/night/run.ts';
import { BASELINE_RENDER, createPlaywrightRenderer, type BaselineRenderer, type RenderRequest } from '../../src/ci/night/baseline.ts';
import { commit, definition, file, git } from './int-fixture.ts';
import { ciFixture } from './night-fixture.ts';
import { png } from './png.ts';

const NOW = Date.parse('2026-11-27T09:00:00Z');
type F = Awaited<ReturnType<typeof ciFixture>>;
const red = png(2, 2, () => [255, 0, 0, 255]);
const blue = png(2, 2, () => [0, 0, 255, 255]);
const night = (f: F, renderBaseline?: BaselineRenderer) => ({ repo: f.repo, heavy: new HeavySemaphore(1), execute: f.execute, report: f.report, home: f.home,
  quarantined: new Set<string>(), retry: 1, now: () => NOW, ...(renderBaseline && { renderBaseline }) });

async function prototype(f: F, html: string, screens: Record<string, string> = { wbs: 'prototype/uiux/Main.dc.html#wbs' }) {
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

test('정의의 screens는 prototype/uiux 아래 HTML(선택적으로 #화면)만 받는다', () => {
  const night = (screens: unknown) => JSON.stringify({ ...definition, stages: { ...definition.stages, night: [{ name: 'visual', argv: ['x'], screens }] } });
  expect(parsePipeline(night({ wbs: 'prototype/uiux/Main.dc.html#wbs' })).stages.night[0]?.screens).toEqual({ wbs: 'prototype/uiux/Main.dc.html#wbs' });
  expect(parsePipeline(night({ home: 'prototype/uiux/Main.dc.html' })).stages.night[0]?.screens).toEqual({ home: 'prototype/uiux/Main.dc.html' });
  for (const bad of ['prototype/uiux/shots/wbs.png', 'src/index.html', 'prototype/uiux/../x.html', 'prototype/uiux/x.html?y=1', 'prototype/uiux/x.html#']) {
    expect(() => parsePipeline(night({ wbs: bad }))).toThrow();
  }
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
    expect(r.calls[0]).toMatchObject({ entry: 'prototype/uiux/Main.dc.html', fragment: '#wbs', settings: BASELINE_RENDER });
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

test('Playwright 렌더러는 main 파일만 내보내고 밖으로 나가는 요청은 막으며 고정 설정으로 찍는다', async () => {
  const log: string[] = [];
  const files: Record<string, string> = { 'prototype/uiux/Main.dc.html': '<html></html>', 'prototype/uiux/app.css': 'body{}' };
  type Handler = (route: { request: () => { url: () => string }; fulfill: (r: { status: number; body: Buffer; contentType: string }) => Promise<void>; abort: () => Promise<void> }) => Promise<void>;
  let handler: Handler | undefined;
  const page = {
    route: async (_: string, h: Handler) => { handler = h; },
    goto: async (url: string) => {
      log.push(`goto ${url}`);
      for (const u of ['http://baseline.invalid/prototype/uiux/app.css', 'https://cdn.example.com/prototype/uiux/app.css', 'http://baseline.invalid/src/secret.ts']) {
        await handler?.({ request: () => ({ url: () => u }),
          fulfill: async r => { log.push(`fulfill ${u} ${r.contentType} ${r.body.toString()}`); },
          abort: async () => { log.push(`abort ${u}`); } });
      }
    },
    addStyleTag: async ({ content }: { content: string }) => { log.push(`style ${content}`); },
    evaluate: async () => undefined,
    screenshot: async (o: Record<string, unknown>) => { log.push(`shot ${JSON.stringify(o)}`); return red; },
  };
  const chromium = { launch: async () => ({
    newContext: async (o: Record<string, unknown>) => { log.push(`context ${JSON.stringify(o)}`); return { newPage: async () => page, close: async () => undefined }; },
    close: async () => { log.push('close'); },
  }) };
  const render = createPlaywrightRenderer(chromium);
  const image = await render({ entry: 'prototype/uiux/Main.dc.html', fragment: '#wbs', settings: BASELINE_RENDER,
    // 렌더러 스스로도 경로를 거른다. read가 무엇이든 내주더라도 prototype/uiux 밖은 막아야 한다.
    read: async path => Buffer.from(files[path] ?? `leaked ${path}`) });
  expect(image).toBe(red);
  expect(log).toContain(`context ${JSON.stringify({ viewport: BASELINE_RENDER.viewport, deviceScaleFactor: 1, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', javaScriptEnabled: true })}`);
  expect(log).toContain('goto http://baseline.invalid/prototype/uiux/Main.dc.html#wbs');
  expect(log).toContain('fulfill http://baseline.invalid/prototype/uiux/app.css text/css body{}');
  expect(log).toContain('abort https://cdn.example.com/prototype/uiux/app.css');
  expect(log).toContain('abort http://baseline.invalid/src/secret.ts');
  expect(log.some(l => l.startsWith('style') && l.includes(BASELINE_RENDER.font))).toBe(true);
  expect(log).toContain(`shot ${JSON.stringify({ type: 'png', fullPage: false, animations: 'disabled', caret: 'hide' })}`);
  expect(log.at(-1)).toBe('close');
});
