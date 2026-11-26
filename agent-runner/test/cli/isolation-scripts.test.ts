import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';

/**
 * 설치·되돌리기·확인 스크립트를 「가짜 루트 폴더 + 가짜 sudo·getent」로 실제 bash에서 돌린다(리뷰 Codex 재현).
 * - 스크립트는 AWBS_ISOLATION_TEST_ROOT가 있고 가짜 sudo가 PATH 맨 앞일 때만 시험 모드가 된다.
 * - 가짜 sudo는 받은 인자를 sudo.log에 적고, 규칙 파일(.sudo-rules)에 맞으면 정한 출력·종료 코드를 돌려준다.
 *   root 명령의 절대 경로 인자가 가짜 루트 밖이면 99로 끝나 시험이 실패한다(실제 시스템을 건드리지 않았다는 증거).
 * - 실제 sudo·계정 생성은 하지 않는다.
 */
const me = userInfo().username;
const usable = /^[a-z_][a-z0-9_-]{0,31}$/.test(me) && me !== 'awbs-agent' && process.getuid?.() !== 0;
const base = realpathSync(mkdtempSync(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'awbs-iso-scripts-')));
afterAll(() => {
  spawnSync('chmod', ['-R', 'u+rwx', base]);
  rmSync(base, { recursive: true, force: true });
});
const scripts = join(import.meta.dirname, '..', '..', 'scripts', 'isolation');
/** 이 설치가 만든 계정 줄: 설명 칸에 생성 표식(awbs-agent-setup-16자리 16진수)이 있다. */
const MARK = 'Agent WBS agent awbs-agent-setup-0123456789abcdef';
const AGENT_LINE = `awbs-agent:x:998:998:${MARK}:/home/awbs-agent:/usr/sbin/nologin`;
const UNMARKED_LINE = 'awbs-agent:x:998:998:Agent WBS agent:/home/awbs-agent:/usr/sbin/nologin';
const EXEC = '/usr/local/libexec/awbs-agent-exec';

let R = '';
let n = 0;

