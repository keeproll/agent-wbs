import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GitCleanupError, GitRepository } from '../../src/git/repository.ts';

const archive = tmpdir();
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
  vi.unstubAllEnvs();
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

test('기준 커밋이 없으면 저장소를 건드리지 않으며 main 삭제와 잘못된 SHA를 거부한다', async () => {
  repo = await clone();
  expect(await repo.reset({ baseCommit: null, branches: ['agent/missing'], worktrees: [], inputs: [] })).toEqual({ commit: null });
  await expect(repo.reset({ baseCommit: baseline, branches: ['main'], worktrees: [], inputs: [] })).rejects.toThrow();
  await expect(repo.checkoutInput('v1', '--help')).rejects.toThrow();
  expect(await repo.head()).toBe(baseline);
});

test('기준에 대상 폴더가 없으면 새 산출물을 모두 없애고 다른 파일은 보존한다', async () => {
  git(source, 'rm', '-r', 'src', 'contracts', '.agentwbs');
  const emptyBaseline = await commit();
  await file(join(source, 'src/new.ts'), '새 코드');
  await file(join(source, '.agentwbs/config'), '새 정책');
  await file(join(source, 'contracts/new.json'), '{}');
  await file(join(source, 'README'), '보존');
  await commit();
  repo = await clone();
  const reset = await repo.reset({ baseCommit: emptyBaseline, branches: [], worktrees: [], inputs: [] });
  expect(reset.commit).toBe(await repo.head());
  for (const path of ['src', 'contracts', '.agentwbs']) expect(() => git(repo.path, 'show', `main:${path}`)).toThrow();
  expect(git(repo.path, 'show', 'main:README')).toBe('보존');
});

test('초기화는 symlink로 바뀐 대상 폴더를 따라가지 않고 Git 객체로 복원한다', async () => {
  await rm(join(source, 'src'), { recursive: true });
  await symlink('../prototype/docs', join(source, 'src'));
  await commit();
  repo = await clone();
  await repo.reset({ baseCommit: baseline, branches: [], worktrees: [], inputs: [] });
  expect(git(repo.path, 'show', 'main:src/existing.ts')).toBe('등록 전 코드');
  expect(git(repo.path, 'show', 'main:prototype/docs/guide.md')).toBe('원본 입력');
});

