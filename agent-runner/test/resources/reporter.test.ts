import { describe, expect, test } from 'vitest';
import { ApiError, type ApiClient, type OperationId } from '../../src/api/client.ts';
import { LIMIT_REASON } from '../../src/resources/concurrency.ts';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { ResourceReporter, type SessionState } from '../../src/resources/reporter.ts';
import { UsageTracker } from '../../src/resources/usage.ts';

const MIN = 60_000;
const HOST = { hostId: 'pc-1', bootId: 'b', cpu: 'c', cores: 20, memGB: 23.46, swapGB: 4, diskFreeGB: 900, os: 'Linux' };
const caps = (total: number, extra: Partial<{ Claude: number; Codex: number; heavy: number }> = {}) => ({
  total,
  Claude: Math.ceil(total * 0.75),
  Codex: Math.ceil(total * 0.75),
  heavy: 6,
  ...extra,
});

interface Call {
  id: OperationId;
  request: Record<string, unknown> & { body?: Record<string, unknown> };
}

/** 계약 형식으로 답하는 가짜 WBS. handlers가 없는 호출은 시험 실패로 본다. */
function fakeApi(handlers: Partial<Record<OperationId, (req: Call['request']) => unknown>>) {
  const calls: Call[] = [];
  const api = ((id: OperationId, request: Call['request']) => {
    calls.push({ id, request });
    const h = handlers[id];
    if (!h) return Promise.reject(new Error(`예상하지 못한 호출 ${id}`));
    try {
      return Promise.resolve(h(request));
    } catch (e) {
      return Promise.reject(e as Error);
    }
  }) as unknown as ApiClient;
  return { api, calls };
}

const hostReply = (total: number, hostChanged = false) => () => ({
  status: 200,
  body: { mode: 'auto', caps: caps(total), recommended: caps(total), hostChanged },
});
const concReply = (total: number, memReserveGB = 4) => () => ({ status: 200, body: { caps: { ...caps(total), memReserveGB } } });

function setup(handlers: Parameters<typeof fakeApi>[0]) {
  let now = 0;
  const { api, calls } = fakeApi(handlers);
  const heavy = new HeavySemaphore(0);
  let n = 0;
  const r = new ResourceReporter({ api, epoch: () => 7, idempotencyKey: () => `k${String((n += 1))}`, now: () => now, heavy });
  return { r, calls, heavy, at: (t: number) => (now = t) };
}

const session = (over: Partial<SessionState> = {}): SessionState => ({ attemptId: 'a1', agent: 'Claude', observed: 0, reserved: 3, state: 'ok', ...over });
const flush = () => new Promise((r) => setImmediate(r));
const res = { cpuPct: 10, memFreeGB: 12, swapUsedGB: 0 };
/** 0분~toMin분 매 분 정상 자원을 관측한다(관측 주기 1분). */
const warm = (r: ResourceReporter, at: (t: number) => void, toMin: number, fromMin = 0) => {
  for (let m = fromMin; m <= toMin; m += 1) {
    at(m * MIN);
    r.observe(res);
  }
};

describe('ResourceReporter.reportHost', () => {
  test('사양을 보내고 받은 상한으로 한도 시작값·무거운 작업 상한을 정한다', async () => {
    const { r, calls, heavy } = setup({ reportHost: hostReply(16) });
    expect(await r.reportHost(HOST)).toEqual({ hostChanged: false });
    expect(calls[0]).toMatchObject({ id: 'reportHost', request: { body: HOST, epoch: 7, idempotencyKey: 'k1' } });
    expect(r.limit).toBe(6);
    expect(r.caps).toMatchObject({ total: 16, Claude: 12, heavy: 6 });
    expect(heavy.snapshot().capacity).toBe(6);
  });
});

