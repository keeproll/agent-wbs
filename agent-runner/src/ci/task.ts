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
  testReview: { required: boolean; baseSha: string; headSha: string; changes: TaskReviewChange[] };
}
export interface TaskCheckOptions {
  repo: GitRepository;
  worktreeId: string;
  branch: string;
  heavy: HeavySemaphore;
  /** Q-08 격리 방식 확정 전에는 fake만 전달한다. 실행·프로세스 등록·종료 확인은 호출자가 맡는다. */
  execute: (argv: readonly string[], cwd: string, signal?: AbortSignal) => Promise<CommandResult>;
  redact?: Redact;
  signal?: AbortSignal;
}

/** M7-06이 부를 ① 경로다. pass는 기계 검사 결과이며 QA의 명시적 확인을 대신하지 않는다. */
export async function runTaskCheck({ repo, worktreeId, branch, heavy, execute, redact = createRedactor(), signal }: TaskCheckOptions): Promise<TaskCheckResult> {
  const { baseSha, pipelineSha, source } = await repo.mainPipeline();
  const pipeline = parsePipeline(source);
  const headSha = await repo.importWorktree(worktreeId, branch);
  const cwd = await repo.taskCheckPath(worktreeId, headSha);
  const guardStarted = performance.now();
  const rejectedPaths = await repo.checkTask(baseSha, headSha);
  const changes = await repo.taskReviewChanges(baseSha, headSha);
  const guard: TaskCheckStep = { name: 'protected-paths', status: rejectedPaths.length ? 'fail' : 'pass', durationMs: Math.max(0, Math.round(performance.now() - guardStarted)), attempts: [] };
  const result: TaskCheckResult = {
    stage: 'task', status: 'fail', baseSha, headSha, pipelineSha,
    steps: [guard, ...pipeline.stages.task.map((step): TaskCheckStep => ({ name: step.name, status: 'skip', durationMs: 0, attempts: [] }))],
    failStep: rejectedPaths.length ? guard.name : null, rejectedPaths, flakyCandidates: [],
    testReview: { required: changes.length > 0, baseSha, headSha, changes },
  };
  if (rejectedPaths.length) return redact(result);
  const release = await heavy.acquire(`ci-task:${worktreeId}`, signal);
  try {
    for (const [index, command] of pipeline.stages.task.entries()) {
      const step = result.steps[index + 1];
      if (!step) throw new Error('필수 검사 단계가 없습니다.');
      const started = performance.now();
      const tries = ['unit', 'contract'].includes(command.name) ? 2 : 1;
      for (let attempt = 0; attempt < tries; attempt++) {
        let output: CommandResult;
        try {
          signal?.throwIfAborted();
          await repo.taskCheckPath(worktreeId, headSha);
          output = await execute(command.argv, cwd, signal);
          signal?.throwIfAborted();
          await repo.taskCheckPath(worktreeId, headSha);
        } catch (error) {
          output = { code: null, stdout: '', stderr: error instanceof Error ? error.message : '검사 명령을 실행하지 못했습니다.' };
        }
        step.attempts.push(redact(output));
        if (output.code === 0) {
          step.status = 'pass';
          if (attempt > 0) result.flakyCandidates.push(command.name);
          break;
        }
        step.status = 'fail';
        // 도구 오류·중단·작업 파일 변경은 실패한 테스트의 재시도와 다르다.
        if (output.code === null) break;
      }
      step.durationMs = Math.max(0, Math.round(performance.now() - started));
      if (step.status === 'fail') { result.failStep = step.name; return redact(result); }
    }
    result.status = 'pass';
    return redact(result);
  } finally { release(); }
}
