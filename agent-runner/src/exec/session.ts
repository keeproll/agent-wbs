import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError, type ApiClient, type ApiRequest, type ApiResponse, type OperationId } from '../api/client.ts';
import { retryable, retryDelay, type Outbox } from '../api/outbox.ts';
import type { Agent, ClaimedJob, ExecutionHold } from '../api/generated/client.ts';
import { buildLaunch, sessionOptions } from '../cli/args.ts';
import { createParser } from '../cli/adapters.ts';
import type { CliEvent } from '../cli/events.ts';
import { SubagentObserver, sessionSlots } from '../cli/observe.ts';
import { SubagentUsage } from '../cli/usage.ts';
import { JsonlDecoder } from '../cli/stream.ts';
import type { IsolationLayer, Launch } from '../cli/isolation.ts';
import { IsolationUndecidedError } from '../cli/isolation.ts';
import type { ResourceReporter, SessionState } from '../resources/reporter.ts';
import type { HeavySemaphore } from '../resources/heavy.ts';
import { atomicWrite } from '../state/files.ts';
import type { ReportId } from '../state/state.ts';
import { installSubagents, localAgentFiles, SubagentInstallError } from './install.ts';
import type { AgentFiles } from '../git/agent-git.ts';
import { Launches, type LaunchJob, type Proof } from './launches.ts';
import { runProcess } from './process.ts';

export type AttemptJob = Extract<ClaimedJob, { kind: 'attempt' }>;
export type ActiveSession = SessionState & { children: number };
export interface ExecutionOptions {
  home: string;
  identity: { hostId: string; bootId: string };
  api: ApiClient;
  outbox: Outbox;
  epoch: () => number;
  ready: () => boolean;
  env: NodeJS.ProcessEnv;
  binaries: Record<Agent, string>;
  /**
   * M4 git 계층이 만든 작업 폴더와 그 HEAD. `notes`는 지시문 끝에 붙일 Runner 안내(입력 사본 위치·종료 메시지 형식)다.
   * 구현: `jobs/workspace.ts`의 `AttemptWorkspace.prepare`.
   */
  prepare: (job: AttemptJob) => Promise<{ cwd: string; headSha: string; notes?: string }>;
  budget: (role: 'dev' | 'qa') => number;
  sessions: ActiveSession[];
  heavy: HeavySemaphore;
  canStart: ResourceReporter['canStart'];
  isolation?: IsolationLayer;
  /**
   * 실행 직전 격리 재확인(전용 계정이면 래퍼 `check`와 사용자 scope 시험). 돌려준 계층으로 이번 실행을 감싼다.
   * undefined를 돌려주면 이번 실행과 이후 claim을 거부한다. 없으면(시험) 지금 계층을 그대로 쓴다.
   * 왜: 준비 점검 뒤에도 상태가 바뀔 수 있다. 예: 재부팅 뒤 /run/WSL 보호가 아직 안 돌았거나 사용자 systemd가 멈췄다(isolation.md §11).
   */
  recheckIsolation?: () => Promise<IsolationLayer | undefined>;
  /**
   * 작업 폴더 안 하위 Agent 정의 파일 접근(fix2 추가). 전용 계정 배치는 래퍼 `agent-file`(Agent 계정)을 넣는다.
   * 없으면 같은 계정 배치의 직접 접근(`localAgentFiles`). 왜: Runner 계정은 Agent가 쓸 수 있는 폴더에 쓰지 않는다.
   */
  agentFiles?: AgentFiles;
  verified?: (agent: Agent, model: string, options: string) => boolean;
  updater?: { tryClaim(): (() => void) | null; applyPending(): Promise<unknown> };
  /**
   * claim 응답 뒤 자원 확인이 실패하면 이 시간(ms)까지 같은 임대로 기다리며 다시 확인한다. 기본 20초.
   * 왜: claim 요청과 응답 사이의 짧은 경합 때문에 자동 QA·재작업 job이 시작 전 실패가 되면 팀장 버튼이 필요해진다(M5-05 P3-4, contracts §3.4-8).
   * 임대(60초)에서 시계 역행 여유를 뺀 시간보다 짧아야 한다. 그래도 부족하면 서버 대기열에 반환한다.
   */
  admissionWaitMs?: number;
  /** 전송 재시도 간격. 시험은 실제 10초 대기 대신 한 번의 재시도와 중단을 주입한다. */
  retryDelay?: typeof retryDelay;
}
interface Resume { cwd: string; agent: Agent; model: string; effort: string; sessionId: string }
class ResourceUnavailableError extends Error {}
export type AttemptOutput = Awaited<ReturnType<typeof runProcess>> & {
  attemptId: string; cwd: string; headSha: string; notes?: string; ok: boolean; text: string;
  /** 이 실행의 CLI 세션 ID(Claude session_id, Codex thread_id). 형식 수정 요청(`followUp`)이 같은 세션을 잇는다. */
  sessionId?: string;
  /** 서버가 정한 이번 실행의 모델·Effort. 수정 요청도 같은 값으로 돈다. */
  grade: { model: string; effort: string };
  observation: ReturnType<SubagentObserver['snapshot']>; reserved: number;
  resultEvent: Extract<CliEvent, { type: 'result' }> | undefined;
  tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
};
export interface AttemptOptions {
  resume?: boolean;
  signal?: AbortSignal;
  prompt?: string;
  started?: (attemptId: string) => Promise<void>;
  /** CLI가 지시문을 읽고 출력을 시작한 뒤 한 번만 호출한다. */
  delivered?: () => Promise<void>;
  /** 물리 슬롯 반환 뒤에도 같은 임대와 종료 신호를 유지한다. */
  complete?: (output: AttemptOutput, signal: AbortSignal) => Promise<void>;
}