describe('PC 변경', () => {
  test('hostChanged면 한도를 시작값으로 되돌리고 그 조절을 보고한다', async () => {
    let changed = false;
    const { r, calls, at } = setup({
      reportHost: () => ({ status: 200, body: { mode: 'auto', caps: caps(changed ? 49 : 16), recommended: caps(49), hostChanged: changed } }),
      reportConcurrency: concReply(49),
    });
    await r.reportHost(HOST);
    warm(r, at, 10);
    expect(r.limit).toBe(8);
    changed = true;
    expect(await r.reportHost({ ...HOST, hostId: 'pc-2' })).toEqual({ hostChanged: true });
    expect(r.limit).toBe(6);
    await r.reportConcurrency([], 0, res);
    const sent = calls.filter((c) => c.id === 'reportConcurrency').map((c) => c.request.body?.adjust);
    expect(sent).toEqual([
      { from: 6, to: 8, reason: LIMIT_REASON.stable },
      { from: 8, to: 6, reason: LIMIT_REASON.hostChanged },
    ]);
  });
});

describe('ResourceReporter.reportConcurrency', () => {
  test('세션·하위 Agent·무거운 작업·자원을 계약 형식으로 보낸다', async () => {
    const { r, calls } = setup({ reportHost: hostReply(16), reportConcurrency: concReply(16) });
    await r.reportHost(HOST);
    await r.reportConcurrency(
      [session(), session({ attemptId: 'a2', agent: 'Codex', observed: 4, reserved: 5, state: 'unconfirmed' }), session({ attemptId: 'a3' })],
      2,
      { cpuPct: 33.3, memFreeGB: 12, swapUsedGB: 0.5 },
      new Date('2026-11-26T09:00:00Z'),
    );
    expect(calls.at(-1)?.request.body).toEqual({
      at: '2026-11-26T09:00:00.000Z',
      limit: 6,
      running: { Claude: 2, Codex: 1 },
      subagents: 2 + 4 + 2,
      heavyJobs: 2,
      resources: { cpuPct: 33.3, memFreeGB: 12, swapGB: 0.5 },
      sessions: [
        { attemptId: 'a1', observed: 0, reserved: 3, state: 'ok' },
        { attemptId: 'a2', observed: 4, reserved: 5, state: 'unconfirmed' },
        { attemptId: 'a3', observed: 0, reserved: 3, state: 'ok' },
      ],
    });
  });

  test('응답의 상한·메모리 예비를 반영한다(상한이 낮아지면 한도를 내림)', async () => {
    const { r } = setup({ reportHost: hostReply(16), reportConcurrency: concReply(4, 6) });
    await r.reportHost(HOST);
    await r.reportConcurrency([], 0, res);
    expect(r.limit).toBe(4);
    expect(r.memReserveGB).toBe(6);
    // 예비 6GB보다 여유가 작으면 압박
    r.observe({ ...res, memFreeGB: 5.9 });
    expect(r.holdNew).toBe(true);
  });

  test('조절이 여러 번 쌓였으면 한 번에 하나씩 순서대로 보낸다', async () => {
    const { r, calls, at } = setup({ reportHost: hostReply(16), reportConcurrency: concReply(16) });
    await r.reportHost(HOST);
    warm(r, at, 10);
    at(11 * MIN);
    r.observe({ ...res, memFreeGB: 1 });
    await r.reportConcurrency([], 0, res);
    const sent = calls.filter((c) => c.id === 'reportConcurrency').map((c) => [c.request.body?.limit, c.request.body?.adjust]);
    expect(sent).toEqual([
      [8, { from: 6, to: 8, reason: LIMIT_REASON.stable }],
      [6, { from: 8, to: 6, reason: LIMIT_REASON.memory }],
    ]);
  });

  test('LIMIT_EXCEEDS_CAP이면 정책의 상한으로 한도를 내리고 다시 보낸다', async () => {
    let first = true;
    const { r, calls } = setup({
      reportHost: hostReply(16),
      reportConcurrency: (req) => {
        if (first) {
          first = false;
          throw new ApiError('reportConcurrency', 400, { code: 'LIMIT_EXCEEDS_CAP', message: 'x' } as never, null);
        }
        expect(req.body?.limit).toBe(3);
        return concReply(3)();
      },
      getRunnerPolicy: () => ({
        status: 200,
        body: { caps: { ...caps(3), memReserveGB: 4 }, subagentBudget: { dev: 2, qa: 1 }, heartbeatSeconds: 60, inputCheckMinutes: 5, ci: { nightAt: '02:00', retry: 1, deployUrl: null, quarantined: [] } },
        headers: new Headers(),
      }),
    });
    await r.reportHost(HOST);
    await r.reportConcurrency([], 0, res);
    expect(calls.map((c) => c.id)).toEqual(['reportHost', 'reportConcurrency', 'getRunnerPolicy', 'reportConcurrency']);
    expect(calls.at(-1)?.request.body?.adjust).toEqual({ from: 6, to: 3, reason: LIMIT_REASON.cap });
    expect(r.limit).toBe(3);
  });

  test('LIMIT_EXCEEDS_CAP 뒤에는 새 상한을 넘는 쌓인 조절 기록을 버린다', async () => {
    const sent: unknown[] = [];
    const { r, at } = setup({
      reportHost: hostReply(16),
      reportConcurrency: (req) => {
        const limit = req.body?.limit as number;
        if (limit > 3) throw new ApiError('reportConcurrency', 400, { code: 'LIMIT_EXCEEDS_CAP', message: 'x' } as never, null);
        sent.push(req.body?.adjust);
        return concReply(3)();
      },
      getRunnerPolicy: () => ({
        status: 200,
        body: { caps: { ...caps(3), memReserveGB: 4 }, subagentBudget: { dev: 2, qa: 1 }, heartbeatSeconds: 60, inputCheckMinutes: 5, ci: { nightAt: '02:00', retry: 1, deployUrl: null, quarantined: [] } },
        headers: new Headers(),
      }),
    });
    await r.reportHost(HOST);
    warm(r, at, 10);
    await r.reportConcurrency([], 0, res);
    expect(sent).toEqual([{ from: 8, to: 3, reason: LIMIT_REASON.cap }]);
  });

  test('다른 오류는 조절 기록을 잃지 않고 다시 던진다', async () => {
    let fail = true;
    const { r, calls, at } = setup({
      reportHost: hostReply(16),
      reportConcurrency: () => {
        if (fail) throw new ApiError('reportConcurrency', 503, undefined, null);
        return concReply(16)();
      },
    });
    await r.reportHost(HOST);
    warm(r, at, 10);
    await expect(r.reportConcurrency([], 0, res)).rejects.toThrow(ApiError);
    fail = false;
    await r.reportConcurrency([], 0, res);
    expect(calls.at(-1)?.request.body?.adjust).toEqual({ from: 6, to: 8, reason: LIMIT_REASON.stable });
  });

  test('상한을 받기 전에는 보고하지 않는다', async () => {
    const { r } = setup({});
    await expect(r.reportConcurrency([], 0, res)).rejects.toThrow(/host/);
  });
});

