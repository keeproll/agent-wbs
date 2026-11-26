import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { IntegrationQueue } from '../../src/ci/integration/queue.ts';
import { commit, file, fixture, git } from './int-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
let queues: IntegrationQueue[];
beforeEach(async () => { f = await fixture(); queues = []; });
afterEach(async () => { for (const queue of queues) await queue.close(); await f.close(); });
const open = async () => { const queue = await IntegrationQueue.open(f.deps); queues.push(queue); return queue; };
const puts = () => f.github.requests.filter(r => r.method === 'PUT');

test('H,A 자동 병합 뒤 같은 H′에서 ①·②를 검사하고 head status·부모·tree를 보고한다', async () => {
  const queue = await open(); const result = await queue.run(f.request);
  expect(result.kind).toBe('merged');
  if (result.kind !== 'merged') throw new Error('병합 실패');
  expect(result).toMatchObject({ baseSha: f.base, qaHeadSha: f.head,
    mergeParents: [f.base, result.syncedHeadSha], actualTreeSha: result.testedTreeSha,
    pipelineSha: git(f.remote, 'rev-parse', `${f.base}:.agentwbs/pipeline.yaml`),
    headSync: { parents: [f.head, f.base], preserved: true, additionalChanges: false } });
  expect(git(f.remote, 'rev-parse', `${result.actualMergeSha}^{tree}`)).toBe(result.testedTreeSha);
  expect(f.calls.map(c => c.argv[1])).toEqual(['install', 'install', 'typecheck', 'lint', 'unit', 'build', 'contract',
    'install', 'int-build', 'int-test', 'int-migrate', 'int-services', 'int-health', 'int-e2e']);
  expect(f.statuses.get(`${result.syncedHeadSha}:agentwbs/int`)).toBe('success');
  expect(puts()).toHaveLength(1);
  expect(f.observations).toEqual([{ baseSha: f.base, pipelineSha: result.pipelineSha }]);
  expect(f.deps.heavy.snapshot().running).toBe(0);
  expect(await f.repo.recordedWorktrees()).toEqual([]);
  expect(await readFile(join(f.root, 'journal', 'merge.json'), 'utf8')).toContain(result.actualMergeSha);
});

test('H가 이미 A를 포함하면 H를 바꾸지 않고 그대로 검사·병합한다', async () => {
  const ancestor = git(f.remote, 'rev-parse', `${f.head}^1`);
  git(f.remote, 'update-ref', 'refs/heads/main', ancestor);
  const result = await (await open()).run(f.request);
  expect(result).toMatchObject({ kind: 'merged', baseSha: ancestor, syncedHeadSha: f.head });
  expect(result).not.toHaveProperty('headSync');
});

test('main과 PR 충돌이면 병합 없이 원인 Task를 재작업으로 넘긴다', async () => {
  await f.advance('shared', 'main');
  git(f.source, 'checkout', 'agent/task'); await file(join(f.source, 'shared'), 'task');
  const head = commit(f.source); git(f.source, 'push', f.remote, 'agent/task');
  f.qa({ passed: true, headSha: head, specRevision: 1 });
  expect(await (await open()).run({ ...f.request, qaHeadSha: head })).toMatchObject({ kind: 'rework', reason: 'conflict' });
  expect(f.calls).toEqual([]); expect(puts()).toEqual([]);
});

test('main 정의 관측 보고를 보관하지 못하면 검사와 병합을 시작하지 않는다', async () => {
  const queue = await IntegrationQueue.open({ ...f.deps, observeMainPipeline: async () => { throw new Error('관측 보관 실패'); } });
  queues.push(queue);
  await expect(queue.run(f.request)).rejects.toThrow('관측 보관 실패');
  expect(f.calls).toEqual([]); expect(puts()).toEqual([]);
});

test('검사 후 main A→B이면 병합하지 않고 새 A로 재검사한다', async () => {
  let moved = false;
  f.action(async argv => { if (argv[1] === 'int-e2e' && !moved) { moved = true; await f.advance(); } return 0; });
  const queue = await open();
  expect(await queue.run(f.request)).toMatchObject({ kind: 'recheck', reason: 'main_changed' });
  expect(puts()).toEqual([]); expect(f.merged.size).toBe(0);
  const latestBase = f.ref('main'); const latestHead = f.ref('agent/task');
  f.qa({ passed: true, headSha: latestHead, specRevision: 1 });
  const result = await queue.run({ ...f.request, qaHeadSha: latestHead });
  expect(result).toMatchObject({ kind: 'merged', baseSha: latestBase });
  expect(f.calls.filter(c => c.argv[1] === 'int-e2e')).toHaveLength(2);
});

