import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, type ApiClient, type ApiRequest, type ApiResponse } from '../api/client.ts';
import type { ClaimedJob } from '../api/generated/client.ts';
import { authenticationFailed, retryable, type Outbox } from '../api/outbox.ts';
import { LEASE_SAFETY_MS } from '../exec/session.ts';
import type { PlanningOutcome } from '../planning/index.ts';
import { GitPushAbortedError, GitPushUnknownError } from '../git/repository.ts';
import { createRedactor } from '../security/redact.ts';
import { atomicWrite } from '../state/files.ts';
import type { Entry, ReportId } from '../state/state.ts';

export const CHECK_KINDS = ['repo_check', 'github_check'] as const;
export const EXTRA_KINDS = ['deploy_check', 'design_apply', 'merge_followup'] as const;
interface Event { operation: ReportId; request: Entry['request'] }
interface Saved { version: 1; epoch: number; identity?: { hostId: string; bootId: string }; job: ClaimedJob; events: Record<string, Event>; outputs?: Record<string, unknown>; outcome?: PlanningOutcome }
export interface QueuedOptions {
  home: string; api: ApiClient; outbox: Outbox; runnerId: string;
  identity: () => { hostId: string; bootId: string }; epoch: () => number; ready: () => boolean;
  kinds: () => Promise<ClaimedJob['kind'][]>;
  warn?: (message: string) => void;
  execute: (job: ClaimedJob, signal: AbortSignal, report: QueuedJobs['report'], remember: QueuedJobs['remember']) => Promise<PlanningOutcome>;
}

/** 시도·통합 외 job의 한 수신 창구. 전송 키와 결과를 먼저 저장해 재시작도 같은 보고를 재생한다. */
export class QueuedJobs {
  #active: Promise<unknown> | undefined;
  #controller: AbortController | undefined;
  #saved: Saved | undefined;
  readonly directory: string;
  readonly options: QueuedOptions;
  constructor(options: QueuedOptions) { this.options = options; this.directory = join(options.home, 'state', 'queued-jobs'); }

