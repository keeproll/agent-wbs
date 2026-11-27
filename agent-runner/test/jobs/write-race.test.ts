// Codex 재리뷰(review2-codex.md) P2·P3 회귀 시험. 리뷰어 재현(R1a~R1d, R2)을 옮기고 기대 결과를 뒤집었다.
// 원칙: 마지막 확인 → 즉시 전송. 소유 확인은 조회·M4 검사·토큰 준비가 끝난 뒤, 실제 전송 바로 앞에서 한다.
import { expect, test } from 'vitest';
import { createGitHubClient, GitHubError } from '../../src/github/client.ts';
import { ownedGitHub, serverWriteGuard } from '../../src/github/write-gate.ts';
import { openPullRequest, PullRequestUnknownError, PushedThenStoppedError } from '../../src/jobs/task-check.ts';
import { IntegrationQueue } from '../../src/ci/integration/queue.ts';
import type { PushGate } from '../../src/git/repository.ts';
import { Secret } from '../../src/security/secret.ts';
import { startFakeGitHub } from '../fakes/github/server.ts';
import { fixture } from '../ci/int-fixture.ts';

const branch = 'agent/TASK-0001-h1';
const job = { id: 'job', fence: 1, kind: 'attempt' as const, leaseUntil: new Date().toISOString(),
  payload: { branch, taskKey: 'TASK-0001', kind: 'dev' as const, agent: 'Claude' as const, baseCommit: 'c'.repeat(40), inputVersion: 1, instructions: {} } };
/** 서버 임대 연장은 늘 성공(60초)한다. 중단은 신호로만 일으킨다. */
const api = (async () => ({ status: 200, body: { leaseUntil: new Date(Date.now() + 60_000).toISOString() } })) as never;
const pull = (n: number) => ({ number: n, state: 'open', merged: false, merge_commit_sha: null, head: { ref: branch, sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) }, html_url: null });
const gatedRepo = { pushCommit: async (_sha: string, b: string, gate: PushGate) => { await gate({ kind: 'branch_push', branch: b, remote: 'https://github.com/o/r' }); } } as never;

test('R1a: PR 조회 응답 시점에 중단되면 그 뒤 PR 생성 POST를 보내지 않는다', async () => {
  const fake = await startFakeGitHub('FAKE');
  const stop = new AbortController(); let writes = 0;
  try {
    fake.on('GET /repos/o/r/pulls', () => { stop.abort(new Error('stop during GET')); return { body: [] }; });
    fake.on('POST /repos/o/r/pulls', () => { writes++; return { status: 201, body: pull(1) }; });
    const client = createGitHubClient({ repo: { owner: 'o', repo: 'r' }, token: async () => new Secret('FAKE'), baseUrl: fake.url });
    const error = await openPullRequest({ repo: gatedRepo, github: client }, job, 'a'.repeat(40), serverWriteGuard(api, job, 1, stop.signal), stop.signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushedThenStoppedError);
    expect(error).toMatchObject({ pull: { kind: 'not_requested' } });
    expect(writes).toBe(0);
  } finally { await fake.close(); }
});

