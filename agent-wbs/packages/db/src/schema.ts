import { sql } from 'drizzle-orm';
import { textChecks } from './schema-values.ts';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  bigint,
  bigserial,
  boolean,
  timestamp,
  date,
  numeric,
  jsonb,
  check,
  unique,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const agent = pgEnum('agent', ['Claude', 'Codex']);
export const role = pgEnum('task_role', ['dev', 'qa']);
export const taskStatus = pgEnum('task_status', [
  'planning',
  'approval',
  'ready',
  'running',
  'qa',
  'verifying',
  'rework',
  'paused',
  'failed',
  'gate',
  'done',
  'cancelled',
]);
export const workType = pgEnum('work_type', [
  'Analysis',
  'Design',
  'Implementation',
  'Configuration',
  'Test',
  'Verification',
  'Documentation',
  'Integration',
]);
export const domain = pgEnum('domain', [
  'FE',
  'BE',
  'DB',
  'DevOps',
  'API',
  'QA',
  'Architecture',
  'Common',
]);
export const attemptKind = pgEnum('attempt_kind', ['dev', 'qa', 'rework', 'reverify']);
export const attemptStatus = pgEnum('attempt_status', [
  'running',
  'completed',
  'failed',
  'interrupted',
]);
export const verificationResult = pgEnum('verification_result', ['PASS', 'FAIL', 'BLOCKED']);
export const jobState = pgEnum('job_state', [
  'queued',
  'leased',
  'started',
  'reconcile',
  'done',
  'failed',
  'cancelled',
]);
export const jobKind = pgEnum('job_kind', [
  'repo_check',
  'bootstrap',
  'input_diff',
  'planning',
  'estimate',
  'split',
  'attempt',
  'stop_attempt',
  'integrate',
  'deploy_check',
  'ci_retry',
  'design_apply',
  'merge_followup',
  'github_check',
]);
export const slotState = pgEnum('slot_state', ['none', 'reserved', 'active', 'unconfirmed']);
export const lockState = pgEnum('lock_state', [
  'none',
  'held',
  'handed_over',
  'released',
  'orphaned',
]);
export const releaseProof = pgEnum('release_proof', ['no_process', 'group_empty', 'boot_changed']);
export const cleanupStatus = pgEnum('cleanup_status', ['none', 'pending', 'running', 'failed']);
export const deliveryState = pgEnum('delivery_state', [
  'queued',
  'sending',
  'accepted',
  'retry_wait',
  'failed',
  'unknown',
]);
export const messageDelivery = pgEnum('message_delivery', [
  'Draft',
  'Queued',
  'Sent',
  'Acknowledged',
  'Cancelled',
  'Failed',
]);
export const proposalStatus = pgEnum('proposal_status', [
  'draft',
  'review',
  'approved',
  'applied',
  'changes',
  'rejected',
  'held',
]);
export const ciStatus = pgEnum('ci_status', ['queued', 'run', 'pass', 'fail', 'skip']);
export const queueStatus = pgEnum('queue_status', [
  'waiting_verify',
  'queued',
  'checking',
  'merged',
  'failed',
  'removed',
]);
export const nodeKind = pgEnum('node_kind', ['phase', 'work_package']);
export const dependencyType = pgEnum('dependency_type', ['FS', 'SS']);
export const projectPhase = pgEnum('project_phase', ['boot', 'active']);
export const stepStatus = pgEnum('step_status', ['wait', 'run', 'done', 'fail']);
export const changeState = pgEnum('input_change_state', ['pending', 'skipped', 'analyzed']);
export const designKind = pgEnum('task_design_kind', ['DB', 'API', 'FE', 'DevOps']);
export const techLevel = pgEnum('tech_level', ['must', 'cond', 'ban']);
export const authority = pgEnum('decision_authority', ['lead', 'agent', 'free']);
export const decisionStatus = pgEnum('decision_status', [
  'fixed',
  'approved',
  'pending',
  'rejected',
  'noted',
  'change',
]);
export const reportKind = pgEnum('report_kind', ['daily', 'weekly', 'custom']);
export const reportView = pgEnum('report_view', ['int', 'ext']);

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const timestamps = () => ({
  created_at: at('created_at').defaultNow().notNull(),
  updated_at: at('updated_at').defaultNow().notNull(),
});
const row = () => ({ id: uuid().defaultRandom().primaryKey(), ...timestamps() });
const version = () => ({ schema_version: integer().notNull().default(1) });
const singleton = () => boolean().notNull().default(true).unique();

