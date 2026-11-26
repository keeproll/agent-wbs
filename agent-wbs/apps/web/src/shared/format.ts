/** 화면에 보이는 시각은 Asia/Seoul 기준 `YYYY-MM-DD HH:mm`(원본 nowStr P L3390과 같은 모양)으로 쓴다. */
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function formatDateTime(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  const p = Object.fromEntries(parts.formatToParts(date).map((part) => [part.type, part.value]));
  return `${p.year ?? ''}-${p.month ?? ''}-${p.day ?? ''} ${p.hour ?? ''}:${p.minute ?? ''}`;
}
