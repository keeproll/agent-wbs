// 생성 파일. 직접 고치지 말고 `pnpm client:generate`를 실행한다.
/* eslint-disable */

export type Agent = "Claude" | "Codex";

export type AttemptKind = "dev" | "qa" | "rework" | "reverify";

export type CiStage = "task" | "int" | "night" | "deploy";

export type CiStatus = "queued" | "run" | "pass" | "fail" | "skip";

export type ClaimedJob = {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "repo_check";
  payload: {
    repoCheckId: Id;
    url: RepoUrl;
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "github_check";
  payload: {
    mode: GithubMode;
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "bootstrap";
  payload: {
    planningJobId: Id;
    runNo: number;
    version: number;
    techDecisionVersion: Sha256;
    techDecisions: ({
      id: Id;
      tdKey: string;
      title: string;
      status: "fixed" | "approved" | "pending" | "rejected" | "noted" | "change";
      authority: "lead" | "agent" | "free";
      updatedAt: Timestamp;
      content: Record<string, unknown>;
    })[];
    commit: Sha;
    previousCommit: Sha | null;
    instruction: string;
    resumeStep: string | null;
    techConstraints: ({
      id: Id;
      name: string;
      level: "must" | "ban" | "cond";
      condition: string | null;
    })[];
    subagentDefs: ({
      id: Id;
      defKey: string;
      version: number;
      agent: Agent;
      role: string;
    })[];
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "input_diff";
  payload: {
    planningJobId: Id;
    runNo: number;
    version: number;
    wbs: {
      phases: ({
        id: Id;
        wps: ({
          id: Id;
          tasks: (TaskKey)[];
        })[];
      })[];
      tasks: ({
        taskKey: TaskKey;
        workType: WorkType;
        wp: Id;
        status: TaskStatus;
        subjectHash: Sha256;
        content: JudgedContent;
      })[];
      dependencies: ({
        pred: TaskKey;
        succ: TaskKey;
        type: DepType;
      })[];
    };
    commit: Sha;
    previousCommit: Sha;
    instruction: string;
    resumeStep: string | null;
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "planning";
  payload: {
    tasks: ({
      taskKey: TaskKey;
      workType: WorkType;
      subjectHash: Sha256;
      content: JudgedContent;
      gradeChange?: Uuid | null;
    })[];
    policy: Record<string, unknown>;
    proposal: {
      id: Id;
      ops: (JudgedProposalOp)[];
      targets: ({
        target: TaskKey;
        subjectHash: Sha256;
        before: JudgedContent;
        after: JudgedContent;
      } | {
        target: string;
        subjectHash: Sha256;
        before: null;
        after: JudgedContent;
      })[];
      splitSubjectHash: null;
      splitTasks: null;
    } | {
      id: Id;
      ops: (JudgedSplitProposalOp)[];
      targets: ({
        target: TaskKey;
        subjectHash: Sha256;
        before: JudgedContent;
        after: JudgedContent;
      } | {
        target: string;
        subjectHash: Sha256;
        before: null;
        after: JudgedContent;
      })[];
      splitSubjectHash: Sha256;
      splitTasks: ({
        taskKey: TaskKey;
        content: JudgedContent;
      })[];
    };
    planning: null;
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "planning";
  payload: {
    tasks: ({
      taskKey: TaskKey;
      workType: WorkType;
      subjectHash: Sha256;
      content: JudgedContent;
      gradeChange?: Uuid | null;
    })[];
    policy: Record<string, unknown>;
    proposal: null;
    planning: {
      id: Id;
      title: string;
      scope: string;
    };
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "planning";
  payload: {
    tasks: ({
      taskKey: TaskKey;
      workType: WorkType;
      subjectHash: Sha256;
      content: JudgedContent;
      gradeChange?: Uuid | null;
    })[];
    policy: Record<string, unknown>;
    proposal: null;
    planning: null;
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "estimate";
  payload: {
    tasks: ({
      taskKey: TaskKey;
      workType: WorkType;
      subjectHash: Sha256;
      content: JudgedContent;
      gradeChange?: Uuid | null;
    })[];
    policy: EstimatePolicy;
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "split";
  payload: {
    tasks: ({
      taskKey: TaskKey;
      workType: WorkType;
      subjectHash: Sha256;
      content: JudgedContent;
      gradeChange?: Uuid | null;
    })[];
    policy: Record<string, unknown>;
    wbs: {
      phases: ({
        id: Id;
        wps: ({
          id: Id;
          tasks: (TaskKey)[];
        })[];
      })[];
      tasks: ({
        taskKey: TaskKey;
        workType: WorkType;
        wp: Id;
        status: TaskStatus;
        subjectHash: Sha256;
        content: JudgedContent;
      })[];
      dependencies: ({
        pred: TaskKey;
        succ: TaskKey;
        type: DepType;
      })[];
    };
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "attempt";
  payload: {
    taskKey: TaskKey;
    kind: AttemptKind;
    agent: Agent;
    branch: string;
    baseCommit: Sha;
    inputVersion: number;
    instructions: Record<string, unknown>;
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "stop_attempt";
  payload: {
    attemptId: Id;
    reason: string;
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "integrate";
  payload: {
    pr: number;
    commit: Sha;
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "deploy_check";
  payload: {
    commit: Sha;
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "ci_retry";
  payload: {
    runId: Id;
    pr: number | null;
    commit: Sha;
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "design_apply";
  payload: {
    itemKey: string;
    driftId: Id;
  };
} | {
  id: Id;
  leaseUntil: Timestamp;
  fence: number;
  kind: "merge_followup";
  payload: {
    pr: number;
  };
};

export type Confidence = "상" | "중" | "하";

export type DateOnly = string;

export type Decision = {
  id: Id;
  tdKey: string;
  area: string;
  title: string;
  choice: string;
  authority: "lead" | "agent" | "free";
  level: "must" | "cond" | "ban" | null;
  condition: string;
  status: "fixed" | "approved" | "pending" | "rejected" | "noted" | "change";
  reason: string;
  alternatives: string;
  by: string;
  at: Timestamp;
  updatedAt: Timestamp;
  constraintId?: Id | null;
  conditionResult?: "met" | "not_met" | null;
  itemKey?: string;
  driftId?: Id;
  change?: {
    choice: string;
    reason: string;
    previousStatus: "fixed" | "approved";
    itemKey?: string;
    driftId?: Id;
  };
};

export type DepType = "FS" | "SS";

export type DesignKind = "DB" | "API" | "FE" | "DevOps";

export type Domain = "FE" | "BE" | "DB" | "DevOps" | "API" | "QA" | "Architecture" | "Common";

export type ErrorResponse = {
  error: {
    code: "VALIDATION_FAILED" | "DEPENDENCY_SELF" | "LIMIT_EXCEEDS_CAP" | "IDEMPOTENCY_KEY_REQUIRED" | "LEAD_UNAUTHORIZED" | "RUNNER_UNAUTHORIZED" | "LOGIN_FAILED" | "FORBIDDEN_PRINCIPAL" | "TASK_NOT_FOUND" | "PROJECT_NOT_FOUND" | "WBS_NODE_NOT_FOUND" | "DEPENDENCY_NOT_FOUND" | "ATTEMPT_NOT_FOUND" | "MESSAGE_NOT_FOUND" | "NOT_FOUND" | "VERSION_CONFLICT" | "EPOCH_MISMATCH" | "DEPENDENCY_DUPLICATE" | "RECIPIENT_DUPLICATE" | "DEPENDENCY_CYCLE" | "TASK_HAS_SUCCESSORS" | "EXTERNAL_WRITE_BLOCKED" | "PROJECT_EXISTS" | "INPUT_UNCHANGED" | "ATTEMPT_CLOSED" | "SCHEDULE_CYCLE" | "INVALID_TRANSITION" | "SPLIT_JUDGEMENT_REQUIRED" | "ACTIVE_TASK_BLOCKED" | "ORDER_NOT_PRESERVED" | "GATE_NOT_PASSED" | "MERGE_MISMATCH" | "CLAIM_REJECTED" | "LEASE_LOST" | "CLEANUP_PENDING" | "IDEMPOTENCY_CONFLICT" | "DECISIONS_PENDING" | "SUBAGENT_INSTALL_FAILED" | "RATE_LIMITED" | "INTERNAL" | "UNAVAILABLE" | "PDF_FAILED";
    message: string;
    action: string;
    fix: string;
    errors: ({
      path: string;
      rule: string;
      message: string;
    })[];
    details: Record<string, unknown>;
    requestId: string;
  };
};

export type EstimatePolicy = {
  rejudge?: RejudgeRequest;
  gradeChange?: Uuid;
  [key: string]: unknown;
};

export type ExecutionHold = {
  id: Id;
  project_id: Id | null;
  job: Id;
  attempt: Id | null;
  epoch: number;
  host_id: string | null;
  boot_id: string | null;
  fence: number | null;
  pgid: number | null;
  cgroup: string | null;
  task: Id | null;
  conflict_group: string | null;
  agent: Agent;
  slots: number;
  heavy: boolean;
  slot_state: "none" | "reserved" | "active" | "unconfirmed";
  lock_state: "none" | "held" | "orphaned" | "handed_over" | "released";
  lock_from_job: Id | null;
  handed_to_job: Id | null;
  release_proof: "no_process" | "group_empty" | "boot_changed" | "cgroup_empty" | null;
  closed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  lease_owner?: string | null;
  lease_until?: Timestamp | null;
};

export type GithubMode = "gh" | "token";

export type GithubPermission = "verified" | "unverified" | "missing";

export type Id = string;

export type JudgedContent = {
  title: string;
  scope: (string)[];
  out: (string)[];
  doneCond: string;
  spec: {
    req: (string)[];
    work: (string)[];
    steps: (string)[];
    inputs: (string)[];
    outputs: (string)[];
    files: (string)[];
    constraints: (string)[];
    errors: (string)[];
    docs: (string)[];
    verify: (string)[];
  };
  ac: ({
    given: string;
    when: string;
    then: string;
    method: string;
  })[];
  outputs: ({
    name: string;
    kind: string;
    required: boolean;
    verify: string;
  })[];
  designs: ({
    kind: DesignKind;
    content: Record<string, unknown>;
  })[];
  conflictGroup: string | null;
};

export type JudgedProposalOp = {
  op: "add";
  ref: string;
  t: {
    title: string;
    type: WorkType;
    domain: Domain;
    rel?: (Domain)[];
    wp: Id;
    priority: number;
    assignee: Agent;
    verifier: Agent;
    purpose: string;
    doneCond: string;
    est?: number;
    lo?: number;
    hi?: number;
    tok?: number;
    conf?: Confidence;
    basis?: string;
    ac?: ({
      given: string;
      when: string;
      then: string;
      method?: string;
    })[];
    srcV?: number;
    splitBasis?: string;
    scope?: (string)[];
    files?: (string)[];
    design?: ({
      kind: DesignKind;
      content: Record<string, unknown>;
    })[];
    conflictGroup?: string | null;
  };
  preds: ({
    pred: Id;
    type: DepType;
  })[];
} | {
  op: "modify";
  task: TaskKey;
  field: "title";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "doneCond";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "scopeAdd";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "acAdd";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "priority";
  before?: unknown;
  after: number;
} | {
  op: "modify";
  task: TaskKey;
  field: "assignee";
  before?: unknown;
  after: Agent;
} | {
  op: "modify";
  task: TaskKey;
  field: "verifier";
  before?: unknown;
  after: Agent;
} | {
  op: "remove";
  task: TaskKey;
} | {
  op: "dep-add";
  pred: Id;
  succ: Id;
  type: DepType;
} | {
  op: "dep-remove";
  pred: Id;
  succ: Id;
};

export type JudgedSplitProposalOp = {
  op: "add";
  ref: string;
  t: {
    title: string;
    type: WorkType;
    domain: Domain;
    rel?: (Domain)[];
    wp: Id;
    priority: number;
    assignee: Agent;
    verifier: Agent;
    purpose: string;
    doneCond: string;
    est?: number;
    lo?: number;
    hi?: number;
    tok?: number;
    conf?: Confidence;
    basis?: string;
    ac?: ({
      given: string;
      when: string;
      then: string;
      method?: string;
    })[];
    srcV?: number;
    splitBasis: string;
    scope?: (string)[];
    files?: (string)[];
    design?: ({
      kind: DesignKind;
      content: Record<string, unknown>;
    })[];
    conflictGroup?: string | null;
  };
  preds: ({
    pred: Id;
    type: DepType;
  })[];
} | {
  op: "modify";
  task: TaskKey;
  field: "title";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "doneCond";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "scopeAdd";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "acAdd";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "priority";
  before?: unknown;
  after: number;
} | {
  op: "modify";
  task: TaskKey;
  field: "assignee";
  before?: unknown;
  after: Agent;
} | {
  op: "modify";
  task: TaskKey;
  field: "verifier";
  before?: unknown;
  after: Agent;
} | {
  op: "remove";
  task: TaskKey;
} | {
  op: "dep-add";
  pred: Id;
  succ: Id;
  type: DepType;
} | {
  op: "dep-remove";
  pred: Id;
  succ: Id;
};

export type PassFail = "PASS" | "FAIL" | "BLOCKED";

export type Pipeline = {
  serviceConfig?: {
    path: RepoPath;
    commit: Sha;
    status: "ok" | "error" | "missing";
    raw: string | null;
    error: string | null;
  };
  path: ".agentwbs/pipeline.yaml";
  commit: Sha | null;
  status: "ok" | "error" | "missing";
  error: string | null;
  raw: string | null;
  stages: ({
    stage: CiStage;
    when: string;
    gate: string;
    steps: (string)[];
  })[] | null;
};

export type PlanningProposalOp = {
  op: "add";
  ref: string;
  t: {
    title: string;
    type: WorkType;
    domain: Domain;
    rel?: (Domain)[];
    wp: Id;
    priority: number;
    assignee: Agent;
    verifier: Agent;
    purpose: string;
    doneCond: string;
    est?: number;
    lo?: number;
    hi?: number;
    tok?: number;
    conf?: Confidence;
    basis?: string;
    ac?: ({
      given: string;
      when: string;
      then: string;
      method?: string;
    })[];
    srcV?: number;
    splitBasis?: string;
    scope?: (string)[];
    files?: (string)[];
    design?: ({
      kind: DesignKind;
      content: Record<string, unknown>;
    })[];
    conflictGroup?: string | null;
    judgedRules?: {
      schemaVersion: 1;
      items: ({
        rule: "revert" | "contract" | "refactor";
        result: "met" | "not_met";
        agreedBy: (Agent)[];
        basis: string;
        judgedAt: Timestamp;
        sourceRef: string;
      })[];
    };
  };
  preds: ({
    pred: Id;
    type: DepType;
  })[];
} | {
  op: "modify";
  task: TaskKey;
  field: "title";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "doneCond";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "scopeAdd";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "acAdd";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "priority";
  before?: unknown;
  after: number;
} | {
  op: "modify";
  task: TaskKey;
  field: "assignee";
  before?: unknown;
  after: Agent;
} | {
  op: "modify";
  task: TaskKey;
  field: "verifier";
  before?: unknown;
  after: Agent;
} | {
  op: "remove";
  task: TaskKey;
} | {
  op: "dep-add";
  pred: Id;
  succ: Id;
  type: DepType;
} | {
  op: "dep-remove";
  pred: Id;
  succ: Id;
};

export type PlanningSplitProposalOp = {
  op: "add";
  ref: string;
  t: {
    title: string;
    type: WorkType;
    domain: Domain;
    rel?: (Domain)[];
    wp: Id;
    priority: number;
    assignee: Agent;
    verifier: Agent;
    purpose: string;
    doneCond: string;
    est?: number;
    lo?: number;
    hi?: number;
    tok?: number;
    conf?: Confidence;
    basis?: string;
    ac?: ({
      given: string;
      when: string;
      then: string;
      method?: string;
    })[];
    srcV?: number;
    splitBasis: string;
    scope?: (string)[];
    files?: (string)[];
    design?: ({
      kind: DesignKind;
      content: Record<string, unknown>;
    })[];
    conflictGroup?: string | null;
    judgedRules?: {
      schemaVersion: 1;
      items: ({
        rule: "revert" | "contract" | "refactor";
        result: "met" | "not_met";
        agreedBy: (Agent)[];
        basis: string;
        judgedAt: Timestamp;
        sourceRef: string;
      })[];
    };
  };
  preds: ({
    pred: Id;
    type: DepType;
  })[];
} | {
  op: "modify";
  task: TaskKey;
  field: "title";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "doneCond";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "scopeAdd";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "acAdd";
  before?: unknown;
  after: string;
} | {
  op: "modify";
  task: TaskKey;
  field: "priority";
  before?: unknown;
  after: number;
} | {
  op: "modify";
  task: TaskKey;
  field: "assignee";
  before?: unknown;
  after: Agent;
} | {
  op: "modify";
  task: TaskKey;
  field: "verifier";
  before?: unknown;
  after: Agent;
} | {
  op: "remove";
  task: TaskKey;
} | {
  op: "dep-add";
  pred: Id;
  succ: Id;
  type: DepType;
} | {
  op: "dep-remove";
  pred: Id;
  succ: Id;
};

export type QueueStatus = "waiting_verify" | "queued" | "checking" | "merged" | "failed" | "removed";

export type RejudgeRequest = {
  reason: "model_disallowed" | "floor_changed" | "subagent_disallowed" | "grade_changed";
  trigger: string;
  targets: ({
    taskKey: TaskKey;
    roles: (RunRole)[];
  })[];
};

export type ReplanSummary = {
  replanId: string;
  baselineVersion: number | null;
  projectEnd: DateOnly;
  range: {
    lo: DateOnly;
    hi: DateOnly;
  };
  moved: ({
    taskKey: TaskKey;
    kind: "delayed" | "advanced" | "new" | "excluded";
    before: DateOnly | null;
    after: DateOnly | null;
    deltaDays: number | null;
  })[];
};

export type RepoPath = string;

export type RepoUrl = string;

export type RunRole = "dev" | "qa";

export type Sha = string;

export type Sha256 = string;

export type StepStatus = "wait" | "run" | "done" | "fail";

export type SubagentName = string;

export type TaskKey = string;

export type TaskStatus = "planning" | "approval" | "ready" | "running" | "paused" | "qa" | "rework" | "verifying" | "gate" | "failed" | "done" | "cancelled";

export type Timestamp = string;

export type Uuid = string;

export type WorkType = "Analysis" | "Design" | "Implementation" | "Configuration" | "Test" | "Verification" | "Documentation" | "Integration";

export interface Operations {
  /** 기술 결정 추가. agent는 팀장 승인 대기, free는 재량 기록 */
  createDecision: {
    request: {
      params: {
        projectId: Id;
      };
      body: {
        jobId: Id;
        fence: number;
        authority: "agent" | "free";
        area: string;
        title: string;
        choice: string;
        reason: string;
        alternatives: string;
      } | {
        jobId: Id;
        fence: number;
        authority: "agent" | "free";
        area: string;
        title: string;
        choice: string;
        reason: string;
        alternatives: string;
        itemKey: string;
        driftId: Id;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      201: Decision;
    };
  };
  /** 생존 보고(60초 주기) */
  heartbeat: {
    request: {
      body: {
        runnerId: string;
        version: string;
        epoch: number;
      };
      epoch: number;
    };
    responses: {
      204: undefined;
    };
  };
  /** 세션 시작·종료 보고(가동률 근거). 열린 세션이 없는 stop은 409 */
  reportSession: {
    request: {
      body: {
        runnerId: string;
        event: "start" | "stop";
        at: Timestamp;
        reason?: "reboot" | "power_off" | "error" | "manual";
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 실행 PC 사양 보고 */
  reportHost: {
    request: {
      body: {
        hostId: string;
        bootId: string;
        cpu: string;
        cores: number;
        memGB: number;
        swapGB: number;
        diskFreeGB: number;
        os: string;
        perSessionGB?: number;
        samples?: number;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      200: {
        mode: "auto" | "manual";
        caps: {
          total: number;
          Claude: number;
          Codex: number;
          heavy: number;
        };
        recommended: {
          total: number;
          Claude: number;
          Codex: number;
          heavy: number;
        };
        hostChanged: boolean;
      };
    };
  };
  /** 실행 환경 준비 상태 보고 */
  reportReadiness: {
    request: {
      body: {
        at: Timestamp;
        items: ({
          key: "claude" | "codex" | "git" | "node" | "pnpm" | "pg" | "repo" | "disk" | "subs" | "obs" | "gh" | "lfs" | "reports" | "font" | "render" | "paid_calls";
          status: "ok" | "warn" | "fail";
          detail: string;
          fix?: string;
        })[];
        cli?: ({
          agent: Agent;
          version: string;
          model: string;
          options: string;
        })[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 사용 가능 모델·Effort 보고(신규는 미허용, 순서는 서버 설정) */
  reportModels: {
    request: {
      body: {
        agent: Agent;
        models: ({
          id: string;
          label: string;
          efforts: (string)[] | null;
        })[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      200: {
        newModels: (string)[];
      };
    };
  };
  /** 남은 사용량·리셋 시각 보고 */
  reportUsage: {
    request: {
      body: {
        agent: Agent;
        remainPct: number;
        resetAt?: Timestamp;
        tokensUsed?: number;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 동시 실행 상태·한도 조절 보고 */
  reportConcurrency: {
    request: {
      body: {
        at: Timestamp;
        limit: number;
        running: {
          Claude: number;
          Codex: number;
        };
        subagents: number;
        heavyJobs: number;
        resources: {
          cpuPct: number;
          memFreeGB: number;
          swapGB: number;
        };
        sessions: ({
          attemptId: Id;
          observed: number;
          reserved: number;
          state: "ok" | "unconfirmed";
        })[];
        adjust?: {
          from: number;
          to: number;
          reason: string;
        };
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      200: {
        caps: {
          total: number;
          Claude: number;
          Codex: number;
          heavy: number;
          memReserveGB: number;
        };
      };
    };
  };
  /** 실행 직전 등급 조회(등급 정책의 단일 출처) */
  getRunGrade: {
    request: {
      params: {
        taskKey: TaskKey;
      };
      query: {
        role: RunRole;
      };
      epoch: number;
    };
    responses: {
      200: {
        model: string;
        effort: string;
        adjust: {
          kind: "up" | "down" | "keep" | "regrade";
          from: {
            model: string;
            effort: string;
          };
          to: {
            model: string;
            effort: string;
          };
          reason: string;
        } | null;
        locked: boolean;
        floorEffort: string;
        allowedModels: (string)[];
        policy: {
          onUsage: "wait" | "down";
          lowPct: number;
          onRework: "same" | "up1" | "top";
          notifyAt: number;
        };
      };
    };
  };
  /** 실행 직전 설치할 하위 Agent 정의(모델·effort 없음) */
  getTaskSubagents: {
    request: {
      params: {
        taskKey: TaskKey;
      };
      query: {
        role: RunRole;
      };
      epoch: number;
    };
    responses: {
      200: {
        enabled: boolean;
        items: ({
          id: Id;
          key: string;
          agent: Agent;
          version: number;
          hash: string;
          file: string;
          sandbox: string;
        })[];
      };
    };
  };
  /** 대기 메시지 조회. cursor 우선, since는 호환용 */
  pollMessages: {
    request: {
      query?: {
        cursor?: string;
        since?: Timestamp;
      };
      epoch: number;
    };
    responses: {
      200: {
        messages: ({
          id: Id;
          taskKey: TaskKey;
          attemptId: Id | null;
          toAgent: Agent;
          type: "추가 지시" | "수정 요청" | "질문" | "일반 의견";
          body: string;
          pendingNext: boolean;
          createdAt: Timestamp;
        })[];
        nextCursor: string | null;
      };
    };
  };
  /** 수신 확인(작업 완료 보고와 별개) */
  ackMessage: {
    request: {
      params: {
        messageId: Id;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** Agent 응답(전달 상태와 별개) */
  respondMessage: {
    request: {
      params: {
        messageId: Id;
      };
      body: {
        text: string;
        workState: string;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 실행 상태 + 실제 모델·Effort·조정 사유 */
  reportAttemptStatus: {
    request: {
      params: {
        attemptId: Id;
      };
      body: {
        fence: number;
        status: "running" | "succeeded" | "failed";
        at: Timestamp;
        model: string;
        effort: string;
        adjust?: {
          kind: "up" | "down" | "keep" | "regrade";
          from: {
            model: string;
            effort: string;
          };
          to: {
            model: string;
            effort: string;
          };
          reason: string;
        };
        subagents?: ({
          id: Id;
          version: number;
          installed: boolean;
        })[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 실행 중단 보고 → Task paused */
  interruptAttempt: {
    request: {
      params: {
        attemptId: Id;
      };
      body: {
        fence: number;
        reason: "reboot" | "power_off" | "usage_limit" | "error";
        at: Timestamp;
        progressNote?: string;
        tokensUsed?: number;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      200: {
        taskStatus: "paused";
      };
    };
  };
  /** 결과 보고. qa·reverify는 verification 필수 */
  reportAttemptResult: {
    request: {
      params: {
        attemptId: Id;
      };
      body: {
        fence: number;
        summary: string;
        changedFiles: (RepoPath)[];
        evidence: (Id)[];
        failure?: string;
        tokens?: number;
        pr?: number;
        prHead?: string;
      } | {
        fence: number;
        summary: string;
        changedFiles: (RepoPath)[];
        evidence: (Id)[];
        failure?: string;
        tokens?: number;
        pr?: number;
        prHead?: string;
        verification: {
          headSha: Sha;
          specRevision: number;
          result: PassFail;
          cmd: string;
          expected: string;
          actual: string;
          defects: ({
            text: string;
            blocking: boolean;
          })[];
          checklist: ({
            itemKey: Id;
            done: boolean;
            evidence?: Id;
            note?: string;
          })[];
        };
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      201: undefined;
    };
  };
  /** Evidence 1파일 업로드(결과 보고 전). sha256·크기 검증 */
  uploadEvidence: {
    request: {
      params: {
        attemptId: Id;
      };
      body: {
        file: Blob;
        kind: string;
        sha256: Sha256;
        size: number;
        fence: number;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      201: {
        id: Id;
      };
    };
  };
  /** 실제 사용한 하위 Agent 사후 확정. job이 끝났어도 그 job의 마지막 fence면 받음 */
  reportSubagentUsage: {
    request: {
      params: {
        attemptId: Id;
      };
      body: {
        fence: number;
        confirm: "confirmed" | "partial";
        items: ({
          id: SubagentName;
          version: number | null;
          hash: string | null;
          count?: number;
        })[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 입력 변경 보고(비교 후 갱신). base가 서버의 입력 head와 다르면 409와 현재 head */
  reportInputChanges: {
    request: {
      body: {
        base: Sha;
        head: Sha;
        baseIsAncestor: boolean;
        treeHash: Sha;
        changes: ({
          status: "A" | "M" | "D" | "R" | "T";
          path: RepoPath;
          from?: RepoPath;
          oldBlob: Sha | null;
          newBlob: Sha | null;
          oldMode: string | null;
          newMode: string | null;
          added: number;
          deleted: number;
        })[];
        commits: ({
          sha: Sha;
          at: Timestamp;
          author: string;
          message: string;
        })[];
        pipelineObservation?: {
          baseSha: Sha;
          pipelineSha: Sha | null;
          definition: Pipeline;
        };
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      200: {
        head: Sha;
        recorded: boolean;
        historyRewritten: boolean;
      };
    };
  };
  /** 저장소 접근·private·main 커밋·필수 구조 */
  reportRepoCheck: {
    request: {
      params: {
        id: Id;
      };
      body: {
        fence: number;
        access: boolean;
        private: boolean | null;
        commit: Sha | null;
        structure: {
          uiux: boolean;
          uiuxFiles: number;
          docs: (RepoPath)[];
          src: boolean;
          contracts: boolean;
          agentwbs: boolean;
        } | null;
        error?: string;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 초기 분석·차이 분석 단계 진행 */
  reportBootstrapProgress: {
    request: {
      params: {
        jobId: Id;
      };
      body: {
        fence: number;
        stepKey: "check" | "unzip" | "repo" | "codex" | "claude" | "cross" | "tech" | "draft" | "approve" | "diff" | "impact" | "cp";
        status: StepStatus;
        at: Timestamp;
        note?: string;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 예약한 CI job의 검증 근거와 재실행 원본 조회 */
  getCiJob: {
    request: {
      params: {
        id: Id;
      };
      query: {
        fence: number;
      };
      epoch: number;
    };
    responses: {
      200: {
        runnable: boolean;
        taskKey: TaskKey | null;
        branch: string | null;
        hold: {
          hostId: string;
          bootId: string | null;
          processGroup: number | null;
          slotState: "none" | "reserved" | "active" | "unconfirmed";
        } | null;
        verification: {
          passed: boolean;
          headSha: Sha;
          specRevision: number;
        } | null;
        source: {
          stage: CiStage;
          ref: string;
          pr: number | null;
          baseSha: Sha | null;
          headSha: Sha;
          pipelineSha: Sha;
        } | null;
      };
    };
  };
  /** 현재 임대의 계약 반영 대상. 추출을 확인한 원본 커밋·파일·목표만 조회 */
  getDesignApplyJob: {
    request: {
      params: {
        id: Id;
      };
      query: {
        fence: number;
      };
      epoch: number;
    };
    responses: {
      200: {
        sourceCommit: Sha;
        path: RepoPath;
        target: {
          fields: ({
            path: string;
            type: string;
            required: boolean;
          })[];
        };
      };
    };
  };
  /** 빌드·통합 실행 시작 */
  startCiRun: {
    request: {
      body: {
        jobId: Id;
        fence: number;
        stage: CiStage;
        taskKey?: TaskKey;
        attemptId?: Id;
        ref: string;
        pr?: number;
        prHead?: string;
        trigger: string;
        baseSha?: Sha;
        headSha?: Sha;
        mergeSha?: Sha;
        treeSha?: Sha;
        pipelineSha: Sha;
      } | {
        stage: "night";
        taskKey?: TaskKey;
        attemptId?: Id;
        ref: string;
        pr?: number;
        prHead?: string;
        trigger: string;
        baseSha?: Sha;
        headSha?: Sha;
        mergeSha?: Sha;
        treeSha?: Sha;
        pipelineSha: Sha;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      201: {
        id: Id;
        runKey: string;
      };
    };
  };
  /** 단계 진행·결과(로그 원문은 Runner PC). fence는 시작 때 저장한 job과 대조하고, job 없는 야간 점검만 null */
  updateCiRun: {
    request: {
      params: {
        id: Id;
      };
      body: {
        fence: number | null;
        steps?: ({
          name: string;
          status: CiStatus;
          durationMs: number;
        })[];
        status?: CiStatus;
        failScope?: "baseline" | "task";
        causeCandidates?: ({
          commit: Sha;
        })[];
        note?: string;
        finishedAt?: Timestamp;
        e2e?: {
          passed: number;
          total: number;
        };
        githubStatus?: {
          headSha: Sha;
          context: string;
          state: "pending" | "success" | "failure" | "error";
          reportedAt: Timestamp;
          url?: string;
        };
        flakyTests?: ({
          testKey: string;
          rate: number;
          lastFailedAt: Timestamp;
        })[];
        deployRestore?: {
          commit: Sha | null;
          status: "pass" | "fail" | "none";
        };
        logExcerpt?: string;
        artifacts?: (string)[];
        url?: string;
        baseSha?: Sha;
        headSha?: Sha;
        mergeSha?: Sha;
        treeSha?: Sha;
        pipelineSha?: Sha;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 병합 상태(PR·병합 커밋) 보고 → 서버가 완료 판정 */
  reportMergeQueue: {
    request: {
      body: {
        jobId: Id;
        fence: number;
        pr: number;
        taskKey: TaskKey;
        status: QueueStatus;
        qaHeadSha?: Sha;
        syncedHeadSha?: Sha;
        baseSha?: Sha;
        ciRunId?: Id;
        testedTreeSha?: Sha;
        actualMergeSha?: Sha;
        actualTreeSha?: Sha;
        mergedAt?: Timestamp;
        headSync?: {
          qaHeadSha: Sha;
          headSha: Sha;
          preserved: boolean;
          parents: (Sha)[];
          autoMergeTreeSha: Sha;
          headTreeSha: Sha;
          additionalChanges: boolean;
          chain?: ({
            qaHeadSha: Sha;
            headSha: Sha;
            preserved: boolean;
            parents: (Sha)[];
            autoMergeTreeSha: Sha;
            headTreeSha: Sha;
            additionalChanges: boolean;
          })[];
        };
        mergeParents?: (Sha)[];
        mergeCommits?: ({
          commit: Sha;
          parents: (Sha)[];
        })[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 커밋 기준 계약 파일 해석·대조 결과 */
  reportDesignSnapshot: {
    request: {
      body: {
        jobId: Id;
        fence: number;
        commit: Sha;
        ref: string;
        files: ({
          path: RepoPath & string;
          kind: string;
          format: string;
          raw?: string;
          status: "ok" | "draft";
          error?: string;
        } | {
          path: RepoPath & string;
          kind: string;
          format: string;
          raw?: string;
          status: "error";
          error: string;
        })[];
        items: ({
          itemKey: string;
          kind: "REST";
          path: RepoPath & string;
          name?: string;
          taskKey?: TaskKey;
          description?: string | null;
          content: Record<string, unknown> | {
            type: "REST";
            auth: string;
            request: string;
            response: string;
            validation: (string)[];
            errors: ({
              code: string;
              http: string;
              cond: string;
            })[];
            tables: (string)[];
          };
          contract?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          };
          extracted?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          } | null;
        } | {
          itemKey: string;
          kind: "WebSocket";
          path: RepoPath & string;
          name?: string;
          taskKey?: TaskKey;
          description?: string | null;
          content: Record<string, unknown> | {
            type: "message";
            auth: string;
            messages: ({
              name: string;
              direction: string;
              schema: string;
            })[];
            rules: (string)[];
            decisionKeys?: (string)[];
            topic: {
              key: string;
              partitions: string;
              retention: string;
              delivery: string;
              dlq: string;
              compat: string;
              consumers: (string)[];
            } | null;
          };
          contract?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          };
          extracted?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          } | null;
        } | {
          itemKey: string;
          kind: "SSE";
          path: RepoPath & string;
          name?: string;
          taskKey?: TaskKey;
          description?: string | null;
          content: Record<string, unknown> | {
            type: "message";
            auth: string;
            messages: ({
              name: string;
              direction: string;
              schema: string;
            })[];
            rules: (string)[];
            decisionKeys?: (string)[];
            topic: {
              key: string;
              partitions: string;
              retention: string;
              delivery: string;
              dlq: string;
              compat: string;
              consumers: (string)[];
            } | null;
          };
          contract?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          };
          extracted?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          } | null;
        } | {
          itemKey: string;
          kind: "Kafka";
          path: RepoPath & string;
          name?: string;
          taskKey?: TaskKey;
          description?: string | null;
          content: Record<string, unknown> | {
            type: "message";
            auth: string;
            messages: ({
              name: string;
              direction: string;
              schema: string;
            })[];
            rules: (string)[];
            decisionKeys?: (string)[];
            topic: {
              key: string;
              partitions: string;
              retention: string;
              delivery: string;
              dlq: string;
              compat: string;
              consumers: (string)[];
            } | null;
          };
          contract?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          };
          extracted?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          } | null;
        } | {
          itemKey: string;
          kind: "postgres";
          path: RepoPath & string;
          name?: string;
          taskKey?: TaskKey;
          description?: string | null;
          content: Record<string, unknown> | {
            type: "postgres";
            columns: ({
              name: string;
              type: string;
              nullable: boolean;
              pk: boolean;
              unique: boolean;
              fk: string | null;
              default: string | null;
              desc: string;
            })[];
            constraints: (string)[];
            indexes: ({
              name: string;
              columns: string;
              kind: string;
            })[];
            usedBy: (string)[];
          };
          contract?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          };
          extracted?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          } | null;
        } | {
          itemKey: string;
          kind: "neo4j";
          path: RepoPath & string;
          name?: string;
          taskKey?: TaskKey;
          description?: string | null;
          content: Record<string, unknown> | {
            type: "neo4j-label";
            props: string;
            note: string;
            constraints: (string)[];
          } | {
            type: "neo4j-relation";
            from: string;
            to: string;
            props: string;
          };
          contract?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          };
          extracted?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          } | null;
        } | {
          itemKey: string;
          kind: "questdb";
          path: RepoPath & string;
          name?: string;
          taskKey?: TaskKey;
          description?: string | null;
          content: Record<string, unknown> | {
            type: "questdb";
            timestamp: string;
            partition: string;
            retention: string;
            dedup: string;
            symbols: string;
            columns: string;
            ingest: string;
            aggregation: string;
          };
          contract?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          };
          extracted?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          } | null;
        } | {
          itemKey: string;
          kind: "redis";
          path: RepoPath & string;
          name?: string;
          taskKey?: TaskKey;
          description?: string | null;
          content: Record<string, unknown> | {
            type: "redis";
            use: string;
            value: string;
            ttl: string;
            invalidation: string;
            persistence: string;
          };
          contract?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          };
          extracted?: {
            fields: ({
              path: string;
              type: string;
              required: boolean;
            })[];
          } | null;
        })[];
        drifts: ({
          itemKey: string;
          kind: string;
          where: string;
          text: string;
          taskKey?: TaskKey;
          compat: "compatible" | "breaking" | "unchecked";
        })[];
        edges?: ({
          from: string;
          to: string;
          kind: string;
        })[];
        ownership?: ({
          data: string;
          source: string;
          copy: string;
          sync: string;
          lag: string;
        })[];
        components?: ({
          id: Id;
          layer: string;
          name: string;
          tech: string;
          note: string;
          decisionId: Id | null;
        })[];
        links?: ({
          from: Id;
          to: Id;
          via: string;
          contractPath: string | null;
        })[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** GitHub 인증 방식·계정·권한 3상태·만료(비밀값 없음). 첫 쓰기 403이면 missing으로 다시 보고 */
  reportGithubStatus: {
    request: {
      body: {
        mode: GithubMode;
        jobId?: Id;
        fence?: number;
        ok: boolean;
        account: string | null;
        scopes: {
          contents: GithubPermission;
          pulls: GithubPermission;
          statuses: GithubPermission;
          metadata: GithubPermission;
        } | null;
        expiresAt: Timestamp | null;
        warning?: string;
        error?: string;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 봉인용 Runner 공개키 등록(프로세스 시작마다). keyId는 서버가 공개키 SHA-256 지문으로 계산 */
  registerGithubKey: {
    request: {
      body: {
        runnerId: string;
        hostId: string;
        bootId: string;
        publicKeyPem: string;
        sealedVersion: 1;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      200: {
        keyId: string;
      };
    };
  };
  /** 토큰 방식: 그 Runner에 등록된 keyId의 공개키로 봉인한 값(평문 없음, 봉인 형식 v1). 모르는 keyId는 404 */
  getGithubCredential: {
    request: {
      query: {
        keyId: string;
      };
      epoch: number;
    };
    responses: {
      200: {
        sealed: string;
      };
    };
  };
  /** 상한·예산·주기·CI 설정·Claude 모델 목록·CLI 관측 등급 묶음 */
  getRunnerPolicy: {
    request: {
      epoch: number;
      ifNoneMatch?: string;
    };
    responses: {
      200: {
        caps: {
          total: number;
          Claude: number;
          Codex: number;
          heavy: number;
          memReserveGB: number;
        };
        subagentBudget: {
          dev: number;
          qa: number;
        };
        heartbeatSeconds: number;
        inputCheckMinutes: number;
        inputRecheck: number;
        inputCheckRequest?: number;
        readinessCheckRequest?: number;
        githubMode?: GithubMode;
        ci: {
          nightAt: string;
          retry: number;
          deployUrl: string | null;
          quarantined: (string)[];
        };
        claudeModels: (string)[];
        cliGrades: ({
          agent: Agent;
          version: string;
          model: string;
          options: string;
          grade: "verified" | "partial" | "unverified";
        })[];
        closedBranches?: (string)[];
      };
      304: undefined;
    };
  };
  /** 현재 Runner principal·epoch의 미해제 실행 보유. 읽기 전용 재시작 대조 */
  getExecutionHolds: {
    request: {
      epoch: number;
    };
    responses: {
      200: {
        holds: (ExecutionHold)[];
      };
    };
  };
  /** 정리 명령(다른 작업보다 먼저) */
  getCommands: {
    request: {
      epoch: number;
    };
    responses: {
      200: {
        currentEpoch: number;
        commands: ({
          id: Id;
          kind: "reset-cleanup";
          epoch: number;
          payload: {
            holds?: (ExecutionHold)[];
            [key: string]: unknown;
          };
        })[];
      };
    };
  };
  /** 명령 결과. X-Project-Epoch에 commands[].epoch를 그대로 보내며 명령 ID와 일치해야 한다(D-04) */
  reportCommandResult: {
    request: {
      params: {
        id: Id;
      };
      body: {
        status: "done";
        items: ({
          name: string;
          ok: boolean;
          detail: string;
        })[];
        holds: ({
          job: Id;
          hostId: string | null;
          bootId: string | null;
          proof: "no_process";
        } | {
          job: Id;
          hostId: string | null;
          bootId: string | null;
          proof: "group_empty";
          processGroup: number;
        } | {
          job: Id;
          hostId: string | null;
          bootId: string | null;
          proof: "cgroup_empty";
          processGroup: number;
          cgroup: string;
        } | {
          job: Id;
          hostId: string | null;
          bootId: string | null;
          proof: "boot_changed";
          processGroup?: number | null;
          currentBootId: string;
        })[];
      } | {
        status: "failed";
        items: ({
          name: string;
          ok: boolean;
          detail: string;
        })[];
        holds?: ({
          job: Id;
          hostId: string | null;
          bootId: string | null;
          proof: "no_process";
        } | {
          job: Id;
          hostId: string | null;
          bootId: string | null;
          proof: "group_empty";
          processGroup: number;
        } | {
          job: Id;
          hostId: string | null;
          bootId: string | null;
          proof: "cgroup_empty";
          processGroup: number;
          cgroup: string;
        } | {
          job: Id;
          hostId: string | null;
          bootId: string | null;
          proof: "boot_changed";
          processGroup?: number | null;
          currentBootId: string;
        })[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 작업 임대(attempt는 예약만) */
  claimJob: {
    request: {
      body: {
        kinds: ("repo_check" | "bootstrap" | "input_diff" | "planning" | "estimate" | "split" | "attempt" | "stop_attempt" | "integrate" | "deploy_check" | "ci_retry" | "design_apply" | "merge_followup" | "github_check")[];
        capacity: number;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      200: {
        job: ClaimedJob;
      };
      204: undefined;
    };
  };
  /** 임대 연장 */
  renewJob: {
    request: {
      params: {
        id: Id;
      };
      body: {
        fence: number;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      200: {
        leaseUntil: Timestamp;
      };
    };
  };
  /** 시작 전 자원 부족 attempt job을 재대기열에 반환. 시도 없이 잠금·fence 유지 */
  returnJob: {
    request: {
      params: {
        id: Id;
      };
      body: {
        fence: number;
        hostId: string;
        bootId: string;
        reason: "resources";
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 시작 확정(attempt는 시도 생성·Task 전이). 슬롯은 reserved 유지 */
  startJob: {
    request: {
      params: {
        id: Id;
      };
      body: {
        fence: number;
        hostId: string;
        bootId: string;
        headSha?: Sha;
        installedSubagents: ({
          id: Id;
          version: number;
          hash: string;
        })[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      200: {
        attemptId?: Id;
      };
    };
  };
  /** 프로세스 생성 직후 기록(reserved→active). 같은 pgid 재전송은 성공, 다른 pgid는 INVALID_TRANSITION */
  reportJobProcess: {
    request: {
      params: {
        id: Id;
      };
      body: {
        fence: number;
        processGroup: number;
        cgroup: string | null;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 물리 슬롯만 반환(논리 잠금 유지). 서버 보유에 pgid가 있으면 no_process는 INVALID_TRANSITION */
  releaseJobSlots: {
    request: {
      params: {
        id: Id;
      };
      body: {
        fence: number;
        hostId: string;
        proof: {
          kind: "no_process";
          bootId: string;
        } | {
          kind: "group_empty";
          bootId: string;
          processGroup: number;
        } | {
          kind: "cgroup_empty";
          bootId: string;
          processGroup: number;
          cgroup: string;
        } | {
          kind: "boot_changed";
          bootId: string;
          processGroup: number | null;
          currentBootId: string;
        };
        at: Timestamp;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** CLI·① 실행 전 용량 재획득(none→reserved). 그룹은 생성 뒤 /process */
  acquireJobSlots: {
    request: {
      params: {
        id: Id;
      };
      body: {
        fence: number;
        hostId: string;
        agent?: Agent;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 잔여 보유 해제(원래 job·host·boot·group이 맞으면 낡은 fence 허용). 서버 보유에 pgid가 있으면 no_process는 INVALID_TRANSITION */
  releaseJob: {
    request: {
      params: {
        id: Id;
      };
      body: {
        fence: number;
        hostId: string;
        proof: {
          kind: "no_process";
          bootId: string;
        } | {
          kind: "group_empty";
          bootId: string;
          processGroup: number;
        } | {
          kind: "cgroup_empty";
          bootId: string;
          processGroup: number;
          cgroup: string;
        } | {
          kind: "boot_changed";
          bootId: string;
          processGroup: number | null;
          currentBootId: string;
        };
        at: Timestamp;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 외부 상태 대조 결과(효과 없음/완료됨/부분 적용) */
  reconcileJob: {
    request: {
      params: {
        id: Id;
      };
      body: {
        fence: number;
        evidence: {
          outcome: "none" | "done" | "partial";
          checkedAt: Timestamp;
          detail: Record<string, unknown>;
        };
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 작업 종료. 설치 실패는 error.code=SUBAGENT_INSTALL_FAILED */
  finishJob: {
    request: {
      params: {
        id: Id;
      };
      body: {
        fence: number;
        status: "done" | "failed" | "cancelled";
        result?: Record<string, unknown>;
        error?: {
          code: string;
          message: string;
        };
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** Task별 추정 등록·재추정(완료 Task 거부) */
  submitEstimates: {
    request: {
      body: {
        jobId: Id;
        fence: number;
        items: ({
          taskKey: TaskKey;
          estHours: number;
          loHours: number;
          hiHours: number;
          tokensK?: number;
          confidence: Confidence;
          basis: string;
          agreedBy: (Agent)[];
        })[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      200: {
        replan?: ReplanSummary;
      };
    };
  };
  /** 일정 재조정. 서버가 다시 계산하며 정책이 꺼져 있으면 202 */
  requestReplan: {
    request: {
      body: {
        jobId: Id;
        fence: number;
        trigger: string;
        capacity: {
          rate: number;
          concurrency: number;
          subRatio: number;
        };
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      201: ReplanSummary;
      202: ReplanSummary;
    };
  };
  /** 초기 WBS 초안 등록(승인 전 WBS 미반영). 현재 실행 job만 받는다 */
  submitDraft: {
    request: {
      params: {
        jobId: Id;
      };
      body: {
        fence: number;
        phases: ({
          ref: string;
          title: string;
        })[];
        wps: ({
          ref: string;
          phaseRef: string;
          title: string;
        })[];
        tasks: ({
          ref: string;
          wpRef: string;
          title: string;
          workType: WorkType;
          primaryDomain: Domain;
          relatedDomains: (Domain)[];
          priority: number;
          assigneeAgent: Agent;
          verifierAgent: Agent;
          estimate: {
            estHours: number;
            loHours: number;
            hiHours: number;
            tokensK?: number;
            confidence: Confidence;
            basis: string;
            agreedBy: (Agent)[];
          };
          overview?: {
            purpose: string;
            background: string;
            scope: (string)[];
            out: (string)[];
            precond: string;
            doneCond: string;
          };
          spec?: {
            req: (string)[];
            work: (string)[];
            steps: (string)[];
            inputs: (string)[];
            outputs: (string)[];
            files: (string)[];
            constraints: (string)[];
            errors: (string)[];
            docs: (string)[];
            verify: (string)[];
          };
          ac?: ({
            given: string;
            when: string;
            then: string;
            method: string;
          })[];
          outputs: ({
            name: string;
            kind: string;
            required: boolean;
            verify: string;
            delivered: boolean;
          })[];
          checklist: ({
            content: string;
            required: boolean;
            verifyMethod?: string | null;
          })[];
          grades: {
            dev: {
              modelId: string;
              effort: string;
              reason: string;
            };
            qa: {
              modelId: string;
              effort: string;
              reason: string;
            };
          };
          subagents: {
            dev: (Id)[];
            qa: (Id)[];
            basis: string;
          };
          splitBasis: string;
          judgedRules?: {
            schemaVersion: 1;
            items: ({
              rule: "revert" | "contract" | "refactor";
              result: "met" | "not_met";
              agreedBy: (Agent)[];
              basis: string;
              judgedAt: Timestamp;
              sourceRef: string;
            })[];
          };
          conflictGroup: string | null;
          designItems: ({
            itemKey: string;
            change: string;
          })[];
        })[];
        deps: ({
          predRef: string;
          succRef: string;
          depType: DepType;
        })[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      201: {
        revision: number;
      };
    };
  };
  /** 기술 결정 제안(근거·대안)과 조건부 선호별 조건 충족 판단. 등록한 조건부 제약마다 판단이 정확히 하나 필요 */
  submitTechProposals: {
    request: {
      params: {
        jobId: Id;
      };
      body: {
        fence: number;
        decisions: ({
          area: string;
          title: string;
          choice: string;
          reason: string;
          alternatives: string;
        })[];
        conditionJudgements?: ({
          constraintId: Id;
          result: "met" | "not_met";
          reason: string;
        })[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      201: undefined;
    };
  };
  /** Planning 세션 생성 */
  createPlanningSession: {
    request: {
      body: {
        jobId: Id;
        fence: number;
        title: string;
        scope: string;
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      201: {
        id: Id;
      };
    };
  };
  /** Agent별 독립 분석 */
  submitPlanningAnalysis: {
    request: {
      params: {
        id: Id;
      };
      body: {
        jobId: Id;
        fence: number;
        agent: Agent;
        summary: string;
        items: (string)[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      201: undefined;
    };
  };
  /** 교차 검토(일치·이견·조정) */
  submitPlanningReviews: {
    request: {
      params: {
        id: Id;
      };
      body: {
        jobId: Id;
        fence: number;
        reviews: ({
          topic: string;
          kind: "agree" | "diff" | "일치" | "이견";
          codex: string;
          claude: string;
          ops?: (PlanningProposalOp)[];
          codexOps?: (PlanningProposalOp)[];
          claudeOps?: (PlanningProposalOp)[];
          memo?: string;
        })[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      201: undefined;
    };
  };
  /** Change Proposal 제출(정책에 따라 자동 반영/보류/검토) */
  submitPlanningProposal: {
    request: {
      body: {
        jobId: Id;
        fence: number;
        splitJudgements?: {
          schemaVersion: 1;
          items: ({
            rule: "ac_meaning" | "layer_order" | "test_included";
            result: "met" | "not_met";
            agreedBy: (Agent)[];
            basis: string;
            judgedAt: Timestamp;
            sourceRef: string;
          })[];
        };
        taskJudgements?: ({
          taskKey: TaskKey;
          judgedRules: {
            schemaVersion: 1;
            items: ({
              rule: "revert" | "contract" | "refactor";
              result: "met" | "not_met";
              agreedBy: (Agent)[];
              basis: string;
              judgedAt: Timestamp;
              sourceRef: string;
            })[];
          };
        })[];
        title: string;
        reason: string;
        source: {
          kind: "planning" | "message" | "manual" | "input" | "decision";
          id?: Id;
        };
        ops: (PlanningProposalOp)[];
      } | {
        jobId: Id;
        fence: number;
        splitJudgements?: {
          schemaVersion: 1;
          items: ({
            rule: "ac_meaning" | "layer_order" | "test_included";
            result: "met" | "not_met";
            agreedBy: (Agent)[];
            basis: string;
            judgedAt: Timestamp;
            sourceRef: string;
          })[];
        };
        taskJudgements?: ({
          taskKey: TaskKey;
          judgedRules: {
            schemaVersion: 1;
            items: ({
              rule: "revert" | "contract" | "refactor";
              result: "met" | "not_met";
              agreedBy: (Agent)[];
              basis: string;
              judgedAt: Timestamp;
              sourceRef: string;
            })[];
          };
        })[];
        title: string;
        reason: string;
        source: {
          kind: "split";
          id: TaskKey;
        };
        ops: (PlanningSplitProposalOp)[];
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      201: {
        id: Id;
        cpKey: string;
        status: "draft" | "review" | "changes" | "approved" | "rejected" | "applied" | "held";
      };
    };
  };
  /** 저장된 CP(팀장 작성 포함)의 판단 기록. 작업 payload의 hash와 다르면 VERSION_CONFLICT */
  submitProposalJudgements: {
    request: {
      params: {
        id: Id;
      };
      body: {
        jobId: Id;
        fence: number;
        judgements: ({
          target: string;
          judgedRules: {
            schemaVersion: 1;
            items: ({
              rule: "revert" | "contract" | "refactor";
              result: "met" | "not_met";
              agreedBy: (Agent)[];
              basis: string;
              judgedAt: Timestamp;
              sourceRef: string;
              subjectHash: Sha256;
            })[];
          };
        })[];
        splitJudgements?: {
          schemaVersion: 1;
          items: ({
            rule: "ac_meaning" | "layer_order" | "test_included";
            result: "met" | "not_met";
            agreedBy: (Agent)[];
            basis: string;
            judgedAt: Timestamp;
            sourceRef: string;
            subjectHash: Sha256;
          })[];
        };
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
  /** 등급·하위 Agent·충돌 묶음·분할 판단과 근거. subjectHash 불일치는 VERSION_CONFLICT */
  submitTaskPlan: {
    request: {
      params: {
        taskKey: TaskKey;
      };
      body: {
        jobId: Id;
        fence: number;
        grades: {
          dev: {
            modelId: string;
            effort: string;
            reason: string;
          };
          qa: {
            modelId: string;
            effort: string;
            reason: string;
          };
        };
        subagents: {
          dev: (Id)[];
          qa: (Id)[];
          basis: string;
        };
        conflictGroup: {
          name: string;
          reason: string;
        } | null;
        judgedRules?: {
          schemaVersion: 1;
          items: ({
            rule: "revert" | "contract" | "refactor";
            result: "met" | "not_met";
            agreedBy: (Agent)[];
            basis: string;
            judgedAt: Timestamp;
            sourceRef: string;
            subjectHash: Sha256;
          })[];
        };
      };
      epoch: number;
      idempotencyKey: string;
    };
    responses: {
      204: undefined;
    };
  };
}

export const OPERATIONS = {
  createDecision: { method: 'POST', path: '/api/projects/{projectId}/design/decisions', content: 'json', statuses: { 201: true } },
  heartbeat: { method: 'POST', path: '/api/runner/heartbeat', content: 'json', statuses: { 204: false } },
  reportSession: { method: 'POST', path: '/api/runner/sessions', content: 'json', statuses: { 204: false } },
  reportHost: { method: 'POST', path: '/api/runner/host', content: 'json', statuses: { 200: true } },
  reportReadiness: { method: 'POST', path: '/api/runner/readiness', content: 'json', statuses: { 204: false } },
  reportModels: { method: 'POST', path: '/api/runner/models', content: 'json', statuses: { 200: true } },
  reportUsage: { method: 'POST', path: '/api/runner/usage', content: 'json', statuses: { 204: false } },
  reportConcurrency: { method: 'POST', path: '/api/runner/concurrency', content: 'json', statuses: { 200: true } },
  getRunGrade: { method: 'GET', path: '/api/runner/tasks/{taskKey}/run-grade', content: 'none', statuses: { 200: true } },
  getTaskSubagents: { method: 'GET', path: '/api/runner/tasks/{taskKey}/subagents', content: 'none', statuses: { 200: true } },
  pollMessages: { method: 'GET', path: '/api/runner/messages', content: 'none', statuses: { 200: true } },
  ackMessage: { method: 'POST', path: '/api/runner/messages/{messageId}/ack', content: 'none', statuses: { 204: false } },
  respondMessage: { method: 'POST', path: '/api/runner/messages/{messageId}/response', content: 'json', statuses: { 204: false } },
  reportAttemptStatus: { method: 'POST', path: '/api/runner/attempts/{attemptId}/status', content: 'json', statuses: { 204: false } },
  interruptAttempt: { method: 'POST', path: '/api/runner/attempts/{attemptId}/interrupt', content: 'json', statuses: { 200: true } },
  reportAttemptResult: { method: 'POST', path: '/api/runner/attempts/{attemptId}/result', content: 'json', statuses: { 201: false } },
  uploadEvidence: { method: 'POST', path: '/api/runner/attempts/{attemptId}/evidence', content: 'multipart', statuses: { 201: true } },
  reportSubagentUsage: { method: 'POST', path: '/api/runner/attempts/{attemptId}/subagent-usage', content: 'json', statuses: { 204: false } },
  reportInputChanges: { method: 'POST', path: '/api/runner/input-changes', content: 'json', statuses: { 200: true } },
  reportRepoCheck: { method: 'POST', path: '/api/runner/repo-checks/{id}/result', content: 'json', statuses: { 204: false } },
  reportBootstrapProgress: { method: 'POST', path: '/api/runner/bootstrap/{jobId}/progress', content: 'json', statuses: { 204: false } },
  getCiJob: { method: 'GET', path: '/api/runner/ci/jobs/{id}', content: 'none', statuses: { 200: true } },
  getDesignApplyJob: { method: 'GET', path: '/api/runner/design/jobs/{id}', content: 'none', statuses: { 200: true } },
  startCiRun: { method: 'POST', path: '/api/runner/ci/runs', content: 'json', statuses: { 201: true } },
  updateCiRun: { method: 'PATCH', path: '/api/runner/ci/runs/{id}', content: 'json', statuses: { 204: false } },
  reportMergeQueue: { method: 'POST', path: '/api/runner/ci/queue', content: 'json', statuses: { 204: false } },
  reportDesignSnapshot: { method: 'POST', path: '/api/runner/design/snapshot', content: 'json', statuses: { 204: false } },
  reportGithubStatus: { method: 'POST', path: '/api/runner/github/status', content: 'json', statuses: { 204: false } },
  registerGithubKey: { method: 'POST', path: '/api/runner/github/key', content: 'json', statuses: { 200: true } },
  getGithubCredential: { method: 'GET', path: '/api/runner/github/credential', content: 'none', statuses: { 200: true } },
  getRunnerPolicy: { method: 'GET', path: '/api/runner/policy', content: 'none', statuses: { 200: true, 304: false } },
  getExecutionHolds: { method: 'GET', path: '/api/runner/holds', content: 'none', statuses: { 200: true } },
  getCommands: { method: 'GET', path: '/api/runner/commands', content: 'none', statuses: { 200: true } },
  reportCommandResult: { method: 'POST', path: '/api/runner/commands/{id}/result', content: 'json', statuses: { 204: false } },
  claimJob: { method: 'POST', path: '/api/runner/jobs/claim', content: 'json', statuses: { 200: true, 204: false } },
  renewJob: { method: 'POST', path: '/api/runner/jobs/{id}/renew', content: 'json', statuses: { 200: true } },
  returnJob: { method: 'POST', path: '/api/runner/jobs/{id}/return', content: 'json', statuses: { 204: false } },
  startJob: { method: 'POST', path: '/api/runner/jobs/{id}/start', content: 'json', statuses: { 200: true } },
  reportJobProcess: { method: 'POST', path: '/api/runner/jobs/{id}/process', content: 'json', statuses: { 204: false } },
  releaseJobSlots: { method: 'POST', path: '/api/runner/jobs/{id}/slots/release', content: 'json', statuses: { 204: false } },
  acquireJobSlots: { method: 'POST', path: '/api/runner/jobs/{id}/slots/acquire', content: 'json', statuses: { 204: false } },
  releaseJob: { method: 'POST', path: '/api/runner/jobs/{id}/release', content: 'json', statuses: { 204: false } },
  reconcileJob: { method: 'POST', path: '/api/runner/jobs/{id}/reconcile', content: 'json', statuses: { 204: false } },
  finishJob: { method: 'POST', path: '/api/runner/jobs/{id}/finish', content: 'json', statuses: { 204: false } },
  submitEstimates: { method: 'POST', path: '/api/planning/estimates', content: 'json', statuses: { 200: true } },
  requestReplan: { method: 'POST', path: '/api/planning/replans', content: 'json', statuses: { 201: true, 202: true } },
  submitDraft: { method: 'POST', path: '/api/planning/bootstrap/{jobId}/draft', content: 'json', statuses: { 201: true } },
  submitTechProposals: { method: 'POST', path: '/api/planning/bootstrap/{jobId}/tech', content: 'json', statuses: { 201: false } },
  createPlanningSession: { method: 'POST', path: '/api/planning/sessions', content: 'json', statuses: { 201: true } },
  submitPlanningAnalysis: { method: 'POST', path: '/api/planning/sessions/{id}/analyses', content: 'json', statuses: { 201: false } },
  submitPlanningReviews: { method: 'POST', path: '/api/planning/sessions/{id}/reviews', content: 'json', statuses: { 201: false } },
  submitPlanningProposal: { method: 'POST', path: '/api/planning/proposals', content: 'json', statuses: { 201: true } },
  submitProposalJudgements: { method: 'POST', path: '/api/planning/proposals/{id}/judgements', content: 'json', statuses: { 204: false } },
  submitTaskPlan: { method: 'POST', path: '/api/planning/tasks/{taskKey}/plan', content: 'json', statuses: { 204: false } },
} as const satisfies Record<keyof Operations, unknown>;

export const DESIGN_SNAPSHOT_SCHEMA = {
  "type": "object",
  "required": [
    "jobId",
    "fence",
    "commit",
    "ref",
    "files",
    "items",
    "drifts"
  ],
  "properties": {
    "jobId": {
      "$ref": "#/components/schemas/Id"
    },
    "fence": {
      "type": "integer",
      "minimum": 0,
      "maximum": 2147483647
    },
    "commit": {
      "$ref": "#/components/schemas/Sha"
    },
    "ref": {
      "type": "string",
      "pattern": "^(?:main|agent/TASK-[0-9]{4,}(?:-h[0-9]+)?)$",
      "maxLength": 1024
    },
    "files": {
      "type": "array",
      "items": {
        "anyOf": [
          {
            "type": "object",
            "required": [
              "path",
              "kind",
              "format",
              "status"
            ],
            "properties": {
              "path": {
                "allOf": [
                  {
                    "$ref": "#/components/schemas/RepoPath"
                  },
                  {
                    "type": "string",
                    "pattern": "^contracts/",
                    "maxLength": 1024
                  }
                ]
              },
              "kind": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 128
              },
              "format": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 128
              },
              "raw": {
                "type": "string",
                "maxLength": 262144
              },
              "status": {
                "enum": [
                  "ok",
                  "draft"
                ]
              },
              "error": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 4096
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "path",
              "kind",
              "format",
              "status",
              "error"
            ],
            "properties": {
              "path": {
                "allOf": [
                  {
                    "$ref": "#/components/schemas/RepoPath"
                  },
                  {
                    "type": "string",
                    "pattern": "^contracts/",
                    "maxLength": 1024
                  }
                ]
              },
              "kind": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 128
              },
              "format": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 128
              },
              "raw": {
                "type": "string",
                "maxLength": 262144
              },
              "status": {
                "enum": [
                  "error"
                ]
              },
              "error": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 4096
              }
            },
            "additionalProperties": false
          }
        ]
      },
      "maxItems": 256
    },
    "items": {
      "type": "array",
      "items": {
        "anyOf": [
          {
            "type": "object",
            "required": [
              "itemKey",
              "kind",
              "path",
              "content"
            ],
            "properties": {
              "itemKey": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512,
                "pattern": "^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /\\S*$"
              },
              "kind": {
                "enum": [
                  "REST"
                ]
              },
              "path": {
                "allOf": [
                  {
                    "$ref": "#/components/schemas/RepoPath"
                  },
                  {
                    "type": "string",
                    "pattern": "^contracts/",
                    "maxLength": 1024
                  }
                ]
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 512
              },
              "taskKey": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "description": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 8192
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "content": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "required": [
                      "type",
                      "auth",
                      "request",
                      "response",
                      "validation",
                      "errors",
                      "tables"
                    ],
                    "properties": {
                      "type": {
                        "enum": [
                          "REST"
                        ]
                      },
                      "auth": {
                        "type": "string"
                      },
                      "request": {
                        "type": "string"
                      },
                      "response": {
                        "type": "string"
                      },
                      "validation": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "errors": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "code",
                            "http",
                            "cond"
                          ],
                          "properties": {
                            "code": {
                              "type": "string"
                            },
                            "http": {
                              "type": "string"
                            },
                            "cond": {
                              "type": "string"
                            }
                          }
                        }
                      },
                      "tables": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                ]
              },
              "contract": {
                "type": "object",
                "required": [
                  "fields"
                ],
                "properties": {
                  "fields": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "path",
                        "type",
                        "required"
                      ],
                      "properties": {
                        "path": {
                          "type": "string",
                          "pattern": "^/",
                          "maxLength": 4096
                        },
                        "type": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S",
                          "maxLength": 4096
                        },
                        "required": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": false
                    },
                    "maxItems": 5000
                  }
                },
                "additionalProperties": false
              },
              "extracted": {
                "anyOf": [
                  {
                    "type": "object",
                    "required": [
                      "fields"
                    ],
                    "properties": {
                      "fields": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "path",
                            "type",
                            "required"
                          ],
                          "properties": {
                            "path": {
                              "type": "string",
                              "pattern": "^/",
                              "maxLength": 4096
                            },
                            "type": {
                              "type": "string",
                              "minLength": 1,
                              "pattern": "\\S",
                              "maxLength": 4096
                            },
                            "required": {
                              "type": "boolean"
                            }
                          },
                          "additionalProperties": false
                        },
                        "maxItems": 5000
                      }
                    },
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "itemKey",
              "kind",
              "path",
              "content"
            ],
            "properties": {
              "itemKey": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512,
                "pattern": "\\S"
              },
              "kind": {
                "enum": [
                  "WebSocket"
                ]
              },
              "path": {
                "allOf": [
                  {
                    "$ref": "#/components/schemas/RepoPath"
                  },
                  {
                    "type": "string",
                    "pattern": "^contracts/",
                    "maxLength": 1024
                  }
                ]
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 512
              },
              "taskKey": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "description": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 8192
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "content": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "required": [
                      "type",
                      "auth",
                      "messages",
                      "rules",
                      "topic"
                    ],
                    "properties": {
                      "type": {
                        "enum": [
                          "message"
                        ]
                      },
                      "auth": {
                        "type": "string"
                      },
                      "messages": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "name",
                            "direction",
                            "schema"
                          ],
                          "properties": {
                            "name": {
                              "type": "string"
                            },
                            "direction": {
                              "type": "string"
                            },
                            "schema": {
                              "type": "string"
                            }
                          }
                        }
                      },
                      "rules": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "decisionKeys": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "pattern": "^TD-[0-9]{2,}$"
                        },
                        "maxItems": 256
                      },
                      "topic": {
                        "anyOf": [
                          {
                            "type": "object",
                            "required": [
                              "key",
                              "partitions",
                              "retention",
                              "delivery",
                              "dlq",
                              "compat",
                              "consumers"
                            ],
                            "properties": {
                              "key": {
                                "type": "string"
                              },
                              "partitions": {
                                "type": "string"
                              },
                              "retention": {
                                "type": "string"
                              },
                              "delivery": {
                                "type": "string"
                              },
                              "dlq": {
                                "type": "string"
                              },
                              "compat": {
                                "type": "string"
                              },
                              "consumers": {
                                "type": "array",
                                "items": {
                                  "type": "string"
                                }
                              }
                            }
                          },
                          {
                            "type": "null"
                          }
                        ]
                      }
                    }
                  }
                ]
              },
              "contract": {
                "type": "object",
                "required": [
                  "fields"
                ],
                "properties": {
                  "fields": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "path",
                        "type",
                        "required"
                      ],
                      "properties": {
                        "path": {
                          "type": "string",
                          "pattern": "^/",
                          "maxLength": 4096
                        },
                        "type": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S",
                          "maxLength": 4096
                        },
                        "required": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": false
                    },
                    "maxItems": 5000
                  }
                },
                "additionalProperties": false
              },
              "extracted": {
                "anyOf": [
                  {
                    "type": "object",
                    "required": [
                      "fields"
                    ],
                    "properties": {
                      "fields": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "path",
                            "type",
                            "required"
                          ],
                          "properties": {
                            "path": {
                              "type": "string",
                              "pattern": "^/",
                              "maxLength": 4096
                            },
                            "type": {
                              "type": "string",
                              "minLength": 1,
                              "pattern": "\\S",
                              "maxLength": 4096
                            },
                            "required": {
                              "type": "boolean"
                            }
                          },
                          "additionalProperties": false
                        },
                        "maxItems": 5000
                      }
                    },
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "itemKey",
              "kind",
              "path",
              "content"
            ],
            "properties": {
              "itemKey": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512,
                "pattern": "\\S"
              },
              "kind": {
                "enum": [
                  "SSE"
                ]
              },
              "path": {
                "allOf": [
                  {
                    "$ref": "#/components/schemas/RepoPath"
                  },
                  {
                    "type": "string",
                    "pattern": "^contracts/",
                    "maxLength": 1024
                  }
                ]
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 512
              },
              "taskKey": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "description": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 8192
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "content": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "required": [
                      "type",
                      "auth",
                      "messages",
                      "rules",
                      "topic"
                    ],
                    "properties": {
                      "type": {
                        "enum": [
                          "message"
                        ]
                      },
                      "auth": {
                        "type": "string"
                      },
                      "messages": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "name",
                            "direction",
                            "schema"
                          ],
                          "properties": {
                            "name": {
                              "type": "string"
                            },
                            "direction": {
                              "type": "string"
                            },
                            "schema": {
                              "type": "string"
                            }
                          }
                        }
                      },
                      "rules": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "decisionKeys": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "pattern": "^TD-[0-9]{2,}$"
                        },
                        "maxItems": 256
                      },
                      "topic": {
                        "anyOf": [
                          {
                            "type": "object",
                            "required": [
                              "key",
                              "partitions",
                              "retention",
                              "delivery",
                              "dlq",
                              "compat",
                              "consumers"
                            ],
                            "properties": {
                              "key": {
                                "type": "string"
                              },
                              "partitions": {
                                "type": "string"
                              },
                              "retention": {
                                "type": "string"
                              },
                              "delivery": {
                                "type": "string"
                              },
                              "dlq": {
                                "type": "string"
                              },
                              "compat": {
                                "type": "string"
                              },
                              "consumers": {
                                "type": "array",
                                "items": {
                                  "type": "string"
                                }
                              }
                            }
                          },
                          {
                            "type": "null"
                          }
                        ]
                      }
                    }
                  }
                ]
              },
              "contract": {
                "type": "object",
                "required": [
                  "fields"
                ],
                "properties": {
                  "fields": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "path",
                        "type",
                        "required"
                      ],
                      "properties": {
                        "path": {
                          "type": "string",
                          "pattern": "^/",
                          "maxLength": 4096
                        },
                        "type": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S",
                          "maxLength": 4096
                        },
                        "required": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": false
                    },
                    "maxItems": 5000
                  }
                },
                "additionalProperties": false
              },
              "extracted": {
                "anyOf": [
                  {
                    "type": "object",
                    "required": [
                      "fields"
                    ],
                    "properties": {
                      "fields": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "path",
                            "type",
                            "required"
                          ],
                          "properties": {
                            "path": {
                              "type": "string",
                              "pattern": "^/",
                              "maxLength": 4096
                            },
                            "type": {
                              "type": "string",
                              "minLength": 1,
                              "pattern": "\\S",
                              "maxLength": 4096
                            },
                            "required": {
                              "type": "boolean"
                            }
                          },
                          "additionalProperties": false
                        },
                        "maxItems": 5000
                      }
                    },
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "itemKey",
              "kind",
              "path",
              "content"
            ],
            "properties": {
              "itemKey": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512,
                "pattern": "\\S"
              },
              "kind": {
                "enum": [
                  "Kafka"
                ]
              },
              "path": {
                "allOf": [
                  {
                    "$ref": "#/components/schemas/RepoPath"
                  },
                  {
                    "type": "string",
                    "pattern": "^contracts/",
                    "maxLength": 1024
                  }
                ]
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 512
              },
              "taskKey": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "description": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 8192
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "content": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "required": [
                      "type",
                      "auth",
                      "messages",
                      "rules",
                      "topic"
                    ],
                    "properties": {
                      "type": {
                        "enum": [
                          "message"
                        ]
                      },
                      "auth": {
                        "type": "string"
                      },
                      "messages": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "name",
                            "direction",
                            "schema"
                          ],
                          "properties": {
                            "name": {
                              "type": "string"
                            },
                            "direction": {
                              "type": "string"
                            },
                            "schema": {
                              "type": "string"
                            }
                          }
                        }
                      },
                      "rules": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "decisionKeys": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "pattern": "^TD-[0-9]{2,}$"
                        },
                        "maxItems": 256
                      },
                      "topic": {
                        "anyOf": [
                          {
                            "type": "object",
                            "required": [
                              "key",
                              "partitions",
                              "retention",
                              "delivery",
                              "dlq",
                              "compat",
                              "consumers"
                            ],
                            "properties": {
                              "key": {
                                "type": "string"
                              },
                              "partitions": {
                                "type": "string"
                              },
                              "retention": {
                                "type": "string"
                              },
                              "delivery": {
                                "type": "string"
                              },
                              "dlq": {
                                "type": "string"
                              },
                              "compat": {
                                "type": "string"
                              },
                              "consumers": {
                                "type": "array",
                                "items": {
                                  "type": "string"
                                }
                              }
                            }
                          },
                          {
                            "type": "null"
                          }
                        ]
                      }
                    }
                  }
                ]
              },
              "contract": {
                "type": "object",
                "required": [
                  "fields"
                ],
                "properties": {
                  "fields": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "path",
                        "type",
                        "required"
                      ],
                      "properties": {
                        "path": {
                          "type": "string",
                          "pattern": "^/",
                          "maxLength": 4096
                        },
                        "type": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S",
                          "maxLength": 4096
                        },
                        "required": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": false
                    },
                    "maxItems": 5000
                  }
                },
                "additionalProperties": false
              },
              "extracted": {
                "anyOf": [
                  {
                    "type": "object",
                    "required": [
                      "fields"
                    ],
                    "properties": {
                      "fields": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "path",
                            "type",
                            "required"
                          ],
                          "properties": {
                            "path": {
                              "type": "string",
                              "pattern": "^/",
                              "maxLength": 4096
                            },
                            "type": {
                              "type": "string",
                              "minLength": 1,
                              "pattern": "\\S",
                              "maxLength": 4096
                            },
                            "required": {
                              "type": "boolean"
                            }
                          },
                          "additionalProperties": false
                        },
                        "maxItems": 5000
                      }
                    },
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "itemKey",
              "kind",
              "path",
              "content"
            ],
            "properties": {
              "itemKey": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512,
                "pattern": "^postgres:\\S.*$"
              },
              "kind": {
                "enum": [
                  "postgres"
                ]
              },
              "path": {
                "allOf": [
                  {
                    "$ref": "#/components/schemas/RepoPath"
                  },
                  {
                    "type": "string",
                    "pattern": "^contracts/",
                    "maxLength": 1024
                  }
                ]
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 512
              },
              "taskKey": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "description": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 8192
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "content": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "required": [
                      "type",
                      "columns",
                      "constraints",
                      "indexes",
                      "usedBy"
                    ],
                    "properties": {
                      "type": {
                        "enum": [
                          "postgres"
                        ]
                      },
                      "columns": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "name",
                            "type",
                            "nullable",
                            "pk",
                            "unique",
                            "fk",
                            "default",
                            "desc"
                          ],
                          "properties": {
                            "name": {
                              "type": "string"
                            },
                            "type": {
                              "type": "string"
                            },
                            "nullable": {
                              "type": "boolean"
                            },
                            "pk": {
                              "type": "boolean"
                            },
                            "unique": {
                              "type": "boolean"
                            },
                            "fk": {
                              "anyOf": [
                                {
                                  "type": "string"
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            },
                            "default": {
                              "anyOf": [
                                {
                                  "type": "string"
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            },
                            "desc": {
                              "type": "string"
                            }
                          }
                        }
                      },
                      "constraints": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "indexes": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "name",
                            "columns",
                            "kind"
                          ],
                          "properties": {
                            "name": {
                              "type": "string"
                            },
                            "columns": {
                              "type": "string"
                            },
                            "kind": {
                              "type": "string"
                            }
                          }
                        }
                      },
                      "usedBy": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                ]
              },
              "contract": {
                "type": "object",
                "required": [
                  "fields"
                ],
                "properties": {
                  "fields": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "path",
                        "type",
                        "required"
                      ],
                      "properties": {
                        "path": {
                          "type": "string",
                          "pattern": "^/",
                          "maxLength": 4096
                        },
                        "type": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S",
                          "maxLength": 4096
                        },
                        "required": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": false
                    },
                    "maxItems": 5000
                  }
                },
                "additionalProperties": false
              },
              "extracted": {
                "anyOf": [
                  {
                    "type": "object",
                    "required": [
                      "fields"
                    ],
                    "properties": {
                      "fields": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "path",
                            "type",
                            "required"
                          ],
                          "properties": {
                            "path": {
                              "type": "string",
                              "pattern": "^/",
                              "maxLength": 4096
                            },
                            "type": {
                              "type": "string",
                              "minLength": 1,
                              "pattern": "\\S",
                              "maxLength": 4096
                            },
                            "required": {
                              "type": "boolean"
                            }
                          },
                          "additionalProperties": false
                        },
                        "maxItems": 5000
                      }
                    },
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "itemKey",
              "kind",
              "path",
              "content"
            ],
            "properties": {
              "itemKey": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512,
                "pattern": "^neo4j:\\S.*$"
              },
              "kind": {
                "enum": [
                  "neo4j"
                ]
              },
              "path": {
                "allOf": [
                  {
                    "$ref": "#/components/schemas/RepoPath"
                  },
                  {
                    "type": "string",
                    "pattern": "^contracts/",
                    "maxLength": 1024
                  }
                ]
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 512
              },
              "taskKey": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "description": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 8192
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "content": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "required": [
                      "type",
                      "props",
                      "note",
                      "constraints"
                    ],
                    "properties": {
                      "type": {
                        "enum": [
                          "neo4j-label"
                        ]
                      },
                      "props": {
                        "type": "string"
                      },
                      "note": {
                        "type": "string"
                      },
                      "constraints": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  },
                  {
                    "type": "object",
                    "required": [
                      "type",
                      "from",
                      "to",
                      "props"
                    ],
                    "properties": {
                      "type": {
                        "enum": [
                          "neo4j-relation"
                        ]
                      },
                      "from": {
                        "type": "string"
                      },
                      "to": {
                        "type": "string"
                      },
                      "props": {
                        "type": "string"
                      }
                    }
                  }
                ]
              },
              "contract": {
                "type": "object",
                "required": [
                  "fields"
                ],
                "properties": {
                  "fields": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "path",
                        "type",
                        "required"
                      ],
                      "properties": {
                        "path": {
                          "type": "string",
                          "pattern": "^/",
                          "maxLength": 4096
                        },
                        "type": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S",
                          "maxLength": 4096
                        },
                        "required": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": false
                    },
                    "maxItems": 5000
                  }
                },
                "additionalProperties": false
              },
              "extracted": {
                "anyOf": [
                  {
                    "type": "object",
                    "required": [
                      "fields"
                    ],
                    "properties": {
                      "fields": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "path",
                            "type",
                            "required"
                          ],
                          "properties": {
                            "path": {
                              "type": "string",
                              "pattern": "^/",
                              "maxLength": 4096
                            },
                            "type": {
                              "type": "string",
                              "minLength": 1,
                              "pattern": "\\S",
                              "maxLength": 4096
                            },
                            "required": {
                              "type": "boolean"
                            }
                          },
                          "additionalProperties": false
                        },
                        "maxItems": 5000
                      }
                    },
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "itemKey",
              "kind",
              "path",
              "content"
            ],
            "properties": {
              "itemKey": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512,
                "pattern": "^questdb:\\S.*$"
              },
              "kind": {
                "enum": [
                  "questdb"
                ]
              },
              "path": {
                "allOf": [
                  {
                    "$ref": "#/components/schemas/RepoPath"
                  },
                  {
                    "type": "string",
                    "pattern": "^contracts/",
                    "maxLength": 1024
                  }
                ]
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 512
              },
              "taskKey": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "description": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 8192
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "content": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "required": [
                      "type",
                      "timestamp",
                      "partition",
                      "retention",
                      "dedup",
                      "symbols",
                      "columns",
                      "ingest",
                      "aggregation"
                    ],
                    "properties": {
                      "type": {
                        "enum": [
                          "questdb"
                        ]
                      },
                      "timestamp": {
                        "type": "string"
                      },
                      "partition": {
                        "type": "string"
                      },
                      "retention": {
                        "type": "string"
                      },
                      "dedup": {
                        "type": "string"
                      },
                      "symbols": {
                        "type": "string"
                      },
                      "columns": {
                        "type": "string"
                      },
                      "ingest": {
                        "type": "string"
                      },
                      "aggregation": {
                        "type": "string"
                      }
                    }
                  }
                ]
              },
              "contract": {
                "type": "object",
                "required": [
                  "fields"
                ],
                "properties": {
                  "fields": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "path",
                        "type",
                        "required"
                      ],
                      "properties": {
                        "path": {
                          "type": "string",
                          "pattern": "^/",
                          "maxLength": 4096
                        },
                        "type": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S",
                          "maxLength": 4096
                        },
                        "required": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": false
                    },
                    "maxItems": 5000
                  }
                },
                "additionalProperties": false
              },
              "extracted": {
                "anyOf": [
                  {
                    "type": "object",
                    "required": [
                      "fields"
                    ],
                    "properties": {
                      "fields": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "path",
                            "type",
                            "required"
                          ],
                          "properties": {
                            "path": {
                              "type": "string",
                              "pattern": "^/",
                              "maxLength": 4096
                            },
                            "type": {
                              "type": "string",
                              "minLength": 1,
                              "pattern": "\\S",
                              "maxLength": 4096
                            },
                            "required": {
                              "type": "boolean"
                            }
                          },
                          "additionalProperties": false
                        },
                        "maxItems": 5000
                      }
                    },
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "itemKey",
              "kind",
              "path",
              "content"
            ],
            "properties": {
              "itemKey": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512,
                "pattern": "^redis:\\S.*$"
              },
              "kind": {
                "enum": [
                  "redis"
                ]
              },
              "path": {
                "allOf": [
                  {
                    "$ref": "#/components/schemas/RepoPath"
                  },
                  {
                    "type": "string",
                    "pattern": "^contracts/",
                    "maxLength": 1024
                  }
                ]
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S",
                "maxLength": 512
              },
              "taskKey": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "description": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 8192
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "content": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "required": [
                      "type",
                      "use",
                      "value",
                      "ttl",
                      "invalidation",
                      "persistence"
                    ],
                    "properties": {
                      "type": {
                        "enum": [
                          "redis"
                        ]
                      },
                      "use": {
                        "type": "string"
                      },
                      "value": {
                        "type": "string"
                      },
                      "ttl": {
                        "type": "string"
                      },
                      "invalidation": {
                        "type": "string"
                      },
                      "persistence": {
                        "type": "string"
                      }
                    }
                  }
                ]
              },
              "contract": {
                "type": "object",
                "required": [
                  "fields"
                ],
                "properties": {
                  "fields": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "path",
                        "type",
                        "required"
                      ],
                      "properties": {
                        "path": {
                          "type": "string",
                          "pattern": "^/",
                          "maxLength": 4096
                        },
                        "type": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S",
                          "maxLength": 4096
                        },
                        "required": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": false
                    },
                    "maxItems": 5000
                  }
                },
                "additionalProperties": false
              },
              "extracted": {
                "anyOf": [
                  {
                    "type": "object",
                    "required": [
                      "fields"
                    ],
                    "properties": {
                      "fields": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "path",
                            "type",
                            "required"
                          ],
                          "properties": {
                            "path": {
                              "type": "string",
                              "pattern": "^/",
                              "maxLength": 4096
                            },
                            "type": {
                              "type": "string",
                              "minLength": 1,
                              "pattern": "\\S",
                              "maxLength": 4096
                            },
                            "required": {
                              "type": "boolean"
                            }
                          },
                          "additionalProperties": false
                        },
                        "maxItems": 5000
                      }
                    },
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false
          }
        ]
      },
      "maxItems": 1000
    },
    "drifts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "itemKey",
          "kind",
          "where",
          "text",
          "compat"
        ],
        "properties": {
          "itemKey": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S",
            "maxLength": 512
          },
          "kind": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S",
            "maxLength": 128
          },
          "where": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S",
            "maxLength": 4096
          },
          "text": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S",
            "maxLength": 4096
          },
          "taskKey": {
            "$ref": "#/components/schemas/TaskKey"
          },
          "compat": {
            "enum": [
              "compatible",
              "breaking",
              "unchecked"
            ]
          }
        },
        "additionalProperties": false
      },
      "maxItems": 1000
    },
    "edges": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "from",
          "to",
          "kind"
        ],
        "properties": {
          "from": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S",
            "maxLength": 512
          },
          "to": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S",
            "maxLength": 512
          },
          "kind": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S",
            "maxLength": 128
          }
        },
        "additionalProperties": false
      },
      "maxItems": 5000
    },
    "ownership": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "data",
          "source",
          "copy",
          "sync",
          "lag"
        ],
        "properties": {
          "data": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S",
            "maxLength": 512
          },
          "source": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S",
            "maxLength": 512
          },
          "copy": {
            "type": "string",
            "maxLength": 4096
          },
          "sync": {
            "type": "string",
            "maxLength": 4096
          },
          "lag": {
            "type": "string",
            "maxLength": 4096
          }
        },
        "additionalProperties": false
      },
      "maxItems": 1000
    },
    "components": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "id",
          "layer",
          "name",
          "tech",
          "note",
          "decisionId"
        ],
        "properties": {
          "id": {
            "$ref": "#/components/schemas/Id"
          },
          "layer": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "tech": {
            "type": "string"
          },
          "note": {
            "type": "string"
          },
          "decisionId": {
            "anyOf": [
              {
                "$ref": "#/components/schemas/Id"
              },
              {
                "type": "null"
              }
            ]
          }
        }
      },
      "maxItems": 256
    },
    "links": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "from",
          "to",
          "via",
          "contractPath"
        ],
        "properties": {
          "from": {
            "$ref": "#/components/schemas/Id"
          },
          "to": {
            "$ref": "#/components/schemas/Id"
          },
          "via": {
            "type": "string"
          },
          "contractPath": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        }
      },
      "maxItems": 5000
    }
  },
  "additionalProperties": false,
  "description": "전체 본문은 UTF-8 JSON 1048576바이트 이하이다. ref는 필수다. main은 design_apply·merge_followup만 보고한다. attempt는 payload.branch와 같은 ref만 보고한다. 같은 commit은 unchecked→checked만 허용한다. VERSION_CONFLICT의 details.conflicts는 충돌 항목만 [{itemKey,serverState:\"checked\"|\"unchecked\",serverContentHash,commit,ref}]로 보낸다. serverContentHash는 {itemKey,kind,path,name,description,taskKey,content,contract,extracted}를 RFC 8785 JCS로 직렬화한 UTF-8의 SHA-256, 소문자 64자리다. 없는 name·description·taskKey·contract·extracted는 null이다. DB sourceCommit은 제외한다. 정규화는 충돌 비교와 해시에 공통 적용한다. 의미 없는 배열은 키로 먼저 정렬한다: fields(path), files(path), items(itemKey), edges(from,to,kind), ownership(data,source,copy,sync,lag), components(id), links(from,to,via,contractPath). 키 튜플은 UTF-16 순서로 비교하고 동률이면 원소의 JCS 문자열로 비교한다. content.decisionKeys·content.tables·content.usedBy는 문자열을 UTF-16 순서로 정렬한다. 나머지 배열의 순서는 보존한다. 보고의 drifts 참고값은 충돌 비교에서 제외한다. 서버에 항목이 없으면 null의 JCS를 해시하고 unchecked로 표시한다. 고정 벡터는 contracts/fixtures/design-snapshot.json에 있다.",
  "components": {
    "schemas": {
      "Id": {
        "type": "string",
        "title": "Id",
        "minLength": 1,
        "maxLength": 128
      },
      "Sha": {
        "type": "string",
        "title": "Sha",
        "pattern": "^[0-9a-f]{40}([0-9a-f]{24})?$"
      },
      "RepoPath": {
        "type": "string",
        "title": "RepoPath",
        "minLength": 1,
        "pattern": "^(?!/)(?![A-Za-z]:)(?!(?:.*/)?\\.\\.?(?:/|$))(?!.*//)[^\\\\\\u0000-\\u001f]+$"
      },
      "TaskKey": {
        "type": "string",
        "title": "TaskKey",
        "pattern": "^TASK-[0-9]{4,}$"
      }
    }
  }
} as const;

