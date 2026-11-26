import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createGitHubClient, type Permissions } from '../../src/github/client.ts';
import { Secret } from '../../src/security/secret.ts';

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
          new URL(String(input)).pathname === '/user'
            ? Response.json({ login: 'bot' })
            : Response.json({ permissions: { admin: false, push, pull: true } }),
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

describe('권한 상태를 바꾸는 경로 전수 고정', () => {
  test('client.ts에서 permissions를 바꾸는 곳은 observeWrite(세대 대조 뒤)와 commitPermissions뿐이다', () => {
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
      'commitPermissions: permissions = next;',
      "observeWrite: permissions[denied] = 'missing';",
      "observeWrite: permissions[permission] = 'verified';",
      'top: let permissions = unverifiedAll();',
    ]);
    // observeWrite의 첫 줄은 세대 대조다.
    const observe = source.slice(source.indexOf('const observeWrite = ('));
    expect(observe.split('\n')[1]?.trim()).toBe('if (raw.generation !== generation) return;');
  });
});