test.each(['before', 'during'] as const)('QA 후 H 변경(%s)은 QA를 무효화하고 병합하지 않는다', async when => {
  const move = async () => {
    git(f.source, 'fetch', f.remote, 'agent/task'); git(f.source, 'checkout', '-B', 'agent/task', 'FETCH_HEAD');
    await file(join(f.source, 'unreviewed'), '추가 변경');
    commit(f.source); git(f.source, 'push', f.remote, 'agent/task'); git(f.source, 'checkout', 'main');
  };
  if (when === 'before') await move();
  else f.action(async argv => { if (argv[1] === 'int-e2e') await move(); return 0; });
  expect(await (await open()).run(f.request)).toMatchObject({ kind: 'recheck', reason: 'head_changed' });
  expect(f.merged.size).toBe(0); expect(puts()).toEqual([]);
});

test('QA 명세 버전이 검사 중 바뀌면 재검증한다', async () => {
  f.action(async argv => { if (argv[1] === 'int-e2e') f.qa({ passed: true, headSha: f.head, specRevision: 2 }); return 0; });
  expect(await (await open()).run(f.request)).toMatchObject({ kind: 'recheck', reason: 'qa_changed' });
  expect(puts()).toEqual([]);
});

test('① 실패 중 QA가 바뀌어도 낡은 결과를 Task 재작업으로 보고하지 않는다', async () => {
  f.action(async argv => {
    if (argv[1] !== 'typecheck') return 0;
    f.qa({ passed: true, headSha: f.head, specRevision: 2 }); return 1;
  });
  expect(await (await open()).run(f.request)).toMatchObject({ kind: 'recheck', reason: 'qa_changed' });
  expect(puts()).toEqual([]);
});

test.each(['main', 'head'] as const)('병합 호출 직전 %s 이동도 strict·예상 SHA로 거부하고 다시 검사한다', async target => {
  f.beforeWrite(async op => {
    if (op.kind !== 'merge') return;
    if (target === 'main') await f.advance();
    else {
      git(f.source, 'fetch', f.remote, 'agent/task'); git(f.source, 'checkout', '-B', 'agent/task', 'FETCH_HEAD');
      await file(join(f.source, 'late'), 'late'); commit(f.source); git(f.source, 'push', f.remote, 'agent/task');
    }
  });
  expect(await (await open()).run(f.request)).toMatchObject({ kind: 'recheck' });
  expect(f.merged.size).toBe(0); expect(puts()).toHaveLength(1);
});

test('② 실패는 미병합·재작업이며 남은 단계는 건너뛴다', async () => {
  f.action(async argv => argv[1] === 'int-migrate' ? 1 : 0);
  expect(await (await open()).run(f.request)).toMatchObject({ kind: 'rework', integration: { failStep: 'migrate', status: 'fail' } });
  expect(f.calls.some(c => c.argv[1] === 'int-health')).toBe(false);
  expect(f.statuses.get(`${f.ref('agent/task')}:agentwbs/int`)).toBe('failure');
  expect(puts()).toEqual([]);
});

test('테스트 실패는 한 번 재시도하고 재시도 통과를 불안정 후보로 남긴다', async () => {
  let count = 0; f.action(async argv => argv[1] === 'int-test' && count++ === 0 ? 1 : 0);
  const result = await (await open()).run(f.request);
  expect(result).toMatchObject({ kind: 'merged', integration: { flakyCandidates: ['test'] } });
});

test('검사 파일 변조·중단은 성공으로 보고하지 않고 사본과 번호표를 정리한다', async () => {
  f.action(async (argv, cwd) => { if (argv[1] === 'int-build') await file(join(cwd, 'task'), '변조'); return 0; });
  expect(await (await open()).run(f.request)).toMatchObject({ kind: 'rework', integration: { failStep: 'build' } });
  expect(puts()).toEqual([]); expect(f.deps.heavy.snapshot().running).toBe(0);
  expect(await f.repo.recordedWorktrees()).toEqual([]);
});

test('병합 직후 crash는 재시작 후 쓰기 없는 대조로 확정하며 다음 PR을 막는다', async () => {
  const real = f.client.mergePullRequest;
  f.client.mergePullRequest = async input => { await real(input); throw new Error('crash'); };
  const queue = await open(); await expect(queue.run(f.request)).rejects.toThrow('crash');
  await queue.close();
  const restarted = await open();
  expect(await restarted.run({ ...f.request, pr: 2, branch: 'agent/task2' })).toMatchObject({ kind: 'blocked' });
  const result = await restarted.reconcile();
  expect(result).toMatchObject({ kind: 'merged', mergeParents: [f.base, f.ref('agent/task')] });
  expect(puts()).toHaveLength(1);
  await restarted.acknowledge();
  expect(await restarted.reconcile()).toBeNull();
});

test('다른 대기열 인스턴스의 동시 실행을 파일 잠금으로 막는다', async () => {
  await open(); await expect(open()).rejects.toThrow();
});

test('① 기준 설치 실패는 Task 재작업으로 돌리지 않고 baseline 근거로 보류한다', async () => {
  f.action(async argv => argv[1] === 'install' ? 1 : 0);
  expect(await (await open()).run(f.request)).toMatchObject({ kind: 'baseline_failed', failScope: 'baseline',
    task: { failScope: 'baseline', failStep: 'baseline-install' } });
  expect(f.statuses.get(`${f.ref('agent/task')}:agentwbs/int`)).toBe('error');
  expect(puts()).toEqual([]);
});