describe('canStart — 보고 중인 세션 기준 새 세션 판단', () => {
  test('보유 계산 합계·미확인 세션·Agent별 상한을 반영한다', async () => {
    const { r } = setup({ reportHost: hostReply(16) });
    expect(r.canStart('Claude', 3, [])).toEqual({ ok: false, reason: 'no_caps' });
    await r.reportHost(HOST);
    expect(r.canStart('Claude', 3, [session()])).toEqual({ ok: true });
    expect(r.canStart('Claude', 4, [session()])).toEqual({ ok: false, reason: 'limit' });
    expect(r.canStart('Codex', 1, [session({ state: 'unconfirmed' })])).toEqual({ ok: false, reason: 'unconfirmed_session' });
  });
});

describe('Agent API 결과 반영', () => {
  test('429 연속이면 한도를 줄이고 보고 대기열에 싣는다', async () => {
    const { r, calls } = setup({ reportHost: hostReply(16), reportConcurrency: concReply(16) });
    await r.reportHost(HOST);
    r.rateLimited();
    r.succeeded();
    r.rateLimited();
    expect(r.limit).toBe(6);
    r.rateLimited();
    expect(r.limit).toBe(3);
    await r.reportConcurrency([], 0, res);
    expect(calls.at(-1)?.request.body?.adjust).toMatchObject({ reason: LIMIT_REASON.rateLimit });
  });
});

