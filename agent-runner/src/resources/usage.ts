import type { Agent } from '../api/generated/client.ts';
import type { ApiRequest } from '../api/client.ts';

/** POST /runner/usage 본문 */
export type UsageReport = ApiRequest<'reportUsage'>['body'];

/**
 * Agent별 남은 사용량을 모아 바뀐 것만 보고한다.
 * 값을 어디서 읽는지(CLI 출력의 사용량 이벤트 등)는 실행 어댑터(M5-01)가 정하고 여기로 넘긴다.
 * 사용량 부족 시 대기/하향 판단은 서버 `run-grade`가 한다(G §9.3-3) — Runner는 보고만 한다.
 */
export class UsageTracker {
  readonly #state = new Map<Agent, { remainPct?: number; resetAt?: string; tokens: number }>();
  readonly #dirty = new Set<Agent>();

  update(agent: Agent, reading: { remainPct: number; resetAt?: Date }): void {
    const { remainPct, resetAt } = reading;
    if (!Number.isFinite(remainPct) || remainPct < 0 || remainPct > 100) {
      throw new RangeError(`남은 사용량이 0~100이 아닙니다: ${String(remainPct)}`);
    }
    if (resetAt && Number.isNaN(resetAt.getTime())) throw new RangeError('리셋 시각이 올바르지 않습니다.');
    const s = this.#get(agent);
    // 반올림하지 않는다 — 19.6%가 20%로 바뀌면 「20% 미만」 정책을 비켜 간다. 표시 반올림은 화면이 한다.
    const pct = remainPct;
    const at = resetAt?.toISOString();
    if (s.remainPct === pct && s.resetAt === at) return;
    s.remainPct = pct;
    if (at === undefined) delete s.resetAt;
    else s.resetAt = at;
    this.#dirty.add(agent);
  }

  addTokens(agent: Agent, n: number): void {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`토큰 수가 올바르지 않습니다: ${String(n)}`);
    if (n === 0) return;
    this.#get(agent).tokens += n;
    this.#dirty.add(agent);
  }

  /** 보고할 본문을 꺼낸다. 남은 사용량을 아직 모르는 Agent는 다음으로 미룬다. */
  drain(): UsageReport[] {
    const out: UsageReport[] = [];
    for (const agent of [...this.#dirty]) {
      const s = this.#get(agent);
      if (s.remainPct === undefined) continue;
      this.#dirty.delete(agent);
      out.push({
        agent,
        remainPct: s.remainPct,
        ...(s.resetAt !== undefined && { resetAt: s.resetAt }),
        ...(s.tokens > 0 && { tokensUsed: s.tokens }),
      });
    }
    return out;
  }

  /** 보고에 실패한 본문을 되돌린다. 그사이 새 값이 왔으면 새 값이 그대로 남는다. */
  restore(reports: readonly UsageReport[]): void {
    for (const r of reports) this.#dirty.add(r.agent);
  }

  #get(agent: Agent) {
    let s = this.#state.get(agent);
    if (!s) {
      s = { tokens: 0 };
      this.#state.set(agent, s);
    }
    return s;
  }
}
