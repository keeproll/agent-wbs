import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ApiError, type ApiClient } from '../../src/api/client.ts';
import { InputChangeReporter, parseCommits, parseRawNumstat, type InputSource } from '../../src/git/inputs.ts';
import { GitRepository, GitSafetyError } from '../../src/git/repository.ts';

// M2-03 새 계약(reportInputChanges): base..head의 prototype/ 트리 차이, 전후 모드, 409 뒤 재계산, 재작성 시 중단.
let root: string;
let source: string;
let remote: string;
let repo: GitRepository;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=시험 작성자', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' },
  }).trim();
}
async function file(path: string, text: string | Buffer) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}
function commit(message: string) {
  git(source, 'add', '-A');
  git(source, 'commit', '-m', message);
  git(source, 'push', '-q', 'origin', 'main');
  return git(source, 'rev-parse', 'HEAD');
}
const blob = (rev: string) => git(source, 'rev-parse', rev);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inputs-test-'));
  source = join(root, 'source');
  remote = join(root, 'remote.git');
  await mkdir(source);
  git(source, 'init', '-q', '-b', 'main');
  await file(join(source, 'prototype/docs/guide.md'), '하나\n둘\n셋\n');
  await file(join(source, 'prototype/docs/keep.md'), '유지\n');
  await file(join(source, 'prototype/run.sh'), 'echo 시험\n');
  await file(join(source, 'src/app.ts'), 'export {};\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', '등록 기준');
  git(source, 'init', '-q', '--bare', '-b', 'main', remote);
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', '-q', 'origin', 'main');
  repo = await GitRepository.clone(join(root, 'runner'), 'project', remote);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('GitRepository.inputObservation', () => {
  test('교차 리뷰 F3: merge-base가 0·1 밖의 종료 코드(128)면 재작성(false)으로 보고하지 않고 중단한다', async () => {
    const fakebin = join(root, 'fakebin');
    await mkdir(fakebin);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    await writeFile(join(fakebin, 'git'), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "merge-base" ]; then exit 128; fi\ndone\nexec ${realGit} "$@"\n`);
    await chmod(join(fakebin, 'git'), 0o755);
    const base = git(source, 'rev-parse', 'HEAD');
    const old = process.env.PATH;
    process.env.PATH = `${fakebin}:${old ?? ''}`;
    try { await expect(repo.inputObservation(base, base)).rejects.toBeInstanceOf(GitSafetyError); } finally { process.env.PATH = old; }
  });

  test('prototype/ 트리 차이를 계약 모양으로: 이름 변경 R·실행 권한만 바뀐 M·종류 변경 T·추가 A·삭제 D, 바이너리는 0줄', async () => {
    const base = git(source, 'rev-parse', 'HEAD');
    const before = { guide: blob('HEAD:prototype/docs/guide.md'), keep: blob('HEAD:prototype/docs/keep.md'), run: blob('HEAD:prototype/run.sh') };
    git(source, 'mv', 'prototype/docs/guide.md', 'prototype/docs/manual.md');
    await chmod(join(source, 'prototype/run.sh'), 0o755);
    await unlink(join(source, 'prototype/docs/keep.md'));
    await symlink('manual.md', join(source, 'prototype/docs/keep.md'));
    await file(join(source, 'prototype/img.bin'), Buffer.from([0, 1, 2, 0]));
    await file(join(source, 'src/app.ts'), 'export const x = 1;\n');
    const first = commit('입력 수정');
    git(source, 'rm', '-q', 'prototype/img.bin');
    const head = commit('이미지 삭제');
    const observed = await repo.inputObservation(base, await repo.fetch());
    expect(observed.baseIsAncestor).toBe(true);
    expect(observed.treeHash).toBe(git(source, 'rev-parse', 'HEAD:prototype'));
    expect(observed.changes).toEqual([
      { status: 'T', path: 'prototype/docs/keep.md', oldMode: '100644', newMode: '120000', oldBlob: before.keep, newBlob: blob('HEAD:prototype/docs/keep.md'), added: 1, deleted: 1 },
      { status: 'R', path: 'prototype/docs/manual.md', from: 'prototype/docs/guide.md', oldMode: '100644', newMode: '100644', oldBlob: before.guide, newBlob: before.guide, added: 0, deleted: 0 },
      { status: 'M', path: 'prototype/run.sh', oldMode: '100644', newMode: '100755', oldBlob: before.run, newBlob: before.run, added: 0, deleted: 0 },
    ]);
    // src/ 변경과, 생겼다가 지워진 파일(순 변경 없음)은 차이에 없다. 커밋 목록은 prototype/을 바꾼 첫 부모 이력(참고 정보)이다.
    expect(observed.commits.map((c) => [c.sha, c.author, c.message])).toEqual([[first, '시험 작성자', '입력 수정'], [head, '시험 작성자', '이미지 삭제']]);
    expect(observed.commits[0]?.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  test('바이너리 추가는 0줄, 같은 커밋이면 빈 차이와 현재 트리', async () => {
    const base = git(source, 'rev-parse', 'HEAD');
    await file(join(source, 'prototype/img.bin'), Buffer.from([0, 1, 2, 0]));
    const head = commit('이미지');
    const observed = await repo.inputObservation(base, await repo.fetch());
    expect(observed.changes).toEqual([{ status: 'A', path: 'prototype/img.bin', oldMode: null, newMode: '100644', oldBlob: null, newBlob: blob('HEAD:prototype/img.bin'), added: 0, deleted: 0 }]);
    expect(await repo.inputObservation(head, head)).toEqual({ baseIsAncestor: true, treeHash: git(source, 'rev-parse', 'HEAD:prototype'), changes: [], commits: [] });
  });

  test('이력 재작성(base가 head의 조상이 아님)은 false, base가 없으면 보고 중단', async () => {
    const base = git(source, 'rev-parse', 'HEAD');
    await file(join(source, 'prototype/docs/guide.md'), '바뀜\n');
    const pushed = commit('입력 수정');
    await repo.fetch();
    git(source, 'reset', '-q', '--hard', base);
    await file(join(source, 'prototype/docs/other.md'), '다른 이력\n');
    git(source, 'add', '-A'); git(source, 'commit', '-q', '-m', '재작성');
    git(source, 'push', '-q', '-f', 'origin', 'main');
    // 기본 fetch(M4)는 재작성된 원격을 거부한다. 입력 보고는 추적 참조만 강제로 맞춘다.
    await expect(repo.fetch()).rejects.toBeInstanceOf(GitSafetyError);
    const head = await repo.fetch({ allowRewrite: true });
    expect(await repo.head()).not.toBe(head);
    expect((await repo.inputObservation(pushed, head)).baseIsAncestor).toBe(false);
    await expect(repo.inputObservation('f'.repeat(40), head)).rejects.toBeInstanceOf(GitSafetyError);
  });
});

describe('parseRawNumstat·parseCommits', () => {
  test('없는 쪽 모드·blob은 null, 계약 밖 상태는 거부', () => {
    const z = (...t: string[]) => `${t.join('\0')}\0`;
    expect(parseRawNumstat(z(`:000000 100644 ${'0'.repeat(40)} ${'a'.repeat(40)} A`, 'prototype/a', `:100644 000000 ${'b'.repeat(40)} ${'0'.repeat(40)} D`, 'prototype/b', '1\t0\tprototype/a', '0\t2\tprototype/b'))).toEqual([
      { status: 'A', path: 'prototype/a', oldMode: null, newMode: '100644', oldBlob: null, newBlob: 'a'.repeat(40), added: 1, deleted: 0 },
      { status: 'D', path: 'prototype/b', oldMode: '100644', newMode: null, oldBlob: 'b'.repeat(40), newBlob: null, added: 0, deleted: 2 },
    ]);
    expect(() => parseRawNumstat(z(`:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} C75`, 'prototype/a', 'prototype/b', '0\t0\t', 'prototype/a', 'prototype/b'))).toThrow('계약에 없는 상태');
    expect(() => parseRawNumstat(z(`:100644 100644 abc ${'b'.repeat(40)} M`, 'prototype/a', '0\t0\tprototype/a'))).toThrow(GitSafetyError);
    expect(parseRawNumstat('')).toEqual([]);
    expect(parseCommits(`${'c'.repeat(40)}\x1f2026-11-26T21:00:00+09:00\x1f작성자\x1f제목\x1e\n`)).toEqual([{ sha: 'c'.repeat(40), at: '2026-11-26T12:00:00.000Z', author: '작성자', message: '제목' }]);
  });
});

describe('InputChangeReporter', () => {
  test('교차 리뷰 F2: 이력 재작성으로 멈춘 뒤 epoch가 바뀌면(초기화) 이전 상태를 버리고 새 프로젝트 입력을 보고한다', async () => {
    let epoch = 1, calls = 0;
    const A = 'a'.repeat(40), B = 'b'.repeat(40);
    const api = ((_op: string, request: { body: { base: string } }) => {
      calls++;
      if (epoch === 1 && request.body.base !== A) return Promise.reject(new ApiError('reportInputChanges', 409, { code: 'VERSION_CONFLICT', details: { current: { base: A } } } as never, null));
      return Promise.resolve({ status: 200, headers: new Headers(), body: epoch === 1 ? { head: A, recorded: false, historyRewritten: true } : { head: B, recorded: true, historyRewritten: false } });
    }) as unknown as ApiClient;
    const source: InputSource = { fetch: () => Promise.resolve(B), inputObservation: () => Promise.resolve({ baseIsAncestor: epoch !== 1, treeHash: A, changes: [], commits: [] }) };
    const reporter = new InputChangeReporter({ api, epoch: () => epoch, warn: () => undefined });
    expect(await reporter.report(source)).toMatchObject({ historyRewritten: true });
    expect(await reporter.report(source)).toEqual({ skipped: 'history_rewritten' });
    epoch = 2;
    expect(await reporter.report(source)).toEqual({ head: B, recorded: true, historyRewritten: false });
    expect(calls).toBe(3);
  });

  test('재작성 복구: 같은 epoch에서 정책 inputRecheck가 바뀌면 서버 head를 base로 다시 관측해 보고하고, 그대로면 멈춰 있다', async () => {
    const A = 'a'.repeat(40), C = 'c'.repeat(40);
    let recheck = 0, restored = false;
    const sent: { base: string; head: string }[] = [];
    const api = ((_op: string, request: { body: { base: string; head: string; baseIsAncestor: boolean } }) => {
      sent.push({ base: request.body.base, head: request.body.head });
      if (request.body.base !== A) return Promise.reject(new ApiError('reportInputChanges', 409, { code: 'VERSION_CONFLICT', details: { current: { base: A } } } as never, null));
      return Promise.resolve({ status: 200, headers: new Headers(), body: request.body.baseIsAncestor ? { head: request.body.head, recorded: true, historyRewritten: false } : { head: A, recorded: false, historyRewritten: true } });
    }) as unknown as ApiClient;
    const source: InputSource = { fetch: () => Promise.resolve(C), inputObservation: () => Promise.resolve({ baseIsAncestor: restored, treeHash: C, changes: [], commits: [] }) };
    const reporter = new InputChangeReporter({ api, epoch: () => 1, warn: () => undefined, recheck: () => recheck });
    expect(await reporter.report(source)).toMatchObject({ historyRewritten: true });
    // owner가 복구하기 전·팀장이 확인하기 전: 보내지 않는다.
    restored = true;
    expect(await reporter.report(source)).toEqual({ skipped: 'history_rewritten' });
    const before = sent.length;
    // 팀장 「복구 확인」 → inputRecheck 증가 → 서버 head(A)를 base로 다시 관측해 보낸다.
    recheck = 1;
    expect(await reporter.report(source)).toEqual({ head: C, recorded: true, historyRewritten: false });
    expect(sent.slice(before)).toEqual([{ base: A, head: C }]);
    expect(reporter.stoppedAt).toBeUndefined();
  });

  test('재작성 복구 확인 뒤에도 연결이 안 됐으면 다시 멈추고, 다음 확인 번호에서만 다시 시도한다', async () => {
    const A = 'a'.repeat(40), C = 'c'.repeat(40);
    let recheck = 0, calls = 0;
    const api = (() => { calls++; return Promise.resolve({ status: 200, headers: new Headers(), body: { head: A, recorded: false, historyRewritten: true } }); }) as unknown as ApiClient;
    const source: InputSource = { fetch: () => Promise.resolve(C), inputObservation: () => Promise.resolve({ baseIsAncestor: false, treeHash: C, changes: [], commits: [] }) };
    const reporter = new InputChangeReporter({ api, epoch: () => 1, warn: () => undefined, recheck: () => recheck });
    await reporter.report(source); // head(C)로 물음 → 재작성 응답(서버 head A)
    recheck = 1;
    expect(await reporter.report(source)).toMatchObject({ historyRewritten: true });
    expect(await reporter.report(source)).toEqual({ skipped: 'history_rewritten' });
    expect(calls).toBe(2);
  });

  const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
  const observation = (ancestor = true) => ({ baseIsAncestor: ancestor, treeHash: 'd'.repeat(40), changes: [], commits: [] });
  function fakes(head: string, server: { head: string; rewritten?: boolean }) {
    const sent: { base: string; head: string; epoch: number; key: string }[] = [];
    const asked: [string, string][] = [];
    const source: InputSource = { fetch: () => Promise.resolve(head), inputObservation: (b, h) => { asked.push([b, h]); return Promise.resolve(observation(!server.rewritten)); } };
    const api = ((operation: string, request: { epoch: number; idempotencyKey: string; body: { base: string; head: string } }) => {
      expect(operation).toBe('reportInputChanges');
      sent.push({ base: request.body.base, head: request.body.head, epoch: request.epoch, key: request.idempotencyKey });
      if (request.body.base !== server.head) {
        return Promise.reject(new ApiError('reportInputChanges', 409, { code: 'VERSION_CONFLICT', message: '', action: '', fix: '', details: { current: { base: server.head }, changes: [] }, errors: [], requestId: 'r' } as never, null));
      }
      if (server.rewritten) return Promise.resolve({ status: 200, body: { head: server.head, recorded: false, historyRewritten: true }, headers: new Headers() });
      server.head = request.body.head;
      return Promise.resolve({ status: 200, body: { head: request.body.head, recorded: true, historyRewritten: false }, headers: new Headers() });
    }) as unknown as ApiClient;
    return { sent, asked, source, api };
  }

  test('처음에는 head로 물어 409의 서버 head를 받고, 그 base로 다시 계산해 보낸다', async () => {
    const f = fakes(B, { head: A });
    const warnings: string[] = [];
    const reporter = new InputChangeReporter({ api: f.api, epoch: () => 3, warn: (m) => warnings.push(m) });
    expect(await reporter.report(f.source)).toEqual({ head: B, recorded: true, historyRewritten: false });
    expect(f.asked).toEqual([[B, B], [A, B]]);
    expect(f.sent.map((s) => [s.base, s.head, s.epoch])).toEqual([[B, B, 3], [A, B, 3]]);
    expect(new Set(f.sent.map((s) => s.key)).size).toBe(2);
    expect(reporter.base).toBe(B);
    // 다음 주기는 받은 head를 base로 쓴다(같은 head면 빈 차이로 한 번).
    await reporter.report(f.source);
    expect(f.sent.at(-1)).toMatchObject({ base: B, head: B });
    expect(warnings).toEqual([]);
  });

  test('이력 재작성 응답 뒤에는 같은 base로 다시 보내지 않고 멈춘다', async () => {
    const f = fakes(C, { head: A, rewritten: true });
    const warnings: string[] = [];
    const reporter = new InputChangeReporter({ api: f.api, epoch: () => 1, warn: (m) => warnings.push(m) });
    expect(await reporter.report(f.source)).toEqual({ head: A, recorded: false, historyRewritten: true });
    expect(warnings[0]).toContain('이력 재작성');
    const count = f.sent.length;
    expect(await reporter.report(f.source)).toEqual({ skipped: 'history_rewritten' });
    expect(f.sent.length).toBe(count);
    expect(reporter.stoppedAt).toBe(A);
  });

  test('서버 head가 계속 바뀌면 정해진 횟수 뒤 다음 주기로 미루고, 409 밖의 오류는 그대로 던진다', async () => {
    let n = 0;
    const source: InputSource = { fetch: () => Promise.resolve(C), inputObservation: () => Promise.resolve(observation()) };
    const moving = (() => Promise.reject(new ApiError('reportInputChanges', 409, { code: 'VERSION_CONFLICT', details: { current: { base: (++n % 2 ? A : B) } } } as never, null))) as unknown as ApiClient;
    await expect(new InputChangeReporter({ api: moving, epoch: () => 1, warn: () => undefined, maxAttempts: 3 }).report(source)).rejects.toThrow('3번 안에');
    const invalid = (() => Promise.reject(new ApiError('reportInputChanges', 400, { code: 'VALIDATION_FAILED' } as never, null))) as unknown as ApiClient;
    await expect(new InputChangeReporter({ api: invalid, epoch: () => 1, warn: () => undefined }).report(source)).rejects.toMatchObject({ status: 400 });
  });
});
