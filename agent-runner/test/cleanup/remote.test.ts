import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createGithubRemoteCleanup, RepositoryMismatch, SystemCredentialMissing } from '../../src/cleanup/remote.ts';
import { createGitHubClient, type WriteOperation } from '../../src/github/client.ts';
import type { GitRepository } from '../../src/git/repository.ts';
import { Secret } from '../../src/security/secret.ts';
import { GitHubModel } from '../fakes/github/model.ts';
import { startFakeGitHub, type FakeGitHub } from '../fakes/github/server.ts';

const TOKEN = 'ghp_FAKEremoteCleanup0123456789abcd';
/** fake 모델 저장소(o/r)의 주소. 대소문자·끝 .git·끝 / 차이는 같은 저장소로 본다. */
const URL_ = 'https://github.com/O/r.git/';
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
  await createGithubRemoteCleanup({ client: client() }).closePullRequests(URL_, [open.number, closed.number, 99]);
  expect(model.pulls.get(open.number)?.state).toBe('closed');
  expect(writes).toEqual([{ kind: 'pull_close', pr: open.number }]);
});

test('기록된 Agent 브랜치만 지우고, 이미 없는 브랜치는 성공으로 본다', async () => {
  model.push('agent/T1-h1');
  await createGithubRemoteCleanup({ client: client() }).deleteBranches(URL_, ['agent/T1-h1', 'agent/gone']);
  expect(model.branches.has('agent/T1-h1')).toBe(false);
  expect(model.branches.has('main')).toBe(true);
  expect(writes).toEqual([{ kind: 'branch_delete', branch: 'agent/T1-h1' }, { kind: 'branch_delete', branch: 'agent/gone' }]);
  await expect(client().deleteBranch('main')).rejects.toThrow();
});

test('targetsMatch: 초기화 대상(src·contracts·.agentwbs)이 기준과 같으면 true, 달라지면 false', async () => {
  const base = model.branches.get('main') ?? '';
  const remote = createGithubRemoteCleanup({ client: client() });
  model.push('main', ['docs/new.md']);
  expect(await remote.targetsMatch(URL_, base)).toBe(true);
  model.push('main', ['src/b.ts']);
  expect(await remote.targetsMatch(URL_, base)).toBe(false);
});

test('M4-06 pushReset: 시스템 키 목록을 매번 확인하고, 다른 키가 있으면 경고 후 전송하지 않는다', async () => {
  const parent = 'a'.repeat(40); const next = 'b'.repeat(40);
  const pushSystemCommit = vi.fn().mockResolvedValue(undefined);
  const repo = { pushSystemCommit } as unknown as GitRepository;
  model.branches.set('main', parent);
  await expect(createGithubRemoteCleanup({ client: client() }).pushReset(URL_, repo, next, parent)).rejects.toBeInstanceOf(SystemCredentialMissing);
  const warnings: string[] = [];
  const systemDeployKey = { id: 7, socket: '/run/system.sock', knownHosts: '/home/test/github-known-hosts' };
  const withKey = createGithubRemoteCleanup({ client: client(), systemDeployKey, warn: (text) => { warnings.push(text); } });
  model.deployKeys.push({ id: 7, read_only: false });
  await expect(withKey.pushReset(URL_, repo, next, 'f'.repeat(40))).rejects.toThrow(/원격 main/);
  expect(pushSystemCommit).not.toHaveBeenCalled();
  await withKey.pushReset(URL_, repo, next, parent);
  expect(pushSystemCommit).toHaveBeenCalledWith(next, parent, systemDeployKey);
  model.deployKeys.push({ id: 8, read_only: true });
  await expect(withKey.pushReset(URL_, repo, next, parent)).rejects.toThrow(/시스템 키 외/);
  expect(pushSystemCommit).toHaveBeenCalledTimes(1);
  expect(warnings).toEqual([expect.stringContaining('시스템 키 외')]);
});

test('이중 방어 2단계: 실행기는 명령 저장소가 자기 저장소와 다르면 어떤 요청도 보내지 않는다', async () => {
  model.push('agent/T1-h1');
  const pr = model.openPull('agent/T1-h1').number;
  const remote = createGithubRemoteCleanup({ client: client(), systemDeployKey: { id: 7, socket: '/run/system.sock', knownHosts: '/home/test/known-hosts' } });
  const foreign = 'https://github.com/foreign/previous';
  const before = github.requests.length;
  await expect(remote.closePullRequests(foreign, [pr])).rejects.toBeInstanceOf(RepositoryMismatch);
  await expect(remote.deleteBranches(foreign, ['agent/T1-h1'])).rejects.toBeInstanceOf(RepositoryMismatch);
  await expect(remote.targetsMatch(foreign, 'a'.repeat(40))).rejects.toBeInstanceOf(RepositoryMismatch);
  await expect(remote.pushReset(foreign, {} as never, 'a'.repeat(40), 'b'.repeat(40))).rejects.toBeInstanceOf(RepositoryMismatch);
  expect(github.requests.length).toBe(before);
  expect(writes).toEqual([]);
  expect(model.pulls.get(pr)?.state).toBe('open');
  expect(model.branches.has('agent/T1-h1')).toBe(true);
});

test('브랜치 삭제 422·409 거절은 실패다. 다시 조회해 참조가 없을 때(404)만 성공으로 본다', async () => {
  model.push('agent/kept');
  for (const status of [422, 409]) {
    github.on('DELETE /repos/o/r/git/refs/heads/agent/kept', () => ({ status, body: { message: 'Reference update failed' } }));
    await expect(client().deleteBranch('agent/kept')).rejects.toThrow();
  }
  expect(model.branches.has('agent/kept')).toBe(true);
  // 실제로 없는 브랜치에 422가 와도 조회가 404이면 지운 것과 같다.
  github.on('DELETE /repos/o/r/git/refs/heads/agent/gone', () => ({ status: 422, body: { message: 'Reference does not exist' } }));
  await expect(client().deleteBranch('agent/gone')).resolves.toBeUndefined();
});
