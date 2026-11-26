import { afterEach, beforeEach, expect, test } from 'vitest';
import { createGitHubClient, DeployKeyError } from '../../src/github/client.ts';
import { Secret } from '../../src/security/secret.ts';
import { GitHubModel } from '../fakes/github/model.ts';
import { startFakeGitHub, type FakeGitHub } from '../fakes/github/server.ts';

let github: FakeGitHub;
let model: GitHubModel;
beforeEach(async () => {
  github = await startFakeGitHub('fake-deploy-key-audit');
  model = new GitHubModel();
  model.install(github);
});
afterEach(async () => { await github.close(); });
const client = () => createGitHubClient({ repo: { owner: 'o', repo: 'r' }, baseUrl: github.url,
  token: () => Promise.resolve(new Secret('fake-deploy-key-audit')) });

test('M4-06: 시스템 키 하나만 있으면 허용하고, 읽기 전용 키라도 다른 키가 있으면 중단한다', async () => {
  github.on('GET /repos/o/r/keys', () => ({ body: [{ id: 7, read_only: false }] }));
  await expect(client().assertDeployKeys(7)).resolves.toBeUndefined();
  github.on('GET /repos/o/r/keys', () => ({ body: [{ id: 7, read_only: false }, { id: 8, read_only: true }] }));
  await expect(client().assertDeployKeys(7)).rejects.toThrow(/시스템 키 외/);
  expect(github.requests.every((request) => request.method === 'GET')).toBe(true);
});

test('M4-06: 두 번째 페이지의 다른 키도 놓치지 않는다', async () => {
  github.on('GET /repos/o/r/keys', (request) => request.query.page === '1'
    ? { body: [{ id: 7, read_only: false }], headers: { link: '<https://attacker.invalid/keys?page=2>; rel="next"' } }
    : { body: [{ id: 8, read_only: false }] });
  await expect(client().assertDeployKeys(7)).rejects.toThrow(/시스템 키 외/);
  expect(github.requests.map((request) => request.query.page)).toEqual(['1', '2']);
});

test('M4-06: 시스템 키가 없거나 쓰기 키가 아니거나 목록을 읽지 못하면 중단한다', async () => {
  github.on('GET /repos/o/r/keys', () => ({ body: [] }));
  await expect(client().assertDeployKeys(7)).rejects.toThrow(/시스템 키/);
  await expect(client().assertDeployKeys(null)).resolves.toBeUndefined();
  github.on('GET /repos/o/r/keys', () => ({ body: [{ id: 7, read_only: true }] }));
  await expect(client().assertDeployKeys(7)).rejects.toThrow(/쓰기/);
  github.on('GET /repos/o/r/keys', () => ({ status: 403, body: { message: 'Resource not accessible by personal access token' } }));
  await expect(client().assertDeployKeys(7)).rejects.toThrow(/Administration.*read/);
});

test.each([{ body: {} }, { body: [null] }, { body: [{ id: 7 }] }])('M4-06: 키 목록의 필수 정보가 잘못된 경우에도 중단한다: %j', async ({ body }) => {
  github.on('GET /repos/o/r/keys', () => ({ body }));
  await expect(client().assertDeployKeys(7)).rejects.toBeInstanceOf(DeployKeyError);
});

test('M1·L2: 목록 통신 실패는 재시도 가능한 DeployKeyError로 전달한다', async () => {
  const failing = createGitHubClient({ repo: { owner: 'o', repo: 'r' }, token: () => Promise.resolve(new Secret('fake')),
    fetch: () => Promise.reject(new TypeError('fetch failed')) });
  await expect(failing.assertDeployKeys(7)).rejects.toMatchObject({ name: 'DeployKeyError', status: 0, retryable: true });
});

test('M1: 자격 증명 공급원의 오류는 통신 오류로 바꾸거나 재시도하지 않는다', async () => {
  const denied = new Error('자격 증명 조회 거부');
  const failing = createGitHubClient({ repo: { owner: 'o', repo: 'r' }, token: () => Promise.reject(denied),
    fetch: () => Promise.reject(new Error('요청을 보내면 안 됩니다.')) });
  await expect(failing.assertDeployKeys(7)).rejects.toBe(denied);
});
