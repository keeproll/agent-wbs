import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { afterAll, expect, test } from 'vitest';
import { Launches, processInfo } from '../../src/exec/launches.ts';
import { runProcess, spawnWaiting } from '../../src/exec/process.ts';
import { hostArchive } from './host-evidence.ts';

const archive = await hostArchive();
const facts: Record<string, unknown> = {};
const fixture = join(import.meta.dirname, 'non-dumpable.py');
afterAll(async () => { await writeFile(join(archive, 'non-dumpable-facts.json'), JSON.stringify(facts, null, 2) + '\n'); });
async function home() { const home = await mkdtemp(join(archive, 'process-')); return { home, launches: new Launches(home, { hostId: 'host', bootId: 'boot' }) }; }
async function info(pid: number) { return { pid, ...await processInfo(pid) }; }
async function stop(process: Awaited<ReturnType<typeof info>> | undefined): Promise<void> {
  if (!process) return;
  try {
    if ((await processInfo(process.pid)).startTime === process.startTime) globalThis.process.kill(process.pid, 'SIGKILL');
  } catch (e) { if (!['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
}
async function unreadable(pid: number) {
  expect((await stat(`/proc/${pid}`)).uid).toBe(process.getuid?.());
  await expect(readFile(`/proc/${pid}/environ`)).rejects.toMatchObject({ code: 'EACCES' });
  return info(pid);
}
async function ready(child: ChildProcess): Promise<{ pid: number; ppid: number }> {
  if (!child.stdout) throw new Error('시험 프로세스의 출력이 없습니다.');
  const [bytes] = await once(child.stdout, 'data') as [Buffer];
  return JSON.parse(bytes.toString()) as { pid: number; ppid: number };
}

test('무관한 같은 UID non-dumpable 프로세스는 실행 종료 증명을 막지 않는다', async () => {
  const t = await home();
  const other = spawn('/usr/bin/python3', [fixture, 'single'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: {} });
  const exited = once(other, 'exit');
  let identity: Awaited<ReturnType<typeof info>> | undefined;
  try {
    const row = await ready(other);
    identity = await unreadable(row.pid);
    const result = await runProcess({ launches: t.launches, job: { id: 'own', fence: 1, epoch: 1 }, launch: { file: process.execPath, args: ['-e', ''], cwd: t.home, env: {}, stdin: '' }, register: () => Promise.resolve(), graceMs: 20 });
    expect(result.code).toBe(0);
    expect(result.proof.kind).toBe('group_empty');
    expect((await info(row.pid)).startTime).toBe(identity.startTime);
    facts.unrelated = { uid: process.getuid?.(), ...identity, environ: 'EACCES', result: result.proof, unrelatedStillAlive: true };
  } finally { await stop(identity); await exited; await rm(t.home, { recursive: true, force: true }); }
});

test.each(['single', 'parent'])('우리 launch의 non-dumpable 프로세스는 미확인으로 남긴다(%s)', async mode => {
  const t = await home();
  const record = await t.launches.create({ id: 'own', fence: 1, epoch: 1 });
  const child = spawnWaiting(record, { file: '/usr/bin/python3', args: [fixture, mode], cwd: t.home, env: {}, stdin: '' });
  const exited = once(child, 'exit');
  const permit = child.stdio[3] as Writable;
  permit.on('error', () => undefined); child.stderr?.resume();
  let parent: Awaited<ReturnType<typeof info>> | undefined, target: Awaited<ReturnType<typeof info>> | undefined;
  try {
    await once(child, 'spawn');
    await t.launches.attach(record, child.pid ?? 0);
    parent = await info(child.pid ?? 0);
    const rowPromise = ready(child);
    permit.end('run\n'); child.stdin?.end();
    const row = await rowPromise;
    target = await unreadable(row.pid);
    if (mode === 'parent') {
      expect(row.ppid).toBe(child.pid);
      expect(target.sessionId).not.toBe(parent.sessionId);
    }
    const proof = await t.launches.reconcile({ job: record.job.id, ...t.launches.identity, processGroup: record.pgid }, 20);
    expect(proof).toBeNull();
    expect(t.launches.problem).toContain('EACCES');
    expect((await info(row.pid)).startTime).toBe(target.startTime);
    facts[mode] = { parent, target, environ: 'EACCES', proof, problem: t.launches.problem, targetStillAlive: true };
  } finally { permit.destroy(); await stop(target); await stop(parent); await exited; await rm(t.home, { recursive: true, force: true }); }
});

test('재사용된 번호의 non-dumpable 타인은 시작 시각으로 제외한다', async () => {
  const t = await home();
  const other = spawn('/usr/bin/python3', [fixture, 'single'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: {} });
  const exited = once(other, 'exit');
  let identity: Awaited<ReturnType<typeof info>> | undefined;
  try {
    const row = await ready(other);
    identity = await unreadable(row.pid);
    const record = await t.launches.create({ id: 'reused', fence: 1, epoch: 1 });
    record.pgid = row.pid; record.sessionId = identity.sessionId; record.startTime = String(BigInt(identity.startTime) - 1n);
    await t.launches.save(record);
    expect(await t.launches.reconcile({ job: record.job.id, ...t.launches.identity, processGroup: record.pgid }, 20)).toBeNull();
    expect(t.launches.problem).toBeNull();
    expect((await info(row.pid)).startTime).toBe(identity.startTime);
    facts.reused = { actual: identity, recordedStartTime: record.startTime, environ: 'EACCES', proof: null, problem: t.launches.problem, unrelatedStillAlive: true };
  } finally { await stop(identity); await exited; await rm(t.home, { recursive: true, force: true }); }
});
