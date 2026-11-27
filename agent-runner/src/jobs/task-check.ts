import type { ApiClient } from '../api/client.ts';
import type { Runner } from '../api/runner.ts';
import type { Launch } from '../cli/isolation.ts';
import { runTaskCheck, type TaskCheckOptions, type TaskCheckResult } from '../ci/task.ts';
import { randomUUID } from 'node:crypto';
import { GitHubError, type GitHubClient } from '../github/client.ts';
import { LEASE_SAFETY_MS } from '../exec/session.ts';
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
  github: Pick<GitHubClient, 'ensurePullRequest' | 'permissions' | 'assertWritable'> | null;
}

/** ① 결과와 이번 시도가 쓴 PR(번호·head 브랜치). 시도 결과 보고에도 그대로 넣는다. */
export type BoundTaskCheckResult = TaskCheckResult & { pullRequest?: { number: number; head: string } };

/** GitHub 쓰기 권한이 없어 PR을 열 수 없다. 시도는 실패가 아니라 보류(중단)로 끝난다. */
export class ExternalWriteBlockedError extends Error {
  override name = 'ExternalWriteBlockedError';
}

/** 외부 쓰기 직전에 이 job을 아직 맡고 있는지 확인한다. 아니면 던진다(쓰지 않는다). */
export type WriteGuard = () => Promise<void>;

/**
 * 서버 기준 소유 확인. 임대 연장(renewJob)은 서버가 fence·임대·Runner를 대조해 맞을 때만 성공한다(아니면 409 LEASE_LOST).
 * 연장된 임대가 시계 역행 여유(LEASE_SAFETY_MS)보다 짧게 남았어도 쓰지 않는다.
 * 왜: 로컬 중단 신호만으로는 서버가 이미 다른 Runner에 넘긴 job을 알 수 없다. 낡은 실행이 원격을 바꾸면 되돌릴 수 없다.
 */
export function serverWriteGuard(api: ApiClient, job: { id: string; fence: number }, epoch: number, signal: AbortSignal): WriteGuard {
  return async () => {
    signal.throwIfAborted();
    const renewed = await api('renewJob', { epoch, idempotencyKey: randomUUID(), params: { id: job.id }, body: { fence: job.fence } });
    signal.throwIfAborted();
    if (!(Date.parse(renewed.body.leaseUntil) - LEASE_SAFETY_MS > Date.now())) throw new Error('임대가 곧 끝나 외부 쓰기를 시작하지 않습니다.');
  };
}

/** push는 끝났지만 그 뒤 확인에서 멈췄다. 원격 브랜치가 바뀐 사실을 그대로 알린다. */
export class PushedThenStoppedError extends Error {
  override name = 'PushedThenStoppedError';
  readonly branch: string;
  readonly commit: string;
  constructor(branch: string, commit: string, reason: unknown) {
    super(`원격 브랜치 ${branch}에 ${commit.slice(0, 7)}를 이미 push했고, 그 뒤 소유 확인에서 멈춰 PR은 열지 않았습니다: ${reason instanceof Error ? reason.message : String(reason)}`, { cause: reason });
    this.branch = branch;
    this.commit = commit;
  }
}

/**
 * 개발 결과를 agent 브랜치에 push하고 그 브랜치의 PR을 연다. 멱등이다(조정자 결정 1).
 * 외부 쓰기(push·PR 생성·재시도) 직전마다 다음을 거친다.
 * 1. 중단 신호와 서버 기준 소유(`guard`: fence·임대·중단)를 확인한다. 아니면 쓰지 않는다.
 * 2. push 전에는 M4 쓰기 관문(`assertWritable`: 앱에서는 원격 저장소·배포 키 확인)과 권한 3상태를 확인한다.
 *    PR 생성은 M4 계층 안에서 같은 관문을 다시 거친다. 열린 PR을 재사용할 때도 이 push 전 관문은 이미 지났다.
 * - `ensurePullRequest`는 브랜치로 열린 PR을 먼저 찾고, 없을 때만 만든다. 생성 경합(422)도 다시 찾는다.
 * - 생성 응답을 잃으면(통신 실패) 소유를 다시 확인한 뒤 한 번 더 부른다. 다시 찾기부터 하므로 PR이 둘 생기지 않는다.
 * - 재시도할 수 없는 403(실제 권한 부족)만 외부 쓰기 막힘으로 바꾼다. 호출 횟수 제한 403은 M4 오류(재시도 가능·대기 시간)를 그대로 둔다.
 * - push 뒤 확인에서 멈추면 `PushedThenStoppedError`로 「이미 push했다」는 사실을 알린다.
 */
export async function openPullRequest(d: Pick<TaskCheckDeps, 'github' | 'repo'>, job: AttemptContext['job'], head: string,
  guard: WriteGuard = () => Promise.resolve()): Promise<{ number: number; head: string } | undefined> {
  const github = d.github;
  if (!github) return undefined;
  const branch = job.payload.branch;
  const blocked = () => new ExternalWriteBlockedError('GitHub 쓰기 권한(contents·pulls)이 없어 PR을 열 수 없습니다. 외부 쓰기 막힘으로 보류합니다.');
  const permissions = github.permissions();
  if (permissions.contents === 'missing' || permissions.pulls === 'missing') throw blocked();
  await guard();
  await github.assertWritable({ kind: 'branch_push', branch, remote: await d.repo.source() });
  await guard();
  await d.repo.pushCommit(head, branch);
  const input = { branch, title: `${job.payload.taskKey} ${job.payload.kind}`, body: `Agent WBS가 ${job.payload.taskKey}의 개발 결과로 연 PR입니다.` };
  const ensure = async () => {
    try { await guard(); }
    catch (error) { throw new PushedThenStoppedError(branch, head, error); }
    try { return await github.ensurePullRequest(input); }
    catch (error) {
      if (error instanceof GitHubError && error.status === 403 && !error.retryable) throw blocked();
      throw error;
    }
  };
  let pull;
  try { pull = await ensure(); }
  catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 0) throw error;
    pull = await ensure();
  }
  if (pull.branch !== branch) throw new Error('PR의 head 브랜치가 이 시도의 브랜치와 다릅니다.');
  return { number: pull.number, head: pull.branch };
}

/** M7-06의 실제 ①을 M5-02의 명령 실행·보유와 M5-05의 결과 흐름에 연결한다. */
export function bindTaskCheck(d: TaskCheckDeps) {
  return async (context: AttemptContext): Promise<BoundTaskCheckResult> => {
    const { job, output, epoch, signal } = context;
    const work = d.worktree(context);
    // 조정자 결정 1: dev → push → PR 열기 → ①. ①은 PR에 올린 그 커밋을 검사한다.
    const head = await d.repo.importWorktree(work.id, work.branch);
    const guard = serverWriteGuard(d.api, job, epoch, signal);
    const pullRequest = await openPullRequest(d, job, head, guard);
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
    if (!pullRequest && result.status === 'pass') { await guard(); await d.repo.pushCommit(result.headSha, job.payload.branch); }
    return { ...result, ...(pullRequest && { pullRequest }) };
  };
}
