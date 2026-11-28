import type { ApiClient } from '../api/client.ts';
import type { Runner } from '../api/runner.ts';
import type { Launch } from '../cli/isolation.ts';
import { runTaskCheck, type TaskCheckOptions, type TaskCheckResult } from '../ci/task.ts';
import { createTestCollector } from '../ci/collect-tests.ts';
import { GitHubError, type GitHubClient } from '../github/client.ts';
import { pushGate, serverWriteGuard, type OwnershipGuard } from '../github/write-gate.ts';
import type { Execution } from '../exec/session.ts';
import { reportEvent, type AttemptContext } from './attempt-flow.ts';

export interface TaskCheckDeps {
  api: ApiClient;
  runner: Runner;
  execution: Execution;
  /** 앱의 로컬 clone. 함수면 처음 쓸 때 연다(main은 clone이 아직 없을 수 있어 함수로 넘긴다). */
  repo: TaskCheckOptions['repo'] | (() => Promise<TaskCheckOptions['repo']>);
  worktree: (context: AttemptContext) => { id: string; branch: string };
  launch: (argv: readonly string[], cwd: string) => Launch;
  /**
   * 시험 목록 수집기. 생략하면 이 시도의 job으로 묶인 실행기(`Execution.command`)로 `createTestCollector`를 쓴다(조정자 결정 2).
   * 목록 명령도 Agent 코드(시험 설정)를 실행하므로 같은 job·같은 격리(전용 계정이면 래퍼 ci-run)로 돌아야 한다.
   */
  collectTests?: TaskCheckOptions['collectTests'];
  observeMainPipeline: (basis: NonNullable<TaskCheckOptions['basis']>) => Promise<void>;
  /**
   * PR을 여는 GitHub 계층(M4 `createGitHubClient`). Runner가 개발 결과를 push한 뒤 같은 head 브랜치의 열린 PR을 쓰거나 새로 연다(조정자 결정 1).
   * null이면 GitHub가 연결되지 않은 것이다. PR 없이 보고하고, 서버는 'PR 정보가 필요합니다'로 통합을 보류한다.
   */
  github: Pick<GitHubClient, 'ensurePullRequest' | 'findPullRequest' | 'permissions' | 'assertWritable'> | null;
}

/**
 * 앱 밖(main)이 넘기는 ① 공급원. 공유 인스턴스(api·runner·execution)와 GitHub 클라이언트는 넣지 않는다.
 * 앱(`RunnerApp`)이 자기 것으로 채워 `bindTaskCheck`를 부른다.
 * 왜: GitHub 클라이언트는 배포 키 검사·권한 거부 보고·토큰 무효화가 걸린 앱의 것 하나만 써야 한다.
 *   밖에서 다른 클라이언트를 만들어 넘기면 PR 생성이 그 관문을 지나지 않는다(M5-7 통합 보고 「알려진 한계」).
 */
export type TaskCheckSources = Omit<TaskCheckDeps, 'api' | 'runner' | 'execution' | 'github'>;

/** ① 결과와 이번 시도가 쓴 PR(번호·head 브랜치). 시도 결과 보고에도 그대로 넣는다. */
export type BoundTaskCheckResult = TaskCheckResult & { pullRequest?: { number: number; head: string } };

/** GitHub 쓰기 권한이 없어 PR을 열 수 없다. 시도는 실패가 아니라 보류(중단)로 끝난다. */
export class ExternalWriteBlockedError extends Error {
  override name = 'ExternalWriteBlockedError';
}

/** 외부 쓰기 직전 소유 확인(중단·임대). 정의는 모든 외부 쓰기가 함께 쓰는 `github/write-gate.ts`에 있다. */
export type WriteGuard = OwnershipGuard;
export { serverWriteGuard };

