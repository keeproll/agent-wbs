/**
 * 보고서가 읽는 표 — **한 곳의 목록**(재리뷰 2 원칙 3).
 *
 * - 마이그레이션 0036이 이 목록의 표마다 기록 트리거를 단다. 목록과 트리거가 다르면 시험(apps/api/test/report-tracked.db.test.ts)이 실패한다.
 * - 보고서 계산(snapshot.ts·state.ts)은 이 목록의 표를 `rel()`로만 읽는다. 다른 표를 직접 읽으면 같은 시험이 실패한다.
 *   예외는 아래 FALLBACK_CURRENT(기록이 시작되기 전 시점의 설정 확인)뿐이다.
 * - 왜 한 곳인가: 표를 하나 빠뜨리면 그 표의 값만 「지금 값」으로 섞여 과거 보고서가 조용히 틀린다(재리뷰 2 문제 3: 알림·실행 PC 세션).
 */
/** 프로젝트 행만 있는 표 → state_log */
export const PROJECT_TABLES = [
  'projects', 'wbs_nodes', 'tasks', 'task_specs', 'task_dependencies', 'checklist_items', 'task_outputs', 'task_grades',
  'task_estimates', 'task_attempts', 'attempt_files', 'verifications', 'verification_invalidations', 'defects', 'defect_events',
  'evidence', 'input_versions', 'messages', 'change_proposals', 'ci_runs', 'replans', 'replan_moves', 'schedule_baselines', 'baseline_items',
] as const;
/** 프로젝트가 없는 표(설정·실행 PC) → global_log */
export const GLOBAL_TABLES = [
  'runner_sessions', 'runner_hosts', 'runner_concurrency_log', 'agent_usage',
  'schedule_policy', 'blackout_days', 'app_settings', 'concurrency_settings',
] as const;
/** 행마다 프로젝트가 있거나 없는 표(전역 알림) → 두 이력을 합쳐 읽는다 */
export const MIXED_TABLES = ['alerts'] as const;

export const TRACKED = [...PROJECT_TABLES, ...GLOBAL_TABLES, ...MIXED_TABLES] as const;
export type TrackedTable = (typeof TRACKED)[number];
/** 이력 자체의 표(보고서가 읽어도 되는 표) */
export const LOG_TABLES = ['state_log', 'global_log', 'commit_log'] as const;
/**
 * 기록이 시작되기 전 시점일 때만 「지금 값이 그때도 같았나」를 확인하려고 지금 표를 읽는 설정 표(state.ts settingsAt).
 * 확인하지 못하면 보고서에 「설정은 현재 값」으로 표시한다.
 */
export const FALLBACK_CURRENT = ['schedule_policy', 'blackout_days', 'app_settings', 'concurrency_settings'] as const;
