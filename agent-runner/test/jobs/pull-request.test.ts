// M5·M7 통합 조정자 결정 1: Runner가 dev 결과를 push하고 같은 head 브랜치의 PR을 쓰거나 연다.
// 실제 M4 GitHub 계층(createGitHubClient)을 fake GitHub 서버에 붙여 시험한다.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ExternalWriteBlockedError, openPullRequest } from '../../src/jobs/task-check.ts';
import { createGitHubClient } from '../../src/github/client.ts';
import { Secret } from '../../src/security/secret.ts';
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
  repo: { pushCommit: async (commit: string, branch: string) => { pushes.push(`${commit}:${branch}`); } } as never,
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

test('PR 쓰기가 403이면 외부 쓰기 막힘으로 보류하고, 이후에는 push도 하지 않는다', async () => {
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
