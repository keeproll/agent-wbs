import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildLaunch } from '../../src/cli/args.ts';
import { agentControl, dedicatedUserIsolation, type DedicatedUserConfig } from '../../src/cli/dedicated-user.ts';

/**
 * 실행 래퍼(scripts/isolation/awbs-agent-exec.sh)를 실제 bash로 돌린다. 실제 계정·sudo는 쓰지 않는다.
 * - 설정 파일 경로만 시험 폴더로 바꾼 사본을 쓰고, 「Agent 계정」은 지금 시험을 돌리는 계정으로 둔다.
 * - sudo 자리에는 fake sudo(인자 모양만 확인하고 환경을 비운 뒤 실행)를 둔다.
 */
const me = userInfo().username;
const usable = /^[a-z_][a-z0-9_-]{0,31}$/.test(me) && spawnSync('bash', ['--version']).status === 0;
const root = realpathSync(mkdtempSync(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'awbs-agent-exec-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const area = join(root, 'srv');
const worktree = join(area, 'worktrees', 'p1', 'attempt-1');
const runnerHome = join(root, 'runner-home');
const out = join(root, 'out.txt');
const exec = join(root, 'awbs-agent-exec');
const conf = join(root, 'agent-exec.conf');
const sudo = join(root, 'fake-sudo');

function writeExec(file: string, body: string) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function setup(): void {
  for (const dir of [worktree, join(area, 'inputs'), join(area, 'cli', 'codex', '1.0.0', 'bin'), join(area, 'cli', 'claude', '2.0.0', 'bin'), join(area, 'runtime', 'node', 'bin'), runnerHome]) {
    mkdirSync(dir, { recursive: true });
  }
  symlinkSync('1.0.0', join(area, 'cli', 'codex', 'current'));
  symlinkSync(process.execPath, join(area, 'runtime', 'node', 'bin', 'node'));
  symlinkSync(runnerHome, join(area, 'worktrees', 'p1', 'escape'));
  // fake CLI: 받은 것(현재 폴더·인자·환경·표준 입력)을 그대로 파일에 적는다.
  const fakeCli = `#!/bin/bash\n{ printf 'cwd=%s\\n' "$PWD"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; env | sort | sed 's/^/env=/'; printf 'stdin=%s\\n' "$(cat)"; } > '${out}'\n`;
  writeExec(join(area, 'cli', 'codex', '1.0.0', 'bin', 'codex'), fakeCli);
  writeExec(join(area, 'cli', 'claude', '2.0.0', 'bin', 'claude'), fakeCli);
  writeExec(join(root, 'outside-cli'), fakeCli);
  // 진입점이 아닌 실행 파일·바꿔치기 모양(조정자 결정 4 재현)
  mkdirSync(join(area, 'cli', 'codex', '1.0.0', 'vendor'), { recursive: true });
  writeExec(join(area, 'cli', 'codex', '1.0.0', 'vendor', 'bwrap'), fakeCli);
  symlinkSync('1.0.0', join(area, 'cli', 'codex', '9.9.9'));
  mkdirSync(join(area, 'cli', 'codex', '1.0.1', 'bin'), { recursive: true });
  symlinkSync(join(area, 'cli', 'codex', '1.0.0', 'bin', 'codex'), join(area, 'cli', 'codex', '1.0.1', 'bin', 'codex'));
  mkdirSync(join(area, 'cli', 'codex', 'evil', 'bin'), { recursive: true });
  writeExec(join(area, 'cli', 'codex', 'evil', 'bin', 'codex'), fakeCli);
  // ci-run용 작업 폴더 안 도구와 고정 PATH의 pnpm
  mkdirSync(join(worktree, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(worktree, '.awbs-home'), { recursive: true });
  writeExec(join(worktree, 'node_modules', '.bin', 'tool'), fakeCli);
  mkdirSync(join(area, 'cli', 'pnpm', '1.0.0', 'bin'), { recursive: true });
  writeExec(join(area, 'cli', 'pnpm', '1.0.0', 'bin', 'pnpm'), fakeCli);
  symlinkSync('1.0.0', join(area, 'cli', 'pnpm', 'current'));
  writeConf(conf, { AGENT_USER: me });
  const original = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'isolation', 'awbs-agent-exec.sh'), 'utf8');
  expect(original).toContain('\nCONF=/etc/agentwbs/agent-exec.conf\n');
  writeExec(exec, original.replace('\nCONF=/etc/agentwbs/agent-exec.conf\n', `\nCONF=${conf}\n`));
  // fake sudo: Runner가 만든 모양(-n -u <계정> --)만 받고, sudo의 env_reset처럼 환경을 모두 비운 뒤 실행한다.
  writeExec(sudo, `#!/bin/bash\n[[ $1 == -n && $2 == -u && $4 == -- ]] || { echo bad-sudo-args >&2; exit 9; }\nshift 4\nexec env -i "$@"\n`);
}

/** 저장소의 래퍼 원본 내용. */
function original(): string {
  return readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'isolation', 'awbs-agent-exec.sh'), 'utf8');
}

