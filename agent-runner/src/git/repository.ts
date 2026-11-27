import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { parseCommits, parseRawNumstat, type InputDiff, type InputObservation } from './inputs.ts';

export class GitSafetyError extends Error {
  override name = 'GitSafetyError';
}

export interface CleanupFailure { name: string; path: string; detail: string }
/** 개인키 대신 전용 ssh-agent 소켓과 공개 서버 키 목록만 받는다. */
export interface SystemSsh { socket: string; knownHosts: string }

/** 시험용 push도 운영 push와 같은 인증·서버 확인 경계를 사용한다. */
export function systemSshCommand(knownHosts: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentityFile=none -o ForwardAgent=no -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=${quote(knownHosts)}`;
}

/** 중단 신호로 push를 끊었고, 그 push의 프로세스 그룹(git-remote-https 등 전송 하위 프로세스 포함)이 비었음을 확인했다. */
export class GitPushAbortedError extends GitSafetyError {
  override name = 'GitPushAbortedError';
  constructor() { super('push를 중단했고 전송 프로세스가 모두 끝났음을 확인했습니다. 이미 원격에 닿은 갱신은 되돌리지 않습니다. 다음 push 전에 원격 브랜치를 다시 읽어 대조합니다.'); }
}

/** 중단 신호로 push를 끊었지만 전송 프로세스가 모두 끝났는지 확인하지 못했다. 원격 상태를 모른다. */
export class GitPushUnknownError extends GitSafetyError {
  override name = 'GitPushUnknownError';
  constructor() { super('push를 중단했지만 전송 프로세스 종료를 확인하지 못해 원격 상태를 모릅니다. 다음 push 전에 원격 브랜치를 다시 읽어 대조합니다.'); }
}

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

export interface TaskReviewChange extends InputDiff { patch: string }
/** H에 main A만 자동으로 합쳤다는 근거다. M7-04의 headSync 보고 형식과 같다. */
export interface HeadSyncProof {
  qaHeadSha: string; headSha: string; preserved: boolean; parents: string[];
  autoMergeTreeSha: string; headTreeSha: string; additionalChanges: boolean;
}
export interface HeadSyncChainProof extends HeadSyncProof { chain?: HeadSyncProof[] }

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

async function run(cwd: string, args: string[], input?: Buffer | string, extraEnv: NodeJS.ProcessEnv = {}, allowed = [0], signal?: AbortSignal): Promise<Buffer> {
  return (await runWithCode(cwd, args, input, extraEnv, allowed, signal)).output;
}

/** 허용한 종료 코드면 출력과 코드를 돌려주고, 그 밖은 GitSafetyError. 종료 코드로 답을 구분하는 명령(merge-base --is-ancestor)에 쓴다. */
async function runWithCode(cwd: string, args: string[], input?: Buffer | string, extraEnv: NodeJS.ProcessEnv = {}, allowed = [0], signal?: AbortSignal): Promise<{ code: number; output: Buffer }> {
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
      // 중단할 수 있는 git(외부 쓰기인 push)은 자기 프로세스 그룹으로 띄운다. git이 띄우는 git-remote-https·git send-pack도 같은 그룹이다.
      // 중단하면 그룹 전체를 끝내고(TERM → 짧은 대기 → KILL) 그룹이 비었음을 확인한 뒤에야 「중단됨」으로 끝낸다.
      detached: signal !== undefined,
    });
    const output: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; signal?.removeEventListener('abort', abort); fn(); } };
    let leaderStart: Promise<string | null> = Promise.resolve(null);
    const abort = () => {
      if (settled) return;
      settled = true;
      void (async () => {
        const pid = child.pid;
        const start = await leaderStart;
        const { terminateGroup } = await import('../exec/launches.ts');
        const empty = pid !== undefined && start !== null && await terminateGroup(pid, start);
        reject(empty ? new GitPushAbortedError() : new GitPushUnknownError());
      })();
    };
    // git 오류 원문에는 URL·인증 정보가 들어갈 수 있으므로 외부에 내보내지 않는다.
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.resume();
    child.on('error', () => { settle(() => { reject(new GitSafetyError('git 명령을 실행할 수 없습니다.')); }); });
    child.on('close', (code) => {
      settle(() => {
        if (code !== null && allowed.includes(code)) resolvePromise({ code, output: Buffer.concat(output) });
        else reject(new GitSafetyError('git 작업이 실패했습니다. 저장소·커밋·도구 설치를 확인하세요.'));
      });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    if (signal) {
      // 그룹 번호 재사용을 막으려고 leader의 시작 시각을 기록한다(그룹 정리는 그 뒤에 생긴 프로세스만 대상).
      leaderStart = child.pid === undefined ? Promise.resolve(null) : import('../exec/launches.ts')
        .then(async ({ processInfo }) => (await processInfo(child.pid as number)).startTime).catch(() => null);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }
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

/**
 * 작업 폴더 안의 모든 파일·폴더에 그룹 쓰기 권한을 준다(전용 계정 격리용). 링크는 따라가지 않는다.
 * 왜: Runner가 만든 파일은 기본 ACL이 붙어도 권한 숫자의 그룹 칸(0644 → r--)이 ACL 상한(mask)이 되어, Agent가 고칠 수 없다.
 *   그룹 칸을 열면 상한도 함께 열려 Agent 항목(rwx)이 효과를 가진다(isolation.md §6).
 */
async function groupWritable(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  const dir = info.isDirectory();
  await chmod(path, (info.mode & 0o7777) | 0o060 | (dir || info.mode & 0o100 ? 0o010 : 0));
  if (dir) for (const name of await readdir(path)) await groupWritable(join(path, name));
}

/** Agent 작업 영역 설정. 주면 작업 폴더·입력 사본을 Runner 홈이 아니라 그 아래에 둔다(Q-08 전용 계정). */
/** H→H′→H″… 동기화 사슬을 따라가는 최대 단계 수. 넘으면 재QA로 돌린다(M7-02 P3). */
export const MAX_SYNC_CHAIN = 50;

/** push 직전 관문. 실패하면 던진다(push하지 않는다). 모양은 GitHub 클라이언트의 `branch_push` 쓰기 종류와 같다. */
export type PushGate = ((operation: { kind: 'branch_push'; branch: string; remote: string }) => Promise<void>) & {
  /** 작업 중단 신호. 관문 직후 다시 보고, 진행 중인 push도 끊는다. */
  signal?: AbortSignal | undefined;
};

export interface GitLayout {
  /** 예: /srv/agentwbs. 그 아래 `worktrees/<저장소>`·`inputs/<저장소>`를 쓴다. */
  agentRoot?: string | null;
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
  /** 전용 계정 격리 사용 여부. 쓰면 Agent가 들어갈 폴더를 그룹에도 연다(작업 폴더 0o770, 모음 폴더 0o750). */
  private readonly shared: boolean;
  private registration: Registration | undefined;

  private constructor(home: string, repositoryId: string, layout: GitLayout = {}) {
    this.home = home;
    this.repositoryId = repositoryId;
    const area = layout.agentRoot ?? home;
    this.shared = Boolean(layout.agentRoot);
    this.path = join(home, 'repos', repositoryId);
    this.worktrees = join(area, 'worktrees', repositoryId);
    this.inputs = join(area, 'inputs', repositoryId);
    this.statePath = join(home, 'state/git', `${repositoryId}.json`);
  }

  private static async prepare(home: string, repositoryId: string, layout: GitLayout = {}): Promise<GitRepository> {
    id(repositoryId);
    await safePath(home);
    if (layout.agentRoot) await safePath(layout.agentRoot);
    // WSL의 Windows 드라이브는 작업 폴더로 사용하지 않는다(가이드 §6.6).
    for (const base of [home, layout.agentRoot ?? home]) {
      if (/^\/mnt\/[a-z](?:\/|$)/i.test(resolve(base))) throw new GitSafetyError('worktree는 Linux 파일 시스템에 만들어야 합니다.');
    }
    const repo = new GitRepository(home, repositoryId, layout);
    for (const path of [dirname(repo.path), dirname(repo.statePath)]) {
      await safePath(path);
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    // 작업 폴더·입력 사본 모음: 전용 계정이면 Agent 그룹이 들어가기만 하게 0o750(맨 위는 Agent가 못 바꿈).
    for (const path of [repo.worktrees, repo.inputs]) {
      await safePath(path);
      await mkdir(path, { recursive: true, mode: repo.shared ? 0o750 : 0o700 });
    }
    if ((await statfs(repo.worktrees)).type !== 0xef53) throw new GitSafetyError('worktree는 ext4 파일 시스템에 만들어야 합니다.');
    await safePath(repo.path);
    return repo;
  }

  static async clone(home: string, repositoryId: string, source: string, layout: GitLayout = {}): Promise<GitRepository> {
    const repo = await this.prepare(home, repositoryId, layout);
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

  static async open(home: string, repositoryId: string, layout: GitLayout = {}): Promise<GitRepository> {
    const repo = await this.prepare(home, repositoryId, layout);
    repo.registration = await repo.readRegistration();
    if ((await repo.git(['rev-parse', '--is-bare-repository'])).toString().trim() !== 'true') {
      throw new GitSafetyError('Runner의 bare 저장소가 아닙니다.');
    }
    await repo.recoverInputCopies();
    return repo;
  }

  /** Runner 홈 잠금을 가진 시작 경로에서만 호출한다. 일반 open은 실행 중인 검사 사본을 건드리지 않는다. */
  static async recoverTaskChecks(home: string, layout: GitLayout = {}): Promise<void> {
    const directory = await safePath(join(home, 'state/git'));
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      // 전용 계정 배치(agentRoot)면 사본이 Agent 작업 영역에 있으므로 같은 배치로 연다.
      const repo = await this.open(home, file.slice(0, -5), layout);
      const record = await repo.trusted();
      for (const entry of record.worktrees) {
        if (/^ci-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(entry.id) &&
          entry.branch === `agent/${entry.id}` && entry.startCommit) await repo.removeWorktree(entry.id);
      }
    }
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
   * `gate`는 필수다. push 직전에 반드시 부른다(Runner의 모든 외부 쓰기는 같은 관문을 지난다, `github/write-gate.ts`).
   */
  async pushCommit(commit: string, branch: string, gate: PushGate, authorization?: string): Promise<'pushed' | 'already'> {
    sha(commit);
    if (branch !== 'main') await this.branch(branch);
    const { source } = await this.trusted();
    const env: NodeJS.ProcessEnv = authorization === undefined ? {}
      : { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: ${authorization}` };
    // 앞선 push를 중단했다면(중단됨·모름) 원격 브랜치 head를 먼저 다시 읽어 대조한다. 이미 그 커밋이면 쓰지 않는다.
    if (await this.reconcileInterruptedPush(source, branch, commit, env) === 'already') return 'already';
    // 마지막 확인 → 즉시 전송: 관문 뒤에는 다른 await 없이 git을 띄운다(저장소 신뢰 확인은 바로 위에서 끝났다).
    await gate({ kind: 'branch_push', branch, remote: source });
    gate.signal?.throwIfAborted();
    try {
      await run(this.path, ['push', '--no-verify', '--', source, `${commit}:refs/heads/${branch}`], undefined, env, [0], gate.signal);
    } catch (error) {
      if (error instanceof GitPushAbortedError || error instanceof GitPushUnknownError) await this.markInterruptedPush(branch, commit, error.name);
      throw error;
    }
    return 'pushed';
  }

  /** 중단한 push 기록(브랜치 → 보내던 커밋). 이름이 `.json`이 아니어야 시작 정리(recoverTaskChecks)가 저장소 기록으로 읽지 않는다. */
  private get interruptedPushPath(): string {
    return join(this.home, 'state/git', `${this.repositoryId}.push-interrupted`);
  }

  private async markInterruptedPush(branch: string, commit: string, outcome: string): Promise<void> {
    const path = await safePath(this.interruptedPushPath);
    let record: Record<string, { commit: string; outcome: string }> = {};
    try { record = JSON.parse(await readFile(path, 'utf8')) as typeof record; } catch { /* 처음 */ }
    record[branch] = { commit, outcome };
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  }

  /**
   * 중단한 push가 남긴 기록이 있으면 원격 브랜치 head를 읽기만 해서 대조한다.
   * - 원격 head가 보내던 커밋이면 그 push는 이미 반영됐다: 다시 쓰지 않는다('already').
   * - 아니면 기록을 지우고 평소처럼 push한다(일반 push라 원격이 다른 커밋으로 움직였으면 git이 거부한다).
   * 왜: 중단·모름은 「반영 안 됨」의 증거가 아니다. 원격 상태를 확인한 뒤에 다음 쓰기를 한다.
   */
  private async reconcileInterruptedPush(source: string, branch: string, commit: string, env: NodeJS.ProcessEnv): Promise<'already' | 'push'> {
    const path = await safePath(this.interruptedPushPath);
    let record: Record<string, { commit: string; outcome: string }>;
    try { record = JSON.parse(await readFile(path, 'utf8')) as typeof record; } catch { return 'push'; }
    if (!record[branch]) return 'push';
    const line = (await this.git(['ls-remote', '--heads', '--', source, `refs/heads/${branch}`], undefined, env)).toString().trim();
    const remoteHead = line ? line.split(/\s/)[0] : null;
    await writeFile(path, JSON.stringify(Object.fromEntries(Object.entries(record).filter(([name]) => name !== branch))), { mode: 0o600 });
    return remoteHead === commit ? 'already' : 'push';
  }

  /** 시스템 직접 push는 최초 생성 또는 세 초기화 경로만 바꾸는 단일 부모 커밋에 한한다. 호출자가 GitHub 키 목록과 main을 먼저 대조한다. */
  async pushSystemCommit(commit: string, parent: string | null, ssh: SystemSsh, gate: PushGate): Promise<void> {
    sha(commit);
    if (parent !== null) sha(parent);
    const parents = (await this.git(['show', '-s', '--format=%P', commit])).toString().trim();
    if (parent === null) {
      if (parents !== '') throw new GitSafetyError('최초 생성 커밋에는 부모가 없어야 합니다.');
    } else {
      if (parents !== parent) throw new GitSafetyError('시스템 되돌림 커밋의 부모가 예상 main과 다릅니다.');
      const outside = await this.git(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', parent, commit, '--',
        '.', ':(exclude)src', ':(exclude)contracts', ':(exclude).agentwbs']);
      if (outside.length > 0) throw new GitSafetyError('시스템 되돌림 커밋이 초기화 대상 밖의 경로를 바꿉니다.');
    }
    const url = URL.parse((await this.trusted()).source);
    if (!url || url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '' ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) {
      throw new GitSafetyError('시스템 SSH push는 등록된 github.com 저장소만 허용합니다.');
    }
    if (!(await stat(await safePath(ssh.socket)))?.isSocket()) throw new GitSafetyError('시스템 SSH 소켓을 확인할 수 없습니다.');
    if (!(await stat(await safePath(ssh.knownHosts)))?.isFile()) throw new GitSafetyError('서버 키 목록 파일을 확인할 수 없습니다.');
    const remote = `ssh://git@ssh.github.com:443${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}.git`;
    // 관문에는 등록된 https 원격(GitHub 저장소 주소)을 넘긴다. SSH 주소는 같은 저장소의 다른 표기다.
    const { source } = await this.trusted();
    // 마지막 확인 → 즉시 전송.
    await gate({ kind: 'branch_push', branch: 'main', remote: source });
    gate.signal?.throwIfAborted();
    await run(this.path, ['push', '--no-verify', '--', remote, `${commit}:refs/heads/main`], undefined, {
      GIT_ALLOW_PROTOCOL: 'ssh', GIT_SSH_COMMAND: systemSshCommand(ssh.knownHosts), GIT_SSH_VARIANT: 'ssh', SSH_AUTH_SOCK: ssh.socket,
    }, [0], gate.signal);
  }

  async head(): Promise<string> {
    return sha((await this.git(['rev-parse', '--verify', 'refs/heads/main^{commit}'])).toString().trim());
  }

  /**
   * 원격 main을 받아 SHA를 돌려준다.
   * `allowRewrite`는 입력 변경 보고만 쓴다: 원격 이력이 재작성돼도 origin/* 추적 참조를 강제로 맞춰
   * 「base가 head의 조상이 아님」을 서버에 보고할 수 있게 한다(M2-03 계약). 로컬 main·Agent 브랜치는 옮기지 않는다.
   * 기본값(false)은 M4 동작 그대로다(재작성된 원격이면 fetch가 실패한다).
   */
  async fetch(options: { allowRewrite?: boolean } = {}): Promise<string> {
    const { source } = await this.trusted();
    // main은 로컬 초기화 커밋을 보존한다. 갱신 대상을 origin/*로 한정한다.
    await this.git(['fetch', '--prune', '--no-recurse-submodules', '--upload-pack=git-upload-pack', '--', source, `${options.allowRewrite ? '+' : ''}refs/heads/*:refs/remotes/origin/*`]);
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
        // 전용 계정이면 0o770: 0o700으로 만들면 ACL 상한이 ---가 되어 Agent가 들어가지 못한다(isolation.md §6, Codex 리뷰 P2-5).
        await mkdir(path, { mode: this.shared ? 0o770 : 0o700 });
        created = true;
        // 고정 커밋의 브랜치만 복사하여 최신 원격 객체도 받고 다른 Agent 결과는 제외한다.
        await run(this.home, ['-c', 'init.templateDir=', 'clone', '--no-local', '--no-hardlinks', '--single-branch', '--branch', branch, '--no-checkout', '--', this.path, path]);
        await run(path, ['remote', 'remove', 'origin']);
        await run(path, ['checkout', '--no-guess', branch]);
        if (this.shared) await groupWritable(path);
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

  /**
   * 입력 변경 보고(M2-03 계약)에 필요한 base..head 관측. `prototype/` 트리 차이가 정답이다.
   * - baseIsAncestor: `merge-base --is-ancestor`의 종료 코드(0=true, 1=false). 그 밖(base가 없음 등)은 실패 = 보고 중단.
   * - treeHash: head의 `prototype` 트리 SHA(모드 포함).
   * - changes: `diff --raw --numstat -M`(blob·모드 전후, 이름 변경, 종류 변경 T).
   * - commits: 첫 부모 이력 중 prototype/을 바꾼 커밋(참고 정보, 판정에 쓰지 않음).
   */
  async inputObservation(base: string, head: string): Promise<InputObservation> {
    sha(base); sha(head);
    // 계약: 종료 코드 0=true, 1=false, 그 밖(커밋 없음·git 실패 등)은 판정 불가라 보고를 중단한다(교차 리뷰 F3).
    // 예전에는 모든 실패를 false로 바꿔 잘못된 「이력 재작성」 경고를 만들 수 있었다.
    await this.trusted();
    const baseIsAncestor = await runWithCode(this.path, ['merge-base', '--is-ancestor', base, head], undefined, {}, [0, 1])
      .then(({ code }) => code === 0, () => { throw new GitSafetyError('base와 head의 조상 관계를 판정할 수 없습니다. 입력 변경 보고를 중단합니다.'); });
    const treeHash = sha((await this.git(['rev-parse', '--verify', `${head}:prototype`])).toString().trim());
    const diff = (await this.git(['diff', '--no-ext-diff', '--no-textconv', '--raw', '--numstat', '-M', '-z', '--no-abbrev', base, head, '--', 'prototype/'])).toString('utf8');
    const log = (await this.git(['log', '--first-parent', '--reverse', '--format=%H%x1f%cI%x1f%an%x1f%s%x1e', `${base}..${head}`, '--', 'prototype/'])).toString('utf8');
    return { baseIsAncestor, treeHash, changes: parseRawNumstat(diff), commits: parseCommits(log) };
  }

  async checkTask(base: string, head: string): Promise<RejectedPath[]> {
    const mergeBase = await this.taskBase(base, head);
    // --no-renames면 이동도 삭제+추가가 되어 원래 경로와 새 경로를 모두 검사한다.
    const changed = (await this.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', mergeBase, head, '--'])).toString().split('\0').filter(Boolean);
    const rejected: RejectedPath[] = changed.filter((path) => ['prototype', '.agentwbs'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
      .map((path) => ({ path, reason: 'protected' }));
    const tracked = (await this.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-filter=AMT', '--name-only', '-z', mergeBase, head, '--'])).toString().split('\0').filter(Boolean);
    if (tracked.length === 0) return rejected;
    // 작업 브랜치가 .gitignore를 지워 검사에서 빠져나가지 못하도록 기준 규칙도 적용한다.
    for (const commit of new Set([mergeBase, head])) {
      // Runner 내부 임시 폴더라 Agent 영역이 아니라 Runner 상태 폴더 아래에 둔다.
      const scratch = await safePath(join(dirname(this.statePath), `ignore-${this.repositoryId}-${randomUUID()}`));
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

  /** 등록한 원격 main을 가져와 한 커밋으로 고정한다. Agent 작업 폴더에서 정의를 읽지 않는다. */
  async mainPipeline(): Promise<{ baseSha: string; pipelineSha: string; source: string }> {
    const { source } = await this.trusted();
    await this.git(['fetch', '--no-tags', '--no-recurse-submodules', '--upload-pack=git-upload-pack', '--', source,
      'refs/heads/main:refs/remotes/origin/main']);
    const baseSha = await this.remoteMain();
    return this.pipelineAt(baseSha);
  }

  /** 재실행도 원래 main 커밋의 정의를 읽어 SHA를 대조한다(M7-06). */
  async pipelineAt(baseSha: string): Promise<{ baseSha: string; pipelineSha: string; source: string }> {
    await this.trusted(); sha(baseSha);
    return { baseSha, ...await this.pipelineOf(baseSha) };
  }

  /**
   * ④ 배포 확인: main을 가져온 뒤 그 커밋 자신의 정의를 읽는다(다시 빌드해도 같은 결과, G L486).
   * M7-03에서는 `pipelineAt`이었다. M7-06의 재실행용 `pipelineAt`(main 조상 검사 없음, baseSha 포함)과 이름이 겹쳐 통합에서 이름을 나눴다.
   */
  async deployPipelineAt(commit: string): Promise<{ pipelineSha: string; source: string }> {
    const { baseSha } = await this.mainPipeline();
    // main에 들어간 커밋만 배포한다. 왜: 병합되지 않은 브랜치를 배포 확인으로 통과시키지 않는다.
    if ((await this.taskBase(commit, baseSha).catch(() => null)) !== sha(commit)) throw new GitSafetyError('배포할 커밋이 main에 없습니다.');
    return this.pipelineOf(sha(commit));
  }

  /** ③ 기준 렌더: 고정한 커밋에서 prefix 아래 일반 파일 경로 목록. symlink·submodule은 넣지 않는다. */
  async listFiles(commit: string, prefix: string): Promise<string[]> {
    return (await this.tree(sha(commit))).filter((entry) => entry.path.startsWith(prefix) && ['100644', '100755'].includes(entry.mode)).map((entry) => entry.path);
  }

  /** ③ 화면 비교 기준 이미지처럼, 고정한 커밋의 일반 파일 하나를 Git 객체에서 읽는다. 작업 폴더나 단계 출력은 보지 않는다. */
  async fileAt(commit: string, path: string): Promise<Buffer> {
    const entry = (await this.tree(sha(commit))).find((value) => value.path === path);
    if (!entry || !['100644', '100755'].includes(entry.mode)) throw new GitSafetyError(`고정 커밋에 일반 파일 ${path}이 없습니다.`);
    return this.blob(entry);
  }

  private async pipelineOf(commit: string): Promise<{ pipelineSha: string; source: string }> {
    const entry = (await this.tree(commit)).find((value) => value.path === '.agentwbs/pipeline.yaml');
    if (!entry || !['100644', '100755'].includes(entry.mode)) throw new GitSafetyError('main의 pipeline.yaml은 일반 파일이어야 합니다.');
    return { pipelineSha: sha(entry.oid), source: (await this.blob(entry)).toString('utf8') };
  }

  /** ③ 원인 추적: from 뒤로 main에 들어온 first-parent 커밋(오래된 것부터). from이 조상이 아니면 빈 목록이다. */
  async mainCommitsSince(from: string, to: string): Promise<string[]> {
    if ((await this.taskBase(from, to).catch(() => null)) !== sha(from)) return [];
    return (await this.git(['rev-list', '--first-parent', '--reverse', `${sha(from)}..${sha(to)}`])).toString().split('\n').filter(Boolean).map(sha);
  }

  async taskBase(base: string, head: string): Promise<string> {
    return sha((await this.git(['merge-base', sha(base), sha(head)])).toString().trim());
  }

  async fetchBranch(branch: string): Promise<string> {
    await this.branch(branch);
    const { source } = await this.trusted();
    const ref = `refs/remotes/origin/${branch}`;
    await this.git(['fetch', '--no-tags', '--no-recurse-submodules', '--upload-pack=git-upload-pack', '--', source,
      `+refs/heads/${branch}:${ref}`]);
    return sha((await this.git(['rev-parse', '--verify', `${ref}^{commit}`])).toString().trim());
  }

  async commitTree(commit: string): Promise<string> {
    return sha((await this.git(['rev-parse', '--verify', `${sha(commit)}^{tree}`])).toString().trim());
  }

  async commitParents(commit: string): Promise<string[]> {
    await this.trusted();
    const parents = (await this.git(['show','-s','--format=%P',sha(commit)])).toString().trim();
    return parents ? parents.split(' ').map(sha) : [];
  }

  private async integrationTree(base: string, head: string): Promise<string | null> {
    const result = await this.git(['merge-tree', '--write-tree', '--no-messages', sha(head), sha(base)], undefined, undefined, [0, 1]);
    const tree = result.toString().trim();
    // 충돌 시 출력에는 경로와 단계별 blob도 섞인다. 성공한 tree 한 줄만 받는다.
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree) ? tree : null;
  }

  /** checkout·Agent 설정 없이 Git 객체만으로 H,A를 자동 병합한다. 충돌은 해결하지 않는다. */
  async prepareIntegration(base: string, head: string): Promise<string | null> {
    if (await this.taskBase(base, head) === base) return head;
    const tree = await this.integrationTree(base, head);
    if (!tree) return null;
    return sha((await this.git(['commit-tree', tree, '-p', head, '-p', base, '-m', 'Agent WBS main 동기화'])).toString().trim());
  }

  /** 호출자가 준 preserved 값을 믿지 않고 부모 순서와 자동 병합 tree를 다시 계산한다. */
  async integrationProof(base: string, head: string, synced: string): Promise<HeadSyncProof | null> {
    if (synced === head) return null;
    const parents = (await this.git(['show', '-s', '--format=%P', sha(synced)])).toString().trim().split(' ');
    if (parents.length !== 2 || parents[0] !== head || parents[1] !== base) return null;
    const autoMergeTreeSha = await this.integrationTree(base, head);
    const headTreeSha = await this.commitTree(synced);
    if (!autoMergeTreeSha || autoMergeTreeSha !== headTreeSha) return null;
    return { qaHeadSha: head, headSha: synced, preserved: true, parents, autoMergeTreeSha, headTreeSha, additionalChanges: false };
  }

  /** 각 단계가 main만 합친 자동 동기화인지 QA의 H까지 거슬러 확인한다. */
  async integrationChainProof(base: string, qaHead: string, head: string): Promise<HeadSyncChainProof | null> {
    const chain: HeadSyncProof[] = [];
    let cursor = head;
    try {
      while (cursor !== qaHead) {
        // 이미 main에 있는 커밋에서는 QA H(main에 없는 Task 커밋)에 닿을 수 없다. main 병합 이력을 따라 내려가지 않는다(M7-02 P3).
        // 단계 수 상한도 둔다. 정상 사슬은 main이 움직인 횟수만큼이라 이보다 훨씬 짧다.
        if (chain.length >= MAX_SYNC_CHAIN || await this.taskBase(base, cursor) === cursor) return null;
        const parents = (await this.git(['show', '-s', '--format=%P', sha(cursor)])).toString().trim().split(' ');
        const [previous, main] = parents;
        if (parents.length !== 2 || !previous || !main || await this.taskBase(base, main) !== main) return null;
        const proof = await this.integrationProof(main, previous, cursor);
        if (!proof) return null;
        chain.push(proof); cursor = previous;
      }
    } catch (error) { if (error instanceof GitSafetyError) return null; throw error; }
    const last = chain[0];
    if (!last) return null;
    return { ...last, qaHeadSha: qaHead, ...(chain.length > 1 && { chain: chain.reverse() }) };
  }

  /** 새 설정으로 테스트를 제외할 수도 있으므로 추가 파일까지 전부 QA 근거로 남긴다. */
  async taskReviewChanges(base: string, head: string): Promise<TaskReviewChange[]> {
    const mergeBase = await this.taskBase(base, head);
    const raw = (await this.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--raw', '--numstat', '-z', '--no-abbrev', mergeBase, head, '--'])).toString('utf8');
    const changes = parseRawNumstat(raw);
    const result: TaskReviewChange[] = [];
    for (const change of changes) {
      const patch = (await this.git(['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', mergeBase, head, '--', change.path])).toString('utf8');
      result.push({ ...change, patch });
    }
    return result;
  }

  /** 검사 폴더는 커밋만으로 새로 복사한다. Agent의 도구·무시 파일·Git 설정을 가져오지 않는다. */
  async createTaskCheckWorktree(worktreeId: string, commit: string): Promise<string> {
    const entries = await this.tree(commit);
    if (entries.some((entry) => !['100644', '100755'].includes(entry.mode) || entry.path.split('/').includes('node_modules'))) {
      throw new GitSafetyError('검사 커밋에는 node_modules, symlink, submodule을 넣을 수 없습니다.');
    }
    return this.createWorktree(worktreeId, `agent/${worktreeId}`, commit);
  }

  /** 고정한 커밋과 실제 작업 파일이 일치해야 다른 코드의 결과를 보고하지 않는다. */
  async taskCheckPath(worktreeId: string, head: string): Promise<string> {
    const record = await this.trusted();
    if (record.resetting || !record.worktrees.some((value) => value.id === worktreeId)) throw new GitSafetyError('검사할 수 있는 작업 폴더가 아닙니다.');
    const path = await safePath(join(this.worktrees, id(worktreeId)));
    await safePath(join(path, '.git'));
    const current = (await run(path, [`--git-dir=${join(path, '.git')}`, 'rev-parse', '--verify', 'HEAD^{commit}'])).toString().trim();
    if (current !== sha(head)) throw new GitSafetyError('검사 대상 head와 작업 폴더가 다릅니다.');
    // Agent index의 assume-unchanged·skip-worktree와 filter 설정을 신뢰하지 않는다.
    const index = join(dirname(this.statePath), `ci-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git(['read-tree', head], undefined, env);
      const dirty = await this.git([`--work-tree=${path}`, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', head, '--'], undefined, env);
      const untracked = await this.git([`--work-tree=${path}`, 'ls-files', '--others', '--exclude-standard', '-z'], undefined, env);
      if (dirty.length || untracked.length) throw new GitSafetyError('작업 폴더에 커밋하지 않은 변경이 있습니다.');
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
    return path;
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
