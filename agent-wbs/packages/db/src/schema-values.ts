import { sql } from 'drizzle-orm';
import { check, type AnyPgColumn } from 'drizzle-orm/pg-core';

// Fixed values come from G §4–9, P's state keys, and the coordinator's reset decision.
// null denotes an extensible label: it must have content, rather than a frozen vocabulary.
export const textValues: Record<string, Record<string, readonly string[] | null>> = {
  reset_log: { runner_cleanup_status: ['pending', 'running', 'done', 'failed'] },
  runner_commands: { status: ['pending', 'running', 'done', 'failed'] },
  counters: { kind: null },
  repo_checks: { status: ['queued', 'running', 'done', 'failed'] },
  wbs_drafts: { status: null },
  tasks: { verif_state: ['none', 'running', 'pass', 'fail', 'blocked'] },
  task_design_items: { change: null },
  task_estimates: { confidence: ['상', '중', '하'] },
  subagent_defs: { role: null },
  plannings: { status: null },
  planning_reviews: { kind: null },
  change_proposal_events: { kind: null },
  attempt_observations: { grade: ['ok', 'partial', 'unver'] },
  attempt_subagent_usage: { name: null, confirm: ['confirmed', 'partial'] },
  defect_events: { kind: null },
  task_outputs: { kind: null },
  evidence: { kind: null },
  runner_readiness: { key: null, status: ['ok', 'warn', 'fail'] },
  runner_sessions: { end_reason: ['reboot', 'power_off', 'error', 'manual', 'unknown'] },
  cli_observation_grades: { grade: ['ok', 'partial', 'unver'] },
  replan_moves: { kind: null },
  notify_rules: { key: ['done', 'fail', 'admin', 'approve', 'buildOk', 'buildFail'] },
  notify_events: { kind: null },
  notify_outbox: { kind: ['biz', 'test'] },
  notify_log: { kind: ['biz', 'test'] },
  alerts: { severity: null },
  github_settings: { mode: null, status: null },
  tech_decision_events: { kind: null },
  design_snapshots: { parse_status: null },
  design_files: { parse_status: null, format: null },
  design_items: { kind: null },
  design_edges: { kind: null },
  design_drifts: { kind: null, status: null },
  design_versions: { kind: null, status: null, compat: ['호환','깨짐','대조 안 함'] },
  messages: { dir: ['in', 'out'], type: ['추가 지시', '수정 요청', '질문', '일반 의견', '응답'] },
  // P msgs[].work is free prose (including an empty string), not an enum.
  task_history: { kind: null },
  change_events: {
    topic: [
      'task',
      'dependency',
      'attempt',
      'verification',
      'message',
      'proposal',
      'planning',
      'schedule',
      'runner',
      'ci',
      'design',
      'report',
      'mail',
      'notify',
      'alert',
      'project',
      'settings',
    ],
  },
};

export function textChecks(name: string, columns: Record<string, AnyPgColumn>) {
  return Object.entries(textValues[name] ?? {}).map(([key, values]) => {
    const column = columns[key];
    if (!column) throw new Error(`unknown column ${name}.${key}`);
    return check(
      `${name}_${key}_value`,
      values
        ? sql`${column} in (${sql.join(
            values.map((value) => sql`${value}`.inlineParams()),
            sql`, `,
          )})`
        : sql`length(btrim(${column}))>0`,
    );
  });
}
