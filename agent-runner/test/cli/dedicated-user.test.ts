import { describe, expect, test, vi } from 'vitest';
import { buildLaunch, sessionOptions, type RunSpec } from '../../src/cli/args.ts';
import {
  agentControl, agentIsolationConfig, agentLoginRun, cliEntryPoint, DEDICATED_FLAGS, dedicatedUserIsolation, DedicatedUserError, selectIsolation, type DedicatedUserConfig,
} from '../../src/cli/dedicated-user.ts';
import { IsolationUndecidedError, PENDING_ISOLATION } from '../../src/cli/isolation.ts';
import type { RunCommand } from '../../src/readiness/command.ts';
import { scopeProbeReply } from '../helpers/scope-probe.ts';

/** 「계정이 있다고 가정한」 설정. 실제 계정·sudo는 쓰지 않는다(명령 구성만 본다). */
const cfg: DedicatedUserConfig = { user: 'awbs-agent', root: '/srv/agentwbs', exec: '/usr/local/libexec/awbs-agent-exec' };
const CODEX_REAL = '/srv/agentwbs/cli/codex/0.172.0/bin/codex';
const CLAUDE_REAL = '/srv/agentwbs/cli/claude/2.1.332/bin/claude';
/** 링크 해석 fake: current 링크는 버전 폴더로, 링크된 작업 폴더는 지정한 곳으로. */
const links: Record<string, string> = {
  // current 링크는 버전 폴더로. 진입점(bin/<agent>)은 패키지 안 파일을 가리키는 링크다(실제 설치 모양).
  '/srv/agentwbs/cli/codex/current': '/srv/agentwbs/cli/codex/0.172.0',
  '/srv/agentwbs/cli/claude/current': '/srv/agentwbs/cli/claude/2.1.332',
  [CODEX_REAL]: '/srv/agentwbs/cli/codex/0.172.0/lib/node_modules/@openai/codex/bin/codex.js',
  [CLAUDE_REAL]: '/srv/agentwbs/cli/claude/2.1.332/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  '/srv/agentwbs/worktrees/p1/escape': '/home/keeproll/.agentwbs/state',
};
const realpath = (p: string) => links[p] ?? p;
const iso = dedicatedUserIsolation(cfg, { realpath });
const spec: RunSpec = { model: 'gpt-6.2-sol', effort: 'high', cwd: '/srv/agentwbs/worktrees/p1/attempt-1', prompt: 'TASK-0001 지시문' };
const hostEnv: NodeJS.ProcessEnv = {
  PATH: '/home/keeproll/.nvm/bin:/usr/bin', HOME: '/home/keeproll', USER: 'keeproll', LANG: 'ko_KR.UTF-8', TMPDIR: '/home/keeproll/tmp',
  CODEX_HOME: '/home/keeproll/.codex', CLAUDE_CONFIG_DIR: '/home/keeproll/.claude', XDG_CONFIG_HOME: '/home/keeproll/.config',
  AWBS_RUNNER_TOKEN: 'runner-secret', GH_TOKEN: 'ghp_secret', SSH_AUTH_SOCK: '/tmp/ssh-x/agent.1',
};

