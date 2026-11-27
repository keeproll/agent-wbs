import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { JudgedContent } from '../../src/api/generated/client.ts';
import { boundRef, canonicalJson, fingerprint, JcsError, judgedContentHash, refFingerprint } from '../../src/planning/binding.ts';
import { normalizeJudged } from '../../src/planning/judged.ts';

/*
 * 서버 계약의 고정 벡터(agent-wbs/contracts/fixtures/judgement-bindings.json, srv4 fix3)로 Runner 지문 계산을 맞춘다.
 * 입력·정규 직렬화 문자열·지문·sourceRef가 모두 같아야 한다.
 */
interface Vector { id: string; kind: 'JudgedContent' | 'JCS'; input: unknown; canonical: string; subjectHash: string; sourceRef?: string }
const vectors = JSON.parse(readFileSync(new URL('../../../agent-wbs/contracts/fixtures/judgement-bindings.json', import.meta.url), 'utf8')) as Vector[];

describe('계약 고정 벡터(judgement-bindings.json)', () => {
  test('벡터가 있다', () => {
    expect(vectors.map((v) => v.kind)).toContain('JudgedContent');
    expect(vectors.map((v) => v.kind)).toContain('JCS');
  });

  test.each(vectors.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    if (v.kind === 'JudgedContent') {
      const content = v.input as JudgedContent;
      expect(canonicalJson(normalizeJudged(content))).toBe(v.canonical);
      expect(judgedContentHash(content)).toBe(v.subjectHash);
      expect(boundRef(judgedContentHash(content))).toBe(v.sourceRef);
    } else {
      expect(canonicalJson(v.input)).toBe(v.canonical);
      expect(fingerprint(v.input)).toBe(v.subjectHash);
    }
  });

  test('JSON 밖의 값·잘못된 Unicode는 다른 값으로 바꾸지 않고 거부한다(서버 jcs와 같음)', () => {
    expect(() => canonicalJson({ a: '\uD800' })).toThrow(JcsError);
    expect(() => canonicalJson([Number.NaN])).toThrow(JcsError);
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow(JcsError);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(JcsError);
    // 전송 JSON에서 사라지는 undefined 키는 빼고 계산한다.
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });

  test('문자열은 정규화하지 않고 그대로 JCS에 넣는다(NFC·NFD·앞뒤 공백 모두 다른 지문, 서버 리뷰 P3)', () => {
    const base = vectors.find((v) => v.kind === 'JudgedContent')?.input as JudgedContent;
    const nfc = { ...base, title: '\u00e9 제목' };
    const nfd = { ...base, title: 'e\u0301 제목' };
    const spaced = { ...base, title: ' \u00e9 제목 ' };
    expect(canonicalJson(normalizeJudged(nfd))).toContain('e\u0301 제목');
    expect(new Set([judgedContentHash(nfc), judgedContentHash(nfd), judgedContentHash(spaced)]).size).toBe(3);
  });

  test('sourceRef는 소문자 hex의 sha256:<64자>만 지문으로 읽는다(대문자·옛 형식은 지문이 아님)', () => {
    const hex = vectors[0]?.subjectHash ?? '';
    expect(refFingerprint(`sha256:${hex}`)).toBe(hex);
    expect(refFingerprint(`sha256:${hex.toUpperCase()}`)).toBeNull();
    expect(refFingerprint(`job-1#input-sha256:${hex}`)).toBeNull();
    expect(refFingerprint('job-1')).toBeNull();
  });
});
