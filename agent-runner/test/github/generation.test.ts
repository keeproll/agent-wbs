import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createGitHubClient, type Permissions } from '../../src/github/client.ts';
import { ghTokenSource } from '../../src/github/token.ts';
import { Secret } from '../../src/security/secret.ts';
import { protectedMainResponse } from '../fakes/github/rules.ts';

/**
 * 권한 상태(`permissions`)를 바꾸는 모든 경로가 「권한 세대」를 대조하는지 고정한다.
 * 세대는 연결 재확인과 토큰 교체 때 오른다. 이전 세대에 보낸 요청의 응답은 현재 상태를 바꾸지 못한다.
 */
const OLD = 'old-review-token';
const NEW = 'new-review-token';
const SHA = 'a'.repeat(40);

type Responder = (path: string, method: string) => Response | Promise<Response>;

/** 옛 토큰의 특정 요청만 보류할 수 있는 가짜 fetch. 새 토큰은 쓰기 가능한 계정이다. */
function harness(oldResponder: Responder, holdOld: (path: string, method: string) => boolean) {
  let selected = OLD;
  const arrived = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const client = createGitHubClient({
    repo: { owner: 'o', repo: 'r' },
    token: () => Promise.resolve(new Secret(selected)),
    fetch: async (input, init) => {
      const protection = protectedMainResponse(new URL(String(input)).pathname);
      if (protection) return Promise.resolve(protection);
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      const isOld = new Headers(init?.headers).get('authorization') === `Bearer ${OLD}`;
      if (isOld) {
        if (holdOld(path, method)) {
          arrived.resolve(undefined);
          await release.promise;
        }
        return oldResponder(path, method);
      }
      if (path === '/user') return Response.json({ login: 'new-writer' });
      if (method === 'GET') return Response.json({ permissions: { admin: false, push: true, pull: true } });
      return Response.json({}, { status: 201 });
    },
  });
  return {
    client,
    arrived: arrived.promise,
    release: () => {
      release.resolve(undefined);
    },
    useNewToken: () => {
      selected = NEW;
    },
  };
}

const readOnlyOld: Responder = (path) =>
  path === '/user' ? Response.json({ login: 'old-reader' }) : Response.json({ permissions: { admin: false, push: false, pull: true } });

/** 새 토큰으로 연결 확인 + status 쓰기까지 성공한 상태를 만든다. */
async function establishNew(h: ReturnType<typeof harness>, recheck = true): Promise<Permissions> {
  await h.arrived;
  h.useNewToken();
  if (recheck) expect((await h.client.checkConnection('token')).ok).toBe(true);
  await h.client.setCommitStatus({ sha: SHA, context: 'agentwbs/task', state: 'pending' });
  const before = h.client.permissions();
  expect(before.statuses).toBe('verified');
  return before;
}

