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
  proof: 'no_process' | 'group_empty' | 'cgroup_empty' | 'boot_changed';
  /** 예약만 하고 프로세스를 만들지 않은 보유가 부팅 변경으로 끝나면 null이다(API boot_changed). */
  processGroup?: number | null;
  currentBootId?: string;
  /** cgroup_empty: 보유에 기록된 cgroup 경로(0040). */
  cgroup?: string;
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

/**
 * runner_commands.payload를 API 본문으로 내보내는 SELECT 식. holds[]의 시각(closed_at·created_at·updated_at)만 계약 Timestamp(UTC, Z)로 바꾼다.
 * 왜: reset_project()는 보유 행을 to_jsonb로 그대로 담아 시각이 `2026-11-27T03:07:56.40799+00:00`처럼 나온다.
 * M5-02가 holds[]를 ExecutionHold(Timestamp 형식)로 계약에 묶었으므로, DB 함수를 다시 만들지 않고 내보낼 때 형식만 맞춘다.
 * 다른 필드와 holds가 없는 payload는 그대로 둔다.
 */
export const COMMAND_PAYLOAD_SQL = `case when jsonb_typeof(payload->'holds')='array' then jsonb_set(payload,'{holds}',(
  select coalesce(jsonb_agg(e.h || coalesce((select jsonb_object_agg(k,to_char((e.h->>k)::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    from unnest(array['closed_at','created_at','updated_at']) k where jsonb_typeof(e.h->k)='string'),'{}'::jsonb) order by e.n),'[]'::jsonb)
  from jsonb_array_elements(payload->'holds') with ordinality e(h,n))) else payload end`;
