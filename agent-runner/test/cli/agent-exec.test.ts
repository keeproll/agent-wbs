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
  writeConf(conf, { AGENT_USER: me });
  const original = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'isolation', 'awbs-agent-exec.sh'), 'utf8');
  expect(original).toContain('\nCONF=/etc/agentwbs/agent-exec.conf\n');
  writeExec(exec, original.replace('\nCONF=/etc/agentwbs/agent-exec.conf\n', `\nCONF=${conf}\n`));
  // fake sudo: Runner가 만든 모양(-n -u <계정> --)만 받고, sudo의 env_reset처럼 환경을 모두 비운 뒤 실행한다.
  writeExec(sudo, `#!/bin/bash\n[[ $1 == -n && $2 == -u && $4 == -- ]] || { echo bad-sudo-args >&2; exit 9; }\nshift 4\nexec env -i "$@"\n`);
}

function writeConf(file: string, over: Record<string, string>): void {
  const values = { AGENT_USER: me, RUNNER_USER: 'keeproll', RUNNER_HOME: runnerHome, AGENT_ROOT: area, NODE_DIR: join(area, 'runtime', 'node', 'bin'), ...over };
  writeFileSync(file, `# 시험 설정\n${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
}

function wrapper(args: string[], input = '', file = exec, path = '/usr/bin:/bin') {
  const r = spawnSync(file, args, { input, encoding: 'utf8', env: { PATH: path, AWBS_RUNNER_TOKEN: 'runner-secret', HOME: runnerHome } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function recorded(): { cwd: string; args: string[]; env: Record<string, string>; stdin: string } {
  const lines = readFileSync(out, 'utf8').split('\n');
  const pick = (p: string) => lines.filter((l) => l.startsWith(p)).map((l) => l.slice(p.length));
  const env = Object.fromEntries(pick('env=').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { cwd: pick('cwd=')[0] ?? '', args: pick('arg='), env, stdin: pick('stdin=').join('\n') };
}

const codex = join(area, 'cli', 'codex', 'current', 'bin', 'codex');
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
    expect(got.env).toMatchObject({ HOME: home, USER: me, TMPDIR: `${home}/tmp`, LANG: 'ko_KR.UTF-8', PATH: `${join(area, 'runtime', 'node', 'bin')}:/usr/local/bin:/usr/bin:/bin` });
    expect(got.env.AWBS_RUNNER_TOKEN).toBeUndefined();
  });

  test.each([
    ['작업 폴더가 worktrees 밖', { cwd: join(area, 'inputs') }, '작업 폴더'],
    ['작업 폴더가 worktrees 자체', { cwd: join(area, 'worktrees') }, '작업 폴더'],
    ['작업 폴더 링크가 Runner 홈을 가리킴', { cwd: join(area, 'worktrees', 'p1', 'escape') }, '작업 폴더'],
    ['CLI가 설치본 밖', { bin: join(root, 'outside-cli') }, 'CLI'],
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
    r = wrapper(['login-status', '--agent', 'claude', '--', join(area, 'cli', 'claude', 'current', 'bin', 'claude')]);
    expect(r.code).toBe(0);
    got = recorded();
    expect(got.args).toEqual(['auth', 'status', '--json']);
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
