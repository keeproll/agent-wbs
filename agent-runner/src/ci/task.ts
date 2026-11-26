import { randomUUID } from 'node:crypto';
import type { GitRepository, RejectedPath, TaskReviewChange } from '../git/repository.ts';
import type { CommandResult } from '../readiness/command.ts';
import type { HeavySemaphore } from '../resources/heavy.ts';
import { createRedactor, type Redact } from '../security/redact.ts';
import { parsePipeline } from './pipeline.ts';

export interface TaskCheckStep {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  durationMs: number;
  attempts: CommandResult[];
}
export interface TaskCheckResult {
  stage: 'task';
  status: 'pass' | 'fail';
  baseSha: string;
  headSha: string;
  pipelineSha: string;
  steps: TaskCheckStep[];
  failStep: string | null;
  rejectedPaths: RejectedPath[];
  flakyCandidates: string[];
  testReview: {
    required: boolean; baseSha: string; headSha: string; changes: TaskReviewChange[];
    collection: { baselineSha: string; before: string[]; after: string[]; removed: string[]; added: string[] };
  };
}
export interface TaskCheckOptions {
  repo: GitRepository;
  worktreeId: string;
  branch: string;
  heavy: HeavySemaphore;
  /** Q-08 확정 전에는 fake만 전달한다. 프로세스 등록·중단·자손 종료 확인 뒤 반환해야 한다. */
  execute: (argv: readonly string[], cwd: string, signal?: AbortSignal) => Promise<CommandResult>;
  /** main의 테스트 명령에 해당하는 실제 수집 결과다. cwd 상대 경로와 테스트 이름으로 안정적인 식별자를 만든다. */
  collectTests: (argv: readonly string[], cwd: string, signal?: AbortSignal) => Promise<readonly string[]>;
  /** ②가 고정한 main A의 정의다. 생략하면 ①이 직접 main을 고정한다. */
  basis?: Awaited<ReturnType<GitRepository['mainPipeline']>>;
  redact?: Redact;
  signal?: AbortSignal;
}

interface Snapshot { id: string; path: string; sha: string }
const message = (error: unknown) => error instanceof Error ? error.message : '검사를 실행하지 못했습니다.';

