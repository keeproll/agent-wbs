import { reservedSlots } from '../resources/concurrency.ts';
import type { CliEvent } from './events.ts';

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
}

/**
 * 출력 스트림에서 하위 Agent 수를 **관측**한다. 슬롯 반환·종료 판단의 근거가 아니다(G §6.7: 확정 근거는 프로세스 그룹뿐).
 * 규칙:
 * - 같은 ID는 한 번만 센다. `done`이면 뺀다. 배경 실행은 도구 결과(`returned`)로 빼지 않는다.
 * - 모르는 상태, ID 없는 생성, 깨진 줄, 결과 없이 끝난 스트림은 `unconfirmed`. 한 번 그러면 되돌리지 않는다.
 * - 스트림이 끝나도 남은 수를 0으로 만들지 않는다(출력 없음·단절 ≠ 실행 수 0).
 * - 모르는 이벤트는 보존만 하고 수·상태를 바꾸지 않는다(추정하지 않음).
 */
export class SubagentObserver {
  readonly #active = new Set<string>();
  readonly #background = new Set<string>();
  #peak = 0;
  #unconfirmed = false;
  #ended = false;

  apply(e: CliEvent): void {
    switch (e.type) {
      case 'subagent':
        if (e.background) this.#background.add(e.id);
        if (e.phase === 'done' || (e.phase === 'returned' && !this.#background.has(e.id))) this.#active.delete(e.id);
        else if (e.phase !== 'returned') this.#active.add(e.id);
        if (e.phase === 'unknown') this.#unconfirmed = true;
        this.#peak = Math.max(this.#peak, this.#active.size);
        break;
      case 'subagent_unlinked':
        this.#unconfirmed = true;
        break;
      case 'unparsed':
        this.#unconfirmed = true;
        break;
      case 'result':
        this.#ended = true;
        break;
      default:
        break;
    }
  }

  /** 출력이 끝났을 때(프로세스 종료·스트림 닫힘) 부른다. */
  finish(): void {
    if (!this.#ended) this.#unconfirmed = true;
  }

  snapshot(): ObservationSnapshot {
    return { observed: this.#active.size, peak: this.#peak, active: [...this.#active], state: this.#unconfirmed ? 'unconfirmed' : 'ok', ended: this.#ended };
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
