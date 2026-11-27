/** 테스트별 최근 야간 점검 결과(true=그날 한 번이라도 실패). 오래된 것부터 담는다. */
export type FlakyHistory = Record<string, boolean[]>;
export const HISTORY_WINDOW = 20;

/** 이번 야간 결과를 더한다. 화면의 「2 / 20 실패」처럼 최근 20번만 센다. */
export function recordHistory(history: FlakyHistory, outcomes: Record<string, boolean>): FlakyHistory {
  const next: FlakyHistory = {};
  for (const [key, values] of Object.entries(history)) next[key] = [...values];
  for (const [key, failed] of Object.entries(outcomes)) next[key] = [...(next[key] ?? []), failed].slice(-HISTORY_WINDOW);
  return next;
}

export function flakyRate(history: FlakyHistory, key: string): number {
  const values = Object.hasOwn(history, key) ? history[key] ?? [] : [];
  return values.length ? values.filter(Boolean).length / values.length : 0;
}

export function parseHistory(value: unknown): FlakyHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('불안정 기록이 손상되었습니다.');
  for (const values of Object.values(value)) {
    if (!Array.isArray(values) || values.length > HISTORY_WINDOW || values.some(v => typeof v !== 'boolean')) throw new TypeError('불안정 기록이 손상되었습니다.');
  }
  return value as FlakyHistory;
}
