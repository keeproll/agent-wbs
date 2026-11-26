/** M4-06 전용. 일반 test에서는 실행하지 않는다. 원격 쓰기는 아래 시험 저장소만 허용한다. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { createGitHubClient } from '../src/github/client.ts';
import { ghTokenSource } from '../src/github/token.ts';
import { createGithubRemoteCleanup } from '../src/cleanup/remote.ts';
import { createRedactor } from '../src/security/redact.ts';
import { Secret } from '../src/security/secret.ts';
import { GitRepository } from '../src/git/repository.ts';

const repo = { owner: 'keeproll', repo: 'agent-wbs-sandbox' };
const path = `/repos/${repo.owner}/${repo.repo}`;
const https = `https://github.com/${repo.owner}/${repo.repo}.git`;
const archive = resolve(process.argv.filter((arg) => arg !== '--')[2] ?? '');
assert(archive.startsWith('/home/keeproll/.orca/bots/agentwbs/archive/2026-11-26/M4-06/'), '지정된 증거 폴더 아래의 새 실행 폴더가 필요합니다.');
await mkdir(archive, { recursive: true, mode: 0o700 });
const evidence = join(archive, 'api.ndjson');
assert.equal(await readFile(evidence, 'utf8').catch(() => ''), '', '기존 실행 증거를 덮어쓰지 않습니다.');
const token = await ghTokenSource().token();
const input = process.argv.includes('--tokens') ? createInterface({ input: process.stdin }) : undefined;
const lines = input?.[Symbol.asyncIterator]();
let supplied: { write: Secret; read: Secret } | undefined;
if (lines) {
  let values: { write?: string; read?: string };
  try { values = JSON.parse(String((await lines.next()).value)) as typeof values; }
  catch { throw new Error('토큰 입력 형식이 올바르지 않습니다. 원문은 기록하지 않습니다.'); }
  assert(typeof values.write === 'string' && typeof values.read === 'string', '시험 전용 fine-grained 토큰 두 개가 필요합니다.');
  assert(values.write.startsWith('github_pat_') && values.read.startsWith('github_pat_'), 'fine-grained 토큰 형식이 필요합니다.');
  supplied = { write: new Secret(values.write), read: new Secret(values.read) };
}
const redact = createRedactor([token.reveal(), ...(supplied ? [supplied.write.reveal(), supplied.read.reveal()] : [])]);
const work = await mkdtemp(join(tmpdir(), 'agentwbs-m4-06-'));
const results: Record<string, unknown> = { repository: https, startedAt: new Date().toISOString(),
  deferred: 'owner 결정 10: 다른 작성자·비관리자 검증은 팀원 합류 때 진행' };
const branches: string[] = [];
const prs: number[] = [];
let keyId: number | undefined;
let extraKeyId: number | undefined;
let agent: Record<string, string> = {};
let baseline: string | undefined;
let fixtureRoot: string | undefined;
let lastMain: string | undefined;
let resetNeeded = false;
let dropped = false;

async function run(command: string, args: string[], input?: string, extra: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(command, args, {
      cwd: work,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', ...extra },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', () => { reject(new Error(`${command} 실행 실패`)); });
    child.on('close', (code) => { accept({ code: code ?? -1, stdout, stderr }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

async function record(name: string, value: unknown) {
  results[name] = value;
  await writeFile(join(archive, 'results.json'), redact(JSON.stringify(results, null, 2)) + '\n', { mode: 0o600 });
}

const auditedFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://api.github.com');
  assert(url.pathname === '/user' || url.pathname === '/meta' || url.pathname === path || url.pathname.startsWith(`${path}/`));
  if (init?.method && init.method !== 'GET') assert(url.pathname.startsWith(`${path}/`));
  const response = await fetch(url, { ...init, redirect: 'manual' });
  const body = await response.clone().text();
  const headers = Object.fromEntries([...response.headers].filter(([name]) =>
    /^(x-github-request-id|x-oauth-scopes|x-accepted-github-permissions|github-authentication-token-expiration|x-ratelimit-|retry-after|link)/.test(name)));
  await appendFile(evidence, redact(JSON.stringify({ at: new Date().toISOString(), method: init?.method ?? 'GET',
    path: url.pathname + url.search, request: init?.body ? JSON.parse(String(init.body)) as unknown : null,
    status: response.status, headers, body: body === '' ? null : JSON.parse(body) as unknown })) + '\n', { mode: 0o600 });
  // GitHub는 실제 병합했다. 이 프로세스에서만 응답을 버려 재조회 경로를 검증한다.
  if (dropped && init?.method === 'PUT' && url.pathname.endsWith('/merge') && response.status === 200) {
    dropped = false;
    throw new Error('M4-06 응답 유실 주입');
  }
  return response;
};

const client = createGitHubClient({ repo, token: () => Promise.resolve(token), fetch: auditedFetch });
const cleanup = createGithubRemoteCleanup({ client });

async function api<T>(method: string, endpoint: string, body?: unknown, expected = 200, credential = token): Promise<T> {
  const response = await auditedFetch(`https://api.github.com${endpoint}`, {
    method,
    headers: { authorization: `Bearer ${credential.reveal()}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, expected, `${method} ${endpoint}`);
  return (expected === 204 ? undefined : await response.json()) as T;
}

async function git(args: string[], extra: Record<string, string> = {}, input?: string) {
  return run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Agent WBS Sandbox', '-c', 'user.email=agentwbs@localhost', ...args], input,
  { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra });
}

async function push(sha: string, system: boolean) {
  if (system) {
    assert(keyId !== undefined);
    await client.assertDeployKeys(keyId);
  }
  const remote = system ? 'ssh://git@ssh.github.com:443/keeproll/agent-wbs-sandbox.git' : https;
  const auth = system ? agent : { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${Buffer.from(`x-access-token:${token.reveal()}`).toString('base64')}` };
  const result = await git(['push', '--no-verify', '--', remote, `${sha}:refs/heads/main`], auth);
  return { code: result.code, stdout: redact(result.stdout), stderr: redact(result.stderr) };
}

async function commit(parent: string, file: string) {
  const tree = await api<{ sha: string }>('POST', `${path}/git/trees`, { base_tree: parent,
    tree: [{ path: file, mode: '100644', type: 'blob', content: `M4-06 ${new Date().toISOString()}\n` }] }, 201);
  return (await api<{ sha: string }>('POST', `${path}/git/commits`, { message: `M4-06: ${file}`, tree: tree.sha, parents: [parent] }, 201)).sha;
}

async function pull(label: string, parent: string, file = `src/${label}.txt`) {
  const branch = `agent/M4-06-${label}-${Date.now()}`;
  branches.push(branch);
  const head = await commit(parent, file);
  await api('POST', `${path}/git/refs`, { ref: `refs/heads/${branch}`, sha: head }, 201);
  const pr = await client.ensurePullRequest({ branch, title: `M4-06 ${label}`, body: '자동 실증용 가짜 입력입니다. Agent 호출은 없습니다.' });
  prs.push(pr.number);
  // mergeable 계산은 비동기다. 정해진 횟수가 지나도 ready가 아니면 실증 실패로 남긴다.
  await ready(pr.number, head);
  return { branch, head, pr: pr.number };
}

async function ready(pr: number, head: string, clean = false) {
  for (let count = 0; count < 20; count++) {
    const state = await api<{ head: { sha: string }; mergeable: boolean | null; mergeable_state: string }>('GET', `${path}/pulls/${pr}`);
    if (state.head.sha === head && state.mergeable !== null && (!clean || state.mergeable_state === 'clean')) return;
    await delay(1000);
  }
  throw new Error('GitHub 병합 가능 여부 계산이 끝나지 않았습니다.');
}

async function merge(pr: number, base: string, head: string) {
  const outcome = await client.mergePullRequest({ pr, baseSha: base, headSha: head });
  if (outcome.kind === 'merged') {
    lastMain = outcome.mergeSha;
    resetNeeded = true;
  }
  return outcome;
}

try {
  await record('connection', await client.checkConnection('gh'));
  const existingKeys = await api<unknown[]>('GET', `${path}/keys`);
  assert.equal(existingKeys.length, 0, '다른 deploy key가 있으면 우회 범위를 넓히지 않고 중단합니다.');
  const generated = await run('python3', ['-c', [
    'import json',
    'from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey',
    'from cryptography.hazmat.primitives.serialization import Encoding,PrivateFormat,PublicFormat,NoEncryption',
    'k=Ed25519PrivateKey.generate()',
    'print(json.dumps({"private":k.private_bytes(Encoding.PEM,PrivateFormat.OpenSSH,NoEncryption()).decode(),"public":k.public_key().public_bytes(Encoding.OpenSSH,PublicFormat.OpenSSH).decode()}))',
  ].join('\n')]);
  assert.equal(generated.code, 0, '메모리 키 생성 실패');
  const key = JSON.parse(generated.stdout) as { private: string; public: string };
  const ssh = await run('ssh-agent', ['-s']);
  assert.equal(ssh.code, 0);
  const socket = /SSH_AUTH_SOCK=([^;]+)/.exec(ssh.stdout)?.[1];
  const pid = /SSH_AGENT_PID=(\d+)/.exec(ssh.stdout)?.[1];
  assert(socket && pid);
  agent = { SSH_AUTH_SOCK: socket, SSH_AGENT_PID: pid };
  assert.equal((await run('ssh-add', ['-'], key.private, agent)).code, 0);
  key.private = '';
  const meta = await api<{ ssh_keys: string[] }>('GET', '/meta');
  await writeFile(join(work, 'known_hosts'), meta.ssh_keys.map((entry) => `[ssh.github.com]:443 ${entry}`).join('\n') + '\n');
  agent.GIT_SSH_COMMAND = `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${join(work, 'known_hosts')}`;
  keyId = (await api<{ id: number }>('POST', `${path}/keys`, { title: `M4-06 ephemeral ${Date.now()}`, key: key.public, read_only: false }, 201)).id;
  await record('deployKey', { id: keyId, privateKeyStorage: 'ssh-agent memory only' });
  await client.assertDeployKeys(keyId);
  const extra = await run('python3', ['-c',
    'from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey; from cryptography.hazmat.primitives.serialization import Encoding,PublicFormat; print(Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.OpenSSH,PublicFormat.OpenSSH).decode())']);
  assert.equal(extra.code, 0);
  extraKeyId = (await api<{ id: number }>('POST', `${path}/keys`, { title: 'M4-06 other-key rejection', key: extra.stdout.trim(), read_only: true }, 201)).id;
  try {
    await assert.rejects(client.assertDeployKeys(keyId), /시스템 키 외/);
    await record('otherDeployKeyDenied', { systemKeyId: keyId, otherKeyId: extraKeyId, blocked: true });
  } finally {
    await api('DELETE', `${path}/keys/${extraKeyId}`, undefined, 204);
    extraKeyId = undefined;
  }
  await client.assertDeployKeys(keyId);
  const rules = { name: 'agentwbs M4-06 main', target: 'branch', enforcement: 'active',
    bypass_actors: [{ actor_type: 'DeployKey', actor_id: null, bypass_mode: 'always' }],
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [ { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true,
        require_code_owner_review: true, require_last_push_approval: false, required_review_thread_resolution: true } },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'agentwbs/int' }],
        strict_required_status_checks_policy: true, do_not_enforce_on_create: false } } ] };
  // 우회 키도 강제 push·main 삭제는 할 수 없도록, 이 두 규칙은 우회 없는 별도 묶음에 둔다.
  const integrity = { ...rules, name: 'agentwbs M4-06 main integrity', bypass_actors: [],
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] };
  const currentRules = await api<{ id: number; name: string }[]>('GET', `${path}/rulesets`);
  assert(currentRules.every((rule) => [rules.name, integrity.name].includes(rule.name)), '다른 보호 규칙이 있으면 중단합니다.');
  for (const desired of [integrity, rules]) {
    const rule = currentRules.find((entry) => entry.name === desired.name);
    await record(desired === rules ? 'ruleset' : 'integrityRuleset',
      await api(rule ? 'PUT' : 'POST', rule ? `${path}/rulesets/${rule.id}` : `${path}/rulesets`, desired, rule ? 200 : 201));
  }
  assert.equal((await git(['init', '-b', 'main'])).code, 0);
  baseline = await client.mainSha() ?? undefined;
  if (!baseline) {
    const files = { 'prototype/uiux/index.html': '<!doctype html><html lang="ko"><title>M4-06 가짜 입력</title><p>시험 자료</p></html>\n',
      'prototype/docs/guide.md': '# M4-06 가짜 입력\n시험 저장소의 가짜 설계 문서입니다.\n',
      'src/.gitkeep': '', 'contracts/.gitkeep': '', '.agentwbs/pipeline.yaml': '# M4-06 시험용. 실행하지 않습니다.\n',
      '.agentwbs/m4-06.json': '{"milestone":"M4-06","fixture":true}\n',
      '.github/CODEOWNERS': '/prototype/ @keeproll\n/.agentwbs/ @keeproll\n/.github/CODEOWNERS @keeproll\n' };
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(join(work, file, '..'), { recursive: true });
      await writeFile(join(work, file), contents);
    }
    assert.equal((await git(['add', '.'])).code, 0);
    assert.equal((await git(['commit', '-m', 'M4-06: 시험 저장소 최초 구조 생성'])).code, 0);
    baseline = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const initial = await push(baseline, true);
    await record('initialSystemPush', { sha: baseline, ...initial });
    assert.equal(initial.code, 0);
  } else {
    const fixture = await api<{ content: string }>('GET', `${path}/contents/.agentwbs/m4-06.json?ref=main`);
    assert.equal(JSON.parse(Buffer.from(fixture.content, 'base64').toString()).milestone, 'M4-06');
    assert.equal((await git(['fetch', '--', https, 'main'])).code, 0);
  }
  fixtureRoot = (await git(['rev-list', '--max-parents=0', baseline])).stdout.trim();
  assert.match(fixtureRoot, /^[0-9a-f]{40}$/);
  await record('fixtureRoot', fixtureRoot);
  lastMain = baseline;
  await record('repositoryCheck', await client.checkRepository());
  await record('effectiveRules', await api('GET', `${path}/rules/branches/main`));

  const a = await pull('normal', baseline);
  const noStatus = await merge(a.pr, baseline, a.head);
  await record('requiredStatusDenied', noStatus);
  assert.equal(noStatus.kind, 'rejected');
  await client.setCommitStatus({ sha: a.head, context: 'agentwbs/int', state: 'success' });
  await record('statuses', await client.listCommitStatuses(a.head));
  const changedHead = await commit(a.head, 'src/changed-head.txt');
  await api('PATCH', `${path}/git/refs/heads/${a.branch}`, { sha: changedHead });
  await ready(a.pr, changedHead);
  await client.setCommitStatus({ sha: changedHead, context: 'agentwbs/int', state: 'success' });
  await ready(a.pr, changedHead, true);
  const changed = await merge(a.pr, baseline, a.head);
  await record('headChanged', changed);
  assert.equal(changed.kind, 'head_changed');
  const normal = await merge(a.pr, baseline, changedHead);
  await record('normalMerge', normal);
  assert.equal(normal.kind, 'merged');

  const outdated = await pull('outdated', baseline);
  await client.setCommitStatus({ sha: outdated.head, context: 'agentwbs/int', state: 'success' });
  const strict = await merge(outdated.pr, lastMain, outdated.head);
  await record('strictDenied', strict);
  assert.equal(strict.kind, 'rejected');

  const protectedPull = await pull('codeowners', lastMain, '.agentwbs/requires-owner.yaml');
  await client.setCommitStatus({ sha: protectedPull.head, context: 'agentwbs/int', state: 'success' });
  const protectedResult = await merge(protectedPull.pr, lastMain, protectedPull.head);
  await record('codeownersOwnerAuthor', { ...protectedResult,
    limitation: 'CODEOWNERS에 지정된 owner가 직접 작성한 PR입니다. 다른 작성자의 보호 경로 변경 거부는 별도 계정이 필요합니다.' });

  const lost = await pull('response-lost', lastMain);
  await client.setCommitStatus({ sha: lost.head, context: 'agentwbs/int', state: 'success' });
  await ready(lost.pr, lost.head, true);
  dropped = true;
  const recovered = await merge(lost.pr, lastMain, lost.head);
  await record('responseLostReconciled', recovered);
  assert.equal(recovered.kind, 'merged');
  assert.equal(recovered.reconciled, true);
  lastMain = recovered.mergeSha;
  if (supplied) {
    const credentials = supplied;
    const reader = createGitHubClient({ repo, token: () => Promise.resolve(credentials.read), fetch: auditedFetch });
    const writer = createGitHubClient({ repo, token: () => Promise.resolve(credentials.write), fetch: auditedFetch });
    await record('fineGrainedReadConnection', await reader.checkConnection('token'));
    await record('fineGrainedWriteConnection', await writer.checkConnection('token'));
    await record('fineGrainedUnverified', writer.permissions());
    const branch = `agent/M4-06-permissions-${Date.now()}`;
    branches.push(branch);
    const head = await commit(lastMain, 'src/permissions.txt');
    await api('POST', `${path}/git/refs`, { ref: `refs/heads/${branch}`, sha: head }, 201);
    await assert.rejects(reader.ensurePullRequest({ branch, title: 'M4-06 권한 시험', body: '' }), { status: 403 });
    await assert.rejects(reader.setCommitStatus({ sha: head, context: 'agentwbs/int', state: 'success' }), { status: 403 });
    const pr = await writer.ensurePullRequest({ branch, title: 'M4-06 권한 시험', body: '' });
    prs.push(pr.number);
    await ready(pr.number, head);
    await assert.rejects(reader.mergePullRequest({ pr: pr.number, baseSha: lastMain, headSha: head }), { status: 403 });
    await record('fineGrainedMissing', reader.permissions());
    for (const permission of ['contents', 'pulls', 'statuses'] as const) assert.equal(reader.permissions()[permission], 'missing');
    await writer.setCommitStatus({ sha: head, context: 'agentwbs/int', state: 'success' });
    await ready(pr.number, head, true);
    const merged = await writer.mergePullRequest({ pr: pr.number, baseSha: lastMain, headSha: head });
    if (merged.kind === 'merged') lastMain = merged.mergeSha;
    await record('fineGrainedMerge', merged);
    assert.equal(merged.kind, 'merged');
    await record('fineGrainedVerified', writer.permissions());
    for (const permission of ['contents', 'pulls', 'statuses'] as const) assert.equal(writer.permissions()[permission], 'verified');
  } else {
    await record('fineGrainedAndTokenRevocation', { state: 'pending', reason: 'owner가 발급한 한정 토큰과 폐기 후 401 확인이 필요합니다.' });
  }
} catch (error) {
  await record('failure', redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  // contracts §6: 기록한 PR 닫기 → 기록한 Agent 브랜치 삭제 → 일반 되돌림 push.
  try {
    await cleanup.closePullRequests(https, prs);
    await cleanup.deleteBranches(https, branches);
    await record('remoteCleanup', { prs, branches, closedAndDeleted: true });
    if (baseline && lastMain && resetNeeded) {
      assert.equal(await client.mainSha(), lastMain, '예상하지 못한 main 변경은 되돌리지 않습니다.');
      assert(fixtureRoot);
      const entries = await client.topLevelEntries(fixtureRoot);
      const tree = await api<{ sha: string }>('POST', `${path}/git/trees`, { base_tree: lastMain,
        tree: ['src', 'contracts', '.agentwbs'].map((target) => ({ path: target, mode: '040000', type: 'tree', sha: entries[target] })) }, 201);
      const reset = await api<{ sha: string }>('POST', `${path}/git/commits`, {
        message: 'M4-06: 초기화 기준으로 되돌림', tree: tree.sha, parents: [lastMain] }, 201);
      assert.equal((await git(['fetch', '--', https, reset.sha])).code, 0);
      const denied = await push(reset.sha, false);
      await record('ordinaryDirectPushDenied', { sha: reset.sha, ...denied });
      assert.notEqual(denied.code, 0);
      assert.equal(await client.mainSha(), lastMain);
      assert(keyId !== undefined && agent.SSH_AUTH_SOCK);
      const managed = await GitRepository.clone(join(work, 'runner'), 'sandbox', https);
      assert.equal((await git(['-C', managed.path, 'fetch', '--', https, reset.sha])).code, 0);
      await createGithubRemoteCleanup({ client, systemDeployKey: { id: keyId, socket: agent.SSH_AUTH_SOCK,
        knownHosts: join(work, 'known_hosts') } }).pushReset(https, managed, reset.sha, lastMain);
      await record('systemResetPush', { sha: reset.sha, parent: lastMain, baseline: fixtureRoot, tree: tree.sha, code: 0,
        adapter: 'createGithubRemoteCleanup.pushReset -> GitRepository.pushSystemCommit' });
      assert.equal(await client.mainSha(), reset.sha);
      lastMain = reset.sha;
    }
  } catch (error) {
    await record('cleanupFailure', redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
  try {
    if (extraKeyId !== undefined) await api('DELETE', `${path}/keys/${extraKeyId}`, undefined, 204);
    if (keyId !== undefined) {
      await api('DELETE', `${path}/keys/${keyId}`, undefined, 204);
      keyId = undefined;
      if (lastMain) {
        // 폐기 검사는 사전 목록 검사 대신 같은 SSH 키로 실제 인증을 다시 시도한다.
        const rejected = await git(['push', '--no-verify', '--', 'ssh://git@ssh.github.com:443/keeproll/agent-wbs-sandbox.git', `${lastMain}:refs/heads/main`], agent);
        await record('revokedDeployKeyDenied', rejected);
        assert.notEqual(rejected.code, 0);
      }
    }
  } catch (error) {
    await record('keyCleanupFailure', redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
  if (agent.SSH_AGENT_PID) await run('ssh-agent', ['-k'], undefined, agent);
  await rm(work, { recursive: true, force: true });
  if (supplied && lines) {
    console.log('토큰 검사 종료. 이번 시험용 토큰 두 개를 GitHub에서 삭제한 뒤 입력 도우미에 폐기완료를 입력하세요.');
    try {
      assert.equal((await lines.next()).value, 'revoked', '폐기 확인 입력이 필요합니다.');
      await api('GET', '/user', undefined, 401, supplied.write);
      await api('GET', '/user', undefined, 401, supplied.read);
      await record('revokedTokens401', true);
    } catch (error) {
      await record('tokenRevocationFailure', redact(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  }
  input?.close();
  await record('finishedAt', new Date().toISOString());
  console.log(JSON.stringify({ archive, failed: process.exitCode === 1, pending: supplied ? null : 'fine-grained 토큰·폐기 401 실증', deferred: results.deferred }));
  process.exitCode ??= supplied ? 0 : 2;
}
