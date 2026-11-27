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

/**
 * 브라우저 손잡이 관리(Codex 재리뷰 3차 P2-1). 가짜 브라우저로 일정을 정확히 맞추거나 무작위로 섞는다.
 * 가짜 브라우저는 「살아 있음」을 스스로 기록한다(띄우기 성공 ~ kill 전). 실제 Chromium처럼 죽이면 연결 끊김 알림을 보낸다. 증명할 것:
 * - 모든 일이 끝나면 살아 있는 브라우저는 최대 1개이고, 그것은 지금 손잡이다(남는 브라우저 0).
 * - 닫으면 살아 있는 브라우저는 0개다.
 */
describe('브라우저 손잡이: 늦은 띄우기 결과·정리·연결 끊김이 겹쳐도', () => {
  const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
  const never = () => new Promise<never>(() => undefined);

  interface Fake { id: number; alive: boolean; hang: boolean; workMs: number; onDisconnect: (() => void)[] }
  /** 가짜 세계: 띄우기마다 계획(지연·실패·멈춤·작업 시간)을 정해 둔다. */
  function world(plan: (n: number) => { delayMs: number; fail: boolean; hang: boolean; workMs: number }) {
    const fakes: Fake[] = [];
    let n = 0;
    const launcher = async () => {
      // 기다리기 전에 ID를 고정한다(기다리는 사이 다른 띄우기가 n을 올려도 ID가 겹치지 않게, Codex 4차 P3).
      const id = ++n;
      const p = plan(id);
      await sleep(p.delayMs);
      if (p.fail) throw new Error('띄우기 실패');
      const f: Fake = { id, alive: true, hang: p.hang, workMs: p.workMs, onDisconnect: [] };
      fakes.push(f);
      const closed = () => { if (!f.alive) throw new Error('Browser closed'); };
      const gate = () => (f.hang ? never() : sleep(f.workMs));
      const browser = {
        on: (_: string, cb: () => void) => { f.onDisconnect.push(cb); },
        contexts: () => [],
        newContext: async () => {
          closed();
          const page = {
            emulateMedia: async () => undefined,
            goto: async () => { await gate(); closed(); },
            evaluate: async () => { closed(); return true; },
            pdf: async () => { closed(); return Buffer.from(`%PDF-${String(f.id)}`); },
          };
          return { setDefaultTimeout: () => undefined, route: async () => undefined, newPage: async () => page,
            close: async () => { if (f.hang && f.alive) await never(); } };
        },
      };
      // 실제 Chromium처럼, 죽이면 연결 끊김 알림이 온다.
      return { browser: browser as never, pid: f.id, kill: async () => { if (!f.alive) return; f.alive = false; await sleep(1); for (const cb of f.onDisconnect) cb(); } };
    };
    /** 밖에서 죽음(프로세스가 사라지고 연결 끊김 알림이 온다) */
    const crash = (f: Fake) => { f.alive = false; for (const cb of f.onDisconnect) cb(); };
    return { fakes, launcher, crash, alive: () => fakes.filter((f) => f.alive).map((f) => f.id), launched: () => n };
  }

  test('늦은 띄우기 실패: 포기한 첫 띄우기가 새 브라우저가 뜬 뒤 실패해도, 새 브라우저의 손잡이를 지우지 않는다', async () => {
    let failFirst: (e: Error) => void = () => undefined;
    const w = world(() => ({ delayMs: 0, fail: false, hang: false, workMs: 20 }));
    let calls = 0;
    const renderer = chromiumRenderer({
      timeoutMs: 100, cleanupMs: 50,
      launcher: () => (++calls === 1 ? new Promise((_, reject) => { failFirst = reject; }) : w.launcher()),
    });
    // 첫 띄우기가 멈춰 시간 초과 → 그 세대를 포기한다.
    await expect(renderer.render('A')).rejects.toThrow('PDF 변환 시간 초과');
    // 새 세대로 정상 변환
    expect((await renderer.render('B')).toString()).toMatch(/^%PDF-/);
    const pid = (await renderer.inspect()).pid;
    expect(pid).not.toBeNull();
    failFirst(new Error('늦은 실패'));
    await sleep(20);
    expect((await renderer.inspect()).pid).toBe(pid);
    await renderer.close();
    expect(w.alive()).toEqual([]);
  });

  test('늦은 띄우기 성공: 포기한 첫 브라우저가 늦게 뜨면 바로 죽이고, 새 브라우저의 손잡이는 그대로다', async () => {
    let resolveFirst: () => void = () => undefined;
    const w = world(() => ({ delayMs: 0, fail: false, hang: false, workMs: 20 }));
    let calls = 0;
    const renderer = chromiumRenderer({
      timeoutMs: 100, cleanupMs: 50,
      launcher: () => (++calls === 1 ? new Promise<void>((r) => { resolveFirst = r; }).then(() => w.launcher()) : w.launcher()),
    });
    await expect(renderer.render('A')).rejects.toThrow('PDF 변환 시간 초과');
    expect((await renderer.render('B')).toString()).toMatch(/^%PDF-/);
    const pid = (await renderer.inspect()).pid;
    resolveFirst();
    await sleep(20);
    // 늦게 뜬 첫 브라우저는 죽었고, 살아 있는 것은 손잡이 하나뿐이다.
    expect(w.alive()).toEqual([pid]);
    expect((await renderer.inspect()).pid).toBe(pid);
    await renderer.close();
    expect(w.alive()).toEqual([]);
  });

  test('같은 띄우기를 기다리던 다른 변환은, 그 띄우기가 포기된 뒤 늦게 성공해도 죽은 브라우저를 쓰지 않고 새로 띄워 성공한다', async () => {
    let release: () => void = () => undefined;
    const w = world(() => ({ delayMs: 0, fail: false, hang: false, workMs: 10 }));
    let calls = 0;
    const renderer = chromiumRenderer({
      timeoutMs: 300, cleanupMs: 50,
      launcher: () => (++calls === 1 ? new Promise<void>((r) => { release = r; }).then(() => w.launcher()) : w.launcher()),
    });
    // A(0ms)와 B(150ms)가 같은 첫 띄우기를 기다린다. A는 350ms에 그 세대를 포기한다.
    const a = renderer.render('A').catch((e: unknown) => (e as Error).message);
    await sleep(150);
    const b = renderer.render('B').then((x) => x.toString(), (e: unknown) => (e as Error).message);
    await sleep(220);
    // 370ms: 포기된 첫 띄우기가 늦게 성공한다. B(시간 한도 450ms)는 그것을 쓰지 않고 새 세대를 띄운다.
    release();
    expect(await a).toBe('PDF 변환 시간 초과');
    expect(await b).toMatch(/^%PDF-2$/);
    await renderer.close();
    expect(w.alive()).toEqual([]);
  });

  test('닫은 뒤에는 끝: 기다리던 늦은 띄우기가 완료돼도 새 브라우저를 띄우지 않고, 그 뒤 렌더는 바로 거부한다(Codex 4차 P2-1)', async () => {
    let release: () => void = () => undefined;
    const w = world(() => ({ delayMs: 0, fail: false, hang: false, workMs: 10 }));
    let calls = 0;
    const renderer = chromiumRenderer({
      timeoutMs: 100, cleanupMs: 30,
      launcher: () => { calls++; return calls === 1 ? new Promise<void>((r) => { release = r; }).then(() => w.launcher()) : w.launcher(); },
    });
    // 첫 띄우기를 기다리던 변환이 시간 초과로 끝난다(띄우기는 아직 진행 중).
    await expect(renderer.render('A')).rejects.toThrow('PDF 변환 시간 초과');
    await renderer.close();
    expect((await renderer.inspect()).pid).toBeNull();
    // 닫은 뒤 늦은 띄우기가 완료된다. 옛 세대는 죽고, 기다리던 쪽이 새 브라우저를 다시 띄우지 않는다.
    release();
    await sleep(100);
    expect(calls).toBe(1);
    expect(w.alive()).toEqual([]);
    // 닫은 뒤의 렌더는 띄우지 않고 바로 거부한다.
    await expect(renderer.render('B')).rejects.toThrow('PDF 변환기가 닫혔습니다');
    expect(calls).toBe(1);
    expect(w.alive()).toEqual([]);
  });

  test('닫는 순간 자리를 기다리던 렌더도 브라우저를 띄우지 않고 거부한다', async () => {
    const w = world(() => ({ delayMs: 0, fail: false, hang: true, workMs: 0 }));
    const renderer = chromiumRenderer({ timeoutMs: 100, cleanupMs: 30, launcher: w.launcher });
    // 자리 2개를 멈춘 변환이 차지하고, 셋째는 자리를 기다린다.
    const jobs = ['A', 'B', 'C'].map((x) => renderer.render(x).then(() => 'ok', (e: unknown) => (e as Error).message));
    await sleep(20);
    await renderer.close();
    const results = await Promise.all(jobs);
    expect(results[2]).toBe('PDF 변환기가 닫혔습니다');
    await sleep(50);
    expect(w.launched()).toBe(1);
    expect(w.alive()).toEqual([]);
  });

  test('무작위 일정 60가지(늦은 성공·늦은 실패·멈춤·정리 겹침·밖에서 죽음): 끝나면 살아 있는 브라우저는 손잡이 하나 이하, 닫으면 0', async () => {
    // 같은 결과를 다시 얻을 수 있게 씨앗을 고정한 의사 난수(mulberry32)
    const rng = (seed: number) => () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const failures: string[] = [];
    await Promise.all(Array.from({ length: 60 }, async (_, seed) => {
      const r = rng(seed + 1);
      // 띄우기 지연(0~250ms)이 시간 한도(80ms)+정리 한도(30ms)를 자주 넘게 해, 포기한 띄우기가 늦게 끝나는 일정을 많이 만든다.
      const w = world(() => ({ delayMs: Math.floor(r() * 250), fail: r() < 0.2, hang: r() < 0.3, workMs: Math.floor(r() * 60) }));
      const renderer = chromiumRenderer({ timeoutMs: 80, cleanupMs: 30, launcher: w.launcher });
      const jobs = Array.from({ length: 6 + Math.floor(r() * 5) }, async (_, i) => {
        await sleep(Math.floor(r() * 200));
        // 가끔 살아 있는 브라우저 하나를 밖에서 죽인다.
        if (r() < 0.2) { const victim = w.fakes.find((f) => f.alive); if (victim) w.crash(victim); }
        return renderer.render(`doc-${String(i)}`).then((b) => b.toString(), (e: unknown) => (e as Error).message);
      });
      const results = await Promise.all(jobs);
      // 늦은 띄우기가 모두 끝나도록 충분히 기다린다(최대 지연 250ms).
      await sleep(400);
      const odd = results.filter((x) => !/^%PDF-/.test(x) && !['PDF 변환 시간 초과', '띄우기 실패', 'Browser closed'].includes(x));
      const alive = w.alive();
      const pid = (await renderer.inspect()).pid;
      if (odd.length) failures.push(`seed ${String(seed)}: 뜻밖의 결과 ${odd.join(',')}`);
      if (alive.length > 1) failures.push(`seed ${String(seed)}: 살아 있는 브라우저 ${String(alive.length)}개 ${alive.join(',')}`);
      if (alive.length === 1 && alive[0] !== pid) failures.push(`seed ${String(seed)}: 살아 있는 브라우저(${String(alive[0])})가 손잡이(${String(pid)})가 아니다`);
      await renderer.close();
      await sleep(10);
      if (w.alive().length) failures.push(`seed ${String(seed)}: 닫은 뒤 남은 브라우저 ${w.alive().join(',')}`);
    }));
    expect(failures).toEqual([]);
  }, 30_000);
});
