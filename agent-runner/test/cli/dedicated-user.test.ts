import { describe, expect, test, vi } from 'vitest';
import { buildLaunch, sessionOptions, type RunSpec } from '../../src/cli/args.ts';
import {
  agentControl, agentIsolationConfig, DEDICATED_FLAGS, dedicatedUserIsolation, DedicatedUserError, selectIsolation, type DedicatedUserConfig,
} from '../../src/cli/dedicated-user.ts';
import { IsolationUndecidedError, PENDING_ISOLATION } from '../../src/cli/isolation.ts';
import type { RunCommand } from '../../src/readiness/command.ts';

/** 「계정이 있다고 가정한」 설정. 실제 계정·sudo는 쓰지 않는다(명령 구성만 본다). */
const cfg: DedicatedUserConfig = { user: 'awbs-agent', root: '/srv/agentwbs', exec: '/usr/local/libexec/awbs-agent-exec' };
const CODEX_REAL = '/srv/agentwbs/cli/codex/0.172.0/bin/codex';
const CLAUDE_REAL = '/srv/agentwbs/cli/claude/2.1.332/bin/claude';
/** 링크 해석 fake: current 링크는 버전 폴더로, 링크된 작업 폴더는 지정한 곳으로. */
const links: Record<string, string> = {
  '/srv/agentwbs/cli/codex/current/bin/codex': CODEX_REAL,
  '/srv/agentwbs/cli/claude/current/bin/claude': CLAUDE_REAL,
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
  const runner = (stdout: string, code: number | null = 0) => vi.fn<RunCommand>(async () => ({ code, stdout, stderr: '' }));

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
    expect(choice.isolation.name).toBe('dedicated-user');
    expect(run).toHaveBeenCalledWith('/usr/bin/sudo', ['-n', '-u', 'awbs-agent', '--', '/usr/local/libexec/awbs-agent-exec', 'check']);
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
