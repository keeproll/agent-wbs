import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { Writable } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPool, recreateTestDatabase, runMigrations, seedSystem } from '@awbs/db';
import { afterAll, beforeAll, beforeEach, expect, inject, test, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loggerOptions } from '../src/log.ts';
import { issueLoginLink, issueRunnerToken, revokeRunnerToken } from '../src/platform/credentials.ts';
import { runnerPublicKey } from '../src/platform/runner-key.ts';
import { inEpoch } from '../src/platform/transaction.ts';
import { installProjectRunner } from '../src/project/runner-routes.ts';
import { sealGithubCredential } from '../src/project/github-credential.ts';
import { assertExternal, claim } from '../src/runner/service.ts';
import { RunnerRepository } from '../src/runner/repository.ts';
import { runnerState } from '../src/runner/state.ts';
import { createApiClient } from '../../../../agent-runner/src/api/client.ts';
import { GithubConnector } from '../../../../agent-runner/src/github/connector.ts';
import { generateRunnerKeyPair, openSealedCredential } from '../../../../agent-runner/src/github/credential.ts';
import { createGitHubClient } from '../../../../agent-runner/src/github/client.ts';
import { Secret } from '../../../../agent-runner/src/security/secret.ts';
import { startFakeGitHub } from '../../../../agent-runner/test/fakes/github/server.ts';
import { GitHubModel } from '../../../../agent-runner/test/fakes/github/model.ts';
import vector from '../../../contracts/fixtures/sealed-v1-vector.json' with { type: 'json' };

const url = new URL(inject('testDatabaseUrl'));
url.pathname += '_ghcred';
const owner = createPool(url.href, { onError: () => undefined });
const appUrl = new URL(url);
appUrl.searchParams.set('options', '-c role=awbs_app');
const pool = createPool(appUrl.href, { onError: () => undefined });
const origin = 'http://127.0.0.1:3100';
const token = `github_pat_${'testOnly'.repeat(6)}`;
const identity = { runnerId: 'credential-runner', hostId: 'host-1', bootId: 'boot-1' };
const verified = { contents: 'verified', pulls: 'verified', statuses: 'verified', metadata: 'verified' } as const;
let bearer: string, other: string, cookie: string, csrf: string;
let logs = '';
const makeApp = () => {
  const app = buildApp(pool, { ...loggerOptions('info'), stream: new Writable({ write(chunk, _encoding, done) { logs += String(chunk); done(); } }) });
  installProjectRunner(app, pool);
  return app;
};
let app = makeApp();
let baseUrl = '';
const headers = (auth = bearer, epoch = '1', key: string = crypto.randomUUID()) => ({ authorization: `Bearer ${auth}`, 'x-project-epoch': epoch, 'idempotency-key': key });
const register = (pem: string, extra = {}, auth = bearer, key?: string) => app.inject({ method: 'POST', url: '/api/runner/github/key', headers: headers(auth, '1', key), payload: { ...identity, publicKeyPem: pem, sealedVersion: 1, ...extra } });
const credential = (keyId: string, auth = bearer) => app.inject({ url: `/api/runner/github/credential?keyId=${encodeURIComponent(keyId)}`, headers: headers(auth) });
const gate = () => inEpoch(pool, 1, async c => { const repo = new RunnerRepository(c); await repo.lock(); await assertExternal(repo); });
const report = (body: object) => app.inject({ method: 'POST', url: '/api/runner/github/status', headers: headers(), payload: { mode: 'token', account: 'fake', scopes: verified, expiresAt: null, ...body } });

