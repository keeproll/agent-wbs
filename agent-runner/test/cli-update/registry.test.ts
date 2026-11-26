import { describe, expect, test } from 'vitest';
import { createCliRegistry, cliArguments, cliEnvironment } from '../../src/cli-update/registry.ts';
import type { CommandResult, RunCommand } from '../../src/readiness/command.ts';

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const home = '/home/example/.agentwbs';

describe('cli-update — 공식 npm 채널·무과금 점검', () => {
  test.each([
    { agent: 'Codex' as const, pkg: '@openai/codex', version: '0.173.0' },
    { agent: 'Claude' as const, pkg: '@anthropic-ai/claude-code', version: '2.1.333' },
  ])('$agent의 latest를 조회하고 전용 prefix에 정확한 버전만 설치한다', async ({ agent, pkg, version }) => {
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const run: RunCommand = async (cmd, args) => {
      calls.push({ cmd, args });
      return ok(JSON.stringify(version));
    };
    const registry = createCliRegistry({ home, env: {}, run });
    expect(await registry.latest(agent)).toBe(version);
    await registry.install(agent, version, `${home}/cli/${agent.toLowerCase()}/.install-123`);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.cmd).toBe('npm');
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['view', `${pkg}@latest`, 'version', '--json', '--registry=https://registry.npmjs.org', '--global']));
    expect(calls[1]?.args).toEqual(expect.arrayContaining(['install', '--global', '--prefix', `${home}/cli/${agent.toLowerCase()}/.install-123`, `${pkg}@${version}`]));
    expect(calls[1]?.args).toEqual(expect.arrayContaining(['--userconfig=/dev/null', '--globalconfig=/dev/null', `--cache=${home}/cli/.npm-cache`]));
  });

  test.each(['../escape', '0.1.0-beta', '01.2.3', '', '1.2.3\n'])('잘못된 설치 버전 %j는 명령 실행 전에 거절', async (version) => {
    let calls = 0;
    const registry = createCliRegistry({ home, env: {}, run: async () => { calls += 1; return ok(); } });
    await expect(registry.install('Codex', version, `${home}/cli/codex/.install-x`)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test('전용 설치 폴더 밖이나 다른 Agent 폴더에는 설치하지 않는다', async () => {
    let calls = 0;
    const registry = createCliRegistry({ home, env: {}, run: async () => { calls += 1; return ok(); } });
    for (const path of ['/usr/local', `${home}/cli/claude/.install-x`, `${home}/cli/codex/.install-x/../../escape`]) {
      await expect(registry.install('Codex', '0.173.0', path)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });

  test('조회 실패·잘못된 JSON·잘못된 latest·설치 실패를 성공으로 취급하지 않는다', async () => {
    for (const result of [{ code: 1, stdout: '"0.173.0"', stderr: '네트워크 단절' }, ok('bad'), ok('"../escape"')]) {
      const registry = createCliRegistry({ home, env: {}, run: async () => result });
      await expect(registry.latest('Codex')).rejects.toThrow();
    }
    const registry = createCliRegistry({ home, env: {}, run: async () => ({ code: 1, stdout: '', stderr: '설치 실패' }) });
    await expect(registry.install('Codex', '0.173.0', `${home}/cli/codex/.install-x`)).rejects.toThrow();
  });

  test.each([
    { agent: 'Codex' as const, version: '0.173.0', versionText: 'codex-cli 0.173.0\n', auth: ['login', 'status'], authText: 'Logged in using ChatGPT', help: ['exec', '--help'], helpText: '--json --model --sandbox' },
    { agent: 'Claude' as const, version: '2.1.333', versionText: '2.1.333 (Claude Code)\n', auth: ['auth', 'status', '--json'], authText: '{"loggedIn":true}', help: ['--help'], helpText: '--print --output-format stream-json --verbose' },
  ])('$agent는 실행·버전·로그인·필수 옵션을 모두 무과금 명령으로 확인', async ({ agent, version, versionText, auth, authText, help, helpText }) => {
    const calls: (readonly string[])[] = [];
    const replies = [ok(versionText), ok(authText), ok(helpText)];
    const registry = createCliRegistry({ home, env: {}, run: async (_cmd, args) => { calls.push(args); return replies.shift() ?? ok(); } });
    await registry.probe(agent, version, '/private/bin/cli');
    const prefix = agent === 'Codex' ? ['-c', 'check_for_update_on_startup=false'] : [];
    expect(calls).toEqual([[...prefix, '--version'], [...prefix, ...auth], [...prefix, ...help]]);
  });

  test.each([
    [ok('codex-cli 0.172.0'), ok('Logged in'), ok('--json --model --sandbox')],
    [ok('codex-cli 0.173.0'), { code: 1, stdout: '', stderr: 'Not logged in' }, ok('--json --model --sandbox')],
    [ok('codex-cli 0.173.0'), ok('Logged in'), ok('--model --sandbox')],
    [{ code: null, stdout: 'codex-cli 0.173.0', stderr: 'timeout' }, ok(), ok('--json --model --sandbox')],
  ])('Codex 점검의 버전·로그인·옵션·실행 실패를 거절 %#', async (...results) => {
    const registry = createCliRegistry({ home, env: {}, run: async () => results.shift() ?? ok() });
    await expect(registry.probe('Codex', '0.173.0', '/private/bin/codex')).rejects.toThrow();
  });

  test.each(['{"loggedIn":false}', 'bad', '{"loggedIn":"true"}'])('Claude 로그인 형식 %s는 유효한 로그인으로 오인하지 않는다', async (auth) => {
    const replies = [ok('2.1.333 (Claude Code)'), ok(auth), ok('--print --output-format --verbose')];
    const registry = createCliRegistry({ home, env: {}, run: async () => replies.shift() ?? ok() });
    await expect(registry.probe('Claude', '2.1.333', '/private/bin/claude')).rejects.toThrow();
  });

  test('Claude 도움말이 stream-json 출력 형식을 지원하지 않으면 적용을 거절한다', async () => {
    const replies = [ok('2.1.333 (Claude Code)'), ok('{"loggedIn":true}'), ok('--print --output-format text --verbose')];
    const registry = createCliRegistry({ home, env: {}, run: async () => replies.shift() ?? ok() });
    await expect(registry.probe('Claude', '2.1.333', '/private/bin/claude')).rejects.toThrow();
  });

  test('CLI가 빌드 꼬리표를 붙인 다른 버전이면 같은 안정판으로 오인하지 않는다', async () => {
    const replies = [ok('codex-cli 0.173.0+other'), ok('Logged in'), ok('--json --model --sandbox')];
    const registry = createCliRegistry({ home, env: {}, run: async () => replies.shift() ?? ok() });
    await expect(registry.probe('Codex', '0.173.0', '/private/bin/codex')).rejects.toThrow();
  });

  test('실행 환경은 비밀을 거르고 자체 업데이트를 끄며 Codex 설정을 명시한다', () => {
    const env = cliEnvironment({ HOME: '/home/u', PATH: '/bin', AWBS_RUNNER_TOKEN: 'secret', GITHUB_TOKEN: 'secret', DISABLE_AUTOUPDATER: '0', DISABLE_UPDATES: '0' });
    expect(env).toEqual({ HOME: '/home/u', PATH: '/bin', DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' });
    expect(cliArguments('Codex', ['exec', '--json'])).toEqual(['-c', 'check_for_update_on_startup=false', 'exec', '--json']);
    expect(cliArguments('Claude', ['-p', '--output-format', 'stream-json'])).toEqual(['-p', '--output-format', 'stream-json']);
  });
});
