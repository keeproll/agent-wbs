export interface Timing { name: string; samplesMs: readonly number[] }
export interface TimingJudgement { name: string; p95Ms: number; budgetMs: number | null; over: boolean }

const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** nearest-rank 방식 p95(측정값의 95%가 이 값 이하). 보간하지 않아 실제로 잰 값 중 하나가 나온다. */
export function p95(samples: readonly number[]): number {
  if (samples.length === 0 || !samples.every(valid)) throw new TypeError('응답 시간 표본이 올바르지 않습니다.');
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
}

/**
 * 주요 API 응답 시간(p95)을 기준과 비교한다.
 * 기준은 main에 고정된 정의(night 단계의 budgetsMs)에서만 받는다. 실행 출력이 기준을 바꾸지 못하게 한다(조정자 결정 3).
 * 기준이 없는 API는 기록만 하고 초과로 보지 않는다.
 */
export function judgeTimings(timings: readonly Timing[], budgets: Readonly<Record<string, number>> = {}): TimingJudgement[] {
  const names = new Set<string>();
  return timings.map(({ name, samplesMs }) => {
    if (typeof name !== 'string' || name === '' || names.has(name)) throw new TypeError('응답 시간 이름이 올바르지 않습니다.');
    names.add(name);
    const value = p95(samplesMs);
    const budgetMs = Object.hasOwn(budgets, name) ? budgets[name] ?? null : null;
    return { name, p95Ms: value, budgetMs, over: budgetMs !== null && value > budgetMs };
  });
}
