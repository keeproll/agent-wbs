// API(계약) 값과 DB 저장 값이 다른 곳의 변환. 같은 철자는 변환하지 않는다(contracts §1 값 철자).
import type { ExecPolicy, SplitSettings } from '@awbs/shared';

/** API CI 단계 → ci_runs.stage(1~4). 순서는 contracts의 task/int/night/deploy */
export const CI_STAGE = { task: 1, int: 2, night: 3, deploy: 4 } as const;
/** API 설계 불일치 compat → design_drifts·design_versions.compat(화면 문구) */
export const DRIFT_COMPAT = { compatible: '호환', breaking: '깨짐', unchecked: '대조 안 함' } as const;
/** API 관측 등급 → attempt_observations·cli_observation_grades.grade(P 키) */
export const OBSERVATION_GRADE = { verified: 'ok', partial: 'partial', unverified: 'unver' } as const;

/** DB 값 → API 값. 모르는 값은 저장 오류이므로 던진다. */
export function fromDb<const M extends Record<string, string | number>>(map: M, value: unknown): keyof M {
  const found = Object.entries(map).find(([, stored]) => stored === value)?.[0];
  if (found === undefined) throw new RangeError(`알 수 없는 저장 값: ${String(value)}`);
  return found;
}

export interface ExecPolicyRow {
  on_usage: ExecPolicy['onUsage'];
  low_pct: number | null;
  on_rework: ExecPolicy['onRework'];
  esc_notify: number;
  floors: ExecPolicy['floors'];
  auto_retry_limit: number;
  auto_rework_limit: number;
}

/**
 * exec_policy 행 → API 실행 정책. esc_notify는 계약의 notifyAt이다.
 * low_pct는 「낮춰서 진행」을 고르기 전에는 저장하지 않으므로 도메인 기본값(M1-06 DEFAULT_EXEC_POLICY)으로 채운다.
 * DB 패키지는 공통 패키지를 타입으로만 쓰므로 기본값은 호출자가 넘긴다.
 */
export function execPolicyToApi(row: ExecPolicyRow, defaults: Pick<ExecPolicy, 'lowPct'>) {
  return {
    onUsage: row.on_usage, lowPct: row.low_pct ?? defaults.lowPct, onRework: row.on_rework,
    notifyAt: row.esc_notify, floors: row.floors, autoRetryLimit: row.auto_retry_limit, autoReworkLimit: row.auto_rework_limit,
  };
}

/** app_settings.split(P 키 maxH·minH·on) → 도메인 분할 기준 */
export function splitSettingsToDomain(split: Record<string, unknown>): SplitSettings {
  return {
    maxHours: split.maxH as number, minHours: split.minH as number, maxFiles: split.maxFiles as number,
    enabled: split.on as SplitSettings['enabled'],
  };
}

/** Runner가 보낸 보유 정리 증거. 키는 complete_cleanup()이 읽는 이름이다. */
export interface CleanupProof {
  job: string;
  hostId: string | null;
  bootId: string | null;
  proof: 'no_process' | 'group_empty' | 'boot_changed';
  /** 예약만 하고 프로세스를 만들지 않은 보유가 부팅 변경으로 끝나면 null이다(API boot_changed). */
  processGroup?: number | null;
  currentBootId?: string;
}
export interface CommandResultBody {
  status: 'done' | 'failed';
  items: readonly { name: string; ok: boolean; detail: string }[];
  holds?: readonly CleanupProof[];
}

/** POST /runner/commands/:id/result 본문 → complete_cleanup(…, succeeded, result) 인자 */
export function cleanupResult({ status, items, holds = [] }: CommandResultBody) {
  return { succeeded: status === 'done', result: { items, holds } };
}