  runNext(capacity: number, signal?: AbortSignal): Promise<void> {
    if (this.#active || !this.options.ready() || capacity <= 0) return Promise.resolve();
    const task = this.#next(capacity, signal);
    this.#active = task;
    void task.finally(() => { this.#active = undefined; }).catch(() => undefined);
    return task;
  }
  async #save() { await atomicWrite(this.directory, 'job.json', JSON.stringify(this.#saved ?? null)); }

  async remember<T>(label: string, build: () => Promise<T>): Promise<T> {
    const saved = this.#saved;
    if (!saved) throw new Error('수신 작업 기록이 없습니다.');
    saved.outputs ??= {};
    if (!(label in saved.outputs)) { saved.outputs[label] = await build(); await this.#save(); }
    return saved.outputs[label] as T;
  }

  async report<K extends ReportId>(label: string, operation: K, request: Omit<ApiRequest<K>, 'idempotencyKey'>): Promise<ApiResponse<K>> {
    const saved = this.#saved;
    if (!saved) throw new Error('수신 작업 기록이 없습니다.');
    let event = saved.events[label];
    if (!event) {
      event = { operation, request: JSON.parse(JSON.stringify({ ...request, idempotencyKey: `${operation}:${this.options.runnerId}:${randomUUID()}` })) as Entry['request'] };
      saved.events[label] = event; await this.#save();
    }
    if (event.operation !== operation || JSON.stringify({ ...event.request, idempotencyKey: undefined }) !== JSON.stringify({ ...request, idempotencyKey: undefined })) throw new Error('저장된 작업 보고가 현재 요청과 다릅니다. 원본을 보존하세요.');
    await this.options.outbox.enqueue(operation, event.request as ApiRequest<K>);
    const response = await this.options.api(operation, event.request as ApiRequest<K>);
    await this.options.outbox.flush();
    return response;
  }

  async #next(capacity: number, outer?: AbortSignal): Promise<void> {
    const d = this.options;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(join(this.directory, 'job.json'), 'utf8')) as Saved | null;
      if (saved && (saved.version !== 1 || !saved.job || !saved.events || !Number.isSafeInteger(saved.epoch))) throw new Error('수신 작업 기록이 손상되었습니다. 원본을 보존하세요.');
      this.#saved = saved ?? undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.#saved && this.#saved.epoch !== d.epoch()) { this.#saved = undefined; await this.#save(); }
    if (!this.#saved) {
      const kinds = await d.kinds();
      if (!kinds.length) return;
      const claim = await d.api('claimJob', { epoch: d.epoch(), idempotencyKey: randomUUID(), body: { kinds, capacity } });
      if (claim.status === 204) return;
      if (!kinds.includes(claim.body.job.kind)) throw new Error('요청하지 않은 종류의 job을 받았습니다.');
      this.#saved = { version: 1, epoch: d.epoch(), identity: { ...d.identity() }, job: claim.body.job, events: {} }; await this.#save();
    }
    const saved = this.#saved, job = saved.job, epoch = saved.epoch;
    const started = saved.identity ?? saved.events.start?.request.body;
    if (started && (started.hostId !== d.identity().hostId || started.bootId !== d.identity().bootId)) {
      // 새 부팅은 옛 프로세스의 종료만 증명한다. 원격 효과는 모른다. 임대를 늘리지 않고 서버 만료·reconcile에 맡긴다.
      if (started.hostId !== d.identity().hostId) throw new Error('다른 host의 작업 기록입니다. 임대를 갱신하지 않고 원본을 보존합니다.');
      const holds = (await d.api('getExecutionHolds', { epoch })).body.holds;
      for (const hold of holds.filter(h => h.job === job.id && h.fence === job.fence && h.host_id === started.hostId && h.boot_id === started.bootId && !h.closed_at)) {
        await this.report('reboot-release', 'releaseJob', { epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity().hostId,
          proof: { kind: 'boot_changed', bootId: String(started.bootId), currentBootId: d.identity().bootId, processGroup: hold.pgid },
          at: String(saved.events['reboot-release']?.request.body?.at ?? new Date().toISOString()) } });
      }
      d.warn?.(`재부팅 복구: ${job.id}의 옛 부팅 종료를 확인했습니다. 임대 갱신을 멈추고 서버의 만료·reconcile 결과 대조를 기다립니다.`);
      this.#saved = undefined; await this.#save(); return;
    }
    const at = (label: string) => {
      const stored = saved.events[label]?.request.body?.at;
      return typeof stored === 'string' ? stored : new Date().toISOString();
    };
    this.#controller = new AbortController();
    const signal = outer ? AbortSignal.any([outer, this.#controller.signal]) : this.#controller.signal;
    let deadline: ReturnType<typeof setTimeout> | undefined, renewing: Promise<unknown> | undefined;
    const extend = (until: string) => {
      clearTimeout(deadline);
      const left = Date.parse(until) - Date.now() - LEASE_SAFETY_MS;
      if (!Number.isFinite(left) || left <= 0) throw new Error('임대가 곧 끝나는 작업은 시작하지 않습니다.');
      deadline = setTimeout(() => this.#controller?.abort(new Error('LEASE_LOST')), left);
    };
    const timer = setInterval(() => {
      if (renewing || saved.outcome || signal.aborted) return;
      renewing = d.api('renewJob', { epoch, params: { id: job.id }, idempotencyKey: randomUUID(), body: { fence: job.fence } })
        .then(response => { extend(response.body.leaseUntil); }).catch(error => { this.#controller?.abort(error); }).finally(() => { renewing = undefined; });
    }, 15_000);
    timer.unref();
    try {
      if (!saved.outcome) {
        signal.throwIfAborted();
        extend((await d.api('renewJob', { epoch, params: { id: job.id }, idempotencyKey: randomUUID(), body: { fence: job.fence } })).body.leaseUntil);
        await this.report('start', 'startJob', { epoch, params: { id: job.id }, body: { fence: job.fence, ...d.identity(), installedSubagents: [], ...(job.kind === 'deploy_check' && { headSha: job.payload.commit }) } });
        if (!CHECK_KINDS.includes(job.kind as typeof CHECK_KINDS[number])) await this.report('initial-slots', 'releaseJobSlots', { epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity().hostId, proof: { kind: 'no_process', bootId: d.identity().bootId }, at: at('initial-slots') } });
        try { saved.outcome = await d.execute(job, signal, this.report.bind(this), this.remember.bind(this)); signal.throwIfAborted(); }
        catch (error) {
          if (signal.aborted || retryable(error) || error instanceof GitPushUnknownError || error instanceof GitPushAbortedError || authenticationFailed(error) || error instanceof ApiError && ['LEASE_LOST', 'EPOCH_MISMATCH', 'EXTERNAL_WRITE_BLOCKED'].includes(error.error?.code ?? '')) throw error;
          saved.outcome = { status: 'failed', error: { code: 'RUNNER_JOB_FAILED', message: createRedactor()(error instanceof Error ? error.message : String(error)).slice(0, 300) } };
        }
        await this.#save();
      }
      const outcome = saved.outcome;
      if (outcome?.status === 'lost') {
        this.#saved = undefined; await this.#save();
        if (outcome.code === 'AUTHENTICATION_FAILED') throw new ApiError('renewJob', 401, undefined, null);
        return;
      }
      if (!outcome) throw new Error('작업 결과를 확인하지 못했습니다.');
      // github_check 결과 보고는 서버가 job도 닫는다(project/github.ts). 같은 job에 finish를 덧붙이지 않는다.
      if (job.kind !== 'github_check') await this.report('finish', 'finishJob', { epoch, params: { id: job.id }, body: { fence: job.fence, ...outcome } });
      if (!CHECK_KINDS.includes(job.kind as typeof CHECK_KINDS[number])) {
        const hold = (await d.api('getExecutionHolds', { epoch })).body.holds.find(h => h.job === job.id && h.fence === job.fence && !h.closed_at);
        if (hold) {
          if (hold.slot_state !== 'none' || hold.host_id !== d.identity().hostId || hold.boot_id !== d.identity().bootId) throw new Error('작업 프로세스의 종료를 확인하지 못했습니다. 기록을 보존합니다.');
          await this.report('release', 'releaseJob', { epoch, params: { id: job.id }, body: { fence: job.fence, hostId: d.identity().hostId,
            proof: hold.pgid === null ? { kind: 'no_process', bootId: d.identity().bootId } : hold.cgroup ? { kind: 'cgroup_empty', bootId: d.identity().bootId, processGroup: hold.pgid, cgroup: hold.cgroup } : { kind: 'group_empty', bootId: d.identity().bootId, processGroup: hold.pgid }, at: at('release') } });
        }
      }
      this.#saved = undefined; await this.#save();
    } catch (error) {
      if (error instanceof ApiError && ['LEASE_LOST', 'EPOCH_MISMATCH'].includes(error.error?.code ?? '')) { this.#saved = undefined; await this.#save(); return; }
      throw error;
    } finally { clearInterval(timer); clearTimeout(deadline); await renewing; this.#controller = undefined; }
  }
  async shutdown(): Promise<void> { this.#controller?.abort(); await this.#active?.catch(() => undefined); }
}