beforeAll(async () => {
  vi.stubEnv('AWBS_SECRET_KEY', 'ab'.repeat(32));
  await recreateTestDatabase(url.href);
  await runMigrations(owner);
  await seedSystem(owner);
  bearer = await issueRunnerToken(pool, identity.runnerId, generateRunnerKeyPair().publicKey);
  other = await issueRunnerToken(pool, 'other-runner', generateRunnerKeyPair().publicKey);
  const link = await issueLoginLink(pool);
  const login = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { origin }, payload: { method: 'link', token: link } });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  csrf = (await app.inject({ url: '/api/session', headers: { cookie } })).json<{ csrfToken: string }>().csrfToken;
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
});
beforeEach(async () => {
  vi.stubEnv('AWBS_SECRET_KEY', 'ab'.repeat(32));
  await owner.query('set session_replication_role=replica');
  try { await owner.query('truncate projects,github_settings,secrets,idempotency_keys,runner_hosts,external_write_authority cascade'); }
  finally { await owner.query('set session_replication_role=origin'); }
  await owner.query("insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at) values('host-1','boot-1','fake',8,32,0,100,'fake',0,now())");
  await owner.query("insert into external_write_authority(singleton,host_id,generation,state) values(true,'host-1',1,'granted')");
  const put = await app.inject({ method: 'PUT', url: '/api/settings/github', headers: { cookie, origin, 'x-csrf-token': csrf }, payload: { mode: 'token', token, updatedAt: null } });
  expect(put.statusCode, put.body).toBe(200);
});
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); vi.unstubAllEnvs(); });

test('암호화 저장 → 서버 봉인 → 실제 Runner 복호화. 지문·재전송·캐시 금지를 확인한다', async () => {
  const keys = generateRunnerKeyPair();
  const idempotency = crypto.randomUUID();
  const first = await register(keys.publicKey, {}, bearer, idempotency);
  expect(first.statusCode, first.body).toBe(200);
  const keyId = first.json<{ keyId: string }>().keyId;
  expect(keyId).toBe(createHash('sha256').update(runnerPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' })).digest('hex'));
  expect((await register(keys.publicKey, {}, bearer, idempotency)).headers['idempotency-replayed']).toBe('true');
  expect((await register(keys.publicKey)).json()).toEqual({ keyId });
  const sealed = await credential(keyId);
  expect(sealed.statusCode, sealed.body).toBe(200);
  expect(sealed.headers['cache-control']).toBe('no-store');
  expect(Object.keys(sealed.json())).toEqual(['sealed']);
  expect(openSealedCredential(keys.privateKey, sealed.json<{ sealed: string }>().sealed).reveal()).toBe(token);
  expect((await credential(keyId)).body).not.toBe(sealed.body);
  const stored = (await owner.query('select * from secrets')).rows;
  expect(JSON.stringify(stored)).not.toContain(token);
  expect(stored[0]).toMatchObject({ key_version: 1, last4: token.slice(-4) });
  expect((await owner.query("select count(*)::int n from runner_tokens where public_key=$1", [keys.publicKey])).rows[0]?.n).toBe(0);
  expect((await app.inject({ url: '/api/settings/github', headers: { cookie } })).body).not.toMatch(/sealed|ciphertext|nonce|secret_key/);
  expect(logs).not.toContain(token);
  expect(logs).not.toContain(sealed.json<{ sealed: string }>().sealed);
  expect(logs).not.toContain(bearer);
});

test('다른 Runner·신원 바꿔치기·낡은 epoch·재부팅·폐기 토큰을 거부한다', async () => {
  const keys = generateRunnerKeyPair();
  const keyId = (await register(keys.publicKey)).json<{ keyId: string }>().keyId;
  expect((await credential(keyId, other)).statusCode).toBe(404);
  expect((await credential('unknown')).statusCode).toBe(404);
  expect((await register(keys.publicKey, { runnerId: 'other-runner' })).statusCode).toBe(403);
  expect((await register(keys.publicKey, { hostId: 'other-host' })).statusCode).toBe(403);
  expect((await register(keys.publicKey, { bootId: 'other-boot' })).statusCode).toBe(403);
  const path = `/api/runner/github/credential?keyId=${keyId}`;
  expect((await app.inject({ url: path })).statusCode).toBe(401);
  expect((await app.inject({ url: path, headers: { cookie } })).statusCode).toBe(401);
  expect((await app.inject({ url: path, headers: headers(bearer, '0') })).statusCode).toBe(409);
  await owner.query("insert into runner_hosts(host_id,boot_id,cpu,cores,mem_gb,swap_gb,disk_gb,os,samples,seen_at) values('host-1','boot-2','fake',8,32,0,100,'fake',0,now())");
  expect((await credential(keyId)).statusCode).toBe(404);
  const revoked = await issueRunnerToken(pool, identity.runnerId, keys.publicKey);
  await revokeRunnerToken(pool, revoked);
  expect((await credential(keyId, revoked)).statusCode).toBe(401);
});

test('잘못된 PEM·개인키·다른 알고리즘·작은 차수 키는 입력 원문 없이 거부한다', async () => {
  const pair = generateKeyPairSync('ed25519');
  const low = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.alloc(32)]);
  const invalid = [token, pair.publicKey.export({ type: 'spki', format: 'pem' }), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    `-----BEGIN PUBLIC KEY-----\n${low.toString('base64')}\n-----END PUBLIC KEY-----\n`];
  for (const pem of invalid) {
    const result = await register(pem);
    expect(result.statusCode, result.body).toBe(400);
    expect(result.json().error).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'publicKeyPem', rule: 'x25519' }] });
    expect(result.body).not.toContain(pem);
  }
  expect(logs).not.toContain(token);
});

