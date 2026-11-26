import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, vi } from 'vitest';
import { State } from '../src/state/state.ts';

const fault = vi.hoisted(() => ({ directory: '', fail: false, syncs: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    if (args[0] !== fault.directory || args[1] !== 'r') return file;
    fault.syncs++;
    if (!fault.fail) return file;
    fault.fail = false;
    return new Proxy(file, { get(target, name) {
      if (name === 'sync') return () => Promise.reject(new Error('디렉토리 동기화 실패 주입'));
      const value: unknown = Reflect.get(target, name);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
  } };
});

test.each(['reportUsage', 'reportCommandResult'])('N3 이전 중복 이력(%s)은 묶음마다 한 번만 원문을 써서 변환한다', async (operation) => {
  await mkdir(process.env.AWBS_TEST_TMP ?? tmpdir(), { recursive: true });
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'state-import-'));
  let state = await State.open(home);
  try {
    await state.close();
    await Promise.all(Array.from({ length: 100 }, async () => {
      const id = randomUUID();
      await writeFile(join(home, 'state/rejected', `${id}.json`), JSON.stringify({ id, operation, request: {
        epoch: 0, idempotencyKey: `usage:r:${id}`, body: { agent: 'Codex', remainPct: 1, note: 'x'.repeat(2000) },
        ...(operation === 'reportCommandResult' && { params: { id: 'same-command' } }),
      }, stream: operation, state: 'rejected', attempts: 1, nextAt: 0, code: 'VALIDATION_FAILED' }));
    }));
    fault.directory = join(home, 'state/rejected');
    fault.syncs = 0;
    state = await State.open(home);
    expect(state.rejected).toMatchObject([{ count: 100 }]);
    expect(fault.syncs).toBeLessThanOrEqual(4);
    if (operation === 'reportCommandResult') expect(state.commandDelay(0, 'same-command', Date.now()).delay).toBeGreaterThan(1700_000);
  } finally { await state.close(); fault.directory = ''; await rm(home, { recursive: true, force: true }); }
});

test('리뷰 L4: 디렉토리 동기화 실패 전에는 메모리를 바꾸지 않고 이후 저장도 막는다', async () => {
  await mkdir(process.env.AWBS_TEST_TMP ?? tmpdir(), { recursive: true });
  const home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'state-fault-'));
  const state = await State.open(home);
  try {
    fault.directory = join(home, 'state');
    fault.fail = true;
    await expect(state.update((draft) => { draft.cursor = '새 위치'; })).rejects.toMatchObject({ name: 'StateStorageError' });
    expect(state.snapshot.cursor).toBeNull();
    await expect(state.update((draft) => { draft.cursor = '덮어쓰기'; })).rejects.toMatchObject({ name: 'StateStorageError' });
    expect(JSON.parse(await readFile(join(home, 'state/runner.json'), 'utf8'))).toMatchObject({ cursor: '새 위치' });
  } finally { await state.close(); fault.fail = false; await rm(home, { recursive: true, force: true }); }
});