describe('연결 확인의 늦은 응답 (최종 리뷰 R11)', () => {
  test('R11: 옛 연결 확인의 저장소 응답이 늦게 와도 새 토큰의 권한 상태를 바꾸지 않고, 무효화됐다고 알린다', async () => {
    const h = harness(readOnlyOld, (path, method) => method === 'GET' && path !== '/user');
    const oldCheck = h.client.checkConnection('token');
    const before = await establishNew(h);
    h.release();
    const oldResult = await oldCheck;
    expect(h.client.permissions()).toEqual(before);
    expect(oldResult).toMatchObject({ ok: false, superseded: true });
  });

  test('옛 연결 확인의 /user 응답이 늦게 와도 상태를 바꾸지 않는다', async () => {
    const h = harness(readOnlyOld, (path) => path === '/user');
    const oldCheck = h.client.checkConnection('token');
    const before = await establishNew(h);
    h.release();
    expect(await oldCheck).toMatchObject({ superseded: true });
    expect(h.client.permissions()).toEqual(before);
  });

  test('옛 연결 확인이 늦은 401로 끝나도 상태를 초기화하지 않는다', async () => {
    const h = harness(
      () => Response.json({ message: 'Bad credentials' }, { status: 401 }),
      (path) => path === '/user',
    );
    const oldCheck = h.client.checkConnection('token');
    const before = await establishNew(h);
    h.release();
    expect(await oldCheck).toMatchObject({ ok: false, superseded: true });
    expect(h.client.permissions()).toEqual(before);
  });

  test('옛 연결 확인이 늦은 통신 실패로 끝나도 상태를 초기화하지 않는다', async () => {
    const h = harness(
      () => {
        throw new TypeError('fetch failed');
      },
      (path) => path === '/user',
    );
    const oldCheck = h.client.checkConnection('token');
    const before = await establishNew(h);
    h.release();
    expect(await oldCheck).toMatchObject({ ok: false, superseded: true });
    expect(h.client.permissions()).toEqual(before);
  });

  test('재확인 없이 토큰만 바뀐 뒤 옛 확인이 통신 실패로 끝나도 상태를 초기화하지 않는다', async () => {
    const h = harness(
      () => {
        throw new TypeError('fetch failed');
      },
      (path) => path === '/user',
    );
    const oldCheck = h.client.checkConnection('token');
    const before = await establishNew(h, false);
    h.release();
    expect(await oldCheck).toMatchObject({ ok: false, superseded: true });
    expect(h.client.permissions()).toEqual(before);
  });

  test('classic 토큰(범위 없음)의 늦은 연결 확인도 상태를 부족으로 덮지 않는다', async () => {
    const h = harness(
      (path) =>
        path === '/user'
          ? Response.json({ login: 'old' }, { headers: { 'x-oauth-scopes': 'read:org' } })
          : Response.json({ permissions: { admin: false, push: true, pull: true } }),
      (path, method) => method === 'GET' && path !== '/user',
    );
    const oldCheck = h.client.checkConnection('gh');
    const before = await establishNew(h);
    h.release();
    expect(await oldCheck).toMatchObject({ superseded: true });
    expect(h.client.permissions()).toEqual(before);
  });

  test('연결 재확인 없이 토큰만 바뀌어도 옛 연결 확인의 늦은 응답은 상태를 바꾸지 않는다', async () => {
    const h = harness(readOnlyOld, (path, method) => method === 'GET' && path !== '/user');
    const oldCheck = h.client.checkConnection('token');
    const before = await establishNew(h, false);
    h.release();
    expect(await oldCheck).toMatchObject({ superseded: true });
    expect(h.client.permissions()).toEqual(before);
  });

  test('같은 토큰으로 연결 확인이 겹치면 나중에 시작한 확인만 반영된다', async () => {
    let push = false;
    const arrived = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let held = false;
    const client = createGitHubClient({
      repo: { owner: 'o', repo: 'r' },
      token: () => Promise.resolve(new Secret(OLD)),
      fetch: async (input, init) => {
        const protection = protectedMainResponse(new URL(String(input)).pathname);
        if (protection) return Promise.resolve(protection);
        const path = new URL(String(input)).pathname;
        if (path === '/user') return Response.json({ login: 'bot' });
        if ((init?.method ?? 'GET') === 'GET' && !held) {
          held = true;
          const answer = push;
          arrived.resolve(undefined);
          await release.promise;
          return Response.json({ permissions: { admin: false, push: answer, pull: true } });
        }
        return Response.json({ permissions: { admin: false, push, pull: true } });
      },
    });
    const first = client.checkConnection('token');
    await arrived.promise;
    push = true; // 팀장이 GitHub에서 계정 권한을 고쳤다
    const second = await client.checkConnection('token');
    expect(second.ok).toBe(true);
    const before = client.permissions();
    release.resolve(undefined);
    expect(await first).toMatchObject({ superseded: true });
    expect(client.permissions()).toEqual(before);
    expect(before.contents).toBe('unverified');
  });

  test('토큰을 기다리느라 아직 요청을 못 보낸 옛 확인도, 나중 확인이 먼저 끝났으면 반영되지 않는다', async () => {
    const gate = Promise.withResolvers<undefined>();
    let calls = 0;
    let push = false;
    const client = createGitHubClient({
      repo: { owner: 'o', repo: 'r' },
      token: async () => {
        calls += 1;
        if (calls === 1) await gate.promise; // 첫 확인의 토큰 조회만 늦다
        return new Secret(OLD);
      },
      fetch: (input) =>
        Promise.resolve(
          protectedMainResponse(new URL(String(input)).pathname) ?? (new URL(String(input)).pathname === '/user'
            ? Response.json({ login: 'bot' })
            : Response.json({ permissions: { admin: false, push, pull: true } })),
        ),
    });
    const first = client.checkConnection('token');
    await Promise.resolve();
    push = true;
    expect((await client.checkConnection('token')).ok).toBe(true);
    const before = client.permissions();
    push = false;
    gate.resolve(undefined);
    expect(await first).toMatchObject({ superseded: true });
    expect(client.permissions()).toEqual(before);
  });

  test('겹치지 않은 연결 확인이 통신 실패로 끝나면 무효화가 아니고, 상태를 새로 판단(미확인)으로 되돌린다', async () => {
    let fail = false;
    const client = createGitHubClient({
      repo: { owner: 'o', repo: 'r' },
      token: () => Promise.resolve(new Secret(OLD)),
      fetch: (input, init) => {
        const protection = protectedMainResponse(new URL(String(input)).pathname);
        if (protection) return Promise.resolve(protection);
        if (fail) return Promise.reject(new TypeError('fetch failed'));
        const path = new URL(String(input)).pathname;
        if (path === '/user') return Promise.resolve(Response.json({ login: 'bot' }));
        if ((init?.method ?? 'GET') === 'GET') {
          return Promise.resolve(Response.json({ permissions: { admin: false, push: true, pull: true } }));
        }
        return Promise.resolve(Response.json({}, { status: 201 }));
      },
    });
    await client.setCommitStatus({ sha: SHA, context: 'agentwbs/task', state: 'pending' });
    expect(client.permissions().statuses).toBe('verified');
    fail = true;
    const result = await client.checkConnection('token');
    expect(result).not.toHaveProperty('superseded');
    expect(result.error).toMatch(/통신 실패/);
    expect(client.permissions()).toEqual({ metadata: 'unverified', contents: 'unverified', pulls: 'unverified', statuses: 'unverified' });
  });

  test('겹치지 않은 연결 확인은 무효화 표시가 없다', async () => {
    const h = harness(readOnlyOld, () => false);
    const result = await h.client.checkConnection('token');
    expect(result).not.toHaveProperty('superseded');
    expect(result.permissions?.contents).toBe('missing');
    expect(h.client.permissions().contents).toBe('missing');
  });
});