/** push 뒤 PR의 상태. 확인한 사실만 말한다. */
export type PullState = { kind: 'not_requested' } | { kind: 'absent' } | { kind: 'opened'; number: number };
const describe = (state: PullState) => state.kind === 'not_requested' ? 'PR 생성 요청은 보내지 않았습니다'
  : state.kind === 'absent' ? '조회로 열린 PR이 없음을 확인했고 다시 요청하지 않았습니다'
  : `PR #${String(state.number)}은 이미 열려 있습니다`;

/** push는 끝났지만 그 뒤 확인에서 멈췄다. 원격 브랜치가 바뀐 사실과 확인한 PR 상태를 그대로 알린다. */
export class PushedThenStoppedError extends Error {
  override name = 'PushedThenStoppedError';
  readonly branch: string;
  readonly commit: string;
  readonly pull: PullState;
  constructor(branch: string, commit: string, reason: unknown, pull: PullState = { kind: 'not_requested' }) {
    super(`원격 브랜치 ${branch}에 ${commit.slice(0, 7)}를 이미 push했고, 그 뒤 소유 확인에서 멈췄습니다. ${describe(pull)}: ${reason instanceof Error ? reason.message : String(reason)}`, { cause: reason });
    this.branch = branch;
    this.commit = commit;
    this.pull = pull;
  }
}

/** PR 생성 응답을 잃었고 조회로도 확인하지 못했다. 만들어졌는지 모른다(만들지 않았다고 단정하지 않는다). */
export class PullRequestUnknownError extends Error {
  override name = 'PullRequestUnknownError';
  readonly branch: string;
  readonly commit: string;
  constructor(branch: string, commit: string, reason: unknown) {
    super(`원격 브랜치 ${branch}에 ${commit.slice(0, 7)}를 push했습니다. PR 생성 응답을 잃었고 조회도 실패해 PR이 만들어졌는지 모릅니다. 브랜치의 열린 PR을 확인하세요: ${reason instanceof Error ? reason.message : String(reason)}`, { cause: reason });
    this.branch = branch;
    this.commit = commit;
  }
}

/**
 * 개발 결과를 agent 브랜치에 push하고 그 브랜치의 PR을 연다. 멱등이다(조정자 결정 1).
 * 모든 외부 쓰기는 같은 관문을 지난다(github/write-gate.ts). 「마지막 확인 → 즉시 전송」이다.
 * - push: 권한 3상태 → pushGate(소유 → M4 원격·배포 키 → 소유) → 다른 await 없이 git push. 중단 신호는 진행 중인 push도 끊는다.
 * - PR 생성: 열린 PR 조회 → M4 관문 → 토큰 준비 → 소유 확인 → 다른 await 없이 POST(클라이언트의 `call`). 중단 신호는 진행 중인 요청도 끊는다.
 *   브랜치 기준 조회는 같은 브랜치의 PR 중복을 막을 뿐, 확인과 GitHub 처리 사이의 임대 만료까지 막지는 않는다(README 「보장하지 않는 것」).
 * - 생성 응답을 잃으면(통신 실패) 브랜치로 읽기 조회만 한다. 있으면 그 PR을 쓰고, 없으면 같은 관문으로 한 번 더 요청하고,
 *   조회도 실패하면 `PullRequestUnknownError`(모름)다. 만들지 않았다고 단정하지 않는다.
 * - 재시도할 수 없는 403(실제 권한 부족)만 외부 쓰기 막힘으로 바꾼다. 호출 횟수 제한 403은 M4 오류를 그대로 둔다.
 * - push 뒤 확인에서 멈추면 `PushedThenStoppedError`로 「이미 push했다」와 확인한 PR 상태를 알린다.
 */
