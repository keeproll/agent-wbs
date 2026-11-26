import { afterEach, describe, expect, test } from 'vitest';
import { createGitHubClient, GitHubError, type WriteOperation } from '../../src/github/client.ts';
import { Secret } from '../../src/security/secret.ts';
import { GitHubModel, type ModelOptions } from '../fakes/github/model.ts';
import { startFakeGitHub, type FakeGitHub } from '../fakes/github/server.ts';

const TOKEN = 'ghp_FAKEfakeFAKEfakeFAKEfake0123456789';
const BRANCH = 'agent/TASK-0001';

let github: FakeGitHub;
let model: GitHubModel;
let writes: { op: WriteOperation; requestsBefore: number }[];

async function setup(options: ModelOptions = {}) {
  github = await startFakeGitHub(TOKEN);
  model = new GitHubModel(options);
  model.install(github);
  writes = [];
  const client = createGitHubClient({
    baseUrl: github.url,
    repo: { owner: model.owner, repo: model.repo },
    token: () => Promise.resolve(new Secret(TOKEN)),
    beforeWrite: (op) => {
      writes.push({ op, requestsBefore: github.requests.length });
      return Promise.resolve();
    },
  });
  // QA까지 끝난 PR: head H가 main A를 포함하고 int가 H에 success
  const head = model.push(BRANCH);
  model.openPull(BRANCH);
  const base = model.branches.get('main') ?? '';
  return { client, head, base };
}

const nonGet = () => github.requests.filter((r) => r.method !== 'GET');

afterEach(async () => {
  await github.close();
});

