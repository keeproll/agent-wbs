// M5·M7 통합 조정자 결정 1: Runner가 dev 결과를 push하고 같은 head 브랜치의 PR을 쓰거나 연다.
// 실제 M4 GitHub 계층(createGitHubClient)을 fake GitHub 서버에 붙여 시험한다.
// fix2(Codex 통합 리뷰 P2·P3): 외부 쓰기 직전마다 소유·중단을 확인하고, push 전에 M4 쓰기 관문을 거친다.
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ApiError } from '../../src/api/client.ts';
import { bindTaskCheck, ExternalWriteBlockedError, openPullRequest, PushedThenStoppedError, serverWriteGuard } from '../../src/jobs/task-check.ts';
import { createGitHubClient, DeployKeyError, GitHubError, type WriteOperation } from '../../src/github/client.ts';
import { githubWriteGate } from '../../src/github/write-gate.ts';
import type { PushGate } from '../../src/git/repository.ts';
import { Secret } from '../../src/security/secret.ts';
import { commit, file, fixture } from '../ci/int-fixture.ts';
import { startFakeGitHub, type FakeGitHub } from '../fakes/github/server.ts';

const BRANCH = 'agent/TASK-0001-h1';
let fake: FakeGitHub;
let pulls: { number: number; head: string }[];
let creates: number;
let pushes: string[];
const pull = (n: number, head = BRANCH) => ({ number: n, state: 'open', merged: false, merge_commit_sha: null, head: { ref: head, sha: 'a'.repeat(40) },
  base: { ref: 'main', sha: 'b'.repeat(40) }, html_url: null });
const job = { id: 'job', fence: 1, kind: 'attempt' as const, leaseUntil: new Date().toISOString(),
  payload: { taskKey: 'TASK-0001', kind: 'dev' as const, agent: 'Claude' as const, branch: BRANCH, baseCommit: 'c'.repeat(40), inputVersion: 1, instructions: {} } };
const deps = (onDenied?: () => void) => ({
  github: createGitHubClient({ repo: { owner: 'o', repo: 'r' }, token: async () => new Secret('FAKE'), baseUrl: fake.url, timeoutMs: 2_000,
    ...(onDenied && { onPermissionDenied: onDenied }) }),
  repo: { pushCommit: async (commit: string, branch: string, gate: PushGate) => {
    await gate({ kind: 'branch_push', branch, remote: 'https://github.com/o/r' }); pushes.push(`${commit}:${branch}`);
  } } as never,
});
const HEAD = 'd'.repeat(40);

beforeEach(async () => {
  fake = await startFakeGitHub('FAKE'); pulls = []; creates = 0; pushes = [];
  fake.on('GET /repos/o/r/pulls', req => ({ body: pulls.filter(p => `o:${p.head}` === req.query.head).map(p => pull(p.number, p.head)) }));
  fake.on('POST /repos/o/r/pulls', req => {
    creates++; const body = req.body as { head: string };
    if (pulls.some(p => p.head === body.head)) return { status: 422, body: { message: 'exists' } };
    pulls.push({ number: 7, head: body.head }); return { status: 201, body: pull(7, body.head) };
  });
});
afterEach(async () => { await fake.close(); });

test('push한 뒤 열린 PR이 없으면 새로 열고, 다시 불러도 같은 PR을 쓴다(멱등)', async () => {
  const d = deps();
  expect(await openPullRequest(d, job, HEAD)).toEqual({ number: 7, head: BRANCH });
  expect(await openPullRequest(d, job, HEAD)).toEqual({ number: 7, head: BRANCH });
  expect(creates).toBe(1);
  expect(pushes).toEqual([`${HEAD}:${BRANCH}`, `${HEAD}:${BRANCH}`]);
});

test('생성 응답을 잃으면 다시 조회해 이미 만들어진 PR을 쓴다(PR이 둘 생기지 않음)', async () => {
  fake.on('POST /repos/o/r/pulls', req => {
    creates++; const body = req.body as { head: string };
    if (!pulls.some(p => p.head === body.head)) pulls.push({ number: 9, head: body.head });
    return creates === 1 ? { drop: true } : { status: 422, body: { message: 'exists' } };
  });
  expect(await openPullRequest(deps(), job, HEAD)).toEqual({ number: 9, head: BRANCH });
  expect(creates).toBe(1);
});