test('owner 명령 그대로: Runner 키 생성 → CLI 승인 → 새 실행 키 등록 → CLI 폐기', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awbs-owner-enroll-'));
  const pem = join(home, 'runner.pub.pem');
  const env = { ...process.env, AWBS_HOME: home, DATABASE_URL: appUrl.href };
  const cwd = resolve(import.meta.dirname, '..');
  const cli = ['--conditions=awbs-source', 'src/platform/auth-cli.ts'];
  try {
    const id = execFileSync(process.execPath, [resolve(import.meta.dirname, '../../../../agent-runner/scripts/runner-public-key.ts'), pem], { env, encoding: 'utf8' }).trim();
    const approved = execFileSync(process.execPath, [...cli, 'runner-token', id, pem], { cwd, env, encoding: 'utf8' }).trim();
    expect(approved).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const saved = (await owner.query('select public_key from runner_tokens where runner_id=$1', [id])).rows[0];
    expect(saved?.public_key).toBe(await readFile(pem, 'utf8'));
    const keyId = (await register(generateRunnerKeyPair().publicKey, { runnerId: id }, approved)).json<{ keyId: string }>().keyId;
    expect((await credential(keyId, approved)).statusCode).toBe(200);
    await writeFile(pem, token);
    const denied = spawnSync(process.execPath, [...cli, 'runner-token', id, pem], { cwd, env, encoding: 'utf8' });
    expect(denied.status).toBe(1);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).not.toContain(token);
    execFileSync(process.execPath, [...cli, 'revoke-runner'], { cwd, env, input: approved });
    expect((await credential(keyId, approved)).statusCode).toBe(401);
    expect(logs).not.toContain(approved);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('저장 키 누락·다른 암호 키·손상된 암호문은 안전한 오류이고 gh 방식에는 토큰을 내주지 않는다', async () => {
  const keys = generateRunnerKeyPair();
  const keyId = (await register(keys.publicKey)).json<{ keyId: string }>().keyId;
  for (const encryption of ['', 'cd'.repeat(32)]) {
    vi.stubEnv('AWBS_SECRET_KEY', encryption);
    const result = await credential(keyId);
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain(token);
    expect(result.body).not.toContain(encryption || 'ciphertext');
  }
  vi.stubEnv('AWBS_SECRET_KEY', 'ab'.repeat(32));
  await owner.query("update secrets set ciphertext='invalid'");
  expect((await credential(keyId)).statusCode).toBe(503);
  await owner.query("update github_settings set mode='gh'");
  expect((await credential(keyId)).statusCode).toBe(404);
  expect(logs).not.toContain(token);
});

test('서버 재시작 뒤 멱등 응답 재생은 등록을 복구하지 않는다. 실제 Runner는 새 키로 복구한다', async () => {
  const keys = generateRunnerKeyPair();
  const api = createApiClient({ baseUrl, token: new Secret(bearer), fetch: (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input);
    target.host = new URL(baseUrl).host;
    return fetch(target, init);
  } });
  const connector = new GithubConnector({ api, epoch: () => 1, identity: () => identity, keyPair: keys, enqueueStatus: async () => undefined });
  expect((await connector.tokenSource().token()).reveal()).toBe(token);
  const idempotency = crypto.randomUUID();
  const keyId = (await register(keys.publicKey, {}, bearer, idempotency)).json<{ keyId: string }>().keyId;
  await app.close();
  app = makeApp();
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const replay = await register(keys.publicKey, {}, bearer, idempotency);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect((await credential(keyId)).statusCode).toBe(404);
  expect((await connector.tokenSource().token()).reveal()).toBe(token);
  expect((await owner.query("select key from idempotency_keys where key like 'github-key:%'")).rows).toHaveLength(2);
});

