// 조정자 결정 6~8 · 방어 점검(review-claude.md) 1·2·3: Runner 계정은 Agent가 쓸 수 있는 저장소에서 git을 돌리지 않는다.
// - 리뷰어 PoC를 반대로 단언한다(표식 파일이 생기지 않아야 함).
// - Runner git이 Agent 작업 영역에 닿는 호출을 전부 적어 두고 고정한다(새 접근이 생기면 실패).
import { execFileSync } from 'node:child_process';
import { lstatSync, statSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { AgentGit } from '../../src/git/agent-git.ts';
import { assertRunnerGit, GitRepository, setGitAudit } from '../../src/git/repository.ts';

let root: string, remote: string, head: string, agentRoot: string;
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', '-c', 'commit.gpgSign=false', ...a], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).toString().trim();
beforeEach(async () => {
  root = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'agent-boundary-'));
  remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const src = join(root, 'src');
  execFileSync('git', ['clone', '-q', remote, src]);
  await writeFile(join(src, 'a.txt'), 'a\n'); g(src, 'add', '.'); g(src, 'commit', '-qm', 'a'); g(src, 'push', '-q', 'origin', 'HEAD:main');
  head = g(src, 'rev-parse', 'HEAD');
  agentRoot = join(root, 'srv');
  await mkdir(join(agentRoot, 'worktrees'), { recursive: true }); await mkdir(join(agentRoot, 'inputs'), { recursive: true });
});
afterEach(async () => { setGitAudit(undefined); await rm(root, { recursive: true, force: true }); });

/** Agent 계정 git 자리: git을 돌리지 않고 정해진 답만 준다. 그래야 「Runner가 git을 돌렸는가」만 본다. */
function silentAgentGit(answer: () => { head: string; dirty: boolean }, bundleFrom?: string): AgentGit & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    inspect: async (path) => { calls.push(`inspect ${path}`); return answer(); },
    bundle: async (path, branch, out) => {
      calls.push(`bundle ${path} ${branch}`);
      // 실제 Agent 쪽 bundle 대신, 시험이 Runner와 무관한 원본 저장소에서 같은 커밋의 bundle을 만든다.
      execFileSync('git', ['-C', bundleFrom ?? '', 'branch', '-f', branch, head]);
      execFileSync('git', ['-C', bundleFrom ?? '', 'bundle', 'create', '--quiet', out, `refs/heads/${branch}`]);
    },
  };
}

test('PoC 1 반대 단언: 검사 사본에 partialClone promisor·uploadpack을 심어도 taskCheckPath는 Runner 계정으로 그 명령을 실행하지 않는다', async () => {
  const agentGit = silentAgentGit(() => ({ head, dirty: false }));
  const repo = await GitRepository.clone(join(root, 'runner'), 'project', remote, { agentRoot, restorePermissions: null, agentGit });
  const work = await repo.createTaskCheckWorktree('ci-poc', head);
  const marker = join(root, 'PWNED_as_runner');
  g(work, 'config', 'core.repositoryformatversion', '1');
  g(work, 'config', 'extensions.partialClone', 'x');
  g(work, 'config', 'remote.x.url', remote);
  g(work, 'config', 'remote.x.promisor', 'true');
  g(work, 'config', 'remote.x.uploadpack', `id -un > ${marker}; git-upload-pack`);
  await writeFile(join(work, '.git', 'refs', 'heads', 'agent', 'ci-poc'), '1'.repeat(40) + '\n');
  const touched: string[][] = [];
  setGitAudit((cwd, args) => { if ([cwd, ...args].some((v) => v.includes(work))) touched.push([cwd, ...args]); });
  await repo.taskCheckPath('ci-poc', head);
  await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(touched).toEqual([]);
  expect(agentGit.calls).toEqual([`inspect ${work}`]);
});

test('PoC 2 반대 단언: 작업 폴더는 Runner 전용 준비 폴더(0700)에서 clone·checkout을 끝낸 뒤에만 제자리에 나타난다', async () => {
  const repo = await GitRepository.clone(join(root, 'runner'), 'project', remote, { agentRoot, restorePermissions: null, agentGit: silentAgentGit(() => ({ head, dirty: false })) });
  const final = join(agentRoot, 'worktrees', 'project', 'ci-race');
  const seen: { op: string; finalExists: boolean; buildMode: number }[] = [];
  setGitAudit((cwd, args) => {
    const op = args.find((a) => ['clone', 'remote', 'checkout'].includes(a));
    if (!op) return;
    const build = op === 'clone' ? args.at(-1) ?? '' : cwd;
    let finalExists = true;
    try { lstatSync(final); } catch { finalExists = false; }
    seen.push({ op, finalExists, buildMode: statSync(op === 'clone' ? join(build, '..') : build).mode & 0o777 });
  });
  await repo.createTaskCheckWorktree('ci-race', head);
  // clone은 준비 폴더를 대상으로(부모는 0710), remote·checkout은 0700 준비 폴더 안에서. 그동안 최종 경로는 없다.
  expect(seen).toEqual([{ op: 'clone', finalExists: false, buildMode: 0o710 }, { op: 'remote', finalExists: false, buildMode: 0o700 }, { op: 'checkout', finalExists: false, buildMode: 0o700 }]);
  expect(statSync(final).mode & 0o777).toBe(0o770);
  // 넘긴 뒤 Agent가 filter를 심어도 Runner git은 더는 이 폴더를 쓰지 않는다(아래 전수 목록 시험).
  expect((await readdir(join(agentRoot, 'worktrees', 'project'))).filter((n) => n.startsWith('.prep-'))).toEqual([]);
});

