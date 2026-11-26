import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, vi } from 'vitest';
import { State } from '../src/state/state.ts';

const fault = vi.hoisted(() => ({ directory: '', fail: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    if (args[0] !== fault.directory || args[1] !== 'r' || !fault.fail) return file;
    fault.fail = false;
    return new Proxy(file, { get(target, name) {
      if (name === 'sync') return () => Promise.reject(new Error('디렉토리 동기화 실패 주입'));
      const value: unknown = Reflect.get(target, name);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
  } };
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
