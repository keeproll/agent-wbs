export interface Timing { name: string; samplesMs: readonly number[]; budgetMs: number }
export interface TimingJudgement { name: string; p95Ms: number; budgetMs: number; over: boolean }

const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** nearest-rank 방식 p95(측정값의 95%가 이 값 이하). 보간하지 않아 실제로 잰 값 중 하나가 나온다. */
export function p95(samples: readonly number[]): number {
  if (samples.length === 0 || !samples.every(valid)) throw new TypeError('응답 시간 표본이 올바르지 않습니다.');
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
}

/** 주요 API 응답 시간(p95)을 예산과 비교한다. 예산은 main 정의의 측정 단계가 API마다 준다. */
export function judgeTimings(timings: readonly Timing[]): TimingJudgement[] {
  const names = new Set<string>();
  return timings.map(({ name, samplesMs, budgetMs }) => {
    if (typeof name !== 'string' || name === '' || names.has(name) || !valid(budgetMs) || budgetMs === 0) throw new TypeError('응답 시간 기준이 올바르지 않습니다.');
    names.add(name);
    const value = p95(samplesMs);
    return { name, p95Ms: value, budgetMs, over: value > budgetMs };
  });
}
