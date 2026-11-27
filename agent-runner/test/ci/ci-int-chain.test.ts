import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IntegrationQueue } from '../../src/ci/integration/queue.ts';
import { commit, file, fixture, git } from './int-fixture.ts';

vi.setConfig({ testTimeout: 30_000 });

let f: Awaited<ReturnType<typeof fixture>>;
let queues: IntegrationQueue[];
beforeEach(async () => { f = await fixture(); queues = []; });
afterEach(async () => { for (const queue of queues) await queue.close(); await f.close(); });
const open = async () => { const queue = await IntegrationQueue.open(f.deps); queues.push(queue); return queue; };
const puts = () => f.github.requests.filter(r => r.method === 'PUT');

test.each(['main_changed', 'merge_rejected', 'baseline_failed'] as const)('%s 뒤 재시작해도 QA H를 바꾸지 않고 ①·②를 다시 검사한다', async failure => {
  let first = true;
  f.action(async argv => {
    if (failure === 'baseline_failed' && argv[1] === 'install' && first) { first = false; return 1; }
    if (failure === 'main_changed' && argv[1] === 'int-e2e' && first) { first = false; await f.advance(); }
    return 0;
  });
  f.beforeWrite(async op => {
    if (failure === 'merge_rejected' && op.kind === 'merge' && first) { first = false; await f.advance(); }
  });
  const queue = await open();
  const result = await queue.run(f.request);
  const firstHead = f.ref('agent/task');
  expect(result).toMatchObject({ kind: failure === 'baseline_failed' ? 'baseline_failed' : 'recheck',
    qaHeadSha: f.head, syncedHeadSha: firstHead,
    headSync: { qaHeadSha: f.head, headSha: firstHead, parents: [f.head, f.base], preserved: true } });
  if (failure === 'merge_rejected') await queue.acknowledge();
  if (failure === 'baseline_failed') await f.advance('fixed', '기준 수정');
  await queue.close();
  const base = f.ref('main');
  const restarted = await open();
  const merged = await restarted.run(f.request);
  expect(merged).toMatchObject({ kind: 'merged', qaHeadSha: f.head, baseSha: base,
    headSync: { qaHeadSha: f.head, parents: [firstHead, base], preserved: true,
      chain: [{ qaHeadSha: f.head, headSha: firstHead, parents: [f.head, f.base] },
        { qaHeadSha: firstHead, parents: [firstHead, base] }] } });
  expect(f.calls.filter(c => c.argv[1] === 'typecheck')).toHaveLength(failure === 'baseline_failed' ? 1 : 2);
  expect(f.calls.filter(c => c.argv[1] === 'int-e2e')).toHaveLength(failure === 'baseline_failed' ? 1 : 2);
  expect(puts()).toHaveLength(failure === 'merge_rejected' ? 2 : 1);
});

test('main이 두 번 움직여도 H→H′→H″→H‴ 사슬 전체를 증명한다', async () => {
  let moves = 0;
  f.action(async argv => { if (argv[1] === 'int-e2e' && moves < 2) await f.advance(`later-${String(++moves)}`, 'main 변경'); return 0; });
  const queue = await open();
  expect(await queue.run(f.request)).toMatchObject({ kind: 'recheck', headSync: { qaHeadSha: f.head } });
  const first = f.ref('agent/task');
  expect(await queue.run(f.request)).toMatchObject({ kind: 'recheck', headSync: { chain: [
    { qaHeadSha: f.head, headSha: first }, { qaHeadSha: first },
  ] } });
  const second = f.ref('agent/task');
  expect(await queue.run(f.request)).toMatchObject({ kind: 'merged', headSync: { qaHeadSha: f.head, chain: [
    { qaHeadSha: f.head, headSha: first }, { qaHeadSha: first, headSha: second }, { qaHeadSha: second },
  ] } });
  expect(puts()).toHaveLength(1);
});

test('같은 main에서 기준 실패를 재시도하면 이미 만든 H′를 그대로 쓴다', async () => {
  let failed = false;
  f.action(async argv => { if (argv[1] === 'install' && !failed) { failed = true; return 1; } return 0; });
  const queue = await open();
  expect((await queue.run(f.request)).kind).toBe('baseline_failed');
  const head = f.ref('agent/task');
  expect(await queue.run(f.request)).toMatchObject({ kind: 'merged', syncedHeadSha: head, headSync: { qaHeadSha: f.head, headSha: head } });
});