describe('agentIsolationConfig — AWBS_AGENT_* 읽기', () => {
  test('AWBS_AGENT_USER가 없으면 null(전용 계정 미설치 → 실행 거부 유지)', () => {
    expect(agentIsolationConfig({})).toBeNull();
    expect(agentIsolationConfig({ AWBS_AGENT_ROOT: '/srv/agentwbs' })).toBeNull();
  });
  test('기본 경로', () => {
    expect(agentIsolationConfig({ AWBS_AGENT_USER: 'awbs-agent' })).toEqual(cfg);
    // .env.example처럼 빈 값으로 남긴 줄도 기본값
    expect(agentIsolationConfig({ AWBS_AGENT_USER: 'awbs-agent', AWBS_AGENT_ROOT: '', AWBS_AGENT_EXEC: '' })).toEqual(cfg);
  });
  test.each([
    [{ AWBS_AGENT_USER: 'root' }],
    [{ AWBS_AGENT_USER: 'Awbs' }],
    [{ AWBS_AGENT_USER: 'a b' }],
    // 고정값이 아닌 다른 계정 이름은 형식이 맞아도 거부(리뷰 P2-2)
    [{ AWBS_AGENT_USER: 'keeproll' }],
    [{ AWBS_AGENT_USER: 'nobody' }],
    [{ AWBS_AGENT_USER: 'awbs-agent', AWBS_AGENT_ROOT: '/srv//agentwbs' }],
    [{ AWBS_AGENT_USER: 'awbs-agent', AWBS_AGENT_ROOT: '/opt/agentwbs' }],
    [{ AWBS_AGENT_USER: 'awbs-agent', AWBS_AGENT_EXEC: '/tmp/awbs-agent-exec' }],
    [{ AWBS_AGENT_USER: 'awbs-agent', AWBS_AGENT_ROOT: 'srv/agentwbs' }],
    [{ AWBS_AGENT_USER: 'awbs-agent', AWBS_AGENT_ROOT: '/srv/../home/keeproll' }],
    [{ AWBS_AGENT_USER: 'awbs-agent', AWBS_AGENT_ROOT: '/srv/agentwbs/' }],
    [{ AWBS_AGENT_USER: 'awbs-agent', AWBS_AGENT_ROOT: '/' }],
    [{ AWBS_AGENT_USER: 'awbs-agent', AWBS_AGENT_EXEC: 'awbs-agent-exec' }],
  ])('잘못된 값 %j는 거부', (env) => {
    expect(() => agentIsolationConfig(env)).toThrow(expect.objectContaining({ code: 'agent_config_invalid' }));
  });
});

