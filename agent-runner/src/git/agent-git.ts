import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
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

interface Spawned { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }

interface CaptureOptions { out?: { path: string; limit: number }; input?: string; allow?: readonly number[] }

/** 명령 하나를 돌려 표준 출력을 모으거나(상한) 파일로 쓴다. 허용하지 않은 종료 코드면 실패. */
async function capture(command: Spawned, out?: { path: string; limit: number }): Promise<string> {
  return (await captureCode(command, { ...(out && { out }) })).stdout;
}

async function captureCode(command: Spawned, options: CaptureOptions): Promise<{ code: number; stdout: string }> {
  const out = options.out;
  const file = out ? await open(out.path, 'wx', 0o600) : undefined;
  try {
    return await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      const child = spawn(command.file, command.args, { cwd: command.cwd, env: command.env, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
      if (options.input !== undefined) { child.stdin?.on('error', () => undefined); child.stdin?.end(options.input); }
      const chunks: Buffer[] = [];
      let size = 0, failed: Error | undefined, writing = Promise.resolve();
      const stop = (error: Error) => { failed ??= error; try { process.kill(-(child.pid ?? 0), 'SIGKILL'); } catch { /* 이미 끝남 */ } };
      const timer = setTimeout(() => stop(new AgentGitError('Agent git 명령이 시간 안에 끝나지 않았습니다.')), TIMEOUT_MS);
      child.stdout?.on('data', (bytes: Buffer) => {
        size += bytes.length;
        if (size > (out?.limit ?? 1024 * 1024)) { stop(new AgentGitError('Agent git 출력이 상한을 넘었습니다.')); return; }
        if (file) { const f = file; writing = writing.then(async () => { await f.write(bytes); }); }
        else chunks.push(bytes);
      });
      child.stderr?.resume();
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        void writing.then(() => {
          if (failed) reject(failed);
          else if (code === null || !(options.allow ?? [0]).includes(code)) reject(new AgentGitError(`Agent 계정 명령이 종료 코드 ${String(code)}로 끝났습니다.`));
          else resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
        }, reject);
      });
    });
  } finally { await file?.close(); }
}

/**
 * 실제 래퍼로 Agent 계정 git을 돌린다: `systemd-run --user --scope -- sudo -n -u awbs-agent -- 래퍼 git-…`.
 * Agent 설정이 무엇을 띄우든 그 프로세스는 scope 안이다. 끝나면 scope를 비우고 비었음을 확인한다(못 하면 실패).
 */
export interface WrapperConfig { user: string; exec: string; sudo?: string }

/** 래퍼 하위 명령 하나를 사용자 scope 안에서 Agent 계정으로 돌리고, 끝나면 scope를 비운 것을 확인한다. */
async function wrapperCall(cfg: WrapperConfig, args: string[], options: CaptureOptions = {}): Promise<{ code: number; stdout: string }> {
  const launch = inUserScope({ file: cfg.sudo ?? '/usr/bin/sudo', args: ['-n', '-u', cfg.user, '--', cfg.exec, ...args], env: { PATH: '/usr/bin:/bin' }, cwd: '/', stdin: '' });
  // 결과를 쓰기 전에 scope를 비운다. Agent 설정이 띄운 프로세스가 남으면 결과도 믿지 않는다.
  let result: { code: number; stdout: string } | undefined, failure: unknown;
  try { result = await captureCode(launch, options); } catch (error) { failure = error; }
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
export function localAgentGit(): AgentGit {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'none', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const git = (dir: string, args: string[], out?: { path: string; limit: number }) => capture({ file: 'git',
    args: ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.excludesFile=/dev/null', ...args], env, cwd: dir }, out);
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
