import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { designHash, designJson, normalizedItem } from '../src/design/cache.ts';
import type { DesignItemInput } from '@awbs/shared/api';

test('JCS는 숫자·문자열 표기와 UTF-16 키 순서를 고정한다', () => {
  expect(designJson({ numbers: [Number('333333333.33333329'), 1e30, 4.50, 2e-3, 1e-27, -0], literals: [null, true, false] }))
    .toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0]}');
  expect(designJson({ '2': 2, '10': 10, '\ufb33': 'BMP', '😀': 'pair' })).toBe('{"10":10,"2":2,"😀":"pair","דּ":"BMP"}');
  expect(() => designJson('\ud800')).toThrow();
  expect(() => designJson(Number.POSITIVE_INFINITY)).toThrow();
});

const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/design-snapshot.json', import.meta.url), 'utf8')) as { id: string; body: { items: DesignItemInput[] }; serverContentHash?: string }[];
test.each(fixtures.filter(fixture => fixture.serverContentHash))('$id의 해시는 공용 고정 벡터와 같다', fixture => {
  expect(designHash(normalizedItem(fixture.body.items[0] ?? null))).toBe(fixture.serverContentHash);
});
