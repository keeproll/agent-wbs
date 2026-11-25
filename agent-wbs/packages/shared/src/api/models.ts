import Type from 'typebox';
import * as c from './common.ts';

const { AnyOf, Nullable, Opt, List, Text } = c;

/* ---- Change Proposal 변경(P `ops`, G§5.6). 저장·시뮬레이션이 P의 키를 그대로 쓴다. ---- */
const ProposedTask = c.Body({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  type: c.WorkType,
  domain: c.Domain,
  rel: Opt(List(c.Domain)),
  wp: c.Id,
  priority: c.Priority,
  assignee: c.Agent,
  verifier: c.Agent,
  purpose: Type.String(),
  doneCond: Type.String(),
  est: Opt(c.Hours),
  lo: Opt(c.Hours),
  hi: Opt(c.Hours),
  tok: Opt(Type.Number({ minimum: 0 })),
  conf: Opt(c.Confidence),
  basis: Opt(Type.String()),
  ac: Opt(List(c.Body({ given: Text, when: Text, then: Text, method: Opt(Type.String()) }))),
  srcV: Opt(c.Count),
});
const ModifyOp = (field: string, after: Parameters<typeof Opt>[0]) =>
  c.Body({ op: AnyOf('modify'), task: c.TaskKey, field: AnyOf(field), before: Opt(Type.Unknown()), after });
export const ProposalOp = Type.Union(
  [
    c.Body({
      op: AnyOf('add'),
      ref: Type.String({ pattern: '^NEW-[0-9]+$' }),
      t: ProposedTask,
      preds: List(c.Body({ pred: c.Id, type: c.DepType })),
    }),
    ...['title', 'doneCond', 'scopeAdd', 'acAdd'].map((field) => ModifyOp(field, Text)),
    ModifyOp('priority', c.Priority),
    ...['assignee', 'verifier'].map((field) => ModifyOp(field, c.Agent)),
    c.Body({ op: AnyOf('remove'), task: c.TaskKey }),
    c.Body({ op: AnyOf('dep-add'), pred: c.Id, succ: c.Id, type: c.DepType }),
    c.Body({ op: AnyOf('dep-remove'), pred: c.Id, succ: c.Id }),
  ],
  { title: 'ProposalOp' },
);

/* ---- Task ---- */
export const WbsNode = Type.Object(
  {
    id: c.Id,
    kind: AnyOf('phase', 'work_package'),
    parentId: Nullable(c.Id),
    title: Type.String(),
    wbsPath: Type.String(),
    sortOrder: Type.Integer(),
  },
  { title: 'WbsNode' },
);
const taskSummary = {
  id: c.Id,
  taskKey: c.TaskKey,
  wbsNodeId: c.Id,
  wbsPath: Type.String(),
  title: Type.String(),
  workType: c.WorkType,
  primaryDomain: c.Domain,
  relatedDomains: List(c.Domain),
  priority: c.Priority,
  assigneeAgent: Nullable(c.Agent),
  verifierAgent: Nullable(c.Agent),
  lifecycleStatus: c.TaskStatus,
  verifState: c.VerifState,
  blocked: Type.Boolean(),
  preds: List(c.TaskKey),
  checklist: Type.Object({ done: c.Count, total: c.Count }),
  gate: Type.Object({ passed: c.Count, total: c.Count }),
  schedule: Nullable(
    Type.Object({
      estHours: c.Hours,
      loHours: c.Hours,
      hiHours: c.Hours,
      progressPct: c.Pct,
      end: Nullable(c.Timestamp),
      baselineEnd: Nullable(c.Timestamp),
    }),
  ),
  updatedAt: c.Timestamp,
  deletedAt: Nullable(c.Timestamp),
};
export const TaskSummary = Type.Object(taskSummary, { title: 'TaskSummary' });
export const Dependency = Type.Object(
  { id: c.Id, pred: c.TaskKey, succ: c.TaskKey, type: c.DepType },
  { title: 'Dependency' },
);

