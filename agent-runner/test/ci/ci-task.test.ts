import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GitRepository } from '../../src/git/repository.ts';
import { HeavySemaphore } from '../../src/resources/heavy.ts';
import type { CommandResult } from '../../src/readiness/command.ts';
import { parsePipeline } from '../../src/ci/pipeline.ts';
import { runTaskCheck } from '../../src/ci/task.ts';

const names = ['install', 'typecheck', 'lint', 'unit', 'build', 'contract'];
const definition = {
  version: 1,
  stages: {
    task: names.map((name) => ({ name, argv: name === 'install' ? ['pnpm', 'install', '--frozen-lockfile'] : ['pnpm', name] })),
    int: [{ name: 'build', argv: ['pnpm', 'build'] }],
    night: [{ name: 'e2e', argv: ['pnpm', 'e2e'] }],
    deploy: [{ name: 'health', argv: ['node', 'health.js'] }],
  },
};
let root: string;
let source: string;
let remote: string;
let repo: GitRepository;
let work: string;
let baseline: string;
const heavy = new HeavySemaphore(1);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=시험', '-c', 'user.email=test@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' },
  }).trim();
}
async function file(path: string, content: string) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}
function commit(cwd: string) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', '시험 변경');
  return git(cwd, 'rev-parse', 'HEAD');
}
const execute = vi.fn<(argv: readonly string[], cwd: string, signal?: AbortSignal) => Promise<CommandResult>>();
const run = () => runTaskCheck({ repo, worktreeId: 'task-1', branch: 'agent/TASK-1-h1', heavy, execute });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ci-task-'));
  source = join(root, 'source');
  remote = join(root, 'remote.git');
  await mkdir(source);
  git(source, 'init', '-b', 'main');
  await file(join(source, '.agentwbs/pipeline.yaml'), JSON.stringify(definition));
  await file(join(source, '.gitignore'), 'dist/\n');
  await file(join(source, 'prototype/guide.md'), '원본');
  await file(join(source, 'src/main.ts'), 'export const value = 1;');
  await file(join(source, 'test/value.test.ts'), 'test("value", () => { expect(value).toBe(1); });');
  baseline = commit(source);
  git(source, 'init', '--bare', '-b', 'main', remote);
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', 'origin', 'main');
  repo = await GitRepository.clone(join(root, 'runner'), 'project', remote);
  work = await repo.createWorktree('task-1', 'agent/TASK-1-h1', baseline);
  execute.mockReset().mockResolvedValue({ code: 0, stdout: '통과', stderr: '' });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('YAML 블록·인자 배열을 해석하고 task의 필수 검사 순서를 고정한다', () => {
  const yaml = `version: 1\nstages:\n  task:\n${names.map((name) => `    - name: ${name}\n      argv: [pnpm, ${name}]`).join('\n')}\n  int: [{name: build, argv: [pnpm, build]}]\n  night: [{name: e2e, argv: [pnpm, e2e]}]\n  deploy: [{name: health, argv: [node, health.js]}]\n`;
  expect(parsePipeline(yaml).stages.task.map((step) => step.name)).toEqual(names);
});

test.each([
  { ...definition, version: 2 },
  { ...definition, shell: 'true' },
  { ...definition, stages: { ...definition.stages, task: [] } },
  { ...definition, stages: { ...definition.stages, task: [...definition.stages.task].reverse() } },
  { ...definition, stages: { ...definition.stages, task: definition.stages.task.map((s) => ({ ...s, argv: 'pnpm test' })) } },
  { ...definition, stages: { ...definition.stages, night: [{ name: 'e2e', argv: [] }] } },
  { ...definition, stages: { ...definition.stages, deploy: [{ name: 'health', argv: ['node', 'bad\0arg'] }] } },
])('잘못된 스키마는 실행 전에 거부한다 %#', (value) => {
  expect(() => parsePipeline(JSON.stringify(value))).toThrow();
});