describe('865c286 리뷰 회귀 (R12·R13)', () => {
  test('R12: 현재 확인의 토큰 취득 실패(gh 로그인 풀림)는 무효화가 아니라 현재 실패이고, 이전 확인됨을 지운다', async () => {
    let loginFailed = false;
    const source = ghTokenSource(() =>
      Promise.resolve({ code: loginFailed ? 1 : 0, stdout: loginFailed ? '' : 'review-only-token' }),
    );
    const client = createGitHubClient({
      repo: { owner: 'o', repo: 'r' },
      token: source.token,
      fetch: () => Promise.resolve(Response.json({}, { status: 201 })),
    });
    await client.setCommitStatus({ sha: SHA, context: 'agentwbs/task', state: 'pending' });
    expect(client.permissions().statuses).toBe('verified');
    loginFailed = true;
    const status = await client.checkConnection('gh');
    expect(status.ok).toBe(false);
    expect(status).not.toHaveProperty('superseded');
    expect(status.error).toContain('gh 로그인');
    expect(client.permissions().statuses).toBe('unverified');
  });

  test('R13: 연결 확인 도중 받은 현재 세대의 실제 쓰기 403은 확인 완료 뒤에도 부족으로 남고, 결과도 ok가 아니다', async () => {
    const arrived = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const notices: string[] = [];
    const client = createGitHubClient({
      repo: { owner: 'o', repo: 'r' },
      token: () => Promise.resolve(new Secret(OLD)),
      onPermissionDenied: (e) => {
        notices.push(e.permission);
      },
      fetch: async (input, init) => {
        const protection = protectedMainResponse(new URL(String(input)).pathname);
        if (protection) return Promise.resolve(protection);
        if (new URL(String(input)).pathname === '/user') return Response.json({ login: 'bot' });
        if ((init?.method ?? 'GET') === 'GET') {
          arrived.resolve(undefined);
          await release.promise;
          return Response.json({ permissions: { admin: false, push: true, pull: true } });
        }
        return Response.json(
          { message: 'Resource not accessible by personal access token' },
          { status: 403, headers: { 'x-accepted-github-permissions': 'statuses=write' } },
        );
      },
    });
    const checking = client.checkConnection('token');
    await arrived.promise;
    await expect(client.setCommitStatus({ sha: SHA, context: 'agentwbs/task', state: 'pending' })).rejects.toMatchObject({
      status: 403,
    });
    expect(client.permissions().statuses).toBe('missing');
    release.resolve(undefined);
    const result = await checking;
    expect(client.permissions().statuses).toBe('missing');
    expect(result).toMatchObject({ ok: false, permissions: { statuses: 'missing', contents: 'unverified' } });
    expect(result).not.toHaveProperty('superseded');
    expect(notices).toEqual(['statuses']);
  });

  test('연결 확인 도중 받은 현재 세대의 쓰기 성공도 확인 완료 뒤 확인됨으로 남는다', async () => {
    const arrived = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const client = createGitHubClient({
      repo: { owner: 'o', repo: 'r' },
      token: () => Promise.resolve(new Secret(OLD)),
      fetch: async (input, init) => {
        const protection = protectedMainResponse(new URL(String(input)).pathname);
        if (protection) return Promise.resolve(protection);
        if (new URL(String(input)).pathname === '/user') return Response.json({ login: 'bot' });
        if ((init?.method ?? 'GET') === 'GET') {
          arrived.resolve(undefined);
          await release.promise;
          return Response.json({ permissions: { admin: false, push: true, pull: true } });
        }
        return Response.json({}, { status: 201 });
      },
    });
    const checking = client.checkConnection('token');
    await arrived.promise;
    await client.setCommitStatus({ sha: SHA, context: 'agentwbs/task', state: 'pending' });
    release.resolve(undefined);
    const result = await checking;
    expect(client.permissions()).toEqual({ metadata: 'verified', contents: 'unverified', pulls: 'unverified', statuses: 'verified' });
    expect(result).toMatchObject({ ok: true, permissions: client.permissions() });
  });

  test('연결 확인 시작 전의 쓰기 결과는 새 확인이 새로 판단한다(재확인 = 새 판단)', async () => {
    let deny = true;
    const client = createGitHubClient({
      repo: { owner: 'o', repo: 'r' },
      token: () => Promise.resolve(new Secret(OLD)),
      fetch: (input, init) => {
        const protection = protectedMainResponse(new URL(String(input)).pathname);
        if (protection) return Promise.resolve(protection);
        if (new URL(String(input)).pathname === '/user') return Promise.resolve(Response.json({ login: 'bot' }));
        if ((init?.method ?? 'GET') === 'GET') {
          return Promise.resolve(Response.json({ permissions: { admin: false, push: true, pull: true } }));
        }
        return Promise.resolve(deny ? Response.json({ message: 'x' }, { status: 403 }) : Response.json({}, { status: 201 }));
      },
    });
    await client.setCommitStatus({ sha: SHA, context: 'agentwbs/task', state: 'pending' }).catch(() => undefined);
    expect(client.permissions().statuses).toBe('missing');
    deny = false; // 팀장이 GitHub에서 토큰 권한을 고침
    expect(await client.checkConnection('token')).toMatchObject({ ok: true });
    expect(client.permissions().statuses).toBe('unverified');
  });
});

