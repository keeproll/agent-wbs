import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rmdir, rm, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, expect, test } from 'vitest';
import { Launches, processInfo } from '../../src/exec/launches.ts';
import { runProcess } from '../../src/exec/process.ts';

const archive = '/home/keeproll/.orca/bots/agentwbs/archive/2026-11-27/M5-03';
const exec = promisify(execFile);
const facts: Record<string, unknown> = { at: new Date().toISOString(), kernel: release(), uid: process.getuid?.(), paidCalls: 0, cliGrades: { Claude: 'unverified', Codex: 'unverified' } };
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
async function stopScope(unit: string): Promise<void> {
  try { await exec('systemctl', ['--user', 'stop', `${unit}.scope`], { timeout: 5000 }); }
  catch (error) { if ((error as { code?: number }).code !== 5) throw error; }
}
afterAll(async () => { await mkdir(archive, { recursive: true }); await writeFile(join(archive, 'host-facts.json'), JSON.stringify(facts, null, 2) + '\n'); });

test.each(['tree', 'setsid', 'nohup', 'double-fork'])('cgroup 대안: %s 자손은 launchId를 추적해 모두 정리한다', async kind => {
  await mkdir(archive, { recursive: true });
  const home = await mkdtemp(join(archive, `${kind}-`));
  const file = join(home, 'pids.jsonl');
  const launches = new Launches(home, { hostId: 'host', bootId: 'boot' });
  let pgid = 0;
  try {
    const result = await runProcess({ launches, job: { id: kind, fence: 1, epoch: 0 }, launch: { file: '/usr/bin/python3', args: [join(import.meta.dirname, 'kernel-tree.py'), kind, file], env: {}, cwd: home, stdin: '' }, register: record => { pgid = record.pgid ?? 0; return Promise.resolve(); }, graceMs: 100 });
    const found = await rows(file);
    expect(result.code).toBe(0);
    expect(result.proof).toMatchObject({ kind: 'group_empty', processGroup: pgid });
    expect(found).toHaveLength(kind === 'tree' ? 2 : 1);
    for (const row of found) {
      expect(row.marked).toBe(true);
      expect(row.cpu_seconds).toBeGreaterThan(0);
      expect(row.rss_bytes).toBeGreaterThan(0);
      expect(await alive(row.pid)).toBe(false);
      if (kind === 'setsid' || kind === 'double-fork') expect(row.pgid).not.toBe(pgid);
      else expect(row.pgid).toBe(pgid);
    }
    if (kind === 'tree') expect(found.find(row => row.role === 'grandchild')?.ppid).toBe(found.find(row => row.role === 'child')?.pid);
    if (kind === 'nohup') expect(found[0]?.hup_ignored).toBe(true);
    if (kind === 'double-fork') expect(found[0]?.sid).not.toBe(found[0]?.pid);
    facts[kind] = { pgid, processes: found, procTotals: { cpuSeconds: found.reduce((n, p) => n + p.cpu_seconds, 0), rssBytes: found.reduce((n, p) => n + p.rss_bytes, 0) }, remaining: 0, proof: result.proof };
  } finally { await cleanup(file); await rm(home, { recursive: true, force: true }); }
});

test('cgroup 없는 대안의 한계: 표식을 지우고 이중 fork하면 그룹 밖 자손을 증명할 수 없다', async () => {
  const home = await mkdtemp(join(archive, 'scrub-'));
  const file = join(home, 'pids.jsonl');
  try {
    const launches = new Launches(home, { hostId: 'host', bootId: 'boot' });
    const result = await runProcess({ launches, job: { id: 'scrub', fence: 1, epoch: 0 }, launch: { file: '/usr/bin/python3', args: [join(import.meta.dirname, 'kernel-tree.py'), 'scrub', file], env: {}, cwd: home, stdin: '' }, register: () => Promise.resolve(), graceMs: 100 });
    const [row] = await rows(file);
    expect(row?.marked).toBe(false);
    expect(await alive(row?.pid ?? 0)).toBe(true);
    // 이 시험은 안전 보장이 아닌, 현재 대안의 실패 범위를 기록한다. finally에서 직접 정리한다.
    facts.markerRemovedEscape = { process: row, returnedProof: result.proof, limitation: '그룹 empty는 표식을 지운 분리 자손의 부재를 증명하지 못함. 운영에는 탈출 불가능한 cgroup 또는 Q-08 전용 계정 제어가 필요함.' };
  } finally { await cleanup(file); await rm(home, { recursive: true, force: true }); }
});

test('cgroup v2: 현재 경로 위임과 사용자 systemd scope의 측정·일괄 종료를 실제 검사한다', async () => {
  const membership = (await readFile('/proc/self/cgroup', 'utf8')).trim();
  const relative = /^0::(\/.*)$/m.exec(membership)?.[1];
  expect(relative).toBeDefined();
  const direct = join('/sys/fs/cgroup', relative ?? '', `awbs-host-${process.pid}`);
  try { await mkdir(direct); facts.directDelegation = { available: true, membership }; await rmdir(direct); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    expect(['EACCES', 'EPERM', 'EROFS']).toContain(code);
    facts.directDelegation = { available: false, membership, code };
  }
  try { await exec('systemd-run', ['--user', '--scope', '--quiet', '--property=Delegate=yes', '/bin/true'], { timeout: 5000 }); }
  catch (error) {
    facts.userScope = { available: false, reason: (error as Error).message, alternative: '같은 사용자·launchId가 유지되는 자손만 프로세스 그룹 + /proc로 추적. 전용 계정은 Q-08 제어 계층 필요.' };
    return;
  }
  const home = await mkdtemp(join(archive, 'scope-'));
  const unit = `awbs-host-cgroup-${process.pid}`;
  try {
    const result = await exec('systemd-run', ['--user', '--scope', '--quiet', '--property=Delegate=yes', '--unit', unit, process.execPath, join(import.meta.dirname, 'cgroup-scope.ts'), home], { timeout: 15000 });
    const report = JSON.parse(result.stdout) as { available: boolean; code?: string; scope: string; before?: { populated: number; memory: number; cpuUsec: number; pids: number }; after?: { populated: number; cpuUsec: number; pids: number }; processes?: Row[] };
    facts.userScope = report;
    if (!report.available) { expect(['EACCES', 'EPERM', 'EROFS', 'ENOENT']).toContain(report.code); return; }
    expect(report.processes).toHaveLength(6);
    expect(report.before?.populated).toBe(1);
    expect(report.before?.pids).toBeGreaterThanOrEqual(7);
    expect(report.before?.memory).toBeGreaterThan(0);
    expect(report.before?.cpuUsec).toBeGreaterThan(0);
    expect(report.after?.populated).toBe(0);
    expect(report.after?.pids).toBe(0);
    expect(report.after?.cpuUsec).toBeGreaterThanOrEqual(report.before?.cpuUsec ?? 0);
    for (const row of report.processes ?? []) expect(await alive(row.pid)).toBe(false);
    await expect(readFile(join(report.scope, 'cgroup.events'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    try { await stopScope(unit); }
    finally { await cleanup(join(home, 'pids.jsonl')); await rm(home, { recursive: true, force: true }); }
  }
});
