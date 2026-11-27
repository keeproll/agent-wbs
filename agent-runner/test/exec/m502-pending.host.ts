// M5-02 리뷰 수정 대기 중인 실제 커널 재현. skip 없이 실행하며 첫 시험은 수정 전 실패해야 한다.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, expect, test } from 'vitest';
import { Launches, processInfo } from '../../src/exec/launches.ts';
import { spawnWaiting } from '../../src/exec/process.ts';
import { createResetCleanup, processGroupEmpty } from '../../src/cleanup/reset.ts';
import { hostArchive } from './host-evidence.ts';

const archive = await hostArchive();
const facts: Record<string, unknown> = { scope: 'M5-02 수정 대기 재현', simulatedPidReuse: true };
afterAll(async () => { await writeFile(join(archive, 'm502-pending-facts.json'), JSON.stringify(facts, null, 2) + '\n'); });
interface Row { pid: number; ppid: number; pgid: number; sid: number; role: string; marked: boolean; hup_ignored: boolean; start_time: string; cpu_seconds: number; rss_bytes: number }
const rows = async (file: string): Promise<Row[]> => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Row);
async function alive(pid: number): Promise<boolean> {
  try { return !['Z', 'X'].includes((await processInfo(pid)).state); }
  catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
}
async function cleanup(file: string): Promise<void> {
  for (const row of await rows(file).catch(() => [])) {
    if (await alive(row.pid) && (await processInfo(row.pid)).startTime === row.start_time) {
      process.kill(row.pid, 'SIGKILL');
      const deadline = Date.now() + 2000;
      while (await alive(row.pid) && Date.now() < deadline) await sleep(10);
      expect(await alive(row.pid)).toBe(false);
    }
  }
}
test('M5-02 수정 대기: 원래 그룹이 비어도 초기화는 setsid 자손을 대조·정리한다', async () => {
  const home = await mkdtemp(join(archive, 'reset-setsid-'));
  const file = join(home, 'pids.jsonl');
  const launches = new Launches(home, { hostId: 'host', bootId: 'boot' });
  const record = await launches.create({ id: 'reset-setsid', fence: 1, epoch: 0 });
  const child = spawnWaiting(record, { file: '/usr/bin/python3', args: [join(import.meta.dirname, 'kernel-tree.py'), 'setsid', file], env: {}, cwd: home, stdin: '' });
  const exited = once(child, 'exit');
  const permit = child.stdio[3] as Writable;
  permit.on('error', () => undefined);
  child.stdout?.resume(); child.stderr?.resume();
  try {
    await once(child, 'spawn');
    await launches.attach(record, child.pid ?? 0);
    permit.end('run\n'); child.stdin?.end();
    await exited;
    const [row] = await rows(file);
    expect(processGroupEmpty(record.pgid ?? 0)).toBe(true);
    expect(await alive(row?.pid ?? 0)).toBe(true);
    const cleanup = createResetCleanup({ home, identity: () => launches.identity, launchCheck: async hold => await launches.reconcile({ job: hold.job, hostId: hold.hostId ?? '', bootId: hold.bootId ?? '', processGroup: hold.processGroup }, 100) ? 'none' : 'unknown' });
    const payload: Record<string, unknown> = { holds: [{ job: record.job.id, host_id: 'host', boot_id: 'boot', pgid: record.pgid, slot_state: 'active' }] };
    const result = await cleanup({ id: 'reset', kind: 'reset-cleanup', epoch: 0, payload });
    facts.resetDetached = { originalGroupEmptyBefore: true, descendant: row, result, descendantAliveAfter: await alive(row?.pid ?? 0) };
    expect(result.status).toBe('done');
    expect(await alive(row?.pid ?? 0)).toBe(false);
  } finally {
    permit.destroy();
    await launches.reconcile({ job: record.job.id, ...launches.identity, processGroup: record.pgid }, 100);
    await cleanup(file); await rm(home, { recursive: true, force: true });
  }
});

test('M5-02 수정 대기: pgid 재사용 상태를 모사해 실제 다른 시작 시각의 프로세스를 보호한다', async () => {
  const home = await mkdtemp(join(archive, 'pid-reuse-'));
  const launches = new Launches(home, { hostId: 'host', bootId: 'boot' });
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: {} });
  const exited = once(other, 'exit');
  try {
    await once(other, 'spawn');
    const pid = other.pid ?? 0;
    const live = await processInfo(pid);
    const record = await launches.create({ id: 'reused', fence: 1, epoch: 0 });
    // PID 순환을 강제하지 않는다. 옛 장부의 번호를 실제 다른 프로세스 번호로 두어 재사용 상태를 만든다.
    record.pgid = pid; record.startTime = String(BigInt(live.startTime) - 1n);
    await launches.save(record);
    const proof = await launches.reconcile({ job: record.job.id, ...launches.identity, processGroup: pid }, 100);
    facts.pidReuse = { pgid: pid, oldStartTime: record.startTime, liveStartTime: live.startTime, proof, unrelatedStillAlive: await alive(pid), simulated: true };
    expect(proof).toBeNull();
    expect(await alive(pid)).toBe(true);
  } finally {
    other.kill('SIGKILL'); await exited;
    await rm(home, { recursive: true, force: true });
  }
});