export async function openPullRequest(d: Pick<TaskCheckDeps, 'github'> & { repo: TaskCheckOptions['repo'] }, job: AttemptContext['job'], head: string,
  guard: WriteGuard = () => Promise.resolve(), signal?: AbortSignal): Promise<{ number: number; head: string } | undefined> {
  const github = d.github;
  if (!github) return undefined;
  const branch = job.payload.branch;
  const blocked = () => new ExternalWriteBlockedError('GitHub 쓰기 권한(contents·pulls)이 없어 PR을 열 수 없습니다. 외부 쓰기 막힘으로 보류합니다.');
  const permissions = github.permissions();
  if (permissions.contents === 'missing' || permissions.pulls === 'missing') throw blocked();
  await d.repo.pushCommit(head, branch, pushGate(github, guard, signal));
  const input = { branch, title: `${job.payload.taskKey} ${job.payload.kind}`, body: `Agent WBS가 ${job.payload.taskKey}의 개발 결과로 연 PR입니다.` };
  const ensure = async (state: PullState) => {
    // 클라이언트가 전송 바로 앞에서 부르는 소유 확인. 실패하면 PR 요청을 보내지 않는다.
    const write = { guard: async () => {
      try { await guard(); signal?.throwIfAborted(); }
      catch (error) { throw new PushedThenStoppedError(branch, head, error, state); }
    }, ...(signal && { signal }) };
    try { return await github.ensurePullRequest(input, write); }
    catch (error) {
      if (error instanceof GitHubError && error.status === 403 && !error.retryable) throw blocked();
      throw error;
    }
  };
  let pull;
  try { pull = await ensure({ kind: 'not_requested' }); }
  catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 0) throw error;
    // 응답을 잃었다. 요청이 GitHub에 닿았는지 모르므로 읽기로 대조한다(쓰기 재시도부터 하지 않는다).
    let found;
    try { found = await github.findPullRequest(branch); }
    catch (lookup) { throw new PullRequestUnknownError(branch, head, lookup); }
    if (found) {
      if (signal?.aborted) throw new PushedThenStoppedError(branch, head, signal.reason, { kind: 'opened', number: found.number });
      pull = found;
    } else {
      if (signal?.aborted) throw new PushedThenStoppedError(branch, head, signal.reason, { kind: 'absent' });
      try { pull = await ensure({ kind: 'absent' }); }
      catch (again) {
        if (again instanceof GitHubError && again.status === 0) throw new PullRequestUnknownError(branch, head, again);
        throw again;
      }
    }
  }
  if (pull.branch !== branch) throw new Error('PR의 head 브랜치가 이 시도의 브랜치와 다릅니다.');
  return { number: pull.number, head: pull.branch };
}

/** M7-06의 실제 ①을 M5-02의 명령 실행·보유와 M5-05의 결과 흐름에 연결한다. */
export function bindTaskCheck(d: TaskCheckDeps) {
  return async (context: AttemptContext): Promise<BoundTaskCheckResult> => {
    const { job, output, epoch, signal } = context;
    const work = d.worktree(context);
    const repo = typeof d.repo === 'function' ? await d.repo() : d.repo;
    // 조정자 결정 1: dev → push → PR 열기 → ①. ①은 PR에 올린 그 커밋을 검사한다.
    const head = await repo.importWorktree(work.id, work.branch);
    const guard = serverWriteGuard(d.api, job, epoch, signal);
    const pullRequest = await openPullRequest({ github: d.github, repo }, job, head, guard, signal);
    signal.throwIfAborted();
    const basis = await repo.mainPipeline();
    await d.observeMainPipeline(basis);
    const execute: TaskCheckOptions['execute'] = (argv, cwd, signal) => d.execution.command({ id: job.id, fence: job.fence, epoch }, job.payload.agent,
      d.launch(argv, cwd), signal, { heavyHeld: true });
    const result = await runTaskCheck({ repo, worktreeId: work.id, branch: work.branch,
      heavy: d.execution.heavy, collectTests: d.collectTests ?? createTestCollector(execute), basis, signal, execute,
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
    // GitHub가 연결되지 않았으면 push하지 않는다. 관문(원격·배포 키 확인)을 거칠 수 없는 외부 쓰기는 하지 않는다.
    // PR도 없으므로 서버는 'PR 정보가 필요합니다'로 통합을 보류한다.
    return { ...result, ...(pullRequest && { pullRequest }) };
  };
}
