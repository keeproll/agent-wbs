import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { IntegrationQueue } from '../../src/ci/integration/queue.ts';
import { commit, file, fixture, git } from './int-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
let queue: IntegrationQueue | undefined;
let second: { pr: number; branch: string; qaHeadSha: string; specRevision: number };
beforeEach(async () => {
  f = await fixture();
  git(f.source, 'checkout', '-b', 'agent/task2');
  await file(join(f.source, 'second'), 'second'); const head = commit(f.source);
  git(f.source, 'push', f.remote, 'agent/task2'); git(f.source, 'checkout', 'main');
  second = { pr: 2, branch: 'agent/task2', qaHeadSha: head, specRevision: 1 };
  const deps = { ...f.deps, readVerification: async (r: typeof second) => ({ passed: true, headSha: r.qaHeadSha, specRevision: 1 }) };
  queue = await IntegrationQueue.open(deps);
});
afterEach(async () => { await queue?.close(); queue = undefined; await f.close(); });

test('묶음 확인은 예비 검사일 뿐 성공해도 push·status·병합하지 않는다', async () => {
  const result = await queue?.checkBatch([f.request, second]);
  expect(result).toMatchObject({ kind: 'diagnostic', runs: [{ prs: [1, 2], status: 'pass' }] });
  expect(f.github.requests.every(r => r.method === 'GET')).toBe(true);
  expect(f.ref('agent/task')).toBe(f.head); expect(f.ref('main')).toBe(f.base);
  expect(await f.repo.recordedWorktrees()).toEqual([]);
});

test('묶음 실패는 반으로 나눠 원인 PR을 찾으며 각 묶음은 같은 A에서 시작한다', async () => {
  f.action(async (argv, cwd) => argv[1] === 'int-test' && await import('node:fs/promises').then(fs => fs.stat(join(cwd, 'second')).then(() => true, () => false)) ? 1 : 0);
  const result = await queue?.checkBatch([f.request, second]);
  expect(result).toMatchObject({ kind: 'diagnostic', suspects: [2], runs: [
    { prs: [1, 2], status: 'fail' }, { prs: [1], status: 'pass' }, { prs: [2], status: 'fail' },
  ] });
  expect(f.merged.size).toBe(0); expect(f.deps.heavy.snapshot().running).toBe(0);
});

test('잘못된 묶음과 중복 PR은 실행 전에 거부한다', async () => {
  await expect(queue?.checkBatch([])).rejects.toThrow();
  await expect(queue?.checkBatch([f.request, f.request])).rejects.toThrow();
  await expect(queue?.checkBatch([f.request, { ...second, qaHeadSha: 'bad' }])).rejects.toThrow();
  expect(f.calls).toEqual([]);
  expect(f.github.requests).toEqual([]);
});

test('각 PR은 통과하고 조합에서만 실패하면 상호작용 후보를 남긴다', async () => {
  f.action(async (argv, cwd) => argv[1] === 'int-test' &&
    await stat(join(cwd, 'task')).then(() => true, () => false) &&
    await stat(join(cwd, 'second')).then(() => true, () => false) ? 1 : 0);
  expect(await queue?.checkBatch([f.request, second])).toMatchObject({ kind: 'diagnostic', suspects: [], interactions: [[1, 2]],
    runs: [{ prs: [1, 2], status: 'fail' }, { prs: [1], status: 'pass' }, { prs: [2], status: 'pass' }] });
  expect(f.github.requests.every(r => r.method === 'GET')).toBe(true);
});

test('묶음 확인도 증명된 H′를 원래 QA H로 검사한다', async () => {
  f.action(async () => 1);
  expect((await queue?.run(f.request))?.kind).toBe('baseline_failed');
  const head = f.ref('agent/task'); const requests = f.github.requests.length;
  f.action(async () => 0);
  expect(await queue?.checkBatch([f.request, second])).toMatchObject({ kind: 'diagnostic', runs: [{ prs: [1, 2], status: 'pass' }] });
  expect(f.ref('agent/task')).toBe(head);
  expect(f.github.requests.slice(requests).every(r => r.method === 'GET')).toBe(true);
});
