// 공통 시각·날짜 스키마의 허용 범위(M2-08 재리뷰 R2, M2-02·M2-08 반복 문제).
// 모양만 보는 정규식은 연도 0000·10000·없는 날짜(02-30)를 통과시켜 DB 변환에서 500이 났다.
// 이제 한 곳(common.ts)에서 1970~9999년, 실재하는 날짜·시각만 받는다. 모든 API가 이 스키마를 쓴다.
import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';
import { describe, expect, test } from 'vitest';
import { DateOnly, isDateOnly, isTimestamp, Timestamp } from '../../src/api/common.ts';
import { OPERATIONS } from '../../src/api/index.ts';

const GOOD_TIMES = ['1970-01-01T00:00:00Z', '2024-02-29T23:59:59.999999Z', '2000-02-29T12:00:00.5Z', '9999-12-31T23:59:59Z', '2026-11-26T09:30:00.000001Z'];
const BAD_TIMES = [
  '0000-01-01T00:00:00Z', '0001-01-01T00:00:00Z', '1969-12-31T23:59:59Z', '10000-01-01T00:00:00Z',
  '2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2100-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2026-13-01T00:00:00Z',
  '2026-04-31T00:00:00Z', '2026-00-10T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T23:60:00Z',
  '2026-01-01T23:59:60Z', '2026-01-01T00:00:00', '2026-01-01T00:00:00.1234567Z', '2026-01-01 00:00:00Z',
];
const GOOD_DATES = ['1970-01-01', '2024-02-29', '2000-02-29', '9999-12-31'];
const BAD_DATES = ['0000-01-01', '1969-12-31', '10000-01-01', '2026-02-30', '2026-02-29', '2100-02-29', '2026-13-01', '2026-06-31', '2026-1-01'];

describe('Timestamp', () => {
  test.each(GOOD_TIMES)('받음: %s', (v) => { expect(Value.Check(Timestamp, v)).toBe(true); expect(isTimestamp(v)).toBe(true); });
  test.each(BAD_TIMES)('거부: %s', (v) => { expect(Value.Check(Timestamp, v)).toBe(false); expect(isTimestamp(v)).toBe(false); });
});

describe('DateOnly', () => {
  test.each(GOOD_DATES)('받음: %s', (v) => { expect(Value.Check(DateOnly, v)).toBe(true); expect(isDateOnly(v)).toBe(true); });
  test.each(BAD_DATES)('거부: %s', (v) => { expect(Value.Check(DateOnly, v)).toBe(false); expect(isDateOnly(v)).toBe(false); });
});

/** 스키마 안의 모든 문자열 노드(경로와 함께) */
function* strings(schema: unknown, path: string): Generator<[string, Record<string, unknown>]> {
  if (!schema || typeof schema !== 'object') return;
  const s = schema as Record<string, unknown>;
  if (s.type === 'string') yield [path, s];
  for (const key of ['anyOf', 'allOf', 'oneOf']) for (const [i, sub] of ((s[key] as unknown[] | undefined) ?? []).entries()) yield* strings(sub, `${path}|${String(i)}`);
  for (const [k, sub] of Object.entries((s.properties as Record<string, unknown> | undefined) ?? {})) yield* strings(sub, `${path}.${k}`);
  if (s.items) yield* strings(s.items, `${path}[]`);
  if (s.additionalProperties && typeof s.additionalProperties === 'object') yield* strings(s.additionalProperties, `${path}{}`);
}

test('전 API: 시각·날짜처럼 생긴 문자열은 모두 공통 스키마를 쓰고, 범위 밖 값을 거부한다', () => {
  const rogue: string[] = [];
  let checked = 0;
  for (const op of OPERATIONS) {
    const parts: [string, unknown][] = [['params', op.params], ['query', op.query], ['body', op.body],
      ...Object.entries(op.responses).map(([status, schema]): [string, unknown] => [`response${status}`, schema])];
    for (const [where, schema] of parts) {
      for (const [path, node] of strings(schema, `${op.id}:${where}`)) {
        const pattern = typeof node.pattern === 'string' ? node.pattern : '';
        const looksDate = /\[0-9\]\{4\}-|\\d\{4\}-/.test(pattern) || node.title === 'Timestamp' || node.title === 'DateOnly';
        if (!looksDate) continue;
        checked++;
        const sample: string = node.title === 'DateOnly' || !pattern.includes('T') ? '0000-01-01' : '0000-01-01T00:00:00Z';
        const impossible = sample.replace('0000-01-01', '2026-02-30');
        if (Value.Check(node as TSchema, sample) || Value.Check(node as TSchema, impossible)) rogue.push(path);
      }
    }
  }
  expect(checked).toBeGreaterThan(100);
  expect(rogue).toEqual([]);
});