const lines = List(Type.String());
/** data-model §2.3 task_specs, P SPEC_GROUPS */
const specOverview = {
  purpose: Type.String(),
  background: Type.String(),
  scope: lines,
  out: lines,
  precond: Type.String(),
  doneCond: Type.String(),
};
const specBody = {
  req: lines, work: lines, steps: lines, inputs: lines, outputs: lines, files: lines,
  constraints: lines, errors: lines, docs: lines, verify: lines,
};
const ac = { given: Text, when: Text, then: Text, method: Type.String() };
const output = {
  name: Text,
  kind: Text,
  required: Type.Boolean(),
  verify: Type.String(),
  delivered: Type.Boolean(),
};
const checklist = {
  content: Text,
  required: Type.Boolean(),
  done: Type.Boolean(),
  verifyMethod: Nullable(Type.String()),
  evidence: Nullable(Type.String()),
  note: Nullable(Type.String()),
};
export const ChecklistItem = Type.Object({ itemKey: c.Id, ...checklist }, { title: 'ChecklistItem' });
export const SpecInput = {
  overview: Opt(c.Body(specOverview)),
  spec: Opt(c.Body(specBody)),
  ac: Opt(List(c.Body(ac))),
};
export const ChecklistInput = {
  content: checklist.content,
  required: checklist.required,
  verifyMethod: Opt(checklist.verifyMethod),
};
export const ChecklistPatch = {
  content: Opt(checklist.content),
  required: Opt(checklist.required),
  done: Opt(checklist.done),
  verifyMethod: Opt(checklist.verifyMethod),
  evidence: Opt(checklist.evidence),
  note: Opt(checklist.note),
};
export const OutputInput = c.Body(output);

export const Grade = Type.Object(
  { modelId: Type.String(), effort: Type.String(), reason: Type.String(), locked: Type.Boolean() },
  { title: 'Grade' },
);
export const TaskDetail = Type.Object(
  {
    ...taskSummary,
    spec: Type.Object({
      overview: Type.Object(specOverview),
      spec: Type.Object(specBody),
      ac: List(Type.Object(ac)),
    }),
    outputs: List(Type.Object(output)),
    designs: List(Type.Object({ kind: c.DesignKind, content: c.Json })),
    checklistItems: List(ChecklistItem),
    predecessors: List(Dependency),
    successors: List(Dependency),
    planningApprovedAt: Nullable(c.Timestamp),
    conflictGroup: Nullable(Type.String()),
    srcInputVersion: Nullable(c.Count),
    grades: Type.Object({ dev: Nullable(Grade), qa: Nullable(Grade) }),
    subagents: Type.Object({ dev: List(c.Id), qa: List(c.Id) }),
    split: Nullable(
      Type.Object({
        basis: Type.String(),
        exceptions: List(
          Type.Object({ rule: Type.String(), why: Type.String(), by: Type.String(), at: c.Timestamp }),
        ),
      }),
    ),
  },
  { title: 'TaskDetail' },
);
export const FieldChange = Type.Object({ field: Type.String(), before: Type.Unknown(), after: Type.Unknown() });
export const TaskChanged = Type.Object({ task: TaskDetail, changes: List(FieldChange) }, { title: 'TaskChanged' });

/* ---- 실행 · 검증 ---- */
export const GradeAdjust = c.Body({ kind: AnyOf('up', 'down', 'keep'), reason: Text });
export const Attempt = Type.Object(
  {
    id: c.Id,
    attemptKey: Type.String(),
    taskKey: c.TaskKey,
    kind: c.AttemptKind,
    agent: c.Agent,
    status: AnyOf('running', 'completed', 'failed', 'interrupted'),
    startedAt: c.Timestamp,
    endedAt: Nullable(c.Timestamp),
    modelId: Nullable(Type.String()),
    effort: Nullable(Type.String()),
    gradeAdjust: Nullable(GradeAdjust),
    summary: Nullable(Type.String()),
    failure: Nullable(Type.String()),
    tokens: Nullable(c.Count),
    resumedFrom: Nullable(c.Id),
    baseSha: Nullable(c.Sha),
    headSha: Nullable(c.Sha),
    changedFiles: List(Type.String()),
    updatedAt: c.Timestamp,
  },
  { title: 'Attempt' },
);
export const Defect = Type.Object(
  { defKey: Type.String(), text: Type.String(), blocking: Type.Boolean(), resolved: Type.Boolean() },
  { title: 'Defect' },
);
export const Evidence = Type.Object(
  {
    id: c.Id,
    taskKey: c.TaskKey,
    attemptId: Nullable(c.Id),
    verificationId: Nullable(c.Id),
    checklistItemKey: Nullable(c.Id),
    kind: Type.String(),
    sha256: c.Sha256,
    size: c.Count,
  },
  { title: 'Evidence' },
);
export const Verification = Type.Object(
  {
    id: c.Id,
    taskKey: c.TaskKey,
    attemptId: c.Id,
    result: c.PassFail,
    headSha: c.Sha,
    specRevision: c.Count,
    cmd: Type.String(),
    expected: Type.String(),
    actual: Type.String(),
    defects: List(Defect),
    invalidated: Type.Boolean(),
    at: c.Timestamp,
  },
  { title: 'Verification' },
);
/** G§5.5 5조건 */
export const Gate = Type.Object(
  {
    taskKey: c.TaskKey,
    passed: Type.Boolean(),
    conditions: List(
      Type.Object({
        key: AnyOf('checklist', 'outputs', 'verification', 'defects', 'approval'),
        result: c.PassFail,
        reason: Type.String(),
      }),
    ),
  },
  { title: 'Gate' },
);
export const HistoryEntry = Type.Object(
  {
    id: c.Id,
    at: c.Timestamp,
    actor: Type.String(),
    taskKey: Nullable(c.TaskKey),
    kind: Type.String(),
    text: Type.String(),
    before: Nullable(Type.String()),
    after: Nullable(Type.String()),
    ref: Nullable(Type.String()),
  },
  { title: 'HistoryEntry' },
);

