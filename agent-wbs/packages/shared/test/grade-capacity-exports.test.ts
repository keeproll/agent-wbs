import { effortLevel, recommendedCaps, resolveRunGrade } from '@awbs/shared';
import type { HostSpec, ResolveInput } from '@awbs/shared';
import { expect, test } from 'vitest';

test('등급·용량 함수와 타입을 패키지 공개 경로로 쓸 수 있다', () => {
  const host: HostSpec = { cores: 20, memGb: 23, diskGb: 952, perSessionGb: null };
  expect(recommendedCaps(host, 4).caps.total).toBe(16);
  expect(effortLevel('Codex', 'gpt-6-sol', 'high')).toBe(3);
  const kind: ResolveInput['kind'] = 'dev';
  expect([typeof resolveRunGrade, kind]).toEqual(['function', 'dev']);
});
