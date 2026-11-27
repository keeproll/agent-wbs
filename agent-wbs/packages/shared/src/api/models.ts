import Type, { type TProperties, type TSchema } from 'typebox';
import * as v from '../vocabulary.ts';
import * as c from './common.ts';

const { AnyOf, Nullable, Opt, List, Text } = c;

/** reset-cleanup의 holds[]와 정상 재시작 조회가 같은 DB 필드 이름을 쓴다. lease 정보는 조회 때만 덧붙인다. */
export const ExecutionHold = Type.Object({
  id: c.Id, project_id: Nullable(c.Id), job: c.Id, attempt: Nullable(c.Id), epoch: c.Epoch,
  host_id: Nullable(Text), boot_id: Nullable(Text), fence: Nullable(c.Fence), pgid: Nullable(c.PositiveInt4), cgroup: Nullable(Text),
  task: Nullable(c.Id), conflict_group: Nullable(Text), agent: c.Agent, slots: c.Int4Count, heavy: Type.Boolean(),
  slot_state: AnyOf('none', 'reserved', 'active', 'unconfirmed'),
  lock_state: AnyOf('none', 'held', 'orphaned', 'handed_over', 'released'),
  lock_from_job: Nullable(c.Id), handed_to_job: Nullable(c.Id), release_proof: Nullable(AnyOf('no_process', 'group_empty', 'boot_changed')),
  closed_at: Nullable(c.Timestamp), created_at: c.Timestamp, updated_at: c.Timestamp,
  lease_owner: Opt(Nullable(Text)), lease_until: Opt(Nullable(c.Timestamp)),
}, { title: 'ExecutionHold' });

/* ---- 판단 기록(data-model §2.3-1, D-33·D-34). 이름과 구조를 그대로 쓴다. ---- */
const judgement = {
  result: AnyOf('met', 'not_met'),
  agreedBy: List(c.Agent, { minItems: 2, uniqueItems: true }),
  basis: Text,
  judgedAt: c.Timestamp,
  sourceRef: Type.String({ pattern: '^sha256:[0-9a-f]{64}$', description: '판단 입력 지문: sha256:<64 lowercase hex>. 일반 규칙은 JudgedContent를 RFC 8785 JCS로 직렬화한 UTF-8의 SHA-256이다. 분할 전체 판단은 기존 splitSubjectHash(판단을 뺀 ops + splitTasks의 JCS SHA-256)다. 서버 계산과 다르면 VERSION_CONFLICT이며 판단을 저장하지 않는다.' }),
};
const splitRule = AnyOf('revert', 'contract', 'refactor');
const cpRule = AnyOf('ac_meaning', 'layer_order', 'test_included');
const subjectHash = c.Sha256;
/** rule별 최대 1건은 서버가 검사한다. */
const judgements = <T extends TSchema>(item: T) =>
  c.Body({ schemaVersion: Type.Literal(1), items: List(item, { maxItems: 3 }) });
/** 새 Task·초안·CP: sourceRef의 입력 지문을 대조한 뒤 그 지문을 subjectHash로 보관한다. */
export const NewJudgedRules = judgements(c.Body({ rule: splitRule, ...judgement }));
export const NewSplitJudgements = judgements(c.Body({ rule: cpRule, ...judgement }));
/** 저장된 기록과 기존 Task 재판단. subjectHash와 sourceRef는 모두 실제 판단한 변경 후 내용을 가리킨다. */
export const JudgedRules = judgements(c.Body({ rule: splitRule, ...judgement, subjectHash }));
export const SplitJudgements = judgements(c.Body({ rule: cpRule, ...judgement, subjectHash }));

/* ---- Change Proposal 변경(P `ops`, G§5.6). 저장·시뮬레이션이 P의 키를 그대로 쓴다. ---- */
/** Task별 분할 근거(G§5.2-1). 초안 Task와 CP가 추가하는 Task가 같은 정의를 쓴다. */
const splitBasis = Text;
const lines = List(Type.String());
const proposedTask = {
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
  srcV: Opt(c.Int4Count),
  splitBasis: Opt(splitBasis),
  // 선택 필드(data-model §2.4-1). design의 kind 중복은 시뮬레이션이 검사한다.
  scope: Opt(lines),
  files: Opt(lines),
  design: Opt(List(c.Body({ kind: c.DesignKind, content: c.Json }), { maxItems: 4 })),
};
/** 충돌 묶음은 Planning만 지정한다(G§6.6). 생략과 명시한 null은 다르다: 분할 CP의 생략은 상속이다. */
const planned = { conflictGroup: Opt(Nullable(Text)) };
const ModifyOp = (field: string, after: Parameters<typeof Opt>[0]) =>
  c.Body({ op: AnyOf('modify'), task: c.TaskKey, field: AnyOf(field), before: Opt(Type.Unknown()), after });
/** CP가 바꾸는 기존 Task 또는 새 Task의 ref */
export const ProposalTarget = Type.String({ pattern: '^(TASK-[0-9]{4,}|NEW-[0-9]+)$' });
export const NewTaskRef = Type.String({ pattern: '^NEW-[0-9]+$' });
const proposalOp = (title: string, judged: TProperties) =>
  Type.Union(
    [
      c.Body({
        op: AnyOf('add'),
        ref: NewTaskRef,
        t: c.Body({ ...proposedTask, ...judged }),
        preds: List(c.Body({ pred: c.Id, type: c.DepType })),
      }),
      ...['title', 'doneCond', 'scopeAdd', 'acAdd'].map((field) => ModifyOp(field, Text)),
      ModifyOp('priority', c.Priority),
      ...['assignee', 'verifier'].map((field) => ModifyOp(field, c.Agent)),
      c.Body({ op: AnyOf('remove'), task: c.TaskKey }),
      c.Body({ op: AnyOf('dep-add'), pred: c.Id, succ: c.Id, type: c.DepType }),
      c.Body({ op: AnyOf('dep-remove'), pred: c.Id, succ: c.Id }),
    ],
    { title },
  );
