import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createApiClient } from '../../src/api/client.ts';
import { RunnerApp } from '../../src/app.ts';
import { Launches } from '../../src/exec/launches.ts';
import type { CliRegistry } from '../../src/cli-update/manager.ts';
import { sealCredential } from '../../src/github/credential.ts';
import { GitRepository } from '../../src/git/repository.ts';
import { repositoryIdFor } from '../../src/git/identity.ts';
import { resultRefspec } from '../../src/git/publish.ts';
import type { RunCommand } from '../../src/readiness/command.ts';
import type { HostSources } from '../../src/resources/host.ts';
import { Secret } from '../../src/security/secret.ts';
import { State } from '../../src/state/state.ts';
import { GitHubModel } from '../fakes/github/model.ts';
import { startFakeGitHub, type FakeGitHub } from '../fakes/github/server.ts';

/**
 * M4 결합 시나리오: fake 서버 + fake GitHub + 로컬 bare 저장소 + 가짜 CLI로 Runner 전체 흐름을 한 번에 돈다.
 * 연결 → heartbeat → 정리 명령(프로세스 그룹 확인 → git 작업 폴더 정리) → 동기화·정책 →
 * host·준비 점검·모델 보고 → GitHub 키 등록·권한 3상태 보고(첫 쓰기 403 → missing 재보고) → 동시 실행 보고 →
 * CLI 업데이트(바쁠 때 보류 → 유휴 때 적용 → 준비 상태 재보고).
 * 유료 CLI 호출은 없다: CLI·npm은 모두 가짜이고, 부른 명령을 허용 목록과 대조한다.
 */

const RUNNER_TOKEN = 'fake-runner-token-0123456789abcdef';
const GITHUB_TOKEN = 'github_pat_FAKE0123456789fakeFAKEfake';
const BOOT = 'e2e0b007-0000-4000-8000-00000000b007';
const fixture = JSON.parse(await readFile(join(import.meta.dirname, '../../../agent-wbs/contracts/fixtures/reset-cleanup-payloads.json'), 'utf8')) as { withBase: { payload: { holds: Record<string, unknown>[] } & Record<string, unknown> } };

interface Received { method: string; path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }

let root: string;
let server: Server;
let github: FakeGitHub;
let received: Received[];
let state: State | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=시험', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' },
  }).trim();
}

async function write(path: string, text: string) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

beforeEach(async () => {
  root = await mkdtemp(join(process.env.AWBS_TEST_TMP ?? tmpdir(), 'runner-flow-'));
  received = [];
});

afterEach(async () => {
  await state?.close();
  state = undefined;
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  await github.close();
  await rm(root, { recursive: true, force: true });
});

