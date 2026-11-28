import { join } from 'node:path';
import { expect, test } from 'vitest';
import { cliBinary } from '../src/cli-update/manager.ts';
import { cliAwareRun } from '../src/cli-update/registry.ts';
import { loadConfig } from '../src/config.ts';
import { checkGitHost } from '../src/git/probe.ts';
import { resultRefspec } from '../src/git/publish.ts';
import { systemSshCommand } from '../src/git/repository.ts';
import { verifiedFromPolicy } from '../src/readiness/checks.ts';
import type { RunCommand } from '../src/readiness/command.ts';

const ok = (stdout: string): ReturnType<RunCommand> => Promise.resolve({ code: 0, stdout, stderr: '' });

test('M-1: 준비 점검·업데이트·세션이 같은 전용 설치 경로를 쓴다', () => {
  expect(cliBinary('/h', 'Codex')).toBe(join('/h', 'cli/codex/current/bin/codex'));
  expect(cliBinary('/h', 'Claude')).toBe(join('/h', 'cli/claude/current/bin/claude'));
});

test('cliAwareRun: 전용 CLI는 세션과 같은 인자·실행기로, 다른 명령은 원래 실행기로', async () => {
  const seen: string[] = [];
  const base: RunCommand = (cmd, args) => { seen.push(`base ${cmd} ${args.join(' ')}`); return ok(''); };
  const cli: RunCommand = (cmd, args) => { seen.push(`cli ${cmd} ${args.join(' ')}`); return ok(''); };
  const run = cliAwareRun(base, cli, { codex: '/c/codex', claude: '/c/claude' });
  await run('/c/codex', ['--version']);
  await run('/c/claude', ['--version']);
  await run('git', ['--version']);
  expect(seen).toEqual(['cli /c/codex -c check_for_update_on_startup=false --version', 'cli /c/claude --version', 'base git --version']);
});

test('verifiedFromPolicy: 정책 cliGrades 중 verified만, 정책이 없으면 확인 불가(undefined)', () => {
  expect(verifiedFromPolicy(undefined)).toBeUndefined();
  expect(verifiedFromPolicy([
    { agent: 'Codex', version: '1.0.0', model: 'm', options: 'o', grade: 'verified' },
    { agent: 'Claude', version: '2.0.0', model: 'm', options: 'o', grade: 'partial' },
  ])).toEqual([{ agent: 'Codex', version: '1.0.0', model: 'm', options: 'o' }]);
});

test('repo 준비 점검: /proc 없으면 fail, flock 없으면 warn, 둘 다 있으면 ok', async () => {
  const proc = (path: string) => Promise.resolve(path.endsWith('boot_id') ? 'b' : '1 (node) S');
  const noProc = () => Promise.reject(new Error('ENOENT'));
  const flock: RunCommand = () => ok('flock from util-linux 2.39.3');
  const noFlock: RunCommand = () => Promise.resolve({ code: null, stdout: '', stderr: 'ENOENT' });
  expect((await checkGitHost(flock, noProc)).status).toBe('fail');
  expect((await checkGitHost(noFlock, proc)).status).toBe('warn');
  expect(await checkGitHost(flock, proc)).toMatchObject({ status: 'ok', detail: expect.stringContaining('2.39.3') as unknown });
});

test('결과 SHA push refspec: 결과 SHA를 원격 Agent 브랜치로만 보낸다', () => {
  const sha = 'a'.repeat(40);
  expect(resultRefspec(sha, 'agent/T-1-h2')).toBe(`${sha}:refs/heads/agent/T-1-h2`);
  expect(() => resultRefspec('abc', 'agent/T')).toThrow();
  expect(() => resultRefspec(sha, 'main')).toThrow();
});

test('설정: GitHub 저장소·방식과 CLI 업데이트 끄기', () => {
  const AWBS_RUNNER_TOKEN = 'x'.repeat(43);
  expect(loadConfig({ AWBS_RUNNER_TOKEN })).toMatchObject({ github: null, cliUpdates: true });
  expect(loadConfig({ AWBS_RUNNER_TOKEN, AWBS_GITHUB_REPO: 'https://github.com/acme/app', AWBS_GITHUB_MODE: 'token', AWBS_CLI_UPDATE: '0' }))
    .toMatchObject({ github: { repo: { owner: 'acme', repo: 'app' }, mode: 'token' }, cliUpdates: false });
  expect(() => loadConfig({ AWBS_RUNNER_TOKEN, AWBS_GITHUB_REPO: 'https://github.com/acme/app/tree/main' })).toThrow();
  expect(() => loadConfig({ AWBS_RUNNER_TOKEN, AWBS_GITHUB_REPO: 'https://github.com/acme/app', AWBS_GITHUB_MODE: 'pat' })).toThrow();
  expect(loadConfig({ AWBS_RUNNER_TOKEN, AWBS_GITHUB_REPO: 'https://github.com/acme/app', AWBS_GITHUB_API_URL: 'http://127.0.0.1:9/' }).github)
    .toMatchObject({ baseUrl: 'http://127.0.0.1:9' });
  expect(() => loadConfig({ AWBS_RUNNER_TOKEN, AWBS_GITHUB_REPO: 'https://github.com/acme/app', AWBS_GITHUB_API_URL: 'http://u:hunter2@x/' })).toThrow();
});

