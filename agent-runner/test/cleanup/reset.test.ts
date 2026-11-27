import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RemoteCleanup } from '../../src/cleanup/remote.ts';
import { createResetCleanup, parseResetPayload, processGroupEmpty } from '../../src/cleanup/reset.ts';
import { repositoryIdFor } from '../../src/git/identity.ts';
import { GitRepository } from '../../src/git/repository.ts';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'reset-cleanup-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

const identity = () => ({ hostId: 'h1', bootId: 'b1' });
const command = (payload: Record<string, unknown>) => ({ id: 'c1', kind: 'reset-cleanup' as const, epoch: 1, payload });
/** reset_project()의 모양(DB 행 그대로의 보유). */
const row = (h: Partial<{ job: string; host_id: string | null; boot_id: string | null; pgid: number | null; slot_state: string }>) =>
  ({ id: 'x', job: 'j', host_id: 'h1', boot_id: 'b1', pgid: null, slot_state: 'reserved', lock_state: 'none', agent: 'Codex', ...h });
const noBase = (holds: unknown[], extra: Record<string, unknown> = {}) => ({ epochPath: '1/', holds, generation: null, unparsedPrs: [], ...extra });
const fixture = JSON.parse(await readFile(join(import.meta.dirname, '../../../agent-wbs/contracts/fixtures/reset-cleanup-payloads.json'), 'utf8')) as Record<'noBase' | 'withBase', { kind: string; payload: Record<string, unknown> }>;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' } }).trim();
}
/** 원격(bare)과 Runner 저장소. 저장소 이름은 repoUrl에서 만든다. */
async function repository() {
  const source = join(home, 'source');
  await mkdir(join(source, 'src'), { recursive: true });
  git(source, 'init', '-b', 'main');
  await writeFile(join(source, 'src/a'), 'base');
  await mkdir(join(source, 'prototype'));
  await writeFile(join(source, 'prototype/p'), 'p');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'base');
  const base = git(source, 'rev-parse', 'HEAD');
  const remote = join(home, 'remote.git');
  git(source, 'clone', '--bare', source, remote);
  const repo = await GitRepository.clone(home, repositoryIdFor(remote), remote);
  return { source, remote, base, repo };
}
const withBase = (remote: string, base: string, extra: Record<string, unknown> = {}) =>
  noBase([], { repoUrl: remote, baseCommit: base, branches: [], prs: [], ...extra });
const recorder = (repository = 'https://github.com/o/r') => {
  const calls: string[] = [];
  const remote: RemoteCleanup = {
    repository,
    closePullRequests: (_t, prs) => { calls.push(`close:${prs.join(',')}`); return Promise.resolve(); },
    deleteBranches: (_t, b) => { calls.push(`delete:${b.join(',')}`); return Promise.resolve(); },
    targetsMatch: () => { calls.push('targets'); return Promise.resolve(true); },
    pushReset: () => { calls.push('push'); return Promise.resolve(); },
  };
  return { calls, remote };
};

test('P1-1: 실제 reset_project payload(기준 없음)를 받아 정리한다', async () => {
  const payload = structuredClone(fixture.noBase.payload);
  // fixture의 보유는 host-a/boot-a. 이 PC가 그 PC이고 그룹이 비었다고 둔다.
  const result = await createResetCleanup({ home, identity: () => ({ hostId: 'host-a', bootId: 'boot-a' }), groupEmpty: () => true, launchCheck: () => Promise.resolve('none') })(command(payload));
  expect(result).toMatchObject({ status: 'done', holds: [
    { hostId: 'host-a', bootId: 'boot-a', proof: 'group_empty', processGroup: 4242 },
    { hostId: 'host-a', bootId: 'boot-a', proof: 'no_process' },
  ] });
});

test('P1-1: 실제 reset_project payload(기준 있음)를 받아 PR 닫기·브랜치 삭제까지 한다', async () => {
  const { remote, base } = await repository();
  const payload = { ...structuredClone(fixture.withBase.payload), repoUrl: remote, baseCommit: base };
  const r = recorder(remote);
  const result = await createResetCleanup({ home, identity: () => ({ hostId: 'host-a', bootId: 'other-boot' }), remote: r.remote })(command(payload));
  expect(result.status).toBe('done');
  expect(r.calls).toEqual(['close:7', 'delete:agent/T1-h1,agent/T2-h1']);
});

test('보유별 증거: 예약 전 no_process, 부팅 변경 boot_changed, 빈 그룹 group_empty, 슬롯 없는 잠금 no_process', async () => {
  const cleanup = createResetCleanup({ home, identity, launchCheck: h => Promise.resolve(h.processGroup === 77 ? 'none' : 'unknown') });
  const result = await cleanup(command(noBase([
    row({ job: 'j0', host_id: null, boot_id: null }),
    row({ job: 'j1', boot_id: 'old-boot', pgid: 55 }),
    row({ job: 'j2', pgid: 77, slot_state: 'active' }),
    row({ job: 'j3', slot_state: 'none' }),
  ])));
  expect(result).toMatchObject({ status: 'done', holds: [
    { job: 'j0', hostId: null, proof: 'no_process' },
    { job: 'j1', proof: 'boot_changed', processGroup: 55, currentBootId: 'b1' },
    { job: 'j2', proof: 'group_empty', processGroup: 77 },
    { job: 'j3', proof: 'no_process' },
  ] });
});