test('고정 벡터와 서버 봉인은 Runner가 열며 변조·다른 키는 거부한다', () => {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(vector.recipientPrivateHex, 'hex')]), type: 'pkcs8', format: 'der' });
  expect(openSealedCredential(privateKey, vector.sealed).reveal()).toBe(vector.token);
  const sealed = sealGithubCredential(runnerPublicKey(vector.recipientPem), vector.token);
  expect(openSealedCredential(privateKey, sealed).reveal()).toBe(vector.token);
  expect(() => openSealedCredential(generateRunnerKeyPair().privateKey, sealed)).toThrow();
  const tampered = Buffer.from(sealed, 'base64url');
  tampered[45] = (tampered[45] ?? 0) ^ 1;
  expect(() => openSealedCredential(privateKey, tampered.toString('base64url'))).toThrow();
});

test('실제 Runner + fake GitHub: unverified 허용 → 쓰기 403의 missing 차단 → 재확인 복구와 deploy key 차단', async () => {
  await owner.query("insert into projects(name,repo_url,repo_owner,repo_name,lead_instruction,phase) values('알림 시험','https://github.com/o/r','o','r','','active')");
  await owner.query("insert into secrets(key,ciphertext,nonce,key_version,last4) values('telegram-ghcred-test','encrypted','nonce',1,'abcd')");
  await owner.query("insert into notify_settings(enabled,secret_key,chat_id,target_name) values(true,'telegram-ghcred-test','-4123456789','팀장')");
  await owner.query("insert into notify_rules(key,enabled) values('admin',true) on conflict(key) do update set enabled=true");
  const fake = await startFakeGitHub(token);
  const model = new GitHubModel({ owner: 'o', repo: 'r', tokenPermissions: { pulls: 'read' } });
  model.install(fake);
  const api = createApiClient({ baseUrl, token: new Secret(bearer) });
  const connector = new GithubConnector({ api, epoch: () => 1, identity: () => identity,
    enqueueStatus: async body => { await api('reportGithubStatus', { epoch: 1, idempotencyKey: crypto.randomUUID(), body }); } });
  let pending = Promise.resolve();
  const client = createGitHubClient({ repo: { owner: 'o', repo: 'r' }, baseUrl: fake.url, token: () => connector.tokenSource().token(),
    beforeWrite: async () => { await gate(); await client.assertDeployKeys(null); },
    onPermissionDenied: event => { pending = connector.reportPermissionDenied(event, client.permissions(), 'token').then(() => undefined); return pending; } });
  try {
    await expect(gate()).rejects.toMatchObject({ code: 'EXTERNAL_WRITE_BLOCKED' });
    const status = await client.checkConnection('token');
    expect(status).toMatchObject({ ok: true, permissions: { pulls: 'unverified' } });
    await connector.reportConnection(status);
    await expect(gate()).resolves.toBeUndefined();
    await expect(client.ensurePullRequest({ branch: 'agent/test', title: 'fake', body: '' })).rejects.toMatchObject({ status: 403 });
    await pending;
    expect((await owner.query('select status,scopes from github_settings')).rows[0]).toMatchObject({ status: 'failed', scopes: { pulls: 'missing' } });
    expect((await owner.query("select kind,resolved_at from notify_events where dedup_key='admin|github'")).rows).toEqual([{ kind: 'admin', resolved_at: null }]);
    await expect(gate()).rejects.toMatchObject({ code: 'EXTERNAL_WRITE_BLOCKED' });
    const view = await inEpoch(pool, 1, c => runnerState(new RunnerRepository(c)));
    expect(view.externalWrite.state).toBe('blocked');
    await connector.reportConnection(await client.checkConnection('token'));
    expect((await owner.query("select resolved_at from notify_events where dedup_key='admin|github'")).rows[0]?.resolved_at).toBeInstanceOf(Date);
    await expect(gate()).resolves.toBeUndefined();
    model.deployKeys.push({ id: 123, read_only: true });
    const writes = fake.requests.filter(r => r.method !== 'GET').length;
    await expect(client.ensurePullRequest({ branch: 'agent/blocked', title: 'fake', body: '' })).rejects.toThrow('deploy key');
    expect(fake.requests.filter(r => r.method !== 'GET')).toHaveLength(writes);
    expect(logs).not.toContain(token);
    fake.assertNoUnexpected();
  } finally { await fake.close(); }
});