function writeConf(file: string, over: Record<string, string>): void {
  const values = { AGENT_USER: me, RUNNER_USER: 'keeproll', RUNNER_HOME: runnerHome, AGENT_ROOT: area, NODE_DIR: join(area, 'runtime', 'node', 'bin'), ...over };
  writeFileSync(file, `# 시험 설정\n${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
}

/** lockedCwd: 그 폴더로 들어간 뒤 권한을 000으로 바꾸고 래퍼를 부른다(들어갈 수 없는 현재 폴더를 물려받은 상황). */
function wrapper(args: string[], input = '', file = exec, path = '/usr/bin:/bin', lockedCwd?: string) {
  const [cmd, argv] = lockedCwd ? ['/bin/bash', ['-c', 'cd -- "$1" && chmod 000 . && shift && exec "$@"', '_', lockedCwd, file, ...args]] as const : [file, args] as const;
  const r = spawnSync(cmd, argv, { input, encoding: 'utf8', env: { PATH: path, AWBS_RUNNER_TOKEN: 'runner-secret', HOME: runnerHome } });
  if (lockedCwd) chmodSync(lockedCwd, 0o755);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function recorded(): { cwd: string; args: string[]; env: Record<string, string>; stdin: string } {
  const lines = readFileSync(out, 'utf8').split('\n');
  const pick = (p: string) => lines.filter((l) => l.startsWith(p)).map((l) => l.slice(p.length));
  const env = Object.fromEntries(pick('env=').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { cwd: pick('cwd=')[0] ?? '', args: pick('arg='), env, stdin: pick('stdin=').join('\n') };
}

/** 진입점은 버전 폴더의 bin/<agent>다. current 링크는 Runner가 실행 시점의 버전으로 바꿔 넘긴다(조정자 결정 4). */
const codex = join(area, 'cli', 'codex', '1.0.0', 'bin', 'codex');
const runArgs = (over: { agent?: string; cwd?: string; bin?: string; env?: string[] } = {}) => [
  'run', '--agent', over.agent ?? 'codex', '--cwd', over.cwd ?? worktree, ...(over.env ?? []).flatMap((e) => ['--env', e]), '--', over.bin ?? codex, 'exec', '--json', '-',
];

describe.skipIf(!usable)('awbs-agent-exec 실행 래퍼(bash, 실제 실행)', () => {
  let home = '';
  beforeAll(() => {
    setup();
    home = spawnSync('getent', ['passwd', me], { encoding: 'utf8' }).stdout.split(':')[5] ?? '';
  });

  test('run: 작업 폴더에서, 받은 인자·표준 입력 그대로, 환경은 새로 만든 값만', () => {
    rmSync(out, { force: true });
    const r = wrapper(runArgs({ env: ['LANG=ko_KR.UTF-8'] }), '지시문 한 줄');
    expect(r).toMatchObject({ code: 0, stderr: '' });
    const got = recorded();
    expect(got.cwd).toBe(worktree);
    expect(got.args).toEqual(['exec', '--json', '-']);
    expect(got.stdin).toBe('지시문 한 줄');
    expect(Object.keys(got.env).filter((k) => k !== 'PWD' && k !== 'SHLVL' && k !== '_').sort()).toEqual(
      ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'TMPDIR', 'USER'],
    );
    expect(got.env).toMatchObject({ HOME: home, USER: me, TMPDIR: `${home}/tmp`, LANG: 'ko_KR.UTF-8', PATH: `${join(area, 'runtime', 'node', 'bin')}:${join(area, 'cli', 'pnpm', 'current', 'bin')}:/usr/local/bin:/usr/bin:/bin` });
    expect(got.env.AWBS_RUNNER_TOKEN).toBeUndefined();
  });

  test.each([
    ['작업 폴더가 worktrees 밖', { cwd: join(area, 'inputs') }, '작업 폴더'],
    ['작업 폴더가 worktrees 자체', { cwd: join(area, 'worktrees') }, '작업 폴더'],
    ['작업 폴더 링크가 Runner 홈을 가리킴', { cwd: join(area, 'worktrees', 'p1', 'escape') }, '작업 폴더'],
    ['CLI가 설치본 밖', { bin: join(root, 'outside-cli') }, 'CLI'],
    ['current 링크 경로(버전으로 바꾸지 않음)', { bin: join(area, 'cli', 'codex', 'current', 'bin', 'codex') }, '진입점'],
    ['CLI 묶음 안의 다른 실행 파일(bwrap 등)', { bin: join(area, 'cli', 'codex', '1.0.0', 'vendor', 'bwrap') }, '진입점'],
    ['링크로 만든 버전 폴더', { bin: join(area, 'cli', 'codex', '9.9.9', 'bin', 'codex') }, '진입점'],
    ['진입점 링크가 버전 폴더 밖을 가리킴', { bin: join(area, 'cli', 'codex', '1.0.1', 'bin', 'codex') }, '진입점'],
    ['버전이 숫자.숫자.숫자가 아님', { bin: join(area, 'cli', 'codex', 'evil', 'bin', 'codex') }, '진입점'],
    ['다른 Agent의 CLI', { agent: 'claude' }, 'CLI'],
    ['모르는 Agent', { agent: 'bash' }, '--agent'],
    ['토큰 환경 변수', { env: ['GH_TOKEN=ghp_x'] }, '허용하지 않는 환경 변수'],
    ['언어 값에 명령', { env: ['LANG=$(id)'] }, '허용하지 않는 환경 변수'],
  ])('run 거부: %s', (_name, over, message) => {
    rmSync(out, { force: true });
    const r = wrapper(runArgs(over));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(message);
    expect(existsSync(out)).toBe(false);
  });

  test('Agent 계정이 아닌 계정으로 부르면 거부(종료 코드 3)', () => {
    const other = join(root, 'other.conf');
    writeConf(other, { AGENT_USER: 'awbs-agent-not-me' });
    const file = join(root, 'exec-other');
    writeExec(file, readFileSync(exec, 'utf8').replace(`\nCONF=${conf}\n`, `\nCONF=${other}\n`));
    const r = wrapper(runArgs(), '', file);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Agent 계정');
  });

  test('설정 파일은 실행하지 않는다: 모르는 이름·명령이 든 값은 거부', () => {
    for (const [name, line] of [['unknown', 'EVIL=1'], ['inject', `AGENT_ROOT=$(touch ${join(root, 'pwned')})`]] as const) {
      const bad = join(root, `${name}.conf`);
      writeConf(bad, {});
      writeFileSync(bad, `${readFileSync(bad, 'utf8')}${line}\n`);
      const file = join(root, `exec-${name}`);
      writeExec(file, readFileSync(exec, 'utf8').replace(`\nCONF=${conf}\n`, `\nCONF=${bad}\n`));
      expect(wrapper(['check'], '', file).code).toBe(2);
    }
    expect(existsSync(join(root, 'pwned'))).toBe(false);
  });

  test('kill-group: 그 프로세스 그룹을 강제 종료하고, 없으면 none', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const exited = new Promise<string | null>((resolve) => child.on('exit', (_code, signal) => resolve(signal)));
    const pgid = child.pid ?? 0;
    expect(pgid).toBeGreaterThan(1);
    expect(wrapper(['kill-group', String(pgid)]).stdout.trim()).toBe('killed');
    expect(await exited).toBe('SIGKILL');
    expect(wrapper(['kill-group', String(pgid)]).stdout.trim()).toBe('none');
    for (const bad of ['0', '-1', '1x', '']) expect(wrapper(['kill-group', bad]).code).toBe(2);
  });

  test('check: Runner 홈에 들어갈 수 있으면 fail 항목을 내고 1로 끝난다', () => {
    const r = wrapper(['check']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('fail runner_home_accessible');
    expect(r.stdout).not.toMatch(/^ok$/m);
  });

  test('login-status: 정해진 인자로 Agent 계정 환경에서 CLI를 부르고, 설치본 밖·다른 Agent CLI는 거부', () => {
    rmSync(out, { force: true });
    let r = wrapper(['login-status', '--agent', 'codex', '--', codex]);
    expect(r.code, r.stderr).toBe(0);
    let got = recorded();
    expect(got.args).toEqual(['-c', 'check_for_update_on_startup=false', 'login', 'status']);
    expect(got.env.HOME).toBe(home);
    expect(got.env.AWBS_RUNNER_TOKEN).toBeUndefined();
    rmSync(out, { force: true });
    r = wrapper(['login-status', '--agent', 'claude', '--', codex]);
    expect(r.code).toBe(2);
    r = wrapper(['login-status', '--agent', 'codex', '--', join(root, 'outside-cli')]);
    expect(r.code).toBe(2);
    r = wrapper(['login-status', '--agent', 'codex', '--', codex, 'extra']);
    expect(r.code).toBe(2);
    expect(existsSync(out)).toBe(false);
    symlinkSync('2.0.0', join(area, 'cli', 'claude', 'current'));
    // current 링크 경로는 받지 않는다. 버전 폴더의 진입점만.
    r = wrapper(['login-status', '--agent', 'claude', '--', join(area, 'cli', 'claude', 'current', 'bin', 'claude')]);
    expect(r.code).toBe(2);
    r = wrapper(['login-status', '--agent', 'claude', '--', join(area, 'cli', 'claude', '2.0.0', 'bin', 'claude')]);
    expect(r.code).toBe(0);
    got = recorded();
    expect(got.args).toEqual(['auth', 'status', '--json']);
  });

  test('ci-run: 고정 PATH의 명령을 작업 폴더에서, 허용 환경만 새로 만들어 실행한다', () => {
    rmSync(out, { force: true });
    const ciHome = join(worktree, '.awbs-home');
    let r = wrapper(['ci-run', '--cwd', worktree, '--home', ciHome, '--env', 'CI=1', '--env', 'NODE_ENV=test', '--', 'pnpm', 'run', 'test'], '');
    expect(r, r.stderr).toMatchObject({ code: 0, stderr: '' });
    let got = recorded();
    expect(got.cwd).toBe(worktree);
    expect(got.args).toEqual(['run', 'test']);
    // 실행마다 새 HOME·TMPDIR(조정자 결정 8): Agent 계정 공용 HOME이 아니라 검사 사본 안.
    expect(got.env).toMatchObject({ CI: '1', NODE_ENV: 'test', HOME: ciHome, TMPDIR: join(ciHome, 'tmp'), USER: me });
    expect(got.env.HOME).not.toBe(home);
    expect(got.env.AWBS_RUNNER_TOKEN).toBeUndefined();
    rmSync(out, { force: true });
    r = wrapper(['ci-run', '--cwd', worktree, '--home', ciHome, '--', './node_modules/.bin/tool', 'list']);
    expect(r.code, r.stderr).toBe(0);
    got = recorded();
    expect(got.args).toEqual(['list']);
  });

  test.each([
    ['작업 폴더가 worktrees 밖', ['--cwd', join(area, 'inputs'), '--', 'pnpm'], '작업 폴더'],
    ['작업 폴더 링크가 Runner 홈', ['--cwd', join(area, 'worktrees', 'p1', 'escape'), '--', 'pnpm'], '작업 폴더'],
    ['경로 명령이 작업 폴더 밖', ['--cwd', worktree, '--', join(root, 'outside-cli')], '작업 폴더 안'],
    ['경로 명령이 링크로 밖을 가리킴', ['--cwd', worktree, '--', '../escape/x'], '작업 폴더 안'],
    ['고정 PATH에 없는 이름', ['--cwd', worktree, '--', 'no-such-tool-x'], 'PATH'],
    ['토큰 환경 변수', ['--cwd', worktree, '--env', 'GH_TOKEN=ghp_x', '--', 'pnpm'], '허용하지 않는 환경 변수'],
    ['환경 값에 공백', ['--cwd', worktree, '--env', 'CI=1 2', '--', 'pnpm'], '허용하지 않는 환경 변수'],
    ['명령 없음', ['--cwd', worktree, '--'], '명령'],
    ['--home 없음', ['--cwd', worktree, '--', 'pnpm'], '--home'],
    ['--home이 다른 곳', ['--cwd', worktree, '--home', join(area, 'inputs'), '--', 'pnpm'], '--home'],
  ])('ci-run 거부: %s', (_name, args, message) => {
    rmSync(out, { force: true });
    const withHome = args.includes('--home') || message === '--home' ? args : [args[0] ?? '', args[1] ?? '', '--home', `${args[1] ?? ''}/.awbs-home`, ...args.slice(2)];
    const r = wrapper(['ci-run', ...withHome]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(message);
    expect(existsSync(out)).toBe(false);
  });

  test('git-inspect·git-bundle: Agent 계정 git으로 HEAD·상태·bundle만 낸다(조정자 결정 6)', () => {
    const repo = join(area, 'worktrees', 'p1', 'git-1');
    mkdirSync(repo, { recursive: true });
    const g = (...a: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@x', ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'agent/x'); writeFileSync(join(repo, 'a'), 'a'); g('add', 'a'); g('commit', '-qm', 'a');
    const head = g('rev-parse', 'HEAD').stdout.trim();
    const r = wrapper(['git-inspect', '--cwd', repo]);
    expect(r, r.stderr).toMatchObject({ code: 0, stdout: `head ${head}\ndirty 0\n` });
    writeFileSync(join(repo, 'b'), 'untracked');
    expect(wrapper(['git-inspect', '--cwd', repo]).stdout).toContain('dirty 1');
    rmSync(join(repo, 'b'));
    g('update-index', '--assume-unchanged', 'a');
    expect(wrapper(['git-inspect', '--cwd', repo]).stdout).toContain('dirty 1');
    g('update-index', '--no-assume-unchanged', 'a');
    const b = spawnSync(exec, ['git-bundle', '--cwd', repo, '--branch', 'agent/x'], { env: { PATH: '/usr/bin:/bin' } });
    expect(b.status, b.stderr.toString()).toBe(0);
    expect(b.stdout.subarray(0, 20).toString()).toMatch(/^# v[23] git bundle/);
    for (const bad of [['--cwd', repo, '--branch', '../x'], ['--cwd', join(area, 'inputs'), '--branch', 'agent/x'], ['--cwd', repo, '--branch', '-x']]) {
      expect(wrapper(['git-bundle', ...bad]).code).toBe(2);
    }
    expect(wrapper(['git-inspect', '--cwd', runnerHome]).code).toBe(2);
  });

  test('git-inspect: 추적 안 된 파일은 커밋된 .gitignore로만 무시한다(Agent가 바꾼 무시 설정으로 숨길 수 없음, collect-prepare)', () => {
    const repo = join(area, 'worktrees', 'p1', 'git-hide');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    const g = (...a: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@x', ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'agent/x');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n*.log\n!keep.log\n');
    writeFileSync(join(repo, 'sub', '.gitignore'), 'gen/\n');
    writeFileSync(join(repo, 'a'), 'a');
    g('add', '-A'); g('commit', '-qm', 'a');
    const dirty = () => wrapper(['git-inspect', '--cwd', repo]).stdout.split('\n')[1];
    expect(dirty()).toBe('dirty 0');
    // 커밋된 규칙으로 무시되는 것·Runner가 정한 폴더는 깨끗하다고 본다.
    for (const path of ['node_modules/x/y.js', 'build.log', 'sub/gen/z.txt', '.awbs-evidence/e.png', '.awbs-home/tmp/t']) {
      mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), 'x');
    }
    expect(dirty()).toBe('dirty 0');
    // 숨긴 파일 재현: 남긴 파일을 Agent가 바꿀 수 있는 무시 설정으로 숨겨도 더럽다고 본다.
    const hidden = (setup: () => void, undo: () => void) => {
      writeFileSync(join(repo, 'secret.txt'), '남긴 파일');
      setup();
      expect(g('status', '--porcelain').stdout, '보통 git status는 숨긴다').not.toContain('secret.txt');
      expect(dirty()).toBe('dirty 1');
      undo(); rmSync(join(repo, 'secret.txt'));
    };
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    hidden(() => writeFileSync(join(repo, '.git', 'info', 'exclude'), 'secret.txt\n'), () => writeFileSync(join(repo, '.git', 'info', 'exclude'), ''));
    hidden(() => { writeFileSync(join(repo, 'secret-rules'), 'secret.txt\nsecret-rules\n'); g('config', 'core.excludesFile', join(repo, 'secret-rules')); },
      () => { g('config', '--unset', 'core.excludesFile'); rmSync(join(repo, 'secret-rules')); });
    // 새 하위 .gitignore(커밋 안 됨)로 숨기기: `*`는 그 .gitignore 자신과 안의 파일을 모두 git status에서 숨긴다. 커밋된 규칙이 아니므로 남은 파일이다.
    mkdirSync(join(repo, 'hide'), { recursive: true });
    writeFileSync(join(repo, 'hide', '.gitignore'), '*\n'); writeFileSync(join(repo, 'hide', 'x'), 'x');
    expect(g('status', '--porcelain').stdout, '보통 git status는 숨긴다').not.toContain('hide/');
    expect(dirty()).toBe('dirty 1');
    rmSync(join(repo, 'hide'), { recursive: true });
    expect(dirty()).toBe('dirty 0');
    // 부정 규칙(!keep.log)은 무시하지 않는다.
    writeFileSync(join(repo, 'keep.log'), 'x');
    expect(dirty()).toBe('dirty 1');
    rmSync(join(repo, 'keep.log'));
    // 커밋된 .gitignore를 고치지 않고(작업 폴더에서만) 바꾸면 그 자체가 추적 파일 변경이다.
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n*.log\n!keep.log\nsecret.txt\n');
    writeFileSync(join(repo, 'secret.txt'), 'x');
    expect(dirty()).toBe('dirty 1');
  });

  test('agent-file: 하위 Agent 정의만 Agent 계정으로 읽기·쓰기·지우기(fix2 추가)', () => {
    const file = (args: string[], input?: string) => spawnSync(exec, ['agent-file', ...args], { input, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    const rel = '.codex/agents/code-reviewer.toml';
    expect(file(['read', '--cwd', worktree, '--path', rel]).status).toBe(3);
    expect(file(['write', '--cwd', worktree, '--path', rel], 'name = "x"\n').status).toBe(0);
    expect(readFileSync(join(worktree, rel), 'utf8')).toBe('name = "x"\n');
    expect(file(['read', '--cwd', worktree, '--path', rel]).stdout).toBe('name = "x"\n');
    expect(file(['remove', '--cwd', worktree, '--path', rel]).status).toBe(0);
    expect(existsSync(join(worktree, rel))).toBe(false);
    for (const bad of [['read', '--cwd', worktree, '--path', '../x/.codex/agents/a.toml'], ['write', '--cwd', worktree, '--path', '.codex/agents/../../a.toml'],
      ['write', '--cwd', worktree, '--path', '.git/config'], ['read', '--cwd', join(area, 'inputs'), '--path', rel], ['chmod', '--cwd', worktree, '--path', rel]]) {
      expect(file(bad, 'x').status, bad.join(' ')).toBe(2);
    }
    expect(file(['write', '--cwd', worktree, '--path', rel], 'x'.repeat(1024 * 1024 + 1)).status).toBe(2);
  });

  test('evidence-read: .awbs-evidence 안의 일반 파일만 Agent 계정으로 읽어 그대로 낸다(collect-prepare)', () => {
    const read = (args: string[]) => spawnSync(exec, ['evidence-read', ...args], { env: { PATH: '/usr/bin:/bin' } });
    const dir = join(worktree, '.awbs-evidence');
    expect(read(['--cwd', worktree, '--name', 'unit.log']).status).toBe(3);
    mkdirSync(dir, { recursive: true });
    expect(read(['--cwd', worktree, '--name', 'unit.log']).status).toBe(3);
    const bytes = Buffer.from([0, 1, 2, 255, 10]);
    writeFileSync(join(dir, 'shot.png'), bytes);
    const ok = read(['--cwd', worktree, '--name', 'shot.png']);
    expect(ok.status, ok.stderr.toString()).toBe(0);
    expect(Buffer.compare(ok.stdout, bytes)).toBe(0);
    // 링크(Runner 파일을 가리키게 바꾼 것)·하위 경로·숨김 이름·작업 영역 밖은 거부한다.
    writeFileSync(join(runnerHome, 'token'), 'secret');
    symlinkSync(join(runnerHome, 'token'), join(dir, 'leak.txt'));
    expect(read(['--cwd', worktree, '--name', 'leak.txt']).status).toBe(2);
    for (const bad of [['--cwd', worktree, '--name', '../a'], ['--cwd', worktree, '--name', '.hidden'], ['--cwd', worktree, '--name', 'a/b'], ['--cwd', runnerHome, '--name', 'token']]) {
      expect(read(bad).status, bad.join(' ')).toBe(2);
    }
    rmSync(dir, { recursive: true });
    symlinkSync(runnerHome, dir);
    expect(read(['--cwd', worktree, '--name', 'token']).status).toBe(3);
    rmSync(dir);
  });

  test('래퍼 자신의 git은 -c safe.directory=<그 폴더 실제 경로>만 쓰고 전역 설정을 쓰지 않는다(fix3)', () => {
    const text = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'isolation', 'awbs-agent-exec.sh'), 'utf8');
    expect(text.match(/safe\.directory/g)?.length).toBeGreaterThan(0);
    expect(text).toContain('git -C "$dir" -c safe.directory="$dir"');
    expect(text).not.toMatch(/GIT_CONFIG_(COUNT|KEY|VALUE)/);
    expect(text).not.toMatch(/config --global/);
  });

  test('cli-version: 진입점 규칙으로 Agent 계정에서 --version만', () => {
    rmSync(out, { force: true });
    const r = wrapper(['cli-version', '--tool', 'codex', '--', codex]);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded().args).toEqual(['--version']);
    expect(wrapper(['cli-version', '--tool', 'codex', '--', join(area, 'cli', 'codex', '1.0.0', 'vendor', 'bwrap')]).code).toBe(2);
    expect(wrapper(['cli-version', '--tool', 'sh', '--', codex]).code).toBe(2);
  });

  test('모르는 하위 명령은 거부', () => {
    expect(wrapper(['sh', '-c', 'id']).code).toBe(2);
  });

  test('Runner 실행 계획 → fake sudo → 래퍼 → CLI: 인자·표준 입력이 그대로 닿고 Runner 환경은 남지 않는다', async () => {
    rmSync(out, { force: true });
    const cfg: DedicatedUserConfig = { user: me, root: area, exec, sudo };
    const l = buildLaunch('Codex', codex, { model: 'gpt-6.2-sol', effort: 'high', cwd: worktree, prompt: 'TASK-0001 지시문' }, {
      env: { PATH: process.env.PATH, HOME: runnerHome, LANG: 'C.UTF-8', AWBS_RUNNER_TOKEN: 'runner-secret', GH_TOKEN: 'ghp_x', CODEX_HOME: join(runnerHome, '.codex') },
      isolation: dedicatedUserIsolation(cfg),
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(l.file, l.args, { cwd: l.cwd, env: l.env, stdio: ['pipe', 'ignore', 'inherit'] });
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end(l.stdin);
    });
    expect(code).toBe(0);
    const got = recorded();
    const cliArgs = l.args.slice(l.args.lastIndexOf('--') + 2);
    expect(got.args).toEqual(cliArgs);
    expect(got.args).toContain('sandbox_mode="workspace-write"');
    expect(got.stdin).toBe('TASK-0001 지시문');
    expect(got.cwd).toBe(worktree);
    expect(got.env.HOME).toBe(home);
    for (const name of ['AWBS_RUNNER_TOKEN', 'GH_TOKEN', 'CODEX_HOME']) expect(got.env[name]).toBeUndefined();
  });

  test('정리 명령(agentControl)도 같은 fake sudo → 래퍼 경로로 돈다', () => {
    const c = agentControl({ user: me, root: area, exec, sudo }, { kind: 'kill-group', pgid: 2 ** 22 + 12345 });
    const r = spawnSync(c.file, c.args, { env: c.env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('none');
  });

  /** 폴더 트리를 읽기 전용으로 바꿔 시험하고 끝나면 되돌린다(정리를 위해). */
  function readonlyTree(dir: string, body: () => void): void {
    const set = (mode: string) => spawnSync('chmod', ['-R', mode, dir]);
    set('a-w');
    try {
      body();
    } finally {
      set('u+w');
    }
  }

  test('check: CLI·입력 자료는 맨 위가 아니라 안쪽 파일까지 쓸 수 없어야 한다(리뷰 P2-7)', () => {
    const cliFile = join(area, 'cli', 'codex', '1.0.0', 'bin', 'codex');
    const input = join(area, 'inputs', 'p1', 'v1', 'spec.md');
    mkdirSync(join(area, 'inputs', 'p1', 'v1'), { recursive: true });
    writeFileSync(input, '입력');
    readonlyTree(join(area, 'cli'), () => readonlyTree(join(area, 'inputs'), () => {
      let r = wrapper(['check']);
      expect(r.stdout).not.toContain('fail cli_writable');
      expect(r.stdout).not.toContain('fail inputs_writable');
      // 맨 위 폴더는 그대로 읽기 전용이고, 안쪽 파일 하나만 쓸 수 있게 한다.
      chmodSync(cliFile, 0o755);
      chmodSync(input, 0o644);
      r = wrapper(['check']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('fail cli_writable');
      expect(r.stdout).toContain('fail inputs_writable');
      chmodSync(cliFile, 0o555);
      chmodSync(input, 0o444);
    }));
  });

  test('check: 안쪽 폴더를 읽지 못해 다 확인하지 못하면 fail(확인 못 함)', () => {
    const hidden = join(area, 'cli', 'claude', 'hidden');
    mkdirSync(hidden, { recursive: true });
    // 쓸 수 있는 곳이 먼저 보이면 그 결과(cli_writable)가 나오므로, 나머지는 읽기 전용으로 두고 숨은 폴더만 못 읽게 한다.
    readonlyTree(join(area, 'cli'), () => {
      chmodSync(hidden, 0o000);
      try {
        const r = wrapper(['check']);
        expect(r.code).toBe(1);
        expect(r.stdout).toContain('fail cli_unverified');
        expect(r.stdout).not.toContain('fail cli_writable');
      } finally {
        chmodSync(hidden, 0o555);
      }
    });
    rmSync(hidden, { recursive: true });
  });

  // owner 설치 1차 실패 재현: sudo는 부른 쪽의 현재 폴더(Runner 홈)를 물려준다. Agent는 거기 못 들어가므로
  // GNU find가 「처음 폴더로 돌아갈 수 없음」으로 실패해 cli_unverified·inputs_unverified가 났다. 래퍼는 먼저 /로 옮긴다.
  test('check·fix-perms: 들어갈 수 없는 현재 폴더에서 불러도 확인을 끝낸다(cwd를 /로 옮김)', () => {
    const noEntry = join(root, 'no-entry-cwd');
    mkdirSync(noEntry, { recursive: true });
    readonlyTree(join(area, 'cli'), () => readonlyTree(join(area, 'inputs'), () => {
      const r = wrapper(['check'], '', exec, '/usr/bin:/bin', noEntry);
      expect(r.stderr).not.toContain('Failed to restore');
      expect(r.stdout).toContain('fail runner_home_accessible');
      expect(r.stdout).not.toMatch(/fail (cli|inputs)_(unverified|writable)/);
    }));
    const sub = join(worktree, 'perm-from-locked-cwd');
    mkdirSync(sub, { recursive: true });
    const fakeBin = join(root, 'fake-acl-cwd');
    mkdirSync(fakeBin, { recursive: true });
    writeExec(join(fakeBin, 'setfacl'), '#!/bin/bash\nexit 0\n');
    const r = wrapper(['fix-perms', sub], '', exec, `${fakeBin}:/usr/bin:/bin`, noEntry);
    expect(r).toMatchObject({ code: 0, stdout: 'fixed\n' });
    rmSync(sub, { recursive: true });
  });

  // 런북 순서: setup(래퍼 check) → CLI 설치. 그래서 check는 빈 cli·inputs를 정상으로 본다(「Agent가 쓸 수 없음」만 본다).
  // CLI가 있는지는 확인 스크립트 7단계와 Runner 준비 점검이 따로 본다.
  test('check: CLI 설치 전(빈 cli·inputs)이어도 cli·inputs 항목은 fail이 아니다', () => {
    const empty = join(root, 'empty-area');
    for (const d of ['cli', 'inputs', 'worktrees']) mkdirSync(join(empty, d), { recursive: true });
    mkdirSync(join(empty, 'runtime', 'node', 'bin'), { recursive: true });
    symlinkSync(process.execPath, join(empty, 'runtime', 'node', 'bin', 'node'));
    const c = join(root, 'empty.conf');
    writeConf(c, { AGENT_ROOT: empty, NODE_DIR: join(empty, 'runtime', 'node', 'bin') });
    const file = join(root, 'exec-empty');
    writeExec(file, readFileSync(exec, 'utf8').replace(`\nCONF=${conf}\n`, `\nCONF=${c}\n`));
    chmodSync(join(empty, 'cli'), 0o555);
    chmodSync(join(empty, 'inputs'), 0o555);
    try {
      const r = wrapper(['check'], '', file);
      expect(r.stdout).not.toMatch(/fail (cli|inputs)_/);
      expect(r.stdout).not.toContain('fail node_missing');
    } finally {
      chmodSync(join(empty, 'cli'), 0o755);
      chmodSync(join(empty, 'inputs'), 0o755);
    }
  });

  // fix7: WSL 링크(/etc/resolv.conf → /mnt/wsl/...)가 그대로면 /mnt가 막힌 Agent는 DNS 설정을 못 읽는다.
  test('check: DNS 설정 파일을 읽을 수 없으면 fail resolv_unreadable, 읽을 수 있으면 그 항목 없음', () => {
    expect(original()).toContain(`[[ -e /etc/resolv.conf || -L /etc/resolv.conf ]] && [[ ! -r /etc/resolv.conf ]]`);
    expect(wrapper(['check']).stdout).not.toContain('resolv_unreadable');
    const locked = join(root, 'locked-mnt');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'resolv.conf'), 'nameserver 10.255.255.254\n');
    const link = join(root, 'resolv-link.conf');
    symlinkSync(join(locked, 'resolv.conf'), link);
    const file = join(root, 'exec-resolv');
    writeExec(file, readFileSync(exec, 'utf8').replaceAll('/etc/resolv.conf', link));
    chmodSync(locked, 0o000);
    try {
      const r = wrapper(['check'], '', file);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('fail resolv_unreadable');
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test('check: Windows 경로는 목록 읽기와 지나가기를 따로 보고, /Docker도 본다', () => {
    const r = wrapper(['check']);
    // 이 시험 계정은 /mnt에 들어갈 수 있다(격리 안 된 계정). 그래서 반드시 fail이 나와야 한다.
    if (existsSync('/mnt')) expect(r.stdout).toContain('fail mnt_accessible');
    if (existsSync('/Docker')) expect(r.stdout).toContain('fail docker_mount_accessible');
  });

  test('설정 값이 같은 곳의 다른 표기(//, 끝 /)면 거부(리뷰 P2-3)', () => {
    for (const [name, value] of [['dslash', `${area.replace('/srv', '//srv')}`], ['trail', `${area}/`]] as const) {
      const bad = join(root, `${name}.conf`);
      writeConf(bad, { AGENT_ROOT: value });
      const file = join(root, `exec-${name}`);
      writeExec(file, readFileSync(exec, 'utf8').replace(`\nCONF=${conf}\n`, `\nCONF=${bad}\n`));
      const r = wrapper(['check'], '', file);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('AGENT_ROOT');
    }
  });

  describe('fix-perms: 권한 000인 중첩 폴더도 한 번에 되돌린다(리뷰 P2-8)', () => {
    const fakeBin = join(root, 'fake-acl-bin');
    const locked = join(worktree, 'nested-locked');
    beforeAll(() => {
      mkdirSync(fakeBin, { recursive: true });
      // setfacl 자리: 받은 인자를 적기만 한다(이 PC에 acl 패키지가 없어도 시험). 실패 주입은 FAIL_SETFACL 파일로.
      writeExec(join(fakeBin, 'setfacl'), `#!/bin/bash\n[[ -e '${join(root, 'FAIL_SETFACL')}' ]] && exit 1\nprintf '%s\\n' "$*" >> '${join(root, 'setfacl.log')}'\n`);
    });
    const lockUp = () => {
      mkdirSync(join(locked, 'inner'), { recursive: true });
      writeFileSync(join(locked, 'inner', 'file'), 'x');
      chmodSync(join(locked, 'inner', 'file'), 0o000);
      chmodSync(join(locked, 'inner'), 0o000);
      chmodSync(locked, 0o000);
    };
    const unlock = () => spawnSync('chmod', ['-R', 'u+rwx', locked]);

    test('바깥·안쪽 폴더와 파일 모두 복구, Runner ACL도 각 항목에', () => {
      lockUp();
      try {
        const r = wrapper(['fix-perms', locked], '', exec, `${fakeBin}:/usr/bin:/bin`);
        expect(r).toMatchObject({ code: 0, stdout: 'fixed\n' });
        expect(readFileSync(join(locked, 'inner', 'file'), 'utf8')).toBe('x');
        const log = readFileSync(join(root, 'setfacl.log'), 'utf8');
        for (const p of [locked, join(locked, 'inner'), join(locked, 'inner', 'file')]) expect(log).toContain(p);
      } finally {
        unlock();
      }
    });

    test('하나라도 못 고치면 종료 코드 4(작업 폴더를 지우지 말라는 뜻)', () => {
      lockUp();
      writeFileSync(join(root, 'FAIL_SETFACL'), '');
      try {
        const r = wrapper(['fix-perms', locked], '', exec, `${fakeBin}:/usr/bin:/bin`);
        expect(r.code).toBe(4);
        expect(r.stdout).not.toContain('fixed');
      } finally {
        rmSync(join(root, 'FAIL_SETFACL'));
        unlock();
      }
    });
  });
});
