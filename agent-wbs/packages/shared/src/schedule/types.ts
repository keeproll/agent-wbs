import type { Dependency } from '../domain/types.ts';
import type { Agent, TaskStatus } from '../vocabulary.ts';

export type { Agent, Dependency };

export const STAGE_PCT = {
  planning: 0, approval: 0, ready: 0, failed: 20, running: 35, paused: 40,
  rework: 50, qa: 65, verifying: 80, gate: 90, done: 100, cancelled: 0,
} as const satisfies Record<TaskStatus, number>;

export interface ScheduleTask {
  id: string;
  wbs: string;
  status: TaskStatus;
  priority: number;
  assignee: Agent;
  est: number;
  lo: number;
  hi: number;
  cg?: string;
  fixStart?: string;
  actStart?: string;
  actEnd?: string;
}

// Instants are UTC/offset ISO strings; calendar dates and day boundaries use Asia/Seoul.
export interface RunnerSession {
  from: string;
  to?: string;
  // Without a first heartbeat, only the session start is known to be online.
  lastHeartbeatAt?: string;
}

export interface ScheduleCapacityPolicy {
  windowDays: number;
  minHours: number;
  minRate: number;
  lowRateFactor: number;
  highRateFactor: number;
  lowQuantile: number;
  highQuantile: number;
}

// P capacity: seven days, 72h, 5% floor, 0.6/1.3 factors, sorted ranks 1 and 5 out of 7.
export const DEFAULT_SCHEDULE_CAPACITY_POLICY: Readonly<ScheduleCapacityPolicy> = Object.freeze({
  windowDays: 7, minHours: 72, minRate: 0.05, lowRateFactor: 0.6, highRateFactor: 1.3,
  lowQuantile: 1 / 6, highQuantile: 5 / 6,
});

export interface ScheduleInput {
  now: string;
  tasks: readonly ScheduleTask[];
  deps: readonly Dependency[];
  sessions: readonly RunnerSession[];
  assumeRate: number;
  policy?: Partial<ScheduleCapacityPolicy>;
  // D-21 defaults: 60 seconds, three misses; open intervals close at their last heartbeat.
  heartbeat?: { intervalSec: number; missLimit: number };
  blackouts: readonly string[];
  concurrency: { total: number; current: number; subRatio: number; Claude: number; Codex: number };
  usage: Partial<Record<Agent, { remain: number; resetAt?: string }>>;
}

export interface EffectivePeriod { s: number; e: number }
export interface ScheduleItem {
  start: string;
  end: string;
  lo: string;
  hi: string;
  pct: number;
  done: boolean;
  mid: EffectivePeriod;
  optimistic: EffectivePeriod;
  pessimistic: EffectivePeriod;
}

export interface ScheduleResult {
  warnings: ScheduleWarning[];
  by: Record<string, ScheduleItem>;
  capacity: {
    warnings: ScheduleWarning[];
    days: { date: string; rate: number }[];
    measured: number;
    enough: boolean;
    logged: number;
    rate: number;
    rLo: number;
    rHi: number;
    todayRate: number;
  };
  project: {
    end: string;
    lo: string;
    hi: string;
    total: number;
    remain: number;
    progress: number;
    doneN: number;
    n: number;
    doneRate: number;
    doneEstRate: number;
  };
}

export type ScheduleWarning = {
  code: 'USAGE_RESET_UNKNOWN';
  agent: Agent;
} | {
  code: 'CLOCK_SKEW_CLAMPED';
  taskId: string;
  field: 'actStart' | 'actEnd';
  before: string;
  after: string;
} | {
  code: 'CLOCK_SKEW_CLAMPED';
  sessionFrom: string;
  field: 'lastHeartbeatAt' | 'to';
  before: string;
  after: string;
};

export interface Baseline {
  v: number;
  at: string;
  trigger: string;
  actor: string;
  rate: number;
  rLo: number;
  rHi: number;
  end: string;
  lo: string;
  hi: string;
  items: Record<string, { start: string; end: string; lo: string; hi: string }>;
}

export interface ReplanMove {
  task: string;
  kind: 'delayed' | 'advanced' | 'new' | 'excluded';
  before: Baseline['items'][string] | null;
  after: Baseline['items'][string] | null;
  delta: number | null;
}

export interface ReplanResult {
  warnings: ScheduleWarning[];
  status: 'applied' | 'pending';
  at: string;
  trigger: string;
  actor: string;
  before: string | null;
  after: string;
  lo: string;
  hi: string;
  rate: number;
  moves: ReplanMove[];
  baseline: Baseline | null;
}
