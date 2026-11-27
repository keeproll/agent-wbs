// 시도별 작업 폴더 준비(execution.prepare)와 재사용·정리 규칙. 실제 git 저장소로 확인한다(원격은 로컬 bare 저장소).
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { AttemptJob } from '../../src/exec/session.ts';
import { GitRepository } from '../../src/git/repository.ts';
import { localAgentGit } from '../../src/git/agent-git.ts';
import { createWorkspace } from '../../src/jobs/workspace.ts';
import { commit, file, fixture, git } from '../ci/int-fixture.ts';

const BRANCH = 'agent/TASK-0001-h1';
let f: Awaited<ReturnType<typeof fixture>>;
const extra: string[] = [];
afterEach(async () => {
  for (const repo of [f.repo]) for (const name of await repo.inputIds().catch(() => [])) await repo.removeInput(name).catch(() => undefined);
  await f.close();
  for (const dir of extra.splice(0)) await rm(dir, { recursive: true, force: true });
});

const job = (kind: AttemptJob['payload']['kind'], baseCommit: string, instructions: Record<string, unknown> = {}): AttemptJob => ({
  id: crypto.randomUUID(), fence: 1, leaseUntil: '2026-11-28T00:00:00Z', kind: 'attempt',
  payload: { taskKey: 'TASK-0001', kind, agent: kind === 'dev' || kind === 'rework' ? 'Claude' : 'Codex', branch: BRANCH, baseCommit, inputVersion: 2, instructions },
});
/** 원격 main에 prototype을 더한다. Runner clone은 아직 이 커밋을 모른다(prepare가 받아야 한다). */
async function setup() {
  f = await fixture(BRANCH);
  await file(join(f.source, 'prototype/docs/guide.md'), '입력');
  commit(f.source); git(f.source, 'push', f.remote, 'main');
  git(f.remote, 'update-ref', '-d', `refs/heads/${BRANCH}`);
  return f.ref('main');
}
/** Agent가 작업 폴더에서 커밋한다(같은 계정 시험). */
async function agentCommit(cwd: string, name = 'src/result.ts') {
  await file(join(cwd, name), `값 ${crypto.randomUUID()}\n`);
  return commit(cwd);
}

test('개발: 없는 입력 커밋은 받아서 새 폴더를 만들고, 재작업·재시도는 같은 폴더와 커밋하지 않은 파일을 그대로 쓴다', async () => {
  const base = await setup();
  const w = createWorkspace({ repo: async () => f.repo });
  const first = await w.prepare(job('dev', base));
  expect(first.cwd).toMatch(/\/worktrees\/project\/w-[0-9a-f]{20}-dev$/);
  expect(first.headSha).toBe(base);
  expect(first.notes).toMatch(/읽기 전용 사본: .*\/inputs\/project\/in-v2-[0-9a-f]{12}/);
  const head = await agentCommit(first.cwd);
  await writeFile(join(first.cwd, 'draft.txt'), '중단된 작업');
  const again = await w.prepare(job('rework', base));
  expect(again).toMatchObject({ cwd: first.cwd, headSha: head });
  expect(await stat(join(first.cwd, 'draft.txt'))).toBeTruthy();
  expect(w.worktree(job('rework', base))).toEqual({ id: expect.stringMatching(/^w-[0-9a-f]{20}-dev$/), branch: expect.stringMatching(/^agent\/w-[0-9a-f]{20}-dev$/) });
});

test('검증: ①이 가져온 결과 커밋으로 매번 새 폴더를 만들고, 보고 뒤 FAIL은 개발 폴더를 남기고 PASS는 둘 다 지운다', async () => {
  const base = await setup();
  const w = createWorkspace({ repo: async () => f.repo });
  const dev = await w.prepare(job('dev', base));
  const head = await agentCommit(dev.cwd);
  const ids = w.worktree(job('dev', base));
  expect(await f.repo.importWorktree(ids.id, ids.branch)).toBe(head);
  const qa = await w.prepare(job('qa', base, { revision: 1, checklist: [{ itemKey: 'CL-1', content: '확인' }] }));
  expect(qa.cwd).toMatch(/w-[0-9a-f]{20}-qa$/);
  expect(qa.headSha).toBe(head);
  expect(qa.notes).toContain('CL-1=확인');
  // QA가 남긴 파일은 다음 검증 준비에서 사라진다(검사한 커밋 그대로 시작).
  await writeFile(join(qa.cwd, 'qa-note.txt'), '남은 파일');
  const reverify = await w.prepare(job('reverify', base));
  expect(reverify.cwd).toBe(qa.cwd);
  await expect(stat(join(qa.cwd, 'qa-note.txt'))).rejects.toThrow();
  await w.settle(job('qa', base), 'FAIL');
  expect(await f.repo.recordedWorktrees()).toEqual([ids.id]);
  await w.settle(job('dev', base), null);
  expect(await f.repo.recordedWorktrees()).toEqual([ids.id]);
  await w.prepare(job('qa', base));
  await w.settle(job('qa', base), 'PASS');
  expect(await f.repo.recordedWorktrees()).toEqual([]);
});

