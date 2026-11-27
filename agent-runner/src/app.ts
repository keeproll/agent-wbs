import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ApiClient } from './api/client.ts';
import type { Agent } from './api/generated/client.ts';
import { Runner } from './api/runner.ts';
import { authenticationFailed } from './api/outbox.ts';
import { createGithubRemoteCleanup } from './cleanup/remote.ts';
import { githubWriteGate } from './github/write-gate.ts';
import { createResetCleanup, type ResetCleanupDeps } from './cleanup/reset.ts';
import { CliUpdater, cliBinary, type CliRegistry } from './cli-update/manager.ts';
import { cliAwareRun, cliEnvironment } from './cli-update/registry.ts';
import { AGENT_USER, agentIsolationConfig, agentLoginRun, selectIsolation } from './cli/dedicated-user.ts';
import type { IsolationLayer } from './cli/isolation.ts';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryIdFor } from './git/identity.ts';
import { InputChangeReporter, type InputReport, type InputSource } from './git/inputs.ts';
import { checkGitHost } from './git/probe.ts';
import { GitRepository } from './git/repository.ts';
import { createGitHubClient, DeployKeyError, type GitHubClient, type GithubMode } from './github/client.ts';
import type { GithubSettings } from './config.ts';
import { GithubConnector } from './github/connector.ts';
import { ghTokenSource, type TokenSource } from './github/token.ts';
import { cgroupNote, checkReadiness, scheduleDaily, verifiedFromPolicy, type ReadinessDeps, type ReadinessReport } from './readiness/checks.ts';
import { createRunCommand, probeEnv, type RunCommand } from './readiness/command.ts';
import { HeavySemaphore } from './resources/heavy.ts';
import { collectHost, CpuMeter, sampleResources, type HostSources } from './resources/host.ts';
import { collectModels } from './resources/models.ts';
import { ResourceReporter, type SessionState } from './resources/reporter.ts';
import { UsageTracker } from './resources/usage.ts';
import type { State } from './state/state.ts';
import { Execution, type ExecutionOptions } from './exec/session.ts';
import { Launches } from './exec/launches.ts';
import { CiJobs, type CiJobsOptions } from './ci/jobs.ts';
import { AttemptFlow, type AttemptFlowOptions } from './jobs/attempt-flow.ts';
import { bindTaskCheck, type TaskCheckSources } from './jobs/task-check.ts';
import { createTestCollector } from './ci/collect-tests.ts';
import { wrapperAgentFiles } from './git/agent-git.ts';
import { ciLaunch } from './ci/launch.ts';

/** 세션 실행 계층(M5)이 시도 하나를 실행하는 동안 등록하는 보유. 지금(M4)은 비어 있다. */
export interface ActiveSession extends SessionState {
  /** 실행 중인 자식 프로세스 수(CLI 업데이트 유휴 판정용) */
  children: number;
}

