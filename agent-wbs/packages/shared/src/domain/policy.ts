import type { Attempt } from './state.ts';

export interface AttemptHistory extends Attempt {
  id: string;
  // Same QA/integration failure ID across all retries of one automatic rework round; null for manual runs.
  automaticReworkCause?: string | null;
}

// Ordered oldest first, one row per attempt. Replayed identical rows do not consume a second retry.
export function attemptPolicyCounts(history: readonly AttemptHistory[]) {
  const consecutiveFailures = { dev: 0, qa: 0, rework: 0, reverify: 0 };
  const reworkCauses = new Set<string>();
  const seen = new Set<string>();
  for (const attempt of history) {
    if (seen.has(attempt.id)) continue;
    seen.add(attempt.id);
    if (attempt.verificationDisposition === 'stale') continue;
    if (attempt.kind === 'rework' && attempt.automaticReworkCause) reworkCauses.add(attempt.automaticReworkCause);
    // 재작업 중 ① Task 실패(failed)는 재작업 원인 횟수와 함께 자동 재시도(같은 종류 연속 실패) 횟수에도 센다.
    // M5·M7 통합 조정자 결정(M5-05 리뷰 P3-2). 왜: ①이 실제로 돌아 실패한 것은 그 시도의 실패이므로 두 한도 모두에 들어간다.
    if (attempt.status === 'failed') consecutiveFailures[attempt.kind] += 1;
    if (attempt.status === 'completed') consecutiveFailures[attempt.kind] = 0;
  }
  return { consecutiveFailures, automaticReworks: reworkCauses.size };
}
