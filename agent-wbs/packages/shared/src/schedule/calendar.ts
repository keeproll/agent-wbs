const DAY = 86_400_000;
const KST = 9 * 3_600_000;

export function instant(value: string): number {
  const time = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(time)) {
    throw new RangeError(`Expected an ISO timestamp with timezone: ${value}`);
  }
  date(value.slice(0, 10));
  return (time + KST) / DAY;
}

export function date(value: string): number {
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new RangeError(`Expected a calendar date: ${value}`);
  }
  return time / DAY;
}

export function ymd(day: number): string {
  return new Date(Math.floor(day) * DAY).toISOString().slice(0, 10);
}

export function finite(value: number, minimum: number, name: string, maximum = Infinity): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`Invalid ${name}: ${value}`);
  }
}

export function calendar(now: number, rate: number, blackouts: ReadonlySet<number>) {
  const today = Math.floor(now);
  return {
    effectiveAt(time: number): number {
      if (time <= now) return 0;
      let hours = (time - now) * 24;
      for (const day of blackouts) hours -= Math.max(0, Math.min(day + 1, time) - Math.max(day, now)) * 24;
      return Math.max(0, hours * rate);
    },
    dayAt(hours: number, start = false): string {
      let day = today;
      let capacity = blackouts.has(day) ? 0 : (day + 1 - now) * 24 * rate;
      while (hours > capacity + 1e-9 || (start && hours >= capacity - 1e-9)) {
        hours -= capacity;
        day++;
        capacity = blackouts.has(day) ? 0 : 24 * rate;
      }
      return ymd(day);
    },
  };
}