describe('dedicatedUserIsolation — sudo로 래퍼만 Agent 계정으로 실행(명령 구성)', () => {
  test('Codex: sudo -n -u awbs-agent -- 래퍼 run … -- 실제 CLI 경로 + CLI 인자', () => {
    const l = buildLaunch('Codex', '/srv/agentwbs/cli/codex/current/bin/codex', spec, { env: hostEnv, isolation: iso });
    expect(l.file).toBe('/usr/bin/sudo');
    expect(l.args).toEqual([
      '-n', '-u', 'awbs-agent', '--', '/usr/local/libexec/awbs-agent-exec', 'run', '--agent', 'codex', '--cwd', spec.cwd, '--env', 'LANG=ko_KR.UTF-8', '--',
      CODEX_REAL, '-c', 'check_for_update_on_startup=false', 'exec', '--json', '--disable', 'hooks',
      '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '--model', 'gpt-6.2-sol', '-c', 'model_reasoning_effort="high"', '-',
    ]);
    expect(l.cwd).toBe(spec.cwd);
    expect(l.stdin).toBe('TASK-0001 지시문');
    expect(l.args.join(' ')).not.toContain('지시문');
  });

  test('Claude: 권한 모드 bypassPermissions, current 링크는 실행 시점 버전으로 고정', () => {
    const l = buildLaunch('Claude', '/srv/agentwbs/cli/claude/current/bin/claude', { ...spec, model: 'claude-opus-5-5', resume: '0b6f3c2e-6a1d-4f7e' }, { env: hostEnv, isolation: iso });
    const cli = l.args.indexOf(CLAUDE_REAL);
    expect(l.args.slice(0, cli)).toContain('claude');
    expect(l.args.slice(cli + 1)).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--settings', '{"disableAllHooks":true}',
      '--permission-mode', 'bypassPermissions', '--model', 'claude-opus-5-5', '--effort', 'high', '--resume', '0b6f3c2e-6a1d-4f7e',
    ]);
  });

  test('Runner 계정의 환경(HOME·PATH·CLI 설정 폴더·토큰)은 sudo에도 인자에도 실리지 않는다', () => {
    const l = buildLaunch('Codex', '/srv/agentwbs/cli/codex/current/bin/codex', spec, { env: hostEnv, isolation: iso });
    expect(l.env).toEqual({ PATH: '/usr/bin:/bin' });
    const text = l.args.join('\n');
    for (const value of ['/home/keeproll', 'runner-secret', 'ghp_secret', 'ssh-x', '.nvm']) expect(text).not.toContain(value);
  });

  test('언어 설정 값이 규칙에 맞지 않으면 넘기지 않는다(래퍼가 거부하기 전에 뺀다)', () => {
    const l = buildLaunch('Codex', '/srv/agentwbs/cli/codex/current/bin/codex', spec, { env: { ...hostEnv, LANG: 'x;rm -rf /', LC_ALL: 'C.UTF-8' }, isolation: iso });
    expect(l.args).not.toContain('LANG=x;rm -rf /');
    expect(l.args).toContain('LC_ALL=C.UTF-8');
  });

  test.each([
    ['Runner 홈 안', '/home/keeproll/.agentwbs/worktrees/p1/attempt-1'],
    ['worktrees 자체', '/srv/agentwbs/worktrees'],
    ['이름만 비슷한 이웃 폴더', '/srv/agentwbs/worktrees-evil/p1'],
    ['입력 사본', '/srv/agentwbs/inputs/p1/v1'],
    ['링크로 밖을 가리킴', '/srv/agentwbs/worktrees/p1/escape'],
  ])('작업 폴더가 %s이면 거부', (_name, cwd) => {
    expect(() => buildLaunch('Codex', '/srv/agentwbs/cli/codex/current/bin/codex', { ...spec, cwd }, { env: hostEnv, isolation: iso }))
      .toThrow(expect.objectContaining({ code: 'cwd_outside_agent_root' }));
  });

  test.each([
    ['Runner 홈의 설치본', 'Codex', '/home/keeproll/.agentwbs/cli/codex/current/bin/codex'],
    ['사용자 전역 설치', 'Codex', '/usr/local/bin/codex'],
    ['다른 Agent의 CLI', 'Codex', '/srv/agentwbs/cli/claude/current/bin/claude'],
    ['cli 폴더 밖 이웃', 'Claude', '/srv/agentwbs/cli/claude-evil/bin/claude'],
  ] as const)('CLI가 %s이면 거부', (_name, agent, binary) => {
    expect(() => buildLaunch(agent, binary, { ...spec, model: agent === 'Claude' ? 'claude-opus-5-5' : spec.model }, { env: hostEnv, isolation: iso }))
      .toThrow(expect.objectContaining({ code: 'binary_outside_agent_root' }));
  });

  test('기준 폴더도 실제 경로로 바꿔 비교한다: 작업 영역이 링크면 링크를 따라간 곳 기준(리뷰 P2-3)', () => {
    const moved: Record<string, string> = { ...links, '/srv/agentwbs/worktrees': '/data/agentwbs/worktrees', '/srv/agentwbs/worktrees/p1/attempt-1': '/data/agentwbs/worktrees/p1/attempt-1' };
    const viaLink = dedicatedUserIsolation(cfg, { realpath: (p) => moved[p] ?? p });
    const l = buildLaunch('Codex', '/srv/agentwbs/cli/codex/current/bin/codex', spec, { env: hostEnv, isolation: viaLink });
    expect(l.args).toContain('/data/agentwbs/worktrees/p1/attempt-1');
    // 작업 폴더 문자열은 고정 경로처럼 보여도 실제 경로가 기준 밖이면 거부
    const escaped = dedicatedUserIsolation(cfg, { realpath: (p) => (p === spec.cwd ? '/home/keeproll/x' : moved[p] ?? p) });
    expect(() => buildLaunch('Codex', '/srv/agentwbs/cli/codex/current/bin/codex', spec, { env: hostEnv, isolation: escaped }))
      .toThrow(expect.objectContaining({ code: 'cwd_outside_agent_root' }));
  });

  test('실제 경로를 못 구하면(없는 폴더 등) 거부', () => {
    const missing = dedicatedUserIsolation(cfg, { realpath: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });
    expect(() => buildLaunch('Codex', '/srv/agentwbs/cli/codex/current/bin/codex', spec, { env: hostEnv, isolation: missing }))
      .toThrow(expect.objectContaining({ code: 'cwd_outside_agent_root' }));
  });

  test('관측 등급 조합의 옵션에 전용 계정 권한 모드가 들어간다(격리가 바뀌면 조합도 바뀜)', () => {
    expect(sessionOptions('Codex', iso, 'new')).toBe('exec --json --disable hooks -c approval_policy="never" -c sandbox_mode="workspace-write"');
    expect(sessionOptions('Claude', iso, 'resume')).toBe(`-p --output-format stream-json --verbose --settings {"disableAllHooks":true} ${DEDICATED_FLAGS.Claude.join(' ')} --resume`);
    expect(sessionOptions('Codex', iso, 'new')).not.toBe(sessionOptions('Codex', PENDING_ISOLATION, 'new'));
  });

  test('격리 계층을 넘기지 않으면 지금처럼 실행 계획을 만들지 않는다', () => {
    expect(() => buildLaunch('Codex', '/srv/agentwbs/cli/codex/current/bin/codex', spec, { env: hostEnv })).toThrow(IsolationUndecidedError);
  });
});

