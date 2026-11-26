import type { Agent } from '../api/generated/client.ts';

/**
 * 동시 실행 한도의 적응형 조절(G §6.6 「Runner 조절 규칙」).
 *
 * - 상한(전체·Agent별·무거운 작업)은 서버가 M1-06 공식(shared `recommendedCaps`/`effectiveCaps`)으로 계산해
 *   `POST /runner/host`·`/runner/concurrency`·`GET /runner/policy` 응답으로 준다. Runner는 공식을 다시 계산하지 않는다
 *   (architecture §1 책임 경계 「자원」, 두 시스템은 소스를 공유하지 않음 §1-4).
 * - Runner는 그 상한 안에서 「실제로 몇 개까지 시작할지」(한도)만 조절한다.
 */

/** 조절 사유. WBS 조절 기록에 그대로 보인다. */
export const LIMIT_REASON = {
  stable: '자원 여유·오류 없음 10분 유지 → +2',
  memory: '메모리 여유가 예비보다 작거나 swap 사용 → 25% 감소',
  rateLimit: 'API 속도 제한(429) 연속 → 50% 감소',
  cap: '상한이 한도보다 낮아짐 → 상한으로',
  hostChanged: 'PC 변경 → 시작값부터 다시',
} as const;

export interface LimitAdjust {
  from: number;
  to: number;
  reason: string;
}

export interface ResourceSample {
  memFreeGB: number;
  swapUsedGB: number;
  memReserveGB: number;
}

/** G §6.6의 [Mock 수치]. 운영 데이터로 보정할 수 있게 한곳에 둔다. */
export interface LimiterSettings {
  start: number;
  step: number;
  stableMs: number;
  memoryCut: number;
  rateLimitCut: number;
  /** 몇 번 연속 429면 줄이는가. G는 「연속」만 적었다 — 2회로 정함[결정, 보고서 참고]. */
  rateLimitStreak: number;
  /**
   * 자원 관측 사이 간격이 이보다 길면 그 사이를 「여유 유지」로 보지 않고 처음부터 다시 센다.
   * 관측 주기(1분 가정)의 두 배로 정함[결정]. 관측 주기를 바꾸면 함께 바꾼다.
   */
  maxSampleGapMs: number;
}

export const DEFAULT_LIMITER_SETTINGS: LimiterSettings = {
  start: 6,
  step: 2,
  stableMs: 10 * 60_000,
  memoryCut: 0.25,
  rateLimitCut: 0.5,
  rateLimitStreak: 2,
  maxSampleGapMs: 2 * 60_000,
};

/** 메모리 여유가 예비보다 작거나 swap을 쓰면 자원 압박 — shared `capacity/limits.ts`의 같은 이름 함수와 같은 식. */
export const memoryPressure = (memFreeGb: number, swapUsedGb: number, memReserveGb: number): boolean =>
  memFreeGb < memReserveGb || swapUsedGb > 0;

export class AdaptiveLimiter {
  #limit: number | null = null;
  #cap = 0;
  #stableSince = 0;
  /** 마지막 정상 관측 시각. 관측 전·관측 실패 뒤에는 null이라 안정 시간을 세지 않는다. */
  #lastSample: number | null = null;
  #pressure = false;
  #streak = 0;
  readonly #s: LimiterSettings;

  constructor(settings: LimiterSettings = DEFAULT_LIMITER_SETTINGS) {
    this.#s = settings;
  }

  /** 현재 한도. 상한을 받기 전에는 null(새 실행 불가). */
  get limit(): number | null {
    return this.#limit;
  }

  /** 자원 압박으로 새 실행을 보류 중인가 */
  get holdNew(): boolean {
    return this.#pressure;
  }

