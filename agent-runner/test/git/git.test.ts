import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { GitRepository } from '../../src/git/repository.ts';

const archive = '/home/keeproll/.orca/bots/agentwbs/archive/2026-11-26/M4-03';
let root: string;
let source: string;
let remote: string;
let baseline: string;
let repo: GitRepository;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=시험', '-c', 'user.email=test@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' },
  }).trim();
}

async function file(path: string, text = path) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

async function commit(message = '시험 변경') {
  git(source, 'add', '-A');
  git(source, 'commit', '-m', message);
  return git(source, 'rev-parse', 'HEAD');
}

async function clone() {
  git(source, 'push', 'origin', 'main');
  return GitRepository.clone(join(root, 'runner'), 'project', remote);
}

beforeEach(async () => {
  await mkdir(archive, { recursive: true });
  root = await mkdtemp(join(archive, 'git-test-'));
  source = join(root, 'source');
  remote = join(root, 'remote.git');
  await mkdir(source);
  git(source, 'init', '-b', 'main');
  await file(join(source, 'prototype/docs/guide.md'), '원본 입력');
  await file(join(source, 'prototype/uiux/install.sh'), `touch ${join(root, 'executed')}`);
  await file(join(source, 'src/existing.ts'), '등록 전 코드');
  await file(join(source, 'contracts/api.json'), '{}');
  await file(join(source, '.agentwbs/policy'), '등록 전 정책');
  await file(join(source, '.gitignore'), 'dist/\n*.generated\n');
  baseline = await commit('등록 기준');
  git(source, 'init', '--bare', '-b', 'main', remote);
  git(source, 'remote', 'add', 'origin', remote);
});

afterEach(async () => {
  // 읽기 전용 입력 사본도 정리하며, 링크를 따라가지는 않는다.
  async function unlock(path: string) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    await chmod(path, 0o700);
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(path)) await unlock(join(path, name));
  }
  await unlock(root);
  await rm(root, { recursive: true, force: true });
});

test('로컬 bare clone과 분리된 Agent worktree를 만들고 재시작 후 다시 연다', async () => {
  repo = await clone();
  expect(await repo.head()).toBe(baseline);
  const work = await repo.createWorktree('task-1', 'agent/TASK-1-h2', baseline);
  expect(await readFile(join(work, 'src/existing.ts'), 'utf8')).toBe('등록 전 코드');
  await file(join(work, 'src/existing.ts'), '작업 중');
  expect(git(source, 'show', 'main:src/existing.ts')).toBe('등록 전 코드');
  const reopened = await GitRepository.open(join(root, 'runner'), 'project');
  await reopened.removeWorktree('task-1');
  await expect(lstat(work)).rejects.toMatchObject({ code: 'ENOENT' });
  await reopened.removeWorktree('task-1');
});