describe('agentControl — Agent 계정 프로세스·파일 정리 명령', () => {
  test('kill-group·kill-all·check·fix-perms', () => {
    const head = ['-n', '-u', 'awbs-agent', '--', '/usr/local/libexec/awbs-agent-exec'];
    expect(agentControl(cfg, { kind: 'kill-group', pgid: 4242 })).toEqual({ file: '/usr/bin/sudo', args: [...head, 'kill-group', '4242'], env: { PATH: '/usr/bin:/bin' } });
    expect(agentControl(cfg, { kind: 'kill-all' }).args).toEqual([...head, 'kill-all']);
    expect(agentControl(cfg, { kind: 'check' }).args).toEqual([...head, 'check']);
    expect(agentControl(cfg, { kind: 'fix-perms', path: '/srv/agentwbs/worktrees/p1/attempt-1' }).args).toEqual([...head, 'fix-perms', '/srv/agentwbs/worktrees/p1/attempt-1']);
  });
  test.each([0, 1, -42, 1.5, Number.NaN])('pgid %s는 거부(0·1·음수는 kill에서 「전체」를 뜻함)', (pgid) => {
    expect(() => agentControl(cfg, { kind: 'kill-group', pgid })).toThrow(RangeError);
  });
  test.each(['/srv/agentwbs/worktrees', '/srv/agentwbs/worktrees/../inputs/p1', '/home/keeproll', 'worktrees/p1'])('fix-perms 경로 %s 거부', (path) => {
    expect(() => agentControl(cfg, { kind: 'fix-perms', path })).toThrow(DedicatedUserError);
  });
});

