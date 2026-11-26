import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { Launches, processInfo } from '../../src/exec/launches.ts';
import { spawnWaiting } from '../../src/exec/process.ts';
import { createResetCleanup, processGroupEmpty } from '../../src/cleanup/reset.ts';

test('review: 빈 원래 그룹이어도 별도 그룹의 자손을 대조한 뒤 reset을 허가해야 한다', async () => {
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'fix1-review-reset-'));
  const launches = new Launches(home, { hostId: 'host', bootId: 'boot' });
  const record = await launches.create({ id: 'old-job', epoch: 1, fence: 1 });
  const script = join(home, 'tree.cjs');
  await writeFile(script, 'const {spawn}=require("node:child_process"); const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}); console.log(c.pid); c.unref();');
  const parent = spawnWaiting(record, { file: process.execPath, args: [script], env: {}, cwd: home, stdin: '' });
  let childPid = 0;
  try {
    await once(parent, 'spawn');
    await launches.attach(record, parent.pid ?? 0);
    const output = new Promise<string>(resolve => parent.stdout?.once('data', b => resolve(String(b))));
    (parent.stdio[3] as import('node:stream').Writable).end('run\n'); parent.stdin?.end();
    const exited = once(parent, 'exit');
    childPid = Number((await output).trim());
    await exited;
    expect(processGroupEmpty(record.pgid ?? 0)).toBe(true);
    expect((await processInfo(childPid)).pgid).toBe(childPid);
    let checked = false;
    const cleanup = createResetCleanup({ home, identity: () => ({ hostId: 'host', bootId: 'boot' }), launchCheck: async h => {
      checked = true;
      return await launches.reconcile({ job: h.job, hostId: h.hostId ?? '', bootId: h.bootId ?? '', processGroup: h.processGroup }, 10) ? 'none' : 'unknown';
    } });
    const payload: Record<string, unknown> = { holds: [{ job: 'old-job', host_id: 'host', boot_id: 'boot', pgid: record.pgid, slot_state: 'active' }] };
    const result = await cleanup({ id: 'reset', kind: 'reset-cleanup', epoch: 1, payload });
    const alive = (() => { try { process.kill(childPid, 0); return true; } catch { return false; } })();
    console.log(JSON.stringify({ checked, result, detachedDescendantAlive: alive }));
    expect(checked).toBe(true);
    expect(alive).toBe(false);
  } finally {
    if (childPid > 1) try { process.kill(-childPid, 'SIGKILL'); } catch { /* 이미 종료됨 */ }
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
  }
});
