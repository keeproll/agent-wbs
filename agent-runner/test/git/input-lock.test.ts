// 재리뷰(4d01ecc) N2: 입력 복사와 초기화를 프로젝트 잠금 하나로 직렬화한다.
// 검토자 재현 A·B(m4-integration-fix2-rereview/review-limit.test.ts)를 같은 순서 제어로 옮겼다.
// 단, 원래 재현은 「멈춘 옛 복사가 있는데 초기화가 먼저 done」을 전제로 한다. 직렬화하면 그 순서 자체가 생길 수 없으므로
// 「초기화는 옛 복사가 끝나거나 취소될 때까지 기다린다」를 확인하도록 기대값을 바꿨다.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createResetCleanup } from '../../src/cleanup/reset.ts';
import { repositoryIdFor } from '../../src/git/identity.ts';
import { GitRepository } from '../../src/git/repository.ts';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'input-lock-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(join(home, 'inputs'), { recursive: true, force: true }).catch(() => undefined);
  execFileSync('chmod', ['-R', 'u+rwx', home]);
  await rm(home, { recursive: true, force: true });
});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' } }).trim();
}
async function fixture() {
  const source = join(home, 'source');
  await mkdir(join(source, 'prototype'), { recursive: true }); await mkdir(join(source, 'src'));
  git(source, 'init', '-b', 'main');
  await writeFile(join(source, 'prototype/input'), 'old input'); await writeFile(join(source, 'src/a'), 'a');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'base');
  const base = git(source, 'rev-parse', 'HEAD');
  const url = join(home, 'remote.git'); git(source, 'clone', '--bare', source, url);
  const id = repositoryIdFor(url);
  const repo = await GitRepository.clone(home, id, url);
  return { source, base, url, id, repo };
}
const reset = (url: string, base: string) => createResetCleanup({ home, identity: () => ({ hostId: 'h', bootId: 'b' }) })({ id: 'c', kind: 'reset-cleanup', epoch: 0,
  payload: { epochPath: '0/', generation: null, unparsedPrs: [], holds: [], repoUrl: url, baseCommit: base, branches: [], prs: [] } });
const settle = <T>(p: Promise<T>) => { const s: { state: 'pending' | 'resolved' | 'rejected'; value?: T } = { state: 'pending' }; p.then((v) => { s.state = 'resolved'; s.value = v; }, () => { s.state = 'rejected'; }); return s; };
/** 입력 디렉터리 아래(숨김 임시 폴더 포함)에 파일이 다 써진 사본이 있는가 */
const written = async (id: string) => {
  const root = join(home, 'inputs', id);
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) if (await lstat(join(root, name, 'prototype/input')).then(() => true, () => false)) return true;
  return false;
};

test('재현 A: 옛 복사가 진행 중이면 초기화는 기다리고, 옛 복사는 취소되며, 그 뒤 새 v1은 지워지지 않는다', async () => {
  const f = await fixture();
  const internal = f.repo as unknown as { trusted(): Promise<unknown> };
  const original = internal.trusted.bind(f.repo);
  const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>();
  let gated = false;
  vi.spyOn(internal, 'trusted').mockImplementation(async () => {
    if (!gated && await written(f.id)) { gated = true; entered.resolve(undefined); await release.promise; }
    return original();
  });
  const old = settle(f.repo.checkoutInput('v1', f.base));
  await entered.promise;
  // 다른 인스턴스(같은 프로세스)의 초기화. 옛 복사가 잠금을 쥐고 있으므로 끝나지 않아야 한다.
  const cleaning = settle(reset(f.url, f.base));
  await pause(300);
  expect(cleaning.state).toBe('pending');
  release.resolve(undefined);
  await vi.waitFor(() => { expect(cleaning.state).toBe('resolved'); }, { timeout: 10_000 });
  expect(cleaning.value?.status).toBe('done');
  // 옛 복사는 초기화가 취소했다. 공개되지 않았다.
  await vi.waitFor(() => { expect(old.state).toBe('rejected'); });
  expect(await readdir(join(home, 'inputs', f.id))).toEqual([]);
  // 새 커밋으로 같은 이름 v1을 다시 만든다. 성공한 새 입력은 그대로 남는다.
  await writeFile(join(f.source, 'prototype/input'), 'new input'); git(f.source, 'add', '.'); git(f.source, 'commit', '-m', 'new'); git(f.source, 'push', f.url, 'main');
  const fresh = await GitRepository.open(home, f.id);
  const published = await fresh.checkoutInput('v1', await fresh.fetch());
  await pause(100);
  expect(await readFile(join(published, 'prototype/input'), 'utf8')).toBe('new input');
});