describe('ce62299 리뷰 (R14)', () => {
  test('R14: 확인의 토큰 취득이 늦는 동안 옛 토큰으로 받은 쓰기 403은 새 토큰 snapshot에 이어지지 않는다', async () => {
    const firstToken = Promise.withResolvers<{ code: number; stdout: string }>();
    let calls = 0;
    let selected = 'old-review-token';
    const source = ghTokenSource(() => {
      calls += 1;
      if (calls === 1) return firstToken.promise;
      return Promise.resolve({ code: 0, stdout: selected });
    });
    const client = createGitHubClient({
      repo: { owner: 'o', repo: 'r' },
      token: source.token,
      fetch: (input, init) => {
        const protection = protectedMainResponse(new URL(String(input)).pathname);
        if (protection) return Promise.resolve(protection);
        const old = new Headers(init?.headers).get('authorization') === 'Bearer old-review-token';
        if (new URL(String(input)).pathname === '/user') {
          return Promise.resolve(Response.json({ login: old ? 'old-bot' : 'new-bot' }));
        }
        if ((init?.method ?? 'GET') === 'GET') {
          return Promise.resolve(Response.json({ permissions: { admin: false, push: true, pull: true } }));
        }
        return Promise.resolve(Response.json({}, { status: old ? 403 : 201 }));
      },
    });
    const checking = client.checkConnection('gh');
    await expect(client.setCommitStatus({ sha: SHA, context: 'agentwbs/task', state: 'pending' })).rejects.toMatchObject({
      status: 403,
    });
    expect(client.permissions().statuses).toBe('missing');
    selected = 'new-review-token';
    firstToken.resolve({ code: 0, stdout: selected });
    const result = await checking;
    expect(result).not.toHaveProperty('superseded');
    expect(result).toMatchObject({ ok: true, account: 'new-bot' });
    expect(client.permissions().statuses).toBe('unverified');
  });

  test('같은 상황에서 옛 토큰의 쓰기 성공(확인됨)도 새 토큰에 이어지지 않는다', async () => {
    const firstToken = Promise.withResolvers<{ code: number; stdout: string }>();
    let calls = 0;
    let selected = 'old-review-token';
    const source = ghTokenSource(() => {
      calls += 1;
      return calls === 1 ? firstToken.promise : Promise.resolve({ code: 0, stdout: selected });
    });
    const client = createGitHubClient({
      repo: { owner: 'o', repo: 'r' },
      token: source.token,
      fetch: (input, init) =>
        Promise.resolve(
          protectedMainResponse(new URL(String(input)).pathname) ?? (new URL(String(input)).pathname === '/user'
            ? Response.json({ login: 'bot' })
            : (init?.method ?? 'GET') === 'GET'
              ? Response.json({ permissions: { admin: false, push: true, pull: true } })
              : Response.json({}, { status: 201 })),
        ),
    });
    const checking = client.checkConnection('gh');
    await client.setCommitStatus({ sha: SHA, context: 'agentwbs/task', state: 'pending' });
    expect(client.permissions().statuses).toBe('verified');
    selected = 'new-review-token';
    firstToken.resolve({ code: 0, stdout: selected });
    expect(await checking).toMatchObject({ ok: true });
    expect(client.permissions().statuses).toBe('unverified');
  });
});

