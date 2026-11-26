import { describe, expect, test } from 'vitest';
import { JsonlDecoder } from '../../src/cli/stream.ts';

const all = (d: JsonlDecoder, chunks: (string | Buffer)[]) => [...chunks.flatMap((c) => d.push(c)), ...d.end()];

describe('JsonlDecoder — CLI 출력 한 줄 = JSON 하나', () => {
  test('조각난 입력도 줄 단위로 모은다(CRLF·빈 줄 포함)', () => {
    const records = all(new JsonlDecoder(), ['{"type":"a"', '}\r\n\n{"type"', ':"b"}\n']);
    expect(records.map((r) => (r.kind === 'json' ? r.value.type : r.kind))).toEqual(['a', 'b']);
    expect(records.map((r) => r.line)).toEqual([1, 3]);
  });

  test('한글 한 글자가 조각 경계에서 잘려도 깨지지 않는다', () => {
    const bytes = Buffer.from('{"text":"완료"}\n');
    const cut = bytes.indexOf(Buffer.from('료')) + 1; // 3바이트 글자 중간
    const records = all(new JsonlDecoder(), [bytes.subarray(0, cut), bytes.subarray(cut)]);
    expect(records).toHaveLength(1);
    expect(records[0]?.kind === 'json' && records[0].value.text).toBe('완료');
  });

  test('JSON이 아닌 줄과 객체가 아닌 JSON은 버리지 않고 원문과 함께 남긴다', () => {
    const records = all(new JsonlDecoder(), ['경고: 업데이트 확인 실패\n', '42\n', '["x"]\n', '{"type":"ok"}\n']);
    expect(records.map((r) => (r.kind === 'unparsed' ? `${r.reason}:${r.raw}` : 'json'))).toEqual([
      'invalid_json:경고: 업데이트 확인 실패',
      'not_object:42',
      'not_object:["x"]',
      'json',
    ]);
  });

  test('줄바꿈 없이 끝난 마지막 줄은 스트림 단절(truncated)로 남긴다', () => {
    const records = all(new JsonlDecoder(), ['{"type":"a"}\n{"type":"assi']);
    expect(records.at(-1)).toMatchObject({ kind: 'unparsed', reason: 'truncated', raw: '{"type":"assi', line: 2 });
  });

  test('줄바꿈 없이 끝났어도 완전한 JSON이면 그대로 읽는다', () => {
    const records = all(new JsonlDecoder(), ['{"type":"a"}']);
    expect(records).toEqual([expect.objectContaining({ kind: 'json', value: { type: 'a' } })]);
  });

  test('너무 긴 줄은 앞부분과 원래 크기만 남기고 다음 줄부터 계속 읽는다', () => {
    const d = new JsonlDecoder({ maxLineBytes: 16, keepBytes: 8 });
    const long = `{"type":"${'x'.repeat(40)}"}`;
    const records = all(d, [long.slice(0, 20), `${long.slice(20)}\n`, '{"type":"b"}\n']);
    expect(records[0]).toMatchObject({ kind: 'unparsed', reason: 'too_long', raw: long.slice(0, 8), bytes: long.length, line: 1 });
    expect(records[1]).toMatchObject({ kind: 'json', value: { type: 'b' }, line: 2 });
  });
});
