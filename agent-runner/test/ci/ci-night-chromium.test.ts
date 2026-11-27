// Codex 재리뷰(review2-codex.md) 지적 2를 실제 Chromium으로 확인한다.
// 렌더러는 기본 거부다: 허용 출처의 main 프로토타입 파일 외 모든 요청을 막고, 새 창·다운로드·서비스 워커·WebSocket도 막는다.
// Runner에는 아직 Playwright 의존성이 없다(M7-06). 이 PC의 agent-wbs 웹 앱에 설치된 Playwright를 쓴다. 없으면 건너뛴다.
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { BASELINE_RENDER, createPlaywrightRenderer, type ChromiumLike } from '../../src/ci/night/baseline.ts';

const PLAYWRIGHT = fileURLToPath(new URL('../../../agent-wbs/apps/web/node_modules/@playwright/test/index.mjs', import.meta.url));
const available = existsSync(PLAYWRIGHT);
let chromium: ChromiumLike;
let server: Server;
let port = 0;
const hits: string[] = [];

beforeAll(async () => {
  if (!available) return;
  chromium = (await import(PLAYWRIGHT) as { chromium: ChromiumLike }).chromium;
  server = createServer((req, res) => { hits.push(`http ${req.url ?? ''}`); res.end('external'); });
  server.on('upgrade', (req, socket) => { hits.push(`upgrade ${req.url ?? ''}`); socket.destroy(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  if (!available) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function render(html: string, steps: { click: string }[] = []) {
  const files: Record<string, string> = { 'prototype/uiux/index.html': html, 'prototype/uiux/sw.js': 'self.addEventListener("fetch", () => {});' };
  const fetched: string[] = [];
  try {
    await createPlaywrightRenderer(chromium)({ entry: 'prototype/uiux/index.html', route: '', ready: '#ready', steps, settings: BASELINE_RENDER,
      read: async path => { fetched.push(path); const v = files[path]; if (v === undefined) throw new Error('없음'); return Buffer.from(v); } });
    return { outcome: 'rendered', fetched };
  } catch (error) { return { outcome: error instanceof Error ? error.message : String(error), fetched }; }
}

test.skipIf(!available)('실제 Chromium: target=_blank 링크로 연 새 창도 허용 출처 밖에 접속하지 못한다', async () => {
  hits.length = 0;
  const result = await render(`<html><body><a id="popup" target="_blank" href="http://127.0.0.1:${String(port)}/popup">open</a><main id="ready">ready</main></body></html>`, [{ click: '#popup' }]);
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(hits).toEqual([]);
  // 이 PC에 고정 글꼴이 없으면 마지막에 비교 불가로 끝난다. 그 전에 바깥 요청이 없었는지가 핵심이다.
  expect(result.outcome === 'rendered' || result.outcome.includes('고정 글꼴')).toBe(true);
}, 60_000);

test.skipIf(!available)('실제 Chromium: 바깥 CSS·이미지·글꼴·fetch·WebSocket·window.open·다운로드·서비스 워커를 모두 막는다', async () => {
  hits.length = 0;
  const base = `http://127.0.0.1:${String(port)}`;
  const html = `<html><head>
    <link rel="stylesheet" href="${base}/style.css">
    <style>@font-face { font-family: Ext; src: url(${base}/font.woff2); } body { font-family: Ext; }</style>
  </head><body>
    <img src="${base}/img.png">
    <a id="dl" download href="${base}/file.zip">download</a>
    <main id="ready">ready</main>
    <script>
      fetch('${base}/fetch').catch(() => {});
      try { new WebSocket('ws://127.0.0.1:${String(port)}/ws'); } catch {}
      window.open('${base}/window-open');
      if (navigator.serviceWorker) navigator.serviceWorker.register('sw.js').catch(() => {});
    </script>
  </body></html>`;
  const result = await render(html, [{ click: '#dl' }]);
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(hits).toEqual([]);
  expect(result.fetched).toContain('prototype/uiux/index.html');
  expect(result.fetched).not.toContain('prototype/uiux/sw.js');
}, 60_000);