test('전수 목록: Runner git이 Agent 작업 영역에 닿는 호출은 준비 폴더 안의 clone·remote remove·checkout뿐이다', async () => {
  const src = join(root, 'src');
  const agentGit = silentAgentGit(() => ({ head, dirty: false }), src);
  const repo = await GitRepository.clone(join(root, 'runner'), 'project', remote, { agentRoot, restorePermissions: null, agentGit });
  const area = join(agentRoot, 'worktrees');
  const calls: string[] = [];
  setGitAudit((cwd, args) => {
    const values = [cwd, ...args];
    if (!values.some((v) => v.includes(area))) return;
    const op = args.find((a) => !a.startsWith('-') && !a.includes('=') && a !== 'init.templateDir=') ?? '';
    calls.push(`${op} cwd=${cwd.includes(area) ? cwd.replace(/\.prep-[0-9a-f-]{36}/, '.prep-*').replace(area, '<area>') : '<runner>'}`);
  });
  // 시도 작업 폴더 → Agent 결과 가져오기 → ① 검사 사본 → 상태 확인 → 삭제 → 초기화
  await repo.createWorktree('task-1', 'agent/TASK-1', head);
  expect(await repo.importWorktree('task-1', 'agent/TASK-1')).toBe(head);
  await repo.createTaskCheckWorktree('ci-1', head);
  await repo.taskCheckPath('ci-1', head);
  await repo.removeWorktree('ci-1');
  await repo.removeWorktree('task-1');
  await repo.beginReset();
  await repo.endReset();
  const prep = (op: string) => op === 'clone' ? 'clone cwd=<runner>' : `${op} cwd=<area>/project/.prep-*`;
  expect(calls).toEqual(['clone', 'remote', 'checkout', 'clone', 'remote', 'checkout'].map(prep));
  expect(agentGit.calls.map((c) => c.split(' ')[0])).toEqual(['bundle', 'inspect']);
});

test('가드: Runner git의 cwd·--git-dir·--work-tree·경로 인자가 Agent 작업 폴더면 거부한다(준비 폴더만 예외)', async () => {
  await GitRepository.clone(join(root, 'runner'), 'project', remote, { agentRoot, restorePermissions: null, agentGit: silentAgentGit(() => ({ head, dirty: false })) });
  const area = join(agentRoot, 'worktrees', 'project');
  for (const [cwd, args] of [
    [join(area, 'task-1'), ['rev-parse', 'HEAD']],
    ['/tmp', [`--git-dir=${join(area, 'task-1', '.git')}`, 'rev-parse', 'HEAD']],
    ['/tmp', [`--work-tree=${join(area, 'ci-1')}`, 'diff']],
    ['/tmp', ['fetch', '--', join(area, 'task-1', '.git'), 'x']],
  ] as const) expect(() => assertRunnerGit(cwd, args)).toThrow('조정자 결정 6');
  expect(() => assertRunnerGit(join(area, '.prep-0b6f3c2e-6a1d-4f7e-8a9b-0123456789ab'), ['checkout', 'x'])).not.toThrow();
  expect(() => assertRunnerGit(join(area, '.prep-evil'), ['checkout', 'x'])).toThrow();
});

test('방어 점검 3: 삭제 중 Agent 폴더가 Runner 폴더를 가리키는 링크로 바뀌어도 링크만 지우고 Runner 파일은 남긴다', async () => {
  const repo = await GitRepository.clone(join(root, 'runner'), 'project', remote, { agentRoot, restorePermissions: null, agentGit: silentAgentGit(() => ({ head, dirty: false })) });
  const work = await repo.createWorktree('task-1', 'agent/TASK-1', head);
  const precious = join(root, 'runner-secret');
  await mkdir(precious); await writeFile(join(precious, 'token'), 'secret');
  await mkdir(join(work, 'sub'));
  await rm(join(work, 'sub'), { recursive: true });
  await symlink(precious, join(work, 'sub'));
  await repo.removeWorktree('task-1');
  await expect(access(join(precious, 'token'))).resolves.toBeUndefined();
  await expect(access(work)).rejects.toMatchObject({ code: 'ENOENT' });
});
