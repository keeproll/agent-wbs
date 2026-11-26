import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

export class GitSafetyError extends Error {
  override name = 'GitSafetyError';
}

export interface ResetOptions {
  baseCommit: string | null;
  /** 서버 정리 명령에 기록된 목록만 전달한다. agent/* 검색 결과를 넣으면 안 된다. */
  branches: string[];
  worktrees: string[];
  inputs: string[];
}

export interface RejectedPath {
  path: string;
  reason: 'protected' | 'ignored';
}

interface TreeEntry { mode: string; oid: string; path: string }

function id(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) throw new GitSafetyError('관리 폴더 이름이 올바르지 않습니다.');
  return value;
}

function sha(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new GitSafetyError('고정된 전체 커밋 SHA가 필요합니다.');
  return value;
}

async function stat(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** 삭제·쓰기 전에 모든 상위 폴더도 검사한다. realpath만 쓰면 링크를 정상 경로로 오인한다. */
async function safePath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new GitSafetyError('관리 폴더는 절대 경로여야 합니다.');
  let current = parse(path).root;
  for (const part of relative(current, path).split('/').filter(Boolean)) {
    current = join(current, part);
    if ((await stat(current))?.isSymbolicLink()) throw new GitSafetyError('관리 경로의 symlink는 허용하지 않습니다.');
  }
  return path;
}

