import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { designFieldDirection } from '../../src/api/design.ts';

/** Runner(agent-runner/src/design/shape.ts fieldDirection)와 같은 사례 파일로 방향 규칙을 시험한다(M6 통합, M6-05 리뷰2 P3-3). */
const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/design-direction.json', import.meta.url), 'utf8')) as { cases: { kind: string; path: string; direction: string }[] };

test.each(fixture.cases)('$kind $path → $direction', ({ kind, path, direction }) => {
  expect(designFieldDirection(kind, path)).toBe(direction);
});