test('R1b: M4 관문 검사 중에 중단되면 REST 쓰기 다섯 가지 모두 보내지 않는다', async () => {
  const fake = await startFakeGitHub('FAKE'); let writes = 0;
  try {
    fake.on('GET /repos/o/r/pulls', () => ({ body: [] }));
    const fail = () => { writes++; return { status: 403, body: { message: 'stale write reached GitHub' } }; };
    fake.on('POST /repos/o/r/pulls', fail);
    fake.on('PATCH /repos/o/r/pulls/:n', fail);
    fake.on(`DELETE /repos/o/r/git/refs/heads/${branch}`, fail);
    fake.on(`GET /repos/o/r/git/ref/heads/${branch}`, () => ({ status: 403 }));
    fake.on('POST /repos/o/r/statuses/:sha', fail);
    fake.on('PUT /repos/o/r/pulls/:n/merge', fail);
    for (const method of ['ensurePullRequest', 'closePullRequest', 'deleteBranch', 'setCommitStatus', 'mergePullRequest'] as const) {
      const stop = new AbortController();
      const client = createGitHubClient({ repo: { owner: 'o', repo: 'r' }, token: async () => new Secret('FAKE'), baseUrl: fake.url,
        beforeWrite: async () => { await Promise.resolve(); stop.abort(new Error('stop during M4 gate')); } });
      const owned = ownedGitHub(client, serverWriteGuard(api, job, 1, stop.signal));
      const calls = {
        ensurePullRequest: () => owned.ensurePullRequest({ branch, title: 't', body: '' }), closePullRequest: () => owned.closePullRequest(1),
        deleteBranch: () => owned.deleteBranch(branch), setCommitStatus: () => owned.setCommitStatus({ sha: 'a'.repeat(40), context: 'agentwbs/int', state: 'pending' }),
        mergePullRequest: () => owned.mergePullRequest({ pr: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }),
      };
      const before = writes;
      await expect(calls[method](), method).rejects.toThrow('stop during M4 gate');
      expect(writes - before, method).toBe(0);
    }
  } finally { await fake.close(); }
});

