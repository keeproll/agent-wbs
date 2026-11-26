import { reservedSlots } from '../resources/concurrency.ts';
import { activeIds, initialObservation, reduceObservation, type ObservationInput, type ObservationState } from './reduce.ts';

export interface ObservationSnapshot {
  /** 지금 실행 중으로 관측된 하위 Agent 수 */
  observed: number;
  /** 세션 동안 동시에 관측된 최대 수 */
  peak: number;
  active: string[];
  /** `unconfirmed`: 관측이 끊기거나 불완전함 — 수를 줄이지 않고 보유한다(G §6.7 규칙 3) */
  state: 'ok' | 'unconfirmed';
  /** 결과 이벤트(정상·실패)를 받았는가 */
  ended: boolean;
  /** 지나간 run의 것이라 버린 이벤트 수 */
  dropped: number;
}

/**
 * 출력 스트림에서 하위 Agent 수를 **관측**한다. 슬롯 반환·종료 판단의 근거가 아니다(G §6.7: 확정 근거는 프로세스 그룹뿐).
 * 이 클래스는 순수 reducer(`reduce.ts`의 `reduceObservation`)를 감싼 얇은 껍데기다. 규칙은 모두 reducer에 있다.
 * - 관측기 하나 = Runner가 시작한 CLI 프로세스(launch) 하나. 같은 관측을 이어 프로세스를 다시 시작하면 `launch()`를 부른다.
 * - 모르는 상태, ID 없는 생성, 깨진 줄, 복구 불가능한 스트림 오류, 연결을 증명할 수 없는 이벤트, 결과 없이 끝난 스트림은 `unconfirmed`.
 *   한 번 그러면 되돌리지 않는다.
 * - 스트림이 끝나도 남은 수를 0으로 만들지 않는다(출력 없음·단절 ≠ 실행 수 0).
 */
export class SubagentObserver {
  #state: ObservationState = initialObservation();

  apply(e: ObservationInput): void {
    this.#state = reduceObservation(this.#state, e);
  }

  /** Runner가 이 관측을 이어 CLI 프로세스를 다시 시작했다(launch 기록). */
  launch(): void {
    this.apply({ type: 'launch' });
  }

  /** 출력이 끝났을 때(프로세스 종료·스트림 닫힘) 부른다. */
  finish(): void {
    this.apply({ type: 'end' });
  }

  get state(): ObservationState {
    return this.#state;
  }

  snapshot(): ObservationSnapshot {
    const s = this.#state;
    const active = activeIds(s);
    return { observed: active.length, peak: s.peak, active, state: s.unconfirmed ? 'unconfirmed' : 'ok', ended: s.ended, dropped: s.dropped };
  }
}

/**
 * 이 세션이 보유할 슬롯 수. `verified`는 서버 `cliGrades`에서 이 조합(CLI·버전·모델·옵션)이 `verified`인지다.
 * CLI는 항상 최신을 쓰므로(owner Q-12) 새 버전은 재검증 전까지 미검증 → 보수 계산 `1 + max(예산, 관측, 직전 보유)`.
 */
export function sessionSlots(o: SubagentObserver, { verified, budget, previousHeld = 0 }: { verified: boolean; budget: number; previousHeld?: number }): number {
  const s = o.snapshot();
  return reservedSlots({ verified, state: s.state, observed: s.observed, budget, previousHeld });
}
