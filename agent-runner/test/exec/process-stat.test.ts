// 전체 시험 간헐 실패(review5: session 「로컬 조건이 달라지면 새 세션」)의 원인 회귀 시험.
// 끝나는 중인 프로세스(상태 X)는 /proc/<pid>/stat에 부모 0, 그룹·세션 -1을 잠깐 보인다. 아래 줄은 실제 전체 시험 중 기록한 값이다.
// 이것을 「식별 정보 손상」으로 던지면 같은 사용자의 다른 프로세스가 끝나는 순간 그룹 정리 전체가 실패한다. 「없는 프로세스」로 본다.
import { expect, test } from 'vitest';
import { parseProcessStat } from '../../src/exec/launches.ts';

const dead = '207084 (git) X 0 -1 -1 0 -1 4227084 244 0 0 0 0 0 0 0 20 0 0 0 63340 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0\n';

test('끝나는 중인 프로세스(상태 X)는 「없음」(ESRCH)으로 알린다', () => {
  expect(() => parseProcessStat(dead)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

test('살아 있는 프로세스와 좀비(Z)는 그대로 읽고, 정말 깨진 값은 여전히 손상 오류다', () => {
  expect(parseProcessStat('42 (a b) c) S 7 42 40 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1234 0').startTime).toBe('1234');
  expect(parseProcessStat('42 (z) Z 7 42 40 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1234 0').state).toBe('Z');
  expect(() => parseProcessStat('42 (bad) S 7 0 0 0')).toThrow('프로세스 식별 정보가 없습니다.');
});
