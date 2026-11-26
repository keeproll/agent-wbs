import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createResetCleanup, parseResetPayload, processGroupEmpty } from '../../src/cleanup/reset.ts';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'reset-cleanup-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const identity = () => ({ hostId: 'h1', bootId: 'b1' });
const command = (payload: Record<string, unknown>) => ({ id: 'c1', kind: 'reset-cleanup' as const, epoch: 1, payload });
const payload = (holds: unknown[], extra: Record<string, unknown> = {}) => ({ projectId: 'p1', baseCommit: null, branches: [], holds, ...extra });

test('보유별 증거: 예약 전 no_process, 부팅 변경 boot_changed, 빈 그룹 group_empty', async () => {
  const cleanup = createResetCleanup({ home, identity, groupEmpty: (pgid) => pgid === 77 });
  const result = await cleanup(command(payload([
    { job: 'j0', hostId: null, bootId: null, processGroup: null },
    { job: 'j1', hostId: 'h1', bootId: 'old-boot', processGroup: 55 },
    { job: 'j2', hostId: 'h1', bootId: 'b1', processGroup: 77 },
  ])));
  expect(result).toMatchObject({ status: 'done', holds: [
    { job: 'j0', hostId: null, proof: 'no_process' },
    { job: 'j1', proof: 'boot_changed', processGroup: 55, currentBootId: 'b1' },
    { job: 'j2', proof: 'group_empty', processGroup: 77 },
  ] });
});

test('하나라도 종료를 증명하지 못하면 failed이고 git 정리를 하지 않는다', async () => {
  const cleanup = createResetCleanup({ home, identity, groupEmpty: () => false });
  for (const hold of [
    { job: 'j', hostId: 'h1', bootId: 'b1', processGroup: 77 }, // 살아 있는 그룹: 죽이지 않는다
    { job: 'j', hostId: 'other', bootId: 'b1', processGroup: 77 }, // 다른 PC
    { job: 'j', hostId: 'h1', bootId: 'b1', processGroup: null }, // launch 기록 확인 불가
  ]) {
    const result = await cleanup(command(payload([hold], { projectId: 'missing-repo-but-not-touched' })));
    expect(result.status).toBe('failed');
    expect(result.items.map((i) => i.name)).toEqual(['hold:j']);
    expect('holds' in result ? result.holds : undefined).toBeUndefined();
  }
});

test('pgid 없는 보유는 launch 대조가 none일 때만 no_process', async () => {
  const cleanup = createResetCleanup({ home, identity, launchCheck: () => Promise.resolve('none') });
  const result = await cleanup(command(payload([{ job: 'j', hostId: 'h1', bootId: 'b1', processGroup: null }])));
  expect(result).toMatchObject({ status: 'done', holds: [{ proof: 'no_process', hostId: 'h1' }] });
});

test('원격 브랜치 정리가 필요한데 원격 쓰기가 연결되지 않았으면 failed', async () => {
  const cleanup = createResetCleanup({ home, identity });
  const result = await cleanup(command(payload([], { branches: ['agent/T1-h1'] })));
  expect(result).toMatchObject({ status: 'failed', items: [{ name: 'git:local', ok: true }, { name: 'github:branches', ok: false }] });
});

test.each([
  [{ projectId: '../x', baseCommit: null, branches: [], holds: [] }],
  [{ projectId: 'p', baseCommit: 'main', branches: [], holds: [] }],
  [{ projectId: 'p', baseCommit: null, branches: ['main'], holds: [] }],
  [{ projectId: 'p', baseCommit: null, branches: [] }],
  [{ projectId: 'p', baseCommit: null, branches: [], holds: [{ job: 'j', hostId: 'h', bootId: 'b', processGroup: 1 }] }],
])('payload 형식이 다르면 추정하지 않고 failed: %j', async (bad) => {
  expect(() => parseResetPayload(bad)).toThrow();
  const result = await createResetCleanup({ home, identity })(command(bad));
  expect(result).toMatchObject({ status: 'failed', items: [{ name: 'payload', ok: false }] });
});

test('processGroupEmpty: 살아 있는 그룹은 비지 않았고, 끝난 그룹은 비었다', async () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const pgid = child.pid ?? 0;
  try {
    expect(processGroupEmpty(pgid)).toBe(false);
  } finally {
    process.kill(-pgid, 'SIGKILL');
    await once(child, 'exit');
  }
  expect(processGroupEmpty(pgid)).toBe(true);
});
