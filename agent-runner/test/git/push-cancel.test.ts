// Codex 재리뷰 3(review3-codex.md) P2 회귀 시험: push를 중단하면 git이 띄운 전송 하위 프로세스(git-remote-https·git send-pack)까지 끝낸다.
// 리뷰어 재현(실제 git + 로컬 HTTPS 서버 + git http-backend)을 옮기고 기대 결과를 뒤집었다.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { GitPushAbortedError, GitPushUnknownError, GitRepository, type PushGate } from '../../src/git/repository.ts';
import { processInfo, terminateGroup } from '../../src/exec/launches.ts';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const git = (cwd: string, ...args: string[]) => execFileSync(realGit, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const gateWith = (signal?: AbortSignal, calls?: string[]): PushGate => Object.assign(async () => { calls?.push('gate'); }, { signal });
const processesFor = (needle: string) => execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n').filter((line) => line.includes(needle) && !line.includes('ps -eo'));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** 실제 git http-backend로 조회·push를 처리하는 로컬 HTTPS 원격. stage 요청을 받으면 onStage를 부르고 800ms 늦춘다. */
async function httpsRemote(stage: 'GET' | 'POST', large: boolean) {
  const root = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'push-cancel-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(root, 'key'), '-out', join(root, 'cert'), '-days', '1', '-nodes', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const source = join(root, 'source'), remote = join(root, 'remote.git');
  await mkdir(source); git(source, 'init', '-b', 'main');
  await writeFile(join(source, 'a'), 'old'); git(source, 'add', '-A'); git(source, 'commit', '-m', 'old'); const old = git(source, 'rev-parse', 'HEAD');
  git(source, 'clone', '--bare', source, remote); git(remote, 'config', 'http.receivepack', 'true');
  const branch = 'agent/cancel-https';
  const seed = await GitRepository.clone(join(root, 'runner'), 'p', remote);
  git(source, 'checkout', '-b', branch); git(remote, 'update-ref', `refs/heads/${branch}`, old);
  await writeFile(join(source, 'a'), 'new');
  if (large) await writeFile(join(source, 'large'), randomBytes(8 * 1024 * 1024));
  git(source, 'add', '-A'); git(source, 'commit', '-m', 'new'); const next = git(source, 'rev-parse', 'HEAD');
  git(seed.path, 'fetch', source, branch);
  const stop = new AbortController();
  const requests: string[] = [];
  let receivedAfterCancel = 0;
  let onStage: () => void = () => undefined;
  const staged = new Promise<void>((resolve) => { onStage = resolve; });
  const server = httpsServer({ key: await readFile(join(root, 'key')), cert: await readFile(join(root, 'cert')) }, (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '', 'https://localhost');
      requests.push(`${stop.signal.aborted ? 'AFTER_CANCEL' : 'BEFORE_CANCEL'} ${req.method ?? ''} ${url.pathname}`);
      // 순서 주의: data 수신기를 늦추기 전에 달면 스트림이 흐르기 시작해 그동안의 본문을 잃는다(리뷰어 재현과 같은 순서).
      if (req.method === stage) { onStage(); await sleep(800); }
      req.on('data', (bytes: Buffer) => { if (stop.signal.aborted) receivedAfterCancel += bytes.length; });
      const child = spawn(realGit, ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method ?? 'GET', CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = []; child.stderr.resume(); child.stdout.on('data', (b: Buffer) => chunks.push(b));
      child.on('close', () => {
        const data = Buffer.concat(chunks), split = data.indexOf('\r\n\r\n');
        if (split < 0) { res.writeHead(500); res.end(); return; }
        let status = 200; const headers: Record<string, string> = {};
        for (const line of data.subarray(0, split).toString().split('\r\n')) {
          const n = line.indexOf(':'); if (n < 0) continue;
          const key = line.slice(0, n), value = line.slice(n + 1).trim();
          if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]); else headers[key] = value;
        }
        res.writeHead(status, headers); res.end(data.subarray(split + 4));
      });
      req.pipe(child.stdin); child.stdin.on('error', () => undefined);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
  const url = `https://127.0.0.1:${String(address.port)}/remote.git`;
  const registration = join(root, 'runner/state/git/p.json');
  const record = JSON.parse(await readFile(registration, 'utf8')) as { source: string };
  record.source = url; await writeFile(registration, JSON.stringify(record));
  // 시험용 자체 서명 인증서: 래퍼에서만 TLS 검증을 끈다. 제품 소스와 시스템 git 설정은 바꾸지 않는다.
  const bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'git'), `#!/bin/sh\nexec '${realGit}' -c http.sslVerify=false "$@"\n`); await chmod(join(bin, 'git'), 0o700);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  const repo = await GitRepository.open(join(root, 'runner'), 'p');
  return { root, remote, branch, old, next, url, repo, stop, staged, requests, received: () => receivedAfterCancel,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}

