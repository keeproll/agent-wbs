// 3차 리뷰(review3-codex.md) 지적 1과 조정자 지시: 렌더러 브라우저는 네트워크가 없는 상태로 띄운다.
// 실제 Chromium으로 페이지·Worker·SharedWorker의 WebSocket, WebRTC, fetch keepalive, EventSource, sendBeacon,
// 새 창, 외부 CSS·이미지·글꼴이 모두 바깥에 닿지 않는지 확인한다.
// 대조 시험: 같은 HTML을 보호 없이 띄우면 실제로 접속이 기록된다(시험 장치가 누출을 잡는다는 증거).
// Runner에는 아직 Playwright 의존성이 없다(M7-06). 이 PC의 agent-wbs 웹 앱에 설치된 Playwright를 쓴다. 없으면 건너뛴다.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createSocket, type Socket } from 'node:dgram';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { BASELINE_RENDER, createPlaywrightRenderer, detectNetworkIsolation, prepareLaunch, type ChromiumLike, type NetworkIsolation } from '../../src/ci/night/baseline.ts';

const PLAYWRIGHT = fileURLToPath(new URL('../../../agent-wbs/apps/web/node_modules/@playwright/test/index.mjs', import.meta.url));
const available = existsSync(PLAYWRIGHT);
let chromium: ChromiumLike & { launch(options?: Record<string, unknown>): Promise<{ newPage(): Promise<{ goto(url: string): Promise<unknown> }>; close(): Promise<void> }> };
let server: Server; let udp: Socket;
let port = 0; let udpPort = 0;
let work = '';
let namespaceMode: NetworkIsolation = 'proxy';
const hits: string[] = [];

beforeAll(async () => {
  if (!available) return;
  chromium = (await import(PLAYWRIGHT) as { chromium: typeof chromium }).chromium;
  work = await mkdtemp(join(tmpdir(), 'awbs-render-'));
  namespaceMode = await detectNetworkIsolation();
  server = createServer((req, res) => { hits.push(`tcp ${req.method ?? ''} ${req.url ?? ''}`); res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }); res.end('data: x\n\n'); });
  server.on('upgrade', (req, socket) => { hits.push(`upgrade ${req.url ?? ''}`); socket.destroy(); });
  server.on('connect', (req, socket) => { hits.push(`connect ${req.url ?? ''}`); socket.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  port = (server.address() as { port: number }).port;
  udp = createSocket('udp4'); udp.on('message', () => hits.push('udp'));
  udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
  udpPort = udp.address().port;
});
afterAll(async () => {
  if (!available) return;
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  udp.close(); await rm(work, { recursive: true, force: true });
});

/** 리뷰어 재현과 추가 경로를 모두 담은 프로토타입. 1.5초 뒤 #done을 그려 접속 시도가 끝날 시간을 준다. */
const html = () => {
  const http = `http://127.0.0.1:${String(port)}`; const ws = `ws://127.0.0.1:${String(port)}`;
  const worker = `new WebSocket('${ws}/worker-ws'); fetch('${http}/worker-fetch').catch(()=>{});`;
  return `<html><head>
  <link rel="stylesheet" href="${http}/style.css">
  <style>@font-face { font-family: Ext; src: url(${http}/font.woff2); } body { font-family: Ext; }</style>
</head><body>
  <img src="${http}/img.png">
  <a id="popup" target="_blank" href="${http}/popup">open</a>
  <main id="ready">ready</main>
  <script>
    const run = (code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try { new WebSocket('${ws}/page-ws'); } catch {}
    try { new Worker(run(${JSON.stringify(worker)})); } catch {}
    try { new SharedWorker(run(${JSON.stringify(`onconnect = () => {}; ${worker.replaceAll('worker-', 'shared-')}`)})); } catch {}
    try { fetch('${http}/keepalive', { method: 'POST', body: 'x', keepalive: true }).catch(()=>{}); } catch {}
    try { new EventSource('${http}/events'); } catch {}
    try { navigator.sendBeacon('${http}/beacon', 'x'); } catch {}
    try { window.open('${http}/window-open'); } catch {}
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${String(udpPort)}' }, { urls: 'turn:127.0.0.1:${String(port)}?transport=tcp', username: 'u', credential: 'c' }] });
      pc.createDataChannel('x'); pc.createOffer().then(o => pc.setLocalDescription(o)).catch(()=>{});
    } catch {}
    setTimeout(() => { const d = document.createElement('div'); d.id = 'done'; d.textContent = 'done'; document.body.append(d); }, 1500);
  </script>
</body></html>`;
};