describe('reportModels·reportUsage·reportReadiness', () => {
  test('모델 보고 응답의 신규 모델을 돌려준다', async () => {
    const { r, calls } = setup({ reportModels: () => ({ status: 200, body: { newModels: ['gpt-7'] } }) });
    expect(await r.reportModels({ agent: 'Codex', models: [{ id: 'gpt-7', label: 'GPT-7', efforts: null }] })).toEqual(['gpt-7']);
    expect(calls[0]?.request).toMatchObject({ epoch: 7, idempotencyKey: 'k1' });
  });

  test('사용량은 바뀐 Agent만 보내고, 실패한 것은 다음에 다시 보낸다', async () => {
    let fail = true;
    const { r, calls } = setup({
      reportUsage: (req) => {
        if (fail && req.body?.agent === 'Codex') throw new ApiError('reportUsage', 503, undefined, null);
        return { status: 204, body: undefined };
      },
    });
    const u = new UsageTracker();
    u.update('Claude', { remainPct: 50 });
    u.update('Codex', { remainPct: 10 });
    await expect(r.reportUsage(u)).rejects.toThrow(ApiError);
    fail = false;
    await r.reportUsage(u);
    expect(calls.map((c) => c.request.body?.agent)).toEqual(['Claude', 'Codex', 'Codex']);
  });

  test('준비 상태를 보내고 멈출 Agent를 돌려준다', async () => {
    const { r, calls } = setup({ reportReadiness: () => ({ status: 204, body: undefined }) });
    const report = { at: '2026-11-26T09:00:00.000Z', items: [{ key: 'codex' as const, status: 'fail' as const, detail: '로그인 안 됨', fix: '`codex login`' }] };
    expect(await r.reportReadiness(report)).toEqual(['Codex']);
    expect(r.blocked).toEqual(['Codex']);
    expect(calls[0]?.request.body).toEqual(report);
  });

  test('준비 상태 보고가 실패해도 로컬에서는 멈춘다(fail-closed)', async () => {
    const { r } = setup({ reportReadiness: () => { throw new ApiError('reportReadiness', 503, undefined, null); } });
    await expect(r.reportReadiness({ at: '2026-11-26T09:00:00.000Z', items: [{ key: 'git', status: 'fail', detail: '' }] })).rejects.toThrow();
    expect(r.blocked).toEqual(['Claude', 'Codex']);
  });
});

describe('리뷰 1 — 준비 점검 실패 Agent는 새 실행을 시작하지 않는다', () => {
  test('codex fail이면 Codex는 거절, Claude는 허용', async () => {
    const { r } = setup({ reportHost: hostReply(16), reportReadiness: () => ({ status: 204, body: undefined }) });
    await r.reportHost(HOST);
    await r.reportReadiness({ at: '2026-11-26T09:00:00.000Z', items: [{ key: 'codex', status: 'fail', detail: '' }] });
    expect(r.canStart('Codex', 1, [])).toEqual({ ok: false, reason: 'readiness_failed' });
    expect(r.canStart('Claude', 1, [])).toEqual({ ok: true });
  });

  test('공통 항목 fail이면 둘 다 거절, 다음 점검이 정상이면 다시 허용', async () => {
    const { r } = setup({ reportHost: hostReply(16), reportReadiness: () => ({ status: 204, body: undefined }) });
    await r.reportHost(HOST);
    await r.reportReadiness({ at: '2026-11-26T09:00:00.000Z', items: [{ key: 'git', status: 'fail', detail: '' }] });
    expect(r.canStart('Claude', 1, [])).toEqual({ ok: false, reason: 'readiness_failed' });
    expect(r.canStart('Codex', 1, [])).toEqual({ ok: false, reason: 'readiness_failed' });
    await r.reportReadiness({ at: '2026-11-27T09:00:00.000Z', items: [{ key: 'git', status: 'ok', detail: '' }] });
    expect(r.canStart('Claude', 1, [])).toEqual({ ok: true });
  });
});

