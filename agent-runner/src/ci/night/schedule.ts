/** Asia/Seoul은 서머타임이 없어 UTC+9로 고정이다. */
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;

export function seoulDate(now: number): string {
  return new Date(now + SEOUL_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 야간 점검을 시작할 날짜(멱등 키 `night:<date>`의 date)를 준다. 아직 아니면 null.
 * 정한 시각이 지났고 그날 아직 시작하지 않았으면 시작한다. Runner가 꺼져 있다가 늦게 켜져도 그날 한 번 한다.
 * 이미 시작한 날짜 이하이면 다시 하지 않는다. 왜: 이 PC처럼 시계가 뒤로 가도 같은 날을 두 번 돌리지 않는다.
 */
export function nightDue(now: number, nightAt: string, lastDate: string | null): string | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(nightAt);
  if (!match) throw new TypeError('야간 점검 시각 형식이 올바르지 않습니다.');
  const local = new Date(now + SEOUL_OFFSET_MS);
  const date = local.toISOString().slice(0, 10);
  if (lastDate !== null && date <= lastDate) return null;
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  return minutes >= Number(match[1]) * 60 + Number(match[2]) ? date : null;
}