test('하나라도 종료를 증명하지 못하면 failed이고 git 정리를 하지 않는다', async () => {
  const cleanup = createResetCleanup({ home, identity, groupEmpty: () => false });
  for (const hold of [row({ pgid: 77, slot_state: 'active' }), row({ host_id: 'other' }), row({})]) {
    const result = await cleanup(command(noBase([hold], { repoUrl: 'https://github.com/o/r', baseCommit: 'a'.repeat(40), branches: [], prs: [] })));
    expect(result.status).toBe('failed');
    expect(result.items.map((i) => i.name)).toEqual(['hold:j']);
  }
});

test('빈 pgid라도 launch 기록을 잃었으면 초기화를 완료하지 않는다', async () => {
  const cleanup = createResetCleanup({ home, identity, groupEmpty: () => true });
  expect((await cleanup(command(noBase([row({ pgid: 77, slot_state: 'active' })])))).status).toBe('failed');
});

test('pgid 없는 보유는 launch 대조가 none일 때만 no_process', async () => {
  const result = await createResetCleanup({ home, identity, launchCheck: () => Promise.resolve('none') })(command(noBase([row({})])));
  expect(result).toMatchObject({ status: 'done', holds: [{ proof: 'no_process', hostId: 'h1' }] });
});

test('P1-2: 원격 정리는 PR 닫기 → 브랜치 삭제 → 되돌림 push 순서다', async () => {
  const { source, remote, base } = await repository();
  await writeFile(join(source, 'src/a'), 'changed'); git(source, 'add', '.'); git(source, 'commit', '-m', 'changed'); git(source, 'push', remote, 'main');
  const r = recorder(remote);
  const result = await createResetCleanup({ home, identity, remote: r.remote })(command(withBase(remote, base, { branches: ['agent/T1'], prs: [3] })));
  expect(result.status).toBe('done');
  expect(r.calls).toEqual(['close:3', 'delete:agent/T1', 'push']);
});

test('이중 방어 1단계: 명령 저장소가 설정 저장소와 다르면 원격 호출 없이 failed', async () => {
  const r = recorder('https://github.com/o/current');
  const foreign = withBase('https://github.com/foreign/previous', 'a'.repeat(40), { branches: ['agent/T1'], prs: [1] });
  const result = await createResetCleanup({ home, identity, remote: r.remote })(command(foreign));
  expect(result).toMatchObject({ status: 'failed', items: expect.arrayContaining([expect.objectContaining({ name: 'github:repo', ok: false })]) as unknown });
  expect(r.calls).toEqual([]);
});

test('P1-2: 원격 작업이 필요한데 GitHub 연결이 없으면 failed', async () => {
  const { remote, base } = await repository();
  const result = await createResetCleanup({ home, identity })(command(withBase(remote, base, { branches: ['agent/T1'] })));
  expect(result).toMatchObject({ status: 'failed', items: expect.arrayContaining([{ name: 'github', ok: false, detail: expect.stringContaining('GitHub') as unknown }]) as unknown });
});

test('로컬 저장소가 없으면 원격 main의 초기화 대상을 기준과 대조한다(같으면 done, 다르면 failed)', async () => {
  const payload = withBase('https://github.com/o/none', 'a'.repeat(40));
  const r = recorder('https://github.com/O/none.git');
  expect((await createResetCleanup({ home, identity, remote: r.remote })(command(payload))).status).toBe('done');
  expect(r.calls).toEqual(['close:', 'delete:', 'targets']);
  const mismatch = { ...r.remote, targetsMatch: () => Promise.resolve(false) };
  expect((await createResetCleanup({ home, identity, remote: mismatch })(command(payload))).status).toBe('failed');
});

test('로컬 저장소의 등록 원격이 명령의 저장소와 다르면 중지한다', async () => {
  const { remote, base } = await repository();
  const id = repositoryIdFor(remote);
  // 같은 이름 폴더가 다른 원격을 가리키는 상황: 등록 기록의 source를 바꿔 흉내 낸다.
  const statePath = join(home, 'state/git', `${id}.json`);
  const record = JSON.parse(await readFile(statePath, 'utf8')) as { source: string };
  await writeFile(statePath, JSON.stringify({ ...record, source: `${remote}-other` }));
  const r = recorder(remote);
  const result = await createResetCleanup({ home, identity, remote: r.remote })(command(withBase(remote, base)));
  expect(result).toMatchObject({ status: 'failed', items: expect.arrayContaining([expect.objectContaining({ name: 'git:open', ok: false })]) as unknown });
  expect(r.calls).toEqual([]);
});