/* ---- 메시지 ---- */
export const MessageType = AnyOf('추가 지시', '수정 요청', '질문', '일반 의견');
export const Message = Type.Object(
  {
    id: c.Id,
    msgKey: Type.String(),
    taskKey: c.TaskKey,
    attemptId: Nullable(c.Id),
    dir: AnyOf('out', 'in'),
    /** 들어온 응답은 P의 「응답」 */
    type: AnyOf('추가 지시', '수정 요청', '질문', '일반 의견', '응답'),
    toAgent: Nullable(c.Agent),
    body: Type.String(),
    delivery: Nullable(AnyOf('Draft', 'Queued', 'Sent', 'Acknowledged', 'Failed', 'Cancelled')),
    pendingNext: Type.Boolean(),
    workState: Nullable(Type.String()),
    failReason: Nullable(Type.String()),
    readAt: Nullable(c.Timestamp),
    createdAt: c.Timestamp,
    updatedAt: c.Timestamp,
  },
  { title: 'Message' },
);

/* ---- Planning · CP ---- */
export const ProposalStatus = AnyOf(
  'draft', 'review', 'changes', 'approved', 'rejected', 'applied', 'held',
);
export const ProposalSource = AnyOf('planning', 'message', 'manual', 'split', 'input', 'decision');
export const Proposal = Type.Object(
  {
    id: c.Id,
    cpKey: Type.String(),
    title: Type.String(),
    reason: Type.String(),
    source: Type.Object({ kind: ProposalSource, id: Nullable(Type.String()) }),
    status: ProposalStatus,
    ops: List(ProposalOp),
    idMap: Type.Record(Type.String(), c.TaskKey),
    holdReasons: List(Type.String()),
    events: List(
      Type.Object({ at: c.Timestamp, actor: Type.String(), action: Type.String(), comment: Type.String() }),
    ),
    createdAt: c.Timestamp,
    updatedAt: c.Timestamp,
  },
  { title: 'Proposal' },
);
/** P plannings[].review[].choice 값은 원본에 전체 목록이 없어 문자열로 받는다. */
export const PlanningReview = Type.Object(
  {
    id: c.Id,
    topic: Type.String(),
    kind: Type.String(),
    codex: Type.String(),
    claude: Type.String(),
    choice: Nullable(Type.String()),
    memo: Type.String(),
    ops: List(ProposalOp),
    codexOps: List(ProposalOp),
    claudeOps: List(ProposalOp),
    updatedAt: c.Timestamp,
  },
  { title: 'PlanningReview' },
);
export const PlanningAnalysis = Type.Object(
  { agent: c.Agent, summary: Type.String(), items: lines, at: c.Timestamp },
  { title: 'PlanningAnalysis' },
);
export const Planning = Type.Object(
  {
    id: c.Id,
    title: Type.String(),
    scope: Type.String(),
    analyses: List(PlanningAnalysis),
    reviews: List(PlanningReview),
    proposalId: Nullable(c.Id),
    createdAt: c.Timestamp,
    updatedAt: c.Timestamp,
  },
  { title: 'Planning' },
);