test('재현 A 보강: 늦은 복사의 실패 처리는 공개 경로가 아니라 자기 임시 폴더만 지운다', async () => {
  const f = await fixture();
  // 같은 이름이 이미 공개돼 있으면 새 복사는 실패하고, 기존 사본은 그대로다.
  const first = await f.repo.checkoutInput('v1', f.base);
  await expect(f.repo.checkoutInput('v1', f.base)).rejects.toThrow();
  expect(await readFile(join(first, 'prototype/input'), 'utf8')).toBe('old input');
  expect((await readdir(join(home, 'inputs', f.id))).filter((n) => n.startsWith('.'))).toEqual([]);
});

function child(f: { id: string; base: string }, inputId: string) {
  const proc = spawn(process.execPath, [join(import.meta.dirname, '../helpers/input-copy-child.ts'), home, f.id, f.base, inputId], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = once(proc, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
  const stage = (name: string) => new Promise<void>((resolve) => { proc.on('message', (m: { stage?: string }) => { if (m.stage === name) resolve(); }); });
  return { proc, closed, stage };
}

test('재현 B(실제 SIGKILL): 복사 프로세스가 죽으면 초기화가 잠금을 회수하고 옛 사본을 남기지 않고 done', { timeout: 60_000 }, async () => {
  const f = await fixture();
  const c = child(f, 'late');
  await c.stage('files-written');
  const cleaning = settle(reset(f.url, f.base));
  await pause(300);
  // 복사가 잠금을 쥔 동안 초기화는 끝나지 않는다.
  expect(cleaning.state).toBe('pending');
  c.proc.kill('SIGKILL');
  expect((await c.closed)[1]).toBe('SIGKILL');
  await vi.waitFor(() => { expect(cleaning.state).toBe('resolved'); }, { timeout: 40_000 });
  expect(cleaning.value?.status).toBe('done');
  expect(await readdir(join(home, 'inputs', f.id))).toEqual([]);
  await expect(lstat(join(home, 'inputs', f.id, 'late'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('시작 회수(실제 SIGKILL): 복사 중 죽은 뒤 저장소를 다시 열면 잠금을 회수하고 공개 안 된 임시 사본을 지운다', { timeout: 60_000 }, async () => {
  const f = await fixture();
  const c = child(f, 'late');
  await c.stage('files-written');
  c.proc.kill('SIGKILL');
  expect((await c.closed)[1]).toBe('SIGKILL');
  const reopened = await GitRepository.open(home, f.id);
  expect(await readdir(join(home, 'inputs', f.id))).toEqual([]);
  // 같은 이름으로 다시 만들 수 있다(죽은 주인의 잠금이 회수됐다).
  const path = await reopened.checkoutInput('late', f.base);
  expect(await readFile(join(path, 'prototype/input'), 'utf8')).toBe('old input');
});

test('실패 처리는 자기 임시 폴더만 지운다: 복사 도중 공개 경로가 생기면 공개하지 않고 그 경로는 그대로 둔다', async () => {
  const f = await fixture();
  const internal = f.repo as unknown as { blob(entry: unknown): Promise<Buffer> };
  const original = internal.blob.bind(f.repo);
  const marker = join(home, 'inputs', f.id, 'v1', 'keep');
  vi.spyOn(internal, 'blob').mockImplementation(async (entry) => {
    // 잠금을 따르지 않는 외부 작성자를 흉내 낸다(정상 경로에서는 생기지 않는 상황).
    await mkdir(join(home, 'inputs', f.id, 'v1'), { recursive: true });
    await writeFile(marker, '다른 사본');
    return original(entry);
  });
  await expect(f.repo.checkoutInput('v1', f.base)).rejects.toThrow(/덮어쓰지 않습니다/);
  expect(await readFile(marker, 'utf8')).toBe('다른 사본');
  expect((await readdir(join(home, 'inputs', f.id))).filter((n) => n.startsWith('.'))).toEqual([]);
});

test('초기화 시작(beginReset)도 죽은 복사의 임시 사본을 지운다(이미 열린 저장소 객체에서)', { timeout: 60_000 }, async () => {
  const f = await fixture();
  // 복사 프로세스가 죽기 전에 열어 둔 객체. open()의 시작 회수는 이미 지나갔다.
  const opened = await GitRepository.open(home, f.id);
  const c = child(f, 'late');
  await c.stage('files-written');
  c.proc.kill('SIGKILL');
  await c.closed;
  expect((await readdir(join(home, 'inputs', f.id))).some((n) => n.startsWith('.copy-'))).toBe(true);
  await opened.beginReset();
  await opened.endReset();
  expect(await readdir(join(home, 'inputs', f.id))).toEqual([]);
});