/** 서버 등급과 fence(낡은 Runner를 막는 번호표)를 그대로 사용한다. */
/**
 * 서버 임대 끝보다 이만큼 먼저 스스로 멈춘다(ms). 이 PC의 벽시계는 약 32초마다 2.3초 뒤로 간다.
 * 서버가 준 끝 시각을 Runner 벽시계로 재므로, 시계가 뒤로 가면 서버가 임대를 끝낸 뒤에도 일할 수 있다.
 * 그 폭보다 넉넉한 5초를 여유로 둔다(통합 [제품 위험] 결정: 여유 ≥5초).
 */
export const LEASE_SAFETY_MS = 5_000;
export class Execution {
  readonly launches: Launches;
  readonly #d: ExecutionOptions;
  readonly #running = new Map<string, AbortController>();
  readonly #controllers = new Set<AbortController>();
  readonly #tasks = new Set<Promise<unknown>>();
  readonly #jobs = new Set<string>();
  readonly #reservations = new Set<SessionState>();
  #recovered = false;
  #isolation: IsolationLayer | undefined;
  constructor(options: ExecutionOptions) { this.#d = options; this.#isolation = options.isolation; this.launches = new Launches(options.home, options.identity); }
  get heavy(): HeavySemaphore { return this.#d.heavy; }
  /** 하위 Agent 정의 파일을 다루는 방법(전용 계정이면 Agent 계정). */
  get agentFiles(): AgentFiles { return this.#d.agentFiles ?? localAgentFiles; }
  /** 지금 쓰는 격리 계층. 없으면 실제 실행을 거부한다(Q-08). */
  get isolation(): IsolationLayer | undefined { return this.#isolation; }
  /** 준비 점검이 고른 격리 계층으로 바꾼다. undefined면 새 claim·실행을 거부한다. 이미 실행 중인 세션은 시작 때 계층을 그대로 쓴다. */
  setIsolation(isolation: IsolationLayer | undefined): void { this.#isolation = isolation; }

  /** 실행 직전 계층. 재확인이 실패하면 거부를 유지하고 실행하지 않는다. */
  async #currentIsolation(): Promise<IsolationLayer> {
    if (this.#d.recheckIsolation) this.#isolation = await this.#d.recheckIsolation();
    if (!this.#isolation) throw new IsolationUndecidedError();
    return this.#isolation;
  }

  /** 서버 보유 대조가 끝나기 전에는 새 claim을 허용하지 않는다. */
  async recover(holds?: ExecutionHold[], signal?: AbortSignal): Promise<boolean> {
    this.#recovered = false;
    signal?.throwIfAborted();
    // 반환 보고를 일반 해제보다 먼저 대조해야 대기열의 논리 잠금을 닫지 않는다.
    const returns = this.#d.outbox.pending.filter(e => e.operation === 'returnJob' && e.request.epoch === this.#d.epoch());
    for (const entry of returns) await this.#call('returnJob',entry.request as ApiRequest<'returnJob'>,signal);
    const remote = holds ?? (await this.#call('getExecutionHolds', { epoch: this.#d.epoch() }, signal)).body.holds;
    for (const hold of remote) {
      signal?.throwIfAborted();
      if (returns.some(e => e.request.params?.id === hold.job && e.request.body?.fence === hold.fence)) continue;
      if (hold.host_id !== this.#d.identity.hostId) continue;
      if (hold.boot_id === null || hold.fence === null) return false;
      const proof = hold.slot_state === 'none' && hold.pgid === null
        ? { kind: 'no_process' as const, bootId: hold.boot_id }
        : await this.launches.reconcile({ job: hold.job, hostId: hold.host_id, bootId: hold.boot_id, processGroup: hold.pgid, cgroup: hold.cgroup });
      if (!proof) return false;
      if (hold.attempt !== null) {
        try { await this.#report('interruptAttempt', { epoch: hold.epoch, params: { attemptId: hold.attempt }, body: { fence: hold.fence, reason: 'reboot', at: new Date().toISOString() } }, signal); }
        catch (e) { if (!(e instanceof ApiError) || !['ATTEMPT_CLOSED', 'LEASE_LOST'].includes(e.error?.code ?? '')) throw e; }
      }
      const request = { epoch: hold.epoch, params: { id: hold.job }, body: { fence: hold.fence, hostId: hold.host_id, proof, at: new Date().toISOString() } };
      const queued = await this.#d.outbox.enqueue('releaseJob', request);
      await this.#call('releaseJob', { ...request, idempotencyKey: queued.request.idempotencyKey }, signal);
      await this.#completeJob({ id: hold.job, epoch: hold.epoch, fence: hold.fence });
    }
    for (const r of await this.launches.list()) {
      signal?.throwIfAborted();
      if (r.hostId === this.#d.identity.hostId && !r.completedAt && !await this.launches.retire(r)) return false;
    }
    await this.#d.outbox.flush();
    this.#recovered = true;
    return true;
  }

  async claim(capacity: number): Promise<ClaimedJob | null> {
    if (!this.#isolation || !this.#recovered || !this.#d.ready()) return null;
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError('실행 용량이 올바르지 않습니다.');
    // 기존 보유는 서버의 claim 트랜잭션에서 빼므로 전체 한도를 그대로 보낸다.
    const allowed = capacity > 0 && (['dev', 'qa'] as const).some(role =>
      (['Claude', 'Codex'] as const).some(agent => this.#admission(agent, this.#attemptSlots(role)).ok));
    const release = this.#d.updater?.tryClaim();
    if (this.#d.updater && !release) return null;
    try {
      const result = await this.#call('claimJob', { epoch: this.#d.epoch(), idempotencyKey: randomUUID(), body: { kinds: allowed ? ['attempt', 'stop_attempt'] : ['stop_attempt'], capacity } });
      const job = result.status === 200 ? result.body.job : null;
      if (job?.kind === 'attempt') {
        try { await this.#awaitStart(job, this.#attemptSlots(job.payload.kind === 'dev' || job.payload.kind === 'rework' ? 'dev' : 'qa')); }
        catch (error) {
          if (error instanceof ResourceUnavailableError) { await this.#returnUnstarted(job,this.#d.epoch()); return null; }
          await this.#finishUnstarted(job, this.#d.epoch()); throw error;
        }
      }
      return job;
    } finally { release?.(); }
  }

  stop(attemptId: string): boolean {
    const controller = this.#running.get(attemptId);
    controller?.abort();
    return controller !== undefined;
  }

  run(job: AttemptJob, options: AttemptOptions = {}) {
    const key = `${this.#d.epoch()}:${job.id}`;
    if (this.#jobs.has(key)) return Promise.reject(new Error('이미 실행 중인 job입니다.'));
    this.#jobs.add(key);
    const task = this.#run(job, options);
    this.#tasks.add(task);
    void task.finally(() => { this.#tasks.delete(task); this.#jobs.delete(key); }).catch(() => undefined);
    return task;
  }

  async shutdown(): Promise<void> {
    for (const controller of this.#controllers) controller.abort();
    await Promise.allSettled(this.#tasks);
  }

  /** ① 명령은 같은 무거운 작업 번호표를 쓰고 물리 슬롯만 반납한다. 논리 잠금은 후속 단계가 쓴다. */
  command(job: LaunchJob, agent: Agent, launch: Launch, signal?: AbortSignal, options: { heavyHeld?: boolean } = {}) {
    const task = this.#command(job, agent, launch, signal, options.heavyHeld ?? false, false);
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task)).catch(() => undefined);
    return task;
  }

  /**
   * 형식 수정 요청(contracts §5): 끝난 시도의 같은 CLI 세션을 같은 작업 폴더에서 한 번 더 실행한다.
   * - 같은 job·fence·임대다. 물리 슬롯을 다시 받고(`acquireJobSlots`) 프로세스를 등록한 뒤, 끝나면 종료 증거로 반환한다.
   *   왜: 슬롯을 반환한 뒤 서버 보유 없이 프로세스를 띄우면 PC 자리 계산과 정리 대조가 어긋난다(contracts §4.1 ① 실패 수정과 같은 길).
   * - 무거운 작업 번호표는 받지 않는다. CLI 세션은 원래도 받지 않는다.
   * - 세션 ID가 없으면(첫 실행이 세션을 알리지 않음) 수정 요청을 보낼 수 없다. 추측해서 새 세션을 열지 않는다.
   * - 횟수(시도마다 1회)는 호출자(`jobs/collect.ts`)가 지킨다.
   */
  followUp(job: AttemptJob, epoch: number, output: AttemptOutput, prompt: string, signal?: AbortSignal): Promise<{ ok: boolean; code: number | null; text: string }> {
    const task = this.#followUp(job, epoch, output, prompt, signal);
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task)).catch(() => undefined);
    return task;
  }

  async #followUp(job: AttemptJob, epoch: number, output: AttemptOutput, prompt: string, signal?: AbortSignal) {
    if (!output.sessionId) throw new Error('이어 갈 CLI 세션 ID가 없어 형식 수정 요청을 보낼 수 없습니다.');
    const agent = job.payload.agent;
    const isolation = await this.#currentIsolation();
    const launch = buildLaunch(agent, this.#d.binaries[agent], { ...output.grade, cwd: output.cwd, prompt, resume: output.sessionId }, { env: this.#d.env, isolation });
    const result = await this.#command({ id: job.id, fence: job.fence, epoch }, agent, launch, signal, true, true);
    const decoder = new JsonlDecoder(), parse = createParser(agent);
    let ok = false, text = '', resultText: string | undefined;
    for (const record of [...decoder.push(Buffer.from(result.stdout)), ...decoder.end()]) for (const event of parse(record)) {
      if (event.type === 'result') { ok = event.ok; resultText = event.text; }
      if (event.type === 'message') text = event.text;
    }
    // 원문 기록에도 남긴다(첫 실행과 같은 파일). 왜: 수정 요청 뒤 결과가 어디서 왔는지 사람이 대조할 수 있어야 한다.
    await mkdir(join(this.#d.home, 'transcripts'), { recursive: true, mode: 0o700 });
    const transcript = await open(join(this.#d.home, 'transcripts', `${createHash('sha256').update(output.attemptId).digest('hex')}.jsonl`), 'a', 0o600);
    try { await transcript.write(result.stdout); await transcript.sync(); } finally { await transcript.close(); }
    return { ok: ok && result.code === 0, code: result.code, text: resultText ?? text };
  }

  async #command(job: LaunchJob, agent: Agent, launch: Launch, signal?: AbortSignal, heavyHeld = false, prewrapped = false) {
    const d = this.#d;
    if (!this.#isolation) throw new IsolationUndecidedError();
    if (!this.#recovered || !d.ready()) throw new Error('Runner 정리가 끝나기 전에는 명령을 실행하지 않습니다.');
    const controller = new AbortController();
    this.#controllers.add(controller);
    const stopped = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let release: (() => void) | undefined, gate: (() => void) | null | undefined;
    let stopLease = () => Promise.resolve();
    let acquired = false, proof: Proof | null = null, launchId: string | undefined;
    const reservation: SessionState = { attemptId: `command:${job.id}`, agent, reserved: 1, observed: 0, state: 'ok' };
    try {
      this.#assertStart(agent, 1);
      this.#reservations.add(reservation);
      const renewed = await this.#call('renewJob', { epoch: job.epoch, params: { id: job.id }, idempotencyKey: randomUUID(), body: { fence: job.fence } }, stopped);
      stopLease = this.#holdLease(job, renewed.body.leaseUntil, controller);
      // runTaskCheck가 같은 번호표를 이미 받았으면 두 번 기다리지 않는다.
      if (!heavyHeld) release = await d.heavy.acquire(job.id, stopped);
      gate = d.updater?.tryClaim();
      if (d.updater && !gate) throw new Error('CLI 업데이트 중에는 명령을 시작하지 않습니다.');
      this.#assertStart(agent, 1, reservation);
      // ①·CI 명령은 격리 계층의 command(전용 계정이면 래퍼 ci-run)로 감싼다. fake 계층(시험)만 wrap으로 대신한다.
      const layer = await this.#currentIsolation();
      // 형식 수정 요청(followUp)은 buildLaunch가 이미 CLI 실행으로 감쌌다(래퍼 run). 다시 감싸지 않는다.
      const wrapped = prewrapped ? launch : layer.command ? layer.command(launch) : layer.wrap(launch, agent);
      // CI job(integrate·ci_retry)은 claim 때 이미 물리 슬롯을 예약한다(reserved). 그때는 다시 받지 않고 그 예약으로 /process를 보낸다.
      // 왜: 서버는 슬롯이 없는(none) 보유에만 acquire를 허락한다. 시도 job은 세션이 끝나 슬롯을 돌려준 뒤라 none이다.
      const current = (await this.#call('getExecutionHolds', { epoch: job.epoch }, stopped)).body.holds
        .find(h => h.job === job.id && h.epoch === job.epoch && h.fence === job.fence && h.host_id === d.identity.hostId && !h.closed_at);
      if (current?.slot_state !== 'reserved') {
        await this.#report('acquireJobSlots', { epoch: job.epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity.hostId } }, stopped);
      }
      acquired = true;
      const logs: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
      const sizes = { stdout: 0, stderr: 0 };
      // shortcut: 점검 명령처럼 출력마다 4 MiB만 보관한다. 원문 전체가 필요하면 파일 로그로 옮긴다.
      const capture = (stream: 'stdout' | 'stderr', bytes: Buffer) => {
        const kept = bytes.subarray(0, Math.max(0, 4 * 1024 * 1024 - sizes[stream]));
        if (kept.length) { logs[stream].push(kept); sizes[stream] += kept.length; }
      };
      const result = await runProcess({ launches: this.launches, job, launch: wrapped, signal: stopped,
        stdout: bytes => capture('stdout', bytes), stderr: bytes => capture('stderr', bytes), register: async record => {
        launchId = record.launchId;
        await this.#report('reportJobProcess', { epoch: job.epoch, params: { id: job.id }, body: { fence: job.fence, processGroup: record.pgid ?? 0, cgroup: record.cgroup } }, stopped);
        this.#assertStart(agent, 1, reservation);
      } });
      proof = result.proof;
      return { ...result, stdout: Buffer.concat(logs.stdout).toString('utf8'), stderr: Buffer.concat(logs.stderr).toString('utf8') };
    } finally {
      await stopLease();
      this.#controllers.delete(controller);
      if (acquired && !proof) {
        const records = await this.launches.list().catch(() => []);
        const record = launchId ? records.find(r => r.launchId === launchId && !r.completedAt) : records.findLast(r => r.job.id === job.id && r.job.epoch === job.epoch && r.job.fence === job.fence && !r.completedAt);
        if (record) {
          launchId = record.launchId;
          proof = await this.launches.reconcile({ job: job.id, ...d.identity, processGroup: record.pgid });
        }
      }
      if (!acquired || proof) {
        try {
          if (acquired && proof) {
            const serverProof = await this.#serverProof(job);
            await this.#report('releaseJobSlots', { epoch: job.epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity.hostId, proof: serverProof, at: new Date().toISOString() } });
            if (launchId) await this.launches.complete(launchId, proof);
          }
        } finally { this.#reservations.delete(reservation); release?.(); gate?.(); }
      } else reservation.state = 'unconfirmed';
    }
  }

  async #run(job: AttemptJob, options: AttemptOptions): Promise<AttemptOutput> {
    const epoch = this.#d.epoch();
    try { return await this.#execute(job, options); }
    catch (error) {
      if (error instanceof ResourceUnavailableError) await this.#returnUnstarted(job,epoch);
      else await this.#finishUnstarted(job, epoch);
      throw error;
    }
  }

  async #returnUnstarted(job: AttemptJob, epoch: number): Promise<void> {
    if (this.#d.epoch() !== epoch) return;
    const hold = (await this.#call('getExecutionHolds',{ epoch },AbortSignal.timeout(10_000))).body.holds.find(h => h.job === job.id && h.fence === job.fence && h.host_id === this.#d.identity.hostId && h.boot_id === this.#d.identity.bootId);
    if (!hold || hold.attempt !== null || hold.pgid !== null || hold.cgroup !== null || hold.closed_at !== null) return;
    await this.#report('returnJob',{ epoch,params:{ id:job.id },body:{ fence:job.fence,...this.#d.identity,reason:'resources' } });
    await this.#completeJob({ id:job.id,epoch,fence:job.fence });
  }

  /** start 앞의 어느 경계에서 거부되어도 프로세스 없는 예약을 남기지 않는다. */
  async #finishUnstarted(job: AttemptJob, epoch: number): Promise<void> {
    const d = this.#d;
    if (d.epoch() !== epoch) return;
    const hold = (await this.#call('getExecutionHolds', { epoch }, AbortSignal.timeout(10_000))).body.holds.find(h => h.job === job.id && h.epoch === epoch && h.fence === job.fence && h.host_id === d.identity.hostId && h.boot_id === d.identity.bootId);
    if (!hold || hold.closed_at !== null || hold.attempt !== null || hold.pgid !== null || hold.cgroup !== null) return;
    await this.#report('finishJob', { epoch, params: { id: job.id }, body: { fence: job.fence, status: 'failed' } });
    await this.#report('releaseJob', { epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity.hostId,
      proof: { kind: 'no_process', bootId: d.identity.bootId }, at: new Date().toISOString() } });
    await this.#completeJob({ id: job.id, epoch, fence: job.fence });
  }

  async #execute(job: AttemptJob, options: AttemptOptions): Promise<AttemptOutput> {
    const d = this.#d, epoch = d.epoch(), role = job.payload.kind === 'dev' || job.payload.kind === 'rework' ? 'dev' : 'qa';
    if (!d.ready()) throw new Error('Runner 정리가 끝나기 전에는 실행하지 않습니다.');
    if (!this.#isolation) throw new IsolationUndecidedError();
    if (!this.#recovered) throw new Error('launch 대조가 끝나기 전에는 실행하지 않습니다.');
    const slots = this.#attemptSlots(role), budget = slots - 1;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const jobRef: LaunchJob = { id: job.id, fence: job.fence, epoch };
    const stopLease = this.#holdLease(jobRef, job.leaseUntil, controller);
    this.#controllers.add(controller);
    let attemptId: string | undefined;
    let session: ActiveSession | undefined;
    let preparation: Awaited<ReturnType<Launches['create']>> | undefined;
    let physicalCleared = false;
    const reservation: SessionState = { attemptId: `job:${job.id}`, agent: job.payload.agent, reserved: slots, observed: 0, state: 'ok' };
    let grade: ApiResponse<'getRunGrade'>['body'] | undefined;
    try {
      this.#assertStart(job.payload.agent, slots);
      this.#reservations.add(reservation);
      preparation = await this.launches.create(jobRef);
      grade = (await this.#call('getRunGrade', { epoch, params: { taskKey: job.payload.taskKey }, query: { role } }, signal)).body;
      const work = await d.prepare(job);
      const resumeName = `${createHash('sha256').update(`${job.payload.taskKey}:${role}`).digest('hex')}.json`;
      const resumeDir = join(d.home, 'state', 'sessions');
      let previous: Resume | undefined;
      if (options.resume) {
        try { previous = JSON.parse(await readFile(join(resumeDir, resumeName), 'utf8')) as Resume; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('재개 기록을 확인할 수 없습니다.', { cause: e }); }
      }
      const resume = previous && previous.cwd === work.cwd && previous.agent === job.payload.agent && previous.model === grade.model && previous.effort === grade.effort ? previous.sessionId : undefined;
      const definitions = (await this.#call('getTaskSubagents', { epoch, params: { taskKey: job.payload.taskKey }, query: { role } }, signal)).body;
      const prompt = `${JSON.stringify(job.payload.instructions)}\n\n동시 하위 Agent 예산: ${budget}\n지정 하위 Agent: ${definitions.enabled ? definitions.items.map(i => i.key).join(', ') : '없음'}\n모델: ${grade.model}, Effort: ${grade.effort}\n입력 버전: ${job.payload.inputVersion}\n${options.prompt ?? ''}${work.notes ? `\n${work.notes}` : ''}`;
      const isolation = await this.#currentIsolation();
      const launch = buildLaunch(job.payload.agent, d.binaries[job.payload.agent], { ...grade, cwd: work.cwd, prompt, ...(resume && { resume }) }, { env: d.env, isolation });
      const installedSubagents = await installSubagents(work.cwd, job.payload.agent, definitions, grade, this.agentFiles);
      signal.throwIfAborted();
      this.#assertStart(job.payload.agent, slots, reservation);
      const start = await this.#report('startJob', { epoch, params: { id: job.id }, body: { fence: job.fence, ...d.identity, headSha: work.headSha, installedSubagents } }, signal);
      attemptId = start.body.attemptId;
      if (!attemptId) throw new Error('start 응답에 attemptId가 없습니다.');
      this.#running.set(attemptId, controller);
      await this.#report('reportAttemptStatus', { epoch, params: { attemptId }, body: { fence: job.fence, status: 'running', model: grade.model, effort: grade.effort, at: new Date().toISOString(), ...(grade.adjust && { adjust: grade.adjust }) } }, signal);
      await options.started?.(attemptId);
      const observer = new SubagentObserver(), usage = new SubagentUsage(), decoder = new JsonlDecoder(), parse = createParser(job.payload.agent);
      let reserved = 1 + budget, ok = false, text = '', sessionId: string | undefined;
      let resultEvent: Extract<CliEvent, { type: 'result' }> | undefined;
      const tokens = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      session = { attemptId, agent: job.payload.agent, observed: 0, reserved, state: 'ok', children: 1 };
      d.sessions.push(session);
      this.#reservations.delete(reservation);
      const active = session;
      const verified = d.verified?.(job.payload.agent, grade.model, sessionOptions(job.payload.agent, isolation, resume ? 'resume' : 'new')) ?? false;
      const apply = (records: ReturnType<JsonlDecoder['end']>) => {
        for (const record of records) for (const event of parse(record)) {
          observer.apply(event);
          usage.apply(event);
          if (event.type === 'result') { ok = event.ok; resultEvent = event; }
          if (event.type === 'session') sessionId = event.sessionId;
          if (event.type === 'message') text = event.text;
          if (event.type === 'usage') { tokens.inputTokens += event.inputTokens; tokens.cachedInputTokens += event.cachedInputTokens; tokens.outputTokens += event.outputTokens; }
        }
        const snapshot = observer.snapshot();
        reserved = sessionSlots(observer, { budget, verified, previousHeld: reserved - 1 });
        Object.assign(active, { observed: snapshot.observed, reserved, state: snapshot.state, children: 1 + snapshot.observed });
      };
      let streamEnded = false;
      const endStream = () => {
        if (streamEnded) return;
        streamEnded = true;
        apply(decoder.end()); observer.finish(); apply([]);
      };
      await mkdir(join(d.home, 'transcripts'), { recursive: true, mode: 0o700 });
      const transcript = await open(join(d.home, 'transcripts', `${createHash('sha256').update(attemptId).digest('hex')}.jsonl`), 'a', 0o600);
      let result, delivered = false;
      try {
        result = await runProcess({ launches: this.launches, job: jobRef, launch, signal, register: async record => {
          await this.#report('reportJobProcess', { epoch, params: { id: job.id }, body: { fence: job.fence, processGroup: record.pgid ?? 0, cgroup: record.cgroup } }, signal);
          this.#assertStart(job.payload.agent, active.reserved, active);
        }, stdout: async bytes => {
          await transcript.write(bytes);
          if (!delivered) { delivered = true; await options.delivered?.(); }
          apply(decoder.push(bytes));
        }, stdoutEnd: endStream });
        await transcript.sync();
      } finally { await transcript.close(); }
      endStream();
      physicalCleared = true;
      if (sessionId) {
        await mkdir(resumeDir, { recursive: true, mode: 0o700 });
        await atomicWrite(resumeDir, resumeName, JSON.stringify({ cwd: work.cwd, agent: job.payload.agent, model: grade.model, effort: grade.effort, sessionId }));
      }
      await this.#report('releaseJobSlots', { epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity.hostId, proof: result.proof, at: new Date().toISOString() } });
      await this.launches.complete(result.launchId, result.proof);
      await this.launches.complete(preparation.launchId, { kind: 'no_process', bootId: d.identity.bootId });
      d.sessions.splice(d.sessions.indexOf(session), 1);
      session = undefined;
      if (definitions.enabled) {
        try { await installSubagents(work.cwd, job.payload.agent, { enabled: false, items: [] }, grade, this.agentFiles); }
        catch (error) { throw new Error('실행을 마친 하위 Agent 정의의 소유 hash를 확인할 수 없습니다.', { cause: error }); }
      }
      // 실제 사용 보고(UAT-TASK-10 「실제」 태그). 출력 스트림에서 본 이름·횟수만 보낸다(SubagentUsage).
      // shortcut: CLI 세션 기록 형식이 검증되기 전에는 「세션 기록 확인(confirmed)」으로 확정하지 않는다. 항상 partial(일부 관측).
      await d.outbox.enqueue('reportSubagentUsage', { epoch, params: { attemptId }, body: { fence: job.fence, confirm: 'partial', items: usage.items(definitions.enabled ? definitions.items : []) } });
      if (signal.aborted || !ok || result.code !== 0) {
        if (signal.aborted) await this.#report('interruptAttempt', { epoch, params: { attemptId }, body: { fence: job.fence, reason: 'error', at: new Date().toISOString() } });
        else await this.#report('reportAttemptStatus', { epoch, params: { attemptId }, body: { fence: job.fence, status: 'failed', model: grade.model, effort: grade.effort, at: new Date().toISOString() } });
        await this.#report('releaseJob', { epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity.hostId, proof: result.proof, at: new Date().toISOString() } });
      }
      const output = { ...result, attemptId, ...work, ok: ok && result.code === 0 && !signal.aborted, text: resultEvent?.text ?? text, observation: observer.snapshot(), reserved, resultEvent, tokens,
        ...(sessionId && { sessionId }), grade: { model: grade.model, effort: grade.effort } };
      if (output.ok) await options.complete?.(output, signal);
      return output;
    } catch (error) {
      if (error instanceof SubagentInstallError || (error instanceof ApiError && error.error?.code === 'SUBAGENT_INSTALL_FAILED')) {
        await this.#report('finishJob', { epoch, params: { id: job.id }, body: { fence: job.fence, status: 'failed', error: { code: 'SUBAGENT_INSTALL_FAILED', message: '하위 Agent 설치를 확인하지 못했습니다.' } } });
        const proof = await this.launches.reconcile({ job: job.id, ...d.identity, processGroup: null });
        if (proof) {
          await this.#report('releaseJob', { epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity.hostId, proof, at: new Date().toISOString() } });
          await this.#completeJob(jobRef);
        }
      } else if (attemptId) {
        await this.#report('interruptAttempt', { epoch, params: { attemptId }, body: { fence: job.fence, reason: 'error', at: new Date().toISOString() } });
        const holds = (await this.#call('getExecutionHolds', { epoch })).body.holds;
        const hold = holds.find(h => h.job === job.id);
        if (hold) {
          const proof = await this.launches.reconcile({ job: job.id, ...d.identity, processGroup: hold.pgid, cgroup: hold.cgroup });
          if (proof) {
            await this.#report('releaseJob', { epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity.hostId, proof, at: new Date().toISOString() } });
            await this.#completeJob(jobRef);
            physicalCleared = true;
          }
        }
      }
      throw error;
    } finally {
      await stopLease();
      this.#controllers.delete(controller);
      this.#reservations.delete(reservation);
      if (attemptId) this.#running.delete(attemptId);
      if (session) {
        const proof = physicalCleared || await this.launches.list().then(records => this.launches.reconcile({ job: job.id, ...d.identity, processGroup: records.findLast(r => r.job.id === job.id)?.pgid ?? null }), () => null);
        if (proof) d.sessions.splice(d.sessions.indexOf(session), 1);
        else session.state = 'unconfirmed';
      }
      await d.updater?.applyPending();
    }
  }

  /** 로컬 종료를 확인한 뒤 서버 장부에 맞는 증거를 고른다. */
  async #serverProof(job: LaunchJob): Promise<Proof> {
    const d = this.#d;
    const holds = (await this.#call('getExecutionHolds', { epoch: job.epoch }, AbortSignal.timeout(10000))).body.holds;
    const hold = holds.find(h => h.job === job.id && h.epoch === job.epoch && h.fence === job.fence && h.host_id === d.identity.hostId && h.boot_id === d.identity.bootId);
    if (!hold) throw new Error('현재 서버 보유의 종료 증명을 확인할 수 없습니다.');
    // 서버가 기록한 cgroup이 있으면 cgroup_empty, 없으면 group_empty를 낸다(조정자 결정 3). 기록과 다르면 증거를 내지 않는다.
    const serverProof = await this.launches.reconcile({ job: job.id, hostId: d.identity.hostId, bootId: d.identity.bootId, processGroup: hold.pgid, cgroup: hold.cgroup });
    if (!serverProof) throw new Error('서버가 기록한 프로세스의 종료를 확인할 수 없습니다.');
    return serverProof;
  }

  #admission(agent: Agent, slots: number, own?: SessionState) {
    const local = [...this.#d.sessions, ...this.#reservations].filter(s => s !== own);
    return this.#d.canStart(agent, slots, local);
  }

  #attemptSlots(role: 'dev' | 'qa'): number {
    const budget = this.#d.budget(role);
    if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError('하위 Agent 예산이 올바르지 않습니다.');
    return 1 + budget;
  }

  /** claim한 job의 자원 확인. 실패하면 임대 안에서 정해진 시간만큼 기다리며 다시 확인한다(단조 시계). */
  async #awaitStart(job: AttemptJob, slots: number): Promise<void> {
    const epoch = this.#d.epoch();
    const leaseLeft = Date.parse(job.leaseUntil) - LEASE_SAFETY_MS - Date.now() - 10_000;
    const deadline = performance.now() + Math.max(0, Math.min(this.#d.admissionWaitMs ?? 20_000, leaseLeft));
    for (;;) {
      try { this.#assertStart(job.payload.agent, slots); return; }
      catch (error) {
        if (performance.now() >= deadline || this.#d.epoch() !== epoch) throw error;
        await sleep(250);
      }
    }
  }

  #assertStart(agent: Agent, slots: number, own?: SessionState): void {
    const result = this.#admission(agent, slots, own);
    if (!result.ok) throw new ResourceUnavailableError(`새 실행을 보류합니다: ${result.reason}`);
  }

  /** job 전체 해제를 서버가 확인한 뒤 남은 준비·명령 기록을 완료한다. */
  async #completeJob(job: LaunchJob): Promise<void> {
    for (const record of await this.launches.list()) {
      if (record.job.id !== job.id || record.job.fence !== job.fence || record.job.epoch !== job.epoch || record.completedAt) continue;
      await this.launches.complete(record.launchId, record.pgid === null ? { kind: 'no_process', bootId: record.bootId }
        : record.cgroup !== null ? { kind: 'cgroup_empty', bootId: record.bootId, processGroup: record.pgid, cgroup: record.cgroup }
          : { kind: 'group_empty', bootId: record.bootId, processGroup: record.pgid });
    }
  }

  /** 전송 전에 outbox에 저장한다. 응답을 잃어도 같은 키·본문으로 재시도한다. */
  async #report<K extends ReportId>(operation: K, request: Omit<ApiRequest<K>, 'idempotencyKey'>, signal = AbortSignal.timeout(10000)): Promise<ApiResponse<K>> {
    const queued = await this.#d.outbox.enqueue(operation, request);
    return this.#call(operation, { ...request, idempotencyKey: queued.request.idempotencyKey } as ApiRequest<K>, signal);
  }

  #holdLease(job: LaunchJob, until: string, execution: AbortController): () => Promise<void> {
    const initial = Date.parse(until) - LEASE_SAFETY_MS;
    if (!Number.isFinite(initial) || initial <= Date.now()) throw new Error('임대가 끝났거나 곧 끝나는 job은 시작하지 않습니다.');
    const stop = new AbortController();
    let timer = setTimeout(() => execution.abort(), initial - Date.now());
    const renewing = this.#renew(job, stop.signal, execution, next => {
      const deadline = Date.parse(next) - LEASE_SAFETY_MS;
      clearTimeout(timer);
      if (!Number.isFinite(deadline) || deadline <= Date.now()) { execution.abort(); return; }
      timer = setTimeout(() => execution.abort(), deadline - Date.now());
    });
    return async () => { clearTimeout(timer); stop.abort(); await renewing; };
  }

  async #renew(job: LaunchJob, stop: AbortSignal, execution: AbortController, extend: (until: string) => void): Promise<void> {
    while (!stop.aborted) {
      try {
        await sleep(20000, undefined, { signal: stop });
        const renewed = await this.#call('renewJob', { epoch: job.epoch, idempotencyKey: randomUUID(), params: { id: job.id }, body: { fence: job.fence } }, AbortSignal.any([stop, execution.signal]));
        extend(renewed.body.leaseUntil);
      } catch { if (!stop.aborted) { execution.abort(); return; } }
    }
  }

  async #call<K extends OperationId>(operation: K, request: ApiRequest<K>, signal?: AbortSignal): Promise<ApiResponse<K>> {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try { return await this.#d.api(operation, request); }
      catch (e) { if (!retryable(e)) throw e; await sleep((this.#d.retryDelay ?? retryDelay)(attempt, e, Date.now(), Math.random()), undefined, { ...(signal && { signal }) }); }
    }
  }
}
