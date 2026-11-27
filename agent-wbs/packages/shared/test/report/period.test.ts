import { describe, expect, test } from 'vitest';
import {
  addDays, customPeriodProblem, duePeriodic, MAX_CUSTOM_DAYS, periodBounds, reportKey, seoulDay, seoulMidnight, toMicro,
} from '@awbs/shared';

// 보고서 기간 규칙(G§4.11 L365-369, §8.5 L944·L957, §9.6 L1045-1047, P dueReports L3871).
describe('서울(Asia/Seoul) 날짜 경계', () => {
  test('자정 직전·직후 시각은 서로 다른 날이다(UTC로 계산하면 9시간 어긋난다)', () => {
    expect(seoulDay('2026-10-27T14:59:59.999Z')).toBe('2026-10-27');
    expect(seoulDay('2026-10-27T15:00:00.000000Z')).toBe('2026-10-28');
    expect(seoulMidnight('2026-10-28')).toBe('2026-10-27T15:00:00.000000Z');
  });
  test('기간의 끝은 다음 날 00:00과 생성 시각 중 이른 쪽이다(P report L3802)', () => {
    expect(periodBounds('2026-10-27', '2026-10-27', '2026-10-28T07:00:00.000000Z')).toEqual({ start: '2026-10-26T15:00:00.000000Z', end: '2026-10-27T15:00:00.000000Z' });
    expect(periodBounds('2026-10-26', '2026-10-28', '2026-10-28T03:00:00.000000Z').end).toBe('2026-10-28T03:00:00.000000Z');
  });
  test('마이크로초를 줄이지 않는다: 생성 시각이 경계면 마이크로초 그대로(재리뷰 2 문제 4)', () => {
    expect(periodBounds('2027-01-09', '2027-01-10', '2027-01-10T00:00:00.100900Z').end).toBe('2027-01-10T00:00:00.100900Z');
    // 같은 밀리초 안: 앞선 변경(…100100)은 경계 전, 경계와 같은 값·뒤의 값은 경계 전이 아니다
    const end = periodBounds('2027-01-09', '2027-01-10', '2027-01-10T00:00:00.100900Z').end;
    expect(['2027-01-10T00:00:00.100100Z', '2027-01-10T00:00:00.100900Z', '2027-01-10T00:00:00.100901Z'].map((v) => v < end)).toEqual([true, false, false]);
  });
  test('toMicro: 자리 수·시간대가 달라도 같은 모양, 더 정밀하면 거부', () => {
    expect(toMicro('2026-10-27T15:00:00Z')).toBe('2026-10-27T15:00:00.000000Z');
    expect(toMicro('2026-10-27T15:00:00.5Z')).toBe('2026-10-27T15:00:00.500000Z');
    expect(toMicro('2026-10-28T00:00:00.123456+09:00')).toBe('2026-10-27T15:00:00.123456Z');
    expect(toMicro('2026-10-27 15:00:00.1+00')).toBe('2026-10-27T15:00:00.100000Z');
    expect(() => toMicro('2026-10-27T15:00:00.1234567Z')).toThrow();
  });
  test('날짜 더하기는 달·해 경계를 넘는다', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('기간 지정 보고서 입력 검사(contracts §2.3: from ≤ to ≤ 오늘, 최대 93일)', () => {
  const today = '2026-11-03';
  test('정상 기간은 문제 없음', () => {
    expect(customPeriodProblem('2026-10-27', '2026-11-02', today)).toBeNull();
    expect(customPeriodProblem(today, today, today)).toBeNull();
  });
  test('시작이 끝보다 늦으면 거부', () => { expect(customPeriodProblem('2026-11-02', '2026-11-01', today)?.path).toBe('from'); });
  test('끝이 오늘보다 뒤면 거부', () => { expect(customPeriodProblem('2026-11-01', '2026-11-04', today)?.path).toBe('to'); });
  test('양 끝 포함 93일까지 허용, 94일은 거부', () => {
    expect(MAX_CUSTOM_DAYS).toBe(93);
    expect(customPeriodProblem(addDays(today, -92), today, today)).toBeNull();
    expect(customPeriodProblem(addDays(today, -93), today, today)?.rule).toBe('maxDays');
  });
});

describe('정기 보고서 예정 목록(일간 매일 07:00·주간 월요일 07:00, 누락 보충 상한)', () => {
  test('07:00 전에는 어제 일간이 아직 예정이 아니다', () => {
    const due = duePeriodic({ now: '2026-10-28T21:59:00.000000Z', start: '2026-10-27', lastDaily: '2026-10-27', lastWeekly: null });
    // 서울 10-29 06:59 → 10-28 일간은 아직 아님
    expect(due.filter((d) => d.kind === 'daily')).toEqual([]);
  });
  test('07:00이 되면 어제 일간이 예정이고, 예정 시각은 다음 날 07:00(서울)이다', () => {
    const due = duePeriodic({ now: '2026-10-28T22:00:00.000000Z', start: '2026-10-27', lastDaily: '2026-10-27', lastWeekly: null });
    expect(due.filter((d) => d.kind === 'daily')).toEqual([{ kind: 'daily', from: '2026-10-28', to: '2026-10-28', dueAt: '2026-10-28T22:00:00.000000Z' }]);
  });
  test('주간은 지난주 월~일이고 월요일 07:00에 예정이다', () => {
    // 2026-11-02는 월요일. 서울 11-02 07:00 = UTC 11-01 22:00
    const before = duePeriodic({ now: '2026-11-01T21:59:00.000000Z', start: '2026-10-27', lastDaily: '2026-11-01', lastWeekly: null });
    expect(before.filter((d) => d.kind === 'weekly')).toEqual([]);
    const at = duePeriodic({ now: '2026-11-01T22:00:00.000000Z', start: '2026-10-27', lastDaily: '2026-11-01', lastWeekly: null });
    expect(at.filter((d) => d.kind === 'weekly')).toEqual([{ kind: 'weekly', from: '2026-10-26', to: '2026-11-01', dueAt: '2026-11-01T22:00:00.000000Z' }]);
  });
  test('이미 만든 기간 다음부터만 예정에 넣는다(중복 0)', () => {
    const due = duePeriodic({ now: '2026-11-03T00:00:00.000000Z', start: '2026-10-27', lastDaily: '2026-11-02', lastWeekly: '2026-11-01' });
    expect(due).toEqual([]);
  });
  test('서버가 오래 꺼져 있어도 일간은 31건까지만 한 번에 보충한다(G L1047)', () => {
    const due = duePeriodic({ now: '2027-02-01T00:00:00.000000Z', start: '2026-10-01', lastDaily: null, lastWeekly: null });
    const daily = due.filter((d) => d.kind === 'daily');
    expect(daily).toHaveLength(31);
    expect(daily[0]?.from).toBe('2026-10-01');
    expect(due.filter((d) => d.kind === 'weekly').length).toBeLessThanOrEqual(8);
  });
});

test('보고서 번호(P mkReport L3880): 정기는 기간 시작일, 기간 지정은 순번', () => {
  expect(reportKey('daily', '2026-10-27')).toBe('RPT-D-261027');
  expect(reportKey('weekly', '2026-10-26')).toBe('RPT-W-261026');
  expect(reportKey('custom', '2026-10-01', 3)).toBe('RPT-C-003');
});
