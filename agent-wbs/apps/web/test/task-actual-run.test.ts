/** Task 개요 「실제 실행」의 토큰 단위(M3 통합 재리뷰 sf3-43e05b9 P2-1). 실행 기록의 tokens는 토큰 개수라 K로 바꿔 보인다. */
import { describe, expect, it } from 'vitest';
import { actualRunLabel } from '../src/features/task/schedule.ts';

describe('실제 실행 표시', () => {
  it('토큰 개수를 1,000으로 나눠 K로 보인다(대시보드 tokensK와 같은 반올림)', () => {
    expect(actualRunLabel(2.5, [{ tokens: 151_000 }, { tokens: 9_400 }, { tokens: null }])).toBe('2.5h · 토큰 160K (실행 시도 3건)');
  });
  it('리뷰 재현: 합계 420개는 420K가 아니다', () => {
    expect(actualRunLabel(0, [{ tokens: 420 }])).not.toContain('420K');
    expect(actualRunLabel(0, [{ tokens: 420 }])).toBe('0h · 토큰 0K (실행 시도 1건)');
  });
});