export interface RunnerAppDeps {
  state: State;
  api: ApiClient;
  home: string;
  version: string;
  env: NodeJS.ProcessEnv;
  warn: (message: string) => void;
  hostSources: HostSources;
  /** 준비 점검 명령 실행기(실제: createRunCommand). 시험은 가짜를 넣는다. */
  run?: RunCommand;
  /** 전용 설치 CLI 실행기(실제: cliEnvironment로 만든 실행기) */
  cliRun?: RunCommand;
  cliRegistry: CliRegistry;
  /** 세션 실행에 쓸 CLI 조합(모델·옵션). M5 설정이 정한다. 비어 있으면 obs는 확인 불가 warn. */
  cliProfiles?: () => { agent: Agent; model: string; options: string }[];
  pg?: ReadinessDeps['pg'];
  github?: GithubSettings;
  githubFetch?: typeof fetch;
  /** 시험용: 원격 정리·launch 대조 주입 */
  cleanup?: Partial<Pick<ResetCleanupDeps, 'remote' | 'launchCheck' | 'groupEmpty'>>;
  now?: () => number;
  /** false면 CLI 최신 확인을 돌리지 않는다(시험·오프라인). */
  cliUpdates?: boolean;
  /**
   * 입력 변경 보고(M2-03 reportInputChanges)의 git 관측 공급원. 없으면 GitHub 설정의 저장소를 Runner 로컬 clone에서 연다.
   * 아직 clone이 없으면(초기 분석 전) 보고하지 않는다. 시험은 가짜를 넣는다.
   */
  inputSource?: () => Promise<InputSource | undefined>;
  /** 입력 확인 주기(시험용 덮어쓰기). 없으면 서버 정책 inputCheckMinutes, 그것도 없으면 5분. */
  inputIntervalMs?: number;
  /** M5 실행은 기존 격리 경계를 그대로 쓴다. 없으면 실제 실행을 거부한다(Q-08). */
  execution?: Pick<ExecutionOptions, 'prepare' | 'isolation' | 'verified'>;
  /**
   * Agent 전용 OS 계정 격리(Q-08)의 작업 영역(고정 `/srv/agentwbs`). 주면 CLI 설치·작업 폴더·입력 사본을 이 아래에 두고,
   * CLI 로그인 상태는 Agent 계정으로 확인한다(isolation.md §12). 없으면 지금처럼 Runner 홈.
   */
  agentRoot?: string | null;
  /** 시험용 CI 실행기 주입(fake 명령 실행기). 전용 계정 격리(agentRoot)에서는 받지 않는다(Runner 계정 직접 실행 금지, 조정자 결정 1). */
  ci?:Pick<CiJobsOptions,'repo'|'execute'|'collectTests'>;
  /**
   * 실제 CI 실행기(integrate·ci_retry, 조정자 결정 1·2). main이 켠다.
   * - 저장소: GitHub 설정의 저장소를 Runner 로컬 clone에서 연다. clone이 아직 없으면(초기 분석 전) 생길 때까지 기다린다.
   * - 명령: `Execution.command`(격리 계층의 command = 전용 계정이면 래퍼 ci-run, 사용자 scope 안)로만 실행한다.
   * - 시험 목록: `createTestCollector`(pipeline 명령 → vitest·playwright 목록, 형식이 다르면 수집 불가).
   * - 격리 계층이 없으면(전용 계정 미설치·점검 실패) CI job을 받지 않는다.
   */
  ciAuto?: boolean;
  /**
   * 검증한 결과 수집 공급원이 연결된 경우에만 시도 흐름을 시작한다.
   * `taskCheck`는 실제 ① 공급원(`TaskCheckSources`)을 넘긴다. 앱이 자기 GitHub 클라이언트·Execution·Runner로 `bindTaskCheck`를 부른다.
   * 함수를 직접 넘기는 모양은 시험용이다(실제 ①과 PR 생성을 거치지 않는다).
   */
  jobs?: Pick<AttemptFlowOptions, 'collect'> & { taskCheck: AttemptFlowOptions['taskCheck'] | TaskCheckSources };
}

/** 서버 정책을 받기 전 입력 확인 기본 주기(5분, 서버 정책 inputCheckMinutes의 기본값과 같음). */
export const INPUT_INTERVAL_MS = 5 * 60_000;

/**
 * Runner 구성 요소를 하나로 잇는다(main.ts의 조립 근거).
 *
 * 공유 인스턴스는 여기서 **한 번만** 만든다. 왜: 무거운 작업 번호표(HeavySemaphore)가 둘이면 상한이 두 배가 되고,
 * 보고기가 둘이면 같은 준비 점검 fail을 한쪽만 알게 된다.
 * - `heavy`: ResourceReporter가 서버 상한으로 크기를 바꾸고, 실행 계층·CI가 같은 객체로 번호표를 받는다.
 * - `reporter`: 준비 점검(M4-02)과 CLI 업데이트(M4-05)의 readiness 보고가 모두 이것을 거쳐 key별로 합쳐진다.
 * - `sessions`: CLI 업데이트 유휴 판정과 동시 실행 보고가 같은 목록을 본다.
 */