async function render(isolation: NetworkIsolation) {
  hits.length = 0;
  const files: Record<string, string> = { 'prototype/uiux/index.html': html() };
  let outcome = 'rendered';
  try {
    await createPlaywrightRenderer(chromium, { isolation, workDir: work })({ entry: 'prototype/uiux/index.html', route: '', ready: '#ready',
      steps: [{ click: '#popup' }, { waitFor: '#done' }], settings: BASELINE_RENDER,
      files: async () => Object.keys(files), read: async path => { const v = files[path]; if (v === undefined) throw new Error('없음'); return Buffer.from(v); } });
  } catch (error) { outcome = error instanceof Error ? error.message : String(error); }
  await new Promise(resolve => setTimeout(resolve, 500));
  return outcome;
}

/** 렌더러 없이 브라우저만 주어진 실행 설정으로 띄워 같은 프로토타입을 연다. 가로채기 등 2차 방어가 없는 상태로 한 계층만 본다. */
async function openWith(options: { args?: string[]; executablePath?: string }) {
  hits.length = 0;
  const dir = join(work, `layer-${String(Date.now())}-${String(Math.random()).slice(2)}`);
  await mkdir(dir);
  const page = join(dir, 'control.html'); await writeFile(page, html());
  const browser = await chromium.launch(options);
  try {
    await (await browser.newPage()).goto(pathToFileURL(page).href);
    await new Promise(resolve => setTimeout(resolve, 2500));
  } finally { await browser.close(); }
  await new Promise(resolve => setTimeout(resolve, 300));
  return dir;
}

test.skipIf(!available)('대조: 보호 없이 띄운 Chromium에서는 같은 프로토타입이 실제로 바깥에 접속한다(시험 장치 확인)', async () => {
  await openWith({});
  expect(hits.some(h => h.includes('worker-ws'))).toBe(true);
  // blob SharedWorker는 file:// 문서(불투명 출처)에서 시작되지 않는다. 렌더러도 file://로 열므로 같은 이유로 막힌다. 페이지에는 그대로 둔다.
  expect(hits.some(h => h.includes('worker-fetch'))).toBe(true);
  expect(hits.filter(h => h === 'udp').length).toBeGreaterThan(0);
  expect(hits.some(h => h.includes('page-ws'))).toBe(true);
  expect(hits.some(h => h.includes('keepalive') || h.includes('events') || h.includes('beacon'))).toBe(true);
}, 60_000);

test.skipIf(!available || process.env.AWBS_NO_NETNS === '1')('계층 1만: 네트워크 네임스페이스 래퍼만으로(차단 인자·가로채기 없이) 접속 0건', async () => {
  const dir = join(work, `wrap-${String(Date.now())}`); await mkdir(dir);
  const { executablePath } = await prepareLaunch('namespace', chromium, dir);
  expect(executablePath).toBeDefined();
  await openWith({ args: [], ...(executablePath && { executablePath }) });
  expect(hits).toEqual([]);
}, 60_000);

test.skipIf(!available)('계층 2만: 차단 인자만으로(네임스페이스·가로채기 없이) 접속 0건', async () => {
  const dir = join(work, `args-${String(Date.now())}`); await mkdir(dir);
  const { args, executablePath } = await prepareLaunch('proxy', chromium, dir);
  expect(executablePath).toBeUndefined();
  await openWith({ args });
  expect(hits).toEqual([]);
}, 60_000);