test('3상태 입력 규칙과 만료를 확인하고 봉인 조회로 외부 쓰기 권한이 열리지 않는다', async () => {
  expect((await report({ ok: true, scopes: null })).statusCode).toBe(400);
  expect((await report({ ok: true, scopes: { ...verified, pulls: 'missing' } })).statusCode).toBe(400);
  expect((await report({ ok: true, scopes: { ...verified, pulls: 'unverified' } })).statusCode).toBe(400);
  expect((await report({ ok: true, scopes: { ...verified, pulls: 'unverified' }, warning: '첫 쓰기 때 확인' })).statusCode).toBe(204);
  await expect(gate()).resolves.toBeUndefined();
  expect((await report({ ok: true, expiresAt: '2020-01-01T00:00:00Z' })).statusCode).toBe(204);
  await expect(gate()).rejects.toMatchObject({ code: 'EXTERNAL_WRITE_BLOCKED' });
  const keyId = (await register(generateRunnerKeyPair().publicKey)).json<{ keyId: string }>().keyId;
  expect((await credential(keyId)).statusCode).toBe(200);
  await expect(gate()).rejects.toMatchObject({ code: 'EXTERNAL_WRITE_BLOCKED' });
  await report({ ok: true });
  await owner.query("update external_write_authority set state='blocked'");
  await expect(gate()).rejects.toMatchObject({ code: 'EXTERNAL_WRITE_BLOCKED' });
});

test('연결 실패 중에는 외부 효과 작업을 배정하지 않고 GitHub 재확인 작업은 배정한다', async () => {
  await report({ ok: false, scopes: null });
  await owner.query("insert into runner_jobs(kind,payload,state,epoch,dedup_key) values('bootstrap','{}','queued',1,'blocked'),('github_check','{}','queued',1,'read-check')");
  const job = await inEpoch(pool, 1, c => claim(new RunnerRepository(c), ['bootstrap', 'github_check'], 1, 1, `runner:${identity.runnerId}`));
  expect(job?.kind).toBe('github_check');
  expect((await owner.query("select state from runner_jobs where dedup_key='blocked'")).rows).toEqual([{ state: 'queued' }]);
});