describe('PR 병합 — strict + 예상 head 단일 경로 (contracts §4.1 코드 근거 고정 3)', () => {
  test('H′에 int가 있으면 sha=H′, merge_method=merge로 병합하고 부모·tree를 확인한다', async () => {
    const { client, head, base } = await setup();
    model.setStatus(head, 'agentwbs/int', 'success');
    const outcome = await client.mergePullRequest({ pr: 1, baseSha: base, headSha: head });
    const mergeSha = model.branches.get('main') ?? '';
    expect(outcome).toEqual({
      kind: 'merged',
      mergeSha,
      treeSha: model.commits.get(head)?.tree,
    });
    expect(model.commits.get(mergeSha)?.parents).toEqual([base, head]);
    // 병합에 쓰는 쓰기 호출은 PUT /merge 하나뿐이다(main 직접 push·ref 갱신 없음).
    expect(nonGet()).toEqual([
      { method: 'PUT', path: '/repos/o/r/pulls/1/merge', query: {}, body: { sha: head, merge_method: 'merge' }, params: { owner: 'o', repo: 'r', number: '1' } },
    ]);
    github.assertNoUnexpected();
  });

  test('beforeWrite(세대 대조)는 PUT /merge 바로 앞에서 불린다', async () => {
    const { client, head, base } = await setup();
    model.setStatus(head, 'agentwbs/int', 'success');
    await client.mergePullRequest({ pr: 1, baseSha: base, headSha: head });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.op).toEqual({ kind: 'merge', pr: 1, headSha: head });
    expect(github.requests.slice(writes[0]?.requestsBefore).at(0)?.method).toBe('PUT');
  });

  test('main 동기화로 만든 H′(부모 H,A)도 같은 경로로 병합된다', async () => {
    const { client, head } = await setup();
    model.push('main', ['other.txt']);
    const base = model.branches.get('main') ?? '';
    const synced = model.syncWithMain(BRANCH);
    expect(model.commits.get(synced)?.parents).toEqual([head, base]);
    model.setStatus(synced, 'agentwbs/int', 'success');
    const outcome = await client.mergePullRequest({ pr: 1, baseSha: base, headSha: synced });
    expect(outcome.kind).toBe('merged');
  });

  test('QA 뒤 head가 바뀌면 409 → head_changed, main은 그대로', async () => {
    const { client, head, base } = await setup();
    model.setStatus(head, 'agentwbs/int', 'success');
    const moved = model.push(BRANCH);
    model.setStatus(moved, 'agentwbs/int', 'success');
    const outcome = await client.mergePullRequest({ pr: 1, baseSha: base, headSha: head });
    expect(outcome).toMatchObject({ kind: 'head_changed', status: 409 });
    expect(model.branches.get('main')).toBe(base);
  });

  test('main이 움직이면 strict 보호가 405 → rejected', async () => {
    const { client, head, base } = await setup();
    model.setStatus(head, 'agentwbs/int', 'success');
    model.push('main', ['other.txt']);
    const outcome = await client.mergePullRequest({ pr: 1, baseSha: base, headSha: head });
    expect(outcome).toMatchObject({ kind: 'rejected', status: 405 });
    expect(model.pulls.get(1)?.merged).toBe(false);
  });

  test('int가 없으면 405 → rejected', async () => {
    const { client, head, base } = await setup();
    model.setStatus(head, 'agentwbs/int', 'pending');
    expect(await client.mergePullRequest({ pr: 1, baseSha: base, headSha: head })).toMatchObject({
      kind: 'rejected',
      status: 405,
    });
  });

  test('응답이 유실되어도 PR을 대조해 병합을 확인한다', async () => {
    const { client, head, base } = await setup();
    model.setStatus(head, 'agentwbs/int', 'success');
    model.dropNextMerge = true;
    const outcome = await client.mergePullRequest({ pr: 1, baseSha: base, headSha: head });
    expect(outcome).toMatchObject({ kind: 'merged', mergeSha: model.branches.get('main'), reconciled: true });
    expect(nonGet()).toHaveLength(1);
  });

  test('응답 유실 뒤 대조해 보니 병합되지 않았으면 not_merged (다시 호출하지 않음)', async () => {
    const { client, head, base } = await setup();
    model.setStatus(head, 'agentwbs/int', 'success');
    github.on('PUT /repos/:owner/:repo/pulls/:number/merge', () => ({ drop: true }));
    const outcome = await client.mergePullRequest({ pr: 1, baseSha: base, headSha: head });
    expect(outcome).toMatchObject({ kind: 'not_merged', reconciled: true });
    expect(nonGet()).toHaveLength(1);
  });

  test('5xx도 결과를 모르는 것으로 보고 대조한다', async () => {
    const { client, head, base } = await setup();
    model.setStatus(head, 'agentwbs/int', 'success');
    github.on('PUT /repos/:owner/:repo/pulls/:number/merge', (request) => {
      model.merge(1, request.body as { sha: string; merge_method: string });
      return { status: 502, body: { message: 'Bad Gateway' } };
    });
    expect(await client.mergePullRequest({ pr: 1, baseSha: base, headSha: head })).toMatchObject({
      kind: 'merged',
      reconciled: true,
    });
  });

  test('대조 조회까지 실패하면 unknown이며 done으로 만들 근거가 없다', async () => {
    const { client, head, base } = await setup();
    model.setStatus(head, 'agentwbs/int', 'success');
    model.dropNextMerge = true;
    github.on('GET /repos/:owner/:repo/pulls/:number', () => ({ drop: true }));
    const outcome = await client.mergePullRequest({ pr: 1, baseSha: base, headSha: head });
    expect(outcome.kind).toBe('unknown');
  });

  test.each(['parents', 'tree'] as const)('병합 커밋의 %s가 기대와 다르면 verify_failed', async (corrupt) => {
    const { client, head, base } = await setup();
    model.setStatus(head, 'agentwbs/int', 'success');
    model.corruptMerge = corrupt;
    const outcome = await client.mergePullRequest({ pr: 1, baseSha: base, headSha: head });
    expect(outcome).toMatchObject({ kind: 'verify_failed', mergeSha: model.branches.get('main') });
  });

  test('병합 커밋의 첫 부모가 대기열이 고정한 A가 아니면 verify_failed', async () => {
    const { client, base } = await setup();
    model.push('main', ['other.txt']);
    const synced = model.syncWithMain(BRANCH);
    model.setStatus(synced, 'agentwbs/int', 'success');
    // 대기열이 고정한 A(base)와 실제 병합 시점의 main이 다르다.
    const outcome = await client.mergePullRequest({ pr: 1, baseSha: base, headSha: synced });
    expect(outcome).toMatchObject({ kind: 'verify_failed', reason: expect.stringMatching(/부모/) as unknown });
  });

  test('대조에서 다른 head로 병합된 PR을 발견하면 verify_failed', async () => {
    const { client, head, base } = await setup();
    const moved = model.push(BRANCH);
    model.setStatus(moved, 'agentwbs/int', 'success');
    github.on('PUT /repos/:owner/:repo/pulls/:number/merge', () => {
      // 다른 누군가가 새 head로 병합했고 우리 응답은 유실됨
      model.merge(1, { sha: moved, merge_method: 'merge' });
      return { drop: true };
    });
    const outcome = await client.mergePullRequest({ pr: 1, baseSha: base, headSha: head });
    expect(outcome.kind).toBe('verify_failed');
  });

  test.each([
    { pr: 0, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
    { pr: 1, baseSha: 'short', headSha: 'b'.repeat(40) },
    { pr: 1, baseSha: 'a'.repeat(40), headSha: 'B'.repeat(40) },
    { pr: 1, baseSha: 'a'.repeat(40), headSha: 'a'.repeat(40) },
  ])('입력이 잘못되면 호출 전에 거부한다 %#', async (input) => {
    const { client } = await setup();
    await expect(client.mergePullRequest(input)).rejects.toThrow(GitHubError);
    expect(github.requests).toEqual([]);
    expect(writes).toEqual([]);
  });

  test('그 밖의 거부(404 등)는 GitHubError로 던진다', async () => {
    const { client, head, base } = await setup();
    await expect(client.mergePullRequest({ pr: 99, baseSha: base, headSha: head })).rejects.toMatchObject({ status: 404 });
  });
});
