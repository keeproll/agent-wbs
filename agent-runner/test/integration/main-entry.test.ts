import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { sealCredential } from '../../src/github/credential.ts';
import { repositoryIdFor } from '../../src/git/identity.ts';
import { GitRepository } from '../../src/git/repository.ts';
import { GitHubModel } from '../fakes/github/model.ts';
import { startFakeGitHub, type FakeGitHub } from '../fakes/github/server.ts';

/**
 * 실제 진입점(`node src/main.ts`) 결합 시험(교차 리뷰 요청).
 * - 정리 명령 payload는 실제 `reset_project()` 출력과 같은 공용 fixture에서 시험 환경 값만 바꾼다.
 * - 원격 정리는 main이 조립한 실제 GitHub 클라이언트가 fake GitHub에 보낸다.
 * - 유료 CLI·npm은 부르지 않는다(AWBS_CLI_UPDATE=0, 전용 CLI 미설치 → 준비 점검이 fail로 보고할 뿐).
 */

const main = join(import.meta.dirname, '../../src/main.ts');
const RUNNER_TOKEN = 'main-entry-runner-token-0123456789abcdef';
const GITHUB_TOKEN = 'github_pat_MAINentry0123456789fakeFAKE';
const fixture = JSON.parse(await readFile(join(import.meta.dirname, '../../../agent-wbs/contracts/fixtures/reset-cleanup-payloads.json'), 'utf8')) as { withBase: { payload: { holds: Record<string, unknown>[] } & Record<string, unknown> } };

