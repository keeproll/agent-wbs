/**
 * PDF 변환기(apps/api/src/pdf/render.ts)의 자원 정리(Codex 리뷰 M6-02 P1).
 *
 * 멈춘 변환은 끝없이 도는 스크립트가 든 문서로 재현한다(실제 Chromium). 확인하는 것:
 * - 시간 초과면 그 변환을 강제로 멈춘다. 동시 실행 자리는 정리가 끝난 뒤에만 넘긴다(동시에 2개 넘게 열리지 않음).
 * - 동시 요청·연속 시간 초과 뒤 남은 작업 공간(context)·탭(page)·Chromium 렌더러 프로세스가 0개다.
 * - 브라우저 프로세스가 비정상(밖에서 죽음)이면 다음 변환이 새로 띄운다. 닫으면 Chromium 프로세스가 남지 않는다.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, test } from 'vitest';
import { chromiumRenderer } from '../src/pdf/render.ts';

const STUCK = '<!doctype html><html><body><script>for (;;) {}</script></body></html>';
const OK = '<!doctype html><html><head><meta charset="utf-8"><style>@font-face{font-family:t;src:url(/fonts/PretendardGOV-Regular.woff2)}body{font-family:t}</style></head><body>정상 문서</body></html>';

/** pid 아래의 모든 자손 프로세스(명령줄 포함) */
function descendants(pid: number): { pid: number; args: string }[] {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).trim().split('\n').map((line) => {
    const [p = '', pp = '', ...rest] = line.trim().split(/\s+/);
    return { pid: Number(p), ppid: Number(pp), args: rest.join(' ') };
  });
  const out: { pid: number; args: string }[] = [];
  const walk = (parent: number) => { for (const r of rows.filter((x) => x.ppid === parent)) { out.push(r); walk(r.pid); } };
  walk(pid);
  return out;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/**
 * 작업 공간이 0개가 될 때까지 최대 2초 기다린 뒤의 상태.
 * 왜: 브라우저 서버에 연결한 Playwright는 작업 공간을 닫은 응답 뒤에 「닫힘」 알림을 받아 목록에서 지운다.
 * 아주 바쁜 PC에서는 그 사이가 잠깐 벌어질 수 있다. 정말 남은 작업 공간이면 2초 뒤에도 남아 시험이 실패한다.
 */
async function settled(renderer: ReturnType<typeof chromiumRenderer>) {
  let now = await renderer.inspect();
  for (let i = 0; i < 40 && now.contexts + now.pages > 0; i++) { await new Promise((r) => setTimeout(r, 50)); now = await renderer.inspect(); }
  return now;
}
const renderers = (pid: number) => descendants(pid).filter((p) => p.args.includes('--type=renderer'));

describe('PDF 변환기 자원 정리', () => {
  const renderer = chromiumRenderer({ timeoutMs: 1_500, cleanupMs: 3_000 });
  afterAll(() => renderer.close());

  test('동시 요청 4개가 모두 시간 초과여도 동시에 2개만 열리고, 끝나면 작업 공간·탭·렌더러 프로세스가 0개다', async () => {
    let max = 0;
    let watching = true;
    const pids = new Set<number>();
    const watch = (async () => {
      while (watching) {
        const now = await renderer.inspect();
        if (now.pid) pids.add(now.pid);
        max = Math.max(max, now.contexts);
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => renderer.render(STUCK)));
    watching = false;
    await watch;
    expect(results.map((r) => (r.status === 'rejected' ? (r.reason as Error).message : 'ok'))).toEqual(Array(4).fill('PDF 변환 시간 초과'));
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(2);
    const after = await settled(renderer);
    expect(after).toMatchObject({ contexts: 0, pages: 0 });
    expect(after.pid).not.toBeNull();
    expect(renderers(after.pid ?? 0)).toEqual([]);
    // 작업 공간을 닫아 멈췄다(브라우저를 다시 띄워 치운 것이 아니다): 내내 같은 브라우저 프로세스다.
    expect([...pids]).toEqual([after.pid]);
  }, 30_000);

  test('시간 초과 뒤에 늦게 만들어진 작업 공간도 바로 닫는다(정리 한도까지 기다리거나 브라우저를 다시 띄우지 않는다)', async () => {
    const late = chromiumRenderer({ timeoutMs: 1, cleanupMs: 5_000 });
    try {
      await late.render(OK).catch(() => undefined); // 브라우저를 먼저 띄워 둔다
      const { pid } = await late.inspect();
      const started = Date.now();
      await expect(late.render(STUCK)).rejects.toThrow('PDF 변환 시간 초과');
      expect(Date.now() - started).toBeLessThan(4_000);
      const after = await settled(late);
      expect(after).toEqual({ pid, contexts: 0, pages: 0 });
      expect(renderers(pid ?? 0)).toEqual([]);
    } finally { await late.close(); }
  }, 30_000);

  test('연속 시간 초과 뒤에도 정상 변환을 하고, 남는 것이 없다', async () => {
    for (let i = 0; i < 3; i++) await expect(renderer.render(STUCK)).rejects.toThrow('PDF 변환 시간 초과');
    const pdf = await renderer.render(OK);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const after = await settled(renderer);
    expect(after).toMatchObject({ contexts: 0, pages: 0 });
    expect(renderers(after.pid ?? 0)).toEqual([]);
  }, 30_000);

  test('브라우저 프로세스가 밖에서 죽으면 다음 변환이 새로 띄운다', async () => {
    const before = (await renderer.inspect()).pid;
    expect(before).not.toBeNull();
    process.kill(before ?? 0, 'SIGKILL');
    for (let i = 0; i < 40 && alive(before ?? 0); i++) await new Promise((r) => setTimeout(r, 50));
    const pdf = await renderer.render(OK);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const after = (await renderer.inspect()).pid;
    expect(after).not.toBe(before);
  }, 30_000);

  test('정리도 멈출 만큼 브라우저가 멈추면(프로세스 정지) 정리 한도 뒤 브라우저를 다시 띄운다', async () => {
    await renderer.render(OK);
    const { pid } = await renderer.inspect();
    process.kill(pid ?? 0, 'SIGSTOP');
    try {
      await expect(renderer.render(OK)).rejects.toThrow('PDF 변환 시간 초과');
    } finally {
      if (alive(pid ?? 0)) process.kill(pid ?? 0, 'SIGCONT');
    }
    for (let i = 0; i < 40 && alive(pid ?? 0); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid ?? 0)).toBe(false);
    const pdf = await renderer.render(OK);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await renderer.inspect()).pid).not.toBe(pid);
  }, 30_000);

  test('닫으면 Chromium 프로세스가 남지 않는다', async () => {
    await renderer.render(OK);
    const { pid } = await renderer.inspect();
    expect(pid).not.toBeNull();
    const children = descendants(pid ?? 0).map((p) => p.pid);
    await renderer.close();
    for (let i = 0; i < 40 && [pid ?? 0, ...children].some(alive); i++) await new Promise((r) => setTimeout(r, 50));
    expect([pid ?? 0, ...children].filter(alive)).toEqual([]);
    expect(await renderer.inspect()).toEqual({ pid: null, contexts: 0, pages: 0 });
  }, 30_000);
});

