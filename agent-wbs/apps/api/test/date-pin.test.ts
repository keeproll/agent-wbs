import { expect, test } from 'vitest';
import { datePin, verifyDatePin } from '../src/platform/date-pin.ts';
import { loadConfig } from '../src/config.ts';

test('서버 날짜 YYMMDD: 오늘만 허용하고 어제·내일·임의·잘못된 형식을 거부한다', () => {
  const at = Date.parse('2026-11-28T03:00:00Z');
  expect(datePin(at)).toBe('261128');
  expect(verifyDatePin('261128', at)).toBe(true);
  for (const pin of ['261127', '261129', '123456', '26112', '2611280', '２６１１２８', '261128\n']) {
    expect(verifyDatePin(pin, at)).toBe(false);
  }
});

test.each([
  ['2026-11-28T15:00:00Z', '261128', '261129'],
  ['2026-12-31T15:00:00Z', '261231', '270101'],
  ['2028-02-28T15:00:00Z', '280228', '280229'],
  ['2028-02-29T15:00:00Z', '280229', '280301'],
])('자정 %s 앞뒤 5초와 2.3초 역행에서도 두 날짜를 허용한다', (midnight, previous, today) => {
  const at = Date.parse(midnight);
  for (const offset of [-5_000, -2_299, 1, -2_299, 2_301, 4_999]) {
    expect(verifyDatePin(previous, at + offset)).toBe(true);
    expect(verifyDatePin(today, at + offset)).toBe(true);
  }
  expect(verifyDatePin(today, at - 5_001)).toBe(false);
  expect(verifyDatePin(previous, at + 5_000)).toBe(false);
});

test('시간대 설정은 날짜 계산에 적용되고 잘못된 시간대는 기동 전에 거부한다', () => {
  const env = { DATABASE_URL: 'postgres://u:p@127.0.0.1:26471/awbs_test_pin' };
  expect(loadConfig(env).pinTimeZone).toBe('Asia/Seoul');
  const config = loadConfig({ ...env, AWBS_PIN_TIME_ZONE: 'America/Los_Angeles' });
  const at = Date.parse('2026-11-28T03:00:00Z');
  expect(datePin(at, config.pinTimeZone)).toBe('261127');
  expect(verifyDatePin('261127', at, config.pinTimeZone)).toBe(true);
  expect(verifyDatePin('261128', at, config.pinTimeZone)).toBe(false);
  for (const timeZone of ['', 'Asia/Unknown']) {
    expect(() => loadConfig({ ...env, AWBS_PIN_TIME_ZONE: timeZone })).toThrow('AWBS_PIN_TIME_ZONE');
  }
});
