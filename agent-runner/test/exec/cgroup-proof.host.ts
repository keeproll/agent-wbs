// 가짜 명령은 host 성공을 만들 수 없어야 한다. 커널 실측 시험과 별도의 거부 경로 검사다.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { hostArchive } from './host-evidence.ts';

const root = await hostArchive();

test.each(['no-bus', 'no-measurements', 'cached-output'])('cgroup host는 실측 없는 systemd-run(%s)을 성공으로 기록하지 않는다', async mode => {
  const home = await mkdtemp(join(root, 'shim-'));
  const evidence = join(home, 'evidence');
  try {
    const cached = { available: true, scope: '/sys/fs/cgroup/awbs-not-created', before: { populated: 1, pids: 7, memory: 4096, cpuUsec: 100 }, after: { populated: 0, pids: 0, cpuUsec: 101 }, processes: Array.from({ length: 6 }, (_, i) => ({ pid: 2147483647 - i })) };
    const script = mode === 'no-bus' ? 'echo "Failed to connect to bus" >&2; exit 1'
      : mode === 'cached-output' ? `echo '${JSON.stringify(cached)}'`
        : 'for last do :; done; [ "$last" = /bin/true ] || echo \'{"available":false,"code":"EACCES"}\' > "$last/kernel-facts.json"';
    await writeFile(join(home, 'systemd-run'), `#!/bin/sh\n${script}\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ['scripts/vitest.ts', '--config', 'vitest.host.config.ts', 'test/exec/cgroup.host.ts', '-t', 'cgroup v2'], {
      cwd: resolve(import.meta.dirname, '../..'), env: { ...process.env, PATH: `${home}${delimiter}${process.env.PATH ?? ''}`, AWBS_HOST_ARCHIVE: evidence }, encoding: 'utf8', timeout: 10000,
    });
    await writeFile(join(root, `${mode}.log`), result.stdout + result.stderr);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const runs = await readdir(evidence);
    expect(runs).toHaveLength(1);
    const facts = JSON.parse(await readFile(join(evidence, runs[0] ?? '', 'host-facts.json'), 'utf8')) as { userScope: { available: boolean } };
    await writeFile(join(root, `${mode}-facts.json`), JSON.stringify(facts, null, 2) + '\n');
    expect(facts.userScope.available).toBe(false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