// 차단 인자 안에도 서로 독립인 두 겹이 있다. 각각만으로도 막히는지 따로 본다(한 인자가 빠져도 다른 겹이 가려 주는 것을 구분).
const WEBRTC = (arg: string) => arg.includes('webrtc-ip-handling-policy');
test.skipIf(!available)('계층 2a만: 죽은 프록시·loopback 우회 해제(+WebRTC UDP 차단)만으로 접속 0건', async () => {
  const { args } = await prepareLaunch('proxy', chromium, work);
  await openWith({ args: args.filter(arg => arg.startsWith('--proxy-') || WEBRTC(arg)) });
  expect(hits).toEqual([]);
}, 60_000);

test.skipIf(!available)('계층 2b만: localhost 포함 모든 이름 해석 차단(+WebRTC UDP 차단)만으로 접속 0건', async () => {
  const { args } = await prepareLaunch('proxy', chromium, work);
  await openWith({ args: args.filter(arg => arg.startsWith('--host-resolver-rules') || WEBRTC(arg)) });
  expect(hits).toEqual([]);
}, 60_000);

test.skipIf(!available)('이 PC에서 사용자 네트워크 네임스페이스로 렌더러를 띄울 수 있다', () => {
  expect(namespaceMode).toBe('namespace');
});

test.skipIf(!available)('네트워크 네임스페이스 렌더러: Worker·SharedWorker·WebSocket·WebRTC·keepalive·EventSource·beacon·새 창·외부 리소스 모두 접속 0건', async () => {
  const outcome = await render('namespace');
  expect(hits).toEqual([]);
  // 이 PC에는 고정 글꼴이 없어 마지막에 비교 불가로 끝난다. 그 전의 조작(click·waitFor)까지는 끝까지 실행됐다.
  expect(outcome === 'rendered' || outcome.includes('고정 글꼴')).toBe(true);
}, 90_000);

test.skipIf(!available)('네임스페이스가 없을 때의 대체(죽은 프록시·loopback 포함 이름 해석 차단·WebRTC UDP 차단)도 접속 0건', async () => {
  const outcome = await render('proxy');
  expect(hits).toEqual([]);
  expect(outcome === 'rendered' || outcome.includes('고정 글꼴')).toBe(true);
}, 90_000);

test.skipIf(!available)('리뷰어 방식: 관측용 프록시를 브라우저에 끼워 넣어도 네임스페이스 안의 Worker·페이지 WebSocket은 프록시에 닿지 않는다', async () => {
  hits.length = 0;
  // 리뷰어는 브라우저 프록시를 관측 수신기로 바꿔 Worker WebSocket이 차단기를 우회하는 것을 보였다(이전 렌더러: CONNECT worker-public.invalid:80).
  // 같은 방식으로 띄워도 네임스페이스 안에서는 이 PC의 수신기에 접근할 길이 없다.
  const observed = {
    executablePath: () => chromium.executablePath(),
    launch: (options: { args: string[]; executablePath?: string }) => chromium.launch({ ...options, proxy: { server: `http://127.0.0.1:${String(port)}` } }),
  } as unknown as ChromiumLike;
  const worker = `new WebSocket('ws://worker-public.invalid/socket');`;
  const page = `<html><body><main id="ready">r</main><script>
    new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}], { type: 'text/javascript' })));
    try { new WebSocket('ws://page-public.invalid/socket'); } catch {}
    setTimeout(() => { const d = document.createElement('div'); d.id = 'done'; d.textContent = 'd'; document.body.append(d); }, 1500);
  </script></body></html>`;
  try {
    await createPlaywrightRenderer(observed, { isolation: 'namespace', workDir: work })({ entry: 'prototype/uiux/index.html', route: '', ready: '#ready',
      steps: [{ waitFor: '#done' }], settings: BASELINE_RENDER, files: async () => ['prototype/uiux/index.html'], read: async () => Buffer.from(page) });
  } catch { /* 고정 글꼴이 없으면 비교 불가로 끝난다. */ }
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(hits).toEqual([]);
}, 90_000);
