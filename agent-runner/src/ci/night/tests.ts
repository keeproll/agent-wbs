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
 * 시도마다 실제로 보고된 테스트는 그 시도의 결과로 바꾼다. 재시도에서 새로 실패한 테스트도 실패다.
 * 재시도에 다시 나오지 않은 테스트만 앞의 결과를 그대로 둔다. 사라진 실패를 통과로 보면 실패를 숨길 수 있다.
 * 왜: 재시도는 불안정 테스트를 가려내려는 것이지 판정을 느슨하게 하려는 것이 아니다.
 */
export function judgeTests(attempts: readonly (readonly TestOutcome[])[], quarantined: ReadonlySet<string>): TestJudgement {
  const runs = attempts.map(outcomes);
  const final = new Map<string, 'pass' | 'fail'>();
  const failedOnce = new Set<string>();
  for (const run of runs) {
    for (const [key, status] of run) {
      if (status === 'fail') failedOnce.add(key);
      final.set(key, status);
    }
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
