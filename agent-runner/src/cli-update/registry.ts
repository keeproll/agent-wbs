import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Agent } from '../api/generated/client.ts';
import { createRunCommand, probeEnv, type CommandResult, type RunCommand } from '../readiness/command.ts';
import { stableVersion, type CliRegistry } from './manager.ts';

const PACKAGES = { Codex: '@openai/codex', Claude: '@anthropic-ai/claude-code' } as const;

/** 세션 실행 계층도 이 인자·환경을 써서 Runner만 설치 버전을 바꿀 수 있게 한다. */
export function cliArguments(agent: Agent, args: readonly string[]): readonly string[] {
  return agent === 'Codex' ? ['-c', 'check_for_update_on_startup=false', ...args] : args;
}
export function cliEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...probeEnv(env), DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' };
}

/**
 * 준비 점검이 전용 설치 CLI를 부를 때도 세션 실행과 같은 인자·환경을 쓰게 감싼다(M-1 단일 출처).
 * 다른 명령(git·node 등)은 원래 실행기로 그대로 보낸다.
 */
export function cliAwareRun(base: RunCommand, cli: RunCommand, bins: { codex: string; claude: string }): RunCommand {
  return (cmd, args) => {
    if (cmd === bins.codex) return cli(cmd, cliArguments('Codex', args));
    if (cmd === bins.claude) return cli(cmd, cliArguments('Claude', args));
    return base(cmd, args);
  };
}

function checked(result: CommandResult): string {
  // 외부 명령의 출력에는 계정 정보가 있을 수 있으므로 오류에 원문을 넣지 않는다.
  if (result.code !== 0) throw new Error('CLI 다운로드·설치·무과금 점검 명령이 실패했습니다.');
  return result.stdout;
}

/**
 * npm을 umask 0022로 실행한다(리뷰5 P3-5). 설치본·npm 캐시에 그룹 쓰기가 생기지 않게 한다.
 * 왜: 전용 계정 격리에서는 CLI 폴더의 그룹이 Agent 계정이다. Runner를 umask 0002인 환경(예: 서비스)에서 띄우면
 *   Agent가 CLI 파일을 고칠 수 있게 되고, 래퍼 check가 `fail cli_writable`로 실행을 막는다.
 * umask는 프로세스 전체 값이라 Runner 안에서 바꾸지 않고, 자식 셸에서만 정한 뒤 npm으로 바꿔 실행한다.
 */
function npmCommand(run: RunCommand, args: readonly string[]): Promise<CommandResult> {
  return run('/bin/sh', ['-c', 'umask 0022 && exec npm "$@"', 'sh', ...args]);
}

/** 공식 npm latest 채널. 전용 prefix를 써서 사용자 전역 설치와 설정을 건드리지 않는다. */
export function createCliRegistry({ home, env, run = createRunCommand({ env: cliEnvironment(env), timeoutMs: 120_000 }) }: {
  home: string; env: NodeJS.ProcessEnv; run?: RunCommand;
}): CliRegistry {
  const npmFlags = ['--global', '--registry=https://registry.npmjs.org', '--userconfig=/dev/null', `--globalconfig=${join(home, 'cli', '.npm-empty-globalconfig')}`,
    `--cache=${join(home, 'cli', '.npm-cache')}`, '--no-update-notifier'];
  return {
    async latest(agent) {
      const output = checked(await npmCommand(run, ['view', `${PACKAGES[agent]}@latest`, 'version', '--json', ...npmFlags]));
      const parsed: unknown = JSON.parse(output);
      const version: unknown = Array.isArray(parsed) ? parsed.at(-1) : parsed;
      stableVersion(version);
      return version;
    },
    async install(agent, version, directory) {
      stableVersion(version);
      const base = resolve(home, 'cli', agent.toLowerCase());
      if (!isAbsolute(directory) || dirname(resolve(directory)) !== base || !/^\.install-[\w-]+$/.test(directory.slice(base.length + 1))) {
        throw new Error('설치는 이 Agent의 전용 임시 폴더에서만 가능합니다.');
      }
      const scripts = agent === 'Claude' ? ['--allow-scripts=@anthropic-ai/claude-code'] : [];
      checked(await npmCommand(run, ['install', '--prefix', directory, `${PACKAGES[agent]}@${version}`, ...npmFlags, '--no-audit', '--no-fund', ...scripts]));
    },
    async probe(agent, version, binary) {
      stableVersion(version);
      const command = async (args: readonly string[]) => checked(await run(binary, cliArguments(agent, args)));
      const output = await command(['--version']);
      const actual = /\b(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)\b/.exec(output)?.[1];
      if (actual !== version) throw new Error('설치한 CLI 버전과 요청한 버전이 다릅니다.');
      const auth = await command(agent === 'Codex' ? ['login', 'status'] : ['auth', 'status', '--json']);
      if (agent === 'Claude' && (JSON.parse(auth) as { loggedIn?: unknown }).loggedIn !== true) throw new Error('Claude 로그인이 필요합니다.');
      const help = await command(agent === 'Codex' ? ['exec', '--help'] : ['--help']);
      const required = agent === 'Codex' ? ['--json', '--model', '--sandbox'] : ['--print', '--output-format', '--verbose', 'stream-json'];
      if (required.some((option) => !new RegExp(`${option}(?=[\\s,=<>]|$)`).test(help))) throw new Error('필수 실행 옵션을 지원하지 않습니다.');
    },
  };
}
