import { describe, expect, test } from 'vitest';
import { HeavySemaphore } from '../../src/resources/heavy.ts';

const tick = () => new Promise((r) => setImmediate(r));

describe('HeavySemaphore — 무거운 작업 상한(G §6.6, §9.6-2-2)', () => {
  test('상한까지 바로 받고, 넘으면 들어온 순서대로 기다린다', async () => {
    const s = new HeavySemaphore(2);
    const order: string[] = [];
    const a = await s.acquire('build');
    const b = await s.acquire('test');
    void s.acquire('e2e').then((r) => (order.push('e2e'), r));
    void s.acquire('install').then((r) => (order.push('install'), r));
    await tick();
    expect(s.snapshot()).toEqual({ capacity: 2, running: 2, waiting: 2 });
    a();
    await tick();
    expect(order).toEqual(['e2e']);
    b();
    await tick();
    expect(order).toEqual(['e2e', 'install']);
  });

  test('release를 두 번 불러도 한 번만 반환한다', async () => {
    const s = new HeavySemaphore(1);
    const r = await s.acquire('x');
    r();
    r();
    expect(s.snapshot().running).toBe(0);
    await s.acquire('y');
    let got = false;
    void s.acquire('z').then(() => (got = true));
    await tick();
    expect(got).toBe(false);
  });

  test('상한을 줄여도 실행 중인 것은 두고, 새로 받지 않는다', async () => {
    const s = new HeavySemaphore(3);
    const rs = await Promise.all([s.acquire('a'), s.acquire('b'), s.acquire('c')]);
    s.resize(1);
    let got = false;
    void s.acquire('d').then(() => (got = true));
    rs[0]?.();
    rs[1]?.();
    await tick();
    expect(got).toBe(false);
    rs[2]?.();
    await tick();
    expect(got).toBe(true);
  });

  test('상한을 늘리면 기다리던 것을 바로 깨운다', async () => {
    const s = new HeavySemaphore(1);
    await s.acquire('a');
    let got = false;
    void s.acquire('b').then(() => (got = true));
    s.resize(2);
    await tick();
    expect(got).toBe(true);
  });

  test('상한 0이면 모두 기다린다(HEAVY_ZERO)', async () => {
    const s = new HeavySemaphore(0);
    let got = false;
    void s.acquire('a').then(() => (got = true));
    await tick();
    expect(got).toBe(false);
    expect(s.snapshot().waiting).toBe(1);
  });

  test('기다리다 취소하면 대기열에서 빠지고 거부된다', async () => {
    const s = new HeavySemaphore(1);
    const r = await s.acquire('a');
    const ac = new AbortController();
    const waiting = s.acquire('b', ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow();
    expect(s.snapshot().waiting).toBe(0);
    r();
    expect(s.snapshot().running).toBe(0);
  });

  test('이미 취소된 신호면 바로 거부된다', async () => {
    const s = new HeavySemaphore(1);
    await expect(s.acquire('a', AbortSignal.abort())).rejects.toThrow();
    expect(s.snapshot().running).toBe(0);
  });

  test('음수·소수 상한은 거부한다', () => {
    expect(() => new HeavySemaphore(-1)).toThrow(RangeError);
    expect(() => new HeavySemaphore(1).resize(1.5)).toThrow(RangeError);
  });
});