test('P1-6: 목록을 읽은 뒤 새 작업 폴더를 만들려 해도 막히고, 남은 항목이 있으면 done이 아니다', async () => {
  const { remote, base, repo } = await repository();
  const original = GitRepository.prototype.recordedWorktrees;
  let raced: unknown;
  vi.spyOn(GitRepository.prototype, 'recordedWorktrees').mockImplementation(async function (this: GitRepository) {
    const ids = await original.call(this);
    raced = await repo.createWorktree('raced', 'agent/raced', base).then(() => 'created', (e: unknown) => e);
    return ids;
  });
  const result = await createResetCleanup({ home, identity, remote: recorder().remote })(command(withBase(remote, base)));
  expect(raced).toBeInstanceOf(Error);
  expect(result.status).toBe('done');
  await expect(lstat(join(home, 'worktrees', repositoryIdFor(remote), 'raced'))).rejects.toMatchObject({ code: 'ENOENT' });
  // 정리가 끝나면 다시 만들 수 있다.
  await repo.createWorktree('after', 'agent/after', base);
});

test('P1-6: 정리 중 생긴 항목이 남으면 done 대신 failed이고 생성 차단이 유지된다', async () => {
  const { remote, base, repo } = await repository();
  // 정리 목록 조회 뒤 차단을 우회해 기록 밖 폴더를 남기는 상황(외부 조작)을 만든다.
  const original = GitRepository.prototype.inputIds;
  vi.spyOn(GitRepository.prototype, 'inputIds').mockImplementation(async function (this: GitRepository) {
    const ids = await original.call(this);
    await mkdir(join(home, 'inputs', repositoryIdFor(remote), 'late'), { recursive: true });
    return ids;
  });
  const result = await createResetCleanup({ home, identity, remote: recorder().remote })(command(withBase(remote, base)));
  expect(result.status).toBe('failed');
  await expect(repo.checkoutInput('v2', base)).rejects.toThrow(/초기화/);
});

test('unparsedPrs는 처음 한 번만 경고 플래그(ok:false)로 남기고, 다음 초기화에서는 다시 경고하지 않는다', async () => {
  const cleanup = createResetCleanup({ home, identity });
  const refs = [{ source: 'task_attempts', id: 'a', value: 'abc' }];
  const first = await cleanup(command(noBase([], { unparsedPrs: refs })));
  expect(first).toMatchObject({ status: 'done', items: expect.arrayContaining([expect.objectContaining({ name: 'warn:manual-reconcile', ok: false })]) as unknown });
  // outbox 저장 전(markReported 전)의 재시도는 같은 경고를 다시 싣는다 — 유실 방지(재리뷰 N5).
  const retried = await cleanup(command(noBase([], { unparsedPrs: refs })));
  expect(retried.items.some((i) => i.name === 'warn:manual-reconcile' && !i.ok)).toBe(true);
  await cleanup.markReported(command({}));
  const second = await cleanup(command(noBase([], { unparsedPrs: refs })));
  expect(second.status).toBe('done');
  expect(second.items.some((i) => !i.ok)).toBe(false);
  await cleanup.markReported(command({}));
  const third = await cleanup(command(noBase([], { unparsedPrs: [...refs, { source: 'ci_runs', id: 'b', value: 'x' }] })));
  expect(third.items.find((i) => i.name === 'warn:manual-reconcile')?.detail).toContain('1건');
});

test.each([
  [{ holds: [], baseCommit: 'main', repoUrl: 'u', branches: [] }],
  [{ holds: [], baseCommit: 'a'.repeat(40), branches: [] }],
  [{ holds: [], baseCommit: 'a'.repeat(40), repoUrl: 'u', branches: ['main'] }],
  [{ epochPath: '1/' }],
  [{ holds: [{ job: 'j', host_id: 'h', boot_id: 'b', pgid: 1, slot_state: 'active' }] }],
  [{ holds: [{ job: 'j', host_id: 'h', boot_id: 'b', pgid: null }] }],
])('payload 형식이 다르면 추정하지 않고 failed: %j', async (bad) => {
  expect(() => parseResetPayload(bad)).toThrow();
  const result = await createResetCleanup({ home, identity })(command(bad));
  expect(result).toMatchObject({ status: 'failed', items: [{ name: 'payload', ok: false }] });
});

test('processGroupEmpty: 살아 있는 그룹은 비지 않았고, 끝난 그룹은 비었다', async () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const pgid = child.pid ?? 0;
  try {
    expect(processGroupEmpty(pgid)).toBe(false);
  } finally {
    process.kill(-pgid, 'SIGKILL');
    await once(child, 'exit');
  }
  expect(processGroupEmpty(pgid)).toBe(true);
});
