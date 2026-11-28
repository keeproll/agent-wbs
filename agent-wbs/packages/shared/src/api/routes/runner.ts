import Type from 'typebox';
import { DesignSnapshot, DesignShape } from '../design.ts';
import * as c from '../common.ts';
import * as m from '../models.ts';
import { operation } from '../operation.ts';

const { AnyOf, Body, Nullable, Opt, List, Text } = c;
/** 실제 사용 보고의 하위 Agent 이름: 1~128자, 공백 아닌 글자 1개 이상, NUL 없음 */
const SubagentName = Type.String({ title: 'SubagentName', minLength: 1, maxLength: 128, pattern: '^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$' });
const runner = { principal: 'runner' } as const;
const fence = c.Fence;
const Pid = c.PositiveInt4;

const PushedCommit = Body({ sha: c.Sha, at: c.Timestamp, author: Type.String(), message: Type.String() });
/**
 * `git diff --raw -M --numstat <base> <head> -- prototype/` 한 줄.
 * status A(추가)·M(수정)·D(삭제)·R(이름 변경, from=이전 경로)·T(종류 변경: 일반 파일 ↔ 심볼릭 링크).
 * blob은 전후 내용의 git blob SHA, mode는 전후 git 파일 모드(100644·100755·120000 등). 없는 쪽은 둘 다 null
 * (raw diff의 000000·0000000은 null로 보낸다). M은 실행 권한만 바뀌어도 생기므로 oldBlob과 newBlob이 같을 수 있다.
 * added·deleted는 numstat 줄 수(바이너리는 0).
 * 서버는 보고 수신과 head 이동을 이 전체 차이(모드 포함)로 판단하고, 분석용 순 변경은 경로별 존재·내용 blob·파일과 링크 구분으로 판단한다.
 * 실행 권한만 바뀐 보고는 head·트리만 옮기고 팀장 확인 항목·입력 버전을 만들지 않는다.
 */
const Mode = Type.String({ pattern: '^[0-7]{6}$' });
/**
 * Runner가 세션을 넣은 cgroup 경로(`/proc/<pid>/cgroup`의 `0::` 뒤 모양, 조정자 결정 3).
 * 절대 경로이고 `..`·`//`·공백이 없다. 예: `/user.slice/user-1000.slice/user@1000.service/app.slice/awbs-<uuid>.scope`.
 */
const CgroupPath = Type.String({ pattern: '^(?!.*//)(?!.*/\\.\\.(/|$))/[A-Za-z0-9@._:/-]{1,511}$' });
const InputDiff = Body({
  status: AnyOf('A', 'M', 'D', 'R', 'T'),
  path: c.RepoPath,
  from: Opt(c.RepoPath),
  oldBlob: Nullable(c.Sha),
  newBlob: Nullable(c.Sha),
  oldMode: Nullable(Mode),
  newMode: Nullable(Mode),
  added: c.Count,
  deleted: c.Count,
});
const Session = Body({ attemptId: c.Id, observed: c.Int4Count, reserved: c.Int4Count, state: c.ObservationState });
const InstalledSubagent = Body({ id: c.Id, version: c.Int4Count, hash: Text });
/**
 * 해제 증거. bootId·processGroup은 보유를 만든 원래 값이고, 서버가 저장된 보유와 같을 때만 그 보유를 닫는다.
 * 낡은 fence의 release도 같은 조건이라 새 프로세스의 보유를 풀 수 없다(contracts §3.2-4·§3.4-2).
 */
const ReleaseProof = Type.Union([
  Body({ kind: AnyOf('no_process'), bootId: Text }),
  Body({ kind: AnyOf('group_empty'), bootId: Text, processGroup: Pid }),
  // cgroup이 기록된 보유: 그 cgroup이 비었음(cgroup.events populated=0)을 확인했다. group_empty로는 닫을 수 없다(조정자 결정 3).
  Body({ kind: AnyOf('cgroup_empty'), bootId: Text, processGroup: Pid, cgroup: CgroupPath }),
  // 예약만 하고 그룹이 없던 보유는 processGroup이 null이다. currentBootId는 host 보고의 bootId와 같아야 한다.
  Body({ kind: AnyOf('boot_changed'), bootId: Text, processGroup: Nullable(Pid), currentBootId: Text }),
]);
/**
 * 초기화 정리 명령의 보유별 정리 증거. 키는 명령 payload의 holds[]와 DB complete_cleanup()이 대조하는 이름이다.
 * 완료(done)에는 payload의 모든 보유에 대한 증거가 필요하다. hostId·bootId는 예약 전 보유면 null이다.
 */
const cleanupBase = { job: c.Id, hostId: Nullable(Text), bootId: Nullable(Text) };
const CleanupProof = Type.Union([
  Body({ ...cleanupBase, proof: AnyOf('no_process') }),
  Body({ ...cleanupBase, proof: AnyOf('group_empty'), processGroup: Pid }),
  Body({ ...cleanupBase, proof: AnyOf('cgroup_empty'), processGroup: Pid, cgroup: CgroupPath }),
  Body({ ...cleanupBase, proof: AnyOf('boot_changed'), processGroup: Opt(Nullable(Pid)), currentBootId: Text }),
]);
const CommandItems = List(Body({ name: Text, ok: Type.Boolean(), detail: Type.String() }));
/** contracts §4.1 근거 고정: 단계별로 해당하는 값만 보낸다. */
const headProof = {
  qaHeadSha:c.Sha,headSha:c.Sha,preserved:Type.Boolean(),
  parents:List(c.Sha,{ minItems:2,maxItems:2 }),
  autoMergeTreeSha:c.Sha,headTreeSha:c.Sha,additionalChanges:Type.Boolean(),
};
const ciShas = {
  baseSha: Opt(c.Sha),
  headSha: Opt(c.Sha),
  mergeSha: Opt(c.Sha),
  treeSha: Opt(c.Sha),
  pipelineSha: Opt(c.Sha),
};