let root: string;
let server: Server | undefined;
let github: FakeGitHub | undefined;
beforeEach(async () => { root = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'main-entry-')); });
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => { server?.close(() => resolve()); server?.closeAllConnections(); });
  await github?.close();
  server = undefined; github = undefined;
  await rm(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' } }).trim();
}
const json = (res: ServerResponse, body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
async function listen(s: Server): Promise<string> {
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((s.address() as AddressInfo).port)}`;
}
function run(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [main], { env: { PATH: process.env.PATH, HOME: process.env.HOME, AWBS_CLI_UPDATE: '0', LOG_LEVEL: 'warn', ...env } });
  let output = '';
  child.stdout.on('data', (c) => (output += String(c)));
  child.stderr.on('data', (c) => (output += String(c)));
  return { child, output: () => output };
}
const until = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 50)); }
  return true;
};

test('main: 실제 DB 모양의 정리 명령 → 그룹 종료 증명 → 로컬·원격 정리 → 동기화·시작 보고 → SIGTERM 정상 종료', { timeout: 60_000 }, async () => {
  // 원격(bare)·Runner 저장소·작업 폴더
  const source = join(root, 'source'); const remote = join(root, 'remote.git'); const home = join(root, 'home');
  await mkdir(join(source, 'src'), { recursive: true }); await mkdir(join(source, 'prototype')); await mkdir(home);
  git(source, 'init', '-b', 'main');
  await writeFile(join(source, 'src/a.ts'), 'a'); await writeFile(join(source, 'prototype/p.md'), 'p');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'base');
  const base = git(source, 'rev-parse', 'HEAD');
  git(source, 'clone', '--bare', source, remote);
  const repo = await GitRepository.clone(home, repositoryIdFor(remote), remote);
  const worktree = await repo.createWorktree('att-1', 'agent/T1-h1', base);
  // 끝난 프로세스 그룹
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  await once(child, 'exit');
  const pgid = child.pid ?? 0;
  // 이 PC의 실제 식별자(host 보고와 같은 계산)
  const machine = (await readFile('/etc/machine-id', 'utf8')).trim();
  const hostId = `${hostname()}-${createHash('sha256').update(machine).digest('hex').slice(0, 16)}`;
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();

  github = await startFakeGitHub(GITHUB_TOKEN);
  const model = new GitHubModel();
  model.install(github);
  model.push('agent/T1-h1');
  const pr = model.openPull('agent/T1-h1').number;

  const received: { method: string; path: string; body: Record<string, unknown> }[] = [];
  let done = false;
  let publicKeyPem = '';
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      received.push({ method: req.method ?? '', path: url.pathname, body });
      const caps = { total: 2, Claude: 1, Codex: 1, heavy: 1 };
      switch (`${req.method ?? ''} ${url.pathname}`) {
        case 'POST /api/runner/heartbeat': res.writeHead(204, { 'x-current-epoch': '0' }).end(); return;
        case 'GET /api/runner/commands':
          json(res, { currentEpoch: 0, commands: done ? [] : [{ id: 'cmd-1', kind: 'reset-cleanup', epoch: 0, payload: {
            ...fixture.withBase.payload, repoUrl: remote, baseCommit: base, branches: ['agent/T1-h1'], prs: [pr],
            holds: [{ ...fixture.withBase.payload.holds[0], host_id: hostId, boot_id: bootId, pgid }],
          } }] });
          return;
        case 'POST /api/runner/commands/cmd-1/result': done = body.status === 'done'; res.writeHead(204).end(); return;
        case 'GET /api/runner/policy':
          json(res, { caps: { ...caps, memReserveGB: 4 }, subagentBudget: { dev: 1, qa: 1 }, heartbeatSeconds: 60, inputCheckMinutes: 10,
            ci: { nightAt: '02:00', retry: 1, deployUrl: null }, claudeModels: ['claude-opus-5-5'], cliGrades: [] });
          return;
        case 'GET /api/runner/messages': json(res, { messages: [], nextCursor: null }); return;
        case 'POST /api/runner/host': json(res, { mode: 'auto', caps, recommended: caps, hostChanged: false }); return;
        case 'POST /api/runner/models': json(res, { newModels: [] }); return;
        case 'POST /api/runner/concurrency': json(res, { caps: { ...caps, memReserveGB: 4 } }); return;
        case 'POST /api/runner/github/key': publicKeyPem = String(body.publicKeyPem); json(res, { keyId: 'k1' }); return;
        case 'GET /api/runner/github/credential': json(res, { sealed: sealCredential(publicKeyPem, GITHUB_TOKEN) }); return;
        default: res.writeHead(204).end();
      }
    });
  });
  const wbsUrl = await listen(server);
  const proc = run({ AWBS_RUNNER_TOKEN: RUNNER_TOKEN, AWBS_URL: wbsUrl, AWBS_HOME: home,
    AWBS_GITHUB_REPO: 'https://github.com/o/r', AWBS_GITHUB_MODE: 'token', AWBS_GITHUB_API_URL: github.url });
  try {
    expect(await until(() => received.some((r) => r.path === '/api/runner/readiness'), 30_000)).toBe(true);
    const result = received.find((r) => r.path === '/api/runner/commands/cmd-1/result');
    expect(result?.body).toMatchObject({ status: 'done', holds: [{ hostId, bootId, proof: 'group_empty', processGroup: pgid }] });
    await expect(lstat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(model.pulls.get(pr)?.state).toBe('closed');
    expect(model.branches.has('agent/T1-h1')).toBe(false);
    expect(received.some((r) => r.path === '/api/runner/host' && r.body.hostId === hostId)).toBe(true);
    expect(await until(() => received.some((r) => r.path === '/api/runner/github/status'), 10_000)).toBe(true);
  } finally {
    proc.child.kill('SIGTERM');
  }
  const [code] = await once(proc.child, 'close') as [number | null];
  expect(code).toBe(0);
  expect(received.filter((r) => r.path === '/api/runner/sessions').map((r) => r.body.event)).toEqual(['start', 'stop']);
  expect(proc.output()).not.toContain(RUNNER_TOKEN);
  expect(proc.output()).not.toContain(GITHUB_TOKEN);
});

test('main: 모든 요청이 401이면 외부 신호 없이 스스로 종료 코드 1로 끝난다(P1-3)', { timeout: 30_000 }, async () => {
  server = createServer((_req, res) => json(res, { error: { code: 'UNAUTHORIZED', message: 'x' } }, 401));
  const wbsUrl = await listen(server);
  const home = join(root, 'home');
  const proc = run({ AWBS_RUNNER_TOKEN: RUNNER_TOKEN, AWBS_URL: wbsUrl, AWBS_HOME: home });
  const closed = once(proc.child, 'close') as Promise<[number | null]>;
  const finished = await Promise.race([closed.then(([code]) => code), new Promise((r) => setTimeout(() => r('timeout'), 10_000))]);
  if (finished === 'timeout') proc.child.kill('SIGKILL');
  expect(finished).toBe(1);
  expect(proc.output()).toContain('API_ERROR');
});
