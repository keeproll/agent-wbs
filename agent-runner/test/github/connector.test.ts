import { describe, expect, test } from 'vitest';
import { ApiError, ApiTransportError, type ApiClient } from '../../src/api/client.ts';
import { GithubConnector, githubStatusBody } from '../../src/github/connector.ts';
import { generateRunnerKeyPair, sealCredential } from '../../src/github/credential.ts';

const verified = { metadata: 'verified', contents: 'verified', pulls: 'verified', statuses: 'verified' } as const;

describe('githubStatusBody — 서버 입력 규칙 githubStatusConsistent와 맞는 본문', () => {
  test('missing이 있으면 ok=false', () => {
    const body = githubStatusBody({ mode: 'gh', ok: true, account: 'a', permissions: { ...verified, statuses: 'missing' }, expiresAt: null });
    expect(body).toMatchObject({ ok: false, scopes: { statuses: 'missing' }, error: '필요한 권한 부족: statuses' });
  });
  test('scopes null이면 ok=false', () => {
    expect(githubStatusBody({ mode: 'token', ok: true, account: null, permissions: null, expiresAt: null }).ok).toBe(false);
  });
  test('unverified가 있으면 warning을 반드시 싣는다', () => {
    const body = githubStatusBody({ mode: 'token', ok: true, account: 'a', permissions: { ...verified, pulls: 'unverified' }, expiresAt: null });
    expect(body.ok).toBe(true);
    expect(body.warning).toBeTruthy();
  });
});

describe('GithubConnector', () => {
  const identity = () => ({ runnerId: 'r1', hostId: 'h1', bootId: 'b1' });
  const notFound = () => new ApiError('getGithubCredential', 404, { code: 'NOT_FOUND', message: '', action: '', fix: '', errors: [], details: {}, requestId: 'x' } as never, null);

  test('404 뒤에는 새 Idempotency-Key로 다시 등록하고 봉인 값을 연다', async () => {
    const keys = generateRunnerKeyPair();
    const calls: { op: string; key?: string; keyId?: string }[] = [];
    let n = 0;
    const api = (async (op: string, req: { idempotencyKey?: string; query?: { keyId: string } }) => {
      calls.push({ op, ...(req.idempotencyKey && { key: req.idempotencyKey }), ...(req.query && { keyId: req.query.keyId }) });
      if (op === 'registerGithubKey') { n += 1; return { status: 200, body: { keyId: `k${String(n)}` }, headers: new Headers() }; }
      if (req.query?.keyId === 'k1') throw notFound();
      return { status: 200, body: { sealed: sealCredential(keys.publicKey, 'ghp_secret_value_123') }, headers: new Headers() };
    }) as unknown as ApiClient;
    const c = new GithubConnector({ api, epoch: () => 3, identity, enqueueStatus: () => Promise.resolve(), keyPair: keys });
    const secret = await c.tokenSource().token();
    expect(secret.reveal()).toBe('ghp_secret_value_123');
    const registers = calls.filter((x) => x.op === 'registerGithubKey');
    expect(registers).toHaveLength(2);
    expect(registers[0]?.key).not.toBe(registers[1]?.key);
    expect(registers.every((x) => x.key?.startsWith('github-key:r1:'))).toBe(true);
    expect(c.keyId).toBe('k2');
  });

  test('같은 등록의 네트워크 재전송은 같은 키를 유지한다', async () => {
    const keys: string[] = [];
    const api = (async (_op: string, req: { idempotencyKey: string }) => {
      keys.push(req.idempotencyKey);
      if (keys.length === 1) throw new ApiTransportError('registerGithubKey');
      return { status: 200, body: { keyId: 'k' }, headers: new Headers() };
    }) as unknown as ApiClient;
    const c = new GithubConnector({ api, epoch: () => 0, identity, enqueueStatus: () => Promise.resolve(), retryWait: () => Promise.resolve() });
    await expect(c.register()).resolves.toBe('k');
    expect(new Set(keys).size).toBe(1);
  });

  test('밀린 연결 확인(superseded)은 보고하지 않고, 권한 부족 403은 missing으로 다시 보고한다', async () => {
    const bodies: unknown[] = [];
    const c = new GithubConnector({ api: (() => undefined) as unknown as ApiClient, epoch: () => 0, identity, enqueueStatus: (b) => { bodies.push(b); return Promise.resolve(); } });
    expect(await c.reportConnection({ mode: 'gh', ok: false, account: null, permissions: null, expiresAt: null, superseded: true })).toBeNull();
    await c.reportConnection({ mode: 'gh', ok: true, account: 'bot', permissions: verified, expiresAt: null });
    await c.reportPermissionDenied({ permission: 'pulls', operation: 'pull_create', message: 'POST pulls: 403' }, { ...verified, pulls: 'missing' }, 'gh');
    expect(bodies).toEqual([
      { mode: 'gh', ok: true, account: 'bot', scopes: verified, expiresAt: null },
      { mode: 'gh', ok: false, account: 'bot', scopes: { ...verified, pulls: 'missing' }, expiresAt: null, error: 'POST pulls: 403' },
    ]);
  });
});