test.each([
  `version: 1\nversion: 1\nstages: ${JSON.stringify(definition.stages)}`,
  `version: 1\nstages:\n  task:\n${names.map((name, i) => `    - name: ${name}\n      argv: ${i === 0 ? '&cmd [pnpm, test]' : '*cmd'}`).join('\n')}\n  int: [{name: build, argv: [pnpm, build]}]\n  night: [{name: e2e, argv: [pnpm, e2e]}]\n  deploy: [{name: health, argv: [node, health.js]}]\n`,
  `version: !unknown 1\nstages: ${JSON.stringify(definition.stages)}`,
  `${JSON.stringify(definition)}\n---\n${JSON.stringify(definition)}`,
])('중복 키·별칭·알 수 없는 태그·여러 문서는 거부한다', (yaml) => {
  expect(() => parsePipeline(yaml)).toThrow();
});

test('main 정의의 blob SHA와 같은 head에서 6개 명령을 순서대로 실행한다', async () => {
  await file(join(work, 'src/new.ts'), 'export const value = 2;');
  const head = commit(work);
  const result = await run();
  expect(result).toMatchObject({ status: 'pass', baseSha: baseline, headSha: head,
    pipelineSha: git(source, 'rev-parse', 'main:.agentwbs/pipeline.yaml'),
    testReview: { required: false, changes: [] }, failStep: null });
  expect(execute.mock.calls.map(([argv, cwd]) => [argv, cwd])).toEqual(definition.stages.task.map((step) => [step.argv, work]));
  expect(result.steps.map((s) => [s.name, s.status])).toEqual([['protected-paths', 'pass'], ...names.map((name) => [name, 'pass'])]);
  expect(heavy.snapshot().running).toBe(0);
});

test.each(['prototype/guide.md', '.agentwbs/pipeline.yaml', 'dist/compiled.js'])('보호 경로·결과물 %s는 명령 실행 전에 실패한다', async (path) => {
  await file(join(work, path), path.endsWith('yaml') ? JSON.stringify({ ...definition, stages: { ...definition.stages, task: [] } }) : '변조');
  git(work, 'add', '-f', path);
  git(work, 'commit', '-m', '변조');
  const result = await run();
  expect(result).toMatchObject({ status: 'fail', failStep: 'protected-paths' });
  expect(result.rejectedPaths.map((p) => p.path)).toContain(path);
  expect(execute).not.toHaveBeenCalled();
});

test('main이 앞서 가도 merge-base로 보호 경로 이름 변경을 잡는다', async () => {
  git(work, 'mv', 'prototype/guide.md', 'src/moved.md');
  commit(work);
  await file(join(source, 'src/other.ts'), 'main의 다른 변경');
  commit(source);
  git(source, 'push', 'origin', 'main');
  await repo.fetch();
  expect((await run()).rejectedPaths).toContainEqual({ path: 'prototype/guide.md', reason: 'protected' });
  expect(execute).not.toHaveBeenCalled();
});

test('로컬 main이 아니라 마지막 fetch의 main 정의를 고정한다', async () => {
  const latest = structuredClone(definition);
  latest.stages.task[1] = { name: 'typecheck', argv: ['pnpm', 'strict-typecheck', 'a; touch forbidden'] };
  await file(join(source, '.agentwbs/pipeline.yaml'), JSON.stringify(latest));
  const newMain = commit(source);
  git(source, 'push', 'origin', 'main');
  await repo.fetch();
  expect(await repo.head()).toBe(baseline);
  const result = await run();
  expect(result.baseSha).toBe(newMain);
  expect(result.pipelineSha).toBe(git(source, 'rev-parse', 'main:.agentwbs/pipeline.yaml'));
  expect(execute.mock.calls[1]?.[0]).toEqual(latest.stages.task[1]?.argv);
});

test.each(['delete', 'skip', 'assertion', 'rename'])('기존 테스트 %s는 자동 실패 대신 SHA에 묶인 QA 확인 목록에 남는다', async (kind) => {
  const path = 'test/value.test.ts';
  if (kind === 'delete') await rm(join(work, path));
  else if (kind === 'rename') git(work, 'mv', path, 'src/hidden.ts');
  else await file(join(work, path), kind === 'skip' ? 'test.skip("value", () => { expect(value).toBe(1); });' : 'test("value", () => {});');
  const head = commit(work);
  const result = await run();
  expect(result.status).toBe('pass');
  expect(result.testReview).toMatchObject({ required: true, headSha: head, baseSha: baseline,
    changes: [expect.objectContaining({ path, status: ['delete', 'rename'].includes(kind) ? 'D' : 'M', oldBlob: expect.any(String) })] });
  expect(result.testReview.changes[0]?.patch).toContain('expect(value).toBe(1)');
});