test('M4 결합: 연결부터 CLI 유휴 적용까지 한 시나리오', { timeout: 60_000 }, async () => {
  // ── 원격 저장소(로컬 bare)와 Runner 저장소 ──
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const home = join(root, 'home');
  await mkdir(source);
  await mkdir(home);
  git(source, 'init', '-b', 'main');
  await write(join(source, 'prototype/docs/guide.md'), '입력');
  await write(join(source, 'src/index.ts'), 'export {};');
  await write(join(source, 'contracts/api.json'), '{}');
  await write(join(source, '.agentwbs/policy'), '정책');
  git(source, 'add', '-A');
  git(source, 'commit', '-m', '등록 기준');
  const baseline = git(source, 'rev-parse', 'HEAD');
  git(source, 'init', '--bare', '-b', 'main', remote);
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', 'origin', 'main');
  const repo = await GitRepository.clone(home, repositoryIdFor(remote), remote);
  const worktree = await repo.createWorktree('att-1', 'agent/T1-h1', baseline);
  await repo.checkoutInput('v1', baseline);
  // Agent가 결과 커밋을 만든다 → 결과 SHA를 원격 Agent 브랜치로 직접 push한다(로컬 Agent 브랜치는 옮기지 않음).
  await write(join(worktree, 'src/feature.ts'), 'export const x = 1;');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-m', 'Agent 결과');
  const resultSha = await repo.importWorktree('att-1', 'agent/T1-h1');
  git(repo.path, 'push', 'origin', resultRefspec(resultSha, 'agent/T1-h1'));
  expect(git(remote, 'rev-parse', 'refs/heads/agent/T1-h1')).toBe(resultSha);
  expect(git(repo.path, 'rev-parse', 'refs/heads/agent/T1-h1')).toBe(baseline);

  // ── 끝난 프로세스 그룹(정리 명령의 보유) ──
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  await once(child, 'spawn');
  const pgid = child.pid ?? 0;

  // ── 전용 설치 CLI(현재 버전) ──
  for (const [agent, version] of [['codex', '0.172.0'], ['claude', '2.1.332']] as const) {
    await write(join(home, 'cli', agent, version, 'bin', agent), `가짜 ${agent} ${version}`);
    await symlink(version, join(home, 'cli', agent, 'current'));
  }

  // ── fake GitHub(fine-grained 토큰: 쓰기 미확인, status 쓰기는 권한 없음) ──
  github = await startFakeGitHub(GITHUB_TOKEN);
  const model = new GitHubModel({ tokenPermissions: { statuses: 'read' } });
  model.install(github);
  // 서버가 기록한 PR·원격 Agent 브랜치(초기화 1·2단계 대상)
  model.push('agent/T1-h1');
  const recordedPr = model.openPull('agent/T1-h1').number;

  // ── fake WBS 서버 ──
  const resulted = new Set<string>();
  let credentialCalls = 0;
  let publicKeyPem = '';
  const keyIds = new Map<string, string>();
  const json = (res: ServerResponse, body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const caps = { total: 4, Claude: 2, Codex: 2, heavy: 2 };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      received.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${RUNNER_TOKEN}`) { json(res, { error: { code: 'UNAUTHORIZED' } }, 401); return; }
      const route = `${req.method ?? ''} ${url.pathname}`;
      switch (route) {
        case 'POST /api/runner/heartbeat': res.writeHead(204, { 'x-current-epoch': '0' }).end(); return;
        case 'POST /api/runner/sessions': res.writeHead(204).end(); return;
        case 'GET /api/runner/commands':
          // 실제 reset_project() 출력과 같은 공용 fixture(기준 있음)에서, 시험 환경 값만 바꾼다. 명령 세 개:
          // cmd-1: 이 PC의 로컬 저장소(등록 원격 = 로컬 bare 경로) 정리 — 원격 작업 없음.
          // cmd-3: 다른 저장소의 명령 — 원격에 아무것도 쓰지 않고 failed여야 한다(이중 방어, 재리뷰 N1).
          // cmd-2: 설정된 GitHub 저장소(o/r)의 PR·브랜치 정리 — 이 PC에 로컬 저장소가 없어 원격 main을 기준과 대조한다.
          json(res, { currentEpoch: 0, commands: [
            { id: 'cmd-1', kind: 'reset-cleanup', epoch: 0, payload: {
              ...fixture.withBase.payload, repoUrl: remote, baseCommit: baseline, branches: [], prs: [],
              holds: [{ ...fixture.withBase.payload.holds[0], job: 'job-1', host_id: hostId, boot_id: BOOT, pgid }],
            } },
            { id: 'cmd-3', kind: 'reset-cleanup', epoch: 0, payload: {
              ...fixture.withBase.payload, repoUrl: 'https://github.com/foreign/previous', baseCommit: model.branches.get('main'), branches: ['agent/T1-h1'], prs: [recordedPr], holds: [],
            } },
            { id: 'cmd-2', kind: 'reset-cleanup', epoch: 0, payload: {
              ...fixture.withBase.payload, repoUrl: 'https://github.com/o/r', baseCommit: model.branches.get('main'), branches: ['agent/T1-h1'], prs: [recordedPr], holds: [],
            } },
          ].filter((c) => !resulted.has(c.id)) });
          return;
        case 'GET /api/runner/holds': json(res, { holds: [] }); return;
        case 'GET /api/runner/policy':
          json(res, {
            caps: { ...caps, memReserveGB: 4 }, subagentBudget: { dev: 2, qa: 1 }, heartbeatSeconds: 60, inputCheckMinutes: 10,
            ci: { nightAt: '02:00', retry: 1, deployUrl: null },
            claudeModels: ['claude-opus-5-5', 'claude-sonnet-5-5'],
            cliGrades: [
              { agent: 'Codex', version: '0.172.0', model: 'gpt-6.2-sol', options: 'exec --json', grade: 'verified' },
              { agent: 'Codex', version: '0.173.0', model: 'gpt-6.2-sol', options: 'exec --json', grade: 'partial' },
            ],
          }, 200);
          return;
        case 'GET /api/runner/messages': json(res, { messages: [], nextCursor: null }); return;
        case 'POST /api/runner/host': json(res, { mode: 'auto', caps, recommended: caps, hostChanged: false }); return;
        case 'POST /api/runner/readiness': res.writeHead(204).end(); return;
        case 'POST /api/runner/models': json(res, { newModels: [] }); return;
        case 'POST /api/runner/concurrency': json(res, { caps: { ...caps, memReserveGB: 4 } }); return;
        case 'POST /api/runner/github/key': {
          publicKeyPem = String(body.publicKeyPem);
          const key = String(req.headers['idempotency-key']);
          if (!keyIds.has(key)) keyIds.set(key, `key-${String(keyIds.size + 1)}`);
          json(res, { keyId: keyIds.get(key) });
          return;
        }
        case 'GET /api/runner/github/credential':
          credentialCalls += 1;
          // 첫 조회는 서버 재시작으로 등록이 사라진 상황(404)을 흉내 낸다.
          if (credentialCalls === 1) { json(res, { error: { code: 'NOT_FOUND', message: '등록 없음', details: {} } }, 404); return; }
          if (![...keyIds.values()].includes(url.searchParams.get('keyId') ?? '')) { json(res, { error: { code: 'NOT_FOUND' } }, 404); return; }
          json(res, { sealed: sealCredential(publicKeyPem, GITHUB_TOKEN) });
          return;
        case 'POST /api/runner/github/status': res.writeHead(204).end(); return;
        default: {
          const done = /^POST \/api\/runner\/commands\/(cmd-\d)\/result$/.exec(route);
          if (done?.[1]) { resulted.add(done[1]); res.writeHead(204).end(); return; }
          json(res, { error: { code: 'NOT_FOUND', message: route } }, 404);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const wbsUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  // ── 가짜 PC 정보·명령 실행기 ──
  const files: Record<string, string> = {
    '/etc/machine-id': 'fake-machine-id',
    '/proc/sys/kernel/random/boot_id': BOOT,
    '/proc/meminfo': 'MemTotal: 33554432 kB\nMemAvailable: 25165824 kB\nSwapTotal: 8388608 kB\nSwapFree: 8388608 kB\n',
    '/proc/stat': 'cpu  100 0 100 800 0 0 0 0\n',
    '/proc/self/stat': '1234 (node) S 1 1234 1234 0',
    '/sys/fs/cgroup/cgroup.controllers': 'cpu memory pids',
  };
  const hostSources: HostSources = {
    readFile: (path) => (path in files ? Promise.resolve(files[path] ?? '') : Promise.reject(new Error(`없음: ${path}`))),
    hostname: () => 'fakehost',
    kernel: () => '6.0-fake',
    cores: () => 8,
    diskFree: () => Promise.resolve(200 * 1024 ** 3),
  };
  const ok = (stdout: string) => Promise.resolve({ code: 0, stdout, stderr: '' });
  const baseCalls: string[] = [];
  const cliCalls: string[] = [];
  const run: RunCommand = (cmd, args) => {
    baseCalls.push([cmd, ...args].join(' '));
    if (args.join(' ') === '--version') return ok(cmd === process.execPath ? 'v26.13.0' : cmd === 'git' ? 'git version 2.43.0' : '1.0.0');
    if (cmd === 'git' && args.join(' ') === 'lfs version') return ok('git-lfs/3.4.1');
    return Promise.resolve({ code: 127, stdout: '', stderr: '없는 명령' });
  };
  const versions = { codex: '0.172.0', claude: '2.1.332' };
  const cliRun: RunCommand = (cmd, args) => {
    const agent = cmd.endsWith('/codex') ? 'codex' : 'claude';
    let rest = [...args];
    if (agent === 'codex') {
      expect(rest.slice(0, 2)).toEqual(['-c', 'check_for_update_on_startup=false']);
      rest = rest.slice(2);
    }
    const line = rest.join(' ');
    cliCalls.push(`${agent} ${line}`);
    if (line === '--version') return ok(agent === 'codex' ? `codex-cli ${versions.codex}` : `${versions.claude} (Claude Code)`);
    if (line === 'login status') return ok('Logged in using ChatGPT');
    if (line === 'auth status --json') return ok('{"loggedIn":true}');
    if (line === 'debug models --bundled') return ok(JSON.stringify({ models: [{ slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }] }));
    if (line === '--help') return ok('  --effort <level>  Effort (low, high)\n');
    return Promise.resolve({ code: 99, stdout: '', stderr: '허용되지 않은 CLI 호출' });
  };
  const installs: string[] = [];
  const registry: CliRegistry = {
    latest: (agent) => Promise.resolve(agent === 'Codex' ? '0.173.0' : '2.1.333'),
    async install(agent, version, directory) {
      installs.push(`${agent}@${version}`);
      await write(join(directory, 'bin', agent.toLowerCase()), `가짜 ${agent} ${version}`);
    },
    probe: () => Promise.resolve(),
  };

  state = await State.open(join(home, 'state'));
  const app = new RunnerApp({
    state,
    api: createApiClient({ baseUrl: wbsUrl, token: new Secret(RUNNER_TOKEN) }),
    home,
    version: '0.0.0-test',
    env: { PATH: process.env.PATH, HOME: home },
    warn: () => undefined,
    hostSources,
    run,
    cliRun,
    cliRegistry: registry,
    cliProfiles: () => [{ agent: 'Codex', model: 'gpt-6.2-sol', options: 'exec --json' }],
    github: { repo: { owner: model.owner, repo: model.repo }, mode: 'token', baseUrl: github.url },
  });
  await app.init();
  const hostId = app.identity.hostId;
  const launches = new Launches(home, app.identity);
  const old = await launches.create({ id: 'job-1', epoch: 0, fence: 1 });
  await launches.attach(old, pgid);
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;

  // 1. 연결·heartbeat
  await app.runner.start();
  await app.runner.heartbeat();
  // 2. 명령 poll → 정리: 그룹 종료 확인 후 git 정리
  await app.runner.poll();
  const result = received.find((r) => r.path === '/api/runner/commands/cmd-1/result');
  expect(result?.body).toMatchObject({ status: 'done', holds: [{ job: 'job-1', hostId, bootId: BOOT, proof: 'group_empty', processGroup: pgid }] });
  await expect(lstat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(join(home, 'inputs', repositoryIdFor(remote), 'v1'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(git(repo.path, 'for-each-ref', 'refs/heads/agent')).toBe('');
  // 원격 정리는 실제 GitHub 클라이언트로: PR 닫기 → 기록된 원격 브랜치 삭제(되돌림은 필요 없음)
  expect(model.pulls.get(recordedPr)?.state).toBe('closed');
  expect(model.branches.has('agent/T1-h1')).toBe(false);
  const order = github.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
  expect(order).toEqual([`PATCH /repos/o/r/pulls/${String(recordedPr)}`, 'DELETE /repos/o/r/git/refs/heads/agent/T1-h1']);
  // 다른 저장소 명령은 원격 쓰기 없이 failed. 위 쓰기 두 개는 모두 cmd-2의 것이다.
  const foreign = received.find((r) => r.path === '/api/runner/commands/cmd-3/result');
  expect(foreign?.body).toMatchObject({ status: 'failed', items: expect.arrayContaining([expect.objectContaining({ name: 'github:repo', ok: false })]) as unknown });
  expect(received.find((r) => r.path === '/api/runner/commands/cmd-2/result')?.body).toMatchObject({ status: 'done' });
  expect(app.runner.ready).toBe(false);
  // 같은 이름으로 다음 시도를 만들 수 있다(결과 SHA push 원칙 덕분에 로컬 브랜치가 지워졌다).
  await repo.createWorktree('att-2', 'agent/T1-h1', baseline);
  await repo.removeWorktree('att-2');

  // 3. 빈 명령 → 동기화·정책
  await app.runner.poll();
  expect(app.runner.ready).toBe(true);
  expect(app.runner.policy?.claudeModels).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);

  // 4. 시작 보고: host → 준비 점검 → 모델 → GitHub
  await app.bootstrap();
  const posted = (path: string) => received.filter((r) => r.method === 'POST' && r.path === path).map((r) => r.body);
  expect(posted('/api/runner/host')[0]).toMatchObject({ hostId, bootId: BOOT });
  expect(app.heavy.snapshot().capacity).toBe(2);
  const readiness = posted('/api/runner/readiness')[0] as { items: { key: string; status: string; detail: string }[]; cli?: unknown[] };
  const item = (key: string) => readiness.items.find((i) => i.key === key);
  expect(item('repo')).toMatchObject({ status: 'ok', detail: expect.stringContaining('flock') as unknown });
  expect(item('codex')).toMatchObject({ status: 'ok', detail: expect.stringContaining('0.172.0') as unknown });
  expect(item('obs')).toMatchObject({ status: 'ok', detail: expect.stringContaining('cgroup') as unknown });
  expect(readiness.cli).toEqual([{ agent: 'Codex', version: '0.172.0', model: 'gpt-6.2-sol', options: 'exec --json' }]);
  const models = posted('/api/runner/models');
  expect(models).toEqual([
    { agent: 'Codex', models: [{ id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', efforts: ['low'] }] },
    { agent: 'Claude', models: [{ id: 'claude-opus-5-5', label: 'claude-opus-5-5', efforts: ['low', 'high'] }, { id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5', efforts: ['low', 'high'] }] },
  ]);
  // GitHub 키: 등록 → 404 → 새 Idempotency-Key로 재등록 → 봉인 조회 성공
  const keyRequests = received.filter((r) => r.path === '/api/runner/github/key');
  // 정리 단계에서 처음 토큰을 받을 때 404 → 새 키로 재등록, 시작 보고의 연결 확인에서 한 번 더 등록한다.
  expect(keyRequests).toHaveLength(3);
  expect(keyRequests[0]?.headers['idempotency-key']).not.toBe(keyRequests[1]?.headers['idempotency-key']);
  expect(keyRequests[0]?.body).toMatchObject({ hostId, bootId: BOOT, sealedVersion: 1 });
  const status1 = posted('/api/runner/github/status')[0];
  expect(status1).toMatchObject({ mode: 'token', ok: true, scopes: { metadata: 'verified', contents: 'unverified', pulls: 'unverified', statuses: 'unverified' } });
  expect(typeof status1?.warning).toBe('string');

  // 5. GitHub 첫 쓰기 403 → missing 재보고
  const head = model.branches.get('main') ?? '';
  await expect(app.github?.client.setCommitStatus({ sha: head, context: 'agentwbs/task', state: 'pending' })).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await app.runner.outbox.flush();
  const status2 = posted('/api/runner/github/status')[1];
  expect(status2).toMatchObject({ ok: false, scopes: { statuses: 'missing' } });
  expect(typeof status2?.error).toBe('string');

  // 6. 동시 실행 보고
  await app.reportConcurrency();
  expect(posted('/api/runner/concurrency')[0]).toMatchObject({ limit: expect.any(Number) as unknown, running: { Claude: 0, Codex: 0 }, heavyJobs: 0 });

  // 7. CLI 업데이트: 바쁘면 보류, 유휴면 적용
  app.sessions.push({ attemptId: 'a1', agent: 'Codex', observed: 1, reserved: 1, state: 'ok', children: 1 });
  await app.updater.check();
  await app.updater.applyPending();
  expect(await readlink(join(home, 'cli/codex/current'))).toBe('0.172.0');
  const held = posted('/api/runner/readiness').at(-1) as typeof readiness;
  expect(held.items.find((i) => i.key === 'codex')).toMatchObject({ status: 'warn', detail: expect.stringContaining('업데이트 대기 0.173.0') as unknown });
  app.sessions.splice(0);
  await app.updater.applyPending();
  versions.codex = '0.173.0';
  versions.claude = '2.1.333';
  expect(await readlink(join(home, 'cli/codex/current'))).toBe('0.173.0');
  expect(await readlink(join(home, 'cli/claude/current'))).toBe('2.1.333');
  expect(installs).toEqual(['Codex@0.173.0', 'Claude@2.1.333']);
  const applied = posted('/api/runner/readiness').at(-1) as typeof readiness;
  expect(applied.items.find((i) => i.key === 'codex')).toMatchObject({ status: 'ok' });
  // 새 버전 조합은 서버 등급이 partial이라 미검증 warn, 준비 점검과 같은 cgroup 문구를 쓴다(M-1).
  expect(applied.items.find((i) => i.key === 'obs')).toMatchObject({ status: 'warn', detail: expect.stringContaining('cgroup') as unknown });
  // 다시 준비 점검해도 같은 전용 설치를 본다.
  await app.checkReadiness();
  const after = posted('/api/runner/readiness').at(-1) as typeof readiness;
  expect(after.items.find((i) => i.key === 'codex')?.detail).toContain('0.173.0');
  expect(app.reporter.blocked).toEqual([]);

  // 유료 호출 없음: CLI는 버전·로그인·도움말·동봉 모델 목록만 불렀다.
  const allowed = new Set(['--version', 'login status', 'auth status --json', 'debug models --bundled', '--help']);
  expect(cliCalls.every((c) => allowed.has(c.slice(c.indexOf(' ') + 1)))).toBe(true);
  expect(baseCalls.some((c) => c.includes('codex') || c.includes('claude'))).toBe(false);
  // 전용 설치만 부른다(전역 CLI 이름으로 부른 적 없음).
  expect(cliCalls.length).toBeGreaterThan(0);
  github.assertNoUnexpected();
  expect(await readFile(join(home, 'cli/codex/0.172.0/bin/codex'), 'utf8')).toBe('가짜 codex 0.172.0');
});