test.each([['POST', true], ['GET', false]] as const)('실제 HTTPS push를 %s 중에 중단하면 전송 하위 프로세스까지 끝나고 중단 뒤 새 요청·원격 변경이 없다', async (stage, large) => {
  const r = await httpsRemote(stage, large);
  try {
    const pushing = r.repo.pushCommit(r.next, r.branch, gateWith(r.stop.signal)).then(() => null, (e: unknown) => e);
    await Promise.race([r.staged, sleep(10_000).then(() => { throw new Error(`${stage} 요청이 오지 않았습니다.`); })]);
    r.stop.abort(new Error(`cancel during HTTPS ${stage}`));
    const error = await pushing;
    // 「중단됨」은 그룹이 비었음을 확인한 뒤에만 온다. 그 시점에 이 원격으로 통신하는 git 프로세스는 없다.
    expect(error).toBeInstanceOf(GitPushAbortedError);
    expect(processesFor(r.url)).toEqual([]);
    await sleep(stage === 'POST' ? 3_500 : 1_800);
    expect(r.requests.filter((line) => line.startsWith('AFTER_CANCEL'))).toEqual([]);
    expect(r.received()).toBe(0);
    expect(git(r.remote, 'rev-parse', r.branch)).toBe(r.old);
    // 다음 push 전에 원격 head를 다시 읽어 대조한다. 아직 옛 커밋이므로 관문을 지나 실제로 push한다.
    const calls: string[] = [];
    expect(await r.repo.pushCommit(r.next, r.branch, gateWith(undefined, calls))).toBe('pushed');
    expect(calls).toEqual(['gate']);
    expect(git(r.remote, 'rev-parse', r.branch)).toBe(r.next);
  } finally { await r.close(); }
}, 60_000);

test('전송 프로세스 종료를 확인하지 못하면 「원격 상태 모름」이고, 다음 push 전에 원격 head를 읽어 이미 반영됐으면 다시 쓰지 않는다', async () => {
  const launches = await import('../../src/exec/launches.ts');
  vi.spyOn(launches, 'terminateGroup').mockResolvedValue(false);
  const r = await httpsRemote('GET', false);
  try {
    const pushing = r.repo.pushCommit(r.next, r.branch, gateWith(r.stop.signal)).then(() => null, (e: unknown) => e);
    await r.staged; r.stop.abort(new Error('cancel'));
    expect(await pushing).toBeInstanceOf(GitPushUnknownError);
    // 그 사이 원격에 이미 그 커밋이 반영된 경우를 만든다(모름 = 반영됐을 수도 있음).
    git(r.repo.path, 'push', r.remote, `${r.next}:refs/heads/${r.branch}`);
    const calls: string[] = [];
    expect(await r.repo.pushCommit(r.next, r.branch, gateWith(undefined, calls))).toBe('already');
    expect(calls).toEqual([]);
  } finally {
    // 모의 때문에 남았을 수 있는 git 프로세스를 정리한다.
    vi.restoreAllMocks();
    for (const line of processesFor(r.url)) { const pid = Number(line.trim().split(/\s+/)[0]); try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝남 */ } }
    await r.close();
  }
}, 60_000);

test('그룹 정리: detached로 띄운 프로세스의 손자까지 TERM으로 끝내고 그룹이 비었음을 확인한다', async () => {
  const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30 & wait'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  const pid = child.pid ?? 0;
  const start = (await processInfo(pid)).startTime;
  await sleep(100);
  expect(await terminateGroup(pid, start, 2_000)).toBe(true);
  expect(() => process.kill(-pid, 0)).toThrow();
});

test('그룹 정리: TERM을 무시하는 구성원은 KILL로 끝낸다', async () => {
  const child = spawn('/bin/sh', ['-c', "trap '' TERM; sleep 30 & trap '' TERM; wait"], { detached: true, stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  const pid = child.pid ?? 0;
  const start = (await processInfo(pid)).startTime;
  await sleep(100);
  expect(await terminateGroup(pid, start, 200)).toBe(true);
});

test('그룹 정리: 시작 시각이 맞지 않으면(번호 재사용 의심) 신호를 보내지 않고 「모름」이다', async () => {
  const child = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  const pid = child.pid ?? 0;
  try {
    expect(await terminateGroup(pid, '999999999999999', 100)).toBe(false);
    expect(() => process.kill(-pid, 0)).not.toThrow();
  } finally { process.kill(-pid, 'SIGKILL'); }
});
