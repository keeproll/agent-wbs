import type { ApiClient } from '../api/client.ts';
import type { Runner } from '../api/runner.ts';
import type { Launch } from '../cli/isolation.ts';
import { runTaskCheck, type TaskCheckOptions, type TaskCheckResult } from '../ci/task.ts';
import { GitHubError, type GitHubClient } from '../github/client.ts';
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
   * PR을 여는 GitHub 계층(M4 `createGitHubClient`). Runner가 개발 결과를 push한 뒤 같은 head 브랜치의 열린 PR을 쓰거나 새로 연다(조정자 결정 1).
   * null이면 GitHub가 연결되지 않은 것이다. PR 없이 보고하고, 서버는 'PR 정보가 필요합니다'로 통합을 보류한다.
   */
  github: Pick<GitHubClient, 'ensurePullRequest' | 'permissions'> | null;
}

/** ① 결과와 이번 시도가 쓴 PR(번호·head 브랜치). 시도 결과 보고에도 그대로 넣는다. */
export type BoundTaskCheckResult = TaskCheckResult & { pullRequest?: { number: number; head: string } };

/** GitHub 쓰기 권한이 없어 PR을 열 수 없다. 시도는 실패가 아니라 보류(중단)로 끝난다. */
export class ExternalWriteBlockedError extends Error {
  override name = 'ExternalWriteBlockedError';
}

/**
 * 개발 결과를 agent 브랜치에 push하고 그 브랜치의 PR을 연다. 멱등이다.
 * - `ensurePullRequest`는 브랜치로 열린 PR을 먼저 찾고, 없을 때만 만든다. 생성 경합(422)도 다시 찾는다.
 * - 생성 응답을 잃으면(통신 실패) 한 번 더 부른다. 다시 찾기부터 하므로 PR이 둘 생기지 않는다.
 * - 권한이 없다고 이미 알려졌거나(3상태의 missing) 쓰기가 403이면 외부 쓰기 막힘으로 보류한다.
 */
export async function openPullRequest(d: Pick<TaskCheckDeps, 'github' | 'repo'>, job: AttemptContext['job'], head: string): Promise<{ number: number; head: string } | undefined> {
  const github = d.github;
  if (!github) return undefined;
  const blocked = () => new ExternalWriteBlockedError('GitHub 쓰기 권한(contents·pulls)이 없어 PR을 열 수 없습니다. 외부 쓰기 막힘으로 보류합니다.');
  const permissions = github.permissions();
  if (permissions.contents === 'missing' || permissions.pulls === 'missing') throw blocked();
  await d.repo.pushCommit(head, job.payload.branch);
  const input = { branch: job.payload.branch, title: `${job.payload.taskKey} ${job.payload.kind}`, body: `Agent WBS가 ${job.payload.taskKey}의 개발 결과로 연 PR입니다.` };
  const ensure = async () => {
    try { return await github.ensurePullRequest(input); }
    catch (error) {
      if (error instanceof GitHubError && error.status === 403) throw blocked();
      throw error;
    }
  };
  let pull;
  try { pull = await ensure(); }
  catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 0) throw error;
    pull = await ensure();
  }
  if (pull.branch !== job.payload.branch) throw new Error('PR의 head 브랜치가 이 시도의 브랜치와 다릅니다.');
  return { number: pull.number, head: pull.branch };
}

/** M7-06의 실제 ①을 M5-02의 명령 실행·보유와 M5-05의 결과 흐름에 연결한다. */
export function bindTaskCheck(d: TaskCheckDeps) {
  return async (context: AttemptContext): Promise<BoundTaskCheckResult> => {
    const { job, output, epoch, signal } = context;
    const work = d.worktree(context);
    // 조정자 결정 1: dev → push → PR 열기 → ①. ①은 PR에 올린 그 커밋을 검사한다.
    const head = await d.repo.importWorktree(work.id, work.branch);
    const pullRequest = await openPullRequest(d, job, head);
    signal.throwIfAborted();
    const basis = await d.repo.mainPipeline();
    await d.observeMainPipeline(basis);
    const result = await runTaskCheck({ repo: d.repo, worktreeId: work.id, branch: work.branch,
      heavy: d.execution.heavy, collectTests: d.collectTests, basis, signal,
      execute: (argv, cwd, signal) => d.execution.command({ id: job.id, fence: job.fence, epoch }, job.payload.agent,
        d.launch(argv, cwd), signal, { heavyHeld: true }),
    });
    signal.throwIfAborted();
    if (result.headSha !== head) throw new Error('PR에 올린 커밋과 ①이 검사한 커밋이 다릅니다.');
    const run = await reportEvent(d, 'startCiRun', { epoch, body: { jobId: job.id, fence: job.fence, stage: 'task',
      taskKey: job.payload.taskKey, attemptId: output.attemptId, ref: job.payload.branch, trigger: 'attempt-flow',
      ...(pullRequest && { pr: pullRequest.number, prHead: pullRequest.head }),
      baseSha: result.baseSha, headSha: result.headSha, pipelineSha: result.pipelineSha } }, signal);
    await reportEvent(d, 'updateCiRun', { epoch, params: { id: run.body.id }, body: { fence: job.fence, status: 'run' } }, signal);
    await reportEvent(d, 'updateCiRun', { epoch, params: { id: run.body.id }, body: { fence: job.fence, status: result.status,
      steps: result.steps.map(({ name, status, durationMs }) => ({ name, status, durationMs })),
      ...(result.failScope && { failScope: result.failScope }) } }, signal);
    // GitHub가 연결되지 않았으면 예전처럼 통과한 커밋만 올린다.
    if (!pullRequest && result.status === 'pass') await d.repo.pushCommit(result.headSha, job.payload.branch);
    return { ...result, ...(pullRequest && { pullRequest }) };
  };
}