test('M4-06: 시스템 키 번호·소켓·서버 키 목록을 함께 받고, 비밀키 파일 설정은 만들지 않는다', () => {
  const base = { AWBS_RUNNER_TOKEN: 'x'.repeat(43), AWBS_GITHUB_REPO: 'https://github.com/acme/app' };
  const fields = { AWBS_SYSTEM_DEPLOY_KEY_ID: '7', AWBS_SYSTEM_SSH_AUTH_SOCK: '/run/user/1000/system.sock',
    AWBS_SYSTEM_SSH_KNOWN_HOSTS: '/home/user/github-known-hosts' };
  expect(loadConfig({ ...base, ...fields }).github).toMatchObject({ systemKey: {
    id: 7, socket: fields.AWBS_SYSTEM_SSH_AUTH_SOCK, knownHosts: fields.AWBS_SYSTEM_SSH_KNOWN_HOSTS,
  } });
  expect(() => loadConfig({ ...base, AWBS_SYSTEM_DEPLOY_KEY_ID: '7' })).toThrow(/시스템/);
  expect(() => loadConfig({ ...base, ...fields, AWBS_SYSTEM_DEPLOY_KEY_ID: '0' })).toThrow(/시스템/);
  expect(() => loadConfig({ ...base, ...fields, AWBS_SYSTEM_SSH_AUTH_SOCK: 'relative.sock' })).toThrow(/절대 경로/);
  expect(() => loadConfig({ ...fields, AWBS_RUNNER_TOKEN: 'x'.repeat(43) })).toThrow(/AWBS_GITHUB_REPO/);
});

test('W5 E2: 운영 GitHub API override는 HTTPS만 허용한다', () => {
  const base = { NODE_ENV: 'production', AWBS_RUNNER_TOKEN: 'x'.repeat(43), AWBS_GITHUB_REPO: 'https://github.com/acme/app' };
  expect(() => loadConfig({ ...base, AWBS_GITHUB_API_URL: 'http://127.0.0.1:9' })).toThrow(/https/);
  expect(loadConfig({ ...base, AWBS_GITHUB_API_URL: 'https://api.github.com' }).github).toMatchObject({ baseUrl: 'https://api.github.com' });
  expect(loadConfig({ ...base, NODE_ENV: 'test', AWBS_GITHUB_API_URL: 'http://127.0.0.1:9' }).github).toMatchObject({ baseUrl: 'http://127.0.0.1:9' });
});

test('W5 T-14: 시스템 SSH push는 지정한 서버 키 목록과 엄격한 확인을 유지한다', () => {
  const command = systemSshCommand('/tmp/awbs-W5-known hosts');
  expect(command).toContain('-o StrictHostKeyChecking=yes');
  expect(command).toContain("-o UserKnownHostsFile='/tmp/awbs-W5-known hosts'");
  expect(command).toContain('-o GlobalKnownHostsFile=/dev/null');
  expect(command).not.toMatch(/StrictHostKeyChecking=(?:no|off|accept-new)|UserKnownHostsFile=\/dev\/null/);
  expect(systemSshCommand("/tmp/awbs-W5-owner's hosts")).toContain("UserKnownHostsFile='/tmp/awbs-W5-owner'\\''s hosts'");
});

test('봉인 형식 v1 고정 벡터: Runner 시험 사본이 공용 계약 fixture와 같다', async () => {
  const { readFile } = await import('node:fs/promises');
  const shared = await readFile(join(import.meta.dirname, '../../agent-wbs/contracts/fixtures/sealed-v1-vector.json'), 'utf8');
  const local = await readFile(join(import.meta.dirname, 'github/fixtures/sealed-v1-vector.json'), 'utf8');
  expect(JSON.parse(local)).toEqual(JSON.parse(shared));
});
