import { describe, expect, test } from 'vitest';
import { judgeTests } from '../../src/ci/night/tests.ts';
import { judgeTimings, p95 } from '../../src/ci/night/perf.ts';
import { compareImages, decodePng } from '../../src/ci/night/visual.ts';
import { nightDue, seoulDate } from '../../src/ci/night/schedule.ts';
import { flakyRate, recordHistory } from '../../src/ci/night/history.ts';
import { png } from './png.ts';

describe('불안정 테스트 판정', () => {
  test('재시도로만 통과한 테스트는 불안정 후보이고 통과를 막지 않는다', () => {
    const result = judgeTests([[{ key: 'a', status: 'fail' }, { key: 'b', status: 'pass' }], [{ key: 'a', status: 'pass' }, { key: 'b', status: 'pass' }]], new Set());
    expect(result).toEqual({ failed: [], flaky: ['a'], quarantinedFailures: [], passed: 2, total: 2, blocking: false });
  });

  test('재시도에서도 실패하면 실제 실패다', () => {
    const result = judgeTests([[{ key: 'a', status: 'fail' }], [{ key: 'a', status: 'fail' }]], new Set());
    expect(result).toMatchObject({ failed: ['a'], flaky: [], blocking: true, passed: 0, total: 1 });
  });

  test('격리한 테스트의 실패는 기록하지만 통과를 막지 않는다', () => {
    const result = judgeTests([[{ key: 'q', status: 'fail' }, { key: 'b', status: 'pass' }], [{ key: 'q', status: 'fail' }, { key: 'b', status: 'pass' }]], new Set(['q']));
    expect(result).toMatchObject({ failed: [], quarantinedFailures: ['q'], blocking: false, passed: 1, total: 2 });
  });

  test('격리를 해제하면 다시 판정에 포함한다', () => {
    const attempts = [[{ key: 'q', status: 'fail' as const }], [{ key: 'q', status: 'fail' as const }]];
    expect(judgeTests(attempts, new Set(['q'])).blocking).toBe(false);
    expect(judgeTests(attempts, new Set()).blocking).toBe(true);
  });

  test('재시도에서 사라진 테스트는 통과로 보지 않는다', () => {
    const result = judgeTests([[{ key: 'a', status: 'fail' }, { key: 'b', status: 'pass' }], [{ key: 'b', status: 'pass' }]], new Set());
    expect(result).toMatchObject({ failed: ['a'], blocking: true });
  });

  test('같은 시도 안에서 이름이 겹치면 거부한다', () => {
    expect(() => judgeTests([[{ key: 'a', status: 'pass' }, { key: 'a', status: 'fail' }]], new Set())).toThrow();
  });
});

describe('응답 시간', () => {
  test('p95는 nearest-rank로 계산한다', () => {
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
    expect(p95([5])).toBe(5);
    expect(p95([30, 10, 20])).toBe(30);
  });

  test('예산을 넘은 API만 초과로 표시한다', () => {
    expect(judgeTimings([{ name: 'GET /api/tasks', samplesMs: [100, 120, 400], budgetMs: 300 }, { name: 'GET /api/wbs', samplesMs: [50], budgetMs: 300 }]))
      .toEqual([{ name: 'GET /api/tasks', p95Ms: 400, budgetMs: 300, over: true }, { name: 'GET /api/wbs', p95Ms: 50, budgetMs: 300, over: false }]);
  });

  test('표본이 없거나 숫자가 아니면 거부한다', () => {
    expect(() => p95([])).toThrow();
    expect(() => judgeTimings([{ name: 'x', samplesMs: [Number.NaN], budgetMs: 1 }])).toThrow();
    expect(() => judgeTimings([{ name: 'x', samplesMs: [1], budgetMs: 0 }])).toThrow();
  });
});

describe('화면 비교', () => {
  const red = () => [255, 0, 0, 255] as [number, number, number, number];
  test.each([0, 1, 2, 3, 4])('filter %i PNG를 읽는다', (filter) => {
    const image = decodePng(png(3, 2, (x, y) => [x * 40, y * 90, 7, 255 - x], { filter }));
    expect(image).toMatchObject({ width: 3, height: 2 });
    expect([...image.data.subarray(0, 8)]).toEqual([0, 0, 7, 255, 40, 0, 7, 254]);
    expect([...image.data.subarray(12, 16)]).toEqual([0, 90, 7, 255]);
  });

  test('RGB PNG는 불투명 RGBA로 읽는다', () => {
    expect([...decodePng(png(1, 1, () => [1, 2, 3, 0], { colorType: 2 })).data]).toEqual([1, 2, 3, 255]);
  });

  test('다른 픽셀 비율을 센다', () => {
    const a = decodePng(png(4, 1, red));
    const b = decodePng(png(4, 1, x => x === 0 ? [0, 0, 0, 255] : red()));
    expect(compareImages(a, a)).toEqual({ sizeMatch: true, diffPixels: 0, ratio: 0 });
    expect(compareImages(a, b)).toEqual({ sizeMatch: true, diffPixels: 1, ratio: 0.25 });
  });

  test('크기가 다르면 크기 불일치다', () => {
    expect(compareImages(decodePng(png(2, 1, red)), decodePng(png(1, 2, red)))).toEqual({ sizeMatch: false, diffPixels: 2, ratio: 1 });
  });

  test('PNG가 아니거나 손상되면 거부한다', () => {
    expect(() => decodePng(Buffer.from('not png'))).toThrow();
    const broken = png(2, 2, red); broken[broken.length - 13] ^= 0xff;
    expect(() => decodePng(broken)).toThrow();
  });
});

describe('야간 일정', () => {
  const at = (iso: string) => Date.parse(iso);
  test('Asia/Seoul 기준 날짜로 정한다', () => {
    expect(seoulDate(at('2026-11-26T16:59:59Z'))).toBe('2026-11-27');
    expect(seoulDate(at('2026-11-26T14:59:59Z'))).toBe('2026-11-26');
  });

  test('정한 시각이 지나고 그날 아직 하지 않았으면 그날 키를 준다', () => {
    expect(nightDue(at('2026-11-26T16:59:00Z'), '02:00', null)).toBeNull();
    expect(nightDue(at('2026-11-26T17:00:00Z'), '02:00', null)).toBe('2026-11-27');
    expect(nightDue(at('2026-11-27T03:00:00Z'), '02:00', '2026-11-27')).toBeNull();
    expect(nightDue(at('2026-11-27T03:00:00Z'), '02:00', '2026-11-26')).toBe('2026-11-27');
  });

  test('시계가 뒤로 가도 이미 한 날짜를 다시 하지 않는다', () => {
    expect(nightDue(at('2026-11-26T17:00:05Z'), '02:00', '2026-11-27')).toBeNull();
    expect(nightDue(at('2026-11-26T16:59:58Z'), '02:00', '2026-11-27')).toBeNull();
  });

  test('시각 형식이 틀리면 거부한다', () => {
    expect(() => nightDue(0, '2:00', null)).toThrow();
    expect(() => nightDue(0, '24:00', null)).toThrow();
  });
});

describe('불안정 비율 기록', () => {
  test('최근 20번 중 실패 비율을 낸다', () => {
    let history = {};
    for (let i = 0; i < 25; i++) history = recordHistory(history, { 'a': i >= 23, 'b': false });
    expect(flakyRate(history, 'a')).toBe(2 / 20);
    expect(flakyRate(history, 'b')).toBe(0);
    expect(flakyRate(history, 'none')).toBe(0);
  });
});
