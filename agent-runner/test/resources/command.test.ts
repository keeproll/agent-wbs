import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRunCommand, probeEnv } from '../../src/readiness/command.ts';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awbs-cmd-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const script = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

describe('createRunCommand — 점검 명령 실행(shell 없이 argv)', () => {
  test('인자를 shell로 해석하지 않는다', async () => {
    const echo = script('echo-args', 'for a in "$@"; do printf "[%s]" "$a"; done');
    const run = createRunCommand({ env: { PATH: '/usr/bin:/bin' } });
    expect(await run(echo, ['$HOME', 'a b', '; rm -rf /'])).toEqual({ code: 0, stdout: '[$HOME][a b][; rm -rf /]', stderr: '' });
  });

  test('종료 코드와 stderr를 돌려준다', async () => {
    const fail = script('fail', 'echo oops >&2; exit 3');
    expect(await createRunCommand({ env: { PATH: '/usr/bin:/bin' } })(fail, [])).toEqual({ code: 3, stdout: '', stderr: 'oops\n' });
  });

  test('없는 명령은 예외 대신 code null + 사유', async () => {
    const r = await createRunCommand({ env: { PATH: dir } })('no-such-cli-awbs', ['--version']);
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
  });

  test('시간 초과면 강제 종료하고 code null', async () => {
    const hang = script('hang', 'exec sleep 30');
    const started = Date.now();
    const r = await createRunCommand({ env: { PATH: '/usr/bin:/bin' }, timeoutMs: 200 })(hang, []);
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/시간 초과/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('출력이 너무 크면 자른다', async () => {
    const big = script('big', 'head -c 300000 /dev/zero | tr "\\0" a');
    const r = await createRunCommand({ env: { PATH: '/usr/bin:/bin' }, maxBytes: 1000 })(big, []);
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
  });
});

describe('probeEnv — 점검 명령에 넘길 환경 변수(allowlist)', () => {
  test('허용 목록만 남기고 Runner 토큰·GitHub 토큰·AWBS_*는 넘기지 않는다', () => {
    const env = probeEnv({
      PATH: '/bin',
      HOME: '/home/u',
      LANG: 'C.UTF-8',
      AWBS_RUNNER_TOKEN: 'secret',
      AWBS_URL: 'x',
      GITHUB_TOKEN: 'ghp',
      GH_TOKEN: 'gh',
      SSH_AUTH_SOCK: '/tmp/ssh',
      CODEX_HOME: '/home/u/.codex',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', LANG: 'C.UTF-8', CODEX_HOME: '/home/u/.codex' });
  });

  test('실제로 자식 프로세스에 토큰이 보이지 않는다', async () => {
    const dump = script('dump', 'env');
    const run = createRunCommand({ env: probeEnv({ PATH: '/usr/bin:/bin', AWBS_RUNNER_TOKEN: 'secret-xyz', HOME: dir }) });
    const r = await run(dump, []);
    expect(r.stdout).toContain(`HOME=${dir}`);
    expect(r.stdout).not.toContain('secret-xyz');
  });
});
