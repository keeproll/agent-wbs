import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { GitRepository } from '../../src/git/repository.ts';

let root: string;
let source: string;
let repo: GitRepository;
let base: string;
let head: string;
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' },
  }).trim();
}
async function commit(name: string, value: string) {
  await writeFile(join(source, name), value);
  git(source, 'add', '-A'); git(source, 'commit', '-m', name);
  return git(source, 'rev-parse', 'HEAD');
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ci-int-git-'));
  source = join(root, 'source'); await mkdir(source);
  git(source, 'init', '-b', 'main');
  await commit('shared', 'original');
  git(source, 'checkout', '-b', 'agent/task');
  head = await commit('task', 'task');
  git(source, 'checkout', 'main');
  base = await commit('main', 'main');
  const remote = join(root, 'remote.git');
  git(source, 'clone', '--bare', source, remote);
  repo = await GitRepository.clone(join(root, 'runner'), 'project', remote);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('H→H′는 부모 H,A와 자동 병합 tree가 일치할 때만 QA 근거를 잇는다', async () => {
  const synced = await repo.prepareIntegration(base, head);
  expect(synced).not.toBeNull();
  if (!synced) throw new Error('자동 병합 실패');
  const proof = await repo.integrationProof(base, head, synced);
  expect(proof).toMatchObject({ qaHeadSha: head, headSha: synced, preserved: true,
    parents: [head, base], additionalChanges: false });
  expect(proof?.autoMergeTreeSha).toBe(git(source, '--git-dir', repo.path, 'rev-parse', `${synced}^{tree}`));
  expect(await repo.integrationProof(base, head, head)).toBeNull();
});

test('H′에 추가 변경을 넣거나 부모를 바꾸면 거부한다', async () => {
  git(source, 'checkout', 'agent/task'); git(source, 'merge', '--no-ff', 'main', '-m', 'sync');
  const work = await repo.createWorktree('forge', 'agent/forge', base);
  await writeFile(join(work, 'forged'), '추가 변경');
  git(work, 'add', '-A'); git(work, 'commit', '-m', 'forged');
  const forged = await repo.importWorktree('forge', 'agent/forge');
  const tree = await repo.commitTree(forged);
  const bad = git(source, '--git-dir', repo.path, 'commit-tree', tree, '-p', head, '-p', base, '-m', 'forged sync');
  expect(await repo.integrationProof(base, head, bad)).toBeNull();
  expect(await repo.integrationProof(base, head, forged)).toBeNull();
});

test('충돌이면 H′를 만들지 않고 이미 main을 포함한 H는 그대로 쓴다', async () => {
  git(source, 'checkout', 'agent/task');
  const changedHead = await commit('shared', 'task change');
  git(source, 'checkout', 'main');
  const changedBase = await commit('shared', 'main change');
  git(source, 'push', join(root, 'remote.git'), 'main', 'agent/task');
  await repo.fetch(); await repo.fetchBranch('agent/task');
  expect(await repo.prepareIntegration(changedBase, changedHead)).toBeNull();
  expect(await repo.prepareIntegration(base, changedBase)).toBe(changedBase);
  expect(await repo.integrationProof(base, changedBase, changedBase)).toBeNull();
});

test('원격 결과 브랜치를 가져오고 main과 임의 ref는 받지 않는다', async () => {
  expect(await repo.fetchBranch('agent/task')).toBe(head);
  await expect(repo.fetchBranch('main')).rejects.toThrow();
  await expect(repo.fetchBranch('agent/../main')).rejects.toThrow();
});