/**
 * 늦은 정리와 브라우저 교체가 겹치는 경합(Codex 재리뷰 M6-02 P2-1).
 * 시각을 정확히 맞추려고 브라우저를 흉내 낸 가짜(launcher)를 쓴다. 변환기 코드는 실제와 같다.
 *
 * 순서(리뷰어 재현과 같다):
 * 1. A(0ms)와 B(150ms)가 브라우저 1에서 시작한다. 브라우저 1은 멈춰 있다(탭 작업·작업 공간 닫기가 끝나지 않는다).
 * 2. A의 시간 한도(400ms)와 정리 한도(100ms)가 지나 A가 브라우저 1을 죽인다(500ms).
 * 3. A가 돌려준 자리에서 C가 브라우저 2를 띄워 정상 변환을 한다(300ms 걸림, 500~800ms).
 * 4. C가 일하는 도중 B의 정리 한도가 뒤늦게 지난다(650ms). B는 자기 브라우저(1)만 죽여야 한다. 브라우저 2와 C는 건드리지 않는다.
 */
describe('늦은 정리와 브라우저 교체가 겹칠 때', () => {
  interface Fake { id: number; killed: boolean; hang: boolean; contexts: number }
  const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
  const never = () => new Promise<never>(() => undefined);

  function fakeBrowser(b: Fake, workMs: number) {
    const gate = () => (b.hang ? never() : sleep(workMs));
    return {
      on: () => undefined,
      contexts: () => Array.from({ length: b.contexts }, () => ({ pages: () => [] })),
      newContext: async () => {
        if (b.killed) throw new Error('Browser closed');
        b.contexts++;
        const page = {
          emulateMedia: async () => undefined,
          goto: async () => { await gate(); if (b.killed) throw new Error('Browser closed'); },
          evaluate: async () => { if (b.killed) throw new Error('Browser closed'); return true; },
          pdf: async () => { if (b.killed) throw new Error('Browser closed'); return Buffer.from('%PDF-fake'); },
        };
        return {
          setDefaultTimeout: () => undefined,
          route: async () => undefined,
          newPage: async () => page,
          // 멈춘 브라우저는 작업 공간 닫기도 끝나지 않는다(리뷰어가 늦춘 정리와 같다).
          close: async () => { if (b.hang) await never(); b.contexts--; },
        };
      },
    };
  }

  test('B의 늦은 정리는 자기 브라우저(1)만 닫고, 새 브라우저(2)의 C는 정상으로 끝난다', async () => {
    const browsers: Fake[] = [];
    const killed: number[] = [];
    const renderer = chromiumRenderer({
      timeoutMs: 400, cleanupMs: 100,
      launcher: async () => {
        const b: Fake = { id: browsers.length + 1, killed: false, hang: browsers.length === 0, contexts: 0 };
        browsers.push(b);
        return {
          browser: fakeBrowser(b, 300) as never,
          pid: 1000 + b.id,
          kill: async () => { b.killed = true; killed.push(b.id); },
        };
      },
    });
    const a = renderer.render('A').catch((e: unknown) => (e as Error).message);
    await sleep(150);
    const b = renderer.render('B').catch((e: unknown) => (e as Error).message);
    await sleep(5);
    const c = renderer.render('C').then((pdf) => pdf.toString(), (e: unknown) => (e as Error).message);
    expect(await a).toBe('PDF 변환 시간 초과');
    expect(await b).toBe('PDF 변환 시간 초과');
    expect(await c).toBe('%PDF-fake');
    // A와 B는 각자 쓴 브라우저 1만 닫았다(두 번 닫아도 같은 브라우저다). 브라우저 2는 닫히지 않았다.
    expect([...new Set(killed)]).toEqual([1]);
    expect(browsers.map((x) => x.id)).toEqual([1, 2]);
    expect((await renderer.inspect()).pid).toBe(1002);
    await renderer.close();
    expect(killed.at(-1)).toBe(2);
  }, 10_000);
});