test('재작업 폴더가 없으면 원격 Task 브랜치(①을 통과해 push된 커밋)에서 이어 가고, 원격도 없으면 지어내지 않고 실패한다', async () => {
  const base = await setup();
  const w = createWorkspace({ repo: async () => f.repo });
  await expect(w.prepare(job('rework', base))).rejects.toThrow();
  expect(await f.repo.recordedWorktrees()).toEqual([]);
  const dev = await w.prepare(job('dev', base));
  const head = await agentCommit(dev.cwd);
  const ids = w.worktree(job('dev', base));
  await f.repo.importWorktree(ids.id, ids.branch);
  git(f.remote, 'fetch', '-q', join(dev.cwd, '.git'), `${ids.branch}:refs/heads/${BRANCH}`);
  await f.repo.removeWorktree(ids.id);
  const rework = await w.prepare(job('rework', base));
  expect(rework).toMatchObject({ cwd: dev.cwd, headSha: head });
});

test('병합 뒤 정리(release): 그 Task 브랜치의 개발·검증 폴더를 모두 지우고, 다른 브랜치는 건드리지 않는다', async () => {
  const base = await setup();
  const w = createWorkspace({ repo: async () => f.repo });
  const dev = await w.prepare(job('dev', base));
  await agentCommit(dev.cwd);
  const ids = w.worktree(job('dev', base));
  await f.repo.importWorktree(ids.id, ids.branch);
  await w.prepare(job('qa', base));
  const other = await w.prepare({ ...job('dev', base), payload: { ...job('dev', base).payload, branch: 'agent/TASK-0002-h1' } });
  expect(await f.repo.recordedWorktrees()).toHaveLength(3);
  await w.release(BRANCH);
  await w.release(BRANCH);
  expect(await f.repo.recordedWorktrees()).toEqual([other.cwd.split('/').at(-1)]);
});

test('검증 폴더의 증거 폴더(.awbs-evidence)는 청결 확인에서 빠지고, 그 밖의 파일은 더럽다고 본다', async () => {
  const base = await setup();
  const w = createWorkspace({ repo: async () => f.repo });
  const dev = await w.prepare(job('dev', base));
  const head = await agentCommit(dev.cwd);
  const ids = w.worktree(job('dev', base));
  await f.repo.importWorktree(ids.id, ids.branch);
  const qa = await w.prepare(job('qa', base));
  await writeFile(join(qa.cwd, '.awbs-evidence', 'unit.log'), '로그');
  await f.repo.taskCheckPath(w.verifyWorktree(job('qa', base)), head);
  await writeFile(join(qa.cwd, 'stray.txt'), '남은 파일');
  await expect(f.repo.taskCheckPath(w.verifyWorktree(job('qa', base)), head)).rejects.toThrow('커밋하지 않은 변경');
});

test('기록은 있는데 폴더가 사라졌으면 기록을 정리하고 다시 만든다', async () => {
  const base = await setup();
  const w = createWorkspace({ repo: async () => f.repo });
  const dev = await w.prepare(job('dev', base));
  await rm(dev.cwd, { recursive: true, force: true });
  expect((await w.prepare(job('dev', base))).cwd).toBe(dev.cwd);
});

test('전용 계정 배치 모양: 준비 폴더(.prep-*)를 남기지 않고 작업 폴더 0770·모음 0710으로 넘긴다', async () => {
  const base = await setup();
  const area = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'agent-area-'));
  extra.push(area);
  const repo = await GitRepository.clone(join(f.root, 'shared-runner'), 'project', f.remote, { agentRoot: area, restorePermissions: null, agentGit: localAgentGit() });
  const w = createWorkspace({ repo: async () => repo });
  const dev = await w.prepare(job('dev', base));
  expect((await stat(dev.cwd)).mode & 0o777).toBe(0o770);
  expect((await stat(join(area, 'worktrees', 'project'))).mode & 0o777).toBe(0o710);
  expect((await readdir(join(area, 'worktrees', 'project'))).filter(name => name.startsWith('.prep-'))).toEqual([]);
  // HEAD는 Agent 쪽 git(여기서는 같은 계정 대역)으로 본다.
  expect(dev.headSha).toBe(base);
  for (const name of await repo.inputIds()) await repo.removeInput(name);
  for (const name of await repo.recordedWorktrees()) await repo.removeWorktree(name);
});