test('PR 쓰기가 권한 부족 403이면 외부 쓰기 막힘으로 보류하고, 이후에는 push도 하지 않는다', async () => {
  fake.on('POST /repos/o/r/pulls', () => {
    creates++;
    return { status: 403, body: { message: 'Resource not accessible by integration' }, headers: { 'x-accepted-github-permissions': 'pull_requests=write' } };
  });
  let denied = 0;
  const d = deps(() => { denied++; });
  await expect(openPullRequest(d, job, HEAD)).rejects.toBeInstanceOf(ExternalWriteBlockedError);
  expect(d.github.permissions().pulls).toBe('missing');
  await expect.poll(() => denied).toBe(1);
  await expect(openPullRequest(d, job, HEAD)).rejects.toBeInstanceOf(ExternalWriteBlockedError);
  expect(creates).toBe(1);
  expect(pushes).toHaveLength(1);
});

test('GitHub가 연결되지 않았으면 PR을 열지 않는다(서버는 PR 정보 필요로 통합을 보류)', async () => {
  expect(await openPullRequest({ github: null, repo: deps().repo }, job, HEAD)).toBeUndefined();
  expect(pushes).toEqual([]);
});

// Codex 리뷰 P3 재현(rate-limit-403)의 반대 단언: 호출 횟수 제한은 권한 부족이 아니다.
test('호출 횟수 제한 403은 M4 오류(재시도 가능)를 그대로 두고 권한을 missing으로 바꾸지 않는다', async () => {
  fake.on('POST /repos/o/r/pulls', () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '1' }, body: { message: 'API rate limit exceeded' } }));
  const d = deps();
  let error: unknown;
  try { await openPullRequest(d, job, HEAD); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(GitHubError);
  expect(error).not.toBeInstanceOf(ExternalWriteBlockedError);
  expect(error).toMatchObject({ status: 403, retryable: true });
  expect(d.github.permissions().pulls).toBe('unverified');
});

// ---- 실제 Git 저장소(int-fixture)와 fake GitHub ----

async function newWork(f: Awaited<ReturnType<typeof fixture>>) {
  const work = await f.repo.createWorktree('review-work', 'agent/review-work', f.head);
  await file(join(work, 'review-new'), 'new');
  return commit(work);
}
const fixtureJob = (f: Awaited<ReturnType<typeof fixture>>) => ({ ...job, payload: { ...job.payload, branch: f.request.branch } });

// Codex 리뷰 P2-1 재현(abort-during-import)의 반대 단언.
test('결과 커밋을 가져오는 동안 중단되면 push와 PR 생성을 하지 않는다', async () => {
  const f = await fixture(BRANCH);
  try {
    await newWork(f);
    const stop = new AbortController();
    const repo = new Proxy(f.repo, { get(target, name) {
      if (name === 'importWorktree') return async (...args: Parameters<typeof target.importWorktree>) => {
        const head = await target.importWorktree(...args); stop.abort(new Error('lease lost / stop')); return head;
      };
      const value = Reflect.get(target, name) as unknown; return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    } });
    let renews = 0;
    const api = (async (operation: string) => { if (operation === 'renewJob') { renews++; return { status: 200, body: { leaseUntil: new Date(Date.now() + 60_000).toISOString() } }; } throw new Error('must not report'); }) as never;
    const check = bindTaskCheck({ repo, github: f.client, worktree: () => ({ id: 'review-work', branch: 'agent/review-work' }),
      execution: {} as never, runner: {} as never, api, launch: () => { throw new Error('must not execute'); },
      collectTests: f.deps.collectTests, observeMainPipeline: async () => undefined });
    const context = { job: fixtureJob(f), output: { attemptId: 'attempt' }, epoch: 1, signal: stop.signal, messages: [] } as never;
    await expect(check(context)).rejects.toThrow('lease lost / stop');
    expect(f.ref(f.request.branch)).toBe(f.head);
    expect(f.pullCreates).toEqual([]);
    expect(renews).toBe(0);
  } finally { await f.close(); }
});