  /**
   * 서버가 준 전체 상한을 반영한다.
   * `restart`는 Runner 시작 또는 PC 변경(`hostChanged`) — 시작값 min(6, 상한)부터 다시(G §6.6 PC 변경 처리 3).
   */
  applyCaps(total: number, { restart }: { restart: boolean }, now: number): LimitAdjust | null {
    if (!Number.isInteger(total) || total < 1) throw new RangeError(`상한 값이 올바르지 않습니다: ${String(total)}`);
    this.#cap = total;
    const prev = this.#limit;
    if (restart || prev === null) {
      this.#stableSince = now;
      this.#lastSample = null;
      this.#streak = 0;
      const to = Math.min(this.#s.start, total);
      this.#limit = to;
      return prev === null || prev === to ? null : { from: prev, to, reason: LIMIT_REASON.hostChanged };
    }
    return prev > total ? this.#set(total, LIMIT_REASON.cap) : null;
  }

  /**
   * 주기 관측. 압박에 들어서는 순간 한 번 줄이고, 압박이 없는 **관측**이 10분 이어질 때마다 늘린다.
   * 첫 관측 전이나 관측 공백(maxSampleGapMs 초과) 뒤에는 그 관측 시각부터 다시 센다 — 보지 못한 시간을 여유로 치지 않는다.
   */
  observe(now: number, r: ResourceSample): LimitAdjust | null {
    if (this.#limit === null) return null;
    const last = this.#lastSample;
    this.#lastSample = now;
    if (last === null || now - last > this.#s.maxSampleGapMs) this.#stableSince = now;
    if (memoryPressure(r.memFreeGB, r.swapUsedGB, r.memReserveGB)) {
      const entering = !this.#pressure;
      this.#pressure = true;
      this.#stableSince = now;
      return entering ? this.#cut(this.#s.memoryCut, LIMIT_REASON.memory) : null;
    }
    if (this.#pressure) {
      this.#pressure = false;
      this.#stableSince = now;
      return null;
    }
    if (now - this.#stableSince < this.#s.stableMs || this.#limit >= this.#cap) return null;
    this.#stableSince = now;
    return this.#set(Math.min(this.#cap, this.#limit + this.#s.step), LIMIT_REASON.stable);
  }

  /** Agent API가 429로 답했다. */
  rateLimited(now: number): LimitAdjust | null {
    this.#stableSince = now;
    this.#streak += 1;
    if (this.#streak < this.#s.rateLimitStreak) return null;
    this.#streak = 0;
    return this.#cut(this.#s.rateLimitCut, LIMIT_REASON.rateLimit);
  }

  /** 429가 아닌 응답 — 연속이 끊긴다. */
  succeeded(): void {
    this.#streak = 0;
  }

  /** 429가 아닌 오류 응답·실행 오류 — 「오류 없음 10분」을 다시 세고, 429 연속도 끊긴다. */
  error(now: number): void {
    this.#stableSince = now;
    this.#streak = 0;
  }

  /** 자원 관측에 실패했다 — 다음 정상 관측부터 다시 센다. */
  sampleFailed(now: number): void {
    this.#stableSince = now;
    this.#lastSample = null;
  }

  #cut(ratio: number, reason: string): LimitAdjust | null {
    if (this.#limit === null) return null;
    return this.#set(Math.max(1, Math.floor(this.#limit * (1 - ratio) + 1e-9)), reason);
  }

  #set(to: number, reason: string): LimitAdjust | null {
    const from = this.#limit;
    if (from === null || from === to) return null;
    this.#limit = to;
    return { from, to, reason };
  }
}

export interface SessionSlots {
  /** 서버가 이 CLI·버전·모델·옵션 조합을 `검증됨`으로 판정했는가. 모르면 false(fail-closed). */
  verified: boolean;
  state: 'ok' | 'unconfirmed';
  observed: number;
  /** 하위 Agent 동시 예산 k */
  budget: number;
  /** 직전까지 보유로 센 하위 Agent 수 */
  previousHeld: number;
}

/**
 * 세션이 보유한 슬롯 = 1 + 하위 Agent 보유 계산(G §6.7 규칙 2·3). shared `heldSlots`와 같은 규칙이다.
 * 출력 스트림의 관측만으로는 슬롯이 줄지 않는다 — 검증된 CLI의 정상 관측일 때만 관측 수를 쓴다.
 */
export function reservedSlots(s: SessionSlots): number {
  for (const [k, v] of Object.entries({ observed: s.observed, budget: s.budget, previousHeld: s.previousHeld })) {
    if (!Number.isInteger(v) || v < 0) throw new RangeError(`${k} 값이 올바르지 않습니다: ${String(v)}`);
  }
  if (s.verified && s.state === 'ok') return 1 + s.observed;
  return 1 + Math.max(s.budget, s.observed, s.previousHeld);
}

export interface Caps {
  total: number;
  Claude: number;
  Codex: number;
  heavy: number;
}

export interface AdmitInput {
  limit: number | null;
  holdNew: boolean;
  caps: Caps;
  /** 현재 host에서 보유 계산 중인 슬롯 합계 */
  held: { total: number } & Record<Agent, number>;
  /** 종료를 확인하지 못한 세션 수 */
  unconfirmed: number;
  agent: Agent;
  /** 새 세션이 보유할 슬롯(1 + 예산) */
  slots: number;
}

export type AdmitResult =
  | { ok: true }
  | { ok: false; reason: 'readiness_failed' | 'no_caps' | 'memory_pressure' | 'unconfirmed_session' | 'limit' | 'agent_cap' };

/** 새 세션을 지금 시작해도 되는가. Runner의 유일한 강제 수단이다(G §6.7-5 b). */
export function admit(i: AdmitInput): AdmitResult {
  if (i.limit === null) return { ok: false, reason: 'no_caps' };
  if (i.holdNew) return { ok: false, reason: 'memory_pressure' };
  if (i.unconfirmed > 0) return { ok: false, reason: 'unconfirmed_session' };
  if (i.held.total + i.slots > i.limit) return { ok: false, reason: 'limit' };
  if (i.held[i.agent] + i.slots > i.caps[i.agent]) return { ok: false, reason: 'agent_cap' };
  return { ok: true };
}
