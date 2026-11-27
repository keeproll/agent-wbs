import type { ApiClient } from '../api/client.ts';
import { ciLaunch } from '../ci/launch.ts';
import { observeMainPipeline } from '../ci/observe.ts';
import { repositoryIdFor } from '../git/identity.ts';
import { InputChangeReporter } from '../git/inputs.ts';
import { GitRepository } from '../git/repository.ts';
import type { RunnerAppDeps } from '../app.ts';
import { createWorkspace, type WorkspaceOptions } from './workspace.ts';

export interface AttemptWiringOptions {
  home: string;
  agentRoot: string | null;
  /** GitHub 설정의 저장소 주소. 로컬 clone 이름(`repositoryIdFor`)을 이것으로 찾는다. */
  repoUrl: string;
  api: ApiClient;
  epoch: () => number;
  warn: (message: string) => void;
  env: NodeJS.ProcessEnv;
  /** 시험용: 저장소 여는 방법 바꾸기·fake 세션 HOME. */
  repo?: () => Promise<GitRepository>;
  sessionHome?: WorkspaceOptions['sessionHome'];
}

/**
 * `new RunnerApp({...})`에 더할 시도 흐름 값 두 개(jobs/README.md 「연결 지점」).
 * - `execution.prepare`: 시도별 작업 폴더(`workspace.ts`).
 * - `jobs`: 결과 수집 공급원(`collect.ts`), ① 공급원(`task-check.ts`), 보고 뒤 정리(`settle`).
 * 저장소는 처음 쓸 때 연다. 로컬 clone이 아직 없으면(초기 분석 전) 준비가 실패하고, 시도는 만들어지지 않는다(시작 전 실패).
 */
export function attemptWiring(o: AttemptWiringOptions): Pick<RunnerAppDeps, 'execution' | 'jobs'> & { execution: NonNullable<RunnerAppDeps['execution']> } {
  let opened: Promise<GitRepository> | undefined;
  const open = o.repo ?? (() => GitRepository.open(o.home, repositoryIdFor(o.repoUrl), { agentRoot: o.agentRoot }));
  const repo = async () => {
    opened ??= open();
    try { return await opened; } catch (error) { opened = undefined; throw error; }
  };
  const workspace = createWorkspace({ repo, ...(o.sessionHome && { sessionHome: true }) });
  const inputs = new InputChangeReporter({ api: o.api, epoch: o.epoch, warn: o.warn });
  return {
    execution: { prepare: job => workspace.prepare(job) },
    jobs: {
      collect: { repo, workspace },
      taskCheck: {
        repo,
        worktree: context => workspace.worktree(context.job),
        launch: (argv, cwd) => ciLaunch(argv, cwd, o.env),
        observeMainPipeline: async basis => { await observeMainPipeline(inputs, await repo(), basis); },
      },
      settle: async (context, report) => { await workspace.settle(context.job, report.verification?.result ?? null); },
    },
  };
}
