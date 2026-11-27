// Codex 재리뷰 4 P3 회귀 시험: 중단 push 기록을 동시에 갱신해도 잃지 않고, 손상된 기록은 「기록 없음」이 아니라 「모두 재대조」다.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { GitRepository, type PushGate } from '../../src/git/repository.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
let root: string;
let repo: GitRepository;
let remote: string;
let head: string;
interface Marks { markInterruptedPush(branch: string, commit: string, outcome: string): Promise<void> }

beforeEach(async () => {
  root = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'push-interrupted-'));
  const source = join(root, 'source'); remote = join(root, 'remote.git');
  await mkdir(source); git(source, 'init', '-b', 'main');
  await writeFile(join(source, 'a'), 'a'); git(source, 'add', '-A'); git(source, 'commit', '-m', 'a'); head = git(source, 'rev-parse', 'HEAD');
  git(source, 'clone', '--bare', source, remote);
  repo = await GitRepository.clone(join(root, 'runner'), 'p', remote);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const recordPath = () => join(root, 'runner/state/git/p.push-interrupted');
const marks = () => repo as unknown as Marks;

// 리뷰어 재현(parallel-interrupted-marks: 5회 중 4회 유실)의 반대 단언.
test('두 브랜치의 중단 기록을 동시에 남겨도 둘 다 남는다(5회 반복)', async () => {
  for (let round = 0; round < 5; round++) {
    await rm(recordPath(), { force: true });
    await Promise.all([marks().markInterruptedPush('agent/a', head, 'GitPushAbortedError'), marks().markInterruptedPush('agent/b', head, 'GitPushUnknownError')]);
    expect(Object.keys(JSON.parse(await readFile(recordPath(), 'utf8')) as object).sort(), `round ${String(round)}`).toEqual(['agent/a', 'agent/b']);
  }
});

// 리뷰어 재현(lost-mark-next-push: 재대조 0회)의 반대 단언: 기록이 남아 있으므로 다음 push 전에 원격을 읽는다.
test('동시에 남긴 기록의 두 브랜치 모두 다음 push 전에 원격을 다시 읽어 대조한다', async () => {
  await Promise.all([marks().markInterruptedPush('agent/a', head, 'GitPushAbortedError'), marks().markInterruptedPush('agent/b', head, 'GitPushAbortedError')]);
  // 원격에 이미 그 커밋이 반영된 상태: 재대조하면 쓰지 않는다('already'), 관문도 부르지 않는다.
  git(repo.path, 'push', remote, `${head}:refs/heads/agent/a`, `${head}:refs/heads/agent/b`);
  const calls: string[] = [];
  const gate: PushGate = async () => { calls.push('gate'); };
  expect(await repo.pushCommit(head, 'agent/a', gate)).toBe('already');
  expect(await repo.pushCommit(head, 'agent/b', gate)).toBe('already');
  expect(calls).toEqual([]);
  expect(JSON.parse(await readFile(recordPath(), 'utf8'))).toEqual({});
});

test('기록이 손상됐으면 「기록 없음」으로 넘어가지 않고 모든 브랜치를 재대조하며, 손상 파일은 그대로 둔다', async () => {
  await writeFile(recordPath(), '{broken');
  git(repo.path, 'push', remote, `${head}:refs/heads/agent/c`);
  const calls: string[] = [];
  const gate: PushGate = async () => { calls.push('gate'); };
  expect(await repo.pushCommit(head, 'agent/c', gate)).toBe('already');
  expect(calls).toEqual([]);
  // 새 중단 기록도 손상 파일을 덮어쓰지 않는다(사람이 확인할 때까지 보존).
  await marks().markInterruptedPush('agent/d', head, 'GitPushAbortedError');
  expect(await readFile(recordPath(), 'utf8')).toBe('{broken');
});

test('대조 중 같은 브랜치가 다시 기록되면(다른 커밋) 그 새 기록은 지우지 않는다', async () => {
  await marks().markInterruptedPush('agent/e', head, 'GitPushAbortedError');
  const original = (repo as unknown as { git(args: string[], input?: unknown, env?: NodeJS.ProcessEnv): Promise<Buffer> }).git.bind(repo);
  const next = 'f'.repeat(40);
  (repo as unknown as { git: typeof original }).git = async (args, input, env) => {
    if (args[0] === 'ls-remote') await marks().markInterruptedPush('agent/e', next, 'GitPushUnknownError');
    return original(args, input, env);
  };
  const gate: PushGate = async () => { throw new Error('관문에서 멈춤(쓰기 없음)'); };
  await expect(repo.pushCommit(head, 'agent/e', gate)).rejects.toThrow('관문에서 멈춤');
  expect(JSON.parse(await readFile(recordPath(), 'utf8'))).toEqual({ 'agent/e': { commit: next, outcome: 'GitPushUnknownError', id: expect.any(String) } });
});

// Codex 재리뷰 5 P3(same-commit-new-mark-lost)의 반대 단언: 같은 브랜치·같은 커밋으로 다시 기록돼도 새 기록은 남고, 다음 push가 원격을 다시 읽는다.
test('대조 중 같은 브랜치가 같은 커밋으로 다시 기록돼도 새 기록은 지우지 않고, 다음 push가 다시 대조한다', async () => {
  await marks().markInterruptedPush('agent/same', head, 'GitPushAbortedError');
  const original = (repo as unknown as { git(args: string[], input?: unknown, env?: NodeJS.ProcessEnv): Promise<Buffer> }).git.bind(repo);
  let lsRemote = 0;
  let injected = false;
  (repo as unknown as { git: typeof original }).git = async (args, input, env) => {
    const result = await original(args, input, env);
    if (args[0] === 'ls-remote') {
      lsRemote++;
      // 원격 조회는 끝났고, 결과를 돌려주기 전에 같은 H의 새 중단 기록이 생긴다(리뷰어 재현과 같은 순서).
      if (!injected) { injected = true; await marks().markInterruptedPush('agent/same', head, 'GitPushUnknownError'); }
    }
    return result;
  };
  const gate: PushGate = async () => { throw new Error('관문에서 멈춤(쓰기 없음)'); };
  await expect(repo.pushCommit(head, 'agent/same', gate)).rejects.toThrow('관문에서 멈춤');
  expect(JSON.parse(await readFile(recordPath(), 'utf8'))).toEqual({ 'agent/same': { commit: head, outcome: 'GitPushUnknownError', id: expect.any(String) } });
  await expect(repo.pushCommit(head, 'agent/same', gate)).rejects.toThrow('관문에서 멈춤');
  expect(lsRemote).toBe(2);
});

test('id가 없는 이전 형식의 기록도 읽고, 같은 커밋이면 대조 뒤 지운다', async () => {
  await writeFile(recordPath(), JSON.stringify({ 'agent/old': { commit: head, outcome: 'GitPushAbortedError' } }));
  git(repo.path, 'push', remote, `${head}:refs/heads/agent/old`);
  const gate: PushGate = async () => { throw new Error('관문에 오면 안 됨'); };
  expect(await repo.pushCommit(head, 'agent/old', gate)).toBe('already');
  expect(JSON.parse(await readFile(recordPath(), 'utf8'))).toEqual({});
});