test('① Task 코드 실패는 Task 재작업이며 H′의 status에도 실패를 남긴다', async () => {
  f.action(async argv => argv[1] === 'typecheck' ? 1 : 0);
  expect(await (await open()).run(f.request)).toMatchObject({ kind: 'rework', failScope: 'task', reason: 'task_failed' });
  expect(f.statuses.get(`${f.ref('agent/task')}:agentwbs/task`)).toBe('failure');
  expect(f.statuses.get(`${f.ref('agent/task')}:agentwbs/int`)).toBe('failure');
  expect(f.calls.some(c => c.argv[1] === 'int-build')).toBe(false); expect(puts()).toEqual([]);
});

test('② 중단은 테스트 재시도를 하지 않고 출력과 정리를 보존한다', async () => {
  const controller = new AbortController();
  const queue = await IntegrationQueue.open({ ...f.deps, signal: controller.signal }); queues.push(queue);
  f.action(async argv => { if (argv[1] === 'int-test') controller.abort(new Error('중단')); return 0; });
  expect(await queue.run(f.request)).toMatchObject({ kind: 'rework', integration: { status: 'fail', failStep: 'test' } });
  expect(f.calls.filter(c => c.argv[1] === 'int-test')).toHaveLength(1);
  expect(f.deps.heavy.snapshot().running).toBe(0); expect(await f.repo.recordedWorktrees()).toEqual([]);
  expect(puts()).toEqual([]);
});

test('손상된 병합 기록은 지우거나 새 작업으로 넘기지 않는다', async () => {
  const queue = await open(); await queue.close();
  await writeFile(join(f.root, 'journal', 'merge.json'), '{broken');
  await expect(open()).rejects.toThrow();
  expect(await readFile(join(f.root, 'journal', 'merge.json'), 'utf8')).toBe('{broken');
  expect(puts()).toEqual([]);
});

test('복구 기록의 실제 병합 SHA가 빠졌으면 성공으로 재생하지 않는다', async () => {
  const queue = await open(); expect((await queue.run(f.request)).kind).toBe('merged'); await queue.close();
  const path = join(f.root, 'journal', 'merge.json');
  const journal = JSON.parse(await readFile(path, 'utf8')) as { outcome: unknown };
  journal.outcome = { kind: 'merged' }; await writeFile(path, JSON.stringify(journal));
  await expect(open()).rejects.toThrow();
});

test('병합 응답 유실·조회 지연은 unknown을 유지하고 재병합하지 않는다', async () => {
  f.github.on('PUT /repos/o/r/pulls/:n/merge', () => ({ drop: true }));
  const queue = await open(); expect(await queue.run(f.request)).toMatchObject({ kind: 'unknown' });
  await expect(queue.acknowledge()).rejects.toThrow();
  expect(await queue.reconcile()).toMatchObject({ kind: 'unknown' });
  expect(await queue.run(f.request)).toMatchObject({ kind: 'blocked' });
  expect(puts()).toHaveLength(1);
});

test('확정된 405 거부는 재시작해도 미확정으로 되돌리지 않는다', async () => {
  f.github.on('PUT /repos/o/r/pulls/:n/merge', () => ({ status: 405 }));
  const queue = await open(); expect(await queue.run(f.request)).toMatchObject({ kind: 'recheck', reason: 'merge_rejected' });
  await queue.close();
  const restarted = await open();
  expect(await restarted.reconcile()).toMatchObject({ kind: 'recheck', reason: 'merge_rejected' });
  await restarted.acknowledge(); expect(puts()).toHaveLength(1);
});

test('실제 병합 tree가 다르면 SHA·경고를 남기고 대기열을 보류한다', async () => {
  f.github.on('PUT /repos/o/r/pulls/:n/merge', req => {
    const head = (req.body as { sha: string }).sha;
    const sha = git(f.remote, 'commit-tree', git(f.remote, 'rev-parse', `${f.base}^{tree}`), '-p', f.base, '-p', head, '-m', 'bad');
    git(f.remote, 'update-ref', 'refs/heads/main', sha); f.merged.set(1, sha); return { body: { sha } };
  });
  const queue = await open();
  expect(await queue.run(f.request)).toMatchObject({ kind: 'verify_failed', actualMergeSha: f.ref('main') });
  await expect(queue.acknowledge()).rejects.toThrow();
  expect(await queue.run(f.request)).toMatchObject({ kind: 'blocked' });
});

test('병합 대기열은 여러 요청을 동시에 받아도 한 건만 검사·병합한다', async () => {
  const queue = await open();
  const results = await Promise.all([queue.run(f.request), queue.run(f.request)]);
  expect(results.map(r => r.kind)).toEqual(['merged', 'blocked']); expect(puts()).toHaveLength(1);
});