test('단위 테스트는 1회만 재시도하고 재시도 통과는 불안정 후보로 남긴다', async () => {
  let calls = 0;
  execute.mockImplementation(async (argv) => ({ code: argv[1] === 'unit' && calls++ === 0 ? 1 : 0, stdout: '', stderr: '' }));
  const result = await run();
  expect(result.status).toBe('pass');
  expect(result.flakyCandidates).toEqual(['unit']);
  expect(result.steps.find((s) => s.name === 'unit')?.attempts.map((a) => a.code)).toEqual([1, 0]);
  execute.mockReset().mockResolvedValue({ code: 0, stdout: '통과', stderr: '' });
});

test('계속 실패한 테스트에서 중단하고 로그와 실행 코드를 남긴다', async () => {
  execute.mockImplementation(async (argv) => ({ code: argv[1] === 'unit' ? 1 : 0, stdout: 'Bearer abcdefghijklmnop', stderr: '실제 테스트 실패' }));
  const result = await run();
  expect(result).toMatchObject({ status: 'fail', failStep: 'unit', flakyCandidates: [] });
  expect(execute.mock.calls.map(([argv]) => argv[1])).toEqual(['install', 'typecheck', 'lint', 'unit', 'unit']);
  expect(result.steps.find((s) => s.name === 'build')?.status).toBe('skip');
  expect(JSON.stringify(result)).not.toContain('abcdefghijklmnop');
  expect(JSON.stringify(result)).toContain('실제 테스트 실패');
  expect(heavy.snapshot().running).toBe(0);
  execute.mockReset().mockResolvedValue({ code: 0, stdout: '통과', stderr: '' });
});

test('실행 어댑터 오류도 실패 기록으로 바꾸고 번호표를 돌려준다', async () => {
  execute.mockRejectedValueOnce(new Error('TOKEN=super-secret-value'));
  const result = await run();
  expect(result).toMatchObject({ status: 'fail', failStep: 'install' });
  expect(result.steps[1]?.attempts[0]).toMatchObject({ code: null });
  expect(JSON.stringify(result)).not.toContain('super-secret-value');
  expect(heavy.snapshot().running).toBe(0);
});

test('계약 테스트도 1회 재시도하고 타입 오류는 재시도하지 않는다', async () => {
  execute.mockImplementation(async (argv) => ({ code: argv[1] === 'contract' ? 1 : 0, stdout: '', stderr: '계약 불일치' }));
  expect(await run()).toMatchObject({ status: 'fail', failStep: 'contract' });
  expect(execute.mock.calls.filter(([argv]) => argv[1] === 'contract')).toHaveLength(2);
  execute.mockClear().mockImplementation(async (argv) => ({ code: argv[1] === 'typecheck' ? 1 : 0, stdout: '', stderr: '타입 오류' }));
  expect(await run()).toMatchObject({ status: 'fail', failStep: 'typecheck' });
  expect(execute.mock.calls.map(([argv]) => argv[1])).toEqual(['install', 'typecheck']);
});

test('검사 중 main 정의가 바뀌어도 시작 때 고정한 명령과 SHA를 유지한다', async () => {
  const oldPipeline = git(source, 'rev-parse', 'main:.agentwbs/pipeline.yaml');
  execute.mockImplementationOnce(async () => {
    const next = structuredClone(definition);
    next.stages.task[1] = { name: 'typecheck', argv: ['node', 'bypass.js'] };
    await file(join(source, '.agentwbs/pipeline.yaml'), JSON.stringify(next));
    commit(source);
    git(source, 'push', 'origin', 'main');
    await repo.fetch();
    return { code: 0, stdout: '', stderr: '' };
  });
  expect(await run()).toMatchObject({ status: 'pass', baseSha: baseline, pipelineSha: oldPipeline });
  expect(execute.mock.calls[1]?.[0]).toEqual(['pnpm', 'typecheck']);
});

