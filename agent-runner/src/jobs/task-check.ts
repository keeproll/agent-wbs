import type { ApiClient } from '../api/client.ts';
import type { Runner } from '../api/runner.ts';
import type { Launch } from '../cli/isolation.ts';
import { runTaskCheck, type TaskCheckOptions } from '../ci/task.ts';
import type { Execution } from '../exec/session.ts';
import { reportEvent, type AttemptContext } from './attempt-flow.ts';

interface TaskCheckDeps {
  api: ApiClient;
  runner: Runner;
  execution: Execution;
  repo: TaskCheckOptions['repo'];
  worktree: (context: AttemptContext) => { id: string; branch: string };
  launch: (argv: readonly string[], cwd: string) => Launch;
  collectTests: TaskCheckOptions['collectTests'];
  observeMainPipeline: (basis: NonNullable<TaskCheckOptions['basis']>) => Promise<void>;
  /**
   * 이 Task 브랜치의 PR 번호 공급원. 서버는 ① 실행의 PR 번호로 통합(②·병합) job을 만든다.
   * 지금 제품에는 PR을 여는 구현이 없어 연결하지 않으면 PR 없이 보고하고, 서버는 'PR 정보가 필요합니다'로 통합을 보류한다(M5·M7 통합에서 확인한 빈 곳).
   */
  pr?: (context: AttemptContext) => Promise<number | undefined> | number | undefined;
}

/** M7-06의 실제 ①을 M5-02의 명령 실행·보유와 M5-05의 결과 흐름에 연결한다. */
export function bindTaskCheck(d: TaskCheckDeps) {
  return async (context: AttemptContext) => {
    const { job, output, epoch, signal } = context;
    const work = d.worktree(context);
    const basis = await d.repo.mainPipeline();
    await d.observeMainPipeline(basis);
    const result = await runTaskCheck({ repo: d.repo, worktreeId: work.id, branch: work.branch,
      heavy: d.execution.heavy, collectTests: d.collectTests, basis, signal,
      execute: (argv, cwd, signal) => d.execution.command({ id: job.id, fence: job.fence, epoch }, job.payload.agent,
        d.launch(argv, cwd), signal, { heavyHeld: true }),
    });
    signal.throwIfAborted();
    const pr = await d.pr?.(context);
    const run = await reportEvent(d, 'startCiRun', { epoch, body: { jobId: job.id, fence: job.fence, stage: 'task',
      taskKey: job.payload.taskKey, attemptId: output.attemptId, ref: job.payload.branch, trigger: 'attempt-flow', ...(pr !== undefined && { pr }),
      baseSha: result.baseSha, headSha: result.headSha, pipelineSha: result.pipelineSha } }, signal);
    await reportEvent(d, 'updateCiRun', { epoch, params: { id: run.body.id }, body: { fence: job.fence, status: 'run' } }, signal);
    await reportEvent(d, 'updateCiRun', { epoch, params: { id: run.body.id }, body: { fence: job.fence, status: result.status,
      steps: result.steps.map(({ name, status, durationMs }) => ({ name, status, durationMs })),
      ...(result.failScope && { failScope: result.failScope }) } }, signal);
    if (result.status === 'pass') await d.repo.pushCommit(result.headSha, job.payload.branch);
    return result;
  };
}