/** 저장된 변경 */
export const ProposalOp = proposalOp('ProposalOp', { ...planned, judgedRules: Opt(JudgedRules) });
/** 팀장 작성: 판단 기록과 충돌 묶음은 쓸 수 없다. */
export const LeadProposalOp = proposalOp('LeadProposalOp', {});
export const PlanningProposalOp = proposalOp('PlanningProposalOp', { ...planned, judgedRules: Opt(NewJudgedRules) });
/** 분할 CP(source.kind=split)의 추가 Task는 분할 근거가 필수다. */
export const LeadSplitProposalOp = proposalOp('LeadSplitProposalOp', { splitBasis });
export const PlanningSplitProposalOp = proposalOp('PlanningSplitProposalOp', {
  ...planned, splitBasis, judgedRules: Opt(NewJudgedRules),
});
/** 판단 job이 주는 ops: 저장된 변경에서 판단 기록만 뺀 것 */
export const JudgedProposalOp = proposalOp('JudgedProposalOp', planned);
export const JudgedSplitProposalOp = proposalOp('JudgedSplitProposalOp', { ...planned, splitBasis });

/** 자동 반영은 held, 수동 승인·반영은 409(contracts §2.1) */
export const HoldReason = Type.Object(
  {
    code: AnyOf('JUDGEMENT_MISSING', 'JUDGEMENT_NOT_MET', 'ORDER_NOT_PRESERVED', 'ACTIVE_TASK_BLOCKED'),
    taskKey: Opt(c.TaskKey),
    rule: Opt(Type.Union([splitRule, cpRule])),
    message: Type.String(),
  },
  { title: 'HoldReason' },
);
/** D-33~35 외의 반영 불가 사유(완료 Task 수정, 순환 등) */
const issues = List(
  // taskKey는 특정 Task의 문제일 때만. 새 Task는 idMap의 예상 키
  Type.Object({ index: Nullable(c.Count), code: Type.String(), taskKey: Opt(c.TaskKey), message: Type.String() }),
);