/** P TASK-0012 replans 응답. 자동 반영 정책이 꺼져 있으면(202) 기준 버전이 없다(D-10). */
export const ReplanSummary = Type.Object(
  {
    replanId: Type.String(),
    baselineVersion: Nullable(Type.Integer({ minimum: 1 })),
    projectEnd: Type.String(),
    range: Type.Object({ lo: Type.String(), hi: Type.String() }),
    moved: List(
      Type.Object({
        taskKey: c.TaskKey,
        before: Type.String(),
        after: Type.String(),
        deltaDays: Type.Number(),
      }),
    ),
  },
  { title: 'ReplanSummary' },
);

/* ---- 설정 값(조회·저장 공용) ---- */
export const Caps = { total: c.Count, Claude: c.Count, Codex: c.Count, heavy: c.Count };
export const SubagentBudget = c.Body({ dev: c.Count, qa: c.Count });
export const ExecPolicy = {
  onUsage: AnyOf('wait', 'down'),
  lowPct: c.Pct,
  onRework: AnyOf('same', 'up1', 'top'),
  notifyAt: c.Count,
};
/** data-model ci_settings */
export const CiSettings = { nightAt: c.ClockTime, retry: c.Count, deployUrl: Nullable(c.HttpUrl) };

/* ---- 설계 ---- */
export const Decision = Type.Object(
  {
    id: c.Id,
    tdKey: Type.String(),
    area: Type.String(),
    title: Type.String(),
    choice: Type.String(),
    authority: AnyOf('lead', 'agent', 'free'),
    level: Nullable(AnyOf('must', 'cond', 'ban')),
    condition: Type.String(),
    status: AnyOf('fixed', 'approved', 'pending', 'rejected', 'noted', 'change'),
    reason: Type.String(),
    alternatives: Type.String(),
    by: Type.String(),
    at: c.Timestamp,
    updatedAt: c.Timestamp,
  },
  { title: 'Decision' },
);
export const TechProposal = c.Body({
  area: Text,
  title: Text,
  choice: Text,
  reason: Text,
  alternatives: Type.String(),
});
export const DesignStore = AnyOf('postgres', 'neo4j', 'questdb', 'redis');
export const IfaceKind = AnyOf('REST', 'WebSocket', 'SSE', 'Kafka');
export const Drift = Type.Object(
  {
    id: c.Id,
    itemKey: Type.String(),
    kind: Type.String(),
    where: Type.String(),
    text: Type.String(),
    taskKey: Nullable(c.TaskKey),
    compat: AnyOf('compatible', 'breaking', 'unchecked'),
    status: AnyOf('open', 'done'),
    updatedAt: c.Timestamp,
  },
  { title: 'Drift' },
);

/* ---- 저장소 확인 ---- */
export const RepoStructure = c.Body({
  uiux: Type.Boolean(),
  uiuxFiles: c.Count,
  docs: List(c.RepoPath),
  src: Type.Boolean(),
  contracts: Type.Boolean(),
  agentwbs: Type.Boolean(),
});

/* ---- CI ---- */
export const CiStep = c.Body({ name: Text, status: c.CiStatus, durationMs: c.Count });
export const CiRun = Type.Object(
  {
    id: c.Id,
    runKey: Type.String(),
    stage: c.CiStage,
    status: c.CiStatus,
    taskKey: Nullable(c.TaskKey),
    attemptId: Nullable(c.Id),
    ref: Type.String(),
    pr: Nullable(Type.Integer({ minimum: 1 })),
    trigger: Nullable(Type.String()),
    baseSha: Nullable(c.Sha),
    headSha: Nullable(c.Sha),
    mergeSha: Nullable(c.Sha),
    treeSha: Nullable(c.Sha),
    pipelineSha: Nullable(c.Sha),
    steps: List(CiStep),
    failStep: Nullable(Type.String()),
    logExcerpt: Nullable(Type.String()),
    artifacts: lines,
    url: Nullable(Type.String()),
    startedAt: c.Timestamp,
  },
  { title: 'CiRun' },
);
export const MergeQueueItem = Type.Object(
  {
    id: c.Id,
    pr: Type.Integer({ minimum: 1 }),
    taskKey: c.TaskKey,
    position: c.Count,
    status: c.QueueStatus,
    qaHeadSha: Nullable(c.Sha),
    syncedHeadSha: Nullable(c.Sha),
    baseSha: Nullable(c.Sha),
    ciRunId: Nullable(c.Id),
    actualMergeSha: Nullable(c.Sha),
  },
  { title: 'MergeQueueItem' },
);
