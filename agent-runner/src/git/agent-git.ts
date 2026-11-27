import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_EXEC, AGENT_USER } from '../cli/dedicated-user.ts';
import { clearScope, inUserScope } from '../exec/scope.ts';

/*
 * Agent 작업 폴더 안의 git(조정자 결정 6).
 *
 * 원칙: Runner 계정(keeproll)은 Agent가 쓸 수 있는 저장소·폴더에서 git을 돌리지 않는다.
 * 왜: git은 저장소 설정의 많은 키(filter·partialClone의 uploadpack·hook 등)로 명령을 실행한다.
 *   `-c 키=값`으로 하나씩 끄는 방식은 빠진 키 하나로 뚫린다(방어 점검 P1 두 건이 그 예).
 * 그래서 Agent 폴더의 git은 Agent 계정이 돌리고(래퍼 git-inspect·git-bundle), Runner는 결과만 받는다.
 * - inspect: HEAD SHA와 「커밋하지 않은 변경 있음」 한 비트만 받는다.
 * - bundle: 브랜치의 git bundle(데이터 파일)을 Runner 소유 파일로 받는다. Runner는 자기 bare 저장소에서 verify 뒤 fetch한다.
 */
export interface AgentGit {
  inspect(path: string): Promise<{ head: string; dirty: boolean }>;
  /** `out`은 Runner 전용 폴더의 새 파일 경로다(0600으로 만든다). */
  bundle(path: string, branch: string, out: string): Promise<void>;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** bundle 크기 상한(2 GiB). 넘으면 받지 않는다. */
export const BUNDLE_LIMIT = 2 * 1024 ** 3;
const TIMEOUT_MS = 10 * 60_000;

export class AgentGitError extends Error { override name = 'AgentGitError'; }

/** `head <sha>` / `dirty 0|1` 두 줄만 받는다. 다른 모양이면 실패. */
export function parseInspect(stdout: string): { head: string; dirty: boolean } {
  const match = /^head ([0-9a-f]{40}|[0-9a-f]{64})\ndirty ([01])\n?$/.exec(stdout);
  if (!match?.[1]) throw new AgentGitError('Agent git 점검 결과 모양이 다릅니다.');
  return { head: match[1], dirty: match[2] === '1' };
}

export interface Spawned { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }

export interface CaptureOptions {
  out?: { path: string; limit: number };
  input?: string;
  allow?: readonly number[];
  /**
   * 그 명령이 띄운 모든 프로세스를 끝낸다(래퍼 호출: 전용 scope의 cgroup.kill). 시간 초과 때와,
   * 명령은 끝났는데 자손이 출력 통로를 쥐고 남았을 때 부른다(재점검 P2-1).
   */
  kill?: () => Promise<void>;
  timeoutMs?: number;
  /** 명령이 끝난 뒤 출력 통로가 닫히기를 기다리는 시간. 넘으면 자손이 통로를 쥔 것으로 보고 실패한다. */
  graceMs?: number;
}

/**
 * 명령 하나를 돌린다. Node의 `close`(프로세스 끝 + 통로 모두 닫힘)만 기다리지 않는다(재점검 P2-1).
 * 왜: Agent 설정이 띄운 `setsid` 자손이 표준 출력·오류 통로를 쥐고 있으면 `close`가 오지 않아 Runner가 멈춘다.
 *   그 자손은 다른 프로세스 그룹이고 Agent 계정이라, 그룹 신호로는 끝나지 않는다.
 * 순서:
 * 1. `exit`(직접 띄운 프로세스의 끝)나 시간 초과 중 먼저 오는 것을 기다린다.
 * 2. 시간 초과면 `kill`(scope 전체 정리) + 그룹 신호 → 통로를 닫고 「시간 초과」로 실패한다.
 * 3. 끝났으면 통로가 닫히기를 `graceMs`만 기다린다. 안 닫히면 `kill` → 통로를 닫고 「자손이 통로를 쥠」으로 실패한다.
 * 결과는 통로가 정상으로 닫힌 경우에만 쓴다.
 */
export async function captureCode(command: Spawned, options: CaptureOptions): Promise<{ code: number; stdout: string }> {
  const out = options.out;
  const file = out ? await open(out.path, 'wx', 0o600) : undefined;
  const child = spawn(command.file, command.args, { cwd: command.cwd, env: command.env, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
  const killGroup = () => { try { process.kill(-(child.pid ?? 0), 'SIGKILL'); } catch { /* 이미 끝남 */ } };
  const destroy = () => { child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); };
  const wait = (ms: number) => new Promise<'wait'>((resolve) => { const t = setTimeout(() => resolve('wait'), ms); t.unref(); });
  try {
    if (options.input !== undefined) { child.stdin?.on('error', () => undefined); child.stdin?.end(options.input); }
    const chunks: Buffer[] = [];
    let size = 0, overflow = false, writing = Promise.resolve();
    child.stdout?.on('data', (bytes: Buffer) => {
      size += bytes.length;
      if (size > (out?.limit ?? 1024 * 1024)) { overflow = true; killGroup(); return; }
      if (file) { const f = file; writing = writing.then(async () => { await f.write(bytes); }); }
      else chunks.push(bytes);
    });
    child.stderr?.resume();
    const spawned = new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const closed = new Promise<'closed'>((resolve) => child.once('close', () => resolve('closed')));
    await spawned;
    const first = await Promise.race([exited.then((code) => ({ code })), wait(options.timeoutMs ?? TIMEOUT_MS)]);
    if (first === 'wait') {
      await options.kill?.();
      killGroup();
      if (await Promise.race([closed, wait(options.graceMs ?? 2_000)]) === 'wait') destroy();
      throw new AgentGitError('Agent 계정 명령이 시간 초과로 끝나지 않아 scope를 정리했습니다(시간 초과).');
    }
    if (await Promise.race([closed, wait(options.graceMs ?? 2_000)]) === 'wait') {
      await options.kill?.();
      if (await Promise.race([closed, wait(options.graceMs ?? 2_000)]) === 'wait') destroy();
      throw new AgentGitError('Agent 계정 명령이 끝난 뒤에도 자손 프로세스가 출력 통로를 쥐고 있어 정리했습니다. 결과를 쓰지 않습니다.');
    }
    await writing;
    if (overflow) throw new AgentGitError('Agent 계정 명령의 출력이 상한을 넘었습니다.');
    const code = first.code;
    if (code === null || !(options.allow ?? [0]).includes(code)) throw new AgentGitError(`Agent 계정 명령이 종료 코드 ${String(code)}로 끝났습니다.`);
    return { code, stdout: Buffer.concat(chunks).toString('utf8') };
  } finally {
    destroy();
    await file?.close();
  }
}

/**
 * 실제 래퍼로 Agent 계정 git을 돌린다: `systemd-run --user --scope -- sudo -n -u awbs-agent -- 래퍼 git-…`.
 * Agent 설정이 무엇을 띄우든 그 프로세스는 scope 안이다. 끝나면 scope를 비우고 비었음을 확인한다(못 하면 실패).
 */
export interface WrapperConfig { user: string; exec: string; sudo?: string; /** 시험용 시간 초과(기본 10분) */ timeoutMs?: number }

/** 래퍼 하위 명령 하나를 사용자 scope 안에서 Agent 계정으로 돌리고, 끝나면 scope를 비운 것을 확인한다. */
async function wrapperCall(cfg: WrapperConfig, args: string[], options: CaptureOptions = {}): Promise<{ code: number; stdout: string }> {
  const launch = inUserScope({ file: cfg.sudo ?? '/usr/bin/sudo', args: ['-n', '-u', cfg.user, '--', cfg.exec, ...args], env: { PATH: '/usr/bin:/bin' }, cwd: '/', stdin: '' });
  // 결과를 쓰기 전에 scope를 비운다. Agent 설정이 띄운 프로세스가 남으면 결과도 믿지 않는다.
  let result: { code: number; stdout: string } | undefined, failure: unknown;
  // 호출마다 전용 scope(launch.scope)다. 시간 초과·통로를 쥔 자손이 있으면 그 scope 전체를 cgroup.kill로 끝낸다.
  const kill = async () => { if (launch.scope) await clearScope(launch.scope); };
  try { result = await captureCode(launch, { ...options, kill, ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }) }); } catch (error) { failure = error; }
  if (launch.scope && !await clearScope(launch.scope)) throw new AgentGitError('Agent 계정 명령의 scope를 비우지 못했습니다.');
  if (failure !== undefined || result === undefined) throw failure instanceof Error ? failure : new AgentGitError('Agent 계정 명령이 실패했습니다.');
  return result;
}

