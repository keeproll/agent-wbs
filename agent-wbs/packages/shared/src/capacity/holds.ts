import type { Agent } from '../vocabulary.ts';

export type ObservationGrade = 'verified' | 'partial' | 'unverified';

/** 관측 등급을 부여한 검증 조건. 하나라도 다르면 재검증 전까지 미검증이다(G §6.7). */
export interface ObservationKey {
  cli: string;
  version: string;
  model: string;
  /** 실행 옵션·동시 하위 Agent 수·중첩 깊이를 포함한 조건 문자열 */
  options: string;
}

export function observationGrade(
  current: ObservationKey,
  registered: readonly (ObservationKey & { grade: ObservationGrade })[],
): ObservationGrade {
  const hit = registered.find(
    (r) =>
      r.cli === current.cli &&
      r.version === current.version &&
      r.model === current.model &&
      r.options === current.options,
  );
  return hit?.grade ?? 'unverified';
}

export interface SessionObservation {
  grade: ObservationGrade;
  state: 'ok' | 'unconfirmed';
  /** 마지막으로 관측한 하위 Agent 수 */
  observed: number;
  /** 하위 Agent 예산 k (개발·재작업 / 검증) */
  budget: number;
  /** 직전까지 보유로 계산한 하위 Agent 수. 첫 계산이면 0. */
  previousHeld: number;
}

/**
 * 세션이 보유한 것으로 셀 하위 Agent 수(G §6.7 규칙 2·3).
 * 검증된 CLI의 정상 관측만 줄어들 수 있다. 그 외에는 예산·관측·직전 보유 중 큰 값이라
 * 출력 스트림만으로 슬롯이 반환되지 않는다.
 */
export function heldSubagents(s: SessionObservation): number {
  for (const [k, v] of Object.entries({ observed: s.observed, budget: s.budget, previousHeld: s.previousHeld })) {
    if (!Number.isInteger(v) || v < 0) throw new RangeError(`${k} 값이 올바르지 않습니다: ${String(v)}`);
  }
  if (s.grade === 'verified' && s.state === 'ok') return s.observed;
  return Math.max(s.budget, s.observed, s.previousHeld);
}

/** 세션 자신 + 하위 Agent 보유 계산 */
export const heldSlots = (s: SessionObservation): number => 1 + heldSubagents(s);

/** `execution_holds` 중 용량 계산에 쓰는 열 (data-model §2.5-1) */
export interface HoldRow {
  jobId: string;
  hostId: string | null;
  agent: Agent;
  slots: number;
  heavy: boolean;
  slotState: 'none' | 'reserved' | 'active' | 'unconfirmed';
}

export interface HeldTotals {
  total: number;
  perAgent: Record<Agent, number>;
  heavy: number;
  /** 종료를 확인하지 못한 job */
  unconfirmedJobs: string[];
}

/**
 * 현재 host에서 `reserved/active/unconfirmed`인 슬롯 합계.
 * 이전 host의 행은 세지 않는다. `ownJobId`를 주면 그 job의 슬롯을 빼서 이중 계산을 막는다.
 */
export function sumHolds(rows: readonly HoldRow[], hostId: string, ownJobId?: string): HeldTotals {
  const out: HeldTotals = { total: 0, perAgent: { Claude: 0, Codex: 0 }, heavy: 0, unconfirmedJobs: [] };
  for (const r of rows) {
    if (r.slotState === 'none' || r.hostId !== hostId || r.jobId === ownJobId) continue;
    out.total += r.slots;
    out.perAgent[r.agent] += r.slots;
    if (r.heavy) out.heavy += 1;
    if (r.slotState === 'unconfirmed') out.unconfirmedJobs.push(r.jobId);
  }
  return out;
}