describe('권한 상태를 바꾸는 경로 전수 고정', () => {
  test('client.ts에서 permissions를 바꾸는 곳은 직렬화된 갱신 함수 applyEvidence 하나뿐이다', () => {
    const source = readFileSync(new URL('../../src/github/client.ts', import.meta.url), 'utf8');
    const lines = source.split('\n');
    // `permissions =`, `permissions[x] =`, `permissions.x =` 형태의 대입(비교 == 제외)
    const writes = lines
      .map((text, index) => ({ text, line: index + 1 }))
      .filter(({ text }) => /\bpermissions(\[[^\]]+\]|\.\w+)?\s*=(?!=)/.test(text) && !/^\s*(\/\/|\*)/.test(text));
    const owner = (line: number) => {
      for (let i = line - 1; i >= 0; i -= 1) {
        const match = /^ {2}const (\w+) = (?:async )?\(/.exec(lines[i] ?? '');
        if (match) return match[1];
      }
      return 'top';
    };
    expect(writes.map(({ text, line }) => `${owner(line)}: ${text.trim()}`).sort()).toEqual([
      'applyEvidence: permissions = merged;',
      'applyEvidence: permissions[evidence.permission] = evidence.state;',
      'top: let permissions = unverifiedAll();',
    ]);
  });
});