describe('selectIsolation — 준비 점검에서 격리 계층 고르기', () => {
  const env = { AWBS_AGENT_USER: 'awbs-agent' };
  // 래퍼 check는 주어진 출력, scope 시험(probe)은 실제 scope였다면 나왔을 응답.
  const runner = (stdout: string, code: number | null = 0) => vi.fn<RunCommand>(async (cmd, args) => scopeProbeReply(cmd, args) ?? { code, stdout, stderr: '' });

  test('전용 계정 설정이 없으면(테스트·미설치 PC) 거부 유지, 명령도 실행하지 않는다', async () => {
    const run = runner('ok');
    const choice = await selectIsolation({}, run);
    expect(choice.isolation).toBe(PENDING_ISOLATION);
    expect(choice.reason).toContain('AWBS_AGENT_USER');
    expect(run).not.toHaveBeenCalled();
  });

  test('설정 값이 틀리면 거부 유지(입력값은 메시지에 넣지 않음)', async () => {
    const choice = await selectIsolation({ AWBS_AGENT_USER: 'root' }, runner('ok'));
    expect(choice.isolation).toBe(PENDING_ISOLATION);
    expect(choice.reason).not.toContain('root ');
  });

  test('래퍼 점검이 ok면 전용 계정 격리. 점검은 sudo -n으로 Agent 계정에서 돈다', async () => {
    const run = runner('ok\n');
    const choice = await selectIsolation(env, run, { realpath });
    expect(choice.reason).toBeNull();
    expect(choice.isolation.name).toBe('dedicated-user+user-scope');
    expect(run).toHaveBeenCalledWith('/usr/bin/sudo', ['-n', '-u', 'awbs-agent', '--', '/usr/local/libexec/awbs-agent-exec', 'check']);
  });

  test('M8 전 연결: check 다음 사용자 scope를 실제로 한 번 만들어, 그 안의 cgroup 종류·경로가 계산한 값과 같은지 본다(방어 점검 4)', async () => {
    const run = runner('ok\n');
    await selectIsolation(env, run, { realpath });
    const uid = String(process.getuid?.());
    const [cmd, args] = run.mock.calls[1] ?? ['', []];
    expect(cmd).toBe('/usr/bin/env');
    expect(args.slice(0, 10)).toEqual(['-i', 'PATH=/usr/bin:/bin', `XDG_RUNTIME_DIR=/run/user/${uid}`,
      '/usr/bin/systemd-run', '--user', '--scope', '--quiet', '--collect', '--slice=app.slice', expect.stringMatching(/^--unit=awbs-/)]);
    expect(args.slice(10)).toEqual(['--', '/bin/sh', '-c', 'stat -f -c %T /sys/fs/cgroup; cat /proc/self/cgroup']);
  });

  test.each([
    ['cgroup v1·혼합(cgroup2fs 아님)', (path: string) => `tmpfs\n0::${path}\n`],
    ['scope가 다른 위치(경로 다름)', (path: string) => `cgroup2fs\n0::${path.replace('app.slice', 'other.slice')}\n`],
  ] as const)('scope 위치를 확인할 수 없으면 거부 유지: %s', async (_name, reply) => {
    const run = vi.fn<RunCommand>(async (cmd, args) => {
      const ok = scopeProbeReply(cmd, args);
      if (!ok) return { code: 0, stdout: 'ok\n', stderr: '' };
      return { ...ok, stdout: reply(ok.stdout.split('0::')[1]?.trim() ?? '') };
    });
    const choice = await selectIsolation(env, run, { realpath });
    expect(choice.isolation).toBe(PENDING_ISOLATION);
    expect(choice.reason).toContain('cgroup 위치');
  });

  test('M8 전 연결: 사용자 scope를 만들 수 없으면(linger 꺼짐 등) check가 ok여도 거부 유지', async () => {
    const run = vi.fn<RunCommand>(async (cmd) => cmd === '/usr/bin/sudo' ? { code: 0, stdout: 'ok\n', stderr: '' } : { code: 1, stdout: '', stderr: 'Failed to connect to bus' });
    const choice = await selectIsolation(env, run, { realpath });
    expect(choice.isolation).toBe(PENDING_ISOLATION);
    expect(choice.reason).toContain('linger');
    expect(choice.reason).not.toContain('Failed to connect');
  });

  test('M8 전 연결: 고른 계층은 「systemd-run --user --scope -- sudo … 래퍼 run …」이고 CLI 옵션(관측 조합)은 그대로', async () => {
    const choice = await selectIsolation(env, runner('ok\n'), { realpath });
    const plain = buildLaunch('Codex', '/srv/agentwbs/cli/codex/current/bin/codex', spec, { env: hostEnv, isolation: iso });
    const scoped = buildLaunch('Codex', '/srv/agentwbs/cli/codex/current/bin/codex', spec, { env: hostEnv, isolation: choice.isolation });
    expect(scoped.file).toBe('/usr/bin/systemd-run');
    expect(scoped.scope).toMatch(/^awbs-[0-9a-f-]{36}$/);
    expect(scoped.args).toEqual(['--user', '--scope', '--quiet', '--collect', '--slice=app.slice', `--unit=${scoped.scope ?? ''}`, '--', plain.file, ...plain.args]);
    expect(scoped.env).toEqual({ PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: `/run/user/${String(process.getuid?.())}` });
    expect(scoped.stdin).toBe(plain.stdin);
    expect(scoped.cwd).toBe(plain.cwd);
    expect(sessionOptions('Codex', choice.isolation, 'new')).toBe(sessionOptions('Codex', iso, 'new'));
    expect(sessionOptions('Claude', choice.isolation, 'resume')).toBe(sessionOptions('Claude', iso, 'resume'));
    // 실행마다 다른 scope 이름을 쓴다.
    expect(buildLaunch('Codex', '/srv/agentwbs/cli/codex/current/bin/codex', spec, { env: hostEnv, isolation: choice.isolation }).scope).not.toBe(scoped.scope);
  });

  test('점검 실패 항목은 이름만 옮긴다', async () => {
    const choice = await selectIsolation(env, runner('fail mnt_accessible\nfail wsl_interop_accessible\n', 1));
    expect(choice.isolation).toBe(PENDING_ISOLATION);
    expect(choice.reason).toBe('전용 Agent 계정 점검 실패: mnt_accessible, wsl_interop_accessible');
  });

  test.each([
    ['sudoers 규칙 없음(비밀번호 요구)', '', 1],
    ['실행 못 함', '', null],
    ['종료 코드 0이어도 ok가 아니면', 'ok\nextra', 0],
  ] as const)('%s → 거부 유지', async (_name, stdout, code) => {
    const choice = await selectIsolation(env, runner(stdout, code));
    expect(choice.isolation).toBe(PENDING_ISOLATION);
    expect(choice.reason).toContain('점검 실패');
  });
});

