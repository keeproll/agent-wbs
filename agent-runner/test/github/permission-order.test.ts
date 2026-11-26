import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, test } from 'vitest';
import { createGitHubClient, type ConnectionStatus, type PermissionState } from '../../src/github/client.ts';
import { CredentialError } from '../../src/github/credential.ts';
import { Secret } from '../../src/security/secret.ts';
import { protectedMainResponse } from '../fakes/github/rules.ts';

/**
 * 무작위 사건 순서 속성 테스트.
 *
 * 연결 확인 시작, status 쓰기 시작, 토큰 교체, 토큰 취득 실패 모드, 토큰 취득 완료(늦게 끝나는 취득 포함), 응답 도착을
 * 무작위 순서로 섞고,
 * 어떤 순서에서도 아래 규칙(README 「권한 상태 갱신 규칙」)이 지켜지는지 본다.
 *
 * 토큰 A: status 쓰기 201(→ 확인됨), 토큰 B: status 쓰기 403(→ 부족). 둘 다 push 가능한 fine-grained 계정이라
 * 연결 확인 snapshot의 statuses는 항상 「미확인」이다. 그래서 최종 값만 봐도 무엇이 이겼는지 구별된다.
 *
 * 용어
 * - 시각(clock): 사건마다 1씩 오르는 번호.
 * - 토큰 관측 시각(Ts): 마지막으로 「직전 요청과 다른 토큰」으로 요청을 보낸 시각. 클라이언트는 요청을 보낼 때에야 토큰이 바뀐 것을 안다.
 * - 마지막 확인 시작 시각(Tc).
 * - 최신 쓰기(W): max(Ts, Tc) 뒤에 보낸 status 쓰기 중 응답까지 받은 것.
 */
type Tok = 'A' | 'B';
interface Pending {
  op: number;
  method: string;
  path: string;
  token: Tok;
  clock: number;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}
interface Op {
  id: number;
  kind: 'check' | 'write';
  start: number;
  sends: { clock: number; token: Tok }[];
  tokenFailed: boolean;
  done: boolean;
  result?: ConnectionStatus | 'ok' | 'error';
  completedAt?: number;
}

/** 재현 가능한 의사 난수(mulberry32). 실패하면 seed로 같은 순서를 다시 돌릴 수 있다. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function runScenario(seed: number) {
  const random = rng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const als = new AsyncLocalStorage<number>();
  let clock = 0;
  let selected: Tok = 'A';
  let tokenFails = false;
  const pending: Pending[] = [];
  // 토큰 취득도 바로 끝나지 않는다. 끝나는 순서를 무작위로 고르고, 값은 끝나는 순간의 토큰(gh가 그 순간 로그인된 계정을 주듯이)이다.
  const pendingTokens: { op: number; resolve: (secret: Secret) => void; reject: (error: unknown) => void }[] = [];
  const ops: Op[] = [];
  const promises: Promise<unknown>[] = [];
  const notices: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  const client = createGitHubClient({
    repo: { owner: 'o', repo: 'r' },
    token: () =>
      new Promise<Secret>((resolve, reject) => {
        pendingTokens.push({ op: als.getStore() ?? -1, resolve, reject });
      }),
    onPermissionDenied: (event) => {
      notices.push(event.permission);
    },
    fetch: (input, init) => {
      const id = als.getStore() ?? -1;
      const op = ops[id];
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      const token: Tok = auth.includes('token-B') ? 'B' : 'A';
      clock += 1;
      op?.sends.push({ clock, token });
      return new Promise<Response>((resolve, reject) => {
        pending.push({
          op: id,
          method: init?.method ?? 'GET',
          path: new URL(String(input)).pathname,
          token,
          clock,
          resolve,
          reject,
        });
      });
    },
  });

  const respond = (p: Pending): void => {
    const protection = protectedMainResponse(p.path);
    if (protection) { p.resolve(protection); return; }
    if (p.path === '/user') {
      p.resolve(Response.json({ login: `user-${p.token}` }));
    } else if (p.method === 'GET') {
      p.resolve(Response.json({ permissions: { admin: false, push: true, pull: true } }));
    } else if (p.token === 'A') {
      p.resolve(Response.json({}, { status: 201 }));
    } else {
      p.resolve(
        Response.json(
          { message: 'Resource not accessible by personal access token' },
          { status: 403, headers: { 'x-accepted-github-permissions': 'statuses=write' } },
        ),
      );
    }
  };

  /** 대기 중인 토큰 취득 하나를 끝낸다. 그 순간 실패 모드면 실패, 아니면 그 순간 선택된 토큰을 준다. */
  const finishToken = (index: number): void => {
    const [waiting] = pendingTokens.splice(index, 1);
    if (!waiting) return;
    clock += 1;
    if (tokenFails) {
      const op = ops[waiting.op];
      if (op) op.tokenFailed = true;
      waiting.reject(new CredentialError('gh 로그인 토큰을 읽지 못했습니다.'));
    } else {
      waiting.resolve(new Secret(`token-${selected}-0123456789abcdef`));
    }
  };

  const startOp = (kind: Op['kind']) => {
    const op: Op = { id: ops.length, kind, start: (clock += 1), sends: [], tokenFailed: false, done: false };
    ops.push(op);
    const promise = als.run(op.id, () =>
      kind === 'check'
        ? client.checkConnection('token').then((result) => {
            op.result = result;
          })
        : client.setCommitStatus({ sha: 'a'.repeat(40), context: 'agentwbs/task', state: 'pending' }).then(
            () => {
              op.result = 'ok';
            },
            () => {
              op.result = 'error';
            },
          ),
    );
    promises.push(
      promise.finally(() => {
        op.done = true;
        op.completedAt = clock += 1;
      }),
    );
  };

  // 사건: 연결 확인 시작, 쓰기 시작, 토큰 교체, 토큰 취득 실패 모드 전환,
  // 토큰 취득 완료(대기 중인 것 중 아무거나 — 늦게 끝나는 취득이 생긴다), 응답 도착(대기 중인 것 중 아무거나).
  const steps = 6 + Math.floor(random() * 16);
  for (let i = 0; i < steps; i += 1) {
    const action = pick(['check', 'write', 'write', 'switch', 'fail', 'token', 'token', 'respond', 'respond', 'respond'] as const);
    if (action === 'check' || action === 'write') startOp(action);
    else if (action === 'switch') selected = selected === 'A' ? 'B' : 'A';
    else if (action === 'fail') tokenFails = !tokenFails;
    else if (action === 'token' && pendingTokens.length > 0) finishToken(Math.floor(random() * pendingTokens.length));
    else if (action === 'respond' && pending.length > 0) {
      respond(pending.splice(Math.floor(random() * pending.length), 1)[0] as Pending);
    }
    await flush();
  }
  tokenFails = false;
  while (ops.some((op) => !op.done)) {
    const total = pendingTokens.length + pending.length;
    const index = Math.floor(random() * total);
    if (index < pendingTokens.length) finishToken(index);
    else if (pending.length > 0) respond(pending.splice(index - pendingTokens.length, 1)[0] as Pending);
    await flush();
  }
  await Promise.all(promises);
  await flush();
  process.off('unhandledRejection', onUnhandled);
  return { client, ops, notices, unhandled };
}