async function run(cwd: string, args: string[], input?: Buffer | string, extraEnv: NodeJS.ProcessEnv = {}, allowed = [0]): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.excludesFile=/dev/null',
      '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'core.sshCommand=false',
      '-c', 'alias.lfs=',
      '-c', 'commit.gpgSign=false', '-c', 'user.name=Agent WBS', '-c', 'user.email=agentwbs@localhost', ...args], {
      cwd,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: 'file:https', GIT_LFS_SKIP_SMUDGE: '1', ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    // git 오류 원문에는 URL·인증 정보가 들어갈 수 있으므로 외부에 내보내지 않는다.
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.resume();
    child.on('error', () => { reject(new GitSafetyError('git 명령을 실행할 수 없습니다.')); });
    child.on('close', (code) => {
      if (code !== null && allowed.includes(code)) resolvePromise(Buffer.concat(output));
      else reject(new GitSafetyError('git 작업이 실패했습니다. 저장소·커밋·도구 설치를 확인하세요.'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

async function removeReadonly(path: string): Promise<void> {
  const info = await stat(path);
  if (!info) return;
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await removeReadonly(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
}

/** 네트워크 쓰기는 GitHub 어댑터의 권한 확인 뒤 별도로 수행한다. 이 계층에는 push가 없다. */
export class GitRepository {
  readonly path: string;
  readonly repositoryId: string;
  private readonly home: string;
  private readonly worktrees: string;
  private readonly inputs: string;

  private constructor(home: string, repositoryId: string) {
    this.home = home;
    this.repositoryId = repositoryId;
    this.path = join(home, 'repos', repositoryId);
    this.worktrees = join(home, 'worktrees', repositoryId);
    this.inputs = join(home, 'inputs', repositoryId);
  }

  private static async prepare(home: string, repositoryId: string): Promise<GitRepository> {
    id(repositoryId);
    await safePath(home);
    // WSL의 Windows 드라이브는 작업 폴더로 사용하지 않는다(가이드 §6.6).
    if (/^\/mnt\/[a-z](?:\/|$)/i.test(resolve(home))) throw new GitSafetyError('worktree는 Linux 파일 시스템에 만들어야 합니다.');
    const repo = new GitRepository(home, repositoryId);
    for (const path of [dirname(repo.path), repo.worktrees, repo.inputs]) {
      await safePath(path);
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    if ((await statfs(repo.worktrees)).type !== 0xef53) throw new GitSafetyError('worktree는 ext4 파일 시스템에 만들어야 합니다.');
    await safePath(repo.path);
    return repo;
  }

  static async clone(home: string, repositoryId: string, source: string): Promise<GitRepository> {
    const repo = await this.prepare(home, repositoryId);
    const url = URL.parse(source);
    if (!isAbsolute(source) && (!url || !['https:', 'file:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)) {
      throw new GitSafetyError('인증 정보가 없는 저장소 주소 또는 로컬 절대 경로가 필요합니다.');
    }
    if (await stat(repo.path)) throw new GitSafetyError('이미 존재하는 저장소를 덮어쓰지 않습니다.');
    await mkdir(repo.path, { mode: 0o700 });
    try {
      await run(home, ['-c', 'init.templateDir=', 'clone', '--bare', '--no-local', '--', source, repo.path]);
      await repo.head();
      return repo;
    } catch (error) {
      await rm(repo.path, { recursive: true, force: true });
      throw error;
    }
  }

  static async open(home: string, repositoryId: string): Promise<GitRepository> {
    const repo = await this.prepare(home, repositoryId);
    if ((await run(repo.path, ['rev-parse', '--is-bare-repository'])).toString().trim() !== 'true') {
      throw new GitSafetyError('Runner의 bare 저장소가 아닙니다.');
    }
    return repo;
  }

  private async git(args: string[], input?: Buffer | string, env?: NodeJS.ProcessEnv, allowed?: number[]) {
    await safePath(this.path);
    return run(this.path, args, input, env, allowed);
  }

  async head(): Promise<string> {
    return sha((await this.git(['rev-parse', '--verify', 'refs/heads/main^{commit}'])).toString().trim());
  }

  async fetch(): Promise<string> {
    // main은 로컬 초기화 커밋을 보존한다. 갱신 대상을 origin/*로 한정한다.
    await this.git(['fetch', '--prune', '--no-recurse-submodules', 'origin', 'refs/heads/*:refs/remotes/origin/*']);
    return sha((await this.git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'])).toString().trim());
  }

  private async branch(branch: string): Promise<void> {
    if (!branch.startsWith('agent/')) throw new GitSafetyError('시스템이 기록한 Agent 브랜치만 다룰 수 있습니다.');
    await this.git(['check-ref-format', '--branch', branch]);
  }

  async createWorktree(worktreeId: string, branch: string, commit: string): Promise<string> {
    const path = await safePath(join(this.worktrees, id(worktreeId)));
    await this.branch(branch);
    sha(commit);
    if (await stat(path)) throw new GitSafetyError('이미 존재하는 작업 폴더를 덮어쓰지 않습니다.');
    // Agent가 로컬 Git 설정에 외부 필터를 심어도 다음 checkout에서 실행하지 않는다.
    const configured = (await this.git(['config', '--name-only', '--get-regexp', '^filter\\.'], undefined, undefined, [0, 1])).toString().trim();
    const filters = new Set(configured.split('\n').filter(Boolean).map((key) => key.slice(0, key.lastIndexOf('.'))));
    const disable = [...filters].flatMap((filter) => ['-c', `${filter}.process=`, '-c', `${filter}.smudge=`, '-c', `${filter}.clean=`, '-c', `${filter}.required=false`]);
    await this.git([...disable, 'worktree', 'add', '-b', branch, '--', path, commit]);
    return path;
  }

  async removeWorktree(worktreeId: string): Promise<void> {
    const path = await safePath(join(this.worktrees, id(worktreeId)));
    const registered = (await this.git(['worktree', 'list', '--porcelain', '-z'])).toString().split('\0').includes(`worktree ${path}`);
    if (registered) await this.git(['worktree', 'remove', '--force', '--', path]);
    else if (await stat(path)) throw new GitSafetyError('git에 등록되지 않은 폴더는 삭제하지 않습니다.');
  }

  private async tree(commit: string): Promise<TreeEntry[]> {
    const records = (await this.git(['ls-tree', '-r', '-z', sha(commit)])).toString().split('\0').filter(Boolean);
    return records.map((record) => {
      const tab = record.indexOf('\t');
      const [mode, , oid] = record.slice(0, tab).split(' ');
      if (!mode || !oid) throw new GitSafetyError('git tree 형식이 올바르지 않습니다.');
      return { mode, oid, path: record.slice(tab + 1) };
    });
  }

  private async blob(entry: TreeEntry): Promise<Buffer> {
    return this.git(['cat-file', 'blob', entry.oid]);
  }

  async checkoutInput(inputId: string, commit: string): Promise<string> {
    const path = await safePath(join(this.inputs, id(inputId)));
    sha(commit);
    if (await stat(path)) throw new GitSafetyError('기존 입력 버전은 덮어쓰지 않습니다.');
    const entries = (await this.tree(commit)).filter((entry) => entry.path === 'prototype' || entry.path.startsWith('prototype/'));
    if (entries.length === 0) throw new GitSafetyError('prototype 입력이 없습니다.');
    for (const entry of entries) {
      if (entry.mode === '120000') throw new GitSafetyError('입력의 symlink는 허용하지 않습니다.');
      if (entry.mode === '160000') throw new GitSafetyError('입력의 submodule은 따라가지 않습니다.');
      if (!['100644', '100755'].includes(entry.mode) || entry.path.split('/').some((p) => ['.', '..', '.git'].includes(p))) {
        throw new GitSafetyError('입력 경로·파일 형식이 올바르지 않습니다.');
      }
    }
    await mkdir(path, { mode: 0o700 });
    try {
      for (const entry of entries) {
        let content = await this.blob(entry);
        if (content.toString().startsWith('version https://git-lfs.github.com/spec/v1\n')) {
          const pointer = /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n$/.exec(content.toString());
          const oid = pointer?.[1];
          if (!pointer || !oid) throw new GitSafetyError('Git LFS 포인터 형식이 올바르지 않습니다.');
          await this.git(['lfs', 'version']);
          await this.git(['lfs', 'fetch', 'origin', commit]);
          content = await readFile(await safePath(join(this.path, 'lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid)));
          if (content.length !== Number(pointer[2]) || createHash('sha256').update(content).digest('hex') !== oid) {
            throw new GitSafetyError('Git LFS 파일의 크기·해시가 일치하지 않습니다.');
          }
        }
        const target = join(path, entry.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { flag: 'wx', mode: 0o444 });
      }
      async function lock(folder: string): Promise<void> {
        for (const name of await readdir(folder, { withFileTypes: true })) {
          if (name.isDirectory()) await lock(join(folder, name.name));
        }
        await chmod(folder, 0o555);
      }
      await lock(path);
      return path;
    } catch (error) {
      await removeReadonly(path);
      throw error;
    }
  }

  async removeInput(inputId: string): Promise<void> {
    await removeReadonly(await safePath(join(this.inputs, id(inputId))));
  }

  async checkTask(base: string, head: string): Promise<RejectedPath[]> {
    const mergeBase = sha((await this.git(['merge-base', sha(base), sha(head)])).toString().trim());
    // --no-renames면 이동도 삭제+추가가 되어 원래 경로와 새 경로를 모두 검사한다.
    const changed = (await this.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', mergeBase, head, '--'])).toString().split('\0').filter(Boolean);
    const rejected: RejectedPath[] = changed.filter((path) => ['prototype', '.agentwbs'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
      .map((path) => ({ path, reason: 'protected' }));
    const entries = await this.tree(head);
    const tracked = entries.map((entry) => entry.path);
    // 작업 브랜치가 .gitignore를 지워 검사에서 빠져나가지 못하도록 기준 규칙도 적용한다.
    for (const commit of new Set([mergeBase, head])) {
      const scratch = await safePath(join(this.home, 'inputs', this.repositoryId, `ignore-${randomUUID()}`));
      await mkdir(scratch, { mode: 0o700 });
      try {
        for (const entry of await this.tree(commit)) {
          if (entry.path.split('/').at(-1) !== '.gitignore') continue;
          if (entry.mode !== '100644' && entry.mode !== '100755') throw new GitSafetyError('gitignore는 일반 파일이어야 합니다.');
          const target = join(scratch, entry.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, await this.blob(entry), { flag: 'wx' });
        }
        const ignored = (await this.git([`--work-tree=${scratch}`, 'check-ignore', '--no-index', '-z', '--stdin'], `${tracked.join('\0')}\0`, undefined, [0, 1])).toString().split('\0').filter(Boolean);
        for (const path of ignored) {
          if (!rejected.some((item) => item.path === path && item.reason === 'ignored')) rejected.push({ path, reason: 'ignored' });
        }
      } finally { await rm(scratch, { recursive: true, force: true }); }
    }
    return rejected;
  }

  async reset(options: ResetOptions): Promise<{ commit: string | null }> {
    for (const name of options.worktrees) id(name);
    for (const name of options.inputs) id(name);
    // 기준 커밋이 없는 명령은 저장소 정리를 포함하지 않는다(가이드 §9.5-2).
    if (options.baseCommit === null) return { commit: null };
    const baseline = sha(options.baseCommit);
    for (const branch of options.branches) await this.branch(branch);
    const local = await this.head();
    const current = await this.fetch();
    const target = (path: string) => ['src', 'contracts', '.agentwbs'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    const entries = [...(await this.tree(current)).filter((entry) => !target(entry.path)), ...(await this.tree(baseline)).filter((entry) => target(entry.path))];
    const index = await safePath(join(this.path, `agentwbs-index-${randomUUID()}`));
    const env = { GIT_INDEX_FILE: index };
    let result = local;
    try {
      await this.git(['read-tree', '--empty'], undefined, env);
      const records = entries.map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join('');
      await this.git(['update-index', '-z', '--index-info'], records, env);
      const tree = (await this.git(['write-tree'], undefined, env)).toString().trim();
      const oldTree = (await this.git(['rev-parse', `${current}^{tree}`])).toString().trim();
      const localTree = (await this.git(['rev-parse', `${local}^{tree}`])).toString().trim();
      const ancestor = (await this.git(['merge-base', current, local])).toString().trim();
      // 아직 push하지 않은 같은 되돌림 커밋은 재시도 때 재사용한다.
      if (tree !== localTree || ancestor !== current) {
        result = tree === oldTree ? current : sha((await this.git(['commit-tree', tree, '-p', current, '-m', 'Agent WBS 프로젝트 초기화'])).toString().trim());
        await this.git(['update-ref', 'refs/heads/main', result, local]);
      }
    } finally { await rm(index, { force: true }); }
    for (const name of options.worktrees) await this.removeWorktree(name);
    for (const name of options.inputs) await this.removeInput(name);
    for (const branch of new Set(options.branches)) {
      // 없는 브랜치는 재시도의 정상 결과다. 체크아웃된 브랜치는 git이 삭제를 거부한다.
      const ref = `refs/heads/${branch}`;
      const existing = (await this.git(['for-each-ref', '--format=%(refname)', ref])).toString().trim().split('\n');
      if (existing.includes(ref)) await this.git(['branch', '-D', '--', branch]);
    }
    return { commit: result };
  }
}