test('서버가 임대를 잃었다고 하면(409 LEASE_LOST) push와 PR 생성을 하지 않는다', async () => {
  const f = await fixture(BRANCH);
  try {
    const next = await newWork(f);
    await f.repo.importWorktree('review-work', 'agent/review-work');
    const api = (async () => { throw new ApiError('renewJob', 409, { code: 'LEASE_LOST', message: '임대 상실' } as never, null); }) as never;
    const guard = serverWriteGuard(api, job, 1, new AbortController().signal);
    await expect(openPullRequest({ repo: f.repo, github: f.client }, fixtureJob(f), next, guard)).rejects.toBeInstanceOf(ApiError);
    expect(f.ref(f.request.branch)).toBe(f.head);
    expect(f.pullCreates).toEqual([]);
  } finally { await f.close(); }
});

test('push 뒤 PR 직전에 임대를 잃으면 PR을 열지 않고 「이미 push했다」고 사실대로 알린다', async () => {
  const f = await fixture(BRANCH);
  try {
    const next = await newWork(f);
    await f.repo.importWorktree('review-work', 'agent/review-work');
    let checks = 0;
    // 1: 관문 전, 2: push 직전, 3: PR 직전
    const guard = async () => { if (++checks === 3) throw new ApiError('renewJob', 409, { code: 'LEASE_LOST', message: '임대 상실' } as never, null); };
    const error = await openPullRequest({ repo: f.repo, github: f.client }, fixtureJob(f), next, guard).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushedThenStoppedError);
    expect(error).toMatchObject({ branch: f.request.branch, commit: next });
    expect(String(error)).toContain('이미 push');
    expect(f.ref(f.request.branch)).toBe(next);
    expect(f.pullCreates).toEqual([]);
  } finally { await f.close(); }
});

test('임대가 시계 역행 여유보다 짧게 남았으면 쓰지 않는다', async () => {
  const api = (async () => ({ status: 200, body: { leaseUntil: new Date(Date.now() + 2_000).toISOString() } })) as never;
  await expect(serverWriteGuard(api, job, 1, new AbortController().signal)()).rejects.toThrow('임대가 곧 끝나');
});

// Codex 리뷰 P2-2 재현(before-write-denied)의 반대 단언.
test('M4 쓰기 관문(배포 키)이 거부하면 push도 PR 생성도 하지 않는다', async () => {
  const f = await fixture(BRANCH);
  try {
    const next = await newWork(f);
    await f.repo.importWorktree('review-work', 'agent/review-work');
    const seen: WriteOperation[] = [];
    f.beforeWrite(operation => { seen.push(operation); throw new DeployKeyError('unapproved deploy key', -1, false); });
    await expect(openPullRequest({ repo: f.repo, github: f.client }, fixtureJob(f), next)).rejects.toBeInstanceOf(DeployKeyError);
    expect(seen).toEqual([{ kind: 'branch_push', branch: f.request.branch, remote: f.remote }]);
    expect(f.ref(f.request.branch)).toBe(f.head);
    expect(f.pullCreates).toEqual([]);
  } finally { await f.close(); }
});

test('열린 PR을 재사용하는 경로도 push 전에 같은 관문을 거친다', async () => {
  const f = await fixture(BRANCH);
  try {
    const next = await newWork(f);
    await f.repo.importWorktree('review-work', 'agent/review-work');
    f.opened.add(1);
    f.beforeWrite(() => { throw new DeployKeyError('unapproved deploy key', -1, false); });
    await expect(openPullRequest({ repo: f.repo, github: f.client }, fixtureJob(f), next)).rejects.toBeInstanceOf(DeployKeyError);
    expect(f.ref(f.request.branch)).toBe(f.head);
  } finally { await f.close(); }
});

test('앱 쓰기 관문: push 원격이 설정 저장소와 다르면 키 검사 전에 거부하고, 같으면 배포 키 검사를 한다', async () => {
  let keyChecks = 0;
  const gate = githubWriteGate('https://github.com/o/r', async () => { keyChecks++; });
  await expect(gate({ kind: 'branch_push', branch: BRANCH, remote: 'https://github.com/evil/r' })).rejects.toThrow('원격');
  expect(keyChecks).toBe(0);
  await gate({ kind: 'branch_push', branch: BRANCH, remote: 'https://github.com/O/r.git' });
  await gate({ kind: 'pull_create', branch: BRANCH });
  expect(keyChecks).toBe(2);
});