export function wrapperAgentGit(cfg: WrapperConfig = { user: AGENT_USER, exec: AGENT_EXEC }): AgentGit {
  const call = async (args: string[], out?: { path: string; limit: number }): Promise<string> => (await wrapperCall(cfg, args, { ...(out && { out }) })).stdout;
  return {
    async inspect(path) { return parseInspect(await call(['git-inspect', '--cwd', path])); },
    async bundle(path, branch, out) { await call(['git-bundle', '--cwd', path, '--branch', branch], { path: out, limit: BUNDLE_LIMIT }); },
  };
}

/** 같은 계정 git(전용 계정이 없는 배치·시험). 래퍼와 같은 안전 기본값과 같은 출력 모양을 쓴다. */
export function localAgentGit(options: { timeoutMs?: number } = {}): AgentGit {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'none', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const git = async (dir: string, args: string[], out?: { path: string; limit: number }) => (await captureCode({ file: 'git',
    args: ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.excludesFile=/dev/null', ...args], env, cwd: dir },
  { ...(out && { out }), ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }) })).stdout;
  return {
    async inspect(path) {
      const head = (await git(path, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      if (!SHA.test(head)) throw new AgentGitError('HEAD 모양이 아닙니다.');
      const status = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
      const flags = (await git(path, ['ls-files', '-v'])).split('\n').some((line) => /^[a-zS] /.test(line));
      return parseInspect(`head ${head}\ndirty ${status || flags ? '1' : '0'}\n`);
    },
    async bundle(path, branch, out) { await git(path, ['bundle', 'create', '--quiet', '-', `refs/heads/${branch}`], { path: out, limit: BUNDLE_LIMIT }); },
  };
}

/**
 * Agent 작업 폴더 안 하위 Agent 정의 파일의 읽기·쓰기·지우기(fix2 추가, 조정자 지시).
 * 전용 계정 배치에서는 래퍼 `agent-file`(Agent 계정)로만 한다. Runner 계정은 Agent가 쓸 수 있는 폴더에 쓰지 않는다.
 * 왜: Runner가 lstat로 폴더를 확인한 뒤 쓰면, 그 사이 다른 Agent 세션이 폴더를 Runner 폴더 링크로 바꿔 Runner 파일을 덮어쓸 수 있다.
 *   Agent 계정이 쓰면 링크를 따라가도 Agent 권한이다.
 * `rel`은 작업 폴더 기준 `.claude/agents/<이름>`·`.codex/agents/<이름>`이다(래퍼가 모양을 다시 검사한다).
 */
export interface AgentFiles {
  readonly kind: 'agent-account' | 'same-account';
  /** 없으면 undefined. */
  read(cwd: string, rel: string): Promise<string | undefined>;
  /** 폴더를 만들고 같은 폴더의 임시 파일을 거쳐 한 번에 바꾼다. */
  write(cwd: string, rel: string, text: string): Promise<void>;
  /** 없으면 아무것도 하지 않는다. */
  remove(cwd: string, rel: string): Promise<void>;
}

export const AGENT_FILE_REL = /^\.(claude|codex)\/agents\/(\.awbs-installed\.json|[a-z][a-z0-9-]{0,63}\.(md|toml))$/;

export function wrapperAgentFiles(cfg: WrapperConfig = { user: AGENT_USER, exec: AGENT_EXEC }): AgentFiles {
  const check = (rel: string) => { if (!AGENT_FILE_REL.test(rel)) throw new AgentGitError('하위 Agent 정의 경로 모양이 아닙니다.'); };
  return {
    kind: 'agent-account',
    async read(cwd, rel) {
      check(rel);
      const result = await wrapperCall(cfg, ['agent-file', 'read', '--cwd', cwd, '--path', rel], { allow: [0, 3] });
      if (result.code === 3) return undefined;
      if (Buffer.byteLength(result.stdout) > 1024 * 1024) throw new AgentGitError('하위 Agent 정의 파일이 너무 큽니다.');
      return result.stdout;
    },
    async write(cwd, rel, text) {
      check(rel);
      if (Buffer.byteLength(text) > 1024 * 1024) throw new AgentGitError('하위 Agent 정의 파일이 너무 큽니다.');
      await wrapperCall(cfg, ['agent-file', 'write', '--cwd', cwd, '--path', rel], { input: text });
    },
    async remove(cwd, rel) { check(rel); await wrapperCall(cfg, ['agent-file', 'remove', '--cwd', cwd, '--path', rel]); },
  };
}

/**
 * QA가 남긴 증거 파일(작업 폴더의 `.awbs-evidence/<이름>`)을 Runner 전용 파일로 받는다(collect-prepare).
 * 전용 계정 배치는 래퍼 `evidence-read`(Agent 계정)로만 읽는다. Runner 계정은 Agent가 쓸 수 있는 폴더의 파일을 직접 열지 않는다.
 * 왜: Runner가 열면 Agent가 그 자리를 Runner 파일(토큰·설정) 링크로 바꿔 서버로 올리게 만들 수 있다. Agent 계정으로 읽으면 Agent 권한까지다.
 */
export interface AgentEvidence {
  /** `out`(Runner 전용 폴더의 새 파일, 0600)에 내용을 쓴다. 파일이 없으면 false. 일반 파일이 아니거나 `limit`보다 크면 예외다. */
  read(cwd: string, name: string, out: string, limit: number): Promise<boolean>;
}

/** 증거 파일 이름. 폴더 구분(/)·숨김 이름(.으로 시작)은 받지 않는다. 래퍼와 같은 규칙이다. */
export const EVIDENCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** 작업 폴더 안 증거 폴더 이름. 준비 때 만들고 `.git/info/exclude`로 상태 검사에서 뺀다. */
export const EVIDENCE_DIR = '.awbs-evidence';

export function wrapperAgentEvidence(cfg: WrapperConfig = { user: AGENT_USER, exec: AGENT_EXEC }): AgentEvidence {
  return {
    async read(cwd, name, out, limit) {
      if (!EVIDENCE_NAME.test(name)) throw new AgentGitError('증거 파일 이름 모양이 아닙니다.');
      const result = await wrapperCall(cfg, ['evidence-read', '--cwd', cwd, '--name', name], { out: { path: out, limit }, allow: [0, 3] });
      return result.code === 0;
    },
  };
}

/** 같은 계정 배치(전용 계정 없음·시험). 링크를 따라가지 않고(O_NOFOLLOW) 일반 파일만 읽는다. */
export const localAgentEvidence: AgentEvidence = {
  async read(cwd, name, out, limit) {
    if (!EVIDENCE_NAME.test(name)) throw new AgentGitError('증거 파일 이름 모양이 아닙니다.');
    const dir = await lstat(join(cwd, EVIDENCE_DIR)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!dir) return false;
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new AgentGitError('증거 폴더가 일반 폴더가 아닙니다.');
    let source;
    try { source = await open(join(cwd, EVIDENCE_DIR, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new AgentGitError('증거 파일을 열 수 없습니다(링크이거나 일반 파일이 아님).', { cause: error });
    }
    try {
      const info = await source.stat();
      if (!info.isFile()) throw new AgentGitError('증거 파일이 일반 파일이 아닙니다.');
      if (info.size > limit) throw new AgentGitError('증거 파일이 상한보다 큽니다.');
      const bytes = await source.readFile();
      if (bytes.length > limit) throw new AgentGitError('증거 파일이 상한보다 큽니다.');
      const target = await open(out, 'wx', 0o600);
      try { await target.writeFile(bytes); } finally { await target.close(); }
      return true;
    } finally { await source.close(); }
  },
};
