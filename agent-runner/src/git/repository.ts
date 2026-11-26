import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

export class GitSafetyError extends Error {
  override name = 'GitSafetyError';
}

export interface CleanupFailure { name: string; path: string; detail: string }

export class GitCleanupError extends GitSafetyError {
  override name = 'GitCleanupError';
  readonly failures: CleanupFailure[];

  constructor(failures: CleanupFailure[]) {
    super(`정리하지 못한 경로에 수동 조치가 필요합니다: ${failures.map((failure) => failure.path).join(', ')}`);
    this.failures = failures;
  }
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
interface WorktreeRecord { id: string; branch?: string; startCommit?: string }
interface Registration { source: string; configHash: string; worktrees: WorktreeRecord[]; resetting?: boolean; resetGeneration?: number }
interface LockOwner { pid: number; bootId?: string; startTime?: string }
const BOOT_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function worktreeRecord(value: unknown): WorktreeRecord {
  // 구버전 기록은 폴더만 정리한다. 브랜치 소유권을 추측하지 않는다.
  if (typeof value === 'string') return { id: id(value) };
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') {
    throw new GitSafetyError('작업 폴더 생성 기록이 올바르지 않습니다.');
  }
  const name = id(value.id);
  if (!('branch' in value) && !('startCommit' in value)) return { id: name };
  if (!('branch' in value) || typeof value.branch !== 'string' || !value.branch.startsWith('agent/') ||
    !('startCommit' in value) || typeof value.startCommit !== 'string') {
    throw new GitSafetyError('작업 폴더 브랜치 기록이 올바르지 않습니다.');
  }
  return { id: name, branch: value.branch, startCommit: sha(value.startCommit) };
}

async function startTime(pid: number): Promise<string> {
  const value = await readFile(`/proc/${pid}/stat`, 'utf8');
  const time = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  if (!time || !/^(0|[1-9]\d*)$/.test(time)) throw new GitSafetyError('프로세스 시작 시간을 확인할 수 없습니다.');
  return time;
}

function lockOwner(value: string): LockOwner | undefined {
  let record: unknown;
  try { record = JSON.parse(value); } catch { return undefined; }
  // 이전 버전의 PID 단독 잠금은 그 PID가 실제로 없을 때만 회수한다.
  if (typeof record === 'number' && /^[1-9]\d*$/.test(value.trim()) && Number.isInteger(record) && record <= 2147483647) return { pid: record };
  if (!record || typeof record !== 'object' || !('pid' in record) || typeof record.pid !== 'number' ||
    !Number.isInteger(record.pid) || record.pid <= 0 || record.pid > 2147483647 ||
    !('bootId' in record) || typeof record.bootId !== 'string' || !BOOT_ID.test(record.bootId) ||
    !('startTime' in record) || typeof record.startTime !== 'string' || !/^(0|[1-9]\d*)$/.test(record.startTime)) return undefined;
  return { pid: record.pid, bootId: record.bootId, startTime: record.startTime };
}