/** 시작 때 pipelineSha·trigger는 필수다. ci_runs에 기본값 없이 저장되는 근거다(M1-01 통합). */
const ciStart = {
  taskKey: Opt(c.TaskKey),
  attemptId: Opt(c.Id),
  ref: Text,
  pr: Opt(c.PositiveInt4),
  /** pr의 head 브랜치 이름. ① 보고에서는 ref(시도 브랜치)와 같아야 한다(조정자 결정 1). pr과 함께 보낸다. */
  prHead: Opt(Text),
  trigger: Text,
  ...ciShas,
  pipelineSha: c.Sha,
};

/** QA 결과(contracts §3.1). 검사한 커밋·명세 버전이 없으면 근거로 쓸 수 없다. */
const VerificationReport = Body({
  headSha: c.Sha,
  specRevision: c.Int4Count,
  result: c.PassFail,
  cmd: Text,
  expected: Text,
  actual: Text,
  defects: List(Body({ text: Text, blocking: Type.Boolean() })),
  checklist: List(Body({ itemKey: c.Id, done: Type.Boolean(), evidence: Opt(c.Id), note: Opt(Type.String()) })),
});
const resultCommon = {
  fence,
  summary: Type.String(),
  changedFiles: List(c.RepoPath),
  /** 먼저 올린 Evidence의 id */
  evidence: List(c.Id),
  failure: Opt(Type.String()),
  tokens: Opt(c.Count),
  /**
   * 개발·재작업 시도가 push한 agent 브랜치의 PR 번호와 그 PR의 head 브랜치 이름(M5·M7 통합 조정자 결정 1).
   * 서버는 prHead가 이 시도의 브랜치와 같을 때만 받는다. 둘은 함께 보낸다.
   */
  pr: Opt(c.PositiveInt4),
  prHead: Opt(Text),
};
/** 시도 종류와 본문 형식의 일치는 서버가 저장된 kind로 판정한다. */
export const AttemptResult = Type.Union([
  Body(resultCommon),
  Body({ ...resultCommon, verification: VerificationReport }),
]);

