/** 권장 상한 공식의 상수(G §6.6). [Mock 추정] 값이라 설정으로 바꿀 수 있게 입력으로 받는다. */
export interface CapConstants {
  baseGb: number;
  minTotal: number;
  maxTotal: number;
  perAgentRatio: number;
  coresPerHeavy: number;
}

export const DEFAULT_CAP_CONSTANTS: CapConstants = {
  baseGb: 3,
  minTotal: 2,
  maxTotal: 64,
  perAgentRatio: 0.75,
  coresPerHeavy: 3,
};
export const DEFAULT_MEM_RESERVE_GB = 4;
/** 관측 전 세션당 평균 메모리 */
export const INITIAL_SESSION_GB = 1;

export interface HostSpec {
  cores: number;
  memGb: number;
  diskGb: number;
  /** 관측 세션 평균 메모리. 관측 전이면 null. */
  perSessionGb: number | null;
}

export interface Caps {
  total: number;
  perAgent: { Claude: number; Codex: number };
  heavy: number;
}

export type CapWarning =
  /** 디스크 여유 50GB 미만 (P `recCap`) */
  | 'DISK_LOW'
  /** 메모리 기준으로 2개도 나오지 않아 최소값을 썼음 */
  | 'MEMORY_TIGHT'
  /** 공식 결과가 0이라 무거운 작업을 실행할 수 없음 */
  | 'HEAVY_ZERO';

// 부동소수 오차로 0.6/0.2가 2가 되는 것을 막는다.
const floor = (n: number): number => Math.floor(n + 1e-9);
const ceil = (n: number): number => Math.ceil(n - 1e-9);

const requireNumber = (name: string, n: number, positive: boolean): void => {
  if (!Number.isFinite(n) || n < 0 || (positive && n === 0)) {
    throw new RangeError(`${name} 값이 올바르지 않습니다: ${String(n)}`);
  }
};

export function recommendedCaps(
  host: HostSpec,
  memReserveGb: number,
  c: CapConstants = DEFAULT_CAP_CONSTANTS,
): { caps: Caps; warnings: CapWarning[] } {
  const session = host.perSessionGb ?? INITIAL_SESSION_GB;
  requireNumber('cores', host.cores, true);
  requireNumber('memGb', host.memGb, true);
  requireNumber('diskGb', host.diskGb, false);
  requireNumber('perSessionGb', session, true);
  requireNumber('memReserveGb', memReserveGb, false);

  const raw = (host.memGb - c.baseGb - memReserveGb) / session;
  const total = Math.max(c.minTotal, Math.min(c.maxTotal, floor(raw)));
  const perAgent = ceil(total * c.perAgentRatio);
  const heavy = Math.min(total, floor(host.cores / c.coresPerHeavy));

  const warnings: CapWarning[] = [];
  if (host.diskGb < 50) warnings.push('DISK_LOW');
  if (raw + 1e-9 < 2) warnings.push('MEMORY_TIGHT');
  if (heavy === 0) warnings.push('HEAVY_ZERO');
  return { caps: { total, perAgent: { Claude: perAgent, Codex: perAgent }, heavy }, warnings };
}

export interface CapOverrun {
  key: 'total' | 'heavy' | 'Claude' | 'Codex';
  set: number;
  recommended: number;
}

/** 자동이면 권장값, 직접 지정이면 팀장 값을 유지하고 권장값을 넘는 항목을 알린다. */
export function effectiveCaps(
  mode: 'auto' | 'manual',
  manual: Caps,
  recommended: Caps,
): { caps: Caps; overruns: CapOverrun[] } {
  if (mode === 'auto') return { caps: recommended, overruns: [] };
  const rows: [CapOverrun['key'], number, number][] = [
    ['total', manual.total, recommended.total],
    ['heavy', manual.heavy, recommended.heavy],
    ['Claude', manual.perAgent.Claude, recommended.perAgent.Claude],
    ['Codex', manual.perAgent.Codex, recommended.perAgent.Codex],
  ];
  return {
    caps: manual,
    overruns: rows.filter(([, s, r]) => s > r).map(([key, set, rec]) => ({ key, set, recommended: rec })),
  };
}
