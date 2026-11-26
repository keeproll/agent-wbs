/** 화면에 보이는 시각은 Asia/Seoul 기준 `YYYY-MM-DD HH:mm`(원본 nowStr P L3390과 같은 모양)으로 쓴다. */
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function formatDateTime(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  const p = Object.fromEntries(parts.formatToParts(date).map((part) => [part.type, part.value]));
  return `${p.year ?? ''}-${p.month ?? ''}-${p.day ?? ''} ${p.hour ?? ''}:${p.minute ?? ''}`;
}

/**
 * 토큰 개수 → K 표시(1,000으로 나눠 정수로 반올림). 대시보드 등급 표와 Task 개요 「실제 실행」이 함께 쓴다.
 * 실행 기록의 tokens는 토큰 개수다(입력용 tokensK와 단위가 다르다). 예: 151,000 → 151K, 420 → 0K.
 */
export const tokensK = (n: number) => `${String(Math.round(n / 1000))}K`;