/** M7-06이 부를 ① 경로다. pass는 기계 검사 결과이며 QA의 명시적 확인을 대신하지 않는다. */
export async function runTaskCheck({ repo, worktreeId, branch, heavy, execute, collectTests, basis, redact = createRedactor(), signal }: TaskCheckOptions): Promise<TaskCheckResult> {
  const { baseSha, pipelineSha, source } = basis ?? await repo.mainPipeline();
  const pipeline = parsePipeline(source);
  const headSha = await repo.importWorktree(worktreeId, branch);
  const baselineSha = await repo.taskBase(baseSha, headSha);
  const changes = await repo.taskReviewChanges(baseSha, headSha);
  const stages = ['worktree', 'protected-paths', 'baseline-install', 'test-collection-before', 'install', 'test-collection-after',
    ...pipeline.stages.task.slice(1).map((command) => command.name)];
  const result: TaskCheckResult = {
    stage: 'task', status: 'fail', baseSha, headSha, pipelineSha,
    steps: stages.map((name) => ({ name, status: 'skip', durationMs: 0, attempts: [] })),
    failStep: null, rejectedPaths: [], flakyCandidates: [],
    testReview: { required: changes.length > 0, baseSha, headSha, changes,
      collection: { baselineSha, before: [], after: [], removed: [], added: [] } },
  };
  const step = (name: string): TaskCheckStep => {
    const found = result.steps.find((value) => value.name === name);
    if (!found) throw new Error('필수 검사 단계가 없습니다.');
    return found;
  };
  const fail = (name: string, error: unknown) => {
    const failed = step(name);
    failed.status = 'fail';
    failed.attempts.push(redact({ code: null, stdout: '', stderr: message(error) }));
    result.failStep = name;
    return redact(result);
  };
  try { await repo.taskCheckPath(worktreeId, headSha); step('worktree').status = 'pass'; }
  catch (error) { return fail('worktree', error); }
  const guardStarted = performance.now();
  result.rejectedPaths = await repo.checkTask(baseSha, headSha);
  step('protected-paths').durationMs = Math.max(0, Math.round(performance.now() - guardStarted));
  step('protected-paths').status = result.rejectedPaths.length ? 'fail' : 'pass';
  if (result.rejectedPaths.length) { result.failStep = 'protected-paths'; return redact(result); }

  const release = await heavy.acquire(`ci-task:${worktreeId}`, signal);
  const checkouts: string[] = [];
  const checkout = async (commit: string): Promise<Snapshot> => {
    const id = `ci-${randomUUID()}`;
    const path = await repo.createTaskCheckWorktree(id, commit);
    checkouts.push(id);
    return { id, path, sha: commit };
  };
  const command = async (name: string, argv: readonly string[], snapshot: Snapshot): Promise<boolean> => {
    const current = step(name);
    const started = performance.now();
    const tries = ['unit', 'contract'].includes(name) ? 2 : 1;
    for (let attempt = 0; attempt < tries; attempt++) {
      let output: CommandResult = { code: null, stdout: '', stderr: '' };
      try {
        signal?.throwIfAborted();
        await repo.taskCheckPath(snapshot.id, snapshot.sha);
        output = await execute(argv, snapshot.path, signal);
        signal?.throwIfAborted();
        await repo.taskCheckPath(snapshot.id, snapshot.sha);
      } catch (error) {
        output = { ...output, code: null, stderr: [output.stderr, message(error)].filter(Boolean).join('\n') };
      }
      current.attempts.push(redact(output));
      current.status = output.code === 0 ? 'pass' : 'fail';
      if (output.code === 0) {
        if (attempt > 0) result.flakyCandidates.push(name);
        break;
      }
      if (output.code === null) break;
    }
    current.durationMs = Math.max(0, Math.round(performance.now() - started));
    if (current.status === 'fail') result.failStep = name;
    return current.status === 'pass';
  };
  const collect = async (phase: 'before' | 'after', snapshot: Snapshot): Promise<boolean> => {
    const current = step(`test-collection-${phase}`);
    const started = performance.now();
    const identifiers: string[] = [];
    try {
      for (const test of pipeline.stages.task.filter((value) => ['unit', 'contract'].includes(value.name))) {
        signal?.throwIfAborted();
        await repo.taskCheckPath(snapshot.id, snapshot.sha);
        const collected = await collectTests(test.argv, snapshot.path, signal);
        signal?.throwIfAborted();
        await repo.taskCheckPath(snapshot.id, snapshot.sha);
        if (!Array.isArray(collected) || collected.some((value: unknown) => typeof value !== 'string' || value.trim() === '') ||
          new Set(collected).size !== collected.length) throw new Error('테스트 수집 식별자가 올바르지 않습니다.');
        identifiers.push(...collected.map((value) => `${test.name}:${value}`));
      }
      result.testReview.collection[phase] = identifiers;
      current.status = 'pass';
      current.attempts.push({ code: 0, stdout: JSON.stringify(identifiers), stderr: '' });
      return true;
    } catch (error) { fail(current.name, error); return false; }
    finally { current.durationMs = Math.max(0, Math.round(performance.now() - started)); }
  };
  let preparing = 'baseline-install';
  try {
    const install = pipeline.stages.task[0];
    if (!install) throw new Error('설치 단계가 없습니다.');
    const baseline = await checkout(baselineSha);
    if (!await command('baseline-install', install.argv, baseline) || !await collect('before', baseline)) return redact(result);
    preparing = 'install';
    const target = await checkout(headSha);
    if (!await command('install', install.argv, target) || !await collect('after', target)) return redact(result);
    const collection = result.testReview.collection;
    const before = new Set(collection.before);
    const after = new Set(collection.after);
    collection.removed = collection.before.filter((value) => !after.has(value));
    collection.added = collection.after.filter((value) => !before.has(value));
    result.testReview.required ||= collection.removed.length > 0;
    for (const next of pipeline.stages.task.slice(1)) {
      if (!await command(next.name, next.argv, target)) return redact(result);
    }
    result.status = 'pass';
    return redact(result);
  } catch (error) { return fail(preparing, error); }
  finally {
    try { for (const id of checkouts) await repo.removeWorktree(id); }
    finally { release(); }
  }
}
