import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRepository } from '../../src/git/repository.ts';
import { createGitHubClient, type WriteOperation } from '../../src/github/client.ts';
import { Secret } from '../../src/security/secret.ts';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import { startFakeGitHub } from '../fakes/github/server.ts';

export function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' },
  }).trim();
}
export async function file(path: string, value: string) {
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, value);
}
export function commit(cwd: string) {
  git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', '시험 변경'); return git(cwd, 'rev-parse', 'HEAD');
}
export const definition = { version: 1, stages: {
  task: ['install', 'typecheck', 'lint', 'unit', 'build', 'contract'].map(name => ({ name, argv: ['fake', name] })),
  int: ['build', 'test', 'migrate', 'services', 'health', 'e2e'].map(name => ({ name, argv: ['fake', `int-${name}`] })),
  night: [{ name: 'night', argv: ['fake', 'night'] }], deploy: [{ name: 'deploy', argv: ['fake', 'deploy'] }],
} };

export async function fixture(taskBranch = 'agent/task') {
  const root = await mkdtemp(join(tmpdir(), 'ci-int-'));
  const source = join(root, 'source'); const remote = join(root, 'remote.git'); await mkdir(source);
  git(source, 'init', '-b', 'main');
  await file(join(source, '.agentwbs/pipeline.yaml'), JSON.stringify(definition));
  await file(join(source, '.gitignore'), 'node_modules/\ndist/\n');
  await file(join(source, 'shared'), 'original');
  commit(source);
  git(source, 'checkout', '-b', taskBranch);
  await file(join(source, 'task'), 'task'); const head = commit(source);
  git(source, 'checkout', 'main');
  await file(join(source, 'other'), 'main'); const base = commit(source);
  git(source, 'clone', '--bare', source, remote);
  const repo = await GitRepository.clone(join(root, 'runner'), 'project', remote);
  const github = await startFakeGitHub('FAKE');
  const statuses = new Map<string, string>();
  const merged = new Map<number, string>();
  const branch = (pr: number) => pr === 1 ? taskBranch : `agent/task${String(pr)}`;
  const ref = (name: string) => git(remote, 'rev-parse', `refs/heads/${name}`);
  let beforeWrite: (op: WriteOperation) => void | Promise<void> = () => undefined;
  github.on('GET /repos/o/r/branches/main', () => ({ body: { commit: { sha: ref('main') } } }));
  github.on('GET /repos/o/r/pulls/:n', req => {
    const n = Number(req.params?.n);
    return { body: { number: n, state: merged.has(n) ? 'closed' : 'open', merged: merged.has(n),
      merge_commit_sha: merged.get(n) ?? null, head: { ref: branch(n), sha: ref(branch(n)) },
      base: { ref: 'main', sha: ref('main') }, html_url: `https://example.invalid/pr/${String(n)}` } };
  });
  github.on('GET /repos/o/r/git/commits/:sha', req => {
    const sha = req.params?.sha ?? '';
    return { body: { sha, tree: { sha: git(remote, 'rev-parse', `${sha}^{tree}`) },
      parents: git(remote, 'show', '-s', '--format=%P', sha).split(' ').filter(Boolean).map(sha => ({ sha })) } };
  });
  github.on('POST /repos/o/r/statuses/:sha', req => {
    const body = req.body as { context: string; state: string };
    statuses.set(`${req.params?.sha}:${body.context}`, body.state); return { status: 201 };
  });
  github.on('PUT /repos/o/r/pulls/:n/merge', req => {
    const n = Number(req.params?.n); const body = req.body as { sha: string; merge_method: string };
    if (body.sha !== ref(branch(n))) return { status: 409 };
    if (body.merge_method !== 'merge' || git(remote, 'merge-base', ref('main'), body.sha) !== ref('main') ||
      statuses.get(`${body.sha}:agentwbs/int`) !== 'success') return { status: 405 };
    const tree = git(remote, 'rev-parse', `${body.sha}^{tree}`);
    const sha = git(remote, 'commit-tree', tree, '-p', ref('main'), '-p', body.sha, '-m', 'PR merge');
    git(remote, 'update-ref', 'refs/heads/main', sha); merged.set(n, sha);
    return { body: { merged: true, sha } };
  });
  const client = createGitHubClient({ repo: { owner: 'o', repo: 'r' }, token: async () => new Secret('FAKE'),
    baseUrl: github.url, beforeWrite: async op => { await beforeWrite(op); } });
  const calls: { argv: readonly string[]; cwd: string; task: string | null }[] = [];
  let action: (argv: readonly string[], cwd: string) => Promise<number> = async () => 0;
  let qa = { passed: true, headSha: head, specRevision: 1 };
  const observations: { baseSha: string; pipelineSha: string; source: string }[] = [];
  const deps = { repo, github: client, directory: join(root, 'journal'), heavy: new HeavySemaphore(1),
    observeMainPipeline: async (basis: { baseSha: string; pipelineSha: string; source: string }) => { observations.push(basis); },
    execute: async (argv: readonly string[], cwd: string) => {
      calls.push({ argv, cwd, task: await readFile(join(cwd, 'task'), 'utf8').catch(() => null) });
      return { code: await action(argv, cwd), stdout: '통과', stderr: '' };
    },
    collectTests: async () => ['test/value::value'], readVerification: async () => qa,
  };
  const request = { pr: 1, branch: taskBranch, qaHeadSha: head, specRevision: 1 };
  return { root, repo, source, remote, client, github, deps, request, head, base, merged, statuses, calls, observations, ref,
    action: (next: typeof action) => { action = next; }, qa: (next: typeof qa) => { qa = next; },
    beforeWrite: (next: typeof beforeWrite) => { beforeWrite = next; },
    advance: async (name = 'later', value = 'later') => {
      await file(join(source, name), value); const sha = commit(source); git(source, 'push', remote, 'main'); return sha;
    },
    close: async () => { await github.close(); await rm(root, { recursive: true, force: true }); },
  };
}
