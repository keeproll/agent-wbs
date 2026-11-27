/**
 * 보고서 기간 규칙(G§4.11 L365-369, §8.5 L944·L957, §9.6 L1045-1047, P dueReports L3871).
 *
 * - 날짜 경계는 팀장 시간대(Asia/Seoul, UTC+9)다.
 *   왜: 서버를 UTC로 돌리면 하루 경계가 9시간 어긋난다(G L1046). 서울은 서머타임이 없어 +9시간 고정으로 계산한다.
 * - 시각은 모두 UTC ISO 문자열(`2026-10-27T15:00:00.000Z`)로 주고받는다. 날짜는 `YYYY-MM-DD`다.
 */
export type ReportKind = 'daily' | 'weekly' | 'custom';

const SEOUL_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;

/** 기간 지정 보고서의 최대 길이(양 끝 포함, G L369). */
export const MAX_CUSTOM_DAYS = 93;
/** 서버 시작 때 한 번에 보충하는 정기 보고서 상한(G L1047 「예: 31일」, P L3874·L3876). */
export const BACKFILL_DAILY_LIMIT = 31;
export const BACKFILL_WEEKLY_LIMIT = 8;
/** 정기 생성 시각(서울 07:00, G L367-368). */
export const PERIODIC_HOUR = 7;

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const fromDayNumber = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/**
 * 시각 문자열을 **마이크로초 6자리 UTC**(`2026-10-27T15:00:00.123456Z`)로 맞춘다. 정밀도를 줄이지 않는다(재리뷰 2 원칙 4).
 * 왜: DB 시각은 마이크로초까지 있다. JavaScript Date로 바꾸면 밀리초로 잘려, 같은 밀리초 안의 앞선 변경이 경계 뒤로 밀린다.
 * 같은 모양의 문자열끼리는 사전순 비교가 시각 순서와 같다.
 */
export function toMicro(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(iso);
  if (!m) throw new RangeError(`시각 형식이 아닙니다: ${iso}`);
  const [, day = '', time = '', frac = '', zone = 'Z'] = m;
  const digits = frac.slice(1).padEnd(6, '0');
  if (digits.length > 6) throw new RangeError(`마이크로초보다 정밀한 시각은 받지 않습니다: ${iso}`);
  const zoneText = zone === 'Z' ? 'Z' : zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const seconds = new Date(`${day}T${time}${zoneText}`).toISOString().slice(0, 19);
  return `${seconds}.${digits}Z`;
}

/** 시각이 속한 서울 날짜. */
export const seoulDay = (instant: string | Date): string =>
  new Date((typeof instant === 'string' ? Date.parse(instant) : instant.getTime()) + SEOUL_MS).toISOString().slice(0, 10);
/** 서울 날짜의 00:00을 UTC 시각으로. */
export const seoulMidnight = (day: string): string => toMicro(new Date(dayNumber(day) * DAY_MS - SEOUL_MS).toISOString());
/** 서울 날짜의 hh:00을 UTC 시각으로. */
export const seoulAt = (day: string, hour: number): string => toMicro(new Date(dayNumber(day) * DAY_MS - SEOUL_MS + hour * 3_600_000).toISOString());
export const addDays = (day: string, n: number): string => fromDayNumber(dayNumber(day) + n);
/** 두 날짜의 차이(일). to - from */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);
/** 그 주의 월요일(월=0 … 일=6). */
export const mondayOf = (day: string): string => addDays(day, -((new Date(dayNumber(day) * DAY_MS).getUTCDay() + 6) % 7));

/**
 * 보고서가 세는 구간 [start, end). start는 from 00:00, end는 (to 다음 날 00:00)과 생성 시각 중 이른 쪽(P report L3802).
 * 왜 생성 시각까지인가: 기간이 오늘을 포함하면 아직 일어나지 않은 일은 셀 수 없다.
 */
export function periodBounds(from: string, to: string, at: string): { start: string; end: string } {
  const end = seoulMidnight(addDays(to, 1));
  const now = toMicro(at);
  return { start: seoulMidnight(from), end: now < end ? now : end };
}

export interface PeriodProblem { path: 'from' | 'to'; rule: 'order' | 'future' | 'maxDays'; message: string }

/** 기간 지정 입력 검사(contracts §2.3, P createReport L4991). 문제가 없으면 null. 날짜 형식은 계약 스키마가 먼저 검사한다. */
export function customPeriodProblem(from: string, to: string, today: string): PeriodProblem | null {
  if (from > to) return { path: 'from', rule: 'order', message: '시작일이 종료일보다 늦습니다.' };
  if (to > today) return { path: 'to', rule: 'future', message: '종료일은 오늘 이후일 수 없습니다.' };
  if (daysBetween(from, to) + 1 > MAX_CUSTOM_DAYS) return { path: 'to', rule: 'maxDays', message: `기간은 최대 ${String(MAX_CUSTOM_DAYS)}일입니다.` };
  return null;
}

export interface DuePeriod { kind: 'daily' | 'weekly'; from: string; to: string; dueAt: string }

/**
 * 지금까지 만들어졌어야 하는 정기 보고서 중 아직 없는 것(P dueReports L3871-3878).
 * - lastDaily·lastWeekly: 이미 만든 마지막 보고서의 `to`. 없으면 프로젝트 시작일부터 센다.
 * - 일간: 어제까지(오늘 07:00 전이면 그제까지). 주간: 월요일 07:00이 지난 지난주까지.
 * - 오래된 것부터 상한만큼 넣는다. 나머지는 다음 점검 때 이어서 만든다.
 * - 첫 주간은 프로젝트 시작일이 든 주의 월요일부터다. [결정] 원본은 시작일부터 7일을 한 주로 셌다(P L3876). 가이드는 「지난주 월~일」이다(G L368).
 */
export function duePeriodic(input: { now: string; start: string; lastDaily: string | null; lastWeekly: string | null }): DuePeriod[] {
  const out: DuePeriod[] = [];
  const nowMs = Date.parse(input.now);
  const today = seoulDay(input.now);
  const lastDue = nowMs >= Date.parse(seoulAt(today, PERIODIC_HOUR)) ? addDays(today, -1) : addDays(today, -2);
  for (let day = input.lastDaily ? addDays(input.lastDaily, 1) : input.start, k = 0; day <= lastDue && k < BACKFILL_DAILY_LIMIT; day = addDays(day, 1), k++) {
    out.push({ kind: 'daily', from: day, to: day, dueAt: seoulAt(addDays(day, 1), PERIODIC_HOUR) });
  }
  for (let mon = input.lastWeekly ? addDays(input.lastWeekly, 1) : mondayOf(input.start), k = 0; k < BACKFILL_WEEKLY_LIMIT; mon = addDays(mon, 7), k++) {
    const sun = addDays(mon, 6);
    const dueAt = seoulAt(addDays(sun, 1), PERIODIC_HOUR);
    if (Date.parse(dueAt) > nowMs) break;
    out.push({ kind: 'weekly', from: mon, to: sun, dueAt });
  }
  return out;
}

/** 보고서 번호(P mkReport L3880). 정기: `RPT-D-261027`(기간 시작일), 기간 지정: `RPT-C-001`(순번). */
export function reportKey(kind: ReportKind, from: string, seq = 0): string {
  if (kind === 'custom') return `RPT-C-${String(seq).padStart(3, '0')}`;
  return `RPT-${kind === 'daily' ? 'D' : 'W'}-${from.replaceAll('-', '').slice(2)}`;
}