export const systemState = pgTable(
  'system_state',
  {
    ...timestamps(),
    id: integer().primaryKey().default(1),
    epoch: integer().notNull().default(1),
    cleanup_status: cleanupStatus().notNull().default('none'),
  },
  (t) => [
    check('system_state_singleton', sql`${t.id}=1`),
    check('epoch_positive', sql`${t.epoch}>0`),
  ],
);
export const resetLog = pgTable(
  'reset_log',
  {
    ...row(),
    epoch: integer().notNull().unique(),
    at: at('at').defaultNow().notNull(),
    actor: text().notNull(),
    deleted_task_count: integer().notNull(),
    keep_settings: boolean().notNull(),
    runner_cleanup_status: text().notNull(),
    finished_at: at('finished_at'),
  },
  (t) => textChecks('reset_log', t),
);
export const runnerCommands = pgTable(
  'runner_commands',
  {
    ...row(),
    kind: text().notNull(),
    epoch: integer().notNull(),
    payload: jsonb().notNull(),
    ...version(),
    status: text().notNull(),
    attempts: integer().notNull().default(0),
    result: jsonb(),
  },
  (t) => [
    ...textChecks('runner_commands', t),
    check('command_kind', sql`${t.kind}='reset-cleanup'`),
  ],
);
export const fileDeleteQueue = pgTable(
  'file_delete_queue',
  {
    ...row(),
    epoch: integer().notNull(),
    path: text().notNull(),
    reason: text().notNull(),
    attempts: integer().notNull().default(0),
    last_error: text(),
  },
  (t) => [unique().on(t.epoch, t.path)],
);
export const leadSessions = pgTable('lead_sessions', {
  ...row(),
  token_hash: text().notNull().unique(),
  expires_at: at('expires_at').notNull(),
  csrf: text().notNull(),
});
export const leadLoginTokens = pgTable('lead_login_tokens', {
  ...row(),
  token_hash: text().notNull().unique(),
  expires_at: at('expires_at').notNull(),
  used_at: at('used_at'),
});
export const leadCredentials = pgTable(
  'lead_credentials',
  { ...row(), singleton: singleton(), password_hash: text().notNull() },
  (t) => [check('lead_credentials_singleton', sql`${t.singleton}`)],
);
export const runnerTokens = pgTable('runner_tokens', {
  ...row(),
  token_hash: text().notNull().unique(),
  runner_id: text().notNull(),
  public_key: text().notNull(),
  revoked_at: at('revoked_at'),
});
export const secrets = pgTable('secrets', {
  ...timestamps(),
  key: text().primaryKey(),
  ciphertext: text().notNull(),
  nonce: text().notNull(),
  key_version: integer().notNull(),
  last4: text().notNull(),
});
export const projects = pgTable(
  'projects',
  {
    ...row(),
    singleton: singleton(),
    name: text().notNull(),
    repo_url: text().notNull(),
    repo_owner: text().notNull(),
    repo_name: text().notNull(),
    branch: text().notNull().default('main'),
    base_commit: text(),
    description: text().notNull().default(''),
    start_date: date().notNull().default(sql`(clock_timestamp() at time zone 'Asia/Seoul')::date`),
    target_date: date(),
    input_checked_at: at('input_checked_at'),
    input_check_request: integer().notNull().default(0),
    lead_instruction: text().notNull(),
    phase: projectPhase().notNull(),
  },
  (t) => [
    check('project_singleton', sql`${t.singleton}`),
    check('project_main', sql`${t.branch}='main'`),
  ],
);
const globalProject = () => ({
  project_id: uuid().references(() => projects.id, { onDelete: 'restrict' }),
});
const project = () => ({
  project_id: uuid()
    .notNull()
    .references(() => projects.id, { onDelete: 'restrict' }),
});
export const counters = pgTable(
  'counters',
  { ...row(), ...project(), kind: text().notNull(), value: bigint({ mode: 'number' }).notNull() },
  (t) => [
    ...textChecks('counters', t),
    unique().on(t.project_id, t.kind),
    check('counter_positive', sql`${t.value}>0`),
  ],
);
export const repoChecks = pgTable(
  'repo_checks',
  {
    ...row(),
    project_id: uuid().references(() => projects.id, { onDelete: 'restrict' }),
    url: text().notNull(),
    status: text().notNull(),
    result: jsonb(),
    ...version(),
    error: text(),
  },
  (t) => textChecks('repo_checks', t),
);
export const inputVersions = pgTable(
  'input_versions',
  {
    ...row(),
    ...project(),
    v: integer().notNull(),
    commit_sha: text().notNull(),
    files: jsonb().notNull(),
    md_list: jsonb().notNull(),
    changes: jsonb().notNull(),
    instruction: text().notNull(),
    ...version(),
  },
  (t) => [
    unique().on(t.project_id, t.v),
    unique().on(t.project_id, t.commit_sha),
    check('input_version_positive', sql`${t.v}>0`),
  ],
);
export const inputVersionResults = pgTable('input_version_results', {
  ...row(),
  ...project(),
  input_version: uuid()
    .notNull()
    .unique()
    .references(() => inputVersions.id, { onDelete: 'restrict' }),
  result: jsonb().notNull(),
  ...version(),
});
export const inputChangeCommits = pgTable(
  'input_change_commits',
  {
    ...row(),
    ...project(),
    sha: text().notNull(),
    files: jsonb().notNull(),
    ...version(),
    state: changeState().notNull(),
    analyzed_in_version: uuid().references(() => inputVersions.id, { onDelete: 'restrict' }),
  },
  (t) => [unique().on(t.project_id, t.sha)],
);
export const planningJobs = pgTable(
  'planning_jobs',
  {
    ...row(),
    ...project(),
    kind: text().notNull(),
    run_no: integer().notNull(),
    status: text().notNull(),
    fail: jsonb(),
    instruction: text().notNull(),
  },
  (t) => [
    check(
      'planning_kind',
      sql`${t.kind} in ('bootstrap','input_diff','planning','estimate','split')`,
    ),
    check('planning_status', sql`${t.status} in ('queued','running','done','failed','cancelled')`),
    uniqueIndex('one_open_bootstrap')
      .on(t.project_id)
      .where(sql`${t.kind}='bootstrap' and ${t.status} in ('queued','running')`),
  ],
);
export const planningJobSteps = pgTable(
  'planning_job_steps',
  {
    ...row(),
    ...project(),
    job: uuid()
      .notNull()
      .references(() => planningJobs.id, { onDelete: 'restrict' }),
    step_key: text().notNull(),
    status: stepStatus().notNull(),
    note: text(),
    started_at: at('started_at'),
    finished_at: at('finished_at'),
  },
  (t) => [unique().on(t.job, t.step_key)],
);
export const planningJobLogs = pgTable('planning_job_logs', {
  ...row(),
  ...project(),
  job: uuid()
    .notNull()
    .references(() => planningJobs.id, { onDelete: 'restrict' }),
  at: at('at').notNull().defaultNow(),
  text: text().notNull(),
});
export const wbsDrafts = pgTable(
  'wbs_drafts',
  {
    ...row(),
    ...project(),
    job: uuid()
      .notNull()
      .references(() => planningJobs.id, { onDelete: 'restrict' }),
    revision: integer().notNull(),
    content: jsonb().notNull(),
    split_check: jsonb().notNull(),
    ...version(),
    status: text().notNull(),
  },
  (t) => [...textChecks('wbs_drafts', t), unique().on(t.job, t.revision)],
);
export const wbsNodes = pgTable(
  'wbs_nodes',
  {
    ...row(),
    ...project(),
    node_key: text().notNull().unique(),
    kind: nodeKind().notNull(),
    parent_id: uuid().references((): AnyPgColumn => wbsNodes.id, { onDelete: 'restrict' }),
    title: text().notNull(),
    sort_order: integer().notNull(),
  },
  (t) => [
    check(
      'node_parent',
      sql`(${t.kind}='phase' and ${t.parent_id} is null) or (${t.kind}='work_package' and ${t.parent_id} is not null)`,
    ),
    check('node_not_self', sql`${t.parent_id}<>${t.id}`),
  ],
);
export const tasks = pgTable(
  'tasks',
  {
    ...row(),
    ...project(),
    task_key: text().notNull().unique(),
    wbs_node_id: uuid()
      .notNull()
      .references(() => wbsNodes.id, { onDelete: 'restrict' }),
    sort_order: integer().notNull(),
    title: text().notNull(),
    work_type: workType().notNull(),
    primary_domain: domain().notNull(),
    related_domains: domain().array().notNull(),
    priority: integer().notNull(),
    assignee_agent: agent().notNull(),
    verifier_agent: agent().notNull(),
    status: taskStatus().notNull(),
    verif_state: text().notNull(),
    planning_approved_at: at('planning_approved_at'),
    fix_start: date(),
    act_start: at('act_start'),
    act_end: at('act_end'),
    conflict_group: text(),
    src_input_version: uuid().references(() => inputVersions.id, { onDelete: 'restrict' }),
    execution_head_sha: text(),
    deleted_at: at('deleted_at'),
  },
  (t) => [
    ...textChecks('tasks', t),
    check('related_domains_no_null', sql`array_position(${t.related_domains},null) is null`),
    check('task_title_length', sql`char_length(${t.title}) between 1 and 200`),
    check('task_priority', sql`${t.priority} between 0 and 3`),
    check('task_related_domains', sql`${t.primary_domain} <> all(${t.related_domains})`),
  ],
);
const task = () => ({
  task: uuid()
    .notNull()
    .references(() => tasks.id, { onDelete: 'restrict' }),
});
export const taskSpecs = pgTable(
  'task_specs',
  {
    ...timestamps(),
    ...project(),
    task: uuid()
      .primaryKey()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    overview: jsonb().notNull(),
    spec: jsonb().notNull(),
    ac: jsonb().notNull(),
    ...version(),
    revision: integer().notNull(),
  },
  (t) => [check('ac_array', sql`jsonb_typeof(${t.ac})='array'`)],
);
export const taskDesigns = pgTable(
  'task_designs',
  {
    ...row(),
    ...project(),
    ...task(),
    kind: designKind().notNull(),
    content: jsonb().notNull(),
    ...version(),
  },
  (t) => [unique().on(t.task, t.kind)],
);
export const taskDesignItems = pgTable(
  'task_design_items',
  { ...row(), ...project(), ...task(), item_key: text().notNull(), change: text().notNull() },
  (t) => [...textChecks('task_design_items', t), unique().on(t.task, t.item_key)],
);
export const taskDependencies = pgTable(
  'task_dependencies',
  {
    ...row(),
    ...project(),
    pred: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    succ: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    dep_type: dependencyType().notNull(),
  },
  (t) => [unique().on(t.pred, t.succ), check('dependency_not_self', sql`${t.pred}<>${t.succ}`)],
);
export const checklistItems = pgTable(
  'checklist_items',
  {
    ...row(),
    ...project(),
    ...task(),
    item_key: text().notNull(),
    content: text().notNull(),
    required: boolean().notNull(),
    done: boolean().notNull(),
    verify_method: text().notNull(),
    evidence: jsonb(),
    note: text(),
    sort_order: integer().notNull(),
  },
  (t) => [unique().on(t.task, t.item_key)],
);
export const taskEstimates = pgTable(
  'task_estimates',
  {
    ...row(),
    ...project(),
    ...task(),
    est: numeric().notNull(),
    lo: numeric().notNull(),
    hi: numeric().notNull(),
    tokens_k: numeric(),
    confidence: text().notNull(),
    basis: text().notNull(),
    agreed_by: text().notNull(),
  },
  (t) => [
    ...textChecks('task_estimates', t),
    check('estimate_bounds', sql`0<=${t.lo} and ${t.lo}<=${t.est} and ${t.est}<=${t.hi}`),
  ],
);
export const agentModels = pgTable(
  'agent_models',
  {
    ...row(),
    agent: agent().notNull(),
    model_id: text().notNull(),
    rank: integer(),
    allowed: boolean().notNull().default(false),
    is_new: boolean().notNull().default(true),
    report: jsonb(),
  },
  (t) => [unique().on(t.agent, t.model_id)],
);
export const agentEfforts = pgTable(
  'agent_efforts',
  {
    ...row(),
    agent: agent().notNull(),
    model_id: text().notNull(),
    value: text().notNull(),
    common_level: integer(),
    supported: boolean(),
    confirmation: text().notNull(),
  },
  (t) => [
    unique().on(t.agent, t.model_id, t.value),
    check('effort_level', sql`${t.common_level} between 1 and 5`),
    check('effort_no_ultra', sql`${t.value}<>'ultra' or ${t.common_level} is null`),
  ],
);
export const subagentDefs = pgTable(
  'subagent_defs',
  {
    ...row(),
    def_key: text().notNull(),
    version: integer().notNull(),
    agent: agent().notNull(),
    role: text().notNull(),
    tools: text().array().notNull(),
    sandbox: text().notNull(),
    text: text().notNull(),
    hash: text().notNull(),
    allowed: boolean().notNull().default(false),
    is_demo: boolean().notNull().default(false),
    ref: text(),
  },
  (t) => [...textChecks('subagent_defs', t), unique().on(t.def_key, t.version)],
);
export const taskGrades = pgTable(
  'task_grades',
  {
    ...row(),
    ...project(),
    ...task(),
    role: role().notNull(),
    model_id: text().notNull(),
    effort: text().notNull(),
    reason: text().notNull(),
    locked: boolean().notNull(),
    locked_by: text(),
    effective_from: at('effective_from').notNull(),
  },
  (t) => [unique().on(t.task, t.role)],
);
export const taskSubagents = pgTable(
  'task_subagents',
  {
    ...row(),
    ...project(),
    ...task(),
    role: role().notNull(),
    subagent_id: uuid()
      .notNull()
      .references(() => subagentDefs.id, { onDelete: 'restrict' }),
    basis: text().notNull(),
  },
  (t) => [unique().on(t.task, t.role, t.subagent_id)],
);
export const taskSplits = pgTable(
  'task_splits',
  {
    ...row(),
    ...project(),
    ...task(),
    basis: text().notNull(),
    judged_rules: jsonb().notNull(),
    exceptions: jsonb().notNull(),
    ...version(),
  },
  (t) => [
    unique().on(t.task),
    check(
      'split_judgements_shape',
      sql`public.awbs_valid_judgements(${t.judged_rules}, ARRAY['revert','contract','refactor'])`,
    ),
  ],
);
export const taskSourceLinks = pgTable('task_source_links', {
  ...row(),
  ...project(),
  fix_task: uuid()
    .notNull()
    .references(() => tasks.id, { onDelete: 'restrict' }),
  origin_task: uuid().references(() => tasks.id, { onDelete: 'restrict' }),
  split_from: uuid().references(() => tasks.id, { onDelete: 'restrict' }),
});
export const plannings = pgTable(
  'plannings',
  {
    ...row(),
    ...project(),
    planning_key: text().notNull().unique(),
    title: text().notNull(),
    scope: jsonb().notNull(),
    ...version(),
    status: text().notNull(),
  },
  (t) => textChecks('plannings', t),
);
export const planningAnalyses = pgTable(
  'planning_analyses',
  {
    ...row(),
    ...project(),
    planning: uuid()
      .notNull()
      .references(() => plannings.id, { onDelete: 'restrict' }),
    agent: agent().notNull(),
    analysis: jsonb().notNull(),
    ...version(),
  },
  (t) => [unique().on(t.planning, t.agent)],
);
export const planningReviews = pgTable(
  'planning_reviews',
  {
    ...row(),
    ...project(),
    planning: uuid()
      .notNull()
      .references(() => plannings.id, { onDelete: 'restrict' }),
    topic: text().notNull(),
    kind: text().notNull(),
    codex: jsonb().notNull(),
    claude: jsonb().notNull(),
    choice: text(),
    memo: text(),
    ...version(),
  },
  (t) => textChecks('planning_reviews', t),
);
export const changeProposals = pgTable(
  'change_proposals',
  {
    ...row(),
    ...project(),
    cp_key: text().notNull().unique(),
    // API Proposal의 title·reason·source.id(M1 통합). 분할 CP의 source_id는 원래 Task 키다.
    title: text().notNull(),
    reason: text().notNull(),
    source: text().notNull(),
    source_id: text(),
    status: proposalStatus().notNull(),
    ops: jsonb().notNull(),
    id_map: jsonb(),
    preview_hash: text(),
    hold_reasons: jsonb(),
    split_judgements: jsonb(),
    task_judgements: jsonb().notNull().default([]),
    deleted_at: at('deleted_at'),
    ...version(),
  },
  (t) => [
    check('cp_task_judgements_array', sql`jsonb_typeof(${t.task_judgements})='array'`),
    check(
      'cp_judgements_shape',
      sql`public.awbs_valid_judgements(${t.split_judgements}, ARRAY['ac_meaning','layer_order','test_included'])`,
    ),
    check('hold_reasons_shape', sql`public.awbs_valid_hold_reasons(${t.hold_reasons})`),
    check('cp_title_text', sql`length(btrim(${t.title}))>0`),
    check('cp_reason_text', sql`length(btrim(${t.reason}))>0`),
    check('cp_source_id_text', sql`${t.source_id} is null or length(btrim(${t.source_id}))>0`),
    // 분할 CP의 source_id 필수는 0014의 트리거 cp_split_source가 검사한다(이전 행의 무관한 갱신 허용).
    check(
      'proposal_source',
      sql`${t.source} in ('planning','message','manual','split','input','decision')`,
    ),
  ],
);
export const changeProposalEvents = pgTable(
  'change_proposal_events',
  {
    ...row(),
    ...project(),
    proposal: uuid()
      .notNull()
      .references(() => changeProposals.id, { onDelete: 'restrict' }),
    kind: text().notNull(),
    actor: text().notNull(),
    comment: text().notNull(),
  },
  (t) => textChecks('change_proposal_events', t),
);
export const runnerJobs = pgTable('runner_jobs', {
  ...row(),
  project_id: uuid().references(() => projects.id, { onDelete: 'restrict' }),
  kind: jobKind().notNull(),
  payload: jsonb().notNull(),
  ...version(),
  state: jobState().notNull(),
  lease_owner: text(),
  lease_until: at('lease_until'),
  fence: integer().notNull().default(0),
  epoch: integer().notNull(),
  attempts: integer().notNull().default(0),
  generation: integer(),
  dedup_key: text().notNull().unique(),
});
export const runnerJobEvents = pgTable(
  'runner_job_events',
  {
    ...row(),
    project_id: uuid().references(() => projects.id, { onDelete: 'restrict' }),
    job: uuid()
      .notNull()
      .references(() => runnerJobs.id, { onDelete: 'restrict' }),
    kind: text().notNull(),
    code: text(),
    detail: jsonb(),
    ...version(),
  },
  (t) => [
    check(
      'job_event_kind',
      sql`${t.kind} in ('prepared','prestart_failed','started','lease_lost','reconciled','finished')`,
    ),
  ],
);
export const taskAttempts = pgTable(
  'task_attempts',
  {
    ...row(),
    ...project(),
    ...task(),
    attempt_key: text().notNull().unique(),
    attempt_no: integer().notNull(),
    branch: text(),
    pr: integer(),
    generation: integer(),
    job: uuid()
      .notNull()
      .unique()
      .references(() => runnerJobs.id, { onDelete: 'restrict' }),
    base_sha: text().notNull(),
    head_sha: text().notNull(),
    spec_revision: integer().notNull(),
    input_version: uuid().references(() => inputVersions.id, { onDelete: 'restrict' }),
    kind: attemptKind().notNull(),
    agent: agent().notNull(),
    status: attemptStatus().notNull(),
    started_at: at('started_at').notNull(),
    ended_at: at('ended_at'),
    model_id: text().notNull(),
    effort: text().notNull(),
    grade_adjust: jsonb(),
    summary: text(),
    failure: jsonb(),
    tokens: bigint({ mode: 'number' }),
    resumed_from: uuid().references((): AnyPgColumn => taskAttempts.id, { onDelete: 'restrict' }),
  },
  (t) => [
    unique().on(t.task, t.attempt_no),
    check(
      'attempt_end_time',
      sql`(${t.status}='running' and ${t.ended_at} is null) or (${t.status}<>'running' and ${t.ended_at}>=${t.started_at} and ${t.ended_at} is not null)`,
    ),
    check('attempt_number_positive', sql`${t.attempt_no}>0`),
    uniqueIndex('one_open_attempt')
      .on(t.task)
      .where(sql`${t.status}='running'`),
  ],
);
export const executionHolds = pgTable(
  'execution_holds',
  {
    ...row(),
    project_id: uuid().references(() => projects.id, { onDelete: 'restrict' }),
    job: uuid()
      .notNull()
      .unique()
      .references(() => runnerJobs.id, { onDelete: 'restrict' }),
    attempt: uuid().references(() => taskAttempts.id, { onDelete: 'restrict' }),
    epoch: integer().notNull(),
    host_id: text(),
    boot_id: text(),
    fence: integer(),
    pgid: integer(),
    cgroup: text(),
    task: uuid().references(() => tasks.id, { onDelete: 'restrict' }),
    conflict_group: text(),
    agent: agent().notNull(),
    slots: integer().notNull(),
    heavy: boolean().notNull(),
    slot_state: slotState().notNull(),
    lock_state: lockState().notNull(),
    lock_from_job: uuid().references(() => runnerJobs.id, { onDelete: 'restrict' }),
    handed_to_job: uuid().references(() => runnerJobs.id, { onDelete: 'restrict' }),
    release_proof: releaseProof(),
    closed_at: at('closed_at'),
  },
  (t) => [
    check(
      'hold_lock_target',
      sql`${t.lock_state}<>'held' or ${t.task} is not null or ${t.conflict_group} is not null`,
    ),
    check(
      'hold_orphaned_slots',
      sql`${t.lock_state}<>'orphaned' or ${t.slot_state} in ('none','unconfirmed')`,
    ),
    check(
      'hold_active_group',
      sql`${t.slot_state}<>'active' or coalesce(${t.pgid}>0,false) or coalesce(length(${t.cgroup})>0,false)`,
    ),
    check('hold_slots', sql`${t.slots}>=0`),
    check(
      'hold_closed',
      sql`(${t.closed_at} is null) = (${t.slot_state}<>'none' or ${t.lock_state}='held')`,
    ),
    check(
      'handover_slots',
      sql`${t.lock_state} not in ('handed_over','released') or ${t.slot_state}='none'`,
    ),
    check('handover_target', sql`${t.lock_state}<>'handed_over' or ${t.handed_to_job} is not null`),
    uniqueIndex('one_task_lock')
      .on(t.task)
      .where(sql`${t.lock_state}='held'`),
    uniqueIndex('one_conflict_lock')
      .on(t.conflict_group)
      .where(sql`${t.lock_state}='held' and ${t.conflict_group} is not null`),
  ],
);
export const externalWriteAuthority = pgTable(
  'external_write_authority',
  {
    ...row(),
    singleton: singleton(),
    host_id: text().notNull(),
    generation: integer().notNull(),
    state: text().notNull(),
    credential_fingerprint: text(),
    blocked_reason: text(),
    reconciled_at: at('reconciled_at'),
  },
  (t) => [
    check('external_singleton', sql`${t.singleton}`),
    check('external_state', sql`${t.state} in ('granted','blocked')`),
  ],
);
export const attemptFiles = pgTable(
  'attempt_files',
  {
    ...row(),
    ...project(),
    attempt: uuid()
      .notNull()
      .references(() => taskAttempts.id, { onDelete: 'restrict' }),
    path: text().notNull(),
  },
  (t) => [
    unique().on(t.attempt, t.path),
    check(
      'relative_file_path',
      sql`${t.path}<>'' and ${t.path} not like '/%' and position(chr(92) in ${t.path})=0 and ${t.path} !~ '(^|/)[.][.](/|$)'`,
    ),
  ],
);
export const attemptSubagents = pgTable(
  'attempt_subagents',
  {
    ...row(),
    ...project(),
    attempt: uuid()
      .notNull()
      .references(() => taskAttempts.id, { onDelete: 'restrict' }),
    subagent: uuid()
      .notNull()
      .references(() => subagentDefs.id, { onDelete: 'restrict' }),
    designated: boolean().notNull(),
    installed: boolean().notNull(),
    observed_used: boolean(),
    version: integer().notNull(),
    def_hash: text().notNull(),
    confirm: text(),
  },
  (t) => [check('usage_confirmation', sql`${t.confirm} in ('confirmed','partial')`)],
);
export const attemptObservations = pgTable(
  'attempt_observations',
  {
    ...row(),
    ...project(),
    attempt: uuid()
      .notNull()
      .references(() => taskAttempts.id, { onDelete: 'restrict' }),
    cli: text().notNull(),
    version: text().notNull(),
    grade: text().notNull(),
    observed: integer(),
    reserved: integer().notNull(),
    state: text().notNull(),
    process_state: jsonb().notNull(),
    at: at('at').notNull(),
  },
  (t) => [
    ...textChecks('attempt_observations', t),
    check('observation_state', sql`${t.state} in ('ok','unconfirmed')`),
  ],
);
export const verifications = pgTable('verifications', {
  ...row(),
  ...project(),
  attempt: uuid()
    .notNull()
    .unique()
    .references(() => taskAttempts.id, { onDelete: 'restrict' }),
  result: verificationResult().notNull(),
  head_sha: text().notNull(),
  spec_revision: integer().notNull(),
  cmd: text().notNull(),
  expected: text().notNull(),
  actual: text().notNull(),
});
export const verificationInvalidations = pgTable('verification_invalidations', {
  ...row(),
  ...project(),
  verification: uuid()
    .notNull()
    .references(() => verifications.id, { onDelete: 'restrict' }),
  reason: text().notNull(),
});
export const defects = pgTable('defects', {
  ...row(),
  ...project(),
  def_key: text().notNull().unique(),
  verification: uuid()
    .notNull()
    .references(() => verifications.id, { onDelete: 'restrict' }),
  blocking: boolean().notNull(),
  content: text().notNull(),
});
export const defectEvents = pgTable(
  'defect_events',
  {
    ...row(),
    ...project(),
    defect: uuid()
      .notNull()
      .references(() => defects.id, { onDelete: 'restrict' }),
    kind: text().notNull(),
    resolved_by_verification: uuid().references(() => verifications.id, { onDelete: 'restrict' }),
    detail: jsonb(),
  },
  (t) => textChecks('defect_events', t),
);
export const taskOutputs = pgTable(
  'task_outputs',
  {
    ...row(),
    ...project(),
    ...task(),
    name: text().notNull(),
    kind: text().notNull(),
    required: boolean().notNull(),
    verify: text().notNull(),
    delivered: boolean().notNull(),
    delivered_attempt: uuid().references(() => taskAttempts.id, { onDelete: 'restrict' }),
  },
  (t) => [...textChecks('task_outputs', t), unique().on(t.task, t.name)],
);
export const evidence = pgTable(
  'evidence',
  {
    ...row(),
    ...project(),
    ...task(),
    attempt: uuid().references(() => taskAttempts.id, { onDelete: 'restrict' }),
    verification: uuid().references(() => verifications.id, { onDelete: 'restrict' }),
    checklist: uuid().references(() => checklistItems.id, { onDelete: 'restrict' }),
    kind: text().notNull(),
    storage_path: text(),
    reference_path: text(),
    sha256: text(),
    size: bigint({ mode: 'number' }),
  },
  (t) => [
    ...textChecks('evidence', t),
    check('evidence_hash_size', sql`${t.sha256} ~ '^[a-f0-9]{64}$' and ${t.size}>=0`),
    check('evidence_source', sql`(${t.reference_path} is null and ${t.storage_path} is not null and ${t.sha256} is not null and ${t.size} is not null) or (${t.reference_path} is not null and length(btrim(${t.reference_path}))>0 and ${t.storage_path} is null and ${t.sha256} is null and ${t.size} is null and ${t.verification} is not null)`),
    unique('evidence_verification_reference').on(t.verification, t.reference_path),
  ],
);
export const runnerSessions = pgTable('runner_sessions', {
  ...row(),
  runner_id: text().notNull(),
  started_at: at('started_at').notNull(),
  ended_at: at('ended_at'),
  end_reason: text(),
  last_heartbeat_at: at('last_heartbeat_at').notNull(),
}, t=>textChecks('runner_sessions',t));
export const runnerHosts = pgTable('runner_hosts', {
  ...row(),
  host_id: text().notNull(),
  // host 보고의 현재 bootId(M1 통합). 이 열이 생기기 전 행은 null이다.
  boot_id: text(),
  cpu: text().notNull(),
  cores: integer().notNull(),
  mem_gb: numeric().notNull(),
  swap_gb: numeric().notNull(),
  disk_gb: numeric().notNull(),
  os: text().notNull(),
  per_session_gb: numeric(),
  samples: integer().notNull(),
  seen_at: at('seen_at').notNull(),
}, (t) => [check('runner_host_boot_text', sql`${t.boot_id} is null or length(btrim(${t.boot_id}))>0`)]);
export const runnerConcurrencyLog = pgTable('runner_concurrency_log', {
  ...row(),
  host_id: text().notNull(),
  limit: integer().notNull(),
  running: integer().notNull(),
  subagents: jsonb().notNull(),
  heavy: integer().notNull(),
  resources: jsonb().notNull(),
  adjust: jsonb(),
  ...version(),
});
export const concurrencySettings = pgTable(
  'concurrency_settings',
  {
    ...row(),
    singleton: singleton(),
    mode: text().notNull(),
    caps: jsonb(),
    mem_reserve_gb: numeric(),
    subagent_budget: jsonb(),
    concurrency_version: at('concurrency_version'),
    budget_version: at('budget_version'),
    ...version(),
  },
  (t) => [
    check('concurrency_singleton', sql`${t.singleton}`),
    check('concurrency_mode', sql`${t.mode} in ('auto','manual')`),
  ],
);
export const runnerReadiness = pgTable(
  'runner_readiness',
  {
    ...row(),
    key: text().notNull().unique(),
    status: text().notNull(),
    detail: text().notNull(),
    fix: text().notNull(),
    at: at('at').notNull(),
  },
  (t) => textChecks('runner_readiness', t),
);
export const agentUsage = pgTable(
  'agent_usage',
  {
    ...row(),
    agent: agent().notNull(),
    remain_pct: numeric().notNull(),
    reset_at: at('reset_at'),
    tokens_used: bigint({ mode: 'number' }),
  },
  (t) => [check('usage_percent', sql`${t.remain_pct} between 0 and 100`)],
);
export const execPolicy = pgTable(
  'exec_policy',
  {
    ...row(),
    singleton: singleton(),
    on_usage: text().notNull(),
    low_pct: integer(),
    on_rework: text().notNull(),
    esc_notify: integer().notNull(),
    floors: jsonb().notNull(),
    live_inject: boolean().notNull().default(false),
    auto_retry_limit: integer().notNull(),
    auto_rework_limit: integer().notNull(),
    settings_version: at('settings_version').notNull().defaultNow(),
    ...version(),
  },
  (t) => [
    check('exec_singleton', sql`${t.singleton}`),
    check('exec_usage', sql`${t.on_usage} in ('wait','down')`),
    check('exec_rework', sql`${t.on_rework} in ('same','up1','top')`),
    check('exec_limits', sql`${t.auto_retry_limit}>=0 and ${t.auto_rework_limit}>=0`),
  ],
);
export const cliObservationGrades = pgTable(
  'cli_observation_grades',
  {
    ...row(),
    cli: text().notNull(),
    version: text().notNull(),
    model: text().notNull(),
    options: text().notNull(),
    grade: text().notNull(),
    verified_at: at('verified_at'),
    notes: text().notNull(),
  },
  (t) => [
    ...textChecks('cli_observation_grades', t),
    unique().on(t.cli, t.version, t.model, t.options),
  ],
);
export const schedulePolicy = pgTable(
  'schedule_policy',
  {
    ...row(),
    singleton: singleton(),
    auto_replan: boolean(),
    cp_auto: boolean(),
    threshold_days: numeric(),
    assume_rate: numeric(),
    window_days: integer().notNull(),
    min_hours: numeric().notNull(),
    settings_version: at('settings_version').notNull().defaultNow(),
  },
  (t) => [
    check('schedule_singleton', sql`${t.singleton}`),
    check('assume_rate_range', sql`${t.assume_rate} between 0 and 1`),
  ],
);
export const blackoutDays = pgTable('blackout_days', {
  ...row(),
  date: date().notNull().unique(),
  note: text().notNull(),
});
export const scheduleBaselines = pgTable(
  'schedule_baselines',
  {
    ...row(),
    ...project(),
    v: integer().notNull(),
    expected: jsonb().notNull(),
    range: jsonb().notNull(),
    applied_rate: numeric().notNull(),
    ...version(),
  },
  (t) => [unique().on(t.project_id, t.v)],
);
export const baselineItems = pgTable(
  'baseline_items',
  {
    ...row(),
    ...project(),
    ...task(),
    baseline: uuid()
      .notNull()
      .references(() => scheduleBaselines.id, { onDelete: 'restrict' }),
    start: at('start').notNull(),
    end: at('end').notNull(),
    lo: at('lo').notNull(),
    hi: at('hi').notNull(),
  },
  (t) => [unique().on(t.baseline, t.task)],
);
export const replans = pgTable(
  'replans',
  {
    ...row(),
    ...project(),
    rp_key: text().notNull().unique(),
    trigger: text().notNull(),
    actor: text().notNull(),
    baseline_v: integer(),
    status: text().notNull(),
    before: jsonb().notNull(),
    after: jsonb().notNull(),
    ...version(),
  },
  (t) => [check('replan_status', sql`${t.status} in ('applied','pending','discarded')`)],
);
export const replanMoves = pgTable(
  'replan_moves',
  {
    ...row(),
    ...project(),
    ...task(),
    replan: uuid()
      .notNull()
      .references(() => replans.id, { onDelete: 'restrict' }),
    kind: text().notNull(),
    before: jsonb(),
    after: jsonb(),
    ...version(),
  },
  (t) => textChecks('replan_moves', t),
);
export const reports = pgTable(
  'reports',
  {
    ...row(),
    ...project(),
    report_key: text().notNull().unique(),
    kind: reportKind().notNull(),
    from: date().notNull(),
    to: date().notNull(),
    view: reportView().notNull().default('int'),
    snapshot: jsonb().notNull(),
    ...version(),
    generated_at: at('generated_at').notNull(),
    due_at: at('due_at'),
    reason: text().notNull(),
  },
  (t) => [
    check('report_period', sql`${t.from}<=${t.to}`),
    uniqueIndex('one_periodic_report')
      .on(t.project_id, t.kind, t.from, t.to)
      .where(sql`${t.kind} in ('daily','weekly')`),
  ],
);
export const reportPdfs = pgTable(
  'report_pdfs',
  {
    ...row(),
    ...project(),
    report: uuid()
      .notNull()
      .references(() => reports.id, { onDelete: 'restrict' }),
    view: reportView().notNull(),
    path: text().notNull(),
    sha256: text().notNull(),
  },
  (t) => [unique().on(t.report, t.view)],
);
export const mailSettings = pgTable(
  'mail_settings',
  {
    ...row(),
    singleton: singleton(),
    host: text(),
    port: integer(),
    security: text(),
    from: text(),
    user: text(),
    secret_key: text().references(() => secrets.key, { onDelete: 'restrict' }),
    checked_at: at('checked_at'),
    status: text(),
    error: text(),
  },
  (t) => [check('mail_singleton', sql`${t.singleton}`)],
);
export const mailRecipients = pgTable(
  'mail_recipients',
  {
    ...row(),
    email: text().notNull(),
    name: text().notNull(),
    active: boolean().notNull(),
    daily: boolean().notNull(),
    weekly: boolean().notNull(),
    pdf: boolean().notNull(),
    view: reportView().notNull(),
  },
  (t) => [
    uniqueIndex('recipient_email_lower').on(sql`lower(${t.email})`),
    check('recipient_schedule', sql`not ${t.active} or ${t.daily} or ${t.weekly}`),
  ],
);
export const mailOutbox = pgTable(
  'mail_outbox',
  {
    ...row(),
    ...project(),
    delivery_id: uuid().notNull(),
    epoch: integer().notNull(),
    report: uuid()
      .notNull()
      .references(() => reports.id, { onDelete: 'restrict' }),
    recipient: uuid().notNull(),
    email: text().notNull(),
    try_no: integer().notNull(),
    state: deliveryState().notNull(),
    next_at: at('next_at'),
    error: text(),
  },
  (t) => [
    unique().on(t.report, t.recipient, t.try_no),
    check('mail_try_positive', sql`${t.try_no}>0`),
  ],
);
export const mailLog = pgTable('mail_log', {
  ...row(),
  ...project(),
  delivery_id: uuid().notNull(),
  report: uuid()
    .notNull()
    .references(() => reports.id, { onDelete: 'restrict' }),
  email: text().notNull(),
  state: deliveryState().notNull(),
  error: text(),
  at: at('at').notNull(),
});
export const notifySettings = pgTable(
  'notify_settings',
  {
    ...row(),
    singleton: singleton(),
    enabled: boolean().notNull(),
    chat_id: text(),
    target_name: text(),
    bot: jsonb(),
    test_fingerprint: text(),
    secret_key: text().references(() => secrets.key, { onDelete: 'restrict' }),
  },
  (t) => [check('notify_singleton', sql`${t.singleton}`)],
);
export const notifyRules = pgTable(
  'notify_rules',
  {
    ...row(),
    key: text().notNull().unique(),
    enabled: boolean().notNull(),
  },
  (t) => textChecks('notify_rules', t),
);
export const notifyEvents = pgTable(
  'notify_events',
  {
    ...row(),
    ...globalProject(),
    dedup_key: text().notNull(),
    kind: text().notNull(),
    ref: jsonb().notNull(),
    resolved_at: at('resolved_at'),
    dup_count: integer().notNull().default(0),
  },
  (t) => [
    ...textChecks('notify_events', t),
    uniqueIndex('one_open_notify_key')
      .on(sql`coalesce(${t.project_id}::text, 'global')`, t.dedup_key)
      .where(sql`${t.resolved_at} is null`),
  ],
);
export const notifyOutbox = pgTable(
  'notify_outbox',
  {
    ...row(),
    ...globalProject(),
    event: uuid().references(() => notifyEvents.id, { onDelete: 'restrict' }),
    delivery_id: uuid().notNull(),
    epoch: integer().notNull(),
    state: deliveryState().notNull(),
    attempts: integer().notNull().default(0),
    next_at: at('next_at'),
    payload: jsonb().notNull(),
    ...version(),
    kind: text().notNull(),
    error: text(),
  },
  (t) => [...textChecks('notify_outbox', t), unique().on(t.event)],
);
export const notifyLog = pgTable(
  'notify_log',
  {
    ...row(),
    ...globalProject(),
    delivery_id: uuid().notNull(),
    kind: text().notNull(),
    state: deliveryState().notNull(),
    error: text(),
    at: at('at').notNull(),
  },
  (t) => textChecks('notify_log', t),
);
export const alerts = pgTable(
  'alerts',
  {
    ...row(),
    ...globalProject(),
    key: text().notNull(),
    severity: text().notNull(),
    target: jsonb().notNull(),
    resolved_at: at('resolved_at'),
    acknowledged_at: at('acknowledged_at'),
  },
  (t) => [
    ...textChecks('alerts', t),
    uniqueIndex('one_open_alert_key')
      .on(sql`coalesce(${t.project_id}::text, 'global')`, t.key)
      .where(sql`${t.resolved_at} is null`),
  ],
);
export const appSettings = pgTable(
  'app_settings',
  {
    ...row(),
    singleton: singleton(),
    readiness_check_request: integer().notNull().default(0),
    split_version: at('split_version').notNull().defaultNow(),
    blackouts_version: at('blackouts_version').notNull().defaultNow(),
    workflow_version: at('workflow_version').notNull().defaultNow(),
    models_version: at('models_version').notNull().defaultNow(),
    subagents_version: at('subagents_version').notNull().defaultNow(),
    app_url: text(),
    heartbeat_seconds: integer().notNull(),
    heartbeat_misses: integer().notNull(),
    split: jsonb().notNull(),
    workflow: jsonb(),
    stage_pct: jsonb().notNull(),
    timezone: text().notNull(),
    // 모델 순서(아래부터)·Codex 계열 순서·Claude 모델 목록(owner 2026-11-26 아이템 8). 초기값은 seed의 default_model_settings()
    model_settings: jsonb().notNull(),
    ...version(),
  },
  (t) => [
    check('app_singleton', sql`${t.singleton}`),
    check('heartbeat_positive', sql`${t.heartbeat_seconds}>0 and ${t.heartbeat_misses}>0`),
    check(
      'app_model_settings_shape',
      sql`(jsonb_typeof(${t.model_settings})='object' and ${t.model_settings} ?& array['rankOrder','codexFamilyOrder','claudeModels'] and jsonb_typeof(${t.model_settings}->'rankOrder')='object' and (${t.model_settings}->'rankOrder') ?& array['Claude','Codex'] and public.awbs_valid_id_list(${t.model_settings}->'rankOrder'->'Claude',0) and public.awbs_valid_id_list(${t.model_settings}->'rankOrder'->'Codex',0) and public.awbs_valid_id_list(${t.model_settings}->'codexFamilyOrder',1) and public.awbs_valid_id_list(${t.model_settings}->'claudeModels',1)) is true`,
    ),
  ],
);
export const githubSettings = pgTable(
  'github_settings',
  {
    ...row(),
    singleton: singleton(),
    mode: text().notNull(),
    status: text().notNull(),
    checked_at: at('checked_at'),
    settings_version: at('settings_version'),
    // 권한별 verified·unverified·missing(조정자 결정 2026-11-26). null = 확인 안 함
    scopes: jsonb(),
    // 미확인 권한 등 화면에 알릴 문구
    warning: text(),
    expires_at: at('expires_at'),
    account: text(),
    secret_key: text().references(() => secrets.key, { onDelete: 'restrict' }),
  },
  (t) => [
    ...textChecks('github_settings', t),
    check('github_singleton', sql`${t.singleton}`),
    check(
      'github_scopes_shape',
      sql`${t.scopes} is null or (jsonb_typeof(${t.scopes})='object' and ${t.scopes} ?& array['contents','pulls','statuses','metadata'] and (${t.scopes} - array['contents','pulls','statuses','metadata'])='{}'::jsonb and ${t.scopes}->>'contents' in ('verified','unverified','missing') and ${t.scopes}->>'pulls' in ('verified','unverified','missing') and ${t.scopes}->>'statuses' in ('verified','unverified','missing') and ${t.scopes}->>'metadata' in ('verified','unverified','missing')) is true`,
    ),
    check('github_warning_text', sql`${t.warning} is null or length(btrim(${t.warning}))>0`),
  ],
);
export const techConstraints = pgTable('tech_constraints', {
  ...row(),
  ...project(),
  name: text().notNull(),
  level: techLevel().notNull(),
  condition: text(),
});
export const techDecisions = pgTable('tech_decisions', {
  ...row(),
  ...project(),
  td_key: text().notNull().unique(),
  title: text().notNull(),
  authority: authority().notNull(),
  status: decisionStatus().notNull(),
  content: jsonb().notNull(),
  ...version(),
});
export const techDecisionEvents = pgTable(
  'tech_decision_events',
  {
    ...row(),
    ...project(),
    decision: uuid()
      .notNull()
      .references(() => techDecisions.id, { onDelete: 'restrict' }),
    actor: text().notNull(),
    kind: text().notNull(),
    detail: jsonb(),
    ...version(),
  },
  (t) => textChecks('tech_decision_events', t),
);
export const designSnapshots = pgTable(
  'design_snapshots',
  {
    ...row(),
    ...project(),
    commit: text().notNull(),
    ref: text().notNull(),
    parse_status: text().notNull(),
    error: text(),
    content: jsonb().notNull().default({}),
  },
  (t) => [...textChecks('design_snapshots', t), unique().on(t.project_id, t.commit, t.ref)],
);
export const designFiles = pgTable(
  'design_files',
  {
    ...row(),
    ...project(),
    snapshot: uuid()
      .notNull()
      .references(() => designSnapshots.id, { onDelete: 'restrict' }),
    path: text().notNull(),
    format: text().notNull(),
    parse_status: text().notNull(),
    content: jsonb(),
    last_success: jsonb(),
    ...version(),
    error: text(),
  },
  (t) => [...textChecks('design_files', t), unique().on(t.snapshot, t.path)],
);
export const designItems = pgTable(
  'design_items',
  {
    ...row(),
    ...project(),
    snapshot: uuid()
      .notNull()
      .references(() => designSnapshots.id, { onDelete: 'restrict' }),
    file: uuid().references(() => designFiles.id, { onDelete: 'restrict' }),
    item_key: text().notNull(),
    kind: text().notNull(),
    content: jsonb().notNull(),
    ...version(),
  },
  (t) => [...textChecks('design_items', t), unique().on(t.snapshot, t.item_key)],
);
export const designEdges = pgTable(
  'design_edges',
  {
    ...row(),
    ...project(),
    snapshot: uuid()
      .notNull()
      .references(() => designSnapshots.id, { onDelete: 'restrict' }),
    from_item: uuid()
      .notNull()
      .references(() => designItems.id, { onDelete: 'restrict' }),
    to_item: uuid()
      .notNull()
      .references(() => designItems.id, { onDelete: 'restrict' }),
    kind: text().notNull(),
  },
  (t) => textChecks('design_edges', t),
);
export const designOwnership = pgTable('design_ownership', {
  ...row(),
  ...project(),
  snapshot: uuid()
    .notNull()
    .references(() => designSnapshots.id, { onDelete: 'restrict' }),
  item_key: text().notNull(),
  owner: text().notNull(),
  task: uuid().references(() => tasks.id, { onDelete: 'restrict' }),
});
export const designDrifts = pgTable(
  'design_drifts',
  {
    ...row(),
    ...project(),
    item_key: text().notNull(),
    kind: text().notNull(),
    compat: text().notNull(),
    status: text().notNull(),
    resolution: jsonb(),
    ...version(),
  },
  (t) => [
    ...textChecks('design_drifts', t),
    check('drift_compat', sql`${t.compat} in ('호환','깨짐','대조 안 함')`),
  ],
);
export const designVersions = pgTable(
  'design_versions',
  {
    ...row(),
    ...project(),
    item_key: text().notNull(),
    kind: text().notNull(),
    compat: text().notNull(),
    status: text().notNull(),
    resolution: jsonb(),
    snapshot: uuid()
      .references(() => designSnapshots.id, { onDelete: 'restrict' }),
    ...version(),
  },
  (t) => textChecks('design_versions', t),
);
export const ciRuns = pgTable(
  'ci_runs',
  {
    ...row(),
    ...project(),
    run_key: text().notNull().unique(),
    stage: integer().notNull(),
    base_sha: text(),
    head_sha: text(),
    merge_sha: text(),
    tree_sha: text(),
    pipeline_sha: text().notNull(),
    spec_revision: integer(),
    input_version: uuid().references(() => inputVersions.id, { onDelete: 'restrict' }),
    ref: text().notNull(),
    pr: integer(),
    task: uuid().references(() => tasks.id, { onDelete: 'restrict' }),
    attempt: uuid().references(() => taskAttempts.id, { onDelete: 'restrict' }),
    trigger: text().notNull(),
    status: ciStatus().notNull(),
    fail_step: text(),
    log_excerpt: text(),
    artifact_path: text(),
    url: text(),
    // 시작한 job과 그 fence(M1 통합). 갱신 보고는 이것과 대조하고, job 없는 실행은 야간 점검(3)뿐이다.
    job: uuid().references(() => runnerJobs.id, { onDelete: 'restrict' }),
    fence: integer(),
    artifacts: jsonb().notNull().default([]),
  },
  (t) => [
    check('ci_stage', sql`${t.stage} between 1 and 4`),
    index('ci_runs_input_version_idx').on(t.input_version),
    // job 없는 실행은 야간 점검뿐이라는 규칙은 0014의 트리거 ci_job_owner가 검사한다.
    check('ci_job_fence', sql`(${t.job} is null)=(${t.fence} is null) and (${t.fence} is null or ${t.fence}>=0)`),
    check('ci_artifacts_array', sql`jsonb_typeof(${t.artifacts})='array'`),
  ],
);
export const ciSteps = pgTable(
  'ci_steps',
  {
    ...row(),
    ...project(),
    run: uuid()
      .notNull()
      .references(() => ciRuns.id, { onDelete: 'restrict' }),
    step_key: text().notNull(),
    status: ciStatus().notNull(),
    command: text().notNull(),
    exit_code: integer(),
    log_excerpt: text(),
  },
  (t) => [unique().on(t.run, t.step_key)],
);
export const mergeQueue = pgTable(
  'merge_queue',
  {
    ...row(),
    ...project(),
    ...task(),
    pr: integer().notNull(),
    position: integer().notNull(),
    status: queueStatus().notNull(),
    qa_head_sha: text().notNull(),
    synced_head_sha: text(),
    base_sha: text(),
    verification: uuid()
      .notNull()
      .references(() => verifications.id, { onDelete: 'restrict' }),
    ci_run: uuid().references(() => ciRuns.id, { onDelete: 'restrict' }),
    tested_tree_sha: text(),
    actual_merge_sha: text(),
    actual_tree_sha: text(),
  },
  (t) => [
    uniqueIndex('one_open_merge_task')
      .on(t.task)
      .where(sql`${t.status} in ('waiting_verify','queued','checking')`),
  ],
);
export const flakyTests = pgTable(
  'flaky_tests',
  {
    ...row(),
    ...project(),
    test_key: text().notNull().unique(),
    rate: numeric().notNull(),
    quarantined: boolean().notNull(),
    task: uuid().references(() => tasks.id, { onDelete: 'restrict' }),
  },
  (t) => [check('flaky_rate', sql`${t.rate} between 0 and 1`)],
);
export const ciSettings = pgTable(
  'ci_settings',
  {
    ...row(),
    singleton: singleton(),
    night_at: text(),
    retry: integer().notNull(),
    deploy_url: text(),
  },
  (t) => [check('ci_singleton', sql`${t.singleton}`)],
);
export const messages = pgTable(
  'messages',
  {
    ...row(),
    ...project(),
    ...task(),
    msg_key: text().notNull().unique(),
    attempt: uuid().references(() => taskAttempts.id, { onDelete: 'restrict' }),
    dir: text().notNull(),
    type: text().notNull(),
    to_agent: agent(),
    from_agent: agent(),
    body: text().notNull(),
    delivery: messageDelivery(),
    pending_next: boolean().notNull(),
    work_state: text().notNull(),
    fail_reason: text(),
    read_at: at('read_at'),
    draft: boolean().notNull(),
  },
  (t) => [
    ...textChecks('messages', t),
    check(
      'message_participants',
      sql`(${t.dir}='out' and ${t.to_agent} is not null and ${t.delivery} is not null) or (${t.dir}='in' and ${t.from_agent} is not null)`,
    ),
  ],
);
export const taskHistory = pgTable(
  'task_history',
  {
    ...row(),
    ...globalProject(),
    at: at('at').notNull().defaultNow(),
    actor: text().notNull(),
    task: uuid().references(() => tasks.id, { onDelete: 'restrict' }),
    kind: text().notNull(),
    text: text().notNull(),
    before: jsonb(),
    after: jsonb(),
    ref: jsonb(),
  },
  (t) => textChecks('task_history', t),
);
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    ...row(),
    ...globalProject(),
    principal: text().notNull(),
    key: text().notNull(),
    request_hash: text().notNull(),
    response: jsonb().notNull(),
    epoch: integer().notNull(),
    ...version(),
  },
  (t) => [unique().on(t.project_id, t.epoch, t.principal, t.key).nullsNotDistinct()],
);
export const changeEvents = pgTable(
  'change_events',
  {
    ...globalProject(),
    seq: bigserial({ mode: 'number' }).primaryKey(),
    topic: text().notNull(),
    ref: jsonb().notNull(),
    at: at('at').notNull().defaultNow(),
  },
  (t) => textChecks('change_events', t),
);