describe('리뷰 3 — 동시 실행 보고가 겹쳐도 조절 기록이 중복·유실되지 않는다', () => {
  /** 응답을 시험이 직접 풀어 주는 가짜 서버 */
  function gated() {
    const sent: { adjust: unknown; settle: (ok: boolean) => void }[] = [];
    const handler = (req: Call['request']) =>
      new Promise((resolve, reject) => {
        sent.push({
          adjust: req.body?.adjust,
          settle: (ok) => (ok ? resolve(concReply(16)()) : reject(new ApiError('reportConcurrency', 503, undefined, null))),
        });
      });
    return { sent, handler };
  }

  test('두 호출이 겹쳐도 각 조절 기록은 한 번씩만 보낸다', async () => {
    const g = gated();
    const { r, at } = setup({ reportHost: hostReply(16), reportConcurrency: g.handler });
    await r.reportHost(HOST);
    warm(r, at, 10); // 6→8 대기
    const a = r.reportConcurrency([], 0, res);
    const b = r.reportConcurrency([], 0, res);
    await flush();
    at(11 * MIN);
    r.observe({ ...res, memFreeGB: 1 }); // 8→6 대기
    for (let i = 0; i < 10 && g.sent.some((s) => s.settle); i += 1) {
      const next = g.sent.find((s) => s.settle);
      if (!next) break;
      const settle = next.settle;
      next.settle = undefined as never;
      settle(true);
      await flush();
    }
    await Promise.all([a, b]);
    const adjusts = g.sent.map((s) => s.adjust).filter(Boolean);
    expect(adjusts).toEqual([
      { from: 6, to: 8, reason: LIMIT_REASON.stable },
      { from: 8, to: 6, reason: LIMIT_REASON.memory },
    ]);
  });

  test('겹친 호출 중 실패한 조절 기록은 사라지지 않고 다음 보고로 간다', async () => {
    const delivered: unknown[] = [];
    let failedOnce = false;
    const pending: (() => void)[] = [];
    const { r, at } = setup({
      reportHost: hostReply(16),
      reportConcurrency: (req) =>
        new Promise((resolve, reject) => {
          pending.push(() => {
            const adj = req.body?.adjust as { reason?: string } | undefined;
            if (adj?.reason === LIMIT_REASON.memory && !failedOnce) {
              failedOnce = true;
              reject(new ApiError('reportConcurrency', 503, undefined, null));
              return;
            }
            delivered.push(adj);
            resolve(concReply(16)());
          });
        }),
    });
    const drain = async () => {
      for (let i = 0; i < 20; i += 1) {
        await flush();
        const next = pending.shift();
        if (!next) return;
        next();
      }
    };
    await r.reportHost(HOST);
    warm(r, at, 10);
    const a = r.reportConcurrency([], 0, res).catch(() => 'a-failed');
    const b = r.reportConcurrency([], 0, res).catch(() => 'b-failed');
    await flush();
    at(11 * MIN);
    r.observe({ ...res, memFreeGB: 1 });
    await drain();
    await Promise.all([a, b]);
    const c = r.reportConcurrency([], 0, res);
    await drain();
    await c;
    expect(delivered.filter(Boolean)).toEqual([
      { from: 6, to: 8, reason: LIMIT_REASON.stable },
      { from: 8, to: 6, reason: LIMIT_REASON.memory },
    ]);
  });
});