test('이름 규칙이 없는 테스트 파일과 바이너리 삭제도 QA 근거에서 빠뜨리지 않는다', async () => {
  await file(join(source, 'checks/unusual.fixture'), 'assert value == 1');
  await writeFile(join(source, 'checks/binary.fixture'), Buffer.from([0, 1, 2]));
  commit(source);
  git(source, 'push', 'origin', 'main');
  const start = await repo.fetch();
  await repo.removeWorktree('task-1');
  work = await repo.createWorktree('task-1', 'agent/TASK-1-h1', start);
  await rm(join(work, 'checks/unusual.fixture'));
  await rm(join(work, 'checks/binary.fixture'));
  commit(work);
  const result = await run();
  expect(result.testReview.required).toBe(true);
  expect(result.testReview.changes.map((change) => change.path)).toEqual(['checks/binary.fixture', 'checks/unusual.fixture']);
  expect(result.testReview.changes[0]?.patch).toContain('GIT binary patch');
});

test('삭제한 테스트를 가진 검사 결과는 원본 assertion의 diff를 보존하고 QA 확인을 요구한다', async () => {
  await file(join(work, 'src/main.ts'), 'export const value = 2;');
  await rm(join(work, 'test/value.test.ts'));
  commit(work);
  const result = await run();
  expect(result.status).toBe('pass');
  expect(result.testReview.required).toBe(true);
  expect(result.testReview.changes.map((change) => change.path)).toEqual(['src/main.ts', 'test/value.test.ts']);
  expect(result.testReview.changes[1]?.patch).toContain('-test("value", () => { expect(value).toBe(1); });');
});

test('실행 전 미커밋 변경과 명령 중 head 변경은 통과시키지 않는다', async () => {
  await file(join(work, 'src/main.ts'), '미커밋 변경');
  await expect(run()).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  git(work, 'checkout', '--', 'src/main.ts');
  execute.mockImplementationOnce(async () => {
    await file(join(work, 'src/main.ts'), '검사 중 변경');
    commit(work);
    return { code: 0, stdout: '', stderr: '' };
  });
  const result = await run();
  expect(result).toMatchObject({ status: 'fail', failStep: 'install' });
  expect(execute).toHaveBeenCalledTimes(1);
});

test('pipeline symlink는 git 객체에서 일반 파일이 아닌 것으로 거부한다', async () => {
  await rm(join(source, '.agentwbs/pipeline.yaml'));
  await symlink('../src/main.ts', join(source, '.agentwbs/pipeline.yaml'));
  commit(source);
  git(source, 'push', 'origin', 'main');
  await repo.fetch();
  await expect(run()).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

test('Agent index의 assume-unchanged로 미커밋 테스트 약화를 숨길 수 없다', async () => {
  git(work, 'update-index', '--assume-unchanged', 'test/value.test.ts');
  await file(join(work, 'test/value.test.ts'), 'test.skip("value", () => {});');
  await expect(run()).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

test('다른 무거운 작업이 번호표를 잡고 있으면 CI 명령은 기다린다', async () => {
  const release = await heavy.acquire('다른 작업');
  const pending = run();
  for (let i = 0; i < 100 && heavy.snapshot().waiting === 0; i++) await new Promise((r) => setTimeout(r, 10));
  expect(heavy.snapshot().waiting).toBe(1);
  expect(execute).not.toHaveBeenCalled();
  release();
  expect((await pending).status).toBe('pass');
});

test('마지막 명령 도중 중단되면 성공 결과를 반환하지 않는다', async () => {
  const abort = new AbortController();
  execute.mockImplementation(async (argv) => {
    if (argv[1] === 'contract') abort.abort(new Error('검사 중단'));
    return { code: 0, stdout: '', stderr: '' };
  });
  const result = await runTaskCheck({ repo, worktreeId: 'task-1', branch: 'agent/TASK-1-h1', heavy, execute, signal: abort.signal });
  expect(result).toMatchObject({ status: 'fail', failStep: 'contract' });
  expect(heavy.snapshot().running).toBe(0);
});
