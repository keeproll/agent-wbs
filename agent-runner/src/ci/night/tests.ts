export interface TestOutcome { key: string; status: 'pass' | 'fail' }
export interface TestJudgement {
  /** 마지막 시도에서도 실패했고 격리하지 않은 테스트. 하나라도 있으면 통과를 막는다. */
  failed: string[];
  /** 앞 시도에서 실패했지만 마지막 시도에서 통과한 테스트(불안정 후보). */
  flaky: string[];
  /** 마지막 시도에서 실패했지만 격리된 테스트. 기록만 하고 통과를 막지 않는다. */
  quarantinedFailures: string[];
  passed: number;
  total: number;
  blocking: boolean;
}

function outcomes(attempt: readonly TestOutcome[]): Map<string, 'pass' | 'fail'> {
  const map = new Map<string, 'pass' | 'fail'>();
  for (const { key, status } of attempt) {
    if (typeof key !== 'string' || key === '' || map.has(key) || !['pass', 'fail'].includes(status)) throw new TypeError('테스트 결과가 올바르지 않습니다.');
    map.set(key, status);
  }
  return map;
}

/**
 * 첫 시도와 재시도의 테스트 결과로 판정한다(G L482).
 * 재시도에 다시 나오지 않은 실패 테스트는 마지막 결과를 실패로 둔다. 사라진 테스트를 통과로 보면 실패를 숨길 수 있다.
 */
export function judgeTests(attempts: readonly (readonly TestOutcome[])[], quarantined: ReadonlySet<string>): TestJudgement {
  const runs = attempts.map(outcomes);
  const final = new Map<string, 'pass' | 'fail'>();
  const failedOnce = new Set<string>();
  for (const [index, run] of runs.entries()) {
    for (const [key, status] of run) {
      if (status === 'fail') failedOnce.add(key);
      if (index === 0 || final.get(key) === 'fail') final.set(key, status);
    }
    // 앞에서 실패한 테스트가 이번 시도에 없으면 실패를 유지한다.
  }
  const keys = [...final.keys()].sort();
  const failing = keys.filter(key => final.get(key) === 'fail');
  const failed = failing.filter(key => !quarantined.has(key));
  return {
    failed,
    flaky: keys.filter(key => final.get(key) === 'pass' && failedOnce.has(key)),
    quarantinedFailures: failing.filter(key => quarantined.has(key)),
    passed: keys.length - failing.length,
    total: keys.length,
    blocking: failed.length > 0,
  };
}
