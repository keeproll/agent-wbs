import type { ApiClient } from '../api/client.ts';
import type { ClaimedJob } from '../api/generated/client.ts';
import type { InputDiff } from '../git/inputs.ts';
import { createRedactor, type Redact } from '../security/redact.ts';
import { ANALYSIS_ORDER, type AgentName, type PlanningAgent, type PlanningAgents } from './agents.ts';
import type { PlanningCheckpoint, PlanningCheckpoints } from './checkpoint.ts';
import { PlanningReporter, PlanningStopped } from './reporter.ts';

/**
 * 준비 단계가 쓰는 로컬 작업 공간 포트. 실제 구현은 Git 안전 계층(src/git)과 GitHub 어댑터(src/github)를 묶어 연결한다.
 * - fixCommit: GitHub 접근을 확인하고 payload의 커밋이 원격에 있는지 확인한다(check).
 * - checkoutInput: 그 커밋의 `prototype/`만 읽기 전용 사본으로 꺼낸다. 안의 스크립트·설치 명령은 실행하지 않는다(unzip).
 * - prepareWork: 로컬 clone, 없는 `src/`·`contracts/`·`.agentwbs/` 생성 커밋, 기준 커밋 기록(repo). 원격 쓰기가 있는 단계다.
 * - diff: 이전 입력 커밋과 새 커밋의 `prototype/` 차이(diff).
 * 같은 인자로 다시 불러도 결과가 같아야 한다(다시 시도·다른 job에서 반복 호출된다).
 */
export interface PlanningWorkspace {
  fixCommit(commit: string): Promise<{ note: string }>;
  checkoutInput(name: string, commit: string): Promise<{ path: string; note: string }>;
  prepareWork(commit: string): Promise<{ note: string }>;
  diff(previousCommit: string, commit: string): Promise<InputDiff[]>;
}

export interface PlanningContext {
  api: ApiClient;
  epoch: number;
  runnerId: string;
  checkpoints: PlanningCheckpoints;
  workspace: PlanningWorkspace;
  agents: PlanningAgents;
  /** 작성(교차 검토 합의안·초안·CP·분할안·등급)을 맡는 Agent. 기본 Claude(보고서의 결정 참고) */
  author?: AgentName;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /** 이미 아는 비밀값(토큰 등). 실패 메모에서 가린다. */
  secrets?: readonly string[];
  maxAttempts?: number;
}

export type PlanningOutcome =
  | { status: 'done'; result: Record<string, unknown> }
  | { status: 'failed'; error: { code: string; message: string } }
  /** 임대 상실·초기화 번호 변경·인증 거부. job 종료 보고도 받아 주지 않으므로 호출자는 finish를 보내지 않는다. */
  | { status: 'lost'; code: PlanningStopped['code']; message: string };

/** Agent 호출이 실패했다. 어느 Agent의 어떤 질문인지 남긴다. */
export class PlanningAgentFailed extends Error {
  override name = 'PlanningAgentFailed';
  readonly agent: AgentName | 'Runner';
  constructor(agent: AgentName | 'Runner', question: string, message: string) { super(`${agent} ${question}: ${message}`); this.agent = agent; }
}

const MAX_NOTE = 300;

export class JobRun<J extends ClaimedJob = ClaimedJob> {
  readonly reporter: PlanningReporter;
  readonly redact: Redact;
  private readonly clock: () => number;
  readonly job: J;
  readonly ctx: PlanningContext;
  readonly checkpoint: PlanningCheckpoint;

  constructor(job: J, ctx: PlanningContext, checkpoint: PlanningCheckpoint) {
    this.job = job;
    this.ctx = ctx;
    this.checkpoint = checkpoint;
    this.clock = ctx.now ?? Date.now;
    this.redact = createRedactor(ctx.secrets ?? []);
    this.reporter = new PlanningReporter({
      api: ctx.api, epoch: ctx.epoch, runnerId: ctx.runnerId, jobId: job.id, fence: job.fence, scope: `${job.id}@${String(job.fence)}`, checkpoint, now: this.clock,
      ...(ctx.sleep && { sleep: ctx.sleep }), ...(ctx.signal && { signal: ctx.signal }), ...(ctx.maxAttempts && { maxAttempts: ctx.maxAttempts }),
    });
  }

  iso(): string { return new Date(this.clock()).toISOString(); }

  /** 보낸 요청 기록의 범위: 이 job의 이번 임대(fence). reporter와 같은 값이다. */
  get sendScope(): string { return `${this.job.id}@${String(this.job.fence)}`; }

  get author(): PlanningAgent { return this.ctx.agents[this.ctx.author ?? 'Claude']; }

  /** 작성자 한 Agent에게 묻는다. */
  async ask<T>(question: string, call: (agent: PlanningAgent) => Promise<T>): Promise<T> {
    return this.call(this.author, question, call);
  }

  /** 두 Agent에게 각각 묻는다(독립 판단). 순서는 원본 분석 순서(Codex → Claude)이고 서로의 답을 넘기지 않는다. */
  async both<T>(question: string, call: (agent: PlanningAgent) => Promise<T>): Promise<Record<AgentName, T>> {
    const answers = {} as Record<AgentName, T>;
    for (const name of ANALYSIS_ORDER) answers[name] = await this.call(this.ctx.agents[name], question, call);
    return answers;
  }

  async call<T>(agent: PlanningAgent, question: string, call: (agent: PlanningAgent) => Promise<T>): Promise<T> {
    this.ctx.signal?.throwIfAborted();
    try { return await call(agent); }
    catch (error) {
      if (error instanceof PlanningStopped) throw error;
      throw new PlanningAgentFailed(agent.name, question, error instanceof Error ? error.message : String(error));
    }
  }

  /** 단계 메모·오류 메시지. 비밀값을 가리고 길이를 줄인다. */
  note(text: string): string {
    const clean = this.redact(text).replaceAll(/\s+/g, ' ').trim();
    return clean.length > MAX_NOTE ? `${clean.slice(0, MAX_NOTE - 1)}…` : clean;
  }
}
