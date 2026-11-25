export const STAGE_PCT = {
  planning: 0, approval: 0, ready: 0, failed: 20, running: 35, paused: 40,
  rework: 50, qa: 65, verifying: 80, gate: 90, done: 100, cancelled: 0,
} as const;

export type Agent = 'Claude' | 'Codex';

export interface ScheduleTask {
  id: string;
  wbs: string;
  status: keyof typeof STAGE_PCT;
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

export interface Dependency {
  pred: string;
  succ: string;
  type: 'FS' | 'SS';
}

// Instants are UTC/offset ISO strings; calendar dates and day boundaries use Asia/Seoul.
export interface RunnerSession {
  from: string;
  to?: string;
}

export interface ScheduleInput {
  now: string;
  tasks: readonly ScheduleTask[];
  deps: readonly Dependency[];
  sessions: readonly RunnerSession[];
  assumeRate: number;
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
  by: Record<string, ScheduleItem>;
  capacity: {
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
  kind: 'delayed' | 'advanced' | 'new' | 'excluded' | 'shifted';
  before: Baseline['items'][string] | null;
  after: Baseline['items'][string] | null;
  delta: number | null;
}

export interface ReplanResult {
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