describe('agentLoginRun — 로그인 상태만 Agent 계정(래퍼 login-status)으로', () => {
  const calls: [string, readonly string[]][] = [];
  const base: RunCommand = async (cmd, args) => { calls.push([cmd, args]); return { code: 0, stdout: '', stderr: '' }; };
  const run = agentLoginRun(cfg, base, { realpath });
  test('Claude auth status --json, Codex (-c …) login status → sudo 래퍼 login-status(실제 경로)', async () => {
    calls.length = 0;
    await run('/srv/agentwbs/cli/claude/current/bin/claude', ['auth', 'status', '--json']);
    await run('/srv/agentwbs/cli/codex/current/bin/codex', ['-c', 'check_for_update_on_startup=false', 'login', 'status']);
    const head = ['-n', '-u', 'awbs-agent', '--', '/usr/local/libexec/awbs-agent-exec', 'login-status', '--agent'];
    expect(calls).toEqual([
      ['/usr/bin/sudo', [...head, 'claude', '--', CLAUDE_REAL]],
      ['/usr/bin/sudo', [...head, 'codex', '--', CODEX_REAL]],
    ]);
  });
  test('그 밖의 명령(--version, 설치본 밖 CLI의 로그인 질의)은 그대로 Runner 계정에서', async () => {
    calls.length = 0;
    await run('/srv/agentwbs/cli/codex/current/bin/codex', ['--version']);
    await run('/usr/local/bin/claude', ['auth', 'status', '--json']);
    expect(calls).toEqual([
      ['/srv/agentwbs/cli/codex/current/bin/codex', ['--version']],
      ['/usr/local/bin/claude', ['auth', 'status', '--json']],
    ]);
  });
});

