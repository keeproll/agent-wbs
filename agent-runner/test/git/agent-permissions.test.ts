// M8 전 연결: 전용 계정 배치에서 Agent가 자기 파일 권한을 지워 작업 폴더 삭제가 막히면 래퍼 fix-perms로 되돌린 뒤 지운다.
// 같은 계정 시험에서는 권한 거부를 만들 수 없어 삭제(treeOps.remove)만 한 번 EACCES로 바꾼다. 실제 Agent 계정 재현은 dedicated-scope.host.ts.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

const blocked = new Set<string>();
const { GitRepository, treeOps } = await import('../../src/git/repository.ts');
const realRemove = treeOps.remove;
// 같은 계정 시험에서는 권한 거부를 만들 수 없어, 그 경로의 첫 삭제만 EACCES로 바꾼다.
treeOps.remove = async (path: string) => {
  if (blocked.delete(path)) throw Object.assign(new Error('권한 없음(시험)'), { code: 'EACCES' });
  return realRemove(path);
};

let root: string, remote: string, base: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgSign=false', ...args],
  { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
beforeEach(async () => {
  root = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'agent-perms-'));
  const source = join(root, 'source');
  remote = join(root, 'remote.git');
  await mkdir(join(source, 'src'), { recursive: true });
  git(source, 'init', '-b', 'main');
  await writeFile(join(source, 'src/a.ts'), 'a');
  git(source, 'add', '-A'); git(source, 'commit', '-m', 'base');
  base = git(source, 'rev-parse', 'HEAD');
  git(source, 'init', '--bare', '-b', 'main', remote);
  git(source, 'push', remote, 'main');
});
afterEach(async () => { blocked.clear(); await rm(root, { recursive: true, force: true }); });

async function workspace(restorePermissions: ((path: string) => Promise<void>) | null) {
  const agentRoot = join(root, 'srv', 'agentwbs');
  await mkdir(join(agentRoot, 'worktrees'), { recursive: true });
  await mkdir(join(agentRoot, 'inputs'), { recursive: true });
  const repo = await GitRepository.clone(join(root, 'runner'), 'project', remote, { agentRoot, restorePermissions });
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', base);
  return { repo, work };
}

test('권한 거부로 막히면 fix-perms를 한 번 부르고 다시 지운다', async () => {
  const restored: string[] = [];
  const { repo, work } = await workspace(async path => { restored.push(path); });
  blocked.add(work);
  await repo.removeWorktree('task-1');
  expect(restored).toEqual([work]);
  expect(await repo.recordedWorktrees()).toEqual([]);
});

test('fix-perms가 실패하면 지우지 않고 생성 기록도 남긴다', async () => {
  const { repo, work } = await workspace(async () => { throw new Error('fixed를 받지 못함'); });
  blocked.add(work);
  await expect(repo.removeWorktree('task-1')).rejects.toThrow('fixed를 받지 못함');
  expect(await repo.recordedWorktrees()).toEqual(['task-1']);
});

test('되돌리는 방법이 없으면(null) 원래 권한 오류를 그대로 올린다', async () => {
  const { repo, work } = await workspace(null);
  blocked.add(work);
  await expect(repo.removeWorktree('task-1')).rejects.toMatchObject({ code: 'EACCES' });
});
