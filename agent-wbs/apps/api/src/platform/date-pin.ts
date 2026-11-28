import { timingSafeEqual } from 'node:crypto';

export const DEFAULT_PIN_TIME_ZONE = 'Asia/Seoul';
// 자정 앞뒤 5초는 두 날짜를 받아 이 PC의 약 2.3초 시계 역행을 흡수한다.
const GRACE_MS = 5_000;

export function datePin(at: number, timeZone = DEFAULT_PIN_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, calendar: 'gregory', numberingSystem: 'latn', year: '2-digit', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('');
}

export function verifyDatePin(pin: string, at: number, timeZone = DEFAULT_PIN_TIME_ZONE): boolean {
  if (pin.length !== 6 || !/^[0-9]{6}$/.test(pin)) return false;
  const input = Buffer.from(pin);
  // 세 후보를 모두 상수 시간으로 비교한다. 앞뒤 시각에서 날짜를 구하므로 월말·윤년·시간대 변경도 같다.
  return [-GRACE_MS, 0, GRACE_MS].map(offset =>
    Number(timingSafeEqual(input, Buffer.from(datePin(at + offset, timeZone)))),
  ).reduce((matched, value) => matched | value, 0) !== 0;
}
