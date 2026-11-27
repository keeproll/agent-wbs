import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GitRepository } from '../../src/git/repository.ts';

let home: string;
let source: string;
let remote: string;
let parent: string;
let commit: string;
let repo: GitRepository;
let socket: string;
let knownHosts: string;
let server: Server;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'system-push-'));
  source = join(home, 'source'); remote = join(home, 'remote.git');
  await mkdir(join(source, 'src'), { recursive: true });
  git(source, 'init', '-b', 'main');
  await writeFile(join(source, 'src/a'), 'before');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'base');
  parent = git(source, 'rev-parse', 'HEAD');
  git(source, 'clone', '--bare', source, remote);
  repo = await GitRepository.clone(home, 'p1', remote);
  await writeFile(join(source, 'src/a'), 'after'); git(source, 'commit', '-am', 'reset');
  commit = git(source, 'rev-parse', 'HEAD');
  git(repo.path, 'fetch', source, 'main');
  // 통신은 아래 가짜 ssh가 로컬 bare 저장소로 연결한다. 실제 GitHub에는 접속하지 않는다.
  const registration = join(home, 'state/git/p1.json');
  const record = JSON.parse(await readFile(registration, 'utf8')) as { source: string };
  record.source = 'https://github.com/o/r.git';
  await writeFile(registration, JSON.stringify(record));
  repo = await GitRepository.open(home, 'p1');
  socket = join(home, 'agent.sock'); knownHosts = join(home, "known'hosts");
  server = createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await writeFile(knownHosts, 'public-host-key-fixture\n');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

/** 관문 통과(관문 자체의 시험은 test/external-writes.test.ts). */
const pass = async (): Promise<void> => undefined;

test('M4-06: 시스템 SSH만 허용하고, 서버 확인·소켓·main 일반 push를 고정한다', async () => {
  const bin = join(home, 'bin'); await mkdir(bin);
  const capture = join(home, 'ssh.json');
  await writeFile(join(bin, 'ssh'), `#!${process.execPath}\nconst fs=require('fs');const cp=require('child_process');
fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),socket:process.env.SSH_AUTH_SOCK,protocol:process.env.GIT_ALLOW_PROTOCOL}));
const r=cp.spawnSync('git-receive-pack',[${JSON.stringify(remote)}],{stdio:'inherit'});process.exit(r.status??1);\n`);
  await chmod(join(bin, 'ssh'), 0o700);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  const before = createHash('sha256').update(await readFile(join(repo.path, 'config'))).digest('hex');
  // M5·M7 통합: 관문(M4 원격·배포 키)이 거부하면 push하지 않는다. 관문은 등록된 https 원격을 받는다.
  const seen: unknown[] = [];
  await expect(repo.pushSystemCommit(parent, null, { socket, knownHosts }, async (operation) => { seen.push(operation); throw new Error('관문 거부'); })).rejects.toThrow('관문 거부');
  expect(seen).toEqual([{ kind: 'branch_push', branch: 'main', remote: await repo.source() }]);
  await expect(readFile(capture, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await repo.pushSystemCommit(parent, null, { socket, knownHosts }, pass);
  expect(git(remote, 'rev-parse', 'main')).toBe(parent);
  await repo.pushSystemCommit(commit, parent, { socket, knownHosts }, pass);
  expect(git(remote, 'rev-parse', 'main')).toBe(commit);
  const call = JSON.parse(await readFile(capture, 'utf8')) as { args: string[]; socket: string; protocol: string };
  expect(call.socket).toBe(socket);
  expect(call.protocol).toBe('ssh');
  expect(call.args.slice(0, 2)).toEqual(['-F', '/dev/null']);
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'IdentityFile=none', 'ForwardAgent=no',
    'GlobalKnownHostsFile=/dev/null', `UserKnownHostsFile=${knownHosts}`]) {
    expect(call.args[call.args.indexOf(option) - 1]).toBe('-o');
  }
  expect(call.args).toEqual(expect.arrayContaining(['443', 'git@ssh.github.com']));
  expect(createHash('sha256').update(await readFile(join(repo.path, 'config'))).digest('hex')).toBe(before);
});

test('M4-06: 부모 불일치·초기화 밖 경로 변경·잘못된 인증 경로는 SSH 실행 전에 거부한다', async () => {
  const ssh = { socket, knownHosts };
  await expect(repo.pushSystemCommit(commit, 'f'.repeat(40), ssh, pass)).rejects.toThrow(/부모/);
  await expect(repo.pushSystemCommit(commit, null, ssh, pass)).rejects.toThrow(/최초/);
  await writeFile(join(source, 'unrelated.txt'), 'must stay');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'outside');
  const outside = git(source, 'rev-parse', 'HEAD');
  git(repo.path, 'fetch', source, 'main');
  await expect(repo.pushSystemCommit(outside, commit, ssh, pass)).rejects.toThrow(/초기화 대상 밖/);
  await expect(repo.pushSystemCommit(commit, parent, { socket: knownHosts, knownHosts }, pass)).rejects.toThrow(/소켓/);
  await expect(repo.pushSystemCommit(commit, parent, { socket, knownHosts: socket }, pass)).rejects.toThrow(/서버 키/);
  expect(git(remote, 'rev-parse', 'main')).toBe(parent);
});

test.each(['https://example.com/o/r.git', 'file://github.com/o/r.git'])('L1: 다른 호스트·통신 방식은 SSH 실행 전에 거부한다: %s', async (sourceUrl) => {
  const bin = join(home, 'bin'); await mkdir(bin);
  const marker = join(home, 'ssh-executed');
  await writeFile(join(bin, 'ssh'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'called');process.exit(1);\n`);
  await chmod(join(bin, 'ssh'), 0o700); vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  const registration = join(home, 'state/git/p1.json');
  const record = JSON.parse(await readFile(registration, 'utf8')) as { source: string };
  record.source = sourceUrl; await writeFile(registration, JSON.stringify(record));
  repo = await GitRepository.open(home, 'p1');
  await expect(repo.pushSystemCommit(commit, parent, { socket, knownHosts }, pass)).rejects.toThrow(/등록된 github.com/);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
