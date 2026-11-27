import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Launches, type LaunchRecord } from '../../src/exec/launches.ts';
import { processGroupEmpty } from '../../src/cleanup/reset.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() {
  const home = await mkdtemp('/home/keeproll/.orca/bots/agentwbs/archive/2026-11-27/M5-02/restart-'); roots.push(home);
  return { home, launches: new Launches(home, { hostId: 'host', bootId: 'boot' }) };
}

test.each(['create', 'spawn', 'record', 'process'])('%s 경계에서 Runner SIGKILL: 명령 미실행·재시작 대조·잔여 0', async boundary => {
  const { home, launches } = await setup();
  const runner = spawn(process.execPath, [join(import.meta.dirname, 'kill-worker.ts'), home, boundary], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  runner.stdout?.resume(); runner.stderr?.resume();
  const [{ record }] = await once(runner, 'message') as [{ record: LaunchRecord }];
  runner.kill('SIGKILL'); await once(runner, 'exit');
  const pgid = await readFile(join(home, 'server-pgid'), 'utf8').then(Number, () => null);
  expect(await launches.reconcile({ job: 'crash-job', hostId: 'host', bootId: 'boot', processGroup: pgid }, 30)).toMatchObject({ kind: pgid === null ? 'no_process' : 'group_empty' });
  await expect(readFile(join(home, 'ran'))).rejects.toMatchObject({ code: 'ENOENT' });
  if (record.pgid !== null) expect(processGroupEmpty(record.pgid)).toBe(true);
}, 10000);

test('실제 명령 실행 뒤 Runner가 죽어도 새 Runner가 같은 launchId 그룹을 정리한다', async () => {
  const { home, launches } = await setup();
  const runner = spawn(process.execPath, [join(import.meta.dirname, 'kill-worker.ts'), home, 'exec'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  runner.stdout?.resume(); runner.stderr?.resume();
  await once(runner, 'message');
  runner.kill('SIGKILL'); await once(runner, 'exit');
  const pgid = Number(await readFile(join(home, 'server-pgid'), 'utf8'));
  expect(await launches.reconcile({ job: 'crash-job', hostId: 'host', bootId: 'boot', processGroup: pgid }, 30)).toMatchObject({ kind: 'group_empty' });
  expect(processGroupEmpty(pgid)).toBe(true);
}, 10000);

test('pgid가 같아도 시작 시각·launchId가 다른 프로그램을 죽이지 않는다', async () => {
  const { launches } = await setup();
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: {} });
  await once(other, 'spawn');
  try {
    const record = await launches.create({ id: 'reused', fence: 1, epoch: 1 });
    record.pgid = other.pid ?? 0; record.startTime = '1';
    await launches.save(record);
    expect(await launches.reconcile({ job: 'reused', hostId: 'host', bootId: 'boot', processGroup: other.pid ?? 0 }, 30)).toBeNull();
    expect(other.kill(0)).toBe(true);
  } finally {
    if (other.exitCode === null && other.signalCode === null) { const ended = once(other, 'exit'); other.kill('SIGKILL'); await ended; }
  }
});