test('R1c: 실제 통합 대기열이 병합 전 M4 검사 중에 중단되면 병합 PUT을 보내지 않고 main도 그대로다', async () => {
  const f = await fixture(); const stop = new AbortController();
  try {
    f.beforeWrite(async (operation) => { if (operation.kind === 'merge') { await Promise.resolve(); stop.abort(new Error('stop before merge PUT')); } });
    const queue = await IntegrationQueue.open({ ...f.deps, signal: stop.signal, guard: serverWriteGuard(api, job, 1, stop.signal) });
    try {
      const before = f.ref('main');
      await expect(queue.run(f.request)).rejects.toThrow('stop before merge PUT');
      expect(f.ref('main')).toBe(before);
      expect(f.github.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
      expect(f.merged.size).toBe(0);
    } finally { await queue.close(); }
  } finally { await f.close(); }
});

test('R1d: M4 검사 뒤 인증 토큰을 기다리다 중단되면 상태 기록 POST를 보내지 않는다', async () => {
  const fake = await startFakeGitHub('FAKE'); const stop = new AbortController(); let writes = 0;
  try {
    fake.on('POST /repos/o/r/statuses/:sha', () => { writes++; return { status: 201 }; });
    const client = createGitHubClient({ repo: { owner: 'o', repo: 'r' }, baseUrl: fake.url,
      token: async () => { await Promise.resolve(); stop.abort(new Error('stop during token fetch')); return new Secret('FAKE'); } });
    const owned = ownedGitHub(client, serverWriteGuard(api, job, 1, stop.signal));
    await expect(owned.setCommitStatus({ sha: 'a'.repeat(40), context: 'agentwbs/int', state: 'pending' })).rejects.toThrow('stop during token fetch');
    expect(writes).toBe(0);
  } finally { await fake.close(); }
});

test('전송 중에 중단 신호가 오면 진행 중인 요청을 끊는다(응답을 기다리지 않는다)', async () => {
  const fake = await startFakeGitHub('FAKE'); const stop = new AbortController();
  try {
    fake.on('POST /repos/o/r/statuses/:sha', async () => { await new Promise((resolve) => setTimeout(resolve, 3_000)); return { status: 201 }; });
    const client = createGitHubClient({ repo: { owner: 'o', repo: 'r' }, token: async () => new Secret('FAKE'), baseUrl: fake.url, timeoutMs: 10_000 });
    const owned = ownedGitHub(client, async () => undefined, stop.signal);
    const started = performance.now();
    setTimeout(() => { stop.abort(new Error('stop in flight')); }, 100);
    const error = await owned.setCommitStatus({ sha: 'a'.repeat(40), context: 'agentwbs/int', state: 'pending' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ status: 0 });
    expect(performance.now() - started).toBeLessThan(2_000);
  } finally { await fake.close(); }
});

test('R2: PR 생성 응답을 잃고 중단되면 조회로 확인한 실제 PR(#1)을 알린다(「열지 않았다」고 단정하지 않는다)', async () => {
  const f = await fixture(branch); const stop = new AbortController();
  try {
    f.github.on('POST /repos/o/r/pulls', () => { f.opened.add(1); stop.abort(new Error('stop after PR creation')); return { drop: true }; });
    const error = await openPullRequest({ repo: f.repo, github: f.client }, { ...job, payload: { ...job.payload, branch: f.request.branch } }, f.head,
      serverWriteGuard(api, job, 1, stop.signal), stop.signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushedThenStoppedError);
    expect(error).toMatchObject({ pull: { kind: 'opened', number: 1 } });
    expect(String(error)).toContain('PR #1은 이미 열려 있습니다');
    expect(String(error)).not.toContain('열지 않았습니다');
    expect(f.opened.size).toBe(1);
  } finally { await f.close(); }
});

test('PR 생성 응답을 잃고 조회도 실패하면 「모름」으로 알린다', async () => {
  const fake = await startFakeGitHub('FAKE'); let gets = 0; let posts = 0;
  try {
    fake.on('GET /repos/o/r/pulls', () => { gets++; return gets === 1 ? { body: [] } : { drop: true }; });
    fake.on('POST /repos/o/r/pulls', () => { posts++; return { drop: true }; });
    const client = createGitHubClient({ repo: { owner: 'o', repo: 'r' }, token: async () => new Secret('FAKE'), baseUrl: fake.url, timeoutMs: 2_000 });
    const error = await openPullRequest({ repo: gatedRepo, github: client }, job, 'a'.repeat(40)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PullRequestUnknownError);
    expect(String(error)).toContain('모릅니다');
    expect(posts).toBe(1);
  } finally { await fake.close(); }
});

test('PR 생성 응답을 잃고 조회에 PR이 있으면 다시 만들지 않고 그 PR을 쓴다', async () => {
  const fake = await startFakeGitHub('FAKE'); let gets = 0; let posts = 0;
  try {
    fake.on('GET /repos/o/r/pulls', () => { gets++; return { body: gets === 1 ? [] : [pull(5)] }; });
    fake.on('POST /repos/o/r/pulls', () => { posts++; return { drop: true }; });
    const client = createGitHubClient({ repo: { owner: 'o', repo: 'r' }, token: async () => new Secret('FAKE'), baseUrl: fake.url, timeoutMs: 2_000 });
    expect(await openPullRequest({ repo: gatedRepo, github: client }, job, 'a'.repeat(40))).toEqual({ number: 5, head: branch });
    expect(posts).toBe(1);
  } finally { await fake.close(); }
});

// 남는 아주 짧은 틈(마지막 확인과 전송 사이)의 근거: GitHub 쪽 보호.
test('남은 틈의 보호: 병합은 기대 head SHA를 보내므로 head가 바뀌었으면 GitHub가 거부(409)하고 main은 그대로다', async () => {
  const f = await fixture();
  try {
    const before = f.ref('main');
    const outcome = await f.client.mergePullRequest({ pr: 1, baseSha: before, headSha: 'f'.repeat(40) });
    expect(outcome).toMatchObject({ kind: 'head_changed', status: 409 });
    expect(f.ref('main')).toBe(before);
  } finally { await f.close(); }
});

test('남은 틈의 보호: PR 생성은 브랜치 기준 멱등이라 같은 브랜치로 두 번 불려도 PR은 하나다', async () => {
  const f = await fixture(branch);
  try {
    const first = await f.client.ensurePullRequest({ branch, title: 't', body: '' });
    const second = await f.client.ensurePullRequest({ branch, title: 't', body: '' });
    expect(second.number).toBe(first.number);
    expect(f.opened.size).toBe(1);
    expect(f.pullCreates).toHaveLength(1);
  } finally { await f.close(); }
});