test('고정 커밋의 prototype만 읽기 전용으로 복사하고 실행 파일을 실행하지 않는다', async () => {
  repo = await clone();
  const input = await repo.checkoutInput('v1', baseline);
  expect(await readFile(join(input, 'prototype/docs/guide.md'), 'utf8')).toBe('원본 입력');
  expect((await lstat(join(input, 'prototype/uiux/install.sh'))).mode & 0o777).toBe(0o444);
  expect((await lstat(input)).mode & 0o777).toBe(0o555);
  await expect(lstat(join(input, 'src'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(join(root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(repo.checkoutInput('v1', baseline)).rejects.toThrow();
  await repo.removeInput('v1');
  await repo.removeInput('v1');
  expect(await readFile(join(source, 'prototype/docs/guide.md'), 'utf8')).toBe('원본 입력');
});

test.each(['../outside', '/outside', '-bad', 'a/b'])('관리 폴더 이름 %s는 거부한다', async (id) => {
  repo = await clone();
  await expect(repo.createWorktree(id, 'agent/TASK-1', baseline)).rejects.toThrow();
  await expect(repo.checkoutInput(id, baseline)).rejects.toThrow();
  await expect(repo.removeInput(id)).rejects.toThrow();
});

test('관리 폴더 symlink로 외부 폴더를 덮어쓰거나 지우지 않는다', async () => {
  repo = await clone();
  const outside = join(root, 'outside');
  await mkdir(outside);
  await file(join(outside, 'keep'), '보존');
  await symlink(outside, join(root, 'runner/inputs/project/v1'));
  await expect(repo.checkoutInput('v1', baseline)).rejects.toThrow();
  await expect(repo.removeInput('v1')).rejects.toThrow();
  await symlink(outside, join(root, 'runner/worktrees/project/task-1'));
  await expect(repo.createWorktree('task-1', 'agent/TASK-1', baseline)).rejects.toThrow();
  await expect(repo.removeWorktree('task-1')).rejects.toThrow();
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('보존');
});

test('입력 안의 symlink는 절대·상대 경로 모두 거부하며 부분 사본도 남기지 않는다', async () => {
  await symlink(join(root, 'outside'), join(source, 'prototype/docs/absolute'));
  await symlink('../../src', join(source, 'prototype/uiux/relative'));
  const head = await commit();
  repo = await clone();
  await expect(repo.checkoutInput('v1', head)).rejects.toThrow(/symlink/);
  await expect(lstat(join(root, 'runner/inputs/project/v1'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('prototype 자체가 symlink이면 거부한다', async () => {
  await rm(join(source, 'prototype'), { recursive: true });
  await symlink('src', join(source, 'prototype'));
  const head = await commit();
  repo = await clone();
  await expect(repo.checkoutInput('v1', head)).rejects.toThrow(/symlink/);
});

test('입력 submodule은 따라가지 않고 실패로 보고한다', async () => {
  git(source, 'update-index', '--add', '--cacheinfo', `160000,${baseline},prototype/vendor`);
  await file(join(source, '.gitmodules'), '[submodule "공격"]\npath = prototype/vendor\nurl = https://invalid.example/private\n');
  git(source, 'add', '.gitmodules');
  git(source, 'commit', '-m', '하위 모듈 공격');
  const head = git(source, 'rev-parse', 'HEAD');
  repo = await clone();
  await expect(repo.checkoutInput('v1', head)).rejects.toThrow(/submodule/);
  await expect(lstat(join(root, 'runner/inputs/project/v1'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['prototype/docs/guide.md', '.agentwbs/policy'])('보호 경로 %s 수정과 삭제를 거부한다', async (path) => {
  await file(join(source, path), '변조');
  let head = await commit();
  repo = await clone();
  expect(await repo.checkTask(baseline, head)).toContainEqual({ path, reason: 'protected' });
  await rm(join(source, path));
  head = await commit();
  git(source, 'push', 'origin', 'main');
  await repo.fetch();
  expect(await repo.checkTask(baseline, head)).toContainEqual({ path, reason: 'protected' });
});

test.each([['prototype/docs/guide.md', 'src/moved.md'], ['src/existing.ts', '.agentwbs/moved.ts']])(
  'rename의 양쪽 경로를 검사한다: %s → %s', async (from, to) => {
    git(source, 'mv', from, to);
    const head = await commit();
    repo = await clone();
    const rejected = await repo.checkTask(baseline, head);
    expect(rejected.some(({ path, reason }) => reason === 'protected' && [from, to].includes(path))).toBe(true);
  },
);

test('main이 앞서가도 merge-base부터 검사하고 일반 코드 변경은 허용한다', async () => {
  git(source, 'checkout', '-b', 'agent/TASK-1');
  await file(join(source, 'src/task.ts'), '작업');
  const taskHead = await commit();
  git(source, 'checkout', 'main');
  await file(join(source, 'prototype/docs/guide.md'), '팀장의 새 입력');
  const main = await commit();
  repo = await clone();
  git(source, 'push', 'origin', 'agent/TASK-1');
  await repo.fetch();
  expect(await repo.checkTask(main, taskHead)).toEqual([]);
});

test('기준 또는 작업 커밋의 gitignore에 해당하는 강제 추가 산출물을 거부한다', async () => {
  await file(join(source, 'dist/app.js'), '산출물');
  await file(join(source, 'src/nested/.gitignore'), '*.cache\n');
  await file(join(source, 'src/nested/file.cache'), '산출물');
  await file(join(source, 'src/line\nbreak.generated'), '개행 파일명');
  await file(join(source, '.gitignore'), '');
  git(source, 'add', '-f', 'dist/app.js', 'src/nested/file.cache', 'src/line\nbreak.generated');
  const head = await commit();
  repo = await clone();
  const rejected = await repo.checkTask(baseline, head);
  for (const path of ['dist/app.js', 'src/nested/file.cache', 'src/line\nbreak.generated']) {
    expect(rejected).toContainEqual({ path, reason: 'ignored' });
  }
});

test('초기화는 새 커밋으로 대상 경로만 복원하고 기록한 Agent 브랜치만 삭제한다', async () => {
  await file(join(source, 'src/existing.ts'), 'Agent 변경');
  await file(join(source, 'src/new.ts'), '새 산출물');
  await rm(join(source, 'contracts'), { recursive: true });
  await file(join(source, '.agentwbs/policy'), '변경');
  await file(join(source, 'prototype/docs/guide.md'), '팀장의 최신 입력');
  await file(join(source, 'README'), '범위 밖 파일');
  const previous = await commit();
  repo = await clone();
  await repo.createWorktree('task-1', 'agent/recorded', previous);
  git(repo.path, 'branch', 'agent/unrecorded', previous);
  git(repo.path, 'branch', 'personal', previous);
  await repo.checkoutInput('v1', baseline);
  const restored = await repo.reset({ baseCommit: baseline, branches: ['agent/recorded'], worktrees: ['task-1'], inputs: ['v1'] });
  expect(restored.commit).not.toBe(previous);
  expect(git(repo.path, 'rev-parse', `${restored.commit}^`)).toBe(previous);
  expect(git(repo.path, 'show', 'main:src/existing.ts')).toBe('등록 전 코드');
  expect(git(repo.path, 'show', 'main:contracts/api.json')).toBe('{}');
  expect(git(repo.path, 'show', 'main:.agentwbs/policy')).toBe('등록 전 정책');
  expect(git(repo.path, 'show', 'main:prototype/docs/guide.md')).toBe('팀장의 최신 입력');
  expect(git(repo.path, 'show', 'main:README')).toBe('범위 밖 파일');
  expect(() => git(repo.path, 'show', 'main:src/new.ts')).toThrow();
  expect(git(repo.path, 'branch', '--list', 'agent/recorded')).toBe('');
  expect(git(repo.path, 'branch', '--list', 'agent/unrecorded')).toContain('agent/unrecorded');
  expect(git(repo.path, 'branch', '--list', 'personal')).toContain('personal');
  expect(git(remote, 'rev-parse', 'main')).toBe(previous);
  expect(await repo.reset({ baseCommit: baseline, branches: ['agent/recorded'], worktrees: ['task-1'], inputs: ['v1'] })).toMatchObject({ commit: restored.commit });
});

test('基準 커밋이 없으면 저장소를 건드리지 않으며 main 삭제와 잘못된 SHA를 거부한다', async () => {
  repo = await clone();
  expect(await repo.reset({ baseCommit: null, branches: ['agent/missing'], worktrees: [], inputs: [] })).toEqual({ commit: null });
  await expect(repo.reset({ baseCommit: baseline, branches: ['main'], worktrees: [], inputs: [] })).rejects.toThrow();
  await expect(repo.checkoutInput('v1', '--help')).rejects.toThrow();
  expect(await repo.head()).toBe(baseline);
});