/** 위 용어대로 기대값을 계산한다. 구현과 다른 방식(사건 기록만 보고)으로 계산해 서로 대조한다. */
function expectations(ops: Op[]) {
  const sends = ops.flatMap((op) => op.sends).sort((a, b) => a.clock - b.clock);
  // 각 시각까지 마지막으로 토큰이 바뀐 것을 관측한 시각
  const observations: number[] = [];
  for (let i = 1; i < sends.length; i += 1) {
    if (sends[i]?.token !== sends[i - 1]?.token) observations.push(sends[i]?.clock ?? -1);
  }
  const tsAt = (time: number) => observations.filter((clock) => clock <= time).at(-1) ?? -1;
  const ts = observations.at(-1) ?? -1;
  const checks = ops.filter((op) => op.kind === 'check');
  const lastCheck = checks.at(-1);
  const tc = lastCheck?.start ?? -1;
  // 토큰이 바뀐 것을 처음 관측한 요청은 새 세대에 속하므로 >= ts.
  const latestWrites = ops
    .filter((op) => {
      const sent = op.sends[0]?.clock ?? -1;
      return op.kind === 'write' && op.sends.length > 0 && sent >= ts && sent > tc;
    })
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  // 마지막 확인이 유효하려면, 끝난 시점 기준으로 그 확인의 요청이 모두 최신 토큰 관측 이후(같은 세대)여야 한다.
  const lastCheckValid =
    lastCheck !== undefined && lastCheck.sends.every((send) => send.clock >= tsAt(lastCheck.completedAt ?? Infinity));
  return { ts, lastCheck, lastCheckValid, latestWrites };
}

describe('권한 상태 — 무작위 사건 순서 속성 테스트', () => {
  const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);

  test.each(SEEDS)('seed %i', async (seed) => {
    const { client, ops, notices, unhandled } = await runScenario(seed);
    const { lastCheck, lastCheckValid, latestWrites } = expectations(ops);
    const statuses: PermissionState = client.permissions().statuses;
    if (process.env.DBG) console.log(JSON.stringify({ seed, ops: ops.map(({ id, kind, start, sends, tokenFailed, completedAt, result }) => ({ id, kind, start, sends, tokenFailed, completedAt, result })), statuses, exp: expectations(ops) }, null, 1));

    // 1) 알림 실패·경합으로 처리되지 않은 거부가 없다.
    expect(unhandled).toEqual([]);
    // 2) 알림은 토큰 B의 쓰기에서만, B 쓰기 수를 넘지 않는다.
    const bWrites = ops.filter((op) => op.kind === 'write' && op.sends.some((send) => send.token === 'B')).length;
    expect(notices.every((n) => n === 'statuses')).toBe(true);
    expect(notices.length).toBeLessThanOrEqual(bWrites);

    const lastWrite = latestWrites.at(-1);
    if (lastWrite) {
      // 3) 가장 최신 세대의 실제 쓰기 결과가 이긴다(옛 응답·연결 확인 snapshot이 덮지 못한다: R9·R11·R13).
      expect(statuses).toBe(lastWrite.sends[0]?.token === 'A' ? 'verified' : 'missing');
    } else if (lastCheck && lastCheckValid) {
      // 4) 최신 쓰기가 없고 마지막 확인이 유효하면 그 확인의 새 판단(미확인)이 반영된다(R12 포함).
      expect(statuses).toBe('unverified');
    }

    if (lastCheck && lastCheck.result && typeof lastCheck.result === 'object') {
      const result = lastCheck.result;
      // 5) 마지막 확인은, 유효할 때 절대 superseded가 아니다(토큰 취득 실패 포함: R12).
      if (lastCheckValid) expect(result).not.toHaveProperty('superseded');
      else expect(result).toMatchObject({ superseded: true, ok: false });
      // 6) 반영된 결과는 앞뒤가 맞는다: 부족이 있으면 ok가 아니다.
      if (!result.superseded && result.permissions) {
        if (Object.values(result.permissions).includes('missing')) expect(result.ok).toBe(false);
      }
    }
  });
});
