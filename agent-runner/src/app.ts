import { randomUUID } from 'node:crypto';
import type { ApiClient } from './api/client.ts';
import type { Agent } from './api/generated/client.ts';
import { Runner } from './api/runner.ts';
import { createResetCleanup, type ResetCleanupDeps } from './cleanup/reset.ts';
import { CliUpdater, cliBinary, type CliRegistry } from './cli-update/manager.ts';
import { cliAwareRun, cliEnvironment } from './cli-update/registry.ts';
import { checkGitHost } from './git/probe.ts';
import { createGitHubClient, type GitHubClient, type GithubMode, type RepoRef } from './github/client.ts';
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

/** 세션 실행 계층(M5)이 시도 하나를 실행하는 동안 등록하는 보유. 지금(M4)은 비어 있다. */
export interface ActiveSession extends SessionState {
  /** 실행 중인 자식 프로세스 수(CLI 업데이트 유휴 판정용) */
  children: number;
}

export interface GithubSettings {
  repo: RepoRef;
  mode: GithubMode;
  baseUrl?: string;
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
}

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
  readonly runner: Runner;
  readonly heavy: HeavySemaphore;
  readonly reporter: ResourceReporter;
  readonly usage = new UsageTracker();
  readonly updater: CliUpdater;
  readonly sessions: ActiveSession[] = [];
  readonly github: { client: GitHubClient; connector: GithubConnector; mode: GithubMode } | undefined;
  readonly bins: { codex: string; claude: string };
  #identity: { hostId: string; bootId: string } | undefined;
  readonly #d: RunnerAppDeps;
  readonly #run: RunCommand;
  readonly #cpu = new CpuMeter();
  #timers: { stop(): void }[] = [];
  #bootstrapped = false;

  constructor(d: RunnerAppDeps) {
    this.#d = d;
    this.bins = { codex: cliBinary(d.home, 'Codex'), claude: cliBinary(d.home, 'Claude') };
    const base = d.run ?? createRunCommand({ env: probeEnv(d.env) });
    const cli = d.cliRun ?? createRunCommand({ env: cliEnvironment(d.env) });
    // M-1: 준비 점검의 codex·claude도 전용 설치 경로를 세션 실행과 같은 인자·환경으로 부른다.
    this.#run = cliAwareRun(base, cli, this.bins);
    this.heavy = new HeavySemaphore(0);
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
    this.runner = new Runner({
      state: d.state,
      api: d.api,
      version: d.version,
      warn: d.warn,
      ...(d.now && { now: d.now }),
      cleanup: createResetCleanup({ home: d.home, identity: () => this.identity, ...d.cleanup }),
    });
    this.updater = new CliUpdater({
      home: d.home,
      // CliUpdater는 생성 때 식별자를 검사하므로 host 식별자를 읽은 뒤(bootstrap) 실제 값으로 바뀐다.
      owner: { get hostId() { return app.identity.hostId; }, get bootId() { return app.identity.bootId; }, get runnerId() { return runnerId(); } },
      registry: d.cliRegistry,
      activity: () => Promise.resolve([{ ...this.owner, children: this.sessions.reduce((n, s) => n + s.children, 0), held: this.sessions.reduce((n, s) => n + s.reserved, 0) }]),
      profiles: () => d.cliProfiles?.() ?? [],
      verified: () => verifiedFromPolicy(this.runner.policy?.cliGrades),
      report: (body) => this.reportReadiness(body),
      obsNote: () => cgroupNote((path) => d.hostSources.readFile(path)),
    });
    if (d.github) {
      const connector = new GithubConnector({
        api: d.api,
        epoch: () => d.state.snapshot.epoch,
        identity: () => ({ runnerId: runnerId(), ...this.identity }),
        enqueueStatus: async (body) => { await this.runner.outbox.enqueue('reportGithubStatus', { epoch: d.state.snapshot.epoch, body }); },
      });
      const source: TokenSource = d.github.mode === 'token' ? connector.tokenSource() : ghTokenSource();
      const mode = d.github.mode;
      const client = createGitHubClient({
        repo: d.github.repo,
        token: source.token,
        ...(d.github.baseUrl && { baseUrl: d.github.baseUrl }),
        ...(d.githubFetch && { fetch: d.githubFetch }),
        onPermissionDenied: async (event) => { await connector.reportPermissionDenied(event, client.permissions(), mode); },
      });
      this.github = { client, connector, mode };
    }
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
  async checkGithub(): Promise<void> {
    if (!this.github) return;
    if (this.github.mode === 'token') await this.github.connector.register();
    const status = await this.github.client.checkConnection(this.github.mode);
    await this.github.connector.reportConnection(status);
  }

  /**
   * Runner가 서버와 동기화된 뒤(`runner.ready`) 한 번 실행하는 시작 보고.
   * host → 준비 점검 → 모델 → GitHub 순서다. host 보고로 식별자와 상한을 먼저 받아야 나머지가 맞는 값을 쓴다.
   */
  async bootstrap(): Promise<void> {
    if (this.#bootstrapped) return;
    await this.reportHost();
    await this.updater.recover();
    await this.checkReadiness();
    await this.reportModels();
    await this.checkGithub().catch((error: unknown) => { this.#d.warn(`GitHub 연결 확인 실패: ${message(error)}`); });
    await this.runner.outbox.flush();
    this.#bootstrapped = true;
  }

  /** 매일 점검(준비 점검 → CLI 최신 확인·유휴 적용 → 모델)과 주기 보고를 건다. */
  startSchedules(): void {
    const onError = (what: string) => (error: unknown) => { this.#d.warn(`${what}: ${message(error)}`); };
    this.#timers.push(scheduleDaily(async () => {
      await this.checkReadiness();
      if (this.#d.cliUpdates !== false) {
        await this.updater.check();
        await this.updater.applyPending();
      }
      await this.reportModels();
    }, { onError: onError('매일 점검') }));
    this.#timers.push(scheduleDaily(() => this.reportConcurrency(), { intervalMs: 60_000, onError: onError('동시 실행 보고') }));
    this.#timers.push(scheduleDaily(() => this.reporter.reportUsage(this.usage), { intervalMs: 60_000, onError: onError('사용량 보고') }));
  }

  /** Runner 반복(heartbeat·poll)과 함께, 동기화가 끝나면 시작 보고와 주기 작업을 돈다. */
  async run(signal: AbortSignal): Promise<void> {
    await this.init();
    const after = (async () => {
      while (!signal.aborted && !this.#bootstrapped) {
        if (this.runner.ready) {
          try { await this.bootstrap(); this.startSchedules(); }
          catch (error) { this.#d.warn(`시작 보고 실패: ${message(error)}`); }
        }
        if (!this.#bootstrapped) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();
    try { await this.runner.run(signal); }
    finally {
      for (const timer of this.#timers) timer.stop();
      this.#timers = [];
      await after.catch(() => undefined);
    }
  }
}

/**
 * M4-01 보고 거부 기록을 readiness 경고로 붙인다.
 * [미정] 계약의 readiness key 목록에 거부 기록 전용 키가 없다(plan-pending). 키가 정해지면 이 함수만 바꾼다.
 */
export function withRejectionWarnings(body: ReadinessReport, warnings: readonly string[]): ReadinessReport {
  void warnings;
  return body;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
