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
    if (attempt.status === 'failed') consecutiveFailures[attempt.kind] += 1;
    if (attempt.status === 'completed') consecutiveFailures[attempt.kind] = 0;
  }
  return { consecutiveFailures, automaticReworks: reworkCauses.size };
}