test('전역 설정·환경 변수·템플릿의 Git hook을 물려받지 않는다', async () => {
  const hooks = join(root, 'hooks');
  await mkdir(hooks);
  await file(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${join(root, 'hook-executed')}'\n`);
  await chmod(join(hooks, 'post-checkout'), 0o755);
  const config = join(root, 'config');
  await file(config, `[core]\n hooksPath = ${hooks}\n`);
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  vi.stubEnv('GIT_DIR', join(root, 'missing'));
  vi.stubEnv('GIT_TEMPLATE_DIR', hooks);
  // clone 준비용 fixture 명령은 오염시키지 않는다.
  delete process.env.GIT_DIR;
  git(source, 'push', 'origin', 'main');
  vi.stubEnv('GIT_DIR', join(root, 'missing'));
  repo = await GitRepository.clone(join(root, 'runner'), 'project', remote);
  await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  await expect(lstat(join(root, 'hook-executed'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('인증 정보·옵션·원격 명령 형태의 저장소 입력은 실행하지 않고 비밀값도 노출하지 않는다', async () => {
  for (const source of ['https://user:hunter2@example.invalid/repo', '--upload-pack=hunter2', 'ext::hunter2', 'git@example.invalid:hunter2']) {
    await expect(GitRepository.clone(join(root, 'runner'), 'invalid', source)).rejects.toThrow(/저장소 주소/);
    try { await GitRepository.clone(join(root, 'runner'), 'invalid', source); }
    catch (error) { expect((error as Error).message).not.toContain('hunter2'); }
  }
  await expect(GitRepository.clone('/mnt/c/runner', 'project', remote)).rejects.toThrow(/Linux/);
});

test('로컬 bare 저장소의 Git LFS 원본을 읽고 포인터 그대로 성공 처리하지 않는다', async () => {
  const content = Buffer.from('로컬 대용량 원본\n');
  const oid = createHash('sha256').update(content).digest('hex');
  await file(join(source, 'prototype/docs/large.bin'), `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`);
  const head = await commit();
  await file(join(remote, 'lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid), content.toString());
  repo = await clone();
  const input = await repo.checkoutInput('v1', head);
  expect(await readFile(join(input, 'prototype/docs/large.bin'))).toEqual(content);
});

test('Git LFS 도구나 원본이 없으면 실패하며 반쪽 입력 사본을 지운다', async () => {
  await file(join(source, 'prototype/docs/large.bin'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 123\n`);
  const head = await commit();
  repo = await clone();
  await expect(repo.checkoutInput('missing-object', head)).rejects.toThrow();
  await expect(lstat(join(root, 'runner/inputs/project/missing-object'))).rejects.toMatchObject({ code: 'ENOENT' });
  const bin = join(root, 'bin');
  await mkdir(bin);
  await symlink('/usr/bin/git', join(bin, 'git'));
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', head);
  git(work, 'config', 'alias.lfs', `!/usr/bin/touch '${join(root, 'lfs-alias-executed')}'`);
  vi.stubEnv('PATH', bin);
  await expect(repo.checkoutInput('missing-lfs', head)).rejects.toThrow();
  await expect(lstat(join(root, 'runner/inputs/project/missing-lfs'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(join(root, 'lfs-alias-executed'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('작업 폴더를 만들 때 저장소에 설정된 외부 변환 명령을 실행하지 않는다', async () => {
  await file(join(source, '.gitattributes'), 'src/*.ts filter=attack\n');
  const head = await commit();
  repo = await clone();
  const agent = await repo.createWorktree('task-1', 'agent/TASK-1', head);
  git(agent, 'config', 'filter.attack.smudge', `touch '${join(root, 'filter-executed')}'`);
  git(agent, 'config', 'filter.attack.required', 'true');
  const work = await repo.createWorktree('task-2', 'agent/TASK-2', head);
  expect(await readFile(join(work, 'src/existing.ts'), 'utf8')).toBe('등록 전 코드');
  await expect(lstat(join(root, 'filter-executed'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('clone 뒤 main에 올라온 입력을 보존하며 강제 push 없이 초기화 커밋을 전달할 수 있다', async () => {
  await file(join(source, 'src/existing.ts'), 'Agent 코드');
  await commit();
  repo = await clone();
  await file(join(source, 'prototype/docs/guide.md'), 'clone 이후 최신 입력');
  const latest = await commit();
  git(source, 'push', 'origin', 'main');
  const result = await repo.reset({ baseCommit: baseline, branches: [], worktrees: [], inputs: [] });
  expect(git(repo.path, 'rev-parse', `${result.commit}^`)).toBe(latest);
  expect(git(repo.path, 'show', 'main:prototype/docs/guide.md')).toBe('clone 이후 최신 입력');
  // GitHub 어댑터가 수행할 일반 push를 로컬 bare 저장소에만 검증한다.
  git(repo.path, 'push', 'origin', 'refs/heads/main:refs/heads/main');
  expect(git(remote, 'rev-parse', 'main')).toBe(result.commit);
  expect(await repo.reset({ baseCommit: baseline, branches: [], worktrees: [], inputs: [] })).toEqual(result);
});

test('관리 경로의 상위 폴더를 symlink로 바꿔도 외부에 입력을 만들지 않는다', async () => {
  repo = await clone();
  const outside = join(root, 'outside');
  await mkdir(outside);
  await rm(join(root, 'runner/inputs/project'), { recursive: true });
  await symlink(outside, join(root, 'runner/inputs/project'));
  await expect(repo.checkoutInput('v1', baseline)).rejects.toThrow(/symlink/);
  await expect(lstat(join(outside, 'v1'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('전송 대기 중인 초기화가 있어도 새 main 입력을 보존하고 옛 입력 버전을 유지한다', async () => {
  await file(join(source, 'src/existing.ts'), 'Agent 변경');
  await commit();
  repo = await clone();
  const inputV1 = await repo.checkoutInput('v1', baseline);
  const first = await repo.reset({ baseCommit: baseline, branches: [], worktrees: [], inputs: [] });
  await file(join(source, 'prototype/docs/guide.md'), '새 입력 v2');
  const latest = await commit();
  git(source, 'push', 'origin', 'main');
  const second = await repo.reset({ baseCommit: baseline, branches: [], worktrees: [], inputs: [] });
  expect(second.commit).not.toBe(first.commit);
  expect(git(repo.path, 'rev-parse', `${second.commit}^`)).toBe(latest);
  expect(git(repo.path, 'show', 'main:prototype/docs/guide.md')).toBe('새 입력 v2');
  const inputV2 = await repo.checkoutInput('v2', latest);
  expect(await readFile(join(inputV1, 'prototype/docs/guide.md'), 'utf8')).toBe('원본 입력');
  expect(await readFile(join(inputV2, 'prototype/docs/guide.md'), 'utf8')).toBe('새 입력 v2');
});

test('E1 Agent의 uploadpack 설정이 Runner 초기화에서 실행되지 않는다', async () => {
  repo = await clone();
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  const marker = join(root, 'uploadpack-executed');
  git(work, 'config', 'remote.origin.uploadpack', `touch '${marker}'; git-upload-pack`);
  await repo.reset({ baseCommit: baseline, branches: ['agent/TASK-1'], worktrees: ['task-1'], inputs: [] });
  await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('E2 Agent가 origin을 바꿔도 등록 원격의 입력만 사용한다', async () => {
  repo = await clone();
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  const evil = join(root, 'evil');
  git(root, 'clone', remote, evil);
  await file(join(evil, 'prototype/docs/guide.md'), '공격자가 바꾼 입력');
  git(evil, 'commit', '-am', '입력 오염');
  git(work, 'config', 'remote.origin.url', evil);
  const reset = await repo.reset({ baseCommit: baseline, branches: [], worktrees: [], inputs: [] });
  expect(git(repo.path, 'show', `${reset.commit}:prototype/docs/guide.md`)).toBe('원본 입력');
  expect(await repo.fetch()).toBe(baseline);
});

test('E3 Agent의 LFS 전송 명령이 Runner 입력 복사에서 실행되지 않는다', async () => {
  const content = Buffer.from('안전한 LFS 원본\n');
  const oid = createHash('sha256').update(content).digest('hex');
  await file(join(source, 'prototype/docs/big.bin'), `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`);
  const head = await commit();
  await file(join(remote, 'lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid), content.toString());
  repo = await clone();
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', head);
  const marker = join(root, 'lfs-transfer-executed');
  git(work, 'config', 'lfs.standalonetransferagent', 'evil');
  git(work, 'config', 'lfs.customtransfer.evil.path', '/bin/sh');
  git(work, 'config', 'lfs.customtransfer.evil.args', `-c "touch '${marker}'; exit 1"`);
  const result = await repo.checkoutInput('v1', head).then((path) => path, () => undefined);
  await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(result).toBeDefined();
  expect(await readFile(join(result as string, 'prototype/docs/big.bin'))).toEqual(content);
});

test('E12 Agent의 core.bare 변경이 Runner 재시작을 막지 않는다', async () => {
  repo = await clone();
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  git(work, 'config', 'core.bare', 'false');
  const reopened = await GitRepository.open(join(root, 'runner'), 'project');
  expect(await reopened.head()).toBe(baseline);
});

test('E5 권한 000 폴더를 복구하여 정리하고 재시도도 완료한다', async () => {
  repo = await clone();
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  await file(join(work, 'locked/inner/data'), '삭제할 파일');
  await chmod(join(work, 'locked'), 0);
  const options = { baseCommit: baseline, branches: ['agent/TASK-1'], worktrees: ['task-1'], inputs: [] };
  await repo.reset(options);
  await expect(lstat(work)).rejects.toMatchObject({ code: 'ENOENT' });
  await repo.reset(options);
});

test('E5 Git 등록 정보가 먼저 사라져도 기록한 폴더는 재시도에서 지운다', async () => {
  repo = await clone();
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  await file(join(work, 'locked/inner/data'), '삭제할 파일');
  await chmod(join(work, 'locked'), 0);
  try { git(repo.path, 'worktree', 'remove', '--force', work); } catch { /* 삭제 중단 사고를 재현한다. */ }
  await chmod(join(work, 'locked'), 0o700);
  await repo.reset({ baseCommit: baseline, branches: ['agent/TASK-1'], worktrees: ['task-1'], inputs: [] });
  await expect(lstat(work)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('E6 기존 강제 추가 파일은 허용하고 Task가 수정한 제외 파일만 거부한다', async () => {
  await file(join(source, '.gitignore'), '.env*\ndist/\n');
  await file(join(source, '.env.example'), 'A=1');
  git(source, 'add', '-f', '.env.example');
  const base = await commit();
  await file(join(source, 'src/feature.ts'), '새 기능');
  const head = await commit();
  repo = await clone();
  expect(await repo.checkTask(base, head)).toEqual([]);
  await file(join(source, '.env.example'), 'A=2');
  const changed = await commit();
  git(source, 'push', 'origin', 'main');
  await repo.fetch();
  expect(await repo.checkTask(base, changed)).toContainEqual({ path: '.env.example', reason: 'ignored' });
  await rm(join(source, '.env.example'));
  const deleted = await commit();
  git(source, 'push', 'origin', 'main');
  await repo.fetch();
  expect(await repo.checkTask(base, deleted)).toEqual([]);
});

test.each(['remote.origin.uploadpack', 'remote.origin.url', 'lfs.customtransfer.evil.path', 'core.bare'])(
  'Runner 설정 %s가 직접 변조되면 실행·재시작을 중지한다', async (setting) => {
    repo = await clone();
    git(repo.path, 'config', setting, setting === 'core.bare' ? 'false' : '/변조된-값');
    await expect(repo.fetch()).rejects.toThrow(/등록 당시와 다릅니다/);
    await expect(GitRepository.open(join(root, 'runner'), 'project')).rejects.toThrow(/등록 당시와 다릅니다/);
  },
);

test('Agent 저장소는 객체·설정을 공유하지 않고 결과만 검증하여 가져온다', async () => {
  repo = await clone();
  git(repo.path, 'branch', 'personal', baseline);
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  expect(git(work, 'rev-parse', '--git-common-dir')).toBe('.git');
  expect(() => git(work, 'remote', 'get-url', 'origin')).toThrow();
  await expect(lstat(join(work, '.git/objects/info/alternates'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(() => git(work, 'branch', '-D', 'personal')).toThrow();
  expect(git(repo.path, 'branch', '--list', 'personal')).toContain('personal');
  await file(join(work, 'src/result.ts'), '작업 결과');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'Agent 결과');
  const marker = join(root, 'import-executed');
  git(work, 'config', 'remote.origin.uploadpack', `touch '${marker}'; git-upload-pack`);
  git(work, 'config', 'uploadpack.packObjectsHook', `touch '${marker}'; git pack-objects`);
  const imported = await repo.importWorktree('task-1', 'agent/TASK-1');
  expect(imported).toBe(git(work, 'rev-parse', 'HEAD'));
  expect(await repo.checkTask(baseline, imported)).toEqual([]);
  expect(await repo.head()).toBe(baseline);
  await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  await file(join(work, 'prototype/docs/guide.md'), '보호 경로 변조');
  git(work, 'commit', '-am', '보호 경로 변경');
  expect(await repo.checkTask(baseline, await repo.importWorktree('task-1', 'agent/TASK-1')))
    .toContainEqual({ path: 'prototype/docs/guide.md', reason: 'protected' });
  await repo.removeWorktree('task-1');
  expect(() => git(repo.path, 'rev-parse', '--verify', 'refs/agent-results/task-1')).toThrow();
});

test('기록한 작업 폴더의 Git 정보가 없어지거나 링크로 바뀌어도 외부 파일을 건드리지 않고 정리한다', async () => {
  repo = await clone();
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  await rm(join(work, '.git'), { recursive: true });
  await (await GitRepository.open(join(root, 'runner'), 'project')).removeWorktree('task-1');
  await expect(lstat(work)).rejects.toMatchObject({ code: 'ENOENT' });
  const reopened = await GitRepository.open(join(root, 'runner'), 'project');
  const replaced = await reopened.createWorktree('task-2', 'agent/TASK-2', baseline);
  await rm(replaced, { recursive: true });
  const outside = join(root, 'outside');
  await file(join(outside, 'keep'), '보존');
  await symlink(outside, replaced);
  await reopened.removeWorktree('task-2');
  await expect(lstat(replaced)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('보존');
});

test('정리 항목 하나가 실패해도 나머지는 끝내고 수동 조치 뒤 재시도할 수 있다', async () => {
  repo = await clone();
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  const input = await repo.checkoutInput('v1', baseline);
  const unknown = join(root, 'runner/worktrees/project/unknown');
  await file(join(unknown, 'keep'), '기록하지 않은 폴더');
  git(repo.path, 'branch', 'agent/recorded', baseline);
  const options = { baseCommit: baseline, branches: ['agent/recorded'], worktrees: ['unknown', 'task-1'], inputs: ['v1'] };
  const error = await repo.reset(options).then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(GitCleanupError);
  expect((error as GitCleanupError).failures).toMatchObject([{ name: 'worktree:unknown', path: unknown }]);
  expect((error as Error).message).toContain('수동 조치');
  await expect(lstat(work)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(input)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(git(repo.path, 'branch', '--list', 'agent/recorded')).toBe('');
  expect(await readFile(join(unknown, 'keep'), 'utf8')).toBe('기록하지 않은 폴더');
  await rm(unknown, { recursive: true });
  await repo.reset(options);
});

test('Agent 결과의 잘못된 Git tree 경로는 가져오는 단계에서 거부한다', async () => {
  repo = await clone();
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  const blob = git(work, 'rev-parse', `${baseline}:prototype/docs/guide.md`);
  const tree = execFileSync('git', ['hash-object', '-w', '-t', 'tree', '--literally', '--stdin'], {
    cwd: work, encoding: 'utf8', input: Buffer.concat([Buffer.from('100644 ../escaped\0'), Buffer.from(blob, 'hex')]),
  }).trim();
  const invalid = git(work, 'commit-tree', tree, '-p', baseline, '-m', '잘못된 경로');
  git(work, 'update-ref', 'refs/heads/agent/TASK-1', invalid);
  await expect(repo.importWorktree('task-1', 'agent/TASK-1')).rejects.toThrow();
  await expect(lstat(join(root, 'runner/worktrees/project/escaped'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await repo.head()).toBe(baseline);
});

test('NG fetch한 최신 원격 main으로 독립 작업 폴더를 만든다', async () => {
  repo = await clone();
  await file(join(source, 'prototype/docs/guide.md'), '등록 뒤 새 입력');
  await file(join(source, 'src/merged.ts'), '앞 Task의 병합 결과');
  const latest = await commit();
  git(source, 'push', 'origin', 'main');
  expect(await repo.fetch()).toBe(latest);
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', latest);
  expect(git(work, 'rev-parse', 'HEAD')).toBe(latest);
  expect(await readFile(join(work, 'prototype/docs/guide.md'), 'utf8')).toBe('등록 뒤 새 입력');
  expect(await readFile(join(work, 'src/merged.ts'), 'utf8')).toBe('앞 Task의 병합 결과');
  expect(await repo.head()).toBe(baseline);
});

test('NC amend와 rebase한 결과를 다시 가져와도 원격 main은 움직이지 않는다', async () => {
  repo = await clone();
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  await file(join(work, 'src/task.ts'), '첫 결과');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', '첫 결과');
  const first = await repo.importWorktree('task-1', 'agent/TASK-1');
  await file(join(work, 'src/task.ts'), '수정 결과');
  git(work, 'commit', '-am', '수정 결과', '--amend');
  const amended = await repo.importWorktree('task-1', 'agent/TASK-1');
  expect(amended).not.toBe(first);
  expect(git(repo.path, 'show', `${amended}:src/task.ts`)).toBe('수정 결과');
  await file(join(source, 'src/main-only.ts'), '새 기준');
  const newBase = await commit();
  git(work, 'fetch', source, 'main');
  git(work, 'rebase', newBase);
  const rebased = await repo.importWorktree('task-1', 'agent/TASK-1');
  expect(rebased).toBe(git(work, 'rev-parse', 'HEAD'));
  expect(git(work, 'merge-base', amended, rebased)).not.toBe(amended);
  expect(git(remote, 'rev-parse', 'main')).toBe(baseline);
  expect(await repo.head()).toBe(baseline);
});

test('ND 같은 객체의 동시 작업 폴더 생성 기록을 모두 보존하고 정리한다', async () => {
  repo = await clone();
  const worktrees = await Promise.all([
    repo.createWorktree('task-1', 'agent/TASK-1', baseline),
    repo.createWorktree('task-2', 'agent/TASK-2', baseline),
  ]);
  const record = JSON.parse(await readFile(join(root, 'runner/state/git/project.json'), 'utf8')) as { worktrees: { id: string }[] };
  expect(record.worktrees.map((entry) => entry.id).sort()).toEqual(['task-1', 'task-2']);
  await repo.reset({ baseCommit: baseline, branches: ['agent/TASK-1', 'agent/TASK-2'], worktrees: ['task-1', 'task-2'], inputs: [] });
  for (const work of worktrees) await expect(lstat(work)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('NE 먼저 열린 여러 객체가 순서대로 생성·삭제해도 최신 기록을 보존한다', async () => {
  repo = await clone();
  const other = await GitRepository.open(join(root, 'runner'), 'project');
  const work1 = await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  const work2 = await other.createWorktree('task-2', 'agent/TASK-2', baseline);
  const record = JSON.parse(await readFile(join(root, 'runner/state/git/project.json'), 'utf8')) as { worktrees: { id: string }[] };
  expect(record.worktrees.map((entry) => entry.id).sort()).toEqual(['task-1', 'task-2']);
  await other.removeWorktree('task-1');
  expect(await repo.importWorktree('task-2', 'agent/TASK-2')).toBe(baseline);
  await repo.removeWorktree('task-2');
  await expect(lstat(work1)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(work2)).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['--single-branch', 'checkout'])('NG %s 실패 뒤 폴더·기록·새 브랜치를 되돌려 같은 요청을 재시도한다', async (phase) => {
  repo = await clone();
  const bin = join(root, 'bin');
  await file(join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "${phase}" ]; then exit 17; fi\ndone\nexec /usr/bin/git "$@"\n`);
  await chmod(join(bin, 'git'), 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  await expect(repo.createWorktree('task-1', 'agent/TASK-1', baseline)).rejects.toThrow();
  await expect(lstat(join(root, 'runner/worktrees/project/task-1'))).rejects.toMatchObject({ code: 'ENOENT' });
  const record = JSON.parse(await readFile(join(root, 'runner/state/git/project.json'), 'utf8')) as { worktrees: { id: string }[] };
  expect(record.worktrees).toEqual([]);
  expect(git(repo.path, 'branch', '--list', 'agent/TASK-1')).toBe('');
  vi.unstubAllEnvs();
  expect(git(await repo.createWorktree('task-1', 'agent/TASK-1', baseline), 'rev-parse', 'HEAD')).toBe(baseline);
});

test('ND 서로 다른 프로세스가 동시에 만든 작업 폴더 기록도 모두 보존한다', async () => {
  repo = await clone();
  const moduleUrl = new URL('../../src/git/repository.ts', import.meta.url).href;
  const code = `import { GitRepository } from ${JSON.stringify(moduleUrl)}; const repo = await GitRepository.open(process.argv[1], 'project'); await repo.createWorktree(process.argv[2], 'agent/' + process.argv[2], process.argv[3]);`;
  await Promise.all(['task-1', 'task-2'].map((name) => promisify(execFile)(process.execPath, [
    '--input-type=module', '-e', code, join(root, 'runner'), name, baseline,
  ])));
  const record = JSON.parse(await readFile(join(root, 'runner/state/git/project.json'), 'utf8')) as { worktrees: { id: string }[] };
  expect(record.worktrees.map((entry) => entry.id).sort()).toEqual(['task-1', 'task-2']);
  await repo.reset({ baseCommit: baseline, branches: ['agent/task-1', 'agent/task-2'], worktrees: ['task-1', 'task-2'], inputs: [] });
  await expect(lstat(join(root, 'runner/state/git/project.json.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('NG 이미 있는 Agent 브랜치는 덮어쓰거나 실패 복구에서 지우지 않는다', async () => {
  repo = await clone();
  git(repo.path, 'branch', 'agent/occupied', baseline);
  await expect(repo.createWorktree('task-1', 'agent/occupied', baseline)).rejects.toThrow();
  expect(git(repo.path, 'rev-parse', 'refs/heads/agent/occupied')).toBe(baseline);
  await expect(lstat(join(root, 'runner/worktrees/project/task-1'))).rejects.toMatchObject({ code: 'ENOENT' });
  const record = JSON.parse(await readFile(join(root, 'runner/state/git/project.json'), 'utf8')) as { worktrees: { id: string }[] };
  expect(record.worktrees).toEqual([]);
});

test('ND 잠금 대기 시간이 지나도 다른 실행의 잠금을 지우지 않는다', async () => {
  repo = await clone();
  const lockPath = join(root, 'runner/state/git/project.json.lock');
  await writeFile(lockPath, '다른 실행의 잠금');
  let now = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => { now += 30_000; return now; });
  try {
    await expect(repo.createWorktree('task-1', 'agent/TASK-1', baseline)).rejects.toThrow(/잠금 대기/);
  } finally { clock.mockRestore(); }
  expect(await readFile(lockPath, 'utf8')).toBe('다른 실행의 잠금');
  await expect(lstat(join(root, 'runner/worktrees/project/task-1'))).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(lockPath);
  await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
});

async function ownerRecord(pid = process.pid) {
  const processStat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return { pid, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    startTime: processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] as string };
}

async function withoutLongLockWait(action: () => Promise<unknown>) {
  let now = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => { now += 30_000; return now; });
  try { await action(); } finally { clock.mockRestore(); }
}

test.each(['full', 'legacy'])('L1 SIGKILL로 종료된 %s 잠금 주인을 확인해 새 작업과 초기화 정리를 자동 재개한다', async (format) => {
  repo = await clone();
  await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
  const lockPath = join(root, 'runner/state/git/project.json.lock');
  const code = `import fs from 'node:fs'; const path = process.argv[1]; const stat = fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8'); const owner = { pid: process.pid, bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), startTime: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19] }; fs.writeFileSync(path + '.prepared', process.argv[2] === 'legacy' ? process.pid + '\\n' : JSON.stringify(owner), { flag: 'wx' }); fs.linkSync(path + '.prepared', path); fs.unlinkSync(path + '.prepared'); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, lockPath, format], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const restarted = await GitRepository.open(join(root, 'runner'), 'project');
    await withoutLongLockWait(async () => {
      await restarted.createWorktree('task-2', 'agent/TASK-2', baseline);
      await restarted.reset({ baseCommit: baseline, branches: ['agent/TASK-1', 'agent/TASK-2'], worktrees: ['task-1', 'task-2'], inputs: [] });
    });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});

test.each(['boot', 'start'])('L1 %s 식별자가 다른 잠금은 살아 있는 pid여도 이전 주인으로 확인해 회수한다', async (changed) => {
  repo = await clone();
  const owner = await ownerRecord();
  if (changed === 'boot') owner.bootId = '00000000-0000-0000-0000-000000000000';
  else owner.startTime = (BigInt(owner.startTime) + 1n).toString();
  await writeFile(join(root, 'runner/state/git/project.json.lock'), JSON.stringify(owner));
  await withoutLongLockWait(() => repo.createWorktree('task-1', 'agent/TASK-1', baseline));
});

test('L2 정리한 같은 Task 브랜치로 이전 결과와 기준에서 다음 시도를 만든다', async () => {
  repo = await clone();
  const branch = 'agent/TASK-1-h2';
  const work = await repo.createWorktree('attempt-1', branch, baseline);
  await file(join(work, 'src/result.ts'), '첫 시도 결과');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', '첫 시도');
  const result = await repo.importWorktree('attempt-1', branch);
  await repo.removeWorktree('attempt-1');
  expect(git(repo.path, 'branch', '--list', branch)).toBe('');
  const next = await repo.createWorktree('attempt-2', branch, result);
  expect(git(next, 'rev-parse', 'HEAD')).toBe(result);
  await repo.removeWorktree('attempt-2');
  const fresh = await repo.createWorktree('attempt-3', branch, baseline);
  expect(git(fresh, 'rev-parse', 'HEAD')).toBe(baseline);
});

test.each(['live', 'pid', 'boot', 'start'])('L1 살아 있거나 %s 형식이 잘못된 주인의 잠금을 보존한다', async (invalid) => {
  repo = await clone();
  const owner: Record<string, unknown> = await ownerRecord();
  if (invalid === 'pid') owner.pid = -1;
  if (invalid === 'boot') owner.bootId = '잘못된 부팅 식별자';
  if (invalid === 'start') owner.startTime = '확인 불가';
  const path = join(root, 'runner/state/git/project.json.lock');
  const content = JSON.stringify(owner);
  await writeFile(path, content);
  await withoutLongLockWait(() => expect(repo.createWorktree('task-1', 'agent/TASK-1', baseline)).rejects.toThrow(/잠금 대기/));
  expect(await readFile(path, 'utf8')).toBe(content);
});

test('L1 주인 확인 권한이 없으면 시작 시간이 달라도 잠금을 회수하지 않는다', async () => {
  repo = await clone();
  const owner = await ownerRecord();
  owner.startTime = (BigInt(owner.startTime) + 1n).toString();
  const path = join(root, 'runner/state/git/project.json.lock');
  const content = JSON.stringify(owner);
  await writeFile(path, content);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('권한 없음'), { code: 'EPERM' }); });
  try {
    await withoutLongLockWait(() => expect(repo.createWorktree('task-1', 'agent/TASK-1', baseline)).rejects.toThrow(/잠금 대기/));
  } finally { kill.mockRestore(); }
  expect(await readFile(path, 'utf8')).toBe(content);
});

test('L1 구버전 PID 잠금도 해당 PID가 살아 있으면 보존한다', async () => {
  repo = await clone();
  const path = join(root, 'runner/state/git/project.json.lock');
  const content = `${process.pid}\n`;
  await writeFile(path, content);
  await withoutLongLockWait(() => expect(repo.createWorktree('task-1', 'agent/TASK-1', baseline)).rejects.toThrow(/잠금 대기/));
  expect(await readFile(path, 'utf8')).toBe(content);
});

test('L1 여러 프로세스가 남은 잠금을 동시에 회수해도 새 잠금과 생성 기록을 보존한다', async () => {
  repo = await clone();
  const owner = { ...await ownerRecord(), bootId: '00000000-0000-0000-0000-000000000000' };
  await writeFile(join(root, 'runner/state/git/project.json.lock'), JSON.stringify(owner));
  const moduleUrl = new URL('../../src/git/repository.ts', import.meta.url).href;
  const code = `import { GitRepository } from ${JSON.stringify(moduleUrl)}; const repo = await GitRepository.open(process.argv[1], 'project'); await repo.createWorktree(process.argv[2], 'agent/' + process.argv[2], process.argv[3]);`;
  await Promise.all(['task-1', 'task-2', 'task-3'].map((name) => promisify(execFile)(process.execPath, [
    '--input-type=module', '-e', code, join(root, 'runner'), name, baseline,
  ])));
  const record = JSON.parse(await readFile(join(root, 'runner/state/git/project.json'), 'utf8')) as { worktrees: { id: string }[] };
  expect(record.worktrees.map((entry) => entry.id).sort()).toEqual(['task-1', 'task-2', 'task-3']);
  await repo.reset({ baseCommit: baseline, branches: [], worktrees: ['task-1', 'task-2', 'task-3'], inputs: [] });
});

test('L1 회수용 커널 잠금의 주인도 SIGKILL 뒤 자동 해제된다', async () => {
  repo = await clone();
  const path = join(root, 'runner/state/git/project.json.lock');
  const content = JSON.stringify({ ...await ownerRecord(), bootId: '00000000-0000-0000-0000-000000000000' });
  await writeFile(path, content);
  const code = `import fs from 'node:fs'; import { spawnSync } from 'node:child_process'; const fd = fs.openSync(process.argv[1], 'a'); const result = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }); if (result.status !== 0) process.exit(1); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, `${path}.recover`], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    await withoutLongLockWait(() => expect(repo.createWorktree('task-1', 'agent/TASK-1', baseline)).rejects.toThrow(/잠금 대기/));
    expect(await readFile(path, 'utf8')).toBe(content);
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  await withoutLongLockWait(() => repo.createWorktree('task-1', 'agent/TASK-1', baseline));
});

test('L2 생성 뒤 이동한 브랜치는 정리 중 덮어쓰거나 삭제하지 않는다', async () => {
  repo = await clone();
  const branch = 'agent/TASK-1-h2';
  const work = await repo.createWorktree('attempt-1', branch, baseline);
  await file(join(work, 'src/new.ts'), '새 결과');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', '새 결과');
  const result = await repo.importWorktree('attempt-1', branch);
  git(repo.path, 'update-ref', `refs/heads/${branch}`, result);
  await repo.removeWorktree('attempt-1');
  expect(git(repo.path, 'rev-parse', `refs/heads/${branch}`)).toBe(result);
  await expect(repo.createWorktree('attempt-2', branch, baseline)).rejects.toThrow();
  expect(git(repo.path, 'rev-parse', `refs/heads/${branch}`)).toBe(result);
});

test('L2 구버전 이름 목록은 읽되 브랜치 소유권을 추측해 삭제하지 않는다', async () => {
  repo = await clone();
  const work = await repo.createWorktree('attempt-1', 'agent/TASK-1', baseline);
  const path = join(root, 'runner/state/git/project.json');
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  record.worktrees = ['attempt-1'];
  await writeFile(path, JSON.stringify(record));
  await (await GitRepository.open(join(root, 'runner'), 'project')).removeWorktree('attempt-1');
  await expect(lstat(work)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(git(repo.path, 'rev-parse', 'refs/heads/agent/TASK-1')).toBe(baseline);
});

test('L2 정리 도중 시작 브랜치가 먼저 사라져도 재시도와 다음 시도를 완료한다', async () => {
  repo = await clone();
  const branch = 'agent/TASK-1';
  const work = await repo.createWorktree('attempt-1', branch, baseline);
  git(repo.path, 'update-ref', '-d', `refs/heads/${branch}`);
  await repo.removeWorktree('attempt-1');
  await expect(lstat(work)).rejects.toMatchObject({ code: 'ENOENT' });
  const next = await repo.createWorktree('attempt-2', branch, baseline);
  expect(git(next, 'rev-parse', 'HEAD')).toBe(baseline);
});

test('L1 실제 작업 폴더 생성 중 Runner를 SIGKILL해도 기록된 폴더와 브랜치를 복구한다', { timeout: 15_000 }, async () => {
  repo = await clone();
  const moduleUrl = new URL('../../src/git/repository.ts', import.meta.url).href;
  const marker = join(root, 'copy-started');
  const bin = join(root, 'slow-bin');
  await file(join(bin, 'git'), `#!${process.execPath}\nconst fs = require('node:fs'); const { spawnSync } = require('node:child_process'); if (process.argv.includes('--single-branch')) { fs.writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000); } else { const result = spawnSync('/usr/bin/git', process.argv.slice(2), { stdio: 'inherit' }); process.exit(result.status ?? 1); }\n`);
  await chmod(join(bin, 'git'), 0o755);
  const code = `import { GitRepository } from ${JSON.stringify(moduleUrl)}; const repo = await GitRepository.open(process.argv[1], 'project'); await repo.createWorktree('crashed', 'agent/TASK-crashed', process.argv[2]);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, join(root, 'runner'), baseline], {
    detached: true, stdio: 'ignore', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  if (!child.pid) throw new Error('시험용 Runner 시작 실패');
  try {
    await vi.waitFor(async () => { expect((await lstat(marker)).isFile()).toBe(true); }, { timeout: 10_000 });
    const owner = JSON.parse(await readFile(join(root, 'runner/state/git/project.json.lock'), 'utf8')) as Record<string, unknown>;
    expect(owner).toEqual(await ownerRecord(child.pid));
  } finally {
    const exited = once(child, 'exit');
    process.kill(-child.pid, 'SIGKILL');
    await exited;
  }
  const restarted = await GitRepository.open(join(root, 'runner'), 'project');
  await withoutLongLockWait(() => restarted.removeWorktree('crashed'));
  const next = await restarted.createWorktree('next', 'agent/TASK-crashed', baseline);
  expect(git(next, 'rev-parse', 'HEAD')).toBe(baseline);
});

test('L1 flock가 없으면 명확히 실패하고 남은 잠금을 보존한 뒤 설치 후 재시도할 수 있다', async () => {
  repo = await clone();
  const path = join(root, 'runner/state/git/project.json.lock');
  const content = JSON.stringify({ ...await ownerRecord(), bootId: '00000000-0000-0000-0000-000000000000' });
  await writeFile(path, content);
  const bin = join(root, 'empty-bin');
  await mkdir(bin);
  vi.stubEnv('PATH', bin);
  await expect(repo.createWorktree('task-1', 'agent/TASK-1', baseline)).rejects.toThrow(/flock/);
  expect(await readFile(path, 'utf8')).toBe(content);
  vi.unstubAllEnvs();
  await repo.createWorktree('task-1', 'agent/TASK-1', baseline);
});

test('L1 회수 구간에 다른 실행이 얻은 새 잠금은 재확인하여 보존한다', async () => {
  repo = await clone();
  const path = join(root, 'runner/state/git/project.json.lock');
  const live = JSON.stringify(await ownerRecord());
  await writeFile(path, JSON.stringify({ ...await ownerRecord(), bootId: '00000000-0000-0000-0000-000000000000' }));
  const bin = join(root, 'flock-bin');
  await file(join(bin, 'flock'), `#!${process.execPath}\nconst fs = require('node:fs'); const { spawnSync } = require('node:child_process'); fs.unlinkSync(${JSON.stringify(path)}); fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(live)}, { flag: 'wx' }); const result = spawnSync('/usr/bin/flock', process.argv.slice(2), { stdio: ['ignore', 'ignore', 'ignore', 3] }); process.exit(result.status ?? 1);\n`);
  await chmod(join(bin, 'flock'), 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  await withoutLongLockWait(() => expect(repo.createWorktree('task-1', 'agent/TASK-1', baseline)).rejects.toThrow(/잠금 대기/));
  expect(await readFile(path, 'utf8')).toBe(live);
  await expect(lstat(join(root, 'runner/worktrees/project/task-1'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('전용 계정 격리(agentRoot): 작업 폴더·입력 사본은 Agent 작업 영역 아래, 작업 폴더는 0770·파일은 그룹 쓰기 가능(isolation.md §6·§12)', async () => {
  git(source, 'push', 'origin', 'main');
  const agentRoot = join(root, 'srv', 'agentwbs');
  await mkdir(join(agentRoot, 'worktrees'), { recursive: true });
  await mkdir(join(agentRoot, 'inputs'), { recursive: true });
  const shared = await GitRepository.clone(join(root, 'runner'), 'project', remote, { agentRoot });
  const work = await shared.createWorktree('task-1', 'agent/TASK-1-h2', baseline);
  expect(work).toBe(join(agentRoot, 'worktrees', 'project', 'task-1'));
  expect((await lstat(work)).mode & 0o777).toBe(0o770);
  // 조정자 결정 8: 작업 폴더 모음은 0710(Agent는 지나가기만, 목록 못 봄)
  expect((await lstat(join(agentRoot, 'worktrees', 'project'))).mode & 0o777).toBe(0o710);
  // Runner가 checkout한 파일도 그룹 쓰기 가능(ACL 상한이 열려 Agent가 고칠 수 있음)
  expect((await lstat(join(work, 'src/existing.ts'))).mode & 0o060).toBe(0o060);
  expect((await lstat(join(work, '.git'))).mode & 0o070).toBe(0o070);
  const input = await shared.checkoutInput('v1', baseline);
  expect(input).toBe(join(agentRoot, 'inputs', 'project', 'v1'));
  expect((await lstat(join(input, 'prototype/docs/guide.md'))).mode & 0o777).toBe(0o444);
  // Runner 홈에는 작업 폴더·입력 사본을 만들지 않는다(bare 저장소·상태만)
  await expect(lstat(join(root, 'runner', 'worktrees', 'project', 'task-1'))).rejects.toThrow();
  // 재시작 뒤 같은 배치로 다시 열고 결과를 가져온다
  const reopened = await GitRepository.open(join(root, 'runner'), 'project', { agentRoot });
  expect(await reopened.recordedWorktrees()).toEqual(['task-1']);
  expect(await reopened.checkTask(baseline, baseline)).toEqual([]);
});

// M5·M7 통합: M7-01의 시작 정리(남은 ci- 검사 사본 회수)와 Q-08 전용 계정 배치(agentRoot)가 함께 동작해야 한다.
// 왜: 배치 없이 열면 Runner 홈 아래의 없는 폴더를 지우고 생성 기록만 버려, Agent 작업 영역의 진짜 사본이 영영 남는다.
test('전용 계정 격리(agentRoot): 시작 정리는 Agent 작업 영역의 ci 사본을 지우고 기록도 정리한다', async () => {
  git(source, 'push', 'origin', 'main');
  const agentRoot = join(root, 'srv', 'agentwbs');
  await mkdir(join(agentRoot, 'worktrees'), { recursive: true });
  await mkdir(join(agentRoot, 'inputs'), { recursive: true });
  const shared = await GitRepository.clone(join(root, 'runner'), 'project', remote, { agentRoot });
  const stale = 'ci-11111111-1111-4111-8111-111111111111';
  const stalePath = await shared.createTaskCheckWorktree(stale, baseline);
  expect(stalePath).toBe(join(agentRoot, 'worktrees', 'project', stale));
  await GitRepository.recoverTaskChecks(join(root, 'runner'), { agentRoot });
  await expect(lstat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await (await GitRepository.open(join(root, 'runner'), 'project', { agentRoot })).recordedWorktrees()).toEqual([]);
});

test('agentRoot 없이(기존 배치) 작업 폴더는 그대로 0700', async () => {
  repo = await clone();
  const work = await repo.createWorktree('task-1', 'agent/TASK-1-h2', baseline);
  expect((await lstat(work)).mode & 0o777).toBe(0o700);
  expect(work).toBe(join(root, 'runner', 'worktrees', 'project', 'task-1'));
});
