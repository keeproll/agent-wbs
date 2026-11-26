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
import { JsonlDecoder } from '../cli/stream.ts';
import type { IsolationLayer, Launch } from '../cli/isolation.ts';
import { IsolationUndecidedError } from '../cli/isolation.ts';
import type { SessionState } from '../resources/reporter.ts';
import type { HeavySemaphore } from '../resources/heavy.ts';
import { atomicWrite } from '../state/files.ts';
import type { ReportId } from '../state/state.ts';
import { installSubagents, SubagentInstallError } from './install.ts';
import { Launches, type LaunchJob } from './launches.ts';
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
  /** M4 git 계층이 만든 작업 폴더와 그 HEAD. */
  prepare: (job: AttemptJob) => Promise<{ cwd: string; headSha: string }>;
  budget: (role: 'dev' | 'qa') => number;
  sessions: ActiveSession[];
  heavy: HeavySemaphore;
  isolation?: IsolationLayer;
  verified?: (agent: Agent, model: string, options: string) => boolean;
  updater?: { tryClaim(): (() => void) | null; applyPending(): Promise<unknown> };
}
interface Resume { cwd: string; agent: Agent; model: string; effort: string; sessionId: string }

/** 서버 등급과 fence(낡은 Runner를 막는 번호표)를 그대로 사용한다. */
export class Execution {
  readonly launches: Launches;
  readonly #d: ExecutionOptions;
  readonly #running = new Map<string, AbortController>();
  readonly #controllers = new Set<AbortController>();
  readonly #tasks = new Set<Promise<unknown>>();
  readonly #jobs = new Set<string>();
  #recovered = false;
  constructor(options: ExecutionOptions) { this.#d = options; this.launches = new Launches(options.home, options.identity); }

  /** 서버 보유 대조가 끝나기 전에는 새 claim을 허용하지 않는다. */
  async recover(holds?: ExecutionHold[], signal?: AbortSignal): Promise<boolean> {
    this.#recovered = false;
    signal?.throwIfAborted();
    const remote = holds ?? (await this.#call('getExecutionHolds', { epoch: this.#d.epoch() }, signal)).body.holds;
    for (const hold of remote) {
      signal?.throwIfAborted();
      if (hold.host_id !== this.#d.identity.hostId) continue;
      if (hold.boot_id === null || hold.fence === null) return false;
      const proof = hold.slot_state === 'none' && hold.pgid === null
        ? { kind: 'no_process' as const, bootId: hold.boot_id }
        : await this.launches.reconcile({ job: hold.job, hostId: hold.host_id, bootId: hold.boot_id, processGroup: hold.pgid });
      if (!proof) return false;
      if (hold.attempt !== null) {
        try { await this.#report('interruptAttempt', { epoch: hold.epoch, params: { attemptId: hold.attempt }, body: { fence: hold.fence, reason: 'reboot', at: new Date().toISOString() } }, signal); }
        catch (e) { if (!(e instanceof ApiError) || !['ATTEMPT_CLOSED', 'LEASE_LOST'].includes(e.error?.code ?? '')) throw e; }
      }
      const request = { epoch: hold.epoch, params: { id: hold.job }, body: { fence: hold.fence, hostId: hold.host_id, proof, at: new Date().toISOString() } };
      const queued = await this.#d.outbox.enqueue('releaseJob', request);
      await this.#call('releaseJob', { ...request, idempotencyKey: queued.request.idempotencyKey }, signal);
    }
    for (const r of await this.launches.list()) {
      signal?.throwIfAborted();
      if (r.hostId === this.#d.identity.hostId && !await this.launches.reconcile({ job: r.job.id, hostId: r.hostId, bootId: r.bootId, processGroup: r.pgid })) return false;
    }
    await this.#d.outbox.flush();
    this.#recovered = true;
    return true;
  }

  async claim(capacity: number): Promise<ClaimedJob | null> {
    if (!this.#d.isolation || !this.#recovered || !this.#d.ready()) return null;
    const blocked = this.#d.sessions.some(s => s.state === 'unconfirmed');
    const release = this.#d.updater?.tryClaim();
    if (this.#d.updater && !release) return null;
    try {
      const result = await this.#call('claimJob', { epoch: this.#d.epoch(), idempotencyKey: randomUUID(), body: { kinds: blocked ? ['stop_attempt'] : ['attempt', 'stop_attempt'], capacity: blocked ? 0 : capacity } });
      return result.status === 200 ? result.body.job : null;
    } finally { release?.(); }
  }

  stop(attemptId: string): boolean {
    const controller = this.#running.get(attemptId);
    controller?.abort();
    return controller !== undefined;
  }

  run(job: AttemptJob, options: { resume?: boolean; signal?: AbortSignal } = {}) {
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
  command(job: LaunchJob, agent: Agent, launch: Launch, signal?: AbortSignal) {
    const task = this.#command(job, agent, launch, signal);
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task)).catch(() => undefined);
    return task;
  }

  async #command(job: LaunchJob, agent: Agent, launch: Launch, signal?: AbortSignal) {
    const d = this.#d;
    if (!d.isolation) throw new IsolationUndecidedError();
    if (!this.#recovered || !d.ready()) throw new Error('Runner 정리가 끝나기 전에는 명령을 실행하지 않습니다.');
    const controller = new AbortController();
    this.#controllers.add(controller);
    const stopped = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let release: (() => void) | undefined, gate: (() => void) | null | undefined;
    let stopLease = () => Promise.resolve();
    let empty = true;
    try {
      const renewed = await this.#call('renewJob', { epoch: job.epoch, params: { id: job.id }, idempotencyKey: randomUUID(), body: { fence: job.fence } }, stopped);
      stopLease = this.#holdLease(job, renewed.body.leaseUntil, controller);
      release = await d.heavy.acquire(job.id, stopped);
      gate = d.updater?.tryClaim();
      if (d.updater && !gate) throw new Error('CLI 업데이트 중에는 명령을 시작하지 않습니다.');
      const wrapped = d.isolation.wrap(launch, agent);
      await this.#report('acquireJobSlots', { epoch: job.epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity.hostId } }, stopped);
      empty = false;
      const result = await runProcess({ launches: this.launches, job, launch: wrapped, signal: stopped, register: async record => {
        await this.#report('reportJobProcess', { epoch: job.epoch, params: { id: job.id }, body: { fence: job.fence, processGroup: record.pgid ?? 0, cgroup: record.cgroup } }, stopped);
      } });
      empty = true;
      await this.#report('releaseJobSlots', { epoch: job.epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity.hostId, proof: result.proof, at: new Date().toISOString() } });
      return result;
    } finally {
      await stopLease();
      this.#controllers.delete(controller);
      if (!empty) {
        const records = await this.launches.list().catch(() => []);
        empty = await this.launches.reconcile({ job: job.id, ...d.identity, processGroup: records.findLast(r => r.job.id === job.id)?.pgid ?? null }) !== null;
      }
      if (empty) { release?.(); gate?.(); }
    }
  }

  async #run(job: AttemptJob, options: { resume?: boolean; signal?: AbortSignal }) {
    const d = this.#d, epoch = d.epoch(), role = job.payload.kind === 'dev' || job.payload.kind === 'rework' ? 'dev' : 'qa';
    if (!d.ready()) throw new Error('Runner 정리가 끝나기 전에는 실행하지 않습니다.');
    if (!d.isolation) throw new IsolationUndecidedError();
    if (!this.#recovered) throw new Error('launch 대조가 끝나기 전에는 실행하지 않습니다.');
    const budget = d.budget(role);
    if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError('하위 Agent 예산이 올바르지 않습니다.');
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const jobRef: LaunchJob = { id: job.id, fence: job.fence, epoch };
    const stopLease = this.#holdLease(jobRef, job.leaseUntil, controller);
    this.#controllers.add(controller);
    let attemptId: string | undefined;
    let session: ActiveSession | undefined;
    let grade: ApiResponse<'getRunGrade'>['body'] | undefined;
    try {
      await this.launches.create(jobRef);
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
      const prompt = `${JSON.stringify(job.payload.instructions)}\n\n동시 하위 Agent 예산: ${budget}\n지정 하위 Agent: ${definitions.enabled ? definitions.items.map(i => i.key).join(', ') : '없음'}\n모델: ${grade.model}, Effort: ${grade.effort}\n입력 버전: ${job.payload.inputVersion}`;
      const launch = buildLaunch(job.payload.agent, d.binaries[job.payload.agent], { ...grade, cwd: work.cwd, prompt, ...(resume && { resume }) }, { env: d.env, ...(d.isolation && { isolation: d.isolation }) });
      const installedSubagents = await installSubagents(work.cwd, job.payload.agent, definitions, grade);
      signal.throwIfAborted();
      const start = await this.#report('startJob', { epoch, params: { id: job.id }, body: { fence: job.fence, ...d.identity, headSha: work.headSha, installedSubagents } }, signal);
      attemptId = start.body.attemptId;
      if (!attemptId) throw new Error('start 응답에 attemptId가 없습니다.');
      this.#running.set(attemptId, controller);
      const observer = new SubagentObserver(), decoder = new JsonlDecoder(), parse = createParser(job.payload.agent);
      let reserved = 1 + budget, ok = false, sessionId: string | undefined;
      let resultEvent: Extract<CliEvent, { type: 'result' }> | undefined;
      const tokens = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      session = { attemptId, agent: job.payload.agent, observed: 0, reserved, state: 'ok', children: 1 };
      d.sessions.push(session);
      const active = session;
      const verified = d.isolation ? d.verified?.(job.payload.agent, grade.model, sessionOptions(job.payload.agent, d.isolation, resume ? 'resume' : 'new')) ?? false : false;
      const apply = (records: ReturnType<JsonlDecoder['end']>) => {
        for (const record of records) for (const event of parse(record)) {
          observer.apply(event);
          if (event.type === 'result') { ok = event.ok; resultEvent = event; }
          if (event.type === 'session') sessionId = event.sessionId;
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
      let result;
      try {
        result = await runProcess({ launches: this.launches, job: jobRef, launch, signal, register: async record => {
          await this.#report('reportJobProcess', { epoch, params: { id: job.id }, body: { fence: job.fence, processGroup: record.pgid ?? 0, cgroup: record.cgroup } }, signal);
        }, stdout: async bytes => {
          await transcript.write(bytes);
          apply(decoder.push(bytes));
        }, stdoutEnd: endStream });
        await transcript.sync();
      } finally { await transcript.close(); }
      endStream();
      if (sessionId) {
        await mkdir(resumeDir, { recursive: true, mode: 0o700 });
        await atomicWrite(resumeDir, resumeName, JSON.stringify({ cwd: work.cwd, agent: job.payload.agent, model: grade.model, effort: grade.effort, sessionId }));
      }
      await this.#report('releaseJobSlots', { epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity.hostId, proof: result.proof, at: new Date().toISOString() } });
      // shortcut: CLI 기록 형식이 검증되기 전에는 실제 사용을 확정하지 않는다. M5-03 실증 뒤 기록 해석기를 연결한다.
      await d.outbox.enqueue('reportSubagentUsage', { epoch, params: { attemptId }, body: { fence: job.fence, confirm: 'partial', items: [] } });
      if (signal.aborted || !ok || result.code !== 0) {
        if (signal.aborted) await this.#report('interruptAttempt', { epoch, params: { attemptId }, body: { fence: job.fence, reason: 'error', at: new Date().toISOString() } });
        else await this.#report('reportAttemptStatus', { epoch, params: { attemptId }, body: { fence: job.fence, status: 'failed', model: grade.model, effort: grade.effort, at: new Date().toISOString() } });
        await this.#report('releaseJob', { epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity.hostId, proof: result.proof, at: new Date().toISOString() } });
      }
      return { ...result, attemptId, ...work, ok: ok && result.code === 0 && !signal.aborted, observation: observer.snapshot(), reserved, resultEvent, tokens };
    } catch (error) {
      if (error instanceof SubagentInstallError || (error instanceof ApiError && error.error?.code === 'SUBAGENT_INSTALL_FAILED')) {
        await this.#report('finishJob', { epoch, params: { id: job.id }, body: { fence: job.fence, status: 'failed', error: { code: 'SUBAGENT_INSTALL_FAILED', message: '하위 Agent 설치를 확인하지 못했습니다.' } } });
        const proof = await this.launches.reconcile({ job: job.id, ...d.identity, processGroup: null });
        if (proof) await this.#report('releaseJob', { epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity.hostId, proof, at: new Date().toISOString() } });
      } else if (attemptId && grade && !signal.aborted) {
        await d.outbox.enqueue('reportAttemptStatus', { epoch, params: { attemptId }, body: { fence: job.fence, status: 'failed', model: grade.model, effort: grade.effort, at: new Date().toISOString() } });
      }
      throw error;
    } finally {
      await stopLease();
      this.#controllers.delete(controller);
      if (attemptId) this.#running.delete(attemptId);
      if (session) {
        const proof = await this.launches.list().then(records => this.launches.reconcile({ job: job.id, ...d.identity, processGroup: records.findLast(r => r.job.id === job.id)?.pgid ?? null }), () => null);
        if (proof) d.sessions.splice(d.sessions.indexOf(session), 1);
        else session.state = 'unconfirmed';
      }
      await d.updater?.applyPending();
    }
  }

  /** 전송 전에 outbox에 저장한다. 응답을 잃어도 같은 키·본문으로 재시도한다. */
  async #report<K extends ReportId>(operation: K, request: Omit<ApiRequest<K>, 'idempotencyKey'>, signal = AbortSignal.timeout(10000)): Promise<ApiResponse<K>> {
    const queued = await this.#d.outbox.enqueue(operation, request);
    return this.#call(operation, { ...request, idempotencyKey: queued.request.idempotencyKey } as ApiRequest<K>, signal);
  }

  #holdLease(job: LaunchJob, until: string, execution: AbortController): () => Promise<void> {
    const initial = Date.parse(until);
    if (!Number.isFinite(initial) || initial <= Date.now()) throw new Error('임대가 끝난 job은 시작하지 않습니다.');
    const stop = new AbortController();
    let timer = setTimeout(() => execution.abort(), initial - Date.now());
    const renewing = this.#renew(job, stop.signal, execution, next => {
      const deadline = Date.parse(next);
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
      catch (e) { if (!retryable(e)) throw e; await sleep(retryDelay(attempt, e, Date.now(), Math.random()), undefined, { ...(signal && { signal }) }); }
    }
  }
}