/* ---- job ---- */
const commit = c.Sha;
export const JOB_KINDS = [
  'repo_check', 'bootstrap', 'input_diff', 'planning', 'estimate', 'split', 'attempt', 'stop_attempt',
  'integrate', 'deploy_check', 'ci_retry', 'design_apply', 'merge_followup', 'github_check',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
const JobKindSchema = AnyOf(...JOB_KINDS);
const lease = { id: c.Id, leaseUntil: c.Timestamp, fence };
const Job = <const K extends JobKind, P extends Record<string, Parameters<typeof Opt>[0]>>(kind: K, payload: P) =>
  Type.Object({ ...lease, kind: AnyOf(kind), payload: Type.Object(payload) });
/** workType은 분할 상속을 정하는 별도 정보다. content와 subjectHash의 JudgedContent 정의에는 넣지 않는다. */
const JudgedTasks = List(
  // 생략은 이전 서버 작업의 최초 등급(null)이다. 새 추정 작업은 Task마다 발행 시점 번호를 담는다.
  Type.Object({ taskKey: c.TaskKey, workType: c.WorkType, subjectHash: c.Sha256, content: m.JudgedContent, gradeChange: Opt(Nullable(c.Uuid)) }),
);
/**
 * 판단할 CP의 snapshot. 내용과 hash는 같은 시점의 값이며 Runner는 이것만으로 판단한다.
 * subjectHash는 after의 hash, splitSubjectHash는 ops와 splitTasks(대상 Task의 현재 내용)의 hash다.
 */
const judgedProposal = <T extends typeof m.JudgedProposalOp | typeof m.JudgedSplitProposalOp>(op: T) => ({
  id: c.Id,
  // 판단 기록을 뺀 변경
  ops: List(op, { minItems: 1 }),
  targets: List(
    Type.Union([
      Type.Object({ target: c.TaskKey, subjectHash: c.Sha256, before: m.JudgedContent, after: m.JudgedContent }),
      Type.Object({ target: m.NewTaskRef, subjectHash: c.Sha256, before: Type.Null(), after: m.JudgedContent }),
    ]),
  ),
});
const JudgedProposal = Type.Union([
  Type.Object({ ...judgedProposal(m.JudgedProposalOp), splitSubjectHash: Type.Null(), splitTasks: Type.Null() }),
  Type.Object({
    ...judgedProposal(m.JudgedSplitProposalOp),
    splitSubjectHash: c.Sha256,
    splitTasks: List(Type.Object({ taskKey: c.TaskKey, content: m.JudgedContent }), { minItems: 1 }),
  }),
]);
const planningRun = { planningJobId: c.Id, runNo: c.PositiveInt4, version: c.PositiveInt4 };
const tech = {
  techDecisionVersion: c.Sha256,
  techDecisions: List(Type.Object({
    id: c.Id, tdKey: Type.String(), title: Type.String(), status: m.Decision.properties.status, authority: m.Decision.properties.authority,
    updatedAt: c.Timestamp, content: c.Json,
  })),
};
const WbsSnapshot = Type.Object({
  phases: List(Type.Object({ id: c.Id, wps: List(Type.Object({ id: c.Id, tasks: List(c.TaskKey) })) })),
  tasks: List(Type.Object({ taskKey: c.TaskKey, workType: c.WorkType, wp: c.Id, status: c.TaskStatus, subjectHash: c.Sha256, content: m.JudgedContent })),
  dependencies: List(Type.Object({ pred: c.TaskKey, succ: c.TaskKey, type: c.DepType })),
});
export const ClaimedJob = Type.Union(
  [
    Job('repo_check', { repoCheckId: c.Id, url: c.RepoUrl }),
    Job('github_check', { mode: c.GithubMode }),
    Job('bootstrap', {
      ...planningRun, ...tech, commit, previousCommit: Nullable(commit), instruction: Type.String(), resumeStep: Nullable(Type.String()),
      techConstraints: List(Type.Object({ id: c.Id, name: Text, level: AnyOf('must', 'ban', 'cond'), condition: Nullable(Type.String()) })),
      subagentDefs: List(Type.Object({ id: c.Id, defKey: Text, version: c.PositiveInt4, agent: c.Agent, role: Text })),
    }),
    Job('input_diff', {
      ...planningRun,
      wbs: WbsSnapshot,
      commit,
      previousCommit: commit,
      instruction: Type.String(),
      resumeStep: Nullable(Type.String()),
    }),
    Job('planning', {
      tasks: JudgedTasks,
      policy: c.Json,
      proposal: JudgedProposal,
      planning: Type.Null(),
    }),
    Job('planning', {
      tasks: JudgedTasks,
      policy: c.Json,
      proposal: Type.Null(),
      planning: Type.Object({ id: c.Id, title: Text, scope: Type.String() }),
    }),
    // 기존 Task 재판단은 CP·세션 없이 대상 Task가 있어야 한다.
    Job('planning', {
      tasks: Type.Array(JudgedTasks.items, { minItems: 1 }),
      policy: c.Json,
      proposal: Type.Null(),
      planning: Type.Null(),
    }),
    // 재판단(M2-08)도 같은 모양이고, 이유·대상 역할은 policy.rejudge에 싣는다.
    Job('estimate', { tasks: JudgedTasks, policy: m.EstimatePolicy }),
    Job('split', { tasks: JudgedTasks, policy: c.Json, wbs: WbsSnapshot }),
    Job('attempt', {
      taskKey: c.TaskKey,
      kind: c.AttemptKind,
      agent: c.Agent,
      branch: Text,
      baseCommit: commit,
      inputVersion: c.PositiveInt4,
      instructions: c.Json,
    }),
    Job('stop_attempt', { attemptId: c.Id, reason: Type.String() }),
    Job('integrate', { pr: c.PositiveInt4, commit }),
    Job('deploy_check', { commit }),
    Job('ci_retry', { runId: c.Id, pr: Nullable(c.PositiveInt4), commit }),
    Job('design_apply', { itemKey: Text, driftId: c.Id }),
    Job('merge_followup', { pr: c.PositiveInt4 }),
  ],
  { title: 'ClaimedJob' },
);

export const runnerOperations = [
  operation({
    ...runner,
    id: 'heartbeat',
    method: 'POST',
    path: '/api/runner/heartbeat',
    summary: '생존 보고(60초 주기)',
    body: Body({ runnerId: Text, version: Text, epoch: c.Epoch }),
    responses: { 204: null },
    responseHeaders: ['X-Current-Epoch'],
    idempotency: 'none',
    staleEpoch: true,
  }),
  operation({
    ...runner,
    id: 'reportSession',
    method: 'POST',
    path: '/api/runner/sessions',
    summary: '세션 시작·종료 보고(가동률 근거). 열린 세션이 없는 stop은 409',
    errors: ['INVALID_TRANSITION'],
    body: Body({
      runnerId: Text,
      event: AnyOf('start', 'stop'),
      at: c.Timestamp,
      // unknown은 heartbeat 누락 때 서버만 기록한다.
      reason: Opt(AnyOf('reboot', 'power_off', 'error', 'manual')),
    }),
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'reportHost',
    method: 'POST',
    path: '/api/runner/host',
    summary: '실행 PC 사양 보고',
    body: Body({
      hostId: Text,
      // 재부팅 판정의 기준값(보유 해제 증거와 대조)
      bootId: Text,
      cpu: Type.String(),
      cores: c.PositiveInt4,
      memGB: Type.Number({ exclusiveMinimum: 0 }),
      swapGB: Type.Number({ minimum: 0 }),
      diskFreeGB: Type.Number({ minimum: 0 }),
      os: Type.String(),
      perSessionGB: Opt(Type.Number({ exclusiveMinimum: 0 })),
      samples: Opt(c.Int4Count),
    }),
    responses: {
      200: Type.Object({
        mode: AnyOf('auto', 'manual'),
        caps: Type.Object(m.Caps),
        recommended: Type.Object(m.Caps),
        hostChanged: Type.Boolean(),
      }),
    },
  }),
  operation({
    ...runner,
    id: 'reportReadiness',
    method: 'POST',
    path: '/api/runner/readiness',
    summary: '실행 환경 준비 상태 보고',
    body: Body({
      at: c.Timestamp,
      items: List(
        Body({
          key: c.ReadinessKey,
          status: c.ReadinessStatus,
          detail: Type.String(),
          fix: Opt(Type.String()),
        }),
      ),
      // 관측 등급은 CLI×버전×모델×옵션 조합으로 서버가 판정한다(G§6.7).
      cli: Opt(List(Body({ agent: c.Agent, version: Text, model: Text, options: Text }))),
    }),
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'reportModels',
    method: 'POST',
    path: '/api/runner/models',
    summary: '사용 가능 모델·Effort 보고(신규는 미허용, 순서는 서버 설정)',
    body: Body({
      agent: c.Agent,
      models: List(
        Body({
          id: Text,
          label: Text,
          // rank는 보내지 않는다. 모델 순서는 서버 설정값이다(owner 2026-11-26 아이템 8, contracts §3.1).
          // 그 모델이 지원하는 CLI 값(낮은 순). 확인하지 못했으면 null. 공통 단계 매핑은 서버의 승인표가 정한다(Q-06).
          efforts: Nullable(List(Text, { minItems: 1, uniqueItems: true })),
        }),
        { minItems: 1 },
      ),
    }),
    responses: { 200: Type.Object({ newModels: List(Type.String()) }) },
  }),
  operation({
    ...runner,
    id: 'reportUsage',
    method: 'POST',
    path: '/api/runner/usage',
    summary: '남은 사용량·리셋 시각 보고',
    body: Body({ agent: c.Agent, remainPct: c.Pct, resetAt: Opt(c.Timestamp), tokensUsed: Opt(c.Count) }),
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'reportConcurrency',
    method: 'POST',
    path: '/api/runner/concurrency',
    summary: '동시 실행 상태·한도 조절 보고',
    body: Body({
      at: c.Timestamp,
      limit: c.Int4Count,
      running: Body({ Claude: c.Int4Count, Codex: c.Int4Count }),
      subagents: c.Count,
      heavyJobs: c.Int4Count,
      resources: Body({
        cpuPct: Type.Number({ minimum: 0 }),
        memFreeGB: Type.Number({ minimum: 0 }),
        swapGB: Type.Number({ minimum: 0 }),
      }),
      sessions: List(Session),
      adjust: Opt(Body({ from: c.Int4Count, to: c.Int4Count, reason: Text })),
    }),
    responses: {
      200: Type.Object({ caps: Type.Object({ ...m.Caps, memReserveGB: Type.Number({ minimum: 0 }) }) }),
    },
    errors: ['LIMIT_EXCEEDS_CAP'],
  }),
  operation({
    ...runner,
    id: 'getRunGrade',
    method: 'GET',
    path: '/api/runner/tasks/:taskKey/run-grade',
    summary: '실행 직전 등급 조회(등급 정책의 단일 출처)',
    query: Type.Object({ role: c.RunRole }),
    // claim 뒤 허용이 해제되어 재판단 전인 경우(D-29)
    errors: ['CLAIM_REJECTED'],
    responses: {
      200: Type.Object({
        model: Type.String(),
        effort: Type.String(),
        adjust: Nullable(m.GradeAdjust),
        locked: Type.Boolean(),
        floorEffort: Type.String(),
        allowedModels: List(Type.String()),
        policy: Type.Object(m.ExecPolicy),
      }),
    },
  }),
  operation({
    ...runner,
    id: 'getTaskSubagents',
    method: 'GET',
    path: '/api/runner/tasks/:taskKey/subagents',
    summary: '실행 직전 설치할 하위 Agent 정의(모델·effort 없음)',
    query: Type.Object({ role: c.RunRole }),
    responses: {
      200: Type.Object({
        enabled: Type.Boolean(),
        items: List(
          Type.Object({
            id: c.Id,
            key: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
            agent: c.Agent,
            version: c.Int4Count,
            // owner M5-02: file 내용의 UTF-8 바이트를 SHA-256(hex)으로 계산한다.
            hash: Type.String(),
            file: Type.String(),
            sandbox: Type.String(),
          }),
        ),
      }),
    },
  }),
  operation({
    ...runner,
    id: 'pollMessages',
    method: 'GET',
    path: '/api/runner/messages',
    summary: '대기 메시지 조회. cursor 우선, since는 호환용',
    query: Type.Object({ cursor: Opt(Text), since: Opt(c.Timestamp) }),
    responses: {
      200: Type.Object({
        messages: List(
          Type.Object({
            id: c.Id,
            taskKey: c.TaskKey,
            attemptId: Nullable(c.Id),
            toAgent: c.Agent,
            type: m.MessageType,
            body: Type.String(),
            pendingNext: Type.Boolean(),
            createdAt: c.Timestamp,
          }),
        ),
        nextCursor: Nullable(Type.String()),
      }),
    },
  }),
  operation({
    ...runner,
    id: 'ackMessage',
    method: 'POST',
    path: '/api/runner/messages/:messageId/ack',
    summary: '수신 확인(작업 완료 보고와 별개)',
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'respondMessage',
    method: 'POST',
    path: '/api/runner/messages/:messageId/response',
    summary: 'Agent 응답(전달 상태와 별개)',
    body: Body({ text: Text, workState: Text }),
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'reportAttemptStatus',
    method: 'POST',
    path: '/api/runner/attempts/:attemptId/status',
    summary: '실행 상태 + 실제 모델·Effort·조정 사유',
    body: Body({
      fence,
      status: AnyOf('running', 'succeeded', 'failed'),
      at: c.Timestamp,
      model: Text,
      effort: Text,
      adjust: Opt(m.GradeAdjust),
      // 실제 사용 여부는 사후 확정(subagent-usage, D-12)
      subagents: Opt(List(Body({ id: c.Id, version: c.Int4Count, installed: Type.Boolean() }))),
    }),
    responses: { 204: null },
    errors: ['ATTEMPT_CLOSED'],
  }),
  operation({
    ...runner,
    id: 'interruptAttempt',
    method: 'POST',
    path: '/api/runner/attempts/:attemptId/interrupt',
    summary: '실행 중단 보고 → Task paused',
    body: Body({
      fence,
      reason: AnyOf('reboot', 'power_off', 'usage_limit', 'error'),
      at: c.Timestamp,
      progressNote: Opt(Type.String()),
      tokensUsed: Opt(c.Count),
    }),
    responses: { 200: Type.Object({ taskStatus: AnyOf('paused') }) },
    errors: ['ATTEMPT_CLOSED'],
  }),
  operation({
    ...runner,
    id: 'reportAttemptResult',
    method: 'POST',
    path: '/api/runner/attempts/:attemptId/result',
    summary: '결과 보고. qa·reverify는 verification 필수',
    body: AttemptResult,
    responses: { 201: null },
    errors: ['ATTEMPT_CLOSED', 'INVALID_TRANSITION', 'LEASE_LOST'],
  }),
  operation({
    ...runner,
    id: 'uploadEvidence',
    method: 'POST',
    path: '/api/runner/attempts/:attemptId/evidence',
    summary: 'Evidence 1파일 업로드(결과 보고 전). sha256·크기 검증',
    multipart: true,
    body: Body({
      file: Type.Unsafe<unknown>({ contentMediaType: 'application/octet-stream' }),
      kind: Text,
      sha256: c.Sha256,
      size: c.Count,
      fence,
    }),
    responses: { 201: Type.Object({ id: c.Id }) },
    errors: ['ATTEMPT_CLOSED'],
  }),
  operation({
    ...runner,
    id: 'reportSubagentUsage',
    method: 'POST',
    path: '/api/runner/attempts/:attemptId/subagent-usage',
    summary: '실제 사용한 하위 Agent 사후 확정. job이 끝났어도 그 job의 마지막 fence면 받음',
    /*
     * items 한 항목 = CLI가 부른 하위 Agent 이름 하나(UAT-TASK-10 「실제」 태그).
     * - id: 설치한 우리 정의면 그 정의의 id(getTaskSubagents items[].id) 또는 key. 아니면 CLI가 적은 이름 그대로(예: Explore).
     * - version·hash: 설치한 우리 정의일 때 그 값. 모르면 null. 설치 기록과 다르면 400.
     * - count: 부른 횟수(화면 「×n」). 생략하면 1. 옛 Runner는 이 필드를 보내지 않는다(호환).
     * 같은 시도에 다시 보내면 이름마다 합친다: 이름은 늘기만 한다. 확인 보고에 든 이름만 confirmed가 되고(횟수는 확인 값),
     * 확인된 이름은 뒤의 partial 보고로 바뀌지 않는다. 일부 관측 이름의 횟수는 큰 값. 재작업률 통계는 확인된 사용만 센다.
     */
    body: Body({
      fence,
      confirm: AnyOf('confirmed', 'partial'),
      // 이름은 공백만이거나 NUL이 든 값을 받지 않는다(DB 이름 제약·PostgreSQL text와 같은 경계, 리뷰 Codex 4 — 500 대신 400).
      items: List(Body({ id: SubagentName, version: Nullable(c.Int4Count), hash: Nullable(Text), count: Opt(c.PositiveInt4) })),
    }),
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'reportInputChanges',
    method: 'POST',
    path: '/api/runner/input-changes',
    summary: '입력 변경 보고(비교 후 갱신). base가 서버의 입력 head와 다르면 409와 현재 head',
    /*
     * 입력 변경의 정답은 커밋 목록이 아니라 base와 head의 prototype/ 트리 차이다(M2-03 입력 원장).
     * Runner는 base·head를 먼저 SHA로 고정하고, 전체 이력이 있는 같은 저장소에서 아래를 계산한다.
     * - base: 서버가 마지막으로 받은 입력 head(처음에는 등록 커밋). 200·409 응답의 head로 갱신한다.
     * - head: 이번에 본 main 끝 커밋. 서버는 차이가 비어도 head를 이 값으로 옮긴다.
     * - baseIsAncestor: `git merge-base --is-ancestor <base> <head>`의 종료 코드(0=true, 1=false, 그 밖은 보고 중단).
     *   **신뢰 전제**: 서버는 git을 직접 보지 않으므로 이 값과 changes·treeHash는 Runner 관측을 믿는다.
     *   false면 이력 재작성으로 보고 아무것도 받지 않으며 팀장에게 경고한다(alerts key=input_history_rewritten).
     *   Runner는 같은 epoch에서 같은 base로 다시 보내지 않고 멈춘다. 정책 inputRecheck가 바뀌면(팀장 복구 확인) 다시 관측한다.
     *   서버는 유효한 보고(base=입력 head, baseIsAncestor=true)를 받아들이는 같은 트랜잭션에서 열린 재작성 경고를 해소한다.
     *   0·1 밖의 종료 코드(판정 불가)는 보고하지 않는다. epoch가 바뀌면(초기화) Runner는 이전 보고 상태를 버린다.
     * - treeHash: `git rev-parse <head>:prototype`(모드를 포함한 head의 prototype/ 트리 SHA). 차이가 비었는지와 트리가 바뀌었는지의 대조에 쓴다.
     * - changes: `git diff --raw -M --numstat <base> <head> -- prototype/` 결과. 비어 있지 않을 때만 입력 변경 항목이 생긴다.
     * - commits: 참고 정보(화면 표시용). `git rev-list --first-parent --reverse <base>..<head> -- prototype/`. 판정에 쓰지 않는다.
     */
    body: Body({
      base: c.Sha,
      head: c.Sha,
      baseIsAncestor: Type.Boolean(),
      treeHash: c.Sha,
      changes: List(InputDiff),
      commits: List(PushedCommit),
      // 입력 head와 같은 main 커밋에서 별도로 읽은 정의. CI 실행 보고로 대신하지 않는다.
      pipelineObservation: Opt(Body({ baseSha: c.Sha, pipelineSha: Nullable(c.Sha), definition: m.Pipeline })),
    }),
    responses: { 200: Type.Object({ head: c.Sha, recorded: Type.Boolean(), historyRewritten: Type.Boolean() }) },
    errors: ['INVALID_TRANSITION', 'VERSION_CONFLICT'],
  }),
  operation({
    ...runner,
    id: 'reportRepoCheck',
    method: 'POST',
    path: '/api/runner/repo-checks/:id/result',
    summary: '저장소 접근·private·main 커밋·필수 구조',
    body: Body({
      fence,
      access: Type.Boolean(),
      private: Nullable(Type.Boolean()),
      commit: Nullable(c.Sha),
      structure: Nullable(m.RepoStructure),
      error: Opt(Text),
    }),
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'reportBootstrapProgress',
    method: 'POST',
    path: '/api/runner/bootstrap/:jobId/progress',
    summary: '초기 분석·차이 분석 단계 진행',
    body: Body({ fence, stepKey: m.JobStepKey, status: c.StepStatus, at: c.Timestamp, note: Opt(Type.String()) }),
    responses: { 204: null },
    errors: ['INVALID_TRANSITION', 'EXTERNAL_WRITE_BLOCKED'],
  }),
  operation({
    ...runner,
    id: 'getCiJob',
    method: 'GET',
    path: '/api/runner/ci/jobs/:id',
    summary: '예약한 CI job의 검증 근거와 재실행 원본 조회',
    query: Body({ fence }),
    responses: { 200: Body({
      runnable:Type.Boolean(),taskKey:Nullable(c.TaskKey),branch:Nullable(Type.String()),
      hold:Nullable(Body({ hostId:Type.String(),bootId:Nullable(Type.String()),processGroup:Nullable(c.PositiveInt4),slotState:AnyOf('none','reserved','active','unconfirmed') })),
      verification:Nullable(Body({ passed:Type.Boolean(),headSha:c.Sha,specRevision:c.Count })),
      source:Nullable(Body({ stage:c.CiStage,ref:Type.String(),pr:Nullable(c.PositiveInt4),baseSha:Nullable(c.Sha),headSha:c.Sha,pipelineSha:c.Sha })),
    }) },
    errors:['INVALID_TRANSITION','EXTERNAL_WRITE_BLOCKED'],
  }),
  operation({
    ...runner,
    id: 'getDesignApplyJob',
    method: 'GET',
    path: '/api/runner/design/jobs/:id',
    summary: '현재 임대의 계약 반영 대상. 추출을 확인한 원본 커밋·파일·목표만 조회',
    query: Body({ fence }),
    responses: { 200: Body({ sourceCommit: c.Sha, path: c.RepoPath, target: DesignShape }) },
    errors: ['LEASE_LOST', 'VERSION_CONFLICT', 'INVALID_TRANSITION', 'EXTERNAL_WRITE_BLOCKED'],
  }),
  operation({
    ...runner,
    id: 'startCiRun',
    method: 'POST',
    path: '/api/runner/ci/runs',
    summary: '빌드·통합 실행 시작',
    // 야간 점검만 Runner가 정책 시각에 job 없이 시작한다(contracts §3.2-5).
    body: Type.Union([
      Body({ ...c.JobContext, stage: c.CiStage, ...ciStart }),
      Body({ stage: AnyOf('night'), ...ciStart }),
    ]),
    responses: { 201: Type.Object({ id: c.Id, runKey: Type.String() }) },
  }),
  operation({
    ...runner,
    id: 'updateCiRun',
    method: 'PATCH',
    path: '/api/runner/ci/runs/:id',
    summary: '단계 진행·결과(로그 원문은 Runner PC). fence는 시작 때 저장한 job과 대조하고, job 없는 야간 점검만 null',
    body: Type.Object(
      {
        fence: Nullable(fence),
        steps: Opt(List(m.CiStep)),
        status: Opt(c.CiStatus),
        failScope: Opt(AnyOf('baseline', 'task')),
        causeCandidates:Opt(List(Body({ commit:c.Sha }),{ uniqueItems:true })),
        note:Opt(Type.String()),
        finishedAt:Opt(c.Timestamp),
        e2e:Opt(m.CiE2e),
        githubStatus:Opt(m.CiGithubStatus),
        flakyTests:Opt(List(Body({ testKey:Text,rate:Type.Number({ minimum:0,maximum:1 }),lastFailedAt:c.Timestamp }))),
        // ④ 실패 뒤 마지막 정상 커밋 복구 결과(M7-03 결정 7·11). none=복구할 직전 통과 배포 없음(commit null). fail·none이면 서버가 서비스 없음 경보를 만든다.
        deployRestore:Opt(Body({ commit:Nullable(c.Sha),status:AnyOf('pass','fail','none') })),
        logExcerpt: Opt(Type.String()),
        artifacts: Opt(List(Type.String())),
        url: Opt(c.HttpUrl),
        ...ciShas,
      },
      { additionalProperties: false, minProperties: 2 },
    ),
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'reportMergeQueue',
    method: 'POST',
    path: '/api/runner/ci/queue',
    summary: '병합 상태(PR·병합 커밋) 보고 → 서버가 완료 판정',
    body: Body({
      ...c.JobContext,
      pr: c.PositiveInt4,
      taskKey: c.TaskKey,
      status: c.QueueStatus,
      qaHeadSha: Opt(c.Sha),
      syncedHeadSha: Opt(c.Sha),
      baseSha: Opt(c.Sha),
      ciRunId: Opt(c.Id),
      testedTreeSha: Opt(c.Sha),
      actualMergeSha: Opt(c.Sha),
      actualTreeSha: Opt(c.Sha),
      mergedAt:Opt(c.Timestamp),
      // H→H′의 자동 병합 보존과 실제 PR 병합 부모를 서버의 저장 근거와 대조한다.
      headSync: Opt(Body({
        ...headProof,
        chain:Opt(List(Body(headProof),{ minItems:2 })),
      })),
      mergeParents: Opt(List(c.Sha, { minItems: 2, maxItems: 2 })),
      // main에 이미 있는 커밋은 제외한다. Task 연결은 서버가 이 부모 사슬로 계산한다.
      mergeCommits: Opt(List(Body({ commit:c.Sha,parents:List(c.Sha,{ uniqueItems:true }) }))),
    }),
    responses: { 204: null },
    errors: ['INVALID_TRANSITION', 'GATE_NOT_PASSED', 'EXTERNAL_WRITE_BLOCKED', 'MERGE_MISMATCH'],
  }),
  operation({
    ...runner,
    id: 'reportDesignSnapshot',
    method: 'POST',
    path: '/api/runner/design/snapshot',
    summary: '커밋 기준 계약 파일 해석·대조 결과',
    body: DesignSnapshot,
    responses: { 204: null },
    errors: ['VERSION_CONFLICT', 'INVALID_TRANSITION', 'EXTERNAL_WRITE_BLOCKED'],
  }),
  operation({
    ...runner,
    id: 'reportGithubStatus',
    method: 'POST',
    path: '/api/runner/github/status',
    summary: 'GitHub 인증 방식·계정·권한 3상태·만료(비밀값 없음). 첫 쓰기 403이면 missing으로 다시 보고',
    // ok는 인증되고 missing이 없을 때만 true, unverified가 있으면 warning 필수(입력 규칙)
    inputRules: ['githubStatusConsistent'],
    body: Body({
      mode: c.GithubMode,
      jobId: Opt(c.Id),
      fence: Opt(fence),
      ok: Type.Boolean(),
      account: Nullable(Text),
      scopes: Nullable(Body(c.GithubScopes.properties)),
      expiresAt: Nullable(c.Timestamp),
      warning: Opt(Text),
      error: Opt(Text),
    }),
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'registerGithubKey',
    method: 'POST',
    path: '/api/runner/github/key',
    summary: '봉인용 Runner 공개키 등록(프로세스 시작마다). keyId는 서버가 공개키 SHA-256 지문으로 계산',
    body: Body({
      runnerId: Text,
      hostId: Text,
      bootId: Text,
      // X25519 SubjectPublicKeyInfo PEM(contracts §6.1)
      publicKeyPem: Text,
      sealedVersion: Type.Literal(1),
    }),
    responses: { 200: Type.Object({ keyId: Type.String() }) },
  }),
  operation({
    ...runner,
    id: 'getGithubCredential',
    method: 'GET',
    path: '/api/runner/github/credential',
    summary: '토큰 방식: 그 Runner에 등록된 keyId의 공개키로 봉인한 값(평문 없음, 봉인 형식 v1). 모르는 keyId는 404',
    query: Type.Object({ keyId: Text }),
    errors: ['NOT_FOUND'],
    responses: { 200: Type.Object({ sealed: Type.String() }) },
  }),
  operation({
    ...runner,
    id: 'getRunnerPolicy',
    method: 'GET',
    path: '/api/runner/policy',
    summary: '상한·예산·주기·CI 설정·Claude 모델 목록·CLI 관측 등급 묶음',
    ifNoneMatch: true,
    responseHeaders: ['ETag'],
    responses: {
      200: Type.Object({
        caps: Type.Object({ ...m.Caps, memReserveGB: Type.Number({ minimum: 0 }) }),
        subagentBudget: m.SubagentBudget,
        heartbeatSeconds: c.PositiveInt4,
        inputCheckMinutes: c.PositiveInt4,
        // 입력 확인 다시 시도 번호(열린 재작성 경고에서 팀장이 복구 확인을 누를 때마다 1 증가, 열린 경고가 없으면 0).
        // Runner는 이력 재작성으로 입력 보고를 멈춘 뒤 이 값이 바뀌면 다시 관측해 보고한다(POST /api/project/inputs/recheck).
        inputRecheck: c.Count,
        // 서버 후속 2: 일반 「지금 확인」 번호. 이력 재작성 복구 번호와 분리해 경고 해소 때 새 요청이 사라지지 않게 한다.
        inputCheckRequest: Opt(c.Count),
        readinessCheckRequest: Opt(c.Count),
        githubMode: Opt(c.GithubMode),
        ci: Type.Object({ ...m.CiSettings,quarantined:List(Text,{ uniqueItems:true }) }),
        // Runner가 보고할 Claude 모델(설정값, 초기값=Q-06 승인표). owner 2026-11-26 아이템 8
        claudeModels: List(Type.String(), { minItems: 1, uniqueItems: true }),
        // 서버에 등록된 CLI 조합별 관측 등급(G§6.7-8). Runner 준비 점검 obs가 실행 조합과 대조한다.
        cliGrades: List(
          Type.Object({ agent: c.Agent, version: Type.String(), model: Type.String(), options: Type.String(), grade: m.ObservationGrade }),
        ),
        // collect-prepare: 끝난 Task(done·cancelled)의 시도 브랜치 중 열린 실행 보유가 없는 것(최근 끝난 것부터 최대 500개).
        // Runner는 이 브랜치의 개발·검증 작업 폴더를 지운다(병합 뒤 정리와 같은 함수). 취소된 Task를 Runner가 알 수 있는 유일한 길이다.
        closedBranches: Opt(List(Text, { maxItems: 500, uniqueItems: true })),
      }),
      304: null,
    },
  }),

  /* ---- 명령·작업(contracts §3.2) ---- */
  operation({
    ...runner,
    id: 'getExecutionHolds',
    method: 'GET',
    path: '/api/runner/holds',
    summary: '현재 Runner principal·epoch의 미해제 실행 보유. 읽기 전용 재시작 대조',
    responses: { 200: Type.Object({ holds: List(m.ExecutionHold) }) },
  }),
  operation({
    ...runner,
    id: 'getCommands',
    method: 'GET',
    path: '/api/runner/commands',
    summary: '정리 명령(다른 작업보다 먼저)',
    staleEpoch: true,
    responses: {
      200: Type.Object({
        currentEpoch: c.Epoch,
        commands: List(
          Type.Object({ id: c.Id, kind: AnyOf('reset-cleanup'), epoch: c.Epoch,
            payload: Type.Object({ holds: Opt(List(m.ExecutionHold)) }, { additionalProperties: true }) }),
        ),
      }),
    },
  }),
  operation({
    ...runner,
    id: 'reportCommandResult',
    method: 'POST',
    path: '/api/runner/commands/:id/result',
    summary: '명령 결과. X-Project-Epoch에 commands[].epoch를 그대로 보내며 명령 ID와 일치해야 한다(D-04)',
    staleEpoch: true,
    body: Type.Union([
      Body({ status: AnyOf('done'), items: CommandItems, holds: List(CleanupProof) }),
      Body({ status: AnyOf('failed'), items: CommandItems, holds: Opt(List(CleanupProof)) }),
    ]),
    responses: { 204: null },
    errors: ['EPOCH_MISMATCH'],
  }),
  operation({
    ...runner,
    id: 'claimJob',
    method: 'POST',
    path: '/api/runner/jobs/claim',
    summary: '작업 임대(attempt는 예약만)',
    body: Body({ kinds: List(JobKindSchema, { minItems: 1, uniqueItems: true }), capacity: c.Count }),
    responses: { 200: Type.Object({ job: ClaimedJob }), 204: null },
    errors: ['CLEANUP_PENDING'],
  }),
  operation({
    ...runner,
    id: 'renewJob',
    method: 'POST',
    path: '/api/runner/jobs/:id/renew',
    summary: '임대 연장',
    body: Body({ fence }),
    responses: { 200: Type.Object({ leaseUntil: c.Timestamp }) },
    errors: ['EXTERNAL_WRITE_BLOCKED'],
  }),
  operation({
    ...runner,
    id: 'returnJob',
    method: 'POST',
    path: '/api/runner/jobs/:id/return',
    summary: '시작 전 자원 부족 attempt job을 재대기열에 반환. 시도 없이 잠금·fence 유지',
    body: Body({ fence,hostId:Text,bootId:Text,reason:AnyOf('resources') }),
    responses: { 204:null },
    errors: ['INVALID_TRANSITION','EXTERNAL_WRITE_BLOCKED'],
  }),
  operation({
    ...runner,
    id: 'startJob',
    method: 'POST',
    path: '/api/runner/jobs/:id/start',
    summary: '시작 확정(attempt는 시도 생성·Task 전이). 슬롯은 reserved 유지',
    body: Body({
      fence,
      hostId: Text,
      bootId: Text,
      // attempt·integrate·deploy_check·ci_retry만 필수, 그 외 job은 보내지 않는다(서버가 kind로 판정, 어기면 400).
      headSha: Opt(c.Sha),
      installedSubagents: List(InstalledSubagent),
    }),
    responses: { 200: Type.Object({ attemptId: Opt(c.Id) }) },
    errors: ['CLAIM_REJECTED', 'INVALID_TRANSITION', 'EXTERNAL_WRITE_BLOCKED'],
  }),
  operation({
    ...runner,
    id: 'reportJobProcess',
    method: 'POST',
    path: '/api/runner/jobs/:id/process',
    summary: '프로세스 생성 직후 기록(reserved→active). 같은 pgid 재전송은 성공, 다른 pgid는 INVALID_TRANSITION',
    errors: ['INVALID_TRANSITION'],
    body: Body({ fence, processGroup: Pid, cgroup: Nullable(CgroupPath) }),
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'releaseJobSlots',
    method: 'POST',
    path: '/api/runner/jobs/:id/slots/release',
    summary: '물리 슬롯만 반환(논리 잠금 유지). 서버 보유에 pgid가 있으면 no_process는 INVALID_TRANSITION',
    errors: ['INVALID_TRANSITION'],
    body: Body({ fence, hostId: Text, proof: ReleaseProof, at: c.Timestamp }),
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'acquireJobSlots',
    method: 'POST',
    path: '/api/runner/jobs/:id/slots/acquire',
    summary: 'CLI·① 실행 전 용량 재획득(none→reserved). 그룹은 생성 뒤 /process',
    body: Body({ fence, hostId: Text, agent: Opt(c.Agent) }),
    responses: { 204: null },
    errors: ['CLAIM_REJECTED'],
  }),
  operation({
    ...runner,
    id: 'releaseJob',
    method: 'POST',
    path: '/api/runner/jobs/:id/release',
    summary: '잔여 보유 해제(원래 job·host·boot·group이 맞으면 낡은 fence 허용). 서버 보유에 pgid가 있으면 no_process는 INVALID_TRANSITION',
    errors: ['INVALID_TRANSITION'],
    body: Body({ fence, hostId: Text, proof: ReleaseProof, at: c.Timestamp }),
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'reconcileJob',
    method: 'POST',
    path: '/api/runner/jobs/:id/reconcile',
    summary: '외부 상태 대조 결과(효과 없음/완료됨/부분 적용)',
    body: Body({
      fence,
      evidence: Body({ outcome: AnyOf('none', 'done', 'partial'), checkedAt: c.Timestamp, detail: c.Json }),
    }),
    responses: { 204: null },
  }),
  operation({
    ...runner,
    id: 'finishJob',
    method: 'POST',
    path: '/api/runner/jobs/:id/finish',
    summary: '작업 종료. 설치 실패는 error.code=SUBAGENT_INSTALL_FAILED',
    body: Body({
      fence,
      status: AnyOf('done', 'failed', 'cancelled'),
      result: Opt(c.Json),
      error: Opt(Body({ code: Text, message: Text })),
    }),
    responses: { 204: null },
  }),
];