describe('조정자 결정 4: 래퍼에 넘기는 CLI는 claude·codex 진입점만', () => {
  test('current 링크는 버전 폴더로 고정하고, 진입점 파일의 링크는 따라가지 않고 그대로 넘긴다', () => {
    expect(cliEntryPoint(cfg, 'Codex', '/srv/agentwbs/cli/codex/current/bin/codex', realpath)).toBe(CODEX_REAL);
    expect(cliEntryPoint(cfg, 'Claude', '/srv/agentwbs/cli/claude/2.1.332/bin/claude', realpath)).toBe(CLAUDE_REAL);
  });
  test.each([
    ['CLI 묶음 안의 bwrap', '/srv/agentwbs/cli/codex/current/lib/node_modules/@openai/codex/vendor/bwrap'],
    ['다른 Agent 진입점', '/srv/agentwbs/cli/claude/current/bin/claude'],
    ['버전이 숫자가 아님', '/srv/agentwbs/cli/codex/latest/bin/codex'],
    ['설치본 밖', '/usr/local/bin/codex'],
  ])('%s → 거부', (_name, file) => {
    expect(cliEntryPoint(cfg, 'Codex', file, realpath)).toBeNull();
    expect(() => buildLaunch('Codex', file, spec, { env: hostEnv, isolation: iso })).toThrow(expect.objectContaining({ code: 'binary_outside_agent_root' }));
  });
  test('진입점 링크가 버전 폴더 밖을 가리키면 거부', () => {
    const evil = (p: string) => p === CODEX_REAL ? '/srv/agentwbs/cli/codex/0.1.0/bin/codex' : realpath(p);
    expect(cliEntryPoint(cfg, 'Codex', '/srv/agentwbs/cli/codex/current/bin/codex', evil)).toBeNull();
  });
});

describe('조정자 결정 1: ①·CI 명령은 래퍼 ci-run으로 Agent 계정에서', () => {
  const launch = { file: 'pnpm', args: ['run', 'test'], env: { PATH: '/home/keeproll/.nvm/bin', CI: '1', LANG: 'C.UTF-8', GH_TOKEN: 'ghp_x' }, cwd: '/srv/agentwbs/worktrees/p1/ci-1', stdin: '' };
  test('sudo -n -u awbs-agent -- 래퍼 ci-run --cwd … --env(허용 이름만) -- 명령', () => {
    const l = iso.command?.(launch);
    expect(l?.file).toBe('/usr/bin/sudo');
    expect(l?.args).toEqual(['-n', '-u', 'awbs-agent', '--', '/usr/local/libexec/awbs-agent-exec', 'ci-run', '--cwd', launch.cwd, '--home', `${launch.cwd}/.awbs-home`, '--env', 'LANG=C.UTF-8', '--env', 'CI=1', '--', 'pnpm', 'run', 'test']);
    expect(l?.env).toEqual({ PATH: '/usr/bin:/bin' });
    expect(l?.args.join(' ')).not.toContain('ghp_x');
  });
  test.each([
    ['작업 폴더가 worktrees 밖', { cwd: '/home/keeproll/project' }, 'cwd_outside_agent_root'],
    ['절대 경로 명령', { file: '/bin/sh' }, 'binary_outside_agent_root'],
    ['작업 폴더 밖 상대 경로', { file: '../../x' }, 'binary_outside_agent_root'],
    ['명령 이름에 공백', { file: 'pnpm test' }, 'binary_outside_agent_root'],
    ['허용 이름의 값에 공백', { env: { CI: 'a b' } }, 'agent_config_invalid'],
  ] as const)('%s → 거부', (_name, over, code) => {
    expect(() => iso.command?.({ ...launch, ...over })).toThrow(expect.objectContaining({ code }));
  });
  test('작업 폴더 안 상대 경로 명령은 받는다', () => {
    expect(iso.command?.({ ...launch, file: './node_modules/.bin/vitest' }).args).toContain('./node_modules/.bin/vitest');
  });
  test('scope 계층은 ci-run도 systemd-run --user --scope로 감싼다. 거부 계층은 명령도 거부', async () => {
    const choice = await selectIsolation({ AWBS_AGENT_USER: 'awbs-agent' }, vi.fn<RunCommand>(async (cmd, args) => scopeProbeReply(cmd, args) ?? { code: 0, stdout: 'ok\n', stderr: '' }), { realpath });
    const l = choice.isolation.command?.(launch);
    expect(l?.file).toBe('/usr/bin/systemd-run');
    expect(l?.scope).toMatch(/^awbs-/);
    expect(l?.args).toContain('ci-run');
    expect(() => PENDING_ISOLATION.command?.(launch)).toThrow(IsolationUndecidedError);
  });
});