test.each(['linear', 'forged-tree', 'foreign-main'] as const)('사슬 중간의 %s 변경은 재QA하고 검사·병합하지 않는다', async mode => {
  f.action(async () => 1);
  const queue = await open(); expect((await queue.run(f.request)).kind).toBe('baseline_failed');
  const synced = f.ref('agent/task');
  let head: string;
  if (mode === 'linear') {
    git(f.source, 'fetch', f.remote, 'agent/task'); git(f.source, 'checkout', '-B', 'agent/task', 'FETCH_HEAD');
    await file(join(f.source, 'unreviewed'), '검증하지 않은 코드'); head = commit(f.source);
    git(f.source, 'push', f.remote, 'agent/task');
  } else if (mode === 'forged-tree') {
    const base = await f.advance('new-main', 'main 변경');
    head = git(f.remote, 'commit-tree', git(f.remote, 'rev-parse', `${f.base}^{tree}`), '-p', synced, '-p', base, '-m', '잘못된 해결');
    git(f.remote, 'update-ref', 'refs/heads/agent/task', head);
  } else {
    git(f.source, 'checkout', '-b', 'agent/foreign'); await file(join(f.source, 'foreign'), 'main에 없는 코드');
    const foreign = commit(f.source); git(f.source, 'push', f.remote, 'agent/foreign');
    const tree = git(f.remote, 'merge-tree', '--write-tree', '--no-messages', synced, foreign);
    head = git(f.remote, 'commit-tree', tree, '-p', synced, '-p', foreign, '-m', 'main이 아닌 병합');
    git(f.remote, 'update-ref', 'refs/heads/agent/task', head);
  }
  const calls = f.calls.length; f.action(async () => 0);
  expect(await queue.run(f.request)).toMatchObject({ kind: 'recheck', reason: 'head_changed' });
  expect(f.calls).toHaveLength(calls); expect(puts()).toEqual([]); expect(f.ref('agent/task')).toBe(head);
});

test('PR push 경합은 사람의 커밋을 보존하고 head_changed로 돌려준다', async () => {
  const push = f.repo.pushCommit.bind(f.repo);
  let human = '';
  f.repo.pushCommit = async (...args) => {
    git(f.source, 'checkout', 'agent/task'); await file(join(f.source, 'human'), '사람 변경'); human = commit(f.source);
    git(f.source, 'push', f.remote, 'agent/task'); await push(...args);
  };
  expect(await (await open()).run(f.request)).toMatchObject({ kind: 'recheck', reason: 'head_changed' });
  expect(f.ref('agent/task')).toBe(human); expect(puts()).toEqual([]);
});

test('head가 그대로인 push 환경 오류는 원래 예외를 보존한다', async () => {
  f.repo.pushCommit = async () => { throw new Error('push 환경 오류'); };
  await expect((await open()).run(f.request)).rejects.toThrow('push 환경 오류');
  expect(f.ref('agent/task')).toBe(f.head); expect(puts()).toEqual([]);
});

test('성공 status 직후 QA가 바뀌면 pending으로 되돌리고 병합하지 않는다', async () => {
  let statuses = 0;
  f.beforeWrite(async op => {
    if (op.kind === 'status' && op.context === 'agentwbs/int' && ++statuses === 2) f.qa({ passed: true, headSha: f.head, specRevision: 2 });
  });
  expect(await (await open()).run(f.request)).toMatchObject({ kind: 'recheck', reason: 'qa_changed',
    headSync: { qaHeadSha: f.head, headSha: f.ref('agent/task') } });
  expect(f.statuses.get(`${f.ref('agent/task')}:agentwbs/int`)).toBe('pending'); expect(puts()).toEqual([]);
});

// M5·M7 통합 [M7 통합 때] M7-02 P3: 사슬 걷기가 main의 병합 이력을 따라 끝없이 내려가지 않는다.
// 왜: 부모가 [main, main~1]이고 tree가 main과 같은 head는 main의 PR 병합 커밋마다 검사를 통과해, main 병합 수만큼 걷는다.
// 대기열은 직렬이라 다른 PR도 함께 기다린다. 걷는 커밋이 이미 main에 있으면 QA H에 닿을 수 없으므로 바로 끝낸다.
test('main 커밋에 닿은 사슬 걷기는 main 이력을 더 따라가지 않고 재QA(null)로 끝난다', async () => {
  git(f.source, 'checkout', '-q', 'main');
  for (let i = 0; i < 5; i++) {
    git(f.source, 'checkout', '-q', '-b', `pr${String(i)}`); await file(join(f.source, `p${String(i)}`), String(i)); const pr = commit(f.source);
    git(f.source, 'checkout', '-q', 'main');
    const merged = git(f.source, 'commit-tree', git(f.source, 'rev-parse', `${pr}^{tree}`), '-p', 'main', '-p', pr, '-m', `merge ${String(i)}`);
    git(f.source, 'reset', '-q', '--hard', merged);
  }
  git(f.source, 'push', '-q', f.remote, 'main');
  const main = f.ref('main');
  const swapped = git(f.remote, 'commit-tree', git(f.remote, 'rev-parse', `${main}^{tree}`), '-p', main, '-p', `${main}~1`, '-m', 'swapped');
  git(f.remote, 'update-ref', 'refs/heads/agent/task', swapped);
  await f.repo.mainPipeline();
  const head = await f.repo.fetchBranch('agent/task');
  const proofs = vi.spyOn(f.repo, 'integrationProof');
  expect(await f.repo.integrationChainProof(main, f.head, head)).toBeNull();
  expect(proofs.mock.calls.length).toBeLessThanOrEqual(1);
});