export const PLANNING_REPORT_SCHEMAS = {
  "submitEstimates": {
    "type": "object",
    "required": [
      "jobId",
      "fence",
      "items"
    ],
    "properties": {
      "jobId": {
        "$ref": "#/components/schemas/Id"
      },
      "fence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "taskKey",
            "estHours",
            "loHours",
            "hiHours",
            "confidence",
            "basis",
            "agreedBy"
          ],
          "properties": {
            "taskKey": {
              "$ref": "#/components/schemas/TaskKey"
            },
            "estHours": {
              "type": "number",
              "minimum": 0
            },
            "loHours": {
              "type": "number",
              "minimum": 0
            },
            "hiHours": {
              "type": "number",
              "minimum": 0
            },
            "tokensK": {
              "type": "number",
              "minimum": 0
            },
            "confidence": {
              "$ref": "#/components/schemas/Confidence"
            },
            "basis": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "agreedBy": {
              "type": "array",
              "items": {
                "$ref": "#/components/schemas/Agent"
              },
              "minItems": 1,
              "uniqueItems": true
            }
          },
          "additionalProperties": false
        },
        "minItems": 1
      }
    },
    "additionalProperties": false
  },
  "submitDraft": {
    "type": "object",
    "required": [
      "fence",
      "phases",
      "wps",
      "tasks",
      "deps"
    ],
    "properties": {
      "fence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      },
      "phases": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "ref",
            "title"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            }
          },
          "additionalProperties": false
        },
        "minItems": 1
      },
      "wps": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "ref",
            "phaseRef",
            "title"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "phaseRef": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            }
          },
          "additionalProperties": false
        },
        "minItems": 1
      },
      "tasks": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "ref",
            "wpRef",
            "title",
            "workType",
            "primaryDomain",
            "relatedDomains",
            "priority",
            "assigneeAgent",
            "verifierAgent",
            "estimate",
            "outputs",
            "checklist",
            "grades",
            "subagents",
            "splitBasis",
            "conflictGroup",
            "designItems"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "wpRef": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "workType": {
              "$ref": "#/components/schemas/WorkType"
            },
            "primaryDomain": {
              "$ref": "#/components/schemas/Domain"
            },
            "relatedDomains": {
              "type": "array",
              "items": {
                "$ref": "#/components/schemas/Domain"
              }
            },
            "priority": {
              "type": "integer",
              "minimum": 0,
              "maximum": 3
            },
            "assigneeAgent": {
              "$ref": "#/components/schemas/Agent"
            },
            "verifierAgent": {
              "$ref": "#/components/schemas/Agent"
            },
            "estimate": {
              "type": "object",
              "required": [
                "estHours",
                "loHours",
                "hiHours",
                "confidence",
                "basis",
                "agreedBy"
              ],
              "properties": {
                "estHours": {
                  "type": "number",
                  "minimum": 0
                },
                "loHours": {
                  "type": "number",
                  "minimum": 0
                },
                "hiHours": {
                  "type": "number",
                  "minimum": 0
                },
                "tokensK": {
                  "type": "number",
                  "minimum": 0
                },
                "confidence": {
                  "$ref": "#/components/schemas/Confidence"
                },
                "basis": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "agreedBy": {
                  "type": "array",
                  "items": {
                    "$ref": "#/components/schemas/Agent"
                  },
                  "minItems": 1,
                  "uniqueItems": true
                }
              },
              "additionalProperties": false
            },
            "overview": {
              "type": "object",
              "required": [
                "purpose",
                "background",
                "scope",
                "out",
                "precond",
                "doneCond"
              ],
              "properties": {
                "purpose": {
                  "type": "string"
                },
                "background": {
                  "type": "string"
                },
                "scope": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "out": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "precond": {
                  "type": "string"
                },
                "doneCond": {
                  "type": "string"
                }
              },
              "additionalProperties": false
            },
            "spec": {
              "type": "object",
              "required": [
                "req",
                "work",
                "steps",
                "inputs",
                "outputs",
                "files",
                "constraints",
                "errors",
                "docs",
                "verify"
              ],
              "properties": {
                "req": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "work": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "steps": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "inputs": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "outputs": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "files": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "constraints": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "errors": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "docs": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "verify": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              },
              "additionalProperties": false
            },
            "ac": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "given",
                  "when",
                  "then",
                  "method"
                ],
                "properties": {
                  "given": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S"
                  },
                  "when": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S"
                  },
                  "then": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S"
                  },
                  "method": {
                    "type": "string"
                  }
                },
                "additionalProperties": false
              }
            },
            "outputs": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "name",
                  "kind",
                  "required",
                  "verify",
                  "delivered"
                ],
                "properties": {
                  "name": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S"
                  },
                  "kind": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S"
                  },
                  "required": {
                    "type": "boolean"
                  },
                  "verify": {
                    "type": "string"
                  },
                  "delivered": {
                    "type": "boolean"
                  }
                },
                "additionalProperties": false
              }
            },
            "checklist": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "content",
                  "required"
                ],
                "properties": {
                  "content": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S"
                  },
                  "required": {
                    "type": "boolean"
                  },
                  "verifyMethod": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "additionalProperties": false
              }
            },
            "grades": {
              "type": "object",
              "required": [
                "dev",
                "qa"
              ],
              "properties": {
                "dev": {
                  "type": "object",
                  "required": [
                    "modelId",
                    "effort",
                    "reason"
                  ],
                  "properties": {
                    "modelId": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    },
                    "effort": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    },
                    "reason": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    }
                  },
                  "additionalProperties": false
                },
                "qa": {
                  "type": "object",
                  "required": [
                    "modelId",
                    "effort",
                    "reason"
                  ],
                  "properties": {
                    "modelId": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    },
                    "effort": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    },
                    "reason": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    }
                  },
                  "additionalProperties": false
                }
              },
              "additionalProperties": false
            },
            "subagents": {
              "type": "object",
              "required": [
                "dev",
                "qa",
                "basis"
              ],
              "properties": {
                "dev": {
                  "type": "array",
                  "items": {
                    "$ref": "#/components/schemas/Id"
                  }
                },
                "qa": {
                  "type": "array",
                  "items": {
                    "$ref": "#/components/schemas/Id"
                  }
                },
                "basis": {
                  "type": "string"
                }
              },
              "additionalProperties": false
            },
            "splitBasis": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "judgedRules": {
              "type": "object",
              "required": [
                "schemaVersion",
                "items"
              ],
              "properties": {
                "schemaVersion": {
                  "type": "number",
                  "const": 1
                },
                "items": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": [
                      "rule",
                      "result",
                      "agreedBy",
                      "basis",
                      "judgedAt",
                      "sourceRef"
                    ],
                    "properties": {
                      "rule": {
                        "enum": [
                          "revert",
                          "contract",
                          "refactor"
                        ]
                      },
                      "result": {
                        "enum": [
                          "met",
                          "not_met"
                        ]
                      },
                      "agreedBy": {
                        "type": "array",
                        "items": {
                          "$ref": "#/components/schemas/Agent"
                        },
                        "minItems": 2,
                        "uniqueItems": true
                      },
                      "basis": {
                        "type": "string",
                        "minLength": 1,
                        "pattern": "\\S"
                      },
                      "judgedAt": {
                        "$ref": "#/components/schemas/Timestamp"
                      },
                      "sourceRef": {
                        "type": "string",
                        "pattern": "^sha256:[0-9a-f]{64}$",
                        "description": "판단 입력 지문: sha256:<64 lowercase hex>. 일반 규칙은 JudgedContent를 RFC 8785 JCS로 직렬화한 UTF-8의 SHA-256이다. 분할 전체 판단은 기존 splitSubjectHash(판단을 뺀 ops + splitTasks의 JCS SHA-256)다. 서버 계산과 다르면 VERSION_CONFLICT이며 판단을 저장하지 않는다."
                      }
                    },
                    "additionalProperties": false
                  },
                  "maxItems": 3
                }
              },
              "additionalProperties": false
            },
            "conflictGroup": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                {
                  "type": "null"
                }
              ]
            },
            "designItems": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "itemKey",
                  "change"
                ],
                "properties": {
                  "itemKey": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S"
                  },
                  "change": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S"
                  }
                },
                "additionalProperties": false
              }
            }
          },
          "additionalProperties": false
        },
        "minItems": 1
      },
      "deps": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "predRef",
            "succRef",
            "depType"
          ],
          "properties": {
            "predRef": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "succRef": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "depType": {
              "$ref": "#/components/schemas/DepType"
            }
          },
          "additionalProperties": false
        }
      }
    },
    "additionalProperties": false
  },
  "submitTechProposals": {
    "type": "object",
    "required": [
      "fence",
      "decisions"
    ],
    "properties": {
      "fence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      },
      "decisions": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "area",
            "title",
            "choice",
            "reason",
            "alternatives"
          ],
          "properties": {
            "area": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "choice": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "reason": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "alternatives": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      },
      "conditionJudgements": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "constraintId",
            "result",
            "reason"
          ],
          "properties": {
            "constraintId": {
              "$ref": "#/components/schemas/Id"
            },
            "result": {
              "enum": [
                "met",
                "not_met"
              ]
            },
            "reason": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            }
          },
          "additionalProperties": false
        }
      }
    },
    "additionalProperties": false
  },
  "submitPlanningAnalysis": {
    "type": "object",
    "required": [
      "jobId",
      "fence",
      "agent",
      "summary",
      "items"
    ],
    "properties": {
      "jobId": {
        "$ref": "#/components/schemas/Id"
      },
      "fence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      },
      "agent": {
        "$ref": "#/components/schemas/Agent"
      },
      "summary": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      },
      "items": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "pattern": "\\S"
        }
      }
    },
    "additionalProperties": false
  },
  "submitPlanningReviews": {
    "type": "object",
    "required": [
      "jobId",
      "fence",
      "reviews"
    ],
    "properties": {
      "jobId": {
        "$ref": "#/components/schemas/Id"
      },
      "fence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      },
      "reviews": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "topic",
            "kind",
            "codex",
            "claude"
          ],
          "properties": {
            "topic": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "kind": {
              "enum": [
                "agree",
                "diff",
                "일치",
                "이견"
              ]
            },
            "codex": {
              "type": "string"
            },
            "claude": {
              "type": "string"
            },
            "ops": {
              "type": "array",
              "items": {
                "$ref": "#/components/schemas/PlanningProposalOp"
              }
            },
            "codexOps": {
              "type": "array",
              "items": {
                "$ref": "#/components/schemas/PlanningProposalOp"
              }
            },
            "claudeOps": {
              "type": "array",
              "items": {
                "$ref": "#/components/schemas/PlanningProposalOp"
              }
            },
            "memo": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "minItems": 1
      }
    },
    "additionalProperties": false
  },
  "submitPlanningProposal": {
    "anyOf": [
      {
        "type": "object",
        "required": [
          "jobId",
          "fence",
          "title",
          "reason",
          "source",
          "ops"
        ],
        "properties": {
          "jobId": {
            "$ref": "#/components/schemas/Id"
          },
          "fence": {
            "type": "integer",
            "minimum": 0,
            "maximum": 2147483647
          },
          "splitJudgements": {
            "type": "object",
            "required": [
              "schemaVersion",
              "items"
            ],
            "properties": {
              "schemaVersion": {
                "type": "number",
                "const": 1
              },
              "items": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "rule",
                    "result",
                    "agreedBy",
                    "basis",
                    "judgedAt",
                    "sourceRef"
                  ],
                  "properties": {
                    "rule": {
                      "enum": [
                        "ac_meaning",
                        "layer_order",
                        "test_included"
                      ]
                    },
                    "result": {
                      "enum": [
                        "met",
                        "not_met"
                      ]
                    },
                    "agreedBy": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/Agent"
                      },
                      "minItems": 2,
                      "uniqueItems": true
                    },
                    "basis": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    },
                    "judgedAt": {
                      "$ref": "#/components/schemas/Timestamp"
                    },
                    "sourceRef": {
                      "type": "string",
                      "pattern": "^sha256:[0-9a-f]{64}$",
                      "description": "판단 입력 지문: sha256:<64 lowercase hex>. 일반 규칙은 JudgedContent를 RFC 8785 JCS로 직렬화한 UTF-8의 SHA-256이다. 분할 전체 판단은 기존 splitSubjectHash(판단을 뺀 ops + splitTasks의 JCS SHA-256)다. 서버 계산과 다르면 VERSION_CONFLICT이며 판단을 저장하지 않는다."
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 3
              }
            },
            "additionalProperties": false
          },
          "taskJudgements": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "taskKey",
                "judgedRules"
              ],
              "properties": {
                "taskKey": {
                  "$ref": "#/components/schemas/TaskKey"
                },
                "judgedRules": {
                  "type": "object",
                  "required": [
                    "schemaVersion",
                    "items"
                  ],
                  "properties": {
                    "schemaVersion": {
                      "type": "number",
                      "const": 1
                    },
                    "items": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "rule",
                          "result",
                          "agreedBy",
                          "basis",
                          "judgedAt",
                          "sourceRef"
                        ],
                        "properties": {
                          "rule": {
                            "enum": [
                              "revert",
                              "contract",
                              "refactor"
                            ]
                          },
                          "result": {
                            "enum": [
                              "met",
                              "not_met"
                            ]
                          },
                          "agreedBy": {
                            "type": "array",
                            "items": {
                              "$ref": "#/components/schemas/Agent"
                            },
                            "minItems": 2,
                            "uniqueItems": true
                          },
                          "basis": {
                            "type": "string",
                            "minLength": 1,
                            "pattern": "\\S"
                          },
                          "judgedAt": {
                            "$ref": "#/components/schemas/Timestamp"
                          },
                          "sourceRef": {
                            "type": "string",
                            "pattern": "^sha256:[0-9a-f]{64}$",
                            "description": "판단 입력 지문: sha256:<64 lowercase hex>. 일반 규칙은 JudgedContent를 RFC 8785 JCS로 직렬화한 UTF-8의 SHA-256이다. 분할 전체 판단은 기존 splitSubjectHash(판단을 뺀 ops + splitTasks의 JCS SHA-256)다. 서버 계산과 다르면 VERSION_CONFLICT이며 판단을 저장하지 않는다."
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 3
                    }
                  },
                  "additionalProperties": false
                }
              },
              "additionalProperties": false
            }
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          "source": {
            "type": "object",
            "required": [
              "kind"
            ],
            "properties": {
              "kind": {
                "enum": [
                  "planning",
                  "message",
                  "manual",
                  "input",
                  "decision"
                ]
              },
              "id": {
                "$ref": "#/components/schemas/Id"
              }
            },
            "additionalProperties": false
          },
          "ops": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/PlanningProposalOp"
            },
            "minItems": 1
          }
        },
        "additionalProperties": false
      },
      {
        "type": "object",
        "required": [
          "jobId",
          "fence",
          "title",
          "reason",
          "source",
          "ops"
        ],
        "properties": {
          "jobId": {
            "$ref": "#/components/schemas/Id"
          },
          "fence": {
            "type": "integer",
            "minimum": 0,
            "maximum": 2147483647
          },
          "splitJudgements": {
            "type": "object",
            "required": [
              "schemaVersion",
              "items"
            ],
            "properties": {
              "schemaVersion": {
                "type": "number",
                "const": 1
              },
              "items": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "rule",
                    "result",
                    "agreedBy",
                    "basis",
                    "judgedAt",
                    "sourceRef"
                  ],
                  "properties": {
                    "rule": {
                      "enum": [
                        "ac_meaning",
                        "layer_order",
                        "test_included"
                      ]
                    },
                    "result": {
                      "enum": [
                        "met",
                        "not_met"
                      ]
                    },
                    "agreedBy": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/Agent"
                      },
                      "minItems": 2,
                      "uniqueItems": true
                    },
                    "basis": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    },
                    "judgedAt": {
                      "$ref": "#/components/schemas/Timestamp"
                    },
                    "sourceRef": {
                      "type": "string",
                      "pattern": "^sha256:[0-9a-f]{64}$",
                      "description": "판단 입력 지문: sha256:<64 lowercase hex>. 일반 규칙은 JudgedContent를 RFC 8785 JCS로 직렬화한 UTF-8의 SHA-256이다. 분할 전체 판단은 기존 splitSubjectHash(판단을 뺀 ops + splitTasks의 JCS SHA-256)다. 서버 계산과 다르면 VERSION_CONFLICT이며 판단을 저장하지 않는다."
                    }
                  },
                  "additionalProperties": false
                },
                "maxItems": 3
              }
            },
            "additionalProperties": false
          },
          "taskJudgements": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "taskKey",
                "judgedRules"
              ],
              "properties": {
                "taskKey": {
                  "$ref": "#/components/schemas/TaskKey"
                },
                "judgedRules": {
                  "type": "object",
                  "required": [
                    "schemaVersion",
                    "items"
                  ],
                  "properties": {
                    "schemaVersion": {
                      "type": "number",
                      "const": 1
                    },
                    "items": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "rule",
                          "result",
                          "agreedBy",
                          "basis",
                          "judgedAt",
                          "sourceRef"
                        ],
                        "properties": {
                          "rule": {
                            "enum": [
                              "revert",
                              "contract",
                              "refactor"
                            ]
                          },
                          "result": {
                            "enum": [
                              "met",
                              "not_met"
                            ]
                          },
                          "agreedBy": {
                            "type": "array",
                            "items": {
                              "$ref": "#/components/schemas/Agent"
                            },
                            "minItems": 2,
                            "uniqueItems": true
                          },
                          "basis": {
                            "type": "string",
                            "minLength": 1,
                            "pattern": "\\S"
                          },
                          "judgedAt": {
                            "$ref": "#/components/schemas/Timestamp"
                          },
                          "sourceRef": {
                            "type": "string",
                            "pattern": "^sha256:[0-9a-f]{64}$",
                            "description": "판단 입력 지문: sha256:<64 lowercase hex>. 일반 규칙은 JudgedContent를 RFC 8785 JCS로 직렬화한 UTF-8의 SHA-256이다. 분할 전체 판단은 기존 splitSubjectHash(판단을 뺀 ops + splitTasks의 JCS SHA-256)다. 서버 계산과 다르면 VERSION_CONFLICT이며 판단을 저장하지 않는다."
                          }
                        },
                        "additionalProperties": false
                      },
                      "maxItems": 3
                    }
                  },
                  "additionalProperties": false
                }
              },
              "additionalProperties": false
            }
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          "source": {
            "type": "object",
            "required": [
              "kind",
              "id"
            ],
            "properties": {
              "kind": {
                "enum": [
                  "split"
                ]
              },
              "id": {
                "$ref": "#/components/schemas/TaskKey"
              }
            },
            "additionalProperties": false
          },
          "ops": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/PlanningSplitProposalOp"
            },
            "minItems": 1
          }
        },
        "additionalProperties": false
      }
    ]
  },
  "submitTaskPlan": {
    "type": "object",
    "required": [
      "jobId",
      "fence",
      "grades",
      "subagents",
      "conflictGroup"
    ],
    "properties": {
      "jobId": {
        "$ref": "#/components/schemas/Id"
      },
      "fence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      },
      "grades": {
        "type": "object",
        "required": [
          "dev",
          "qa"
        ],
        "properties": {
          "dev": {
            "type": "object",
            "required": [
              "modelId",
              "effort",
              "reason"
            ],
            "properties": {
              "modelId": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              },
              "effort": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              }
            },
            "additionalProperties": false
          },
          "qa": {
            "type": "object",
            "required": [
              "modelId",
              "effort",
              "reason"
            ],
            "properties": {
              "modelId": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              },
              "effort": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              }
            },
            "additionalProperties": false
          }
        },
        "additionalProperties": false
      },
      "subagents": {
        "type": "object",
        "required": [
          "dev",
          "qa",
          "basis"
        ],
        "properties": {
          "dev": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/Id"
            }
          },
          "qa": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/Id"
            }
          },
          "basis": {
            "type": "string"
          }
        },
        "additionalProperties": false
      },
      "conflictGroup": {
        "anyOf": [
          {
            "type": "object",
            "required": [
              "name",
              "reason"
            ],
            "properties": {
              "name": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "null"
          }
        ]
      },
      "judgedRules": {
        "type": "object",
        "required": [
          "schemaVersion",
          "items"
        ],
        "properties": {
          "schemaVersion": {
            "type": "number",
            "const": 1
          },
          "items": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "rule",
                "result",
                "agreedBy",
                "basis",
                "judgedAt",
                "sourceRef",
                "subjectHash"
              ],
              "properties": {
                "rule": {
                  "enum": [
                    "revert",
                    "contract",
                    "refactor"
                  ]
                },
                "result": {
                  "enum": [
                    "met",
                    "not_met"
                  ]
                },
                "agreedBy": {
                  "type": "array",
                  "items": {
                    "$ref": "#/components/schemas/Agent"
                  },
                  "minItems": 2,
                  "uniqueItems": true
                },
                "basis": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "judgedAt": {
                  "$ref": "#/components/schemas/Timestamp"
                },
                "sourceRef": {
                  "type": "string",
                  "pattern": "^sha256:[0-9a-f]{64}$",
                  "description": "판단 입력 지문: sha256:<64 lowercase hex>. 일반 규칙은 JudgedContent를 RFC 8785 JCS로 직렬화한 UTF-8의 SHA-256이다. 분할 전체 판단은 기존 splitSubjectHash(판단을 뺀 ops + splitTasks의 JCS SHA-256)다. 서버 계산과 다르면 VERSION_CONFLICT이며 판단을 저장하지 않는다."
                },
                "subjectHash": {
                  "$ref": "#/components/schemas/Sha256"
                }
              },
              "additionalProperties": false
            },
            "maxItems": 3
          }
        },
        "additionalProperties": false
      }
    },
    "additionalProperties": false
  },
  "components": {
    "schemas": {
      "Id": {
        "type": "string",
        "title": "Id",
        "minLength": 1,
        "maxLength": 128
      },
      "TaskKey": {
        "type": "string",
        "title": "TaskKey",
        "pattern": "^TASK-[0-9]{4,}$"
      },
      "Confidence": {
        "enum": [
          "상",
          "중",
          "하"
        ],
        "title": "Confidence"
      },
      "Agent": {
        "enum": [
          "Claude",
          "Codex"
        ],
        "title": "Agent"
      },
      "WorkType": {
        "enum": [
          "Analysis",
          "Design",
          "Implementation",
          "Configuration",
          "Test",
          "Verification",
          "Documentation",
          "Integration"
        ],
        "title": "WorkType"
      },
      "Domain": {
        "enum": [
          "FE",
          "BE",
          "DB",
          "DevOps",
          "API",
          "QA",
          "Architecture",
          "Common"
        ],
        "title": "Domain"
      },
      "Timestamp": {
        "type": "string",
        "title": "Timestamp",
        "pattern": "^(?:(?:19[7-9][0-9]|[2-9][0-9]{3})-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?=19[7-9]|[2-9])(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,6})?Z$"
      },
      "DepType": {
        "enum": [
          "FS",
          "SS"
        ],
        "title": "DepType"
      },
      "PlanningProposalOp": {
        "anyOf": [
          {
            "type": "object",
            "required": [
              "op",
              "ref",
              "t",
              "preds"
            ],
            "properties": {
              "op": {
                "enum": [
                  "add"
                ]
              },
              "ref": {
                "type": "string",
                "pattern": "^NEW-[0-9]+$"
              },
              "t": {
                "type": "object",
                "required": [
                  "title",
                  "type",
                  "domain",
                  "wp",
                  "priority",
                  "assignee",
                  "verifier",
                  "purpose",
                  "doneCond"
                ],
                "properties": {
                  "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "type": {
                    "$ref": "#/components/schemas/WorkType"
                  },
                  "domain": {
                    "$ref": "#/components/schemas/Domain"
                  },
                  "rel": {
                    "type": "array",
                    "items": {
                      "$ref": "#/components/schemas/Domain"
                    }
                  },
                  "wp": {
                    "$ref": "#/components/schemas/Id"
                  },
                  "priority": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 3
                  },
                  "assignee": {
                    "$ref": "#/components/schemas/Agent"
                  },
                  "verifier": {
                    "$ref": "#/components/schemas/Agent"
                  },
                  "purpose": {
                    "type": "string"
                  },
                  "doneCond": {
                    "type": "string"
                  },
                  "est": {
                    "type": "number",
                    "minimum": 0
                  },
                  "lo": {
                    "type": "number",
                    "minimum": 0
                  },
                  "hi": {
                    "type": "number",
                    "minimum": 0
                  },
                  "tok": {
                    "type": "number",
                    "minimum": 0
                  },
                  "conf": {
                    "$ref": "#/components/schemas/Confidence"
                  },
                  "basis": {
                    "type": "string"
                  },
                  "ac": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "given",
                        "when",
                        "then"
                      ],
                      "properties": {
                        "given": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S"
                        },
                        "when": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S"
                        },
                        "then": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S"
                        },
                        "method": {
                          "type": "string"
                        }
                      },
                      "additionalProperties": false
                    }
                  },
                  "srcV": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 2147483647
                  },
                  "splitBasis": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S"
                  },
                  "scope": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "files": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "design": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "kind",
                        "content"
                      ],
                      "properties": {
                        "kind": {
                          "$ref": "#/components/schemas/DesignKind"
                        },
                        "content": {
                          "type": "object",
                          "patternProperties": {
                            "^.*$": {}
                          }
                        }
                      },
                      "additionalProperties": false
                    },
                    "maxItems": 4
                  },
                  "conflictGroup": {
                    "anyOf": [
                      {
                        "type": "string",
                        "minLength": 1,
                        "pattern": "\\S"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "judgedRules": {
                    "type": "object",
                    "required": [
                      "schemaVersion",
                      "items"
                    ],
                    "properties": {
                      "schemaVersion": {
                        "type": "number",
                        "const": 1
                      },
                      "items": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "rule",
                            "result",
                            "agreedBy",
                            "basis",
                            "judgedAt",
                            "sourceRef"
                          ],
                          "properties": {
                            "rule": {
                              "enum": [
                                "revert",
                                "contract",
                                "refactor"
                              ]
                            },
                            "result": {
                              "enum": [
                                "met",
                                "not_met"
                              ]
                            },
                            "agreedBy": {
                              "type": "array",
                              "items": {
                                "$ref": "#/components/schemas/Agent"
                              },
                              "minItems": 2,
                              "uniqueItems": true
                            },
                            "basis": {
                              "type": "string",
                              "minLength": 1,
                              "pattern": "\\S"
                            },
                            "judgedAt": {
                              "$ref": "#/components/schemas/Timestamp"
                            },
                            "sourceRef": {
                              "type": "string",
                              "pattern": "^sha256:[0-9a-f]{64}$",
                              "description": "판단 입력 지문: sha256:<64 lowercase hex>. 일반 규칙은 JudgedContent를 RFC 8785 JCS로 직렬화한 UTF-8의 SHA-256이다. 분할 전체 판단은 기존 splitSubjectHash(판단을 뺀 ops + splitTasks의 JCS SHA-256)다. 서버 계산과 다르면 VERSION_CONFLICT이며 판단을 저장하지 않는다."
                            }
                          },
                          "additionalProperties": false
                        },
                        "maxItems": 3
                      }
                    },
                    "additionalProperties": false
                  }
                },
                "additionalProperties": false
              },
              "preds": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "pred",
                    "type"
                  ],
                  "properties": {
                    "pred": {
                      "$ref": "#/components/schemas/Id"
                    },
                    "type": {
                      "$ref": "#/components/schemas/DepType"
                    }
                  },
                  "additionalProperties": false
                }
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "title"
                ]
              },
              "before": {},
              "after": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "doneCond"
                ]
              },
              "before": {},
              "after": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "scopeAdd"
                ]
              },
              "before": {},
              "after": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "acAdd"
                ]
              },
              "before": {},
              "after": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "priority"
                ]
              },
              "before": {},
              "after": {
                "type": "integer",
                "minimum": 0,
                "maximum": 3
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "assignee"
                ]
              },
              "before": {},
              "after": {
                "$ref": "#/components/schemas/Agent"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "verifier"
                ]
              },
              "before": {},
              "after": {
                "$ref": "#/components/schemas/Agent"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task"
            ],
            "properties": {
              "op": {
                "enum": [
                  "remove"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "pred",
              "succ",
              "type"
            ],
            "properties": {
              "op": {
                "enum": [
                  "dep-add"
                ]
              },
              "pred": {
                "$ref": "#/components/schemas/Id"
              },
              "succ": {
                "$ref": "#/components/schemas/Id"
              },
              "type": {
                "$ref": "#/components/schemas/DepType"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "pred",
              "succ"
            ],
            "properties": {
              "op": {
                "enum": [
                  "dep-remove"
                ]
              },
              "pred": {
                "$ref": "#/components/schemas/Id"
              },
              "succ": {
                "$ref": "#/components/schemas/Id"
              }
            },
            "additionalProperties": false
          }
        ],
        "title": "PlanningProposalOp"
      },
      "DesignKind": {
        "enum": [
          "DB",
          "API",
          "FE",
          "DevOps"
        ],
        "title": "DesignKind"
      },
      "PlanningSplitProposalOp": {
        "anyOf": [
          {
            "type": "object",
            "required": [
              "op",
              "ref",
              "t",
              "preds"
            ],
            "properties": {
              "op": {
                "enum": [
                  "add"
                ]
              },
              "ref": {
                "type": "string",
                "pattern": "^NEW-[0-9]+$"
              },
              "t": {
                "type": "object",
                "required": [
                  "title",
                  "type",
                  "domain",
                  "wp",
                  "priority",
                  "assignee",
                  "verifier",
                  "purpose",
                  "doneCond",
                  "splitBasis"
                ],
                "properties": {
                  "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "type": {
                    "$ref": "#/components/schemas/WorkType"
                  },
                  "domain": {
                    "$ref": "#/components/schemas/Domain"
                  },
                  "rel": {
                    "type": "array",
                    "items": {
                      "$ref": "#/components/schemas/Domain"
                    }
                  },
                  "wp": {
                    "$ref": "#/components/schemas/Id"
                  },
                  "priority": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 3
                  },
                  "assignee": {
                    "$ref": "#/components/schemas/Agent"
                  },
                  "verifier": {
                    "$ref": "#/components/schemas/Agent"
                  },
                  "purpose": {
                    "type": "string"
                  },
                  "doneCond": {
                    "type": "string"
                  },
                  "est": {
                    "type": "number",
                    "minimum": 0
                  },
                  "lo": {
                    "type": "number",
                    "minimum": 0
                  },
                  "hi": {
                    "type": "number",
                    "minimum": 0
                  },
                  "tok": {
                    "type": "number",
                    "minimum": 0
                  },
                  "conf": {
                    "$ref": "#/components/schemas/Confidence"
                  },
                  "basis": {
                    "type": "string"
                  },
                  "ac": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "given",
                        "when",
                        "then"
                      ],
                      "properties": {
                        "given": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S"
                        },
                        "when": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S"
                        },
                        "then": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "\\S"
                        },
                        "method": {
                          "type": "string"
                        }
                      },
                      "additionalProperties": false
                    }
                  },
                  "srcV": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 2147483647
                  },
                  "splitBasis": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S"
                  },
                  "scope": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "files": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "design": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "kind",
                        "content"
                      ],
                      "properties": {
                        "kind": {
                          "$ref": "#/components/schemas/DesignKind"
                        },
                        "content": {
                          "type": "object",
                          "patternProperties": {
                            "^.*$": {}
                          }
                        }
                      },
                      "additionalProperties": false
                    },
                    "maxItems": 4
                  },
                  "conflictGroup": {
                    "anyOf": [
                      {
                        "type": "string",
                        "minLength": 1,
                        "pattern": "\\S"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "judgedRules": {
                    "type": "object",
                    "required": [
                      "schemaVersion",
                      "items"
                    ],
                    "properties": {
                      "schemaVersion": {
                        "type": "number",
                        "const": 1
                      },
                      "items": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "rule",
                            "result",
                            "agreedBy",
                            "basis",
                            "judgedAt",
                            "sourceRef"
                          ],
                          "properties": {
                            "rule": {
                              "enum": [
                                "revert",
                                "contract",
                                "refactor"
                              ]
                            },
                            "result": {
                              "enum": [
                                "met",
                                "not_met"
                              ]
                            },
                            "agreedBy": {
                              "type": "array",
                              "items": {
                                "$ref": "#/components/schemas/Agent"
                              },
                              "minItems": 2,
                              "uniqueItems": true
                            },
                            "basis": {
                              "type": "string",
                              "minLength": 1,
                              "pattern": "\\S"
                            },
                            "judgedAt": {
                              "$ref": "#/components/schemas/Timestamp"
                            },
                            "sourceRef": {
                              "type": "string",
                              "pattern": "^sha256:[0-9a-f]{64}$",
                              "description": "판단 입력 지문: sha256:<64 lowercase hex>. 일반 규칙은 JudgedContent를 RFC 8785 JCS로 직렬화한 UTF-8의 SHA-256이다. 분할 전체 판단은 기존 splitSubjectHash(판단을 뺀 ops + splitTasks의 JCS SHA-256)다. 서버 계산과 다르면 VERSION_CONFLICT이며 판단을 저장하지 않는다."
                            }
                          },
                          "additionalProperties": false
                        },
                        "maxItems": 3
                      }
                    },
                    "additionalProperties": false
                  }
                },
                "additionalProperties": false
              },
              "preds": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "pred",
                    "type"
                  ],
                  "properties": {
                    "pred": {
                      "$ref": "#/components/schemas/Id"
                    },
                    "type": {
                      "$ref": "#/components/schemas/DepType"
                    }
                  },
                  "additionalProperties": false
                }
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "title"
                ]
              },
              "before": {},
              "after": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "doneCond"
                ]
              },
              "before": {},
              "after": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "scopeAdd"
                ]
              },
              "before": {},
              "after": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "acAdd"
                ]
              },
              "before": {},
              "after": {
                "type": "string",
                "minLength": 1,
                "pattern": "\\S"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "priority"
                ]
              },
              "before": {},
              "after": {
                "type": "integer",
                "minimum": 0,
                "maximum": 3
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "assignee"
                ]
              },
              "before": {},
              "after": {
                "$ref": "#/components/schemas/Agent"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task",
              "field",
              "after"
            ],
            "properties": {
              "op": {
                "enum": [
                  "modify"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              },
              "field": {
                "enum": [
                  "verifier"
                ]
              },
              "before": {},
              "after": {
                "$ref": "#/components/schemas/Agent"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "task"
            ],
            "properties": {
              "op": {
                "enum": [
                  "remove"
                ]
              },
              "task": {
                "$ref": "#/components/schemas/TaskKey"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "pred",
              "succ",
              "type"
            ],
            "properties": {
              "op": {
                "enum": [
                  "dep-add"
                ]
              },
              "pred": {
                "$ref": "#/components/schemas/Id"
              },
              "succ": {
                "$ref": "#/components/schemas/Id"
              },
              "type": {
                "$ref": "#/components/schemas/DepType"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "required": [
              "op",
              "pred",
              "succ"
            ],
            "properties": {
              "op": {
                "enum": [
                  "dep-remove"
                ]
              },
              "pred": {
                "$ref": "#/components/schemas/Id"
              },
              "succ": {
                "$ref": "#/components/schemas/Id"
              }
            },
            "additionalProperties": false
          }
        ],
        "title": "PlanningSplitProposalOp"
      },
      "Sha256": {
        "type": "string",
        "title": "Sha256",
        "pattern": "^[0-9a-f]{64}$"
      }
    }
  }
} as const;