async function ownerGone(owner: LockOwner, bootId: string): Promise<boolean> {
  if (owner.bootId !== undefined && owner.bootId !== bootId) return true;
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  if (owner.startTime === undefined) return false;
  try { return await startTime(owner.pid) !== owner.startTime; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}

async function lockContent(path: string): Promise<string | undefined> {
  try { return await readFile(await safePath(path), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function recoverLock(path: string, bootId: string): Promise<boolean> {
  const expected = await lockContent(path);
  if (expected === undefined) return true;
  const owner = lockOwner(expected);
  if (!owner || !await ownerGone(owner, bootId)) return false;
  const guard = await open(await safePath(`${path}.recover`), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    // flock는 부모와 공유한 열린 파일에 걸린다. 부모가 강제 종료돼도 커널이 잠금을 해제한다.
    const held = await new Promise<boolean>((resolvePromise, reject) => {
      const child = spawn('flock', ['-n', '-E', '75', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', guard.fd], env: { PATH: process.env.PATH },
      });
      child.on('error', () => { reject(new GitSafetyError('잠금 회수에 필요한 Linux flock를 실행할 수 없습니다.')); });
      child.on('close', (code) => {
        if (code === 0 || code === 75) resolvePromise(code === 0);
        else reject(new GitSafetyError('잠금 회수용 배타 잠금을 얻지 못했습니다.'));
      });
    });
    if (!held) return false;
    // 다른 회수자가 새 잠금을 만든 뒤라면 절대 지우지 않고 처음부터 다시 확인한다.
    if (await lockContent(path) !== expected) return true;
    if (!await ownerGone(owner, bootId)) return false;
    await rm(path);
    return true;
  } finally { await guard.close(); }
}

function sourceUrl(source: string): string {
  const url = URL.parse(source);
  if (!isAbsolute(source) && (!url || !['https:', 'file:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)) {
    throw new GitSafetyError('인증 정보가 없는 저장소 주소 또는 로컬 절대 경로가 필요합니다.');
  }
  return source;
}

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
      '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true',
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

/** 입력 복사의 임시 폴더 접두사. 점으로 시작하므로 `inputIds()`(입력 이름)에 섞이지 않는다. */
const INPUT_TEMP = '.copy-';

/**
 * 이 프로세스에서 진행 중인 입력 복사(저장소 경로별). 초기화가 시작되면 먼저 이것들을 취소하고 잠금을 기다린다.
 * 다른 프로세스의 복사는 취소 신호를 받을 수 없으므로 잠금이 풀리기(또는 죽은 주인의 잠금이 회수되기)를 기다린다.
 */
const activeCopies = new Map<string, Set<AbortController>>();

/** 네트워크 쓰기는 GitHub 어댑터의 권한 확인 뒤 별도로 수행한다. 이 계층의 push는 `pushCommit`(일반 push) 하나뿐이다. */
export class GitRepository {
  readonly path: string;
  readonly repositoryId: string;
  private readonly home: string;
  private readonly worktrees: string;
  private readonly inputs: string;
  private readonly statePath: string;
  private registration: Registration | undefined;

  private constructor(home: string, repositoryId: string) {
    this.home = home;
    this.repositoryId = repositoryId;
    this.path = join(home, 'repos', repositoryId);
    this.worktrees = join(home, 'worktrees', repositoryId);
    this.inputs = join(home, 'inputs', repositoryId);
    this.statePath = join(home, 'state/git', `${repositoryId}.json`);
  }

  private static async prepare(home: string, repositoryId: string): Promise<GitRepository> {
    id(repositoryId);
    await safePath(home);
    // WSL의 Windows 드라이브는 작업 폴더로 사용하지 않는다(가이드 §6.6).
    if (/^\/mnt\/[a-z](?:\/|$)/i.test(resolve(home))) throw new GitSafetyError('worktree는 Linux 파일 시스템에 만들어야 합니다.');
    const repo = new GitRepository(home, repositoryId);
    for (const path of [dirname(repo.path), repo.worktrees, repo.inputs, dirname(repo.statePath)]) {
      await safePath(path);
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    if ((await statfs(repo.worktrees)).type !== 0xef53) throw new GitSafetyError('worktree는 ext4 파일 시스템에 만들어야 합니다.');
    await safePath(repo.path);
    return repo;
  }

  static async clone(home: string, repositoryId: string, source: string): Promise<GitRepository> {
    const repo = await this.prepare(home, repositoryId);
    sourceUrl(source);
    if (await stat(repo.path)) throw new GitSafetyError('이미 존재하는 저장소를 덮어쓰지 않습니다.');
    if (await stat(await safePath(repo.statePath))) throw new GitSafetyError('기존 저장소 등록 기록을 덮어쓰지 않습니다.');
    await mkdir(repo.path, { mode: 0o700 });
    try {
      await run(home, ['-c', 'init.templateDir=', 'clone', '--bare', '--no-local', '--', source, repo.path]);
      // Git LFS가 최초 fetch 때 쓰는 값도 등록 전에 고정한다.
      await run(repo.path, ['config', 'lfs.repositoryformatversion', '0']);
      repo.registration = { source, configHash: await repo.configHash(), worktrees: [] };
      await repo.saveRegistration(repo.registration);
      await repo.head();
      return repo;
    } catch (error) {
      await rm(repo.path, { recursive: true, force: true });
      await rm(repo.statePath, { force: true });
      throw error;
    }
  }

  static async open(home: string, repositoryId: string): Promise<GitRepository> {
    const repo = await this.prepare(home, repositoryId);
    repo.registration = await repo.readRegistration();
    if ((await repo.git(['rev-parse', '--is-bare-repository'])).toString().trim() !== 'true') {
      throw new GitSafetyError('Runner의 bare 저장소가 아닙니다.');
    }
    await repo.recoverInputCopies();
    return repo;
  }

  /**
   * 시작 회수(재리뷰 N2). 강제 종료로 남은 입력 복사 임시 폴더를 지운다.
   * 프로젝트 잠금 아래에서 하므로, 죽은 주인의 잠금은 기존 자동 회수(boot ID·PID·시작 시각·flock)로 회수된다.
   * 임시 폴더는 공개(이름 바꾸기) 전 사본이라 어느 세대의 것이든 쓸모가 없다. 이 프로세스에서 진행 중인 복사가 있으면 그 복사의 것이므로 건드리지 않는다.
   */
  private async recoverInputCopies(): Promise<void> {
    const names = await readdir(await safePath(this.inputs)).catch(() => [] as string[]);
    if (!names.some((name) => name.startsWith(INPUT_TEMP))) return;
    if ((activeCopies.get(this.path)?.size ?? 0) > 0) return;
    await this.worktreeUpdate(() => this.removeInputTemps());
  }

  /** 잠금 안에서만 부른다. 입력 복사 임시 폴더를 모두 지운다. */
  private async removeInputTemps(): Promise<void> {
    for (const name of await readdir(await safePath(this.inputs)).catch(() => [] as string[])) {
      if (name.startsWith(INPUT_TEMP)) await removeReadonly(join(this.inputs, name));
    }
  }

  private async readRegistration(): Promise<Registration> {
    let record: unknown;
    try { record = JSON.parse(await readFile(await safePath(this.statePath), 'utf8')); }
    catch { throw new GitSafetyError('저장소 등록 기록이 없습니다. 등록된 주소로 안전하게 다시 복사해야 합니다.'); }
    if (!record || typeof record !== 'object' || !('source' in record) || typeof record.source !== 'string' ||
      !('configHash' in record) || typeof record.configHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.configHash) ||
      !('worktrees' in record) || !Array.isArray(record.worktrees)) {
      throw new GitSafetyError('저장소 등록 기록이 올바르지 않습니다.');
    }
    const resetting = 'resetting' in record && record.resetting === true;
    const generation = 'resetGeneration' in record && Number.isSafeInteger(record.resetGeneration) ? record.resetGeneration as number : 0;
    return { source: sourceUrl(record.source), configHash: record.configHash,
      worktrees: record.worktrees.map((value: unknown) => worktreeRecord(value)), ...(resetting && { resetting }),
      ...(generation > 0 && { resetGeneration: generation }) };
  }

  private async git(args: string[], input?: Buffer | string, env?: NodeJS.ProcessEnv, allowed?: number[]) {
    await this.trusted();
    return run(this.path, args, input, env, allowed);
  }

  private async configHash(): Promise<string> {
    return createHash('sha256').update(await readFile(await safePath(join(this.path, 'config')))).digest('hex');
  }

  private async trusted(): Promise<Registration> {
    const current = await this.readRegistration();
    if (!this.registration || current.source !== this.registration.source || current.configHash !== this.registration.configHash ||
      await this.configHash() !== current.configHash) {
      throw new GitSafetyError('Runner 저장소 설정이 등록 당시와 다릅니다. 자동 실행을 중지합니다.');
    }
    this.registration = current;
    return current;
  }

  private async saveRegistration(record: Registration): Promise<void> {
    await safePath(this.statePath);
    const temporary = `${this.statePath}.${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.statePath);
      this.registration = record;
    } finally { await rm(temporary, { force: true }); }
  }

  private async worktreeUpdate<T>(action: () => Promise<T>): Promise<T> {
    const path = await safePath(`${this.statePath}.lock`);
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (!BOOT_ID.test(bootId)) throw new GitSafetyError('부팅 식별자를 확인할 수 없습니다.');
    const owner = JSON.stringify({ pid: process.pid, bootId, startTime: await startTime(process.pid) });
    const prepared = `${path}.${randomUUID()}`;
    const deadline = Date.now() + 30_000;
    let acquired = false;
    try {
      // 내용을 완성한 뒤 원자적으로 연결하므로, 종료돼도 빈 잠금은 공개되지 않는다.
      await writeFile(prepared, owner, { flag: 'wx', mode: 0o600 });
      while (!acquired) {
        try { await link(prepared, path); acquired = true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (await recoverLock(path, bootId)) continue;
          if (Date.now() >= deadline) throw new GitSafetyError(`저장소 잠금 대기 시간이 지났습니다. 주인 확인 불가 시 수동 조치가 필요합니다: ${path}`);
          await delay(25);
        }
      }
      await rm(prepared);
      await this.trusted();
      return await action();
    } finally {
      try { if (acquired && await lockContent(path) === owner) await rm(path); }
      finally { await rm(prepared, { force: true }); }
    }
  }

  /** 생성 기록에 있는 작업 폴더 이름(초기화 정리에 넘길 목록). 읽기 전용이며 설정 지문을 먼저 검증한다. */
  async recordedWorktrees(): Promise<string[]> {
    return (await this.trusted()).worktrees.map((value) => value.id);
  }

  /** Runner가 만든 입력 사본 이름(`inputs/<projectId>` 아래). 관리 폴더 이름 형식에 맞는 것만 돌려준다. */
  async inputIds(): Promise<string[]> {
    await this.trusted();
    const names = await readdir(await safePath(this.inputs)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    return names.filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name)).sort();
  }

  /** 원격 `main`의 SHA(마지막 fetch 기준). 초기화 결과를 원격에 보내야 하는지 판단할 때 쓴다. */
  async remoteMain(): Promise<string> {
    return sha((await this.git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'])).toString().trim());
  }

  /** 등록한 원격 주소(설정 지문 검증 뒤). 초기화 명령의 저장소와 같은지 대조할 때 쓴다. */
  async source(): Promise<string> {
    return (await this.trusted()).source;
  }

  /**
   * 초기화 정리 시작(교차 리뷰 P1-6). 등록 기록에 `resetting`을 남겨, 끝날 때까지 새 작업 폴더·입력 사본 생성을 막는다.
   * 기록이 디스크에 있으므로 다른 프로세스와 강제 종료 뒤 재시작에도 유지된다. 정리 명령 재시도가 다시 지운다.
   */
  async beginReset(): Promise<void> {
    // 진행 중인 입력 복사를 먼저 취소한다. 복사는 잠금을 쥐고 있으므로, 취소를 보고 끝날 때까지 아래 잠금 획득이 기다린다(재리뷰 N2).
    for (const controller of activeCopies.get(this.path) ?? []) controller.abort();
    await this.worktreeUpdate(async () => {
      const record = await this.trusted();
      // 시작할 때마다 세대를 올린다. 복사는 공개 직전에 잠금 안에서 이 세대를 다시 확인한다.
      await this.saveRegistration({ ...record, resetting: true, resetGeneration: (record.resetGeneration ?? 0) + 1 });
      // 공개되지 못한 임시 사본(강제 종료로 남은 것 포함)은 이 초기화가 지운다.
      await this.removeInputTemps();
    });
  }

  /** 초기화 정리 끝. 생성 기록·작업 폴더·입력 사본이 하나라도 남아 있으면 해제하지 않고 실패한다. */
  async endReset(): Promise<void> {
    await this.worktreeUpdate(async () => {
      const record = await this.trusted();
      const folders = await readdir(await safePath(this.worktrees)).catch(() => []);
      const inputs = await readdir(await safePath(this.inputs)).catch(() => []);
      if (record.worktrees.length > 0 || folders.length > 0 || inputs.length > 0) {
        throw new GitSafetyError(`초기화 뒤에도 남은 항목이 있습니다: 기록 ${String(record.worktrees.length)}개, 작업 폴더 ${String(folders.length)}개, 입력 ${String(inputs.length)}개`);
      }
      const next: Registration = { source: record.source, configHash: record.configHash, worktrees: record.worktrees,
        ...(record.resetGeneration !== undefined && { resetGeneration: record.resetGeneration }) };
      await this.saveRegistration(next);
    });
  }

  /**
   * 커밋을 등록 원격의 브랜치로 **일반 push**한다(강제 push 없음, 로컬 브랜치를 옮기지 않음).
   * 인증 헤더는 명령 인자가 아니라 환경 변수(GIT_CONFIG_*)로만 넘긴다. 왜: 인자는 다른 프로세스가 /proc에서 읽을 수 있다.
   * 호출자(GitHub 원격 정리)가 외부 쓰기 권한과 원격 main 대조를 먼저 한다.
   */
  async pushCommit(commit: string, branch: string, authorization?: string): Promise<void> {
    sha(commit);
    if (branch !== 'main') await this.branch(branch);
    const { source } = await this.trusted();
    const env: NodeJS.ProcessEnv = authorization === undefined ? {}
      : { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: ${authorization}` };
    await this.git(['push', '--no-verify', '--', source, `${commit}:refs/heads/${branch}`], undefined, env);
  }

  async head(): Promise<string> {
    return sha((await this.git(['rev-parse', '--verify', 'refs/heads/main^{commit}'])).toString().trim());
  }

  async fetch(): Promise<string> {
    const { source } = await this.trusted();
    // main은 로컬 초기화 커밋을 보존한다. 갱신 대상을 origin/*로 한정한다.
    await this.git(['fetch', '--prune', '--no-recurse-submodules', '--upload-pack=git-upload-pack', '--', source, 'refs/heads/*:refs/remotes/origin/*']);
    return sha((await this.git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'])).toString().trim());
  }

  private async branch(branch: string): Promise<void> {
    if (!branch.startsWith('agent/')) throw new GitSafetyError('시스템이 기록한 Agent 브랜치만 다룰 수 있습니다.');
    await this.git(['check-ref-format', '--branch', branch]);
  }

  async createWorktree(worktreeId: string, branch: string, commit: string): Promise<string> {
    return this.worktreeUpdate(async () => {
      const path = await safePath(join(this.worktrees, id(worktreeId)));
      await this.branch(branch);
      sha(commit);
      if (await stat(path)) throw new GitSafetyError('이미 존재하는 작업 폴더를 덮어쓰지 않습니다.');
      const record = await this.trusted();
      if (record.resetting) throw new GitSafetyError('초기화 정리 중에는 작업 폴더를 만들 수 없습니다.');
      if (record.worktrees.some((value) => value.id === worktreeId)) throw new GitSafetyError('이 작업 폴더는 정리 후 다시 만들어야 합니다.');
      const ref = `refs/heads/${branch}`;
      await this.git(['update-ref', ref, commit, '']);
      let created = false;
      try {
        // 생성 중 종료돼도 폴더가 기록 없이 남지 않도록 먼저 예약한다.
        await this.saveRegistration({ ...record, worktrees: [...record.worktrees, { id: worktreeId, branch, startCommit: commit }] });
        await mkdir(path, { mode: 0o700 });
        created = true;
        // 고정 커밋의 브랜치만 복사하여 최신 원격 객체도 받고 다른 Agent 결과는 제외한다.
        await run(this.home, ['-c', 'init.templateDir=', 'clone', '--no-local', '--no-hardlinks', '--single-branch', '--branch', branch, '--no-checkout', '--', this.path, path]);
        await run(path, ['remote', 'remove', 'origin']);
        await run(path, ['checkout', '--no-guess', branch]);
        return path;
      } catch (error) {
        try {
          if (created) await removeReadonly(path);
          const latest = await this.trusted();
          await this.saveRegistration({ ...latest, worktrees: latest.worktrees.filter((value) => value.id !== worktreeId) });
        } finally { await this.git(['update-ref', '-d', ref, commit]); }
        throw error;
      }
    });
  }

  async importWorktree(worktreeId: string, branch: string): Promise<string> {
    const path = await safePath(join(this.worktrees, id(worktreeId), '.git'));
    if (!(await this.trusted()).worktrees.some((value) => value.id === worktreeId)) throw new GitSafetyError('기록하지 않은 작업 폴더입니다.');
    await this.branch(branch);
    const ref = `refs/agent-results/${worktreeId}`;
    // Agent 설정을 읽어 checkout하지 않고, Git의 객체 검증을 거쳐 결과만 가져온다.
    await this.git(['fetch', '--no-tags', '--no-recurse-submodules', '--upload-pack=git-upload-pack', '--', path, `+refs/heads/${branch}:${ref}`]);
    return sha((await this.git(['rev-parse', '--verify', `${ref}^{commit}`])).toString().trim());
  }

  async removeWorktree(worktreeId: string): Promise<void> {
    return this.worktreeUpdate(async () => {
      const path = join(this.worktrees, id(worktreeId));
      await safePath(dirname(path));
      const record = await this.trusted();
      const entry = record.worktrees.find((value) => value.id === worktreeId);
      if (!entry) {
        if (await stat(path)) throw new GitSafetyError('Runner가 생성 기록을 남기지 않은 폴더는 삭제하지 않습니다.');
        return;
      }
      if (entry.branch && entry.startCommit) {
        await this.branch(entry.branch);
      }
      await removeReadonly(path);
      if (entry.branch && entry.startCommit) {
        const ref = `refs/heads/${entry.branch}`;
        const current = (await this.git(['rev-parse', '--verify', '--quiet', ref], undefined, undefined, [0, 1])).toString().trim();
        if (current === entry.startCommit) await this.git(['update-ref', '-d', ref, entry.startCommit]);
      }
      await this.git(['update-ref', '-d', `refs/agent-results/${worktreeId}`]);
      await this.saveRegistration({ ...record, worktrees: record.worktrees.filter((value) => value.id !== worktreeId) });
    });
  }

  private async tree(commit: string): Promise<TreeEntry[]> {
    const records = (await this.git(['ls-tree', '-r', '-z', sha(commit)])).toString().split('\0').filter(Boolean);
    return records.map((record) => {
      const tab = record.indexOf('\t');
      const [mode, , oid] = record.slice(0, tab).split(' ');
      if (!mode || !oid) throw new GitSafetyError('git tree 형식이 올바르지 않습니다.');
      const path = record.slice(tab + 1);
      if (isAbsolute(path) || path.split('/').some((part) => ['', '.', '..', '.git'].includes(part.toLowerCase()))) {
        throw new GitSafetyError('Git 객체의 경로가 올바르지 않습니다.');
      }
      return { mode, oid, path };
    });
  }

  private async blob(entry: TreeEntry): Promise<Buffer> {
    return this.git(['cat-file', 'blob', entry.oid]);
  }

  /**
   * 고정 커밋의 `prototype/`을 읽기 전용 입력 사본으로 만든다.
   *
   * 초기화와의 직렬화(재리뷰 N2):
   * - 복사 전체를 프로젝트 잠금(작업 폴더 생성·삭제·초기화 시작/끝과 같은 잠금) 안에서 한다.
   * - 임시 폴더(`.copy-…`)에 쓰고, 잠금 안에서 초기화 세대가 시작 때와 같은지 확인한 뒤 **이름 바꾸기 한 번으로만** 공개한다.
   * - 실패하면 자기 임시 폴더만 지운다. 공개 경로는 절대 지우지 않는다. 왜: 같은 이름의 새 정상 입력을 지우면 안 된다.
   * - 초기화가 시작되면 취소 신호를 받고 멈춘다. 초기화는 잠금이 풀린 뒤에야 진행한다.
   * - 복사 중 강제 종료되면 공개되지 않은 임시 폴더만 남고, 다음 초기화나 저장소 다시 열기가 지운다.
   */
  async checkoutInput(inputId: string, commit: string): Promise<string> {
    const path = await safePath(join(this.inputs, id(inputId)));
    sha(commit);
    const controller = new AbortController();
    const active = activeCopies.get(this.path) ?? new Set<AbortController>();
    active.add(controller);
    activeCopies.set(this.path, active);
    const cancelled = () => { if (controller.signal.aborted) throw new GitSafetyError('초기화가 시작되어 입력 복사를 취소했습니다.'); };
    try {
      return await this.worktreeUpdate(async () => {
        cancelled();
        const started = await this.trusted();
        if (started.resetting) throw new GitSafetyError('초기화 정리 중에는 입력 사본을 만들 수 없습니다.');
        if (await stat(path)) throw new GitSafetyError('기존 입력 버전은 덮어쓰지 않습니다.');
        const generation = started.resetGeneration ?? 0;
        const entries = (await this.tree(commit)).filter((entry) => entry.path === 'prototype' || entry.path.startsWith('prototype/'));
        if (entries.length === 0) throw new GitSafetyError('prototype 입력이 없습니다.');
        for (const entry of entries) {
          if (entry.mode === '120000') throw new GitSafetyError('입력의 symlink는 허용하지 않습니다.');
          if (entry.mode === '160000') throw new GitSafetyError('입력의 submodule은 따라가지 않습니다.');
          if (!['100644', '100755'].includes(entry.mode) || entry.path.split('/').some((p) => ['.', '..', '.git'].includes(p))) {
            throw new GitSafetyError('입력 경로·파일 형식이 올바르지 않습니다.');
          }
        }
        const temp = await safePath(join(this.inputs, `${INPUT_TEMP}${inputId}-${String(generation)}-${randomUUID()}`));
        await mkdir(temp, { mode: 0o700 });
        try {
          for (const entry of entries) {
            cancelled();
            let content = await this.blob(entry);
            if (content.toString().startsWith('version https://git-lfs.github.com/spec/v1\n')) {
              const pointer = /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n$/.exec(content.toString());
              const oid = pointer?.[1];
              if (!pointer || !oid) throw new GitSafetyError('Git LFS 포인터 형식이 올바르지 않습니다.');
              await this.git(['lfs', 'version']);
              await this.git(['-c', `remote.origin.url=${(await this.trusted()).source}`, 'lfs', 'fetch', 'origin', commit]);
              content = await readFile(await safePath(join(this.path, 'lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid)));
              if (content.length !== Number(pointer[2]) || createHash('sha256').update(content).digest('hex') !== oid) {
                throw new GitSafetyError('Git LFS 파일의 크기·해시가 일치하지 않습니다.');
              }
            }
            const target = join(temp, entry.path);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await writeFile(target, content, { flag: 'wx', mode: 0o444 });
          }
          async function lock(folder: string): Promise<void> {
            for (const name of await readdir(folder, { withFileTypes: true })) {
              if (name.isDirectory()) await lock(join(folder, name.name));
            }
            await chmod(folder, 0o555);
          }
          for (const name of await readdir(temp, { withFileTypes: true })) if (name.isDirectory()) await lock(join(temp, name.name));
          cancelled();
          // 공개 직전 확인(잠금 안). 초기화 세대가 바뀌었거나 같은 이름이 생겼으면 공개하지 않는다.
          const finished = await this.trusted();
          if (finished.resetting || (finished.resetGeneration ?? 0) !== generation) {
            throw new GitSafetyError('입력 사본을 만드는 동안 초기화가 있어 공개하지 않았습니다.');
          }
          if (await stat(path)) throw new GitSafetyError('기존 입력 버전은 덮어쓰지 않습니다.');
          cancelled();
          await rename(temp, path);
          await chmod(path, 0o555);
          return path;
        } catch (error) {
          // 자기 임시 폴더만 지운다(공개 경로는 건드리지 않음).
          await removeReadonly(temp).catch(() => undefined);
          throw error;
        }
      });
    } finally {
      active.delete(controller);
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
    const tracked = (await this.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-filter=AMT', '--name-only', '-z', mergeBase, head, '--'])).toString().split('\0').filter(Boolean);
    if (tracked.length === 0) return rejected;
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
      const resetPaths = (await this.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', current, tree])).toString().split('\0').filter(Boolean);
      if (resetPaths.some((path) => !target(path))) throw new GitSafetyError('초기화가 보존 대상 파일을 변경하여 중지합니다.');
      const oldTree = (await this.git(['rev-parse', `${current}^{tree}`])).toString().trim();
      const localTree = (await this.git(['rev-parse', `${local}^{tree}`])).toString().trim();
      const ancestor = (await this.git(['merge-base', current, local])).toString().trim();
      // 아직 push하지 않은 같은 되돌림 커밋은 재시도 때 재사용한다.
      if (tree !== localTree || ancestor !== current) {
        result = tree === oldTree ? current : sha((await this.git(['commit-tree', tree, '-p', current, '-m', 'Agent WBS 프로젝트 초기화'])).toString().trim());
        await this.git(['update-ref', 'refs/heads/main', result, local]);
      }
    } finally { await rm(index, { force: true }); }
    const failures: CleanupFailure[] = [];
    const attempt = async (name: string, path: string, action: () => Promise<unknown>) => {
      try { await action(); }
      catch (error) { failures.push({ name, path, detail: error instanceof Error ? error.message : '수동 조치가 필요합니다.' }); }
    };
    for (const name of options.worktrees) await attempt(`worktree:${name}`, join(this.worktrees, name), () => this.removeWorktree(name));
    for (const name of options.inputs) await attempt(`input:${name}`, join(this.inputs, name), () => this.removeInput(name));
    for (const branch of new Set(options.branches)) {
      await attempt(`branch:${branch}`, this.path, async () => {
        const ref = `refs/heads/${branch}`;
        const existing = (await this.git(['for-each-ref', '--format=%(refname)', ref])).toString().trim().split('\n');
        if (existing.includes(ref)) await this.git(['branch', '-D', '--', branch]);
      });
    }
    if (failures.length > 0) throw new GitCleanupError(failures);
    return { commit: result };
  }
}
