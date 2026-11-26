import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import { Launches } from '../../src/exec/launches.ts';
import { runProcess } from '../../src/exec/process.ts';
import { createResetCleanup } from '../../src/cleanup/reset.ts';
import { installFakeCli } from '../fakes/cli.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() {
  const home = await mkdtemp('/home/keeproll/.orca/bots/agentwbs/archive/2026-11-27/M5-02/process-');
  roots.push(home);
  return { home, launches: new Launches(home, { hostId: 'host', bootId: 'boot' }) };
}
const job = { id: 'job', fence: 7, epoch: 1 };

test('/process 응답 전에 실제 명령을 실행하지 않고 승인 뒤에만 stdin을 전달한다', async () => {
  const { home, launches } = await setup();
  const fake = installFakeCli(join(home, 'fake'), 'codex');
  const result = await runProcess({ launches, job, launch: { file: fake.path, args: [], cwd: home, env: { PATH: process.env.PATH }, stdin: '비밀 지시문' }, register: async record => {
    expect(fake.calls()).toEqual([]);
    expect(record.pgid).toBeGreaterThan(1);
    expect((await launches.list())[0]?.pgid).toBe(record.pgid);
  } });
  expect(result.code).toBe(0);
  expect(result.proof.kind).toBe('group_empty');
  expect(fake.calls()[0]?.stdin).toBe('비밀 지시문');
});

test('출력을 디스크에 천천히 써도 역압으로 메모리에 쌓지 않고 끝까지 전달한다', async () => {
  const { home, launches } = await setup();
  let concurrent = 0, peak = 0, bytes = 0;
  const result = await runProcess({ launches, job, launch: { file: process.execPath, args: ['-e', 'process.stdout.write(Buffer.alloc(1024*1024,120))'], cwd: home, env: {}, stdin: '' }, register: () => Promise.resolve(), stdout: async chunk => {
    concurrent++; peak = Math.max(peak, concurrent);
    await sleep(5); bytes += chunk.length; concurrent--;
  } });
  expect(result.code).toBe(0);
  expect(bytes).toBe(1024 * 1024);
  expect(peak).toBe(1);
});

test('/process 거부면 실제 명령 없이 그룹을 정리한다', async () => {
  const { home, launches } = await setup();
  const fake = installFakeCli(join(home, 'fake'), 'claude');
  await expect(runProcess({ launches, job, launch: { file: fake.path, args: [], cwd: home, env: {}, stdin: '' }, register: () => Promise.reject(new Error('LEASE_LOST')) })).rejects.toThrow('LEASE_LOST');
  expect(fake.calls()).toEqual([]);
  expect(await launches.reconcile({ job: 'job', hostId: 'host', bootId: 'boot', processGroup: null })).toMatchObject({ kind: 'no_process' });
});

test('/process 응답이 늦어도 승인 파이프를 먼저 열지 않는다', async () => {
  const { home, launches } = await setup();
  const fake = installFakeCli(join(home, 'fake'), 'codex');
  const gate = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>();
  const running = runProcess({ launches, job, launch: { file: fake.path, args: [], cwd: home, env: {}, stdin: '' }, register: () => { entered.resolve(undefined); return gate.promise; } });
  try {
    await entered.promise; await sleep(100);
    expect(fake.calls()).toEqual([]);
  } finally { gate.resolve(undefined); await running; }
  expect(fake.calls()).toHaveLength(1);
});

test('SIGTERM 무시 세션도 강제 종료 후에만 해제 증거를 준다', async () => {
  const { home, launches } = await setup();
  const fake = installFakeCli(join(home, 'fake'), 'codex', { hang: true, ignoreSigterm: true, lines: ['ready'] });
  const stop = new AbortController();
  const result = await runProcess({ launches, job, launch: { file: fake.path, args: [], cwd: home, env: {}, stdin: '' }, register: () => Promise.resolve(), signal: stop.signal, graceMs: 30, stdout: () => stop.abort() });
  expect(result.signal).toBe('SIGKILL');
  expect(result.proof.kind).toBe('group_empty');
});

test('launch 기록 유실은 unconfirmed이고 부팅 변경만 해제한다', async () => {
  const { launches } = await setup();
  expect(await launches.reconcile({ job: 'lost', hostId: 'host', bootId: 'boot', processGroup: null })).toBeNull();
  expect(await launches.reconcile({ job: 'lost', hostId: 'host', bootId: 'old', processGroup: 123 })).toEqual({ kind: 'boot_changed', bootId: 'old', currentBootId: 'boot', processGroup: 123 });
});

test('초기화 정리는 pgid가 있는 살아 있는 그룹도 launch 대조 후에 확인한다', async () => {
  const { home } = await setup();
  let empty = false;
  const cleanup = createResetCleanup({ home, identity: () => ({ hostId: 'host', bootId: 'boot' }), groupEmpty: () => empty, launchCheck: () => { empty = true; return Promise.resolve('none'); } });
  const payload: Record<string, unknown> = { holds: [{ job: 'job', host_id: 'host', boot_id: 'boot', pgid: 98765, slot_state: 'active' }] };
  const result = await cleanup({ id: 'reset', kind: 'reset-cleanup', epoch: 0, payload });
  expect(result.status).toBe('done');
});

test.each([false, true])('부모가 정상 종료해도 TERM을 무시하는 자손을 남기지 않는다(detached=%s)', async detached => {
  const { home, launches } = await setup();
  let descendant = 0;
  try {
    const result = await runProcess({ launches, job, launch: { file: process.execPath, args: [join(import.meta.dirname, 'tree.ts'), ...(detached ? ['--detach'] : [])], cwd: home, env: {}, stdin: '' }, register: () => Promise.resolve(), graceMs: 30, stdout: bytes => { descendant = Number(bytes.toString().trim()); } });
    expect(result.proof.kind).toBe('group_empty');
    expect(descendant).toBeGreaterThan(1);
    expect(() => process.kill(descendant, 0)).toThrow();
  } finally {
    if (descendant > 1) try { process.kill(descendant, 'SIGKILL'); } catch { /* 이미 종료됨 */ }
  }
});

test('정리 도중 SIGTERM을 받아 새 그룹으로 분리한 자손도 찾아 강제 종료한다', async () => {
  const { home, launches } = await setup();
  const pidFile = join(home, 'late-child');
  const record = await launches.create(job);
  const child = spawn(process.execPath, [join(import.meta.dirname, 'term-fork.ts'), pidFile], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { AWBS_LAUNCH_ID: record.launchId } });
  try {
    await once(child.stdout, 'data');
    await launches.attach(record, child.pid ?? 0);
    expect(await launches.reconcile({ job: job.id, ...launches.identity, processGroup: record.pgid }, 100)).toMatchObject({ kind: 'group_empty' });
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    child.kill('SIGKILL');
    const pid = await readFile(pidFile, 'utf8').then(Number, () => 0);
    if (pid > 1) try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 종료됨 */ }
  }
});
