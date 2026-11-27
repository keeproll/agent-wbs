import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { fieldDirection } from '../../src/design/shape.ts';

/** 서버(@awbs/shared designFieldDirection)와 같은 사례 파일로 방향 규칙을 시험한다(M6 통합, M6-05 리뷰2 P3-3). */
const fixture = JSON.parse(readFileSync(new URL('../../../agent-wbs/contracts/fixtures/design-direction.json', import.meta.url), 'utf8')) as { cases: { kind: string; path: string; direction: string }[] };

test.each(fixture.cases)('$kind $path → $direction', ({ kind, path, direction }) => {
  expect(fieldDirection(kind, path)).toBe(direction);
});
