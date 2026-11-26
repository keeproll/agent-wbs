import { randomUUID } from 'node:crypto';
import { ApiError, type ApiClient } from '../api/client.ts';
import type { Agent } from '../api/generated/client.ts';
import { blockedAgents, type ReadinessReport } from '../readiness/checks.ts';
import { AdaptiveLimiter, admit, type AdmitResult, type Caps, type LimitAdjust } from './concurrency.ts';
import type { HeavySemaphore } from './heavy.ts';
import type { HostReport } from './host.ts';
import type { ModelsReport } from './models.ts';
import type { UsageTracker } from './usage.ts';

/** G §6.6 「메모리 예비 — 팀장 지정(기본 4GB)」. 서버 값을 받기 전까지만 쓴다. */
const DEFAULT_MEM_RESERVE_GB = 4;

/** 실행 중 세션 하나의 보유 상태. reserved는 `reservedSlots`로 계산한 값(세션 자신 포함). */
export interface SessionState {
  attemptId: string;
  agent: Agent;
  observed: number;
  reserved: number;
  state: 'ok' | 'unconfirmed';
}

export interface ResourceSnapshot {
  cpuPct: number;
  memFreeGB: number;
  swapUsedGB: number;
}

export interface ResourceReporterDeps {
  api: ApiClient;
  /** 현재 프로젝트 epoch(M4-01 상태 계층이 관리) */
  epoch: () => number;
  idempotencyKey?: () => string;
  now?: () => number;
  heavy: HeavySemaphore;
  limiter?: AdaptiveLimiter;
}

/**
 * host·concurrency·models·usage·readiness 보고와 그 응답 반영(architecture §5 `resources`).
 * 재전송(outbox)은 M4-01 계층이 맡는다. 여기서는 1회 호출과 응답 처리, 실패 시 보낼 내용 보존만 한다.
 */
export class ResourceReporter {
  readonly #d: Required<Omit<ResourceReporterDeps, 'limiter'>>;
  readonly #limiter: AdaptiveLimiter;
  readonly #pending: LimitAdjust[] = [];
  #caps: Caps | null = null;
  #memReserveGB = DEFAULT_MEM_RESERVE_GB;
  #started = false;
  #blocked: Agent[] = [];
  /** 동시 실행 보고를 한 번에 하나씩 보내기 위한 꼬리 */
  #concurrencyTail: Promise<unknown> = Promise.resolve();

  constructor(deps: ResourceReporterDeps) {
    this.#d = { idempotencyKey: randomUUID, now: Date.now, ...deps };
    this.#limiter = deps.limiter ?? new AdaptiveLimiter();
  }

  get caps(): Caps | null {
    return this.#caps;
  }
  get limit(): number | null {
    return this.#limiter.limit;
  }
  get holdNew(): boolean {
    return this.#limiter.holdNew;
  }
  get memReserveGB(): number {
    return this.#memReserveGB;
  }
  /** 준비 점검 fail로 실행을 멈춘 Agent */
  get blocked(): Agent[] {
    return this.#blocked;
  }

  /** Runner 시작·PC 변경 시. 첫 보고와 `hostChanged`면 한도를 시작값부터 다시 잡는다. */
  async reportHost(body: HostReport): Promise<{ hostChanged: boolean }> {
    const res = await this.#d.api('reportHost', { body, ...this.#meta() });
    const { caps, hostChanged } = res.body;
    this.#applyCaps(caps, !this.#started || hostChanged);
    this.#started = true;
    return { hostChanged };
  }

  /**
   * 동시 실행 상태 보고. 쌓인 조절 기록은 하나씩 순서대로 싣는다(계약의 adjust는 1건).
   * 응답의 상한·메모리 예비를 반영하고, 한도가 상한을 넘었다는 400이면 정책을 다시 받아 한 번 더 보낸다.
   * 호출이 겹쳐도 앞 호출이 끝난 뒤 차례로 보낸다 — 같은 조절 기록을 두 번 보내거나 남이 보낸 기록을 지우지 않게.
   */
  reportConcurrency(sessions: readonly SessionState[], heavyJobs: number, r: ResourceSnapshot, at?: Date): Promise<void> {
    const run = this.#concurrencyTail.then(() => this.#sendConcurrency(sessions, heavyJobs, r, at));
    this.#concurrencyTail = run.catch(() => undefined);
    return run;
  }

