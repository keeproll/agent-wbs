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

function checked(result: CommandResult): string {
  // 외부 명령의 출력에는 계정 정보가 있을 수 있으므로 오류에 원문을 넣지 않는다.
  if (result.code !== 0) throw new Error('CLI 다운로드·설치·무과금 점검 명령이 실패했습니다.');
  return result.stdout;
}

/** 공식 npm latest 채널. 전용 prefix를 써서 사용자 전역 설치와 설정을 건드리지 않는다. */
export function createCliRegistry({ home, env, run = createRunCommand({ env: cliEnvironment(env), timeoutMs: 120_000 }) }: {
  home: string; env: NodeJS.ProcessEnv; run?: RunCommand;
}): CliRegistry {
  const npmFlags = ['--global', '--registry=https://registry.npmjs.org', '--userconfig=/dev/null', `--globalconfig=${join(home, 'cli', '.npm-empty-globalconfig')}`,
    `--cache=${join(home, 'cli', '.npm-cache')}`, '--no-update-notifier'];
  return {
    async latest(agent) {
      const output = checked(await run('npm', ['view', `${PACKAGES[agent]}@latest`, 'version', '--json', ...npmFlags]));
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
      checked(await run('npm', ['install', '--prefix', directory, `${PACKAGES[agent]}@${version}`, ...npmFlags, '--no-audit', '--no-fund', ...scripts]));
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