export class RunnerApp {
  readonly execution: Execution;
  readonly jobs: AttemptFlow | undefined;
  readonly runner: Runner;
  readonly heavy: HeavySemaphore;
  readonly reporter: ResourceReporter;
  readonly usage = new UsageTracker();
  readonly updater: CliUpdater;
  readonly sessions: ActiveSession[] = [];
  readonly github: { client: GitHubClient; connector: GithubConnector; mode: GithubMode; checkDeployKeys(): Promise<void> } | undefined;
  readonly bins: { codex: string; claude: string };
  readonly inputs: InputChangeReporter;
  #ci:CiJobs|undefined;
  /** CI 처리기. 시험 주입이면 생성 때, 실제 실행기(ciAuto)면 로컬 clone이 생긴 뒤 만든다. */
  get ci():CiJobs|undefined { return this.#ci; }
  #identity: { hostId: string; bootId: string } | undefined;
  readonly #d: RunnerAppDeps;
  readonly #run: RunCommand;
  readonly #cpu = new CpuMeter();
  #timers: { stop(): Promise<void> }[] = [];
  #bootstrapped = false;
  #ciRecovery: Promise<void> | undefined;
  /** 종료가 시작되면 새 예약 작업을 등록하지 않는다(P1-4). */
  #stopping = false;
  /** 치명적 오류(인증 실패 등) 발생 시 앱 전체를 멈추는 내부 신호(P1-3). */
  #halt: ((error: unknown) => void) | undefined;
  #tokenSource: TokenSource | undefined;
  /** 마지막으로 알린 격리 보류 이유. 같은 이유를 매번 다시 경고하지 않는다. */
  #isolationReason: string | null | undefined;

  constructor(d: RunnerAppDeps) {
    this.#d = d;
    const cliHome = d.agentRoot ?? d.home;
    this.bins = { codex: cliBinary(cliHome, 'Codex'), claude: cliBinary(cliHome, 'Claude') };
    const base = d.run ?? createRunCommand({ env: probeEnv(d.env) });
    const plainCli = d.cliRun ?? createRunCommand({ env: cliEnvironment(d.env) });
    // 전용 계정이면 로그인 상태 질의만 Agent 계정(래퍼 login-status)으로 보낸다. 나머지는 그대로.
    const isolation = d.agentRoot ? agentIsolationConfig({ AWBS_AGENT_USER: AGENT_USER }) : null;
    const cli = isolation ? agentLoginRun(isolation, plainCli) : plainCli;
    // M-1: 준비 점검의 codex·claude도 전용 설치 경로를 세션 실행과 같은 인자·환경으로 부른다.
    this.#run = cliAwareRun(base, cli, this.bins);
    this.heavy = new HeavySemaphore(0);
    this.inputs = new InputChangeReporter({ api: d.api, epoch: () => d.state.snapshot.epoch, warn: d.warn, recheck: () => this.runner.policy?.inputRecheck });
    const runnerId = () => d.state.snapshot.runnerId;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 아래 getter가 생성 중에도 현재 식별자를 읽는다.
    const app = this;
    this.reporter = new ResourceReporter({
      api: d.api,
      epoch: () => d.state.snapshot.epoch,
      heavy: this.heavy,
      idempotencyKey: () => `resources:${runnerId()}:${randomUUID()}`,
      ...(d.now && { now: d.now }),
    });
    if (d.github) {
      const systemKey = d.github.systemKey;
      const connector = new GithubConnector({
        api: d.api,
        epoch: () => d.state.snapshot.epoch,
        identity: () => ({ runnerId: runnerId(), ...this.identity }),
        enqueueStatus: async (body) => { await this.runner.outbox.enqueue('reportGithubStatus', { epoch: d.state.snapshot.epoch, body }); },
        // 봉인 조회의 WBS 401/403은 Runner 토큰 폐기다. 실행 중이면 앱을 멈춘다(재리뷰 N4).
        onAuthFailure: (error) => { this.#halt?.(error); },
      });
      const source: TokenSource = d.github.mode === 'token' ? connector.tokenSource() : ghTokenSource();
      this.#tokenSource = source;
      const mode = d.github.mode;
      const send = d.githubFetch ?? fetch;
      // GitHub가 401(토큰 만료·폐기·교체)을 주면 캐시한 토큰을 버려 다음 요청이 새 봉인 값을 받게 한다(P1-5).
      const githubFetch: typeof fetch = async (input, init) => {
        const response = await send(input, init);
        if (response.status === 401) source.invalidate();
        return response;
      };
      const checkDeployKeys = async (): Promise<void> => {
        try { await client.assertDeployKeys(systemKey?.id ?? null); }
        catch (error) {
          try { if (!(error instanceof DeployKeyError) || !error.retryable) d.warn(message(error)); }
          catch { /* 경고 출력 실패가 원래 거부 사유를 가리지 않게 한다. */ }
          throw error;
        }
      };
      const githubRepo = `https://github.com/${d.github.repo.owner}/${d.github.repo.repo}`;
      const client = createGitHubClient({
        repo: d.github.repo,
        token: () => source.token(),
        ...(d.github.baseUrl && { baseUrl: d.github.baseUrl }),
        fetch: githubFetch,
        // 모든 외부 쓰기(REST·Git push)의 관문. push는 원격 저장소 확인 뒤 같은 배포 키 검사를 거친다.
        beforeWrite: githubWriteGate(githubRepo, checkDeployKeys),
        onPermissionDenied: async (event) => { await connector.reportPermissionDenied(event, client.permissions(), mode); },
      });
      this.github = { client, connector, mode, checkDeployKeys };
    }
    const resetCleanup = createResetCleanup({
      home: d.home,
      agentRoot: d.agentRoot ?? null,
      identity: () => this.identity,
      launchCheck: async hold => {
        if (!hold.hostId || !hold.bootId) return 'unknown';
        return await new Launches(d.home, this.identity).reconcile({ job: hold.job, hostId: hold.hostId, bootId: hold.bootId, processGroup: hold.processGroup, cgroup: hold.cgroup }) ? 'none' : 'unknown';
      },
      // 원격 초기화는 GitHub 설정이 있을 때 실제 클라이언트로 연결한다(교차 리뷰 P1-2).
      ...(this.github && { remote: createGithubRemoteCleanup({ client: this.github.client, warn: d.warn,
        ...(d.github?.systemKey && { systemDeployKey: d.github.systemKey }) }) }),
      ...d.cleanup,
    });
    this.runner = new Runner({
      state: d.state,
      api: d.api,
      version: d.version,
      warn: d.warn,
      ...(d.now && { now: d.now }),
      cleanup: resetCleanup,
      onCleanupQueued: (command) => resetCleanup.markReported(command),
    });
    this.updater = new CliUpdater({
      home: cliHome,
      // 전용 계정이면 Agent 그룹이 읽고 실행만 하게 0o750(isolation.md §6).
      ...(d.agentRoot && { dirMode: 0o750 }),
      // CliUpdater는 생성 때 식별자를 검사하므로 host 식별자를 읽은 뒤(bootstrap) 실제 값으로 바뀐다.
      owner: { get hostId() { return app.identity.hostId; }, get bootId() { return app.identity.bootId; }, get runnerId() { return runnerId(); } },
      registry: d.cliRegistry,
      activity: async () => {
        const holds = (await d.api('getExecutionHolds', { epoch: d.state.snapshot.epoch })).body.holds;
        const held = holds.filter(h => h.host_id === this.identity.hostId && h.boot_id === this.identity.bootId).length;
        return [{ ...this.owner, children: this.sessions.reduce((n, s) => n + s.children, 0), held: held + this.sessions.reduce((n, s) => n + s.reserved, 0) }];
      },
      profiles: () => d.cliProfiles?.() ?? [],
      verified: () => verifiedFromPolicy(this.runner.policy?.cliGrades),
      report: (body) => this.reportReadiness(body),
      obsNote: () => cgroupNote((path) => d.hostSources.readFile(path)),
    });
    this.execution = new Execution({
      home: d.home, api: d.api, outbox: this.runner.outbox,
      identity: { get hostId() { return app.identity.hostId; }, get bootId() { return app.identity.bootId; } },
      epoch: () => d.state.snapshot.epoch, ready: () => this.runner.ready,
      env: d.env, binaries: { Codex: this.bins.codex, Claude: this.bins.claude },
      sessions: this.sessions, heavy: this.heavy,
      canStart: (agent, slots, sessions) => this.reporter.canStart(agent, slots, sessions),
      budget: role => this.runner.policy?.subagentBudget[role] ?? 0,
      updater: this.updater,
      prepare: () => Promise.reject(new Error('작업 폴더 준비 공급원이 연결되지 않았습니다.')),
      // 전용 계정 격리(Q-08)면 실행 직전마다 래퍼 check와 사용자 scope를 다시 확인한다. 시험이 격리 계층을 직접 주면 그대로 쓴다.
      ...(d.agentRoot && !d.execution?.isolation && { recheckIsolation: () => this.refreshIsolation() }),
      // 전용 계정 배치: 하위 Agent 정의 파일은 Agent 계정(래퍼 agent-file)으로만 쓴다(fix2 추가).
      ...(d.agentRoot && { agentFiles: wrapperAgentFiles() }),
      ...d.execution,
    });
    if (d.ci && d.agentRoot) throw new Error('전용 계정 격리에서는 CI 실행기를 주입할 수 없습니다. 실제 실행기(ciAuto)는 Agent 계정으로만 돈다.');
    if (d.ci && this.github) this.#ci = this.#ciJobs(d.ci);
    const taskCheck = d.jobs?.taskCheck;
    if (d.jobs && taskCheck) this.jobs = new AttemptFlow({
      ...d.jobs, execution: this.execution, runner: this.runner, api: d.api,
      // 실제 ①은 앱의 GitHub 클라이언트로 PR을 연다. GitHub 설정이 없으면 null(PR 없이 보고, 서버가 통합을 보류).
      taskCheck: typeof taskCheck === 'function' ? taskCheck
        : bindTaskCheck({ ...taskCheck, api: d.api, runner: this.runner, execution: this.execution, github: this.github?.client ?? null }),
      epoch: () => d.state.snapshot.epoch,
      identity: { get hostId() { return app.identity.hostId; }, get bootId() { return app.identity.bootId; } },
      onError: error => {
        if (authenticationFailed(error)) this.#halt?.(error);
        else d.warn(`시도 흐름 실패: ${message(error)}`);
      },
    });
  }

  #ciJobs(sources: Pick<CiJobsOptions,'repo'|'execute'|'collectTests'> & Pick<CiJobsOptions,'collectTestsFor'>): CiJobs {
    const d = this.#d, github = this.github;
    if (!github) throw new Error('GitHub 설정 없이 CI 처리기를 만들 수 없습니다.');
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- identity getter가 생성 뒤의 현재 식별자를 읽는다.
    const app = this;
    return new CiJobs({ ...sources,api:d.api,outbox:this.runner.outbox,runnerId:d.state.snapshot.runnerId,
      directory:join(d.home,'state','ci'),epoch:() => d.state.snapshot.epoch,ready:() => this.runner.ready,
      identity:{ get hostId() { return app.identity.hostId; },get bootId() { return app.identity.bootId; } },
      github:github.client,heavy:this.heavy,warn:d.warn });
  }

  /**
   * 실제 CI 실행기를 준비한다(ciAuto). 로컬 clone이 있으면 열어서 한 번만 만든다. 없으면 undefined(다음 주기에 다시 본다).
   * 명령은 모두 `Execution.command`로 간다: job의 슬롯·보유·launch 기록을 거치고, 격리 계층의 command로 Agent 계정에서 돈다.
   */
  async #ensureCi(): Promise<CiJobs | undefined> {
    if (this.#ci || !this.#d.ciAuto || !this.github) return this.#ci;
    const repo = this.#d.github?.repo;
    if (!repo) return undefined;
    const repositoryId = repositoryIdFor(`https://github.com/${repo.owner}/${repo.repo}`);
    if (!await lstat(join(this.#d.home, 'repos', repositoryId)).then(() => true, () => false)) return undefined;
    const git = await GitRepository.open(this.#d.home, repositoryId, { agentRoot: this.#d.agentRoot ?? null });
    const command = (job: { id: string; fence: number; epoch: number }, argv: readonly string[], cwd: string, signal?: AbortSignal) =>
      this.execution.command({ id: job.id, fence: job.fence, epoch: job.epoch }, 'Codex', ciLaunch(argv, cwd, this.#d.env), signal, { heavyHeld: true });
    this.#ci = this.#ciJobs({
      repo: git, execute: command,
      // job에 묶인 수집기를 쓴다. 이 기본값은 쓰이지 않아야 한다(쓰이면 수집 불가로 멈춘다).
      collectTests: () => Promise.reject(new Error('시험 목록 수집 불가: job에 묶이지 않은 수집 요청입니다.')),
      collectTestsFor: (job, argv, cwd, signal) => createTestCollector((list, dir, stopped) => command(job, list, dir, stopped))(argv, cwd, signal),
    });
    return this.#ci;
  }

  /**
   * Agent 실행 격리 계층을 고른다(Q-08). 준비 점검 뒤와 실행 직전마다 부른다.
   * - 전용 계정(`agentRoot`)이 없으면 지금 계층을 그대로 둔다. 기본은 실행 거부다.
   * - 있으면 `selectIsolation`(래퍼 check + 사용자 scope 시험)을 돌려, 통과하면 「전용 계정 + 사용자 scope」, 아니면 거부로 바꾼다.
   * - 보류 이유가 바뀔 때만 경고한다. 예: 「전용 Agent 계정 점검 실패: wsl_interop_accessible」.
   * 왜 매번 다시 보나: 준비 점검 뒤에도 WSL 보호·사용자 systemd 상태가 바뀔 수 있다(isolation.md §11).
   */
  async refreshIsolation(): Promise<IsolationLayer | undefined> {
    if (!this.#d.agentRoot || this.#d.execution?.isolation) return this.execution.isolation;
    const choice = await selectIsolation({ AWBS_AGENT_USER: AGENT_USER }, this.#run);
    const layer = choice.reason === null ? choice.isolation : undefined;
    if (choice.reason !== this.#isolationReason) {
      if (choice.reason !== null) this.#d.warn(`실제 Agent 실행 보류: ${choice.reason}`);
      this.#isolationReason = choice.reason;
    }
    this.execution.setIsolation(layer);
    return layer;
  }

  get identity(): { hostId: string; bootId: string } {
    // 식별자를 읽기 전에는 어떤 보유도 이 PC의 것으로 증명하지 않는다.
    return this.#identity ?? { hostId: 'unknown-host', bootId: 'unknown-boot' };
  }

  get owner(): { hostId: string; bootId: string; runnerId: string } {
    return { ...this.identity, runnerId: this.#d.state.snapshot.runnerId };
  }

  /**
   * readiness 보고 단일 통로. M4-01의 보고 거부 기록 경고를 함께 싣는다.
   * 왜: 거부 기록은 contracts §1.2 「다른 4xx는 rejected로 보존하고 readiness 경고로 올린다」의 대상이다.
   */
  async reportReadiness(body: ReadinessReport): Promise<void> {
    await this.reporter.reportReadiness(withRejectionWarnings(body, this.runner.outbox.readinessWarnings));
  }

  /** 준비 점검 12항목. `repo`는 M4-03이 기대는 /proc·flock 점검이다. */
  async checkReadiness(): Promise<ReadinessReport> {
    const d = this.#d;
    const report = await checkReadiness({
      run: this.#run,
      bins: { ...this.bins, git: 'git', node: process.execPath, pnpm: 'pnpm', gh: 'gh', pgIsReady: 'pg_isready' },
      worktreeRoot: d.home,
      diskFree: (path) => d.hostSources.diskFree(path),
      readFile: (path) => d.hostSources.readFile(path),
      pg: d.pg ?? null,
      probes: { repo: () => checkGitHost(this.#run, (path) => d.hostSources.readFile(path)) },
      cliProfiles: d.cliProfiles?.() ?? [],
      verifiedObservations: verifiedFromPolicy(this.runner.policy?.cliGrades),
    }, new Date((d.now ?? Date.now)()));
    await this.reportReadiness(report);
    return report;
  }

  /**
   * 이 PC의 식별자(hostId·bootId)를 읽는다. 서버 통신 전에 한다.
   * 왜: 동기화 전에 오는 정리 명령도 「이 PC·이 부팅의 보유인가」를 판단해야 한다.
   */
  async init(): Promise<void> {
    await (this.#ciRecovery ??= GitRepository.recoverTaskChecks(this.#d.home, { agentRoot: this.#d.agentRoot ?? null }));
    const host = await collectHost(this.#d.hostSources, this.#d.home);
    this.#identity = { hostId: host.hostId, bootId: host.bootId };
  }

  /** host 사양 보고. 식별자(hostId·bootId)는 정리 증거·키 등록·CLI 업데이트 소유자 판정에 함께 쓴다. */
  async reportHost(): Promise<void> {
    const host = await collectHost(this.#d.hostSources, this.#d.home);
    this.#identity = { hostId: host.hostId, bootId: host.bootId };
    await this.reporter.reportHost(host);
  }

  /** 모델 보고. rank는 싣지 않고, Claude 목록은 서버 정책의 claudeModels를 쓴다. */
  async reportModels(): Promise<void> {
    const claudeModelIds = this.runner.policy?.claudeModels;
    for (const agent of ['Codex', 'Claude'] as const) {
      const body = await collectModels(agent, { run: this.#run, ...this.bins, ...(claudeModelIds && { claudeModelIds }) });
      if (body) await this.reporter.reportModels(body);
    }
  }

  /** 동시 실행 상태 보고(주기). 자원 관측 실패는 안정 시간을 다시 센다. */
  async reportConcurrency(): Promise<void> {
    let sample;
    try {
      const resources = await sampleResources(this.#d.hostSources);
      const cpuPct = this.#cpu.sample(await this.#d.hostSources.readFile('/proc/stat'));
      sample = { cpuPct, memFreeGB: resources.memFreeGB, swapUsedGB: resources.swapUsedGB };
    } catch (error) {
      this.reporter.sampleFailed();
      throw error;
    }
    this.reporter.observe(sample);
    await this.reporter.reportConcurrency(this.sessions, this.heavy.snapshot().running, sample);
  }

  /** GitHub 연결 확인 → 권한 3상태 보고(토큰 방식이면 키 등록·봉인 조회 포함). */
  async checkGithub(signal?: AbortSignal): Promise<void> {
    if (!this.github) return;
    signal?.throwIfAborted();
    // 연결 재확인은 새로 판단한다. 자격 증명이 바뀌었을 수 있으므로 캐시한 토큰을 버린다(P1-5).
    this.#tokenSource?.invalidate();
    if (this.github.mode === 'token') await this.github.connector.register();
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      try { await this.github.checkDeployKeys(); break; }
      catch (error) {
        if (!(error instanceof DeployKeyError) || !error.retryable || attempt >= 2) throw error;
        await sleep(Math.max(error.retryAfterSeconds ?? 0, 2 ** attempt) * 1000, undefined, { signal });
      }
    }
    signal?.throwIfAborted();
    const status = await this.github.client.checkConnection(this.github.mode);
    // 연결 확인은 토큰 취득 실패를 ok:false로 바꾼다. WBS 인증 실패였으면 상태를 보고하지 않고 그 오류를 그대로 던진다.
    if (this.github.connector.authFailure !== undefined) throw this.github.connector.authFailure;
    await this.github.connector.reportConnection(status);
  }

  /**
   * 입력 변경 보고 한 번(M2-03 새 계약). 원격 main을 받아 서버 입력 head와의 `prototype/` 트리 차이를 보낸다.
   * 409면 서버 head로 다시 계산하고, 이력 재작성이면 멈춘다(InputChangeReporter).
   * 로컬 clone이 아직 없으면 아무것도 하지 않는다(undefined).
   */
  async reportInputs(): Promise<InputReport | undefined> {
    const source = await (this.#d.inputSource ?? (() => this.#defaultInputSource()))();
    if (!source) return undefined;
    return this.inputs.report(source);
  }

  async #defaultInputSource(): Promise<InputSource | undefined> {
    const repo = this.#d.github?.repo;
    if (!repo) return undefined;
    const repositoryId = repositoryIdFor(`https://github.com/${repo.owner}/${repo.repo}`);
    const exists = await lstat(join(this.#d.home, 'repos', repositoryId)).then(() => true, () => false);
    if (!exists) return undefined;
    const git = await GitRepository.open(this.#d.home, repositoryId, { agentRoot: this.#d.agentRoot ?? null });
    return { fetch: () => git.fetch({ allowRewrite: true }), inputObservation: (base, head) => git.inputObservation(base, head) };
  }

  /**
   * Runner가 서버와 동기화된 뒤(`runner.ready`) 한 번 실행하는 시작 보고.
   * host → 준비 점검 → 모델 → GitHub 순서다. host 보고로 식별자와 상한을 먼저 받아야 나머지가 맞는 값을 쓴다.
   */
  async bootstrap(signal?: AbortSignal): Promise<void> {
    if (this.#bootstrapped) return;
    signal?.throwIfAborted();
    await this.reportHost();
    await this.runner.outbox.flush();
    if (!await this.execution.recover(undefined, signal)) throw new Error('launch 대조 실패: unconfirmed 보유가 있어 새 실행을 보류합니다.');
    await this.updater.recover();
    await this.checkReadiness();
    await this.refreshIsolation();
    await this.reportModels();
    await this.checkGithub(signal).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      // 키 등록·봉인 조회의 WBS 인증 실패는 Runner 토큰 문제이므로 위로 올려 앱을 멈춘다(P1-3).
      if (authenticationFailed(error) || (error instanceof DeployKeyError && !error.retryable)) throw error;
      this.#d.warn(`GitHub 연결 확인 실패: ${message(error)}`);
    });
    signal?.throwIfAborted();
    await this.runner.outbox.flush();
    this.#bootstrapped = true;
  }

  /** 매일 점검(준비 점검 → CLI 최신 확인·유휴 적용 → 모델)과 주기 보고를 건다. 종료가 시작된 뒤에는 등록하지 않는다. */
  startSchedules(signal?:AbortSignal): void {
    if (this.#stopping) return;
    const onError = (what: string) => (error: unknown) => {
      // WBS 인증 실패(401/403)는 일반 실패가 아니다. Runner 토큰이 폐기된 것이므로 앱 전체를 멈춘다(contracts §1.1 표).
      if (authenticationFailed(error)) { this.#halt?.(error); return; }
      this.#d.warn(`${what}: ${message(error)}`);
    };
    if (this.jobs) this.#timers.push(scheduleDaily(async () => {
      await this.jobs?.poll(this.reporter.caps?.total ?? 0, signal);
    }, { intervalMs: 1000, onError: onError('시도 예약') }));
    this.#timers.push(scheduleDaily(async () => {
      await this.checkReadiness();
      await this.refreshIsolation();
      if (this.#d.cliUpdates !== false) {
        await this.updater.check();
        await this.updater.applyPending();
      }
      await this.reportModels();
    }, { onError: onError('매일 점검') }));
    this.#timers.push(scheduleDaily(() => this.reportConcurrency(), { intervalMs: 60_000, onError: onError('동시 실행 보고') }));
    this.#timers.push(scheduleDaily(() => this.reporter.reportUsage(this.usage), { intervalMs: 60_000, onError: onError('사용량 보고') }));
    if (this.#ci || this.#d.ciAuto) this.#timers.push(scheduleDaily(async () => {
      // 실제 실행기는 격리 계층(전용 계정 + scope)이 있을 때만 CI job을 받는다. 없으면 받아도 실행할 수 없다.
      if (this.#d.ciAuto && !this.execution.isolation) return;
      await (await this.#ensureCi())?.runNext(this.reporter.caps?.total ?? 0,signal);
    },{ intervalMs:1000,onError:onError('통합·CI 재실행') }));
    // 주기는 서버 정책(inputCheckMinutes)을 따른다. 정책이 없으면 기본 5분(P3-1 임시값).
    const policyMinutes = this.runner.policy?.inputCheckMinutes;
    const inputInterval = this.#d.inputIntervalMs ?? (policyMinutes ? policyMinutes * 60_000 : INPUT_INTERVAL_MS);
    const now = this.#d.now ?? Date.now;
    let nextInputAt = 0;
    let inputTicket: string | undefined;
    // 정책은 5초마다 받는다. 확인 번호가 바뀌면 정기 확인 시각 전에도 관측하되 같은 번호로 중복 실행하지 않는다.
    this.#timers.push(scheduleDaily(async () => {
      const ticket = JSON.stringify([this.#d.state.snapshot.epoch, this.runner.policy?.inputRecheck, this.runner.policy?.inputCheckRequest]);
      if (now() < nextInputAt && ticket === inputTicket) return;
      nextInputAt = now() + inputInterval;
      inputTicket = ticket;
      await this.reportInputs();
    }, { intervalMs: Math.min(inputInterval, 5000), onError: onError('입력 변경 보고') }));
  }

  /**
   * Runner 반복(heartbeat·poll)과 함께, 동기화가 끝나면 시작 보고와 주기 작업을 돈다.
   *
   * 끝나는 조건은 셋이다: 외부 종료 신호, 통신 반복의 종료·치명적 오류, 시작 보고·예약 작업의 WBS 인증 실패.
   * 어느 경우든 같은 순서로 정리한다.
   * 1. 종료 표시 → 새 예약 등록 금지.
   * 2. 통신 반복과 시작 보고 반복이 끝나기를 기다린다.
   * 3. 예약 작업을 멈추고, 이미 실행 중인 작업이 끝나기를 기다린다.
   * 4. 치명적 오류가 있었으면 그 오류를 던진다(main이 종료 코드 1로 끝낸다).
   * 왜: 이 순서를 지켜야 main이 `runner.stop()`·`State.close()`(홈 잠금 해제)를 한 뒤에는 이전 실행의 작업이 남지 않는다.
   */
  async run(signal: AbortSignal): Promise<void> {
    await this.init();
    const internal = new AbortController();
    let fatal: { error: unknown } | undefined;
    const halt = (error?: unknown) => {
      if (error !== undefined && !fatal) fatal = { error };
      this.#stopping = true;
      internal.abort();
    };
    this.#halt = halt;
    const onAbort = () => halt();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) halt();
    const communication = this.runner.run(internal.signal).then(() => halt(), (error: unknown) => halt(error ?? new Error('Runner 통신 반복 오류')));
    const startup = (async () => {
      while (!internal.signal.aborted && !this.#bootstrapped) {
        if (this.runner.ready) {
          try {
            await this.bootstrap(internal.signal);
            if (!internal.signal.aborted) this.startSchedules(internal.signal);
          } catch (error) {
            if (internal.signal.aborted) return;
            if (authenticationFailed(error) || (error instanceof DeployKeyError && !error.retryable)) { halt(error); return; }
            this.#d.warn(`시작 보고 실패: ${message(error)}`);
          }
        }
        if (this.#bootstrapped || internal.signal.aborted) break;
        await sleep(1000, undefined, { signal: internal.signal }).catch(() => undefined);
      }
    })();
    try {
      await Promise.all([communication, startup]);
    } finally {
      this.#stopping = true;
      internal.abort();
      const timers = this.#timers;
      this.#timers = [];
      await Promise.allSettled(timers.map((timer) => timer.stop()));
      if (this.jobs) await this.jobs.shutdown();
      else await this.execution.shutdown();
      await this.ci?.shutdown();
      signal.removeEventListener('abort', onAbort);
      this.#halt = undefined;
    }
    if (fatal) throw fatal.error;
  }
}

/** 보고 거부는 별도 경고로 보낸다(contracts §1.2). 다른 준비 실패를 덮어쓰지 않는다. */
export function withRejectionWarnings(body: ReadinessReport, warnings: readonly string[]): ReadinessReport {
  return { ...body, items: [...body.items.filter(item => item.key !== 'reports'), {
    key: 'reports', status: warnings.length ? 'warn' : 'ok',
    detail: warnings.length ? warnings.join('\n') : '보고 거부 기록 없음',
    fix: warnings.length ? 'Runner의 거부 기록을 확인하고 원인을 해결하세요.' : '',
  }] };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
