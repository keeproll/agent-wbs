import { realpathSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { Agent } from '../api/generated/client.ts';
import type { RunCommand } from '../readiness/command.ts';
import { PENDING_ISOLATION, type IsolationLayer, type Launch } from './isolation.ts';

/**
 * 전용 OS 계정 격리(owner Q-08 결정 B, 2026-11-27).
 * Runner 계정은 sudoers 규칙 하나로 실행 래퍼(`awbs-agent-exec`)만 Agent 계정으로 실행한다.
 * 실제 계정·sudoers·래퍼 설치는 owner가 `scripts/isolation/setup-agent-user.sh`로 한다. 설계는 `docs/isolation.md`.
 */
export interface DedicatedUserConfig {
  /** Agent 전용 계정 이름(`AWBS_AGENT_USER`, 예: awbs-agent) */
  user: string;
  /** Agent 작업 영역(`AWBS_AGENT_ROOT`, 예: /srv/agentwbs). 작업 폴더는 `worktrees/`, CLI는 `cli/` 아래여야 한다. */
  root: string;
  /** 실행 래퍼(`AWBS_AGENT_EXEC`, 예: /usr/local/libexec/awbs-agent-exec). root 소유여야 한다. */
  exec: string;
  /** sudo 실행 파일. 기본 /usr/bin/sudo */
  sudo?: string;
}

export type DedicatedUserCode = 'agent_config_invalid' | 'cwd_outside_agent_root' | 'binary_outside_agent_root';

export class DedicatedUserError extends Error {
  readonly code: DedicatedUserCode;
  constructor(code: DedicatedUserCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 전용 계정 안에서 쓰는 CLI 권한 모드. 이 값도 관측 등급 조합의 「옵션」에 들어간다(`sessionOptions`).
 * - 왜 CLI 승인 창을 끄나: 세션은 사람이 없는 `-p`·`exec` 실행이라 승인을 물으면 명령(시험·빌드)을 못 돌린다.
 *   대신 OS 계정이 실제 경계다(Runner 홈·비밀값·다른 프로젝트를 OS 권한으로 막는다).
 * - Codex는 CLI sandbox(workspace-write)를 함께 켜 둔다. 두 번째 울타리다. 단 네트워크가 막히므로 M8 실검증에서 확인한다.
 */
export const DEDICATED_FLAGS: Readonly<Record<Agent, readonly string[]>> = {
  Claude: ['--permission-mode', 'bypassPermissions'],
  Codex: ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"'],
};

/**
 * 계정 이름·경로는 고정값이다. 설치 스크립트(scripts/isolation/common.sh)와 같은 값이어야 한다.
 * 왜: 설정 오입력으로 root나 다른 계정·다른 폴더를 쓰지 않게 한다(리뷰 P2-2).
 */
export const AGENT_USER = 'awbs-agent';
export const AGENT_ROOT = '/srv/agentwbs';
export const AGENT_EXEC = '/usr/local/libexec/awbs-agent-exec';

const PATH = /^\/[A-Za-z0-9._/-]+$/;
/** 래퍼가 받는 언어 설정 값. 래퍼도 같은 규칙으로 다시 검사한다. */
const LOCALE = /^[A-Za-z0-9_.@-]{1,64}$/;
/** sudo 자신에게 주는 환경. sudo는 어차피 환경을 지우지만(env_reset), Runner 환경을 넘길 이유가 없다. */
const SUDO_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };

function validPath(value: string): boolean {
  return isAbsolute(value) && PATH.test(value) && normalize(value) === value && !value.endsWith('/');
}

/**
 * `AWBS_AGENT_*` 환경 변수에서 설정을 읽는다. `AWBS_AGENT_USER`가 없으면 null(=전용 계정 미설치, 실행 거부 유지).
 * 오류 메시지에 입력값을 넣지 않는다.
 */
export function agentIsolationConfig(env: NodeJS.ProcessEnv): DedicatedUserConfig | null {
  const user = env.AWBS_AGENT_USER;
  if (!user) return null;
  if (user !== AGENT_USER) throw new DedicatedUserError('agent_config_invalid', `AWBS_AGENT_USER는 고정값 ${AGENT_USER}만 쓸 수 있습니다.`);
  // 경로는 고정이다. 예전 .env처럼 값을 적었다면 고정값과 같을 때만 받아들인다. 빈 줄(AWBS_AGENT_ROOT=)은 고정값.
  if (env.AWBS_AGENT_ROOT && env.AWBS_AGENT_ROOT !== AGENT_ROOT) throw new DedicatedUserError('agent_config_invalid', `AWBS_AGENT_ROOT는 고정값 ${AGENT_ROOT}만 쓸 수 있습니다.`);
  if (env.AWBS_AGENT_EXEC && env.AWBS_AGENT_EXEC !== AGENT_EXEC) throw new DedicatedUserError('agent_config_invalid', `AWBS_AGENT_EXEC는 고정값 ${AGENT_EXEC}만 쓸 수 있습니다.`);
  return { user: AGENT_USER, root: AGENT_ROOT, exec: AGENT_EXEC };
}

/** 링크를 모두 따라간 실제 경로가 `base` 폴더 「안」인가(base 자체는 아님). */
function inside(real: string, base: string): boolean {
  return real.startsWith(`${base}/`);
}

export interface DedicatedUserDeps {
  /** 링크를 따라간 실제 경로. 기본 `fs.realpathSync.native`. 시험은 fake를 넘긴다. */
  realpath?: (path: string) => string;
}

/**
 * 실행 계획을 `sudo -n -u <Agent 계정> -- <래퍼> run ...`으로 감싼다.
 * - 작업 폴더·CLI 경로는 링크를 따라간 실제 경로로 바꿔 넘긴다. Agent 계정은 Runner 홈의 링크를 따라갈 수 없기 때문이다.
 *   - 예: `current` 링크를 이 시점의 버전 폴더로 고정한다. 실행 중 CLI 업데이트가 링크를 바꿔도 이 세션은 그대로다.
 * - 환경 변수는 언어 설정(LANG·LC_ALL)만 넘긴다. HOME·PATH·TMPDIR는 래퍼가 Agent 계정 값으로 새로 만든다.
 *   - 왜: Runner의 HOME·CODEX_HOME·CLAUDE_CONFIG_DIR는 Runner 계정 폴더라 넘기면 안 되고, 넘겨도 Agent가 읽을 수 없다.
 * - 지시문은 그대로 표준 입력으로 간다(sudo가 그대로 이어 준다).
 * - `-n`: 비밀번호를 묻지 않는다. sudoers 규칙이 없으면 바로 실패해 멈추지 않는다.
 */
export function dedicatedUserIsolation(cfg: DedicatedUserConfig, deps: DedicatedUserDeps = {}): IsolationLayer {
  const realpath = deps.realpath ?? ((p: string) => realpathSync.native(p));
  /** 실제 경로. 없거나 읽지 못하면 그 코드로 거부한다. 비교하는 양쪽(대상·기준 폴더)을 모두 이 함수로 정규화한다(리뷰 P2-3). */
  const real = (p: string, code: DedicatedUserCode, message: string): string => {
    try {
      return realpath(p);
    } catch {
      throw new DedicatedUserError(code, message);
    }
  };
  const sudo = cfg.sudo ?? '/usr/bin/sudo';
  return {
    name: 'dedicated-user',
    flags: (agent) => DEDICATED_FLAGS[agent],
    wrap(launch: Launch, agent: Agent): Launch {
      const outside = '작업 폴더가 Agent 작업 영역(worktrees) 밖입니다.';
      const cwd = real(launch.cwd, 'cwd_outside_agent_root', outside);
      const worktrees = real(join(cfg.root, 'worktrees'), 'cwd_outside_agent_root', outside);
      if (!inside(cwd, worktrees)) throw new DedicatedUserError('cwd_outside_agent_root', '작업 폴더가 Agent 작업 영역(worktrees) 밖입니다.');
      const name = agent.toLowerCase();
      const notCli = 'CLI가 Agent 작업 영역의 Runner 설치본(cli) 밖입니다.';
      const binary = real(launch.file, 'binary_outside_agent_root', notCli);
      if (!inside(binary, real(join(cfg.root, 'cli', name), 'binary_outside_agent_root', notCli))) {
        throw new DedicatedUserError('binary_outside_agent_root', 'CLI가 Agent 작업 영역의 Runner 설치본(cli) 밖입니다.');
      }
      const env = (['LANG', 'LC_ALL'] as const).flatMap((key) => {
        const value = launch.env[key];
        return value !== undefined && LOCALE.test(value) ? ['--env', `${key}=${value}`] : [];
      });
      return {
        file: sudo,
        args: ['-n', '-u', cfg.user, '--', cfg.exec, 'run', '--agent', name, '--cwd', cwd, ...env, '--', binary, ...launch.args],
        env: SUDO_ENV,
        cwd,
        stdin: launch.stdin,
      };
    },
  };
}

export type AgentControl =
  | { kind: 'kill-group'; pgid: number }
  | { kind: 'kill-all' }
  | { kind: 'fix-perms'; path: string }
  | { kind: 'check' };

/**
 * Agent 계정 프로세스·파일을 다루는 래퍼 명령. Runner 계정은 다른 계정의 프로세스에 신호를 보낼 수 없어(EPERM)
 * 정리는 Agent 계정으로 실행해야 한다. 실행은 exec 계층(M5-02)·정리 계층이 한다.
 * - `kill-group`: 세션 프로세스 그룹의 Agent 프로세스 강제 종료. cgroup(M5-03)을 쓸 수 있으면 `cgroup.kill`이 먼저다.
 * - `kill-all`: 실행 중 세션이 0일 때 Agent 계정에 남은 프로세스 청소. 전용 계정이라 계정 전체가 곧 Agent 실행이다.
 * - `fix-perms`: Agent가 권한을 지운 작업 폴더 파일에 Runner 권한을 되돌린다(삭제 전에).
 */
export function agentControl(cfg: DedicatedUserConfig, op: AgentControl): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const base = ['-n', '-u', cfg.user, '--', cfg.exec];
  let tail: string[];
  if (op.kind === 'kill-group') {
    if (!Number.isSafeInteger(op.pgid) || op.pgid <= 1) throw new RangeError('pgid는 1보다 큰 정수여야 합니다.');
    tail = ['kill-group', String(op.pgid)];
  } else if (op.kind === 'fix-perms') {
    if (!validPath(op.path) || !inside(op.path, join(cfg.root, 'worktrees'))) {
      throw new DedicatedUserError('cwd_outside_agent_root', '권한을 고칠 경로가 Agent 작업 영역(worktrees) 밖입니다.');
    }
    tail = ['fix-perms', op.path];
  } else {
    tail = [op.kind];
  }
  return { file: cfg.sudo ?? '/usr/bin/sudo', args: [...base, ...tail], env: SUDO_ENV };
}

export interface IsolationChoice {
  isolation: IsolationLayer;
  /** 전용 계정을 쓰지 못한 이유. 쓰면 null. readiness 경고에 그대로 쓴다. */
  reason: string | null;
}

/**
 * 준비 점검에서 격리 계층을 고른다.
 * - `AWBS_AGENT_USER`가 없으면(=테스트·미설치 PC) 지금처럼 `PENDING_ISOLATION`(실제 실행 거부).
 * - 있으면 래퍼 `check`를 Agent 계정으로 실제로 돌려 본다. 「ok」가 아니면 거부를 유지한다.
 *   - 왜: 설정만 믿으면 sudoers·래퍼·WSL 보호가 빠진 PC에서 격리된 줄 알고 실행하게 된다.
 *   - 예: 부팅 뒤 /run/WSL 보호 서비스가 아직 안 돌았으면 `fail wsl_interop_accessible`로 거부된다.
 */
export async function selectIsolation(env: NodeJS.ProcessEnv, run: RunCommand, deps: DedicatedUserDeps = {}): Promise<IsolationChoice> {
  let cfg: DedicatedUserConfig | null;
  try {
    cfg = agentIsolationConfig(env);
  } catch (error) {
    return { isolation: PENDING_ISOLATION, reason: (error as Error).message };
  }
  if (!cfg) return { isolation: PENDING_ISOLATION, reason: '전용 Agent 계정(AWBS_AGENT_USER)이 설정되지 않아 실제 실행을 만들지 않습니다.' };
  const check = agentControl(cfg, { kind: 'check' });
  const result = await run(check.file, check.args);
  if (result.code !== 0 || result.stdout.trim() !== 'ok') {
    // 외부 명령 출력은 줄 이름(fail <항목>)만 옮긴다. 다른 글은 넣지 않는다.
    const items = result.stdout.split('\n').map((line) => /^fail ([a-z_]+)$/.exec(line.trim())?.[1]).filter(Boolean);
    return { isolation: PENDING_ISOLATION, reason: `전용 Agent 계정 점검 실패${items.length ? `: ${items.join(', ')}` : '(sudoers·래퍼 확인 필요)'}` };
  }
  return { isolation: dedicatedUserIsolation(cfg, deps), reason: null };
}
