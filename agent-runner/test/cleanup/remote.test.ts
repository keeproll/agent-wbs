import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createGithubRemoteCleanup, SystemCredentialMissing } from '../../src/cleanup/remote.ts';
import { createGitHubClient, type WriteOperation } from '../../src/github/client.ts';
import { GitRepository } from '../../src/git/repository.ts';
import { Secret } from '../../src/security/secret.ts';
import { GitHubModel } from '../fakes/github/model.ts';
import { startFakeGitHub, type FakeGitHub } from '../fakes/github/server.ts';

const TOKEN = 'ghp_FAKEremoteCleanup0123456789abcd';
let github: FakeGitHub;
let model: GitHubModel;
let home: string;
let writes: WriteOperation[];
beforeEach(async () => {
  github = await startFakeGitHub(TOKEN);
  model = new GitHubModel({ files: ['src/a.ts', 'contracts/api.json', 'README.md'] });
  model.install(github);
  home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'remote-cleanup-'));
  writes = [];
});
afterEach(async () => { await github.close(); await rm(home, { recursive: true, force: true }); });
const client = () => createGitHubClient({ baseUrl: github.url, repo: { owner: model.owner, repo: model.repo }, token: () => Promise.resolve(new Secret(TOKEN)),
  beforeWrite: (op) => { writes.push(op); return Promise.resolve(); } });

test('열린 PR만 닫고, 이미 닫힌·없는 PR은 건너뛴다', async () => {
  const open = model.openPull('agent/T1-h1');
  const closed = model.openPull('agent/T2-h1');
  closed.state = 'closed';
  await createGithubRemoteCleanup({ client: client() }).closePullRequests([open.number, closed.number, 99]);
  expect(model.pulls.get(open.number)?.state).toBe('closed');
  expect(writes).toEqual([{ kind: 'pull_close', pr: open.number }]);
});

test('기록된 Agent 브랜치만 지우고, 이미 없는 브랜치는 성공으로 본다', async () => {
  model.push('agent/T1-h1');
  await createGithubRemoteCleanup({ client: client() }).deleteBranches(['agent/T1-h1', 'agent/gone']);
  expect(model.branches.has('agent/T1-h1')).toBe(false);
  expect(model.branches.has('main')).toBe(true);
  expect(writes).toEqual([{ kind: 'branch_delete', branch: 'agent/T1-h1' }, { kind: 'branch_delete', branch: 'agent/gone' }]);
  await expect(client().deleteBranch('main')).rejects.toThrow();
});

test('targetsMatch: 초기화 대상(src·contracts·.agentwbs)이 기준과 같으면 true, 달라지면 false', async () => {
  const base = model.branches.get('main') ?? '';
  const remote = createGithubRemoteCleanup({ client: client() });
  model.push('main', ['docs/new.md']);
  expect(await remote.targetsMatch(base)).toBe(true);
  model.push('main', ['src/b.ts']);
  expect(await remote.targetsMatch(base)).toBe(false);
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' } }).trim();
}

test('pushReset: 시스템 커밋 자격 증명이 없으면 보내지 않고, 원격 main이 부모와 다르면 보내지 않고, 맞으면 일반 push한다', async () => {
  const source = join(home, 'source');
  await mkdir(join(source, 'src'), { recursive: true });
  git(source, 'init', '-b', 'main'); await writeFile(join(source, 'src/a'), '1'); git(source, 'add', '.'); git(source, 'commit', '-m', 'a');
  const parent = git(source, 'rev-parse', 'HEAD');
  const remote = join(home, 'remote.git'); git(source, 'clone', '--bare', source, remote);
  const repo = await GitRepository.clone(home, 'p1', remote);
  await writeFile(join(source, 'src/a'), '2'); git(source, 'commit', '-am', 'b');
  const next = git(source, 'rev-parse', 'HEAD');
  git(repo.path, 'fetch', source, 'main');
  model.branches.set('main', parent);
  await expect(createGithubRemoteCleanup({ client: client() }).pushReset(repo, next, parent)).rejects.toBeInstanceOf(SystemCredentialMissing);
  const auth: string[] = [];
  const withAuth = createGithubRemoteCleanup({ client: client(), systemCommitAuthorization: () => { auth.push('asked'); return Promise.resolve('Bearer system'); } });
  await expect(withAuth.pushReset(repo, next, 'f'.repeat(40))).rejects.toThrow(/원격 main/);
  expect(git(remote, 'rev-parse', 'main')).toBe(parent);
  await withAuth.pushReset(repo, next, parent);
  expect(git(remote, 'rev-parse', 'main')).toBe(next);
  expect(auth.length).toBe(2);
});