function exe(file: string, body: string): void {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

/** 가짜 명령 원본. __ROOT__·__AGENT__를 시험마다 바꿔 넣는다. */
const FAKE_SUDO = readFileSync(join(import.meta.dirname, '..', 'fakes', 'isolation', 'sudo.sh'), 'utf8');
const FAKE_GETENT = readFileSync(join(import.meta.dirname, '..', 'fakes', 'isolation', 'getent.sh'), 'utf8');

/** 새 가짜 루트. WSL 흉내 폴더와 가짜 명령을 만든다. */
function fresh(opts: { account?: string | null; uid?: string | null } = {}): void {
  R = join(base, `r${++n}`);
  for (const d of ['bin', 'etc', 'home/runner', 'home/awbs-agent', 'mnt/c', 'run/WSL', 'Docker/host', 'proc/sys/fs/binfmt_misc', 'tmp', 'srv', 'usr/local/libexec']) {
    mkdirSync(join(R, d), { recursive: true });
  }
  writeFileSync(join(R, 'proc/sys/fs/binfmt_misc/WSLInterop'), 'enabled\n');
  writeFileSync(join(R, 'etc/passwd'), `root:x:0:0:root:/root:/bin/bash\n${opts.account ? `${opts.account}\n` : ''}`);
  writeFileSync(join(R, 'etc/group'), `root:x:0:\nsudo:x:27:${me}\n${opts.account ? 'awbs-agent:x:998:\n' : ''}`);
  if (opts.uid) {
    mkdirSync(join(R, 'etc/agentwbs'), { recursive: true });
    writeFileSync(join(R, 'etc/agentwbs/agent-user.uid'), `${opts.uid}\n`);
  }
  exe(join(R, 'bin/sudo'), FAKE_SUDO.replaceAll('__ROOT__', R).replace('__AGENT__', AGENT_LINE));
  exe(join(R, 'bin/getent'), FAKE_GETENT.replaceAll('__ROOT__', R));
  writeFileSync(join(R, 'sudo.log'), '');
}

function rules(...lines: [code: number, out: string, glob: string][]): void {
  writeFileSync(join(R, '.sudo-rules'), lines.map((l) => l.join('\x1f')).join('\n') + '\n');
}

function run(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('bash', [join(scripts, script), ...args], {
    encoding: 'utf8',
    env: { PATH: `${R}/bin:/usr/bin:/bin`, HOME: join(R, 'home/runner'), AWBS_ISOLATION_TEST_ROOT: R, LANG: 'C.UTF-8', ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, log: readFileSync(join(R, 'sudo.log'), 'utf8').split('\n').filter(Boolean) };
}

/** 설치 스크립트가 쓰는 sudoers 원본(common.sh의 sudoers_content)을 그대로 얻는다. */
function sudoersContent(): string {
  const r = spawnSync('bash', ['-c', `source '${join(scripts, 'common.sh')}' && sudoers_content '${me}'`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  return r.stdout.replace(/\n$/, '');
}

const setup = (args: string[] = []) => run('setup-agent-user.sh', ['--node', process.execPath, ...args]);
const okCheck: [number, string, string] = [0, 'ok', '-u awbs-agent -H -- *awbs-agent-exec check'];
/** 이 줄(부분 문자열)이 들어간 첫 sudo 호출의 순서. 없으면 -1. */
const at = (log: string[], part: string) => log.findIndex((l) => l.includes(part));

describe.skipIf(!usable)('설치·되돌리기·확인 스크립트(가짜 루트, 실제 sudo 없음)', () => {
  beforeEach(() => fresh());

  test('시험 모드 안전 장치: 가짜 sudo가 PATH 맨 앞이 아니면 시작도 안 한다', () => {
    const r = run('setup-agent-user.sh', ['--dry-run'], { PATH: '/usr/bin:/bin' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('가짜 sudo');
  });

  describe('setup', () => {
    test('정상: 실행 규칙(sudoers)은 Windows 차단·래퍼 점검 ok 뒤 맨 마지막에만 들어간다', () => {
      rules(okCheck);
      const r = setup();
      expect(r.code, r.out).toBe(0);
      const sudoers = at(r.log, `install -o root -g root -m 0440`);
      expect(sudoers).toBeGreaterThan(at(r.log, `setfacl -P -m u:awbs-agent:--- ${R}/mnt`));
      expect(sudoers).toBeGreaterThan(at(r.log, `${R}/usr/local/libexec/awbs-agent-exec check`));
      expect(sudoers).toBe(r.log.length - 1);
      // 시작하자마자 기존 규칙부터 지운다(닫고 시작)
      expect(r.log[0]).toBe(`-- rm -f -- ${R}/etc/sudoers.d/awbs-agent`);
      expect(readFileSync(join(R, 'etc/agentwbs/agent-user.uid'), 'utf8').trim()).toBe('999');
      // 별칭·추가 기본값 없이 규칙 한 줄(확인 스크립트가 sudo -l과 정확히 맞춰 보는 줄)
      const rule = readFileSync(join(R, 'etc/sudoers.d/awbs-agent'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
      expect(rule).toEqual([`${me} ALL=(awbs-agent) NOPASSWD: ${EXEC}`]);
      // 계정은 고른 UID·생성 표식으로 만들고, 진행 기록은 계정 생성 직전에 남겼다가 끝나면 지운다(리뷰2 P2-B)
      expect(at(r.log, 'agent-user.pending')).toBeLessThan(at(r.log, 'useradd'));
      expect(r.log.find((l) => l.includes('useradd'))).toMatch(/--uid 999 .*--comment Agent WBS agent awbs-agent-setup-[0-9a-f]{16} awbs-agent$/);
      expect(existsSync(join(R, 'etc/agentwbs/agent-user.pending'))).toBe(false);
    });

    test('P1-1: Agent 홈 안(tmp 링크)은 root가 아니라 Agent 권한으로만 다룬다', () => {
      symlinkSync(join(R, 'etc'), join(R, 'home/awbs-agent/tmp'));
      rules(okCheck);
      const r = setup();
      expect(r.code, r.out).toBe(0);
      const rootLines = r.log.filter((l) => l.startsWith('-- '));
      expect(rootLines.filter((l) => l.includes('/home/awbs-agent') && !l.startsWith('-- useradd'))).toEqual([]);
      expect(r.log).toContain(`-u awbs-agent -H -- mkdir -p -m 0700 ${R}/home/awbs-agent/tmp`);
      expect(r.log).toContain(`-u awbs-agent -H -- chmod 0700 ${R}/home/awbs-agent`);
    });

    test.each([
      ['작업 영역 하위가 링크', () => { mkdirSync(join(R, 'srv/agentwbs'), { recursive: true }); symlinkSync(join(R, 'etc'), join(R, 'srv/agentwbs/cli')); }, '링크는 따라가지 않습니다'],
      ['작업 영역 자체가 링크', () => symlinkSync(join(R, 'etc'), join(R, 'srv/agentwbs')), '링크는 따라가지 않습니다'],
      ['Windows 차단 대상이 링크', () => { rmSync(join(R, 'run/WSL'), { recursive: true }); symlinkSync(join(R, 'etc'), join(R, 'run/WSL')); }, '링크는 따라가지 않습니다'],
      ['작업 영역이 Agent 소유', () => { mkdirSync(join(R, 'srv/agentwbs/cli'), { recursive: true }); writeFileSync(join(R, '.owners'), '/srv/agentwbs/cli awbs-agent\n'); }, '예상 밖 소유자(awbs-agent)'],
      ['래퍼 폴더가 다른 계정 소유', () => writeFileSync(join(R, '.owners'), '/usr/local/libexec nobody\n'), '예상 밖 소유자(nobody)'],
    ])('P1-1: root 대상 경로가 %s면 sudo를 한 번도 부르지 않고 멈춘다', (_name, plant, message) => {
      plant();
      const r = setup();
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(message);
      expect(r.log).toEqual([]);
    });

    test.each([['--agent-user', 'root'], ['--agent-root', '/home//runner'], ['--agent-user', 'keeproll']])('P2-2·3: %s 옵션은 없다(종료 코드 2)', (opt, value) => {
      const r = setup([opt, value]);
      expect(r.code).toBe(2);
      expect(r.log).toEqual([]);
    });

    test.each([
      ['셸이 열린 같은 이름 계정', 'awbs-agent:x:998:998::/home/awbs-agent:/bin/bash', '998'],
      ['생성 표식 없음·UID 기록 없음', UNMARKED_LINE, null],
      ['생성 표식 없음(UID 기록은 같음)', UNMARKED_LINE, '998'],
      ['UID 기록과 다름', AGENT_LINE, '997'],
      ['홈이 다름', 'awbs-agent:x:998:998::/root:/usr/sbin/nologin', '998'],
    ])('P2-2: 이미 있는 계정이 우리 계정이 아니면(%s) 손대지 않는다', (_name, line, uid) => {
      fresh({ account: line, uid });
      const r = setup();
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('손대지 않고 멈춥니다');
      expect(r.log).toEqual([]);
    });

    test('P2-2: 다른 그룹(sudo)에 속한 같은 이름 계정도 거부', () => {
      fresh({ account: AGENT_LINE, uid: '998' });
      writeFileSync(join(R, 'etc/group'), `root:x:0:\nsudo:x:27:${me},awbs-agent\nawbs-agent:x:998:\n`);
      const r = setup();
      expect(r.code).not.toBe(0);
      expect(r.log).toEqual([]);
    });

    test('재설치: 우리 계정이면 새로 만들지 않고 이어서 맞춘다', () => {
      fresh({ account: AGENT_LINE, uid: '998' });
      rules(okCheck);
      const r = setup();
      expect(r.code, r.out).toBe(0);
      expect(r.log.some((l) => l.includes('useradd'))).toBe(false);
    });

    test.each([
      ['Windows 차단(setfacl /mnt) 실패', `-- setfacl -P -m u:awbs-agent:--- ${'*'}/mnt`],
      ['래퍼 점검 실패', '-u awbs-agent -H -- *awbs-agent-exec check'],
      ['작업 영역 생성 실패', '-- install -d -o * -m 2750 */srv/agentwbs/cli'],
    ])('P2-4: %s → 실행 규칙을 넣지 않고, 지운 상태(닫힘)로 끝난다', (_name, glob) => {
      rules([42, glob.includes('check') ? 'fail mnt_accessible' : '', glob], okCheck);
      const r = setup();
      expect(r.code).not.toBe(0);
      expect(r.log.some((l) => l.includes('-m 0440'))).toBe(false);
      expect(r.log.at(-1)).toBe(`-- rm -f -- ${R}/etc/sudoers.d/awbs-agent`);
      expect(r.out).toContain('닫힌 상태로 둡니다');
      // Windows 차단을 푸는 명령은 없다
      expect(r.log.some((l) => l.includes('setfacl -P -x'))).toBe(false);
    });

    describe('리뷰2 P2-B: 계정 생성 뒤 실패해도 이번 설치가 만든 계정만 되돌리고 다시 실행하면 이어서 된다', () => {
      const passwd = () => readFileSync(join(R, 'etc/passwd'), 'utf8');
      const pending = () => join(R, 'etc/agentwbs/agent-user.pending');

      test('UID 기록 설치 실패 → 진행 기록으로 방금 만든 계정을 되돌림 → 재실행 성공', () => {
        rules([42, '', '-- install * */etc/agentwbs/agent-user.uid'], okCheck);
        let r = setup();
        expect(r.code).toBe(42);
        expect(at(r.log, 'userdel --remove awbs-agent')).toBeGreaterThan(at(r.log, 'useradd'));
        expect(passwd()).not.toContain('awbs-agent');
        expect(existsSync(pending())).toBe(false);
        expect(r.out).toContain('이번 설치가 만든 계정과 진행 기록을 되돌렸습니다');
        expect(r.log.some((l) => l.includes('-m 0440'))).toBe(false);
        rules(okCheck);
        writeFileSync(join(R, 'sudo.log'), '');
        r = setup();
        expect(r.code, r.out).toBe(0);
        expect(readFileSync(join(R, 'etc/agentwbs/agent-user.uid'), 'utf8').trim()).toBe('999');
      });

      test('계정 생성 명령 자체가 실패 → 지울 계정이 없으니 진행 기록만 지움', () => {
        rules([9, '', '-- useradd *'], okCheck);
        const r = setup();
        expect(r.code).toBe(9);
        expect(r.log.some((l) => l.includes('userdel'))).toBe(false);
        expect(existsSync(pending())).toBe(false);
      });

      test('만들어진 계정이 진행 기록과 다르면(다른 표식) 지우지 않고 기록을 남긴다. 제거 스크립트도 그 계정을 건드리지 않는다', () => {
        writeFileSync(join(R, '.useradd-line'), 'awbs-agent:x:999:999:Agent WBS agent awbs-agent-setup-ffffffffffffffff:/home/awbs-agent:/usr/sbin/nologin\n');
        rules(okCheck);
        let r = setup();
        expect(r.code).not.toBe(0);
        expect(r.out).toContain('만든 계정이 진행 기록과 다릅니다');
        expect(r.out).toContain('다른 계정이라 손대지 않습니다');
        expect(r.log.some((l) => l.includes('userdel'))).toBe(false);
        expect(existsSync(pending()), r.out + r.log.join('\n')).toBe(true);
        writeFileSync(join(R, 'sudo.log'), '');
        r = run('remove-agent-user.sh');
        expect(r.code).not.toBe(0);
        expect(r.log).toEqual([]);
        expect(passwd()).toContain('ffffffffffffffff');
      });

      test('강제 종료로 정리 코드도 못 돈 경우(진행 기록+표식 계정, UID 기록 없음) → 재실행이 그 계정을 되돌리고 새로 만든다', () => {
        fresh({ account: AGENT_LINE });
        mkdirSync(join(R, 'etc/agentwbs'), { recursive: true });
        writeFileSync(pending(), 'awbs-agent 998 awbs-agent-setup-0123456789abcdef\n');
        rules(okCheck);
        const r = setup();
        expect(r.code, r.out).toBe(0);
        expect(at(r.log, 'userdel --remove awbs-agent'), r.out).toBeLessThan(at(r.log, 'useradd'));
        expect(existsSync(pending())).toBe(false);
      });

      test('기록이 하나도 없어도 생성 표식이 있는 우리 계정은 제거 스크립트가 계정의 UID로 정리한다', () => {
        fresh({ account: AGENT_LINE });
        mkdirSync(join(R, 'srv/agentwbs'), { recursive: true });
        const r = run('remove-agent-user.sh');
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain('생성 표식이 있는 우리 계정(UID 998)');
        expect(r.log).toContain('-- userdel --remove awbs-agent');
        expect(r.log).toContain(`-- setfacl -P -x u:998 ${R}/mnt`);
      });

      test('표식 없는 같은 이름 계정은 기록이 없으면 제거 스크립트가 건드리지 않는다', () => {
        fresh({ account: UNMARKED_LINE });
        const r = run('remove-agent-user.sh');
        expect(r.code).not.toBe(0);
        expect(r.log).toEqual([]);
      });
    });

    test('dry-run은 가짜 sudo도 부르지 않는다', () => {
      const r = setup(['--dry-run']);
      expect(r.code, r.out).toBe(0);
      expect(r.log).toEqual([]);
      expect(r.out).toContain('[dry-run] sudo');
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      fresh({ account: AGENT_LINE, uid: '998' });
      mkdirSync(join(R, 'srv/agentwbs/worktrees'), { recursive: true });
      writeFileSync(join(R, '.procs'), '1234\n');
    });

    test('정상(작업 영역 남김): 규칙 회수 → 프로세스 0개 확인 → 계정 삭제 → 그 뒤 Windows 차단 해제 → 숫자 권한 항목 정리', () => {
      const r = run('remove-agent-user.sh');
      expect(r.code, r.out).toBe(0);
      const i = (p: string) => at(r.log, p);
      expect(i('rm -f -- ' + join(R, 'etc/sudoers.d/awbs-agent'))).toBe(0);
      expect(i('pgrep -U 998')).toBeGreaterThan(i('pkill -KILL -U 998'));
      expect(i('userdel --remove awbs-agent')).toBeGreaterThan(i('pgrep -U 998'));
      expect(i(`setfacl -P -x u:998 ${R}/mnt`)).toBeGreaterThan(i('userdel'));
      for (const d of ['mnt', 'Docker', 'run/WSL']) expect(r.log).toContain(`-- setfacl -P -x u:998 ${R}/${d}`);
      // P2-9: 남기는 작업 영역의 ACL(이름·숫자·기본)과 Agent 소유권을 남김없이 정리
      expect(r.log).toContain(`-- setfacl -R -P -b -- ${R}/srv/agentwbs`);
      expect(r.log).toContain(`-- chown -R --no-dereference --from=998 ${me} -- ${R}/srv/agentwbs`);
      expect(at(r.log, 'agent-user.uid')).toBe(r.log.length - 3);
      expect(at(r.log, 'agent-user.pending')).toBe(r.log.length - 2);
    });

    test('P2-4: 프로세스 종료 명령 오류 → Windows 차단을 풀지 않고 멈춘다', () => {
      rules([42, '', '-- pkill -KILL -U 998']);
      const r = run('remove-agent-user.sh');
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('pkill 종료 코드 42');
      expect(r.log.some((l) => l.includes('setfacl -P -x') || l.includes('userdel'))).toBe(false);
    });

    test('P2-4: 끝내도 프로세스가 남으면 Windows 차단 유지', () => {
      writeFileSync(join(R, '.procs-stubborn'), '');
      const r = run('remove-agent-user.sh');
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('Windows 차단을 유지');
      expect(r.log.some((l) => l.includes('setfacl -P -x') || l.includes('userdel'))).toBe(false);
    }, 20_000);

    test('P2-4: 계정 삭제 실패 → Windows 차단 유지, 다시 실행하면 기록한 UID로 이어서 정리(P2-9)', () => {
      rules([8, '', '-- userdel --remove awbs-agent']);
      let r = run('remove-agent-user.sh');
      expect(r.code).toBe(8);
      expect(r.log.some((l) => l.includes('setfacl -P -x'))).toBe(false);
      // 계정은 없고 UID 기록만 남은 상태(부분 실패)에서 다시 실행
      writeFileSync(join(R, '.sudo-rules'), '');
      writeFileSync(join(R, 'etc/passwd'), 'root:x:0:0:root:/root:/bin/bash\n');
      writeFileSync(join(R, 'sudo.log'), '');
      r = run('remove-agent-user.sh');
      expect(r.code, r.out).toBe(0);
      expect(r.log).toContain(`-- setfacl -P -x u:998 ${R}/mnt`);
      expect(r.log).toContain(`-- chown -R --no-dereference --from=998 ${me} -- ${R}/srv/agentwbs`);
    });

    test('P2-2: 우리 계정이 아니면(셸 열림) 아무것도 지우지 않는다', () => {
      writeFileSync(join(R, 'etc/passwd'), `root:x:0:0:root:/root:/bin/bash\nawbs-agent:x:998:998::/home/awbs-agent:/bin/bash\n`);
      const r = run('remove-agent-user.sh');
      expect(r.code).not.toBe(0);
      expect(r.log).toEqual([]);
    });

    test.each([['--agent-user', 'root'], ['--agent-root', '/home//runner']])('P2-2·3: %s 옵션은 없다', (opt, value) => {
      const r = run('remove-agent-user.sh', ['--dry-run', '--purge-work', opt, value]);
      expect(r.code).toBe(2);
      expect(r.log).toEqual([]);
    });

    test('P2-3: 작업 영역이 Runner 홈을 가리키는 링크면 --purge-work도 멈춘다', () => {
      rmSync(join(R, 'srv/agentwbs'), { recursive: true });
      symlinkSync(join(R, 'home/runner'), join(R, 'srv/agentwbs'));
      const r = run('remove-agent-user.sh', ['--purge-work']);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('링크는 따라가지 않습니다');
      expect(r.log).toEqual([]);
      expect(existsSync(join(R, 'home/runner'))).toBe(true);
    });

    test('UID 기록 값이 이상하면(0) 멈춘다', () => {
      writeFileSync(join(R, 'etc/agentwbs/agent-user.uid'), '0\n');
      const r = run('remove-agent-user.sh');
      expect(r.code).not.toBe(0);
      expect(r.log).toEqual([]);
    });
  });

  describe('check(fail-closed)', () => {
    /** sudo 1.9 `sudo -l -U` 출력 모양. defaults는 기본값 줄, extra는 규칙 뒤에 더할 줄. */
    const goodListing = (extra = '', defaults = 'env_reset, mail_badpass, secure_path=/usr/local/sbin\\\\:/usr/local/bin\\\\:/usr/sbin\\\\:/usr/bin\\\\:/sbin\\\\:/bin\\\\:/snap/bin, use_pty') =>
      `Matching Defaults entries for ${me} on host:\\n    ${defaults}\\n\\nUser ${me} may run the following commands on host:\\n    (ALL : ALL) ALL\\n    (awbs-agent) NOPASSWD: ${EXEC}\\n${extra}`;
    const allow = (glob: string): [number, string, string] => [0, 'rc=0', glob];
    function baseline(listing = goodListing()): [number, string, string][] {
      return [
        [0, listing, `-l -U ${me}`],
        [0, 'ok', `-n -u awbs-agent -- ${EXEC} check`],
        allow('*bash -c * _ true'),
        allow('*test -x */srv/agentwbs/cli'),
        allow('*find -P * _ */srv/agentwbs/cli'),
        allow('*find -P * _ */srv/agentwbs/inputs'),
        allow('*mkdir * _ */worktrees/.check-*'),
        allow('*test -r */.interop-*/whoami.exe'),
        allow('*test -x */.interop-*/whoami.exe'),
      ];
    }
    beforeEach(() => {
      fresh({ account: AGENT_LINE, uid: '998' });
      for (const d of ['srv/agentwbs/cli', 'srv/agentwbs/inputs', 'srv/agentwbs/worktrees', 'home/runner/.config/gh', 'mnt/c/Windows/System32']) mkdirSync(join(R, d), { recursive: true });
      exe(join(R, 'mnt/c/Windows/System32/whoami.exe'), '#!/bin/sh\nexit 0\n');
      writeFileSync(join(R, '.agent-deny'), '');
      mkdirSync(join(R, 'etc/sudoers.d'), { recursive: true });
      writeFileSync(join(R, 'etc/sudoers.d/awbs-agent'), `${sudoersContent()}\n`);
    });
    const check = () => run('check-agent-user.sh');

    test('기준: 모두 막히고 정책이 맞으면 FAIL 0개, 종료 코드 0', () => {
      rules(...baseline());
      const r = check();
      expect(r.out).toContain('결과: FAIL 0개');
      expect(r.code, r.out).toBe(0);
    });

    test.each([
      ['root로 래퍼를 비밀번호 없이', `    (root) NOPASSWD: ${EXEC}\\n`],
      ['root 셸을 비밀번호 없이(리뷰2)', '    (root) NOPASSWD: /bin/bash\\n'],
      ['root로 경로 와일드카드(리뷰2)', '    (root) NOPASSWD: /usr/local/libexec/awbs-agent-*\\n'],
      ['모든 계정으로 모든 명령을 비밀번호 없이', '    (ALL) NOPASSWD: ALL\\n'],
      ['Agent 계정으로 다른 명령도', '    (awbs-agent) NOPASSWD: /bin/bash\\n'],
      ['인증 태그가 섞인 Agent 규칙(리뷰2)', `    (awbs-agent) NOPASSWD: /bin/bash, PASSWD: ${EXEC}\\n`],
      ['SETENV 태그가 붙은 Agent 규칙(리뷰2)', `    (awbs-agent) NOPASSWD: SETENV: ${EXEC}\\n`],
      ['비밀번호가 필요한 다른 규칙', '    (root) /usr/bin/apt\\n'],
      ['해석할 수 없는 줄', '    알 수 없는 줄\\n'],
    ])('P2-6·리뷰2 P2-A: sudo 허용 목록에 %s → FAIL(기대 줄과 글자 그대로 같은 줄만 통과)', (_name, extra) => {
      rules(...baseline(goodListing(extra)));
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain(`FAIL  허용 목록에 없는 sudo 규칙: ${extra.trim().replaceAll('\\n', '')}`);
      expect(r.out).not.toContain('PASS  sudo 허용 목록이 기대와 정확히 같음');
    });

    test('리뷰2 P2-A: 기대 규칙이 정확한 모양이 아니면(SETENV만 있는 줄로 바뀜) 「1번 있어야 함」도 FAIL', () => {
      rules(...baseline(goodListing().replace(`(awbs-agent) NOPASSWD: ${EXEC}`, `(awbs-agent) NOPASSWD: SETENV: ${EXEC}`)));
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain('정확히 1번 있어야 함(지금 0번)');
    });

    test.each([
      ['!authenticate', 'env_reset, !authenticate'],
      ['env_keep 추가', 'env_reset, env_keep+=LD_PRELOAD'],
      ['setenv', 'env_reset, setenv'],
      ['secure_path 변경', 'env_reset, secure_path=/tmp\\\\:/usr/bin'],
    ])('리뷰2 P2-A: sudo 기본값 변화(%s) → FAIL', (name, defaults) => {
      rules(...baseline(goodListing('', defaults)));
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain(`FAIL  허용 목록에 없는 sudo 기본값: ${(defaults.split(', ')[1] ?? '').replaceAll('\\\\', '\\')}`);
      expect(name).toBeTruthy();
    });

    test('리뷰2 P2-A: 모르는 머리말(명령별 기본값 등)이 나오면 확인 못 함 FAIL', () => {
      rules(...baseline(goodListing().replace('\\nUser ', `\\nRunas and Command-specific defaults for ${me}:\\n    Defaults!${EXEC} setenv\\n\\nUser `)));
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain('확인 못 함: 해석하지 않는 sudo 출력 줄');
    });

    test('리뷰2 P2-A: Agent 래퍼 규칙이 없으면 FAIL', () => {
      rules(...baseline(`Matching Defaults entries for ${me} on host:\\n    env_reset\\n\\nUser ${me} may run the following commands on host:\\n    (ALL : ALL) ALL\\n`));
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain('정확히 1번 있어야 함(지금 0번)');
    });

    test('리뷰2 P2-A: 설치된 sudoers 파일에 별칭·기본값을 더하면 FAIL', () => {
      writeFileSync(join(R, 'etc/sudoers.d/awbs-agent'), `${sudoersContent()}\nDefaults!${EXEC} setenv\n`);
      rules(...baseline());
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain('awbs-agent가 설치 원본과 다름');
    });

    test('fail-closed: Agent로 실행 자체가 안 되면(sudo 실패) 「막힘」으로 치지 않고 FAIL, 요약까지 출력', () => {
      rules(...baseline().filter(([, , g]) => g !== '*bash -c * _ true'), [1, '', '*bash -c * _ true']);
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain('확인 못 함: Agent 계정으로 명령을 실행하지 못함');
      expect(r.out).not.toContain('PASS  Agent가 못 함');
      expect(r.out).toMatch(/결과: FAIL \d+개/);
    });

    test('fail-closed: 검사 하나에서만 sudo가 실패해도(출력 없음) 그 검사는 PASS가 아니라 FAIL', () => {
      rules([1, '', `*test -r ${R}/home/runner/.config/gh`], ...baseline());
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain(`FAIL  확인 못 함(Agent로 실행 실패): 목록 읽기 ${R}/home/runner/.config/gh`);
      expect(r.out).toContain(`PASS  Agent가 못 함: 지나가기 ${R}/home/runner/.config/gh`);
    });

    test('P2-5: Agent가 Windows 시험 복사본을 못 읽으면 「통로 차단」 PASS가 아니라 FAIL', () => {
      rules(...baseline().filter(([, , g]) => !g.includes('whoami')));
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain('확인 못 함: Agent가 시험용 복사본을 읽거나 실행할 권한이 없음');
      expect(r.out).not.toContain('PASS  Agent가 못 함: Windows 실행 통로');
    });

    test('P2-5: 시험 복사본이 열려 있고 실행이 막히면 PASS', () => {
      rules(...baseline());
      const r = check();
      expect(r.out).toContain('PASS  Agent가 못 함: Windows 실행 통로로 Windows 프로그램 실행');
    });

    test.each([
      ['CLI 안쪽 파일 쓰기 가능', '*find -P * _ */srv/agentwbs/cli', 'rc=3', 'Agent가 고칠 수 있는 파일·폴더가 있음: CLI 설치본'],
      ['입력 안쪽 파일 쓰기 가능', '*find -P * _ */srv/agentwbs/inputs', 'rc=3', 'Agent가 고칠 수 있는 파일·폴더가 있음: 입력 자료'],
      ['CLI 안쪽을 다 못 읽음', '*find -P * _ */srv/agentwbs/cli', 'rc=2', '확인 못 함(하위 폴더를 다 읽지 못함): CLI'],
    ])('P2-7: %s → FAIL', (_name, glob, out, message) => {
      rules(...baseline().filter(([, , g]) => g !== glob), [0, out, glob]);
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain(message);
    });

    test('P2-7: Windows 경로는 목록 읽기와 지나가기를 따로 본다(/Docker 포함)', () => {
      rules(...baseline(), [0, 'rc=0', `*test -x ${R}/Docker`]);
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain(`FAIL  Agent가 할 수 있음: 지나가기 ${R}/Docker`);
      expect(r.out).toContain(`PASS  Agent가 못 함: 목록 읽기 ${R}/Docker`);
    });

    test('P3-10: /tmp 검색이 다른 계정 폴더 때문에 오류를 내도 끝까지 가서 요약한다', () => {
      mkdirSync(join(R, 'tmp/private'));
      chmodSync(join(R, 'tmp/private'), 0o000);
      rules(...baseline());
      const r = check();
      chmodSync(join(R, 'tmp/private'), 0o755);
      expect(r.out).toContain('결과: FAIL 0개');
      expect(r.code).toBe(0);
    });

    test('계정이 우리 계정과 다르면 FAIL', () => {
      writeFileSync(join(R, 'etc/passwd'), `root:x:0:0:root:/root:/bin/bash\nawbs-agent:x:998:998::/home/awbs-agent:/bin/bash\n`);
      rules(...baseline());
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain('설치 기록과 다릅니다');
    });
  });
});
