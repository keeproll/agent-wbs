import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createGitHubClient, GitHubError, parseRepoUrl, type GitHubClient, type WriteOperation } from '../../src/github/client.ts';
import { Secret } from '../../src/security/secret.ts';
import { GitHubModel, type ModelOptions } from '../fakes/github/model.ts';
import { startFakeGitHub, type FakeGitHub } from '../fakes/github/server.ts';

const TOKEN = 'ghp_FAKEfakeFAKEfakeFAKEfake0123456789';

let github: FakeGitHub;
const servers: FakeGitHub[] = [];
let model: GitHubModel;
let writes: WriteOperation[];

async function setup(options: ModelOptions = {}, extra: Partial<Parameters<typeof createGitHubClient>[0]> = {}) {
  github = await startFakeGitHub(TOKEN);
  servers.push(github);
  model = new GitHubModel(options);
  model.install(github);
  writes = [];
  return createGitHubClient({
    baseUrl: github.url,
    repo: { owner: model.owner, repo: model.repo },
    token: () => Promise.resolve(new Secret(TOKEN)),
    beforeWrite: (op) => {
      writes.push(op);
      return Promise.resolve();
    },
    ...extra,
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('저장소 주소', () => {
  test.each([
    ['https://github.com/acme/app', { owner: 'acme', repo: 'app' }],
    ['https://github.com/acme/app.git', { owner: 'acme', repo: 'app' }],
    ['https://github.com/acme/app/', { owner: 'acme', repo: 'app' }],
  ])('%s → 저장소까지만 읽는다', (url, expected) => {
    expect(parseRepoUrl(url)).toEqual(expected);
  });

  test.each([
    'https://github.com/a/b/tree/main',
    'https://github.com/a/b/blob/main/x.md',
    'http://github.com/a/b',
    'https://gitlab.com/a/b',
    'https://user:pw@github.com/a/b',
    'https://github.com/a/b?x=1',
    'https://github.com/a',
    'https://github.com/a/..',
    'git@github.com:a/b.git',
  ])('%s는 거부한다', (url) => {
    expect(parseRepoUrl(url)).toBeNull();
  });
});

describe('연결 확인', () => {
  test('fine-grained 토큰: 계정·만료는 보고하되 확인 못 한 쓰기 권한을 true로 추정하지 않는다(리뷰 2)', async () => {
    const client = await setup({ login: 'bot', tokenExpiration: '2026-12-20 09:00:00 +0900' });
    const status = await client.checkConnection('token');
    expect(status).toEqual({
      mode: 'token',
      ok: false,
      account: 'bot',
      scopes: null,
      expiresAt: '2026-12-20T00:00:00.000Z',
      error: expect.stringMatching(/인증됨.*확인 안 됨.*M4-06/) as unknown,
    });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(writes).toEqual([]);
  });

  test('classic/gh 토큰은 x-oauth-scopes로 권한을 판단한다', async () => {
    const client = await setup({ oauthScopes: 'read:org, gist' });
    expect((await client.checkConnection('gh')).scopes).toEqual({
      contents: false,
      pulls: false,
      statuses: false,
      metadata: false,
    });
    const repoScoped = await setup({ oauthScopes: 'repo, read:org' });
    expect((await repoScoped.checkConnection('gh')).scopes).toEqual({
      contents: true,
      pulls: true,
      statuses: true,
      metadata: true,
    });
  });

  test('저장소 push가 안 되면 쓰기 권한 없음으로 보고한다', async () => {
    const client = await setup({ permissions: { admin: false, push: false, pull: true } });
    const status = await client.checkConnection('token');
    expect(status).toMatchObject({ ok: false, scopes: null });
    expect(status.error).toMatch(/쓰기 권한 없음/);
  });

  test('리뷰 R2: Contents 쓰기만 있고 Commit statuses 쓰기가 없는 토큰을 정상으로 보고하지 않는다', async () => {
    const client = await setup({ tokenPermissions: { statuses: 'none' } });
    const sha = model.push('agent/TASK-0001');
    const status = await client.checkConnection('token');
    await expect(client.setCommitStatus({ sha, context: 'agentwbs/task', state: 'pending' })).rejects.toMatchObject({
      status: 403,
      retryable: false,
    });
    expect(status.ok).toBe(false);
    expect(status.scopes).toBeNull();
  });

  test('연결 확인 중 속도 제한이면 던지지 않고 이유를 보고한다', async () => {
    const client = await setup();
    model.limitNext(1, 'secondary');
    const status = await client.checkConnection('token');
    expect(status).toMatchObject({ ok: false, account: null });
    expect(status.error).toMatch(/속도 제한/);
  });

  test('관리자 권한 자격 증명은 ok가 아니다(일반 병합 자격 증명에 우회 권한 금지)', async () => {
    const client = await setup({ permissions: { admin: true, push: true, pull: true } });
    const status = await client.checkConnection('token');
    expect(status.ok).toBe(false);
    expect(status.error).toMatch(/관리자/);
  });

  test('토큰이 틀리면 401을 실패로 보고하고 던지지 않는다', async () => {
    const client = await setup({}, { token: () => Promise.resolve(new Secret('ghp_wrongwrongwrongwrongwrong0000')) });
    const status = await client.checkConnection('token');
    expect(status).toMatchObject({ ok: false, account: null, scopes: null, expiresAt: null });
    expect(status.error).toMatch(/401/);
  });

  test('저장소에 접근할 수 없으면 실패로 보고한다', async () => {
    const client = await setup();
    const other = createGitHubClient({
      baseUrl: github.url,
      repo: { owner: 'o', repo: 'missing' },
      token: () => Promise.resolve(new Secret(TOKEN)),
    });
    expect(client).toBeDefined();
    const status = await other.checkConnection('token');
    expect(status).toMatchObject({ ok: false, account: 'agentwbs-bot', scopes: null });
    expect(status.error).toMatch(/저장소/);
  });
});

describe('저장소 확인', () => {
  const FULL = [
    'prototype/uiux/Main.dc.html',
    'prototype/uiux/img/a.png',
    'prototype/docs/guide.md',
    'prototype/docs/notes.txt',
    'prototype/docs/sub/more.md',
    'src/index.ts',
    'contracts/openapi.json',
    '.agentwbs/pipeline.yaml',
  ];

  test('private 여부·main 커밋·필수 구조를 보고한다', async () => {
    const client = await setup({ files: FULL });
    expect(await client.checkRepository()).toEqual({
      access: true,
      private: true,
      commit: model.branches.get('main'),
      structure: {
        uiux: true,
        uiuxFiles: 2,
        docs: ['prototype/docs/guide.md', 'prototype/docs/sub/more.md'],
        src: true,
        contracts: true,
        agentwbs: true,
      },
    });
  });

  test('없는 구조는 false로 보고한다', async () => {
    const client = await setup({ files: ['prototype/docs/a.md', 'srcx/a.ts'] });
    expect((await client.checkRepository()).structure).toEqual({
      uiux: false,
      uiuxFiles: 0,
      docs: ['prototype/docs/a.md'],
      src: false,
      contracts: false,
      agentwbs: false,
    });
  });

  test('커밋 없는 새 저장소는 commit·structure가 null이다', async () => {
    const client = await setup({ files: [] });
    expect(await client.checkRepository()).toEqual({ access: true, private: true, commit: null, structure: null });
  });

  test('접근 불가면 access=false', async () => {
    await setup();
    const other = createGitHubClient({
      baseUrl: github.url,
      repo: { owner: 'o', repo: 'missing' },
      token: () => Promise.resolve(new Secret(TOKEN)),
    });
    expect(await other.checkRepository()).toMatchObject({ access: false, private: null, commit: null, structure: null });
  });

  test.each(['primary', 'secondary', 'secondary429'] as const)(
    '리뷰 R4: 저장소 조회의 속도 제한(%s)은 access=false가 아니라 재시도 오류다',
    async (kind) => {
      const client = await setup({ files: FULL });
      model.limitNext(1, kind);
      await expect(client.checkRepository()).rejects.toMatchObject({ retryable: true });
    },
  );

  test('트리가 잘려 있으면 구조를 추정하지 않고 오류로 보고한다', async () => {
    const client = await setup({ files: FULL, truncatedTree: true });
    const result = await client.checkRepository();
    expect(result.structure).toBeNull();
    expect(result.error).toMatch(/잘림|truncated/);
  });
});

describe('PR', () => {
  let client: GitHubClient;
  beforeEach(async () => {
    client = await setup();
  });

  test('agent 브랜치로 main 대상 PR을 만든다', async () => {
    const head = model.push('agent/TASK-0001');
    const pr = await client.ensurePullRequest({ branch: 'agent/TASK-0001', title: 'TASK-0001', body: '설명' });
    expect(pr).toMatchObject({ number: 1, headSha: head, state: 'open', merged: false, created: true });
    expect(github.requests.find((r) => r.method === 'POST')?.body).toEqual({
      title: 'TASK-0001',
      head: 'agent/TASK-0001',
      base: 'main',
      body: '설명',
    });
    expect(writes).toEqual([{ kind: 'pull_create', branch: 'agent/TASK-0001' }]);
  });

  test('이미 열린 PR이 있으면 새로 만들지 않고 그것을 돌려준다(재시도 멱등)', async () => {
    model.push('agent/TASK-0001');
    model.openPull('agent/TASK-0001');
    const pr = await client.ensurePullRequest({ branch: 'agent/TASK-0001', title: 't', body: '' });
    expect(pr).toMatchObject({ number: 1, created: false });
    expect(github.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  test('조회와 생성 사이에 PR이 생겨 422가 나도 기존 PR을 돌려준다', async () => {
    model.push('agent/TASK-0001');
    let first = true;
    github.on('GET /repos/:owner/:repo/pulls', () => {
      if (first) {
        first = false;
        model.openPull('agent/TASK-0001');
        return { body: [] };
      }
      return { body: [...model.pulls.values()].map((p) => model.pullJson(p)) };
    });
    const pr = await client.ensurePullRequest({ branch: 'agent/TASK-0001', title: 't', body: '' });
    expect(pr).toMatchObject({ number: 1, created: false });
  });

  test.each(['main', 'feature/x', 'agent/', 'agent/../main', 'agent/a b'])('agent/<TASK> 형식이 아닌 브랜치(%s)는 거부한다', async (branch) => {
    await expect(client.ensurePullRequest({ branch, title: 't', body: '' })).rejects.toThrow(GitHubError);
    expect(github.requests).toEqual([]);
  });

  test('PR을 조회하고 닫는다', async () => {
    model.push('agent/TASK-0002');
    model.openPull('agent/TASK-0002');
    expect(await client.getPullRequest(1)).toMatchObject({ number: 1, state: 'open', branch: 'agent/TASK-0002' });
    await client.closePullRequest(1);
    expect(model.pulls.get(1)?.state).toBe('closed');
    expect(writes).toEqual([{ kind: 'pull_close', pr: 1 }]);
  });
});

describe('commit status', () => {
  let client: GitHubClient;
  beforeEach(async () => {
    client = await setup();
  });

  test('허용된 context로 status를 게시하고 설명은 140자로 자르며 비밀값을 가린다', async () => {
    const sha = model.push('agent/TASK-0001');
    await client.setCommitStatus({
      sha,
      context: 'agentwbs/task',
      state: 'failure',
      description: `실패 ${TOKEN} ${'가'.repeat(200)}`,
      targetUrl: 'http://127.0.0.1:3100/ci/CI-0001',
    });
    const [posted] = model.statuses.get(sha) ?? [];
    expect(posted).toMatchObject({ state: 'failure', context: 'agentwbs/task', target_url: 'http://127.0.0.1:3100/ci/CI-0001' });
    expect(posted?.description?.length).toBeLessThanOrEqual(140);
    expect(posted?.description).not.toContain(TOKEN);
    expect(writes).toEqual([{ kind: 'status', sha, context: 'agentwbs/task' }]);
    expect(await client.listCommitStatuses(sha)).toEqual([
      expect.objectContaining({ context: 'agentwbs/task', state: 'failure' }),
    ]);
  });

  test('리뷰 R6: 100개가 넘는 status도 같은 API 경로의 page를 올려 모두 읽는다', async () => {
    const sha = model.push('agent/TASK-0001');
    model.setStatus(sha, 'agentwbs/int', 'success');
    for (let i = 0; i < 230; i += 1) model.setStatus(sha, 'agentwbs/task', 'pending');
    const list = await client.listCommitStatuses(sha);
    expect(list).toHaveLength(231);
    expect(list.at(-1)).toMatchObject({ context: 'agentwbs/int', state: 'success' });
    const pages = github.requests.filter((r) => r.path.endsWith('/statuses')).map((r) => r.query);
    expect(pages).toEqual([
      { per_page: '100', page: '1' },
      { per_page: '100', page: '2' },
      { per_page: '100', page: '3' },
    ]);
  });

  test('Link가 다른 주소를 가리켜도 그 주소로 토큰을 보내지 않는다', async () => {
    const sha = model.push('agent/TASK-0001');
    const seen: string[] = [];
    github.on('GET /repos/:owner/:repo/commits/:sha/statuses', (request) => {
      seen.push(request.query.page ?? '');
      return request.query.page === '2'
        ? { body: [{ context: 'agentwbs/int', state: 'success', description: null, target_url: null }] }
        : {
            headers: { link: '<http://evil.example/steal?page=2>; rel="next"' },
            body: Array.from({ length: 100 }, () => ({ context: 'agentwbs/task', state: 'pending', description: null, target_url: null })),
          };
    });
    expect(await client.listCommitStatuses(sha)).toHaveLength(101);
    expect(seen).toEqual(['1', '2']);
  });

  test('페이지가 끝없이 이어지면 잘라 내지 않고 오류로 알린다', async () => {
    const sha = model.push('agent/TASK-0001');
    github.on('GET /repos/:owner/:repo/commits/:sha/statuses', () => ({
      headers: { link: `<${github.url}/next>; rel="next"` },
      body: Array.from({ length: 100 }, () => ({ context: 'agentwbs/task', state: 'pending', description: null, target_url: null })),
    }));
    await expect(client.listCommitStatuses(sha)).rejects.toThrow(GitHubError);
  });

  test('허용되지 않은 context·잘못된 SHA는 호출 전에 거부한다', async () => {
    const sha = model.push('agent/TASK-0001');
    await expect(
      client.setCommitStatus({ sha, context: 'ci/other' as 'agentwbs/int', state: 'success' }),
    ).rejects.toThrow(GitHubError);
    await expect(client.setCommitStatus({ sha: 'abc', context: 'agentwbs/int', state: 'success' })).rejects.toThrow(
      GitHubError,
    );
    expect(github.requests).toEqual([]);
  });
});

describe('쓰기 차단(협조적 검사)', () => {
  test('beforeWrite가 거부하면 GitHub를 호출하지 않는다', async () => {
    const client = await setup(
      {},
      {
        beforeWrite: () => Promise.reject(new Error('EXTERNAL_WRITE_BLOCKED')),
      },
    );
    const sha = model.push('agent/TASK-0001');
    model.openPull('agent/TASK-0001');
    model.setStatus(sha, 'agentwbs/int', 'success');
    await expect(client.setCommitStatus({ sha, context: 'agentwbs/int', state: 'success' })).rejects.toThrow(
      'EXTERNAL_WRITE_BLOCKED',
    );
    await expect(client.ensurePullRequest({ branch: 'agent/TASK-0009', title: 't', body: '' })).rejects.toThrow(
      'EXTERNAL_WRITE_BLOCKED',
    );
    await expect(client.closePullRequest(1)).rejects.toThrow('EXTERNAL_WRITE_BLOCKED');
    await expect(
      client.mergePullRequest({ pr: 1, baseSha: model.branches.get('main') ?? '', headSha: sha }),
    ).rejects.toThrow('EXTERNAL_WRITE_BLOCKED');
    expect(github.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(model.pulls.get(1)?.merged).toBe(false);
  });
});

describe('오류와 비밀값', () => {
  test('요청 헤더에 Bearer 토큰과 API 버전을 싣고, 경로·질의에는 토큰이 없다', async () => {
    const seen: Request[] = [];
    const client = await setup(
      {},
      {
        fetch: (input, init) => {
          seen.push(new Request(input, init));
          return fetch(input, init);
        },
      },
    );
    await client.checkConnection('token');
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(request.headers.get('x-github-api-version')).toBe('2022-11-28');
      expect(request.headers.get('accept')).toBe('application/vnd.github+json');
      expect(request.url).not.toContain(TOKEN);
      expect(request.redirect).toBe('manual');
    }
  });

  test('리다이렉트를 따라가지 않는다(토큰을 다른 주소로 보내지 않음)', async () => {
    const client = await setup();
    github.on('GET /repos/:owner/:repo/pulls/:number', () => ({ status: 302, headers: { location: 'http://evil.example/' } }));
    await expect(client.getPullRequest(1)).rejects.toMatchObject({ status: 302, retryable: false });
  });

  test('GitHub 오류 메시지에 섞인 비밀값을 가린다', async () => {
    const client = await setup();
    github.on('GET /repos/:owner/:repo/pulls/:number', () => ({
      status: 422,
      body: { message: `bad ${TOKEN} https://x/?access_token=abc123secret` },
    }));
    const error = (await client.getPullRequest(1).catch((e: unknown) => e)) as GitHubError;
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('abc123secret');
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  test.each([
    [500, {}, true],
    [502, {}, true],
    [429, { 'retry-after': '7' }, true],
    [403, { 'x-ratelimit-remaining': '0' }, true],
    [403, { 'retry-after': '5' }, true],
    [403, {}, false],
    [401, {}, false],
    [404, {}, false],
    [422, {}, false],
  ])('%i 응답의 재시도 여부를 구분한다', async (status, headers, retryable) => {
    const client = await setup();
    github.on('GET /repos/:owner/:repo/pulls/:number', () => ({ status, headers, body: { message: 'x' } }));
    await expect(client.getPullRequest(1)).rejects.toMatchObject({ status, retryable });
  });

  test('리뷰 R3: 잔량이 남은 보조 속도 제한 403도 재시도 대상이고 Retry-After를 넘긴다', async () => {
    const client = await setup();
    model.limitNext(1, 'secondary');
    await expect(client.getPullRequest(1)).rejects.toMatchObject({ status: 403, retryable: true, retryAfterSeconds: 60 });
  });

  test('헤더 없이 본문만 rate limit을 말하는 403도 재시도 대상이다', async () => {
    const client = await setup();
    github.on('GET /repos/:owner/:repo/pulls/:number', () => ({
      status: 403,
      body: { message: 'You have exceeded a secondary rate limit.' },
    }));
    await expect(client.getPullRequest(1)).rejects.toMatchObject({ status: 403, retryable: true, retryAfterSeconds: null });
  });

  test('기본 속도 제한 403은 x-ratelimit-reset까지 남은 초를 넘긴다', async () => {
    const client = await setup();
    model.limitNext(1, 'primary');
    const error = (await client.getPullRequest(1).catch((e: unknown) => e)) as GitHubError;
    expect(error).toMatchObject({ status: 403, retryable: true });
    expect(error.retryAfterSeconds).toBeGreaterThan(100);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(121);
  });

  test('권한 부족 403(속도 제한 신호 없음)은 재시도하지 않는다', async () => {
    const client = await setup({ tokenPermissions: { pulls: 'read' } });
    model.push('agent/TASK-0001');
    await expect(client.ensurePullRequest({ branch: 'agent/TASK-0001', title: 't', body: '' })).rejects.toMatchObject({
      status: 403,
      retryable: false,
    });
  });

  test('429의 Retry-After를 넘긴다', async () => {
    const client = await setup();
    github.on('GET /repos/:owner/:repo/pulls/:number', () => ({ status: 429, headers: { 'retry-after': '7' } }));
    await expect(client.getPullRequest(1)).rejects.toMatchObject({ retryAfterSeconds: 7 });
  });

  test('통신 실패는 status 0·재시도 가능이다', async () => {
    const client = await setup();
    github.on('GET /repos/:owner/:repo/pulls/:number', () => ({ drop: true }));
    await expect(client.getPullRequest(1)).rejects.toMatchObject({ status: 0, retryable: true });
  });

  test('토큰을 매 요청마다 가져온다(교체된 자격 증명 반영)', async () => {
    let calls = 0;
    const client = await setup(
      {},
      {
        token: () => {
          calls += 1;
          return Promise.resolve(new Secret(TOKEN));
        },
      },
    );
    await client.getPullRequest(1).catch(() => undefined);
    await client.getPullRequest(1).catch(() => undefined);
    expect(calls).toBe(2);
  });
});