/** 취소로 제거된 관계와 실제로 풀리는 후속(contracts §2.1, D-27) */
const Relation = { pred: c.TaskKey, succ: c.TaskKey, type: c.DepType };
export const Impact = Type.Object(
  {
    removedDependencies: List(
      Type.Object({ ...Relation, reason: AnyOf('pred-cancelled', 'succ-cancelled', 'dep-remove') }),
    ),
    unblockedSuccessors: List(
      Type.Object({
        taskKey: c.TaskKey,
        // 비어 있을 때만 실제로 풀린다.
        remainingBlockers: List(Type.Object({ ...Relation, predStatus: Nullable(c.TaskStatus) })),
      }),
    ),
  },
  { title: 'Impact' },
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
      end: Nullable(c.DateOnly),
      baselineEnd: Nullable(c.DateOnly),
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
/**
 * 재판단 요청(M2-08, G§7.2·D-29). 허용 해제·최저선 변경·하위 Agent 해제로 Planning Agent가 등급·하위 Agent 지정을
 * 다시 판단해야 할 때 estimate job의 `policy.rejudge`에 싣는다. job payload 자체는 기존 estimate 모양 그대로다.
 * - reason: model_disallowed(허용 해제) / floor_changed(최저선 변경) / subagent_disallowed(하위 Agent 해제) / grade_changed(팀장 고정·해제)
 * - trigger: 팀장 화면·이력에 보이는 사유 문구
 * - targets: 다시 판단할 Task와 역할(dev·qa). payload `tasks`에도 같은 Task가 현재 내용·hash와 함께 있다.
 */
export const RejudgeRequest = Type.Object(
  {
    reason: AnyOf('model_disallowed', 'floor_changed', 'subagent_disallowed', 'grade_changed'),
    trigger: Type.String({ minLength: 1 }),
    targets: List(Type.Object({ taskKey: c.TaskKey, roles: List(c.RunRole, { minItems: 1, uniqueItems: true }) }, { additionalProperties: false }), { minItems: 1 }),
  },
  { title: 'RejudgeRequest', additionalProperties: false },
);
/** estimate job의 정책 묶음. 재판단이면 rejudge가 있다. 그 밖의 정책 값은 자유 형식(기존 계약 c.Json과 호환). */
export const EstimatePolicy = Type.Object(
  { rejudge: Type.Optional(RejudgeRequest), gradeChange: Type.Optional(c.Uuid) },
  { title: 'EstimatePolicy', additionalProperties: true },
);
/** 규칙 5·7·9의 판단 대상이자 subjectHash 계산 대상(data-model §2.3-1). 범위를 늘리거나 줄이지 않는다. */
export const JudgedContent = Type.Object(
  {
    title: Type.String(),
    scope: lines,
    out: lines,
    doneCond: Type.String(),
    spec: c.Body(specBody),
    ac: List(c.Body(ac)),
    // 제출 여부는 상태라서 뺀다.
    outputs: List(c.Body({ name: Text, kind: Text, required: Type.Boolean(), verify: Type.String() })),
    designs: List(c.Body({ kind: c.DesignKind, content: c.Json })),
    conflictGroup: Nullable(Type.String()),
  },
  { title: 'JudgedContent', additionalProperties: false, description: 'subjectHash는 이 객체의 RFC 8785 JCS 직렬화 UTF-8 바이트를 SHA-256으로 계산한 64자리 소문자 16진수다. sourceRef는 sha256: 뒤에 같은 값을 붙인다. Unicode 정규화는 하지 않는다. 고정 예시는 contracts/fixtures/judgement-bindings.json에 있다.' },
);
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
/** 개요 편집(UAT-TASK-02, P1111–1127). 토큰은 천 개(K) 단위다. */
const EditHours = Type.Number({ exclusiveMinimum: 0, maximum: 400 });
export const TaskEstimateInput = c.Body({
  estHours: EditHours, loHours: EditHours, hiHours: EditHours, tokensK: c.Count,
});
/**
 * Task 생성 때의 추정(srv-perf, 조정자 결정 2026-11-27). 원본 Wizard 입력은 예상 시간 하나다(P wizErrs·createTask).
 * 필드 이름·범위는 TaskEstimateInput(updateTask)과 같다. 범위(×0.7~×1.6)·토큰(×140K)·신뢰도 「하」는 서버가 정한다.
 */
export const TaskCreateEstimateInput = c.Body({ estHours: EditHours });
export const TaskEstimate = Type.Object({
  estHours: c.Hours, loHours: c.Hours, hiHours: c.Hours, tokensK: Nullable(Type.Number({ minimum: 0 })),
  confidence: c.Confidence, basis: Type.String(), agreedBy: Type.String(), at: c.Timestamp,
}, { title: 'TaskEstimate' });
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
    estimate: Nullable(TaskEstimate),
    fixStart: Nullable(c.DateOnly),
    actStart: Nullable(c.Timestamp),
    actEnd: Nullable(c.Timestamp),
    actualHours: c.Hours,
    conflictGroup: Nullable(Type.String()),
    srcInputVersion: Nullable(c.Int4Count),
    grades: Type.Object({ dev: Nullable(Grade), qa: Nullable(Grade) }),
    subagents: Type.Object({ dev: List(c.Id), qa: List(c.Id) }),
    split: Nullable(
      Type.Object({
        basis: Type.String(),
        judgedRules: Nullable(JudgedRules),
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
const RunGrade = c.Body({ model: Text, effort: Text });
/** 조정의 이전·이후·사유. regrade는 허용 해제로 재판단한 재개(D-29), up은 모델 이동을 포함한다(D-30). */
export const GradeAdjust = c.Body({
  kind: AnyOf('up', 'down', 'keep', 'regrade'),
  from: RunGrade,
  to: RunGrade,
  reason: Text,
});
export const AttemptStatus = AnyOf(...v.ATTEMPT_STATUSES);
export const Attempt = Type.Object(
  {
    id: c.Id,
    attemptKey: Type.String(),
    taskKey: c.TaskKey,
    kind: c.AttemptKind,
    agent: c.Agent,
    status: AttemptStatus,
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
    /** 경로 입력은 파일 업로드가 아니다. 원본을 읽지 않았으므로 지문·크기는 null이다(UAT-VERIFY-02). */
    path: Opt(Nullable(Type.String())),
    sha256: Nullable(c.Sha256),
    size: Nullable(c.Count),
  },
  { title: 'Evidence' },
);
export const Verification = Type.Object(
  {
    id: c.Id,
    verificationKey: Opt(Type.String()),
    taskKey: c.TaskKey,
    attemptId: c.Id,
    result: c.PassFail,
    headSha: c.Sha,
    specRevision: c.Int4Count,
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
export const GateKey = AnyOf('checklist', 'outputs', 'verification', 'defects', 'approval');
export const Gate = Type.Object(
  {
    taskKey: c.TaskKey,
    passed: Type.Boolean(),
    conditions: List(
      Type.Object({
        key: GateKey,
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
/** CP 제출 본문. 분할 CP만 추가 Task에 분할 근거를 요구한다. */
export const proposalBody = <T extends TProperties, O extends TSchema, S extends TSchema>(extra: T, op: O, splitOp: S) => {
  const body = <K extends TSchema, I extends TSchema>(kind: K, item: I) =>
    c.Body({ ...extra, title: Text, reason: Text, source: c.Body({ kind, id: Opt(c.Id) }), ops: List(item, { minItems: 1 }) });
  // 분할 CP는 원래 Task 키가 필수다(조정자 결정 2026-11-26). 충돌 묶음 상속과 분할 검증의 기준이다.
  const splitBody = <I extends TSchema>(item: I) =>
    c.Body({ ...extra, title: Text, reason: Text, source: c.Body({ kind: AnyOf('split'), id: c.TaskKey }), ops: List(item, { minItems: 1 }) });
  return Type.Union([body(AnyOf('planning', 'message', 'manual', 'input', 'decision'), op), splitBody(splitOp)]);
};
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
    splitJudgements: Nullable(SplitJudgements),
    /** 기존 Task의 변경 후 내용에 대한 판단. 새 Task의 판단은 ops[].t.judgedRules */
    taskJudgements: List(Type.Object({ taskKey: c.TaskKey, judgedRules: JudgedRules })),
    holdReasons: List(HoldReason),
    issues,
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
    kind: AnyOf('agree', 'diff'),
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
    planningKey: Type.String(),
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

export const MoveKind = AnyOf('delayed', 'advanced', 'new', 'excluded');
/** P TASK-0012 replans 응답. 자동 반영 정책이 꺼져 있으면(202) 기준 버전이 없다(D-10). */
export const ReplanSummary = Type.Object(
  {
    replanId: Type.String(),
    baselineVersion: Nullable(c.PositiveInt4),
    projectEnd: c.DateOnly,
    range: Type.Object({ lo: c.DateOnly, hi: c.DateOnly }),
    moved: List(
      Type.Object({
        taskKey: c.TaskKey,
        kind: MoveKind,
        // 신규 편입은 before, 제외는 after가 없다.
        before: Nullable(c.DateOnly),
        after: Nullable(c.DateOnly),
        deltaDays: Nullable(Type.Number()),
      }),
    ),
  },
  { title: 'ReplanSummary' },
);

/* ---- 설정 값(조회·저장 공용) ---- */
export const Caps = { total: c.Int4Count, Claude: c.Int4Count, Codex: c.Int4Count, heavy: c.Int4Count };
export const SubagentBudget = c.Body({ dev: c.Int4Count, qa: c.Int4Count });
export const ExecPolicy = {
  onUsage: AnyOf('wait', 'down'),
  lowPct: c.Pct,
  onRework: AnyOf('same', 'up1', 'top'),
  notifyAt: c.Int4Count,
};
/** data-model ci_settings */
/** 모델 순서 설정(owner 2026-11-26 아이템 8). 목록은 아래 등급부터, 같은 모델을 두 번 쓰지 않는다. */
const ModelIds = (min = 0) => List(Type.String({ minLength: 1 }), { uniqueItems: true, minItems: min });
export const ModelRankOrder = c.Body({ Claude: ModelIds(), Codex: ModelIds() });
/** Codex 같은 세대 안 계열 순서(아래부터) */
export const CodexFamilyOrder = ModelIds(1);
/** Runner가 보고할 Claude 모델(초기값=Q-06 승인표) */
export const ClaudeModels = ModelIds(1);
export const CiSettings = { nightAt: c.ClockTime, retry: c.Int4Count, deployUrl: Nullable(c.HttpUrl) };

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
    // 조건부 선호에서 만든 결정: 원래 제약과 Planning의 조건 충족 판단(근거는 reason)
    constraintId: Opt(Nullable(c.Id)),
    conditionResult: Opt(Nullable(AnyOf('met', 'not_met'))),
  },
  { title: 'Decision' },
);
/** 조건부 선호 하나의 조건 충족 판단(G§4.12). 근거는 공백 아닌 문장 */
export const ConditionJudgement = { constraintId: c.Id, result: AnyOf('met', 'not_met'), reason: Text };
export const TechProposal = {
  area: Text,
  title: Text,
  choice: Text,
  reason: Text,
  alternatives: Type.String(),
};
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
export const CiE2e = c.Body({ passed:c.Count,total:c.Count });
export const CiGithubStatus = c.Body({ headSha:c.Sha,context:Text,state:AnyOf('pending','success','failure','error'),reportedAt:c.Timestamp,url:Opt(c.HttpUrl) });
export const CiServiceConfig = c.Body({ path:c.RepoPath,commit:c.Sha,status:AnyOf('ok','error','missing'),raw:Nullable(Type.String()),error:Nullable(Type.String()) });
export const CiObservedSettings = { serviceConfig:Opt(Nullable(CiServiceConfig)) };
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
    pr: Nullable(c.PositiveInt4),
    trigger: Nullable(Type.String()),
    baseSha: Nullable(c.Sha),
    headSha: Nullable(c.Sha),
    mergeSha: Nullable(c.Sha),
    treeSha: Nullable(c.Sha),
    pipelineSha: Nullable(c.Sha),
    steps: List(CiStep),
    failStep: Nullable(Type.String()),
    failScope: Opt(Nullable(c.AnyOf('baseline', 'task'))),
    logExcerpt: Nullable(Type.String()),
    artifacts: lines,
    url: Nullable(Type.String()),
    startedAt: c.Timestamp,
    finishedAt:Opt(Nullable(c.Timestamp)),
    note:Opt(Nullable(Type.String())),
    e2e:Opt(Nullable(CiE2e)),
    githubStatus:Opt(Nullable(CiGithubStatus)),
    baselineResolved:Nullable(Type.Boolean()),
    autoReintegrate:AnyOf('none','pending','blocked'),
    autoReintegrateReason:Nullable(Type.String()),
    retryAllowed:Type.Boolean(),
    retryBlockedReason:Nullable(Type.String()),
    taskStatus:Nullable(c.TaskStatus),
    mergeStatus:Nullable(c.QueueStatus),
    mergeCompleted:Type.Boolean(),
    actualMergeSha:Nullable(c.Sha),
    causeCandidates:Opt(List(c.Body({ commit:c.Sha,taskKey:Nullable(c.TaskKey) }))),
  },
  { title: 'CiRun' },
);
export const MergeQueueItem = Type.Object(
  {
    id: c.Id,
    pr: c.PositiveInt4,
    taskKey: c.TaskKey,
    position: c.Int4Count,
    status: c.QueueStatus,
    qaHeadSha: Nullable(c.Sha),
    syncedHeadSha: Nullable(c.Sha),
    baseSha: Nullable(c.Sha),
    ciRunId: Nullable(c.Id),
    actualMergeSha: Nullable(c.Sha),
    queuedAt:Opt(c.Timestamp),
    mergedAt:Opt(Nullable(c.Timestamp)),
  },
  { title: 'MergeQueueItem' },
);

/* ---- 추정 · 초안 ---- */
export const Estimate = {
  estHours: c.Hours,
  loHours: c.Hours,
  hiHours: c.Hours,
  tokensK: Opt(Type.Number({ minimum: 0 })),
  confidence: c.Confidence,
  basis: Text,
  agreedBy: List(c.Agent, { minItems: 1, uniqueItems: true }),
};
const GradeProposal = c.Body({ modelId: Text, effort: Text, reason: Text });
export const roleGrades = c.Body({ dev: GradeProposal, qa: GradeProposal });
export const roleSubagents = c.Body({ dev: List(c.Id), qa: List(c.Id), basis: Type.String() });
/** 초안 안에서만 쓰는 참조(승인 때 Task ID가 정해진다) */
const Ref = Text;

const draftTask = <T extends TSchema>(judgedRules: T) => c.Body({
  ref: Ref,
  wpRef: Ref,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  workType: c.WorkType,
  primaryDomain: c.Domain,
  relatedDomains: List(c.Domain),
  priority: c.Priority,
  assigneeAgent: c.Agent,
  verifierAgent: c.Agent,
  estimate: c.Body(Estimate),
  ...SpecInput,
  outputs: List(OutputInput),
  checklist: List(c.Body(ChecklistInput)),
  grades: roleGrades,
  subagents: roleSubagents,
  splitBasis,
  judgedRules: Opt(judgedRules),
  conflictGroup: Nullable(Text),
  designItems: List(c.Body({ itemKey: Text, change: Text })),
});

/** 초기 WBS 초안(contracts §3.3). 저장된 초안의 판단에는 hash가 있다. */
const wbsDraft = <T extends TSchema>(judgedRules: T) => ({
  phases: List(c.Body({ ref: Ref, title: Text }), { minItems: 1 }),
  wps: List(c.Body({ ref: Ref, phaseRef: Ref, title: Text }), { minItems: 1 }),
  tasks: List(draftTask(judgedRules), { minItems: 1 }),
  deps: List(c.Body({ predRef: Ref, succRef: Ref, depType: c.DepType })),
});
export const WbsDraft = wbsDraft(NewJudgedRules);
const StoredDraft = wbsDraft(JudgedRules);

/* ---- 화면 조회 응답. 필드 근거는 프로토타입 계산 결과(P 줄 번호)이고 표시 문자열 대신 값을 보낸다. ---- */
const N = Type.Number();
const Str = Type.String();
const MaybeStr = Nullable(Type.String());
const MaybeDate = Nullable(c.DateOnly);
const obj = Type.Object;

export const Alert = Type.Object(
  { id: c.Id, key: Str, severity: Str, taskKey: Nullable(c.TaskKey), target: MaybeStr, text: Str, at: c.Timestamp },
  { title: 'Alert' },
);

/** P simulate L4304, M1-05 결과 */
const simulation = {
  issues,
  holdReasons: List(HoldReason),
  idMap: Type.Record(Type.String(), c.TaskKey),
  diff: List(
    obj({ index: c.Count, op: Str, target: Str, field: Str, before: Type.Unknown(), after: Type.Unknown() }),
  ),
  impact: Impact,
};
export const ProposalPreview = Type.Object({ previewHash: Str, ...simulation }, { title: 'ProposalPreview' });
/** 반영 결과. 문제가 있으면 status가 held이고 issues에 사유가 있다. */
export const ProposalApplied = Type.Object({ proposal: Proposal, ...simulation }, { title: 'ProposalApplied' });

/** P L4488·L4490 */
const BOOT_STEPS = ['check', 'unzip', 'repo', 'codex', 'claude', 'cross', 'tech', 'draft', 'approve'] as const;
const INPUT_STEPS = ['check', 'unzip', 'diff', 'impact', 'cp'] as const;
export const JobStepKey = AnyOf(
  'check', 'unzip', 'repo', 'codex', 'claude', 'cross', 'tech', 'draft', 'approve', 'diff', 'impact', 'cp',
);
const jobView = <const T extends readonly string[]>(...keys: T) => ({
  jobId: c.Id,
  runNo: c.PositiveInt4,
  status: AnyOf('queued', 'running', 'done', 'failed', 'cancelled'),
  steps: List(obj({ key: AnyOf(...keys), status: c.StepStatus, at: Nullable(c.Timestamp), note: Str })),
  logs: List(obj({ at: c.Timestamp, text: Str })),
  fail: Nullable(obj({ reason: Str, fix: Str })),
});
const projectBase = {
  epoch: c.Epoch,
  cleanup: AnyOf('none', 'pending', 'running', 'failed'),
};
const registered = {
  ...projectBase,
  id: c.Id,
  name: Str,
  description: Str,
  startDate: c.DateOnly,
  /** Runner가 마지막으로 유효한 main 관측을 보고한 시각. 요청 접수·브라우저 조회 시각이 아니다. */
  inputCheckedAt: Nullable(c.Timestamp),
  repo: obj({ url: c.RepoUrl, owner: Str, name: Str, branch: AnyOf('main'), baseCommit: Nullable(c.Sha) }),
  targetDate: MaybeDate,
  instruction: Str,
  constraints: List(obj({ id: c.Id, name: Str, level: AnyOf('must', 'cond', 'ban'), condition: Str })),
  registeredAt: c.Timestamp,
  inputs: List(
    obj({
      v: c.PositiveInt4,
      at: c.Timestamp,
      commit: c.Sha,
      mdList: List(c.RepoPath),
      changes: List(obj({ path: c.RepoPath, change: AnyOf('added', 'modified', 'deleted') })),
      instruction: Str,
      result: MaybeStr,
      taskCount: c.Count,
    }),
  ),
  changeCommits: List(
    obj({
      sha: c.Sha,
      at: c.Timestamp,
      author: Str,
      message: Str,
      state: AnyOf('pending', 'skipped', 'analyzed'),
      files: List(
        obj({ path: c.RepoPath, change: AnyOf('added', 'modified', 'deleted'), added: c.Count, deleted: c.Count }),
      ),
    }),
  ),
  /** 입력 사슬의 끝: Runner가 마지막으로 보고한 main 끝 커밋(처음에는 등록 커밋). 「이 버전으로 분석」은 이 커밋으로 고정한다. */
  inputHead: c.Sha,
  inputJob: Nullable(obj({ ...jobView(...INPUT_STEPS), version: c.PositiveInt4, proposalId: Nullable(c.Id) })),
  updatedAt: c.Timestamp,
};
/** 등록 전 / 초기 분석 / 진행 중(data-model §3.4, P project·boot) */
export const ProjectState = Type.Union(
  [
    obj({ state: AnyOf('none'), ...projectBase }),
    obj({
      state: AnyOf('boot'),
      ...registered,
      bootstrap: obj({
        ...jobView(...BOOT_STEPS),
        decisions: List(Decision),
        revision: Nullable(c.PositiveInt4),
        draft: Nullable(
          obj({ ...StoredDraft, splitCheck: obj({ pass: c.Count, suspect: c.Count, violation: c.Count }) }),
        ),
      }),
    }),
    obj({ state: AnyOf('active'), ...registered, approvedAt: c.Timestamp, approvedTaskCount: c.Count }),
  ],
  { title: 'ProjectState' },
);

/** P resetImpact L4696 */
export const ResetPreview = Type.Object(
  {
    epoch: c.Epoch,
    projectName: Str,
    counts: obj({
      tasks: c.Count, running: c.Count, subagents: c.Count, attempts: c.Count, verifications: c.Count,
      evidence: c.Count, proposals: c.Count, messages: c.Count, history: c.Count, reports: c.Count,
      baselines: c.Count, inputs: c.Count,
    }),
    sending: obj({ mail: c.Count, notify: c.Count }, { description: '이미 외부로 보내기 시작한 건수다. 초기화해도 회수할 수 없다.' }),
    runner: obj({ branches: List(Str), worktrees: c.Count, worktreesEstimated: Type.Literal(true, { description: '기록된 Agent 브랜치 수로 계산한 추정값이다. 실제 작업 폴더 수와 다를 수 있다.' }), mergedTasks: c.Count }),
    repo: registered.repo,
  },
  { title: 'ResetPreview' },
);

/** P schedule L4279, M1-04 결과. 날짜는 Asia/Seoul */
const Rate = Type.Number({ minimum: 0, maximum: 1 });
const schedulePeriod = { s: N, e: N };
const projectSchedule = {
  start: c.DateOnly,
  end: c.DateOnly,
  lo: c.DateOnly,
  hi: c.DateOnly,
  baselineVersion: c.Count,
  baselineEnd: MaybeDate,
  firstBaselineEnd: MaybeDate,
  target: MaybeDate,
  slipDays: N,
  slackDays: Nullable(N),
  elapsedDays: N,
  remainingDays: N,
  totalHours: c.Hours,
  doneHours: c.Hours,
  remainHours: c.Hours,
  progressPct: c.Pct,
  plannedPct: c.Pct,
  doneRatePct: c.Pct,
  doneHoursRatePct: c.Pct,
  doneCount: c.Count,
  taskCount: c.Count,
};
/** M1-04 경고. 시계 오차로 자른 값의 이전·이후를 보존한다(세션 또는 Task). */
export const ScheduleWarning = Type.Union(
  [
    obj({ code: AnyOf('USAGE_RESET_UNKNOWN'), agent: c.Agent }),
    obj({
      code: AnyOf('CLOCK_SKEW_CLAMPED'), taskKey: c.TaskKey, field: AnyOf('actStart', 'actEnd'), before: Str, after: Str,
    }),
    obj({
      code: AnyOf('CLOCK_SKEW_CLAMPED'), sessionFrom: Str, field: AnyOf('lastHeartbeatAt', 'to'), before: Str, after: Str,
    }),
  ],
  { title: 'ScheduleWarning' },
);
export const Schedule = Type.Object(
  {
    calcVersion: c.Count,
    at: c.Timestamp,
    tasks: List(
      obj({
        taskKey: c.TaskKey,
        start: c.DateOnly,
        end: c.DateOnly,
        lo: c.DateOnly,
        hi: c.DateOnly,
        estHours: c.Hours,
        loHours: c.Hours,
        hiHours: c.Hours,
        progressPct: c.Pct,
        started: Type.Boolean(),
        done: Type.Boolean(),
        isNew: Type.Boolean(),
        baselineStart: MaybeDate,
        baselineEnd: MaybeDate,
        slipDays: Nullable(N),
        // 유효 작업 시간 축(시나리오별)
        mid: obj(schedulePeriod),
        optimistic: obj(schedulePeriod),
        pessimistic: obj(schedulePeriod),
      }),
    ),
    project: obj(projectSchedule),
    capacity: obj({
      days: List(obj({ date: c.DateOnly, rate: Rate })),
      measured: Rate,
      enough: Type.Boolean(),
      loggedHours: c.Hours,
      rate: Rate,
      rateLo: Rate,
      rateHi: Rate,
      todayRate: Rate,
    }),
    blackouts: List(obj({ date: c.DateOnly, note: Str })),
    warnings: List(ScheduleWarning),
  },
  { title: 'Schedule' },
);

/** P dashVM L6274 */
const counts = <const T extends readonly string[]>(...keys: T) => List(obj({ key: AnyOf(...keys), count: c.Count }));
const taskRef = { taskKey: c.TaskKey, title: Str };
export const Dashboard = Type.Object(
  {
    at: c.Timestamp,
    tasks: obj({ total: c.Count, done: c.Count, active: c.Count, blocked: c.Count }),
    byWorkType: counts(...v.WORK_TYPES),
    byDomain: counts(...v.DOMAINS),
    schedule: Nullable(obj({ ...projectSchedule, rate: Rate })),
    panels: obj({
      late: List(obj({ ...taskRef, baselineEnd: MaybeDate, end: c.DateOnly, slipDays: Nullable(N), paused: Type.Boolean() })),
      approvals: List(
        Type.Union([
          obj({ kind: AnyOf('planning'), id: c.Id, planningKey: Opt(Str), title: Str, unresolved: c.Count }),
          obj({ kind: AnyOf('proposal'), id: c.Id, cpKey: Opt(Str), title: Str, status: ProposalStatus }),
        ]),
      ),
      executions: List(
        Type.Union([
          obj({ kind: AnyOf('running'), ...taskRef, attemptId: c.Id, attemptKey: Opt(Str), attemptKind: c.AttemptKind, agent: c.Agent }),
          obj({ kind: AnyOf('ready'), ...taskRef }),
        ]),
      ),
      rework: List(obj({ ...taskRef, verificationId: Nullable(c.Id), result: Nullable(c.PassFail), defects: c.Count })),
      gate: List(obj({ ...taskRef, unmet: List(GateKey) })),
      messages: List(Message),
    }),
    recent: List(
      Type.Union([
        obj({ kind: AnyOf('attempt'), at: c.Timestamp, id: c.Id, attemptKey: Opt(Str), taskKey: c.TaskKey, agent: c.Agent, text: Str, status: AttemptStatus }),
        obj({ kind: AnyOf('verification'), at: c.Timestamp, id: c.Id, verificationKey: Opt(Str), taskKey: c.TaskKey, agent: c.Agent, text: Str, result: c.PassFail }),
      ]),
    ),
    grades: List(
      obj({
        agent: c.Agent, modelId: Str, effort: Str, attempts: c.Count, judged: c.Count, fails: c.Count,
        // 판정 전이면 null
        reworkRatePct: Nullable(c.Pct),
        escalations: c.Count, tokens: c.Count,
      }),
    ),
    alerts: List(Alert),
  },
  { title: 'Dashboard' },
);

/** unknown은 heartbeat 누락 때 서버가 기록한다. */
const EndReason = AnyOf('reboot', 'power_off', 'error', 'manual', 'unknown');
/** P conc L4118, integrity L4373, G§6.6·§6.7 */
export const ObservationGrade = AnyOf('verified', 'partial', 'unverified');
export const RunnerState = Type.Object(
  {
    connection: obj({
      online: Type.Boolean(),
      runnerId: MaybeStr,
      version: MaybeStr,
      lastHeartbeatAt: Nullable(c.Timestamp),
      sessionStartedAt: Nullable(c.Timestamp),
    }),
    readiness: Nullable(
      obj({
        at: c.Timestamp,
        items: List(obj({ key: c.ReadinessKey, status: c.ReadinessStatus, detail: Str, fix: MaybeStr })),
      }),
    ),
    host: Nullable(
      obj({
        hostId: Str, bootId: Str, cpu: Str, cores: c.Int4Count, memGB: N, swapGB: N, diskFreeGB: N, os: Str,
        perSessionGB: Nullable(N), samples: c.Int4Count, seenAt: c.Timestamp,
        recommended: obj(Caps), warnings: List(Str),
      }),
    ),
    hostHistory: List(obj({ hostId: Str, cpu: Str, cores: c.Int4Count, memGB: N, seenAt: c.Timestamp })),
    concurrency: obj({
      mode: AnyOf('auto', 'manual'),
      caps: obj(Caps),
      memReserveGB: N,
      limit: Nullable(c.Count),
      used: obj({ total: c.Count, Claude: c.Count, Codex: c.Count }),
      subagentsObserved: c.Count,
      subagentsHeld: c.Count,
      subRatio: N,
      heavyJobs: c.Count,
      resources: Nullable(obj({ cpuPct: N, memFreeGB: N, swapGB: N, at: c.Timestamp })),
      parallelWidth: c.Count,
      startable: c.Count,
      factor: AnyOf('cap', 'runner_limit', 'parallel_tasks'),
      pressure: Type.Boolean(),
      conflictWaits: List(obj({ taskKey: c.TaskKey, conflictGroup: Str, by: c.TaskKey })),
      adjustments: List(obj({ at: c.Timestamp, from: c.Count, to: c.Count, by: Str, reason: Str })),
    }),
    sessions: List(
      obj({
        attemptId: c.Id, taskKey: c.TaskKey, agent: c.Agent, observed: c.Count, reserved: c.Count,
        state: c.ObservationState, grade: ObservationGrade,
      }),
    ),
    unconfirmedHolds: List(obj({ jobId: c.Id, taskKey: Nullable(c.TaskKey), hostId: MaybeStr, slots: c.Count })),
    observation: obj({
      budget: SubagentBudget,
      profiles: List(
        obj({
          agent: c.Agent, version: Str, model: Str, options: Str, grade: ObservationGrade,
          verifiedVersion: MaybeStr, verifiedAt: Nullable(c.Timestamp), notes: Str,
        }),
      ),
    }),
    usage: List(obj({ agent: c.Agent, remainPct: c.Pct, resetAt: Nullable(c.Timestamp), at: c.Timestamp })),
    // 최근 중단 구간. to가 null이면 아직 끊긴 상태(P L6684)
    gaps: List(obj({ from: c.Timestamp, to: Nullable(c.Timestamp), reason: EndReason })),
    externalWrite: obj({ state: AnyOf('granted', 'blocked'), reason: MaybeStr }),
  },
  { title: 'RunnerState' },
);
export const Integrity = Type.Object(
  { checkedAt: c.Timestamp, items: List(obj({ key: Str, label: Str, ok: Type.Boolean(), detail: Str })) },
  { title: 'Integrity' },
);

/** 보고서 12개 구성(G L379-392, P report L3796). int/ext 보기가 같은 값을 쓴다. */
const rel = { taskKey: c.TaskKey, wbsPath: Str, title: Str };
const actors = { assignee: Nullable(c.Agent), verifier: Nullable(c.Agent) };
const ratio = obj({ done: c.Count, total: c.Count });
const checklistCount = obj({ done: c.Count, total: c.Count, requiredLeft: c.Count });
const grade = Nullable(obj({ modelId: Str, effort: Str }));
const blockers = List(obj({ pred: c.TaskKey, type: c.DepType, status: c.TaskStatus }));
const gateCount = obj({ passed: c.Count, unmet: List(GateKey) });
const lastVerification = Nullable(obj({ id: c.Id, result: c.PassFail, cmd: Str, actual: Str }));
const moved = List(
  obj({ taskKey: c.TaskKey, title: Str, kind: MoveKind, before: MaybeDate, after: MaybeDate, deltaDays: Nullable(N) }),
);
export const ReportSnapshot = Type.Object(
  {
    summary: obj({
      taskCount: c.Count, doneCount: c.Count, doneBefore: c.Count, workPct: c.Pct, workPctBefore: c.Pct,
      baselineVersion: c.Count, forecast: MaybeDate, lo: MaybeDate, hi: MaybeDate, forecastBefore: MaybeDate,
      target: MaybeDate, uptimePct: c.Pct, ratePct: c.Pct, blocked: c.Count,
      statuses: List(obj({ status: c.TaskStatus, count: c.Count })),
      started: List(obj({ ...rel, at: c.Timestamp })),
      attempts: obj({
        total: c.Count, dev: c.Count, qa: c.Count, pass: c.Count, fail: c.Count, escalated: c.Count,
        interrupted: c.Count, tokens: c.Count,
      }),
    }),
    issues: List(obj({ level: AnyOf('bad', 'warn', 'info'), text: Str, taskKey: Nullable(c.TaskKey) })),
    series: List(
      obj({ day: c.DateOnly, done: c.Count, attempts: c.Count, fails: c.Count, uptimePct: c.Pct, forecast: MaybeDate }),
    ),
    done: List(
      obj({
        ...rel, ...actors, workType: c.WorkType, domain: c.Domain,
        actStart: Nullable(c.Timestamp), actEnd: c.Timestamp, estHours: c.Hours, actualHours: c.Hours,
        attempts: c.Count, slipDays: Nullable(N), verification: lastVerification, checklist: checklistCount,
        outputs: obj({ delivered: c.Count, names: List(Str) }), doneCond: Str,
      }),
    ),
    active: List(
      obj({
        ...rel, ...actors, workType: c.WorkType, domain: c.Domain, status: c.TaskStatus, progressPct: c.Pct,
        actStart: Nullable(c.Timestamp), end: MaybeDate, lo: MaybeDate, hi: MaybeDate, slipDays: Nullable(N),
        remainHours: Nullable(c.Hours),
        lastAttempt: Nullable(
          obj({ attemptKey: Str, kind: c.AttemptKind, agent: c.Agent, grade, status: AttemptStatus, summary: Str }),
        ),
        verification: lastVerification, checklist: checklistCount, gate: gateCount,
        blockingDefects: c.Count, blockers, next: Str,
      }),
    ),
    failures: List(
      obj({
        verificationId: c.Id, taskKey: c.TaskKey, title: Str, agent: c.Agent, at: c.Timestamp, cmd: Str, expected: Str,
        actual: Str, defects: List(Str), evidence: List(Str),
        messages: List(obj({ msgKey: Str, delivery: Str })),
        reworks: List(obj({ attemptKey: Str, status: AttemptStatus })),
      }),
    ),
    attempts: List(
      obj({
        attemptKey: Str, taskKey: c.TaskKey, kind: c.AttemptKind, agent: c.Agent, grade, startedAt: c.Timestamp,
        endedAt: Nullable(c.Timestamp), status: AttemptStatus, summary: Str, adjust: Nullable(GradeAdjust),
        files: c.Count, tokens: c.Count,
      }),
    ),
    replans: List(
      obj({ replanId: Str, at: c.Timestamp, trigger: Str, before: MaybeDate, after: c.DateOnly, lo: c.DateOnly, hi: c.DateOnly, moved }),
    ),
    gaps: List(obj({ from: c.Timestamp, to: Nullable(c.Timestamp), minutes: c.Count, reason: EndReason })),
    messages: List(
      obj({
        at: c.Timestamp, taskKey: c.TaskKey, dir: AnyOf('out', 'in'), agent: Nullable(c.Agent), type: Str,
        delivery: MaybeStr, pendingNext: Type.Boolean(), firstLine: Str,
      }),
    ),
    next: List(
      obj({
        ...rel, ...actors, status: c.TaskStatus, start: c.DateOnly, end: c.DateOnly, estHours: c.Hours, grade, blockers,
        conflictGroup: MaybeStr,
      }),
    ),
    all: List(
      obj({
        ...rel, ...actors, status: c.TaskStatus, progressPct: c.Pct, checklist: ratio, verifState: c.VerifState,
        end: MaybeDate, slipDays: Nullable(N), blocked: Type.Boolean(),
      }),
    ),
  },
  { title: 'ReportSnapshot' },
);

/** P CI_PIPE L3525. 원문은 main 커밋의 것이며 해석하지 못하면 stages가 null이다. */
export const Pipeline = Type.Object(
  {
    serviceConfig:Opt(CiServiceConfig),
    path: AnyOf('.agentwbs/pipeline.yaml'),
    commit: Nullable(c.Sha),
    status: AnyOf('ok', 'error', 'missing'),
    error: MaybeStr,
    raw: MaybeStr,
    stages: Nullable(List(obj({ stage: c.CiStage, when: Str, gate: Str, steps: List(Str) }))),
  },
  { title: 'Pipeline' },
);

/** P DS_MOCK L3559 */
const fileStatus = AnyOf('ok', 'draft', 'error');
export const designOverview = {
  components: List(obj({ id: c.Id, layer: Str, name: Str, tech: Str, note: Str, decisionId: Nullable(c.Id) })),
  links: List(obj({ from: c.Id, to: c.Id, via: Str, contractPath: MaybeStr })),
  files: List(
    obj({ path: Str, kind: Str, format: Str, status: fileStatus, commit: Nullable(c.Sha), itemCount: c.Count, error: MaybeStr }),
  ),
  versions: List(obj({ v: c.PositiveInt4, at: c.Timestamp, by: Str, note: Str, breaking: Type.Boolean() })),
};
/** 해석기가 없는 형식은 raw만 있고 content가 null이다(G L430, Q-14). */
export const DesignSource = Type.Object(
  { path: Str, format: Str, commit: Nullable(c.Sha), status: fileStatus, raw: MaybeStr },
  { title: 'DesignSource' },
);
export const IfaceContent = Nullable(
  Type.Union([
    obj({
      type: AnyOf('REST'), auth: Str, request: Str, response: Str, validation: List(Str),
      errors: List(obj({ code: Str, http: Str, cond: Str })), tables: List(Str),
    }),
    obj({
      type: AnyOf('message'), auth: Str, messages: List(obj({ name: Str, direction: Str, schema: Str })), rules: List(Str),
      topic: Nullable(
        obj({ key: Str, partitions: Str, retention: Str, delivery: Str, dlq: Str, compat: Str, consumers: List(Str) }),
      ),
    }),
  ]),
);
export const DataContent = Nullable(
  Type.Union([
    obj({
      type: AnyOf('postgres'),
      columns: List(
        obj({
          name: Str, type: Str, nullable: Type.Boolean(), pk: Type.Boolean(), unique: Type.Boolean(), fk: MaybeStr,
          default: MaybeStr, desc: Str,
        }),
      ),
      constraints: List(Str),
      indexes: List(obj({ name: Str, columns: Str, kind: Str })),
      usedBy: List(Str),
    }),
    obj({ type: AnyOf('neo4j-label'), props: Str, note: Str, constraints: List(Str) }),
    obj({ type: AnyOf('neo4j-relation'), from: Str, to: Str, props: Str }),
    obj({
      type: AnyOf('questdb'), timestamp: Str, partition: Str, retention: Str, dedup: Str, symbols: Str, columns: Str,
      ingest: Str, aggregation: Str,
    }),
    obj({ type: AnyOf('redis'), use: Str, value: Str, ttl: Str, invalidation: Str, persistence: Str }),
  ]),
);