  async #sendConcurrency(sessions: readonly SessionState[], heavyJobs: number, r: ResourceSnapshot, at?: Date): Promise<void> {
    if (this.#limiter.limit === null) throw new Error('host 보고로 상한을 받기 전에는 동시 실행을 보고할 수 없습니다.');
    let retried = false;
    for (;;) {
      const adjust = this.#pending[0];
      const limit = adjust?.to ?? this.#limiter.limit;
      const body = {
        at: (at ?? new Date(this.#d.now())).toISOString(),
        limit,
        running: { Claude: count(sessions, 'Claude'), Codex: count(sessions, 'Codex') },
        subagents: sessions.reduce((sum, s) => sum + Math.max(0, s.reserved - 1), 0),
        heavyJobs,
        resources: { cpuPct: r.cpuPct, memFreeGB: r.memFreeGB, swapGB: r.swapUsedGB },
        sessions: sessions.map(({ attemptId, observed, reserved, state }) => ({ attemptId, observed, reserved, state })),
        ...(adjust && { adjust }),
      };
      let res;
      try {
        res = await this.#d.api('reportConcurrency', { body, ...this.#meta() });
      } catch (e) {
        if (retried || !(e instanceof ApiError) || e.status !== 400 || e.error?.code !== 'LIMIT_EXCEEDS_CAP') throw e;
        retried = true;
        await this.#refreshPolicy();
        continue;
      }
      // 보낸 그 기록만 지운다(그사이 대기열이 바뀌었을 수 있다).
      if (adjust) {
        const i = this.#pending.indexOf(adjust);
        if (i >= 0) this.#pending.splice(i, 1);
      }
      this.#applyCaps(res.body.caps, false);
      this.#memReserveGB = res.body.caps.memReserveGB;
      if (this.#pending.length === 0) return;
    }
  }

  /** 주기 자원 관측(G §6.6 조절 규칙) */
  observe(r: ResourceSnapshot): void {
    this.#queue(this.#limiter.observe(this.#d.now(), { memFreeGB: r.memFreeGB, swapUsedGB: r.swapUsedGB, memReserveGB: this.#memReserveGB }));
  }
  rateLimited(): void {
    this.#queue(this.#limiter.rateLimited(this.#d.now()));
  }
  succeeded(): void {
    this.#limiter.succeeded();
  }
  error(): void {
    this.#limiter.error(this.#d.now());
  }
  /** 자원 관측 실패 — 안정 시간을 다시 센다. */
  sampleFailed(): void {
    this.#limiter.sampleFailed(this.#d.now());
  }

  /** 새 세션을 시작해도 되는가. slots는 새 세션의 보유 계산(1 + 예산). */
  canStart(agent: Agent, slots: number, sessions: readonly SessionState[]): AdmitResult {
    // 준비 점검 fail이면 서버 보고 성공 여부와 무관하게 그 Agent는 시작하지 않는다(G §7.4).
    if (this.#blocked.includes(agent)) return { ok: false, reason: 'readiness_failed' };
    if (!this.#caps) return { ok: false, reason: 'no_caps' };
    const held = { total: 0, Claude: 0, Codex: 0 };
    for (const s of sessions) {
      held.total += s.reserved;
      held[s.agent] += s.reserved;
    }
    return admit({
      limit: this.#limiter.limit,
      holdNew: this.#limiter.holdNew,
      caps: this.#caps,
      held,
      unconfirmed: sessions.filter((s) => s.state === 'unconfirmed').length,
      agent,
      slots,
    });
  }

  /** 새로 보고된(미허용으로 등록된) 모델 ID를 돌려준다. */
  async reportModels(body: ModelsReport): Promise<string[]> {
    const res = await this.#d.api('reportModels', { body, ...this.#meta() });
    return res.body.newModels;
  }

  /** 바뀐 Agent의 사용량을 보낸다. 실패한 것은 tracker에 되돌려 다음에 다시 보낸다. */
  async reportUsage(tracker: UsageTracker): Promise<void> {
    const reports = tracker.drain();
    for (const [i, body] of reports.entries()) {
      try {
        await this.#d.api('reportUsage', { body, ...this.#meta() });
      } catch (e) {
        tracker.restore(reports.slice(i));
        throw e;
      }
    }
  }

  /** 준비 상태를 보낸다. 보고 성공 여부와 무관하게 fail 항목의 Agent는 로컬에서 바로 멈춘다. */
  async reportReadiness(body: ReadinessReport): Promise<Agent[]> {
    this.#blocked = blockedAgents(body.items);
    await this.#d.api('reportReadiness', { body, ...this.#meta() });
    return this.#blocked;
  }

  async #refreshPolicy(): Promise<void> {
    const res = await this.#d.api('getRunnerPolicy', { epoch: this.#d.epoch() });
    if (res.status !== 200) return;
    this.#applyCaps(res.body.caps, false);
    this.#memReserveGB = res.body.caps.memReserveGB;
    // 새 상한을 넘는 조절 기록은 보낼 수 없다.
    const cap = res.body.caps.total;
    for (let i = this.#pending.length - 1; i >= 0; i -= 1) if ((this.#pending[i]?.to ?? 0) > cap) this.#pending.splice(i, 1);
  }

  #applyCaps(c: Caps, restart: boolean): void {
    this.#caps = { total: c.total, Claude: c.Claude, Codex: c.Codex, heavy: c.heavy };
    this.#d.heavy.resize(c.heavy);
    this.#queue(this.#limiter.applyCaps(c.total, { restart }, this.#d.now()));
  }

  #queue(a: LimitAdjust | null): void {
    if (a) this.#pending.push(a);
  }

  #meta() {
    return { epoch: this.#d.epoch(), idempotencyKey: this.#d.idempotencyKey() };
  }
}

const count = (sessions: readonly SessionState[], agent: Agent): number => sessions.filter((s) => s.agent === agent).length;
