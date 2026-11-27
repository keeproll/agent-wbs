// 청결 확인의 무시 규칙(collect-prepare 방어 점검): 추적 안 된 파일은 무시 규칙 없이 모두 뽑고, 무시 여부는 「커밋된」 .gitignore로만 정한다.
// Agent가 바꿀 수 있는 무시 설정(.git/info/exclude, 저장소 설정의 core.excludesFile, 커밋하지 않은 하위 .gitignore)으로 남긴 파일을 숨길 수 없어야 한다.
// 같은 계정 배치(Runner git + 임시 index)와 전용 계정 모양(Agent 쪽 git 대역 localAgentGit) 둘 다 같은 규칙인지 본다. 래퍼 쪽은 test/cli/agent-exec.test.ts.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { localAgentGit, untrackedNotIgnored } from '../../src/git/agent-git.ts';
import { GitRepository } from '../../src/git/repository.ts';
import { commit, file, fixture, git } from '../ci/int-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
const extra: string[] = [];
afterEach(async () => { await f.close(); for (const dir of extra.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function layouts() {
  f = await fixture();
  await file(join(f.source, '.gitignore'), 'node_modules/\ndist/\n*.log\n!keep.log\n');
  await file(join(f.source, 'sub/.gitignore'), 'gen/\n');
  commit(f.source); git(f.source, 'push', f.remote, 'main');
  const area = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'ignore-area-'));
  extra.push(area);
  const shared = await GitRepository.clone(join(f.root, 'shared-runner'), 'project', f.remote, { agentRoot: area, restorePermissions: null, agentGit: localAgentGit() });
  await f.repo.fetch();
  return { same: f.repo, shared, head: f.ref('main') };
}

describe.each(['same', 'shared'] as const)('%s 배치', kind => {
  test('커밋된 규칙으로 무시되는 파일·Runner 폴더는 깨끗하고, Agent가 바꾼 무시 설정으로 숨긴 파일은 더럽다', async () => {
    const all = await layouts();
    const repo = all[kind];
    const path = await repo.createTaskCheckWorktree('ci-hide', all.head);
    const check = () => repo.taskCheckPath('ci-hide', all.head).then(() => 'clean', (error: Error) => error.message.includes('커밋하지 않은 변경') ? 'dirty' : `error: ${error.message}`);
    const put = async (rel: string, text = 'x') => { await mkdir(join(path, rel, '..'), { recursive: true }); await writeFile(join(path, rel), text); };
    for (const rel of ['node_modules/a/b.js', 'dist/out.js', 'build.log', 'sub/gen/z.txt', '.awbs-evidence/e.png']) await put(rel);
    expect(await check()).toBe('clean');
    // 1) .git/info/exclude
    await put('secret.txt');
    await mkdir(join(path, '.git', 'info'), { recursive: true });
    await writeFile(join(path, '.git', 'info', 'exclude'), 'secret.txt\n', { flag: 'a' });
    expect(await check()).toBe('dirty');
    await rm(join(path, 'secret.txt'));
    expect(await check()).toBe('clean');
    // 2) 저장소 설정의 core.excludesFile(Agent가 쓸 수 있는 .git/config)
    await put('secret2.txt');
    await writeFile(join(path, 'rules'), 'secret2.txt\nrules\n');
    git(path, 'config', 'core.excludesFile', join(path, 'rules'));
    expect(await check()).toBe('dirty');
    await rm(join(path, 'secret2.txt')); await rm(join(path, 'rules')); git(path, 'config', '--unset', 'core.excludesFile');
    // 3) 커밋하지 않은 하위 .gitignore(`*`로 자신까지 숨김)
    await put('hide/.gitignore', '*\n'); await put('hide/x');
    expect(git(path, 'status', '--porcelain')).not.toContain('hide');
    expect(await check()).toBe('dirty');
    await rm(join(path, 'hide'), { recursive: true });
    // 4) 부정 규칙(!keep.log)은 무시하지 않는다
    await put('keep.log');
    expect(await check()).toBe('dirty');
    await rm(join(path, 'keep.log'));
    expect(await check()).toBe('clean');
    await repo.removeWorktree('ci-hide');
  });
});

test('untrackedNotIgnored: 규칙 경로는 저장소 상대 .gitignore만 받는다', async () => {
  await expect(untrackedNotIgnored(Buffer.from('a\0'), [{ path: '../x/.gitignore', content: Buffer.from('*') }])).rejects.toThrow('무시 규칙 경로');
  await expect(untrackedNotIgnored(Buffer.from('a\0'), [{ path: 'rules', content: Buffer.from('*') }])).rejects.toThrow('무시 규칙 경로');
  expect(await untrackedNotIgnored(Buffer.from('a\0b.log\0'), [{ path: '.gitignore', content: Buffer.from('*.log\n') }])).toEqual(['a']);
  expect(await untrackedNotIgnored(Buffer.from(''), [])).toEqual([]);
});

// collect-prepare P2-1(방어 점검 재현): Agent가 .git을 고쳐 git status를 「깨끗함」으로 속여도, 청결 판정은 실제 파일 목록·내용과
// Runner bare 저장소의 커밋 tree를 대조하므로 속지 않는다. 네 통로: clean filter(+index stat 0), core.worktree, stat 위조, replace 객체.
describe.each(['same', 'shared'] as const)('%s 배치: .git 위조 통로', kind => {
  const tricks: Record<string, (path: string) => Promise<void>> = {
    'A. clean filter + index stat 0': async path => {
      await writeFile(join(path, 'shared'), 'changed by agent\n');
      await mkdir(join(path, '.git', 'info'), { recursive: true });
      await writeFile(join(path, '.git', 'info', 'attributes'), 'shared filter=x\n');
      git(path, 'config', 'filter.x.clean', 'git show HEAD:shared');
      const blob = git(path, 'rev-parse', 'HEAD:shared');
      execFileSync('git', ['-C', path, 'update-index', '--index-info'], { input: `100644 ${blob}\tshared\n` });
    },
    'B. core.worktree': async path => {
      const decoy = `${path}-decoy`;
      execFileSync('cp', ['-a', path, decoy]);
      await rm(join(decoy, '.git'), { recursive: true, force: true });
      await writeFile(join(path, 'shared'), 'changed by agent\n');
      git(path, 'config', 'core.worktree', decoy);
    },
    'D. stat 위조': async path => {
      execFileSync('sleep', ['1.1']); git(path, 'update-index', '--refresh');
      const before = execFileSync('stat', ['-c', '%Y', join(path, 'shared')], { encoding: 'utf8' }).trim();
      git(path, 'config', 'core.checkStat', 'minimal'); git(path, 'config', 'core.trustctime', 'false');
      await writeFile(join(path, 'shared'), 'ORIGINAL');
      execFileSync('touch', ['-d', `@${before}`, join(path, 'shared')]);
    },
    'E. replace 객체': async path => {
      const original = git(path, 'rev-parse', 'HEAD');
      await writeFile(join(path, 'shared'), 'changed by agent\n'); await writeFile(join(path, 'x.ts'), 'new');
      git(path, 'add', '-A'); git(path, 'commit', '-qm', 'fake');
      const fake = git(path, 'rev-parse', 'HEAD');
      git(path, 'update-ref', `refs/heads/${git(path, 'symbolic-ref', '--short', 'HEAD')}`, original);
      git(path, 'replace', original, fake);
    },
  };
  test.each(Object.keys(tricks))('%s: git status는 깨끗하다고 하지만 청결 판정은 변경을 잡는다', async name => {
    const all = await layouts();
    const repo = all[kind];
    const path = await repo.createTaskCheckWorktree('ci-trick', all.head);
    await repo.taskCheckPath('ci-trick', all.head);
    await tricks[name]?.(path);
    expect(git(path, 'status', '--porcelain', '--untracked-files=no'), '보통 git status는 속는다').toBe('');
    await expect(repo.taskCheckPath('ci-trick', all.head)).rejects.toThrow('커밋하지 않은 변경');
    await rm(`${path}-decoy`, { recursive: true, force: true });
  }, 20_000);
});
