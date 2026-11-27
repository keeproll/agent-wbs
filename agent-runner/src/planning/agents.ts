import type { ApiRequest } from '../api/client.ts';
import type { Agent, Confidence, JudgedContent, PlanningProposalOp, PlanningSplitProposalOp } from '../api/generated/client.ts';
import type { InputDiff } from '../git/inputs.ts';
import type { DecisionSnapshot, SubagentDef, TechConstraint, WbsSnapshot } from './payload.ts';

/*
 * Planning Agent(계획을 세우는 Agent) 포트.
 * 실제 Claude·Codex CLI 연결은 M5-01·M5-02가 만든다. 이 폴더는 「무엇을 어떤 순서로 묻고, 두 답을 어떻게 합치나」만 맡는다.
 * 시험은 손으로 쓴 가짜 Agent를 쓴다(실제 호출 없음).
 *
 * 두 종류의 질문이 있다.
 * - 독립 판단: 두 Agent에게 각각 묻고 Runner가 합친다(analyze·estimate·judgeRules·judgeSplit).
 *   합의 주체(agreedBy)에 둘 다 적어야 하는 기록은 이 경로로만 만든다(data-model §2.3-1).
 * - 작성: 작성자(author) 한 Agent가 쓴다(crossReview·draft·proposeChanges·proposeSplit·planTask).
 *   작성물 안의 판단 기록은 작성자가 적지 않고, 다시 두 Agent의 독립 판단으로 채운다.
 */

export type AgentName = Agent;
/** 원본 초기 분석 순서: Codex 독립 분석 → Claude 독립 분석(G§4.2, P L4489) */
export const ANALYSIS_ORDER = ['Codex', 'Claude'] as const satisfies readonly AgentName[];
export const SPLIT_RULES = ['revert', 'contract', 'refactor'] as const;
export const CP_RULES = ['ac_meaning', 'layer_order', 'test_included'] as const;
export type SplitRule = (typeof SPLIT_RULES)[number];
export type CpRule = (typeof CP_RULES)[number];

export interface Analysis { summary: string; items: string[] }
export interface AnalysisRequest {
  kind: 'bootstrap' | 'input_diff' | 'planning';
  jobId: string;
  instruction: string;
  /** 읽기 전용 입력 사본 경로(prototype/). 세션 분석은 없다. */
  inputPath: string | null;
  commit: string | null;
  previousCommit?: string;
  diff?: InputDiff[];
  scope?: { title: string; scope: string };
  /** 초기 분석: 등록 시점의 기술 제약. 조건부 선호는 constraintId로 판단해 답한다. */
  techConstraints?: TechConstraint[];
  /** 차이 분석: 입력 버전 고정 시점의 현재 WBS */
  wbs?: WbsSnapshot;
  /**
   * 초기 분석: 확정·반려된 기술 결정을 따르라는 지시문(`instructions.ts`의 `decisionGuide`).
   * 기술 결정이 확정된 뒤(재분석·초안)에만 넣는다. 실제 CLI 어댑터는 이 글을 지시문에 그대로 붙인다.
   */
  decisionGuide?: string;
}

type Reviews = ApiRequest<'submitPlanningReviews'>['body']['reviews'];
type Tech = ApiRequest<'submitTechProposals'>['body'];
export interface CrossReviewRequest extends Omit<AnalysisRequest, 'diff'> { analyses: Record<AgentName, Analysis> }
export interface CrossReview {
  /** 합의안 요약. 초안 작성의 입력이자 단계 메모다. */
  summary: string;
  reviews: Reviews;
  /** 초기 분석만: 기술 결정 제안과 조건부 선호 판단(G§4.12) */
  tech?: { decisions: Tech['decisions']; conditionJudgements: NonNullable<Tech['conditionJudgements']> };
}

type DraftBody = Omit<ApiRequest<'submitDraft'>['body'], 'fence'>;
/** 작성자의 초안. 판단 기록은 두 Agent의 독립 판단으로 채우므로 받지 않는다. */
export type DraftContent = Omit<DraftBody, 'tasks'> & { tasks: Omit<DraftBody['tasks'][number], 'judgedRules'>[] };
export interface DraftRequest {
  jobId: string; instruction: string; inputPath: string; commit: string; cross: CrossReview; analyses: Record<AgentName, Analysis>;
  techConstraints: TechConstraint[];
  /** 팀장이 확정한 결정 스냅샷(fixed·approved·rejected 구별). 반려된 제안(rejected의 tdKey)은 사용 기술로 쓰지 않는다. */
  decisions: DecisionSnapshot;
  /** 위 스냅샷을 상태별 규칙과 함께 글로 만든 지시문(`decisionGuide`). 실제 CLI 어댑터는 이 글을 지시문에 그대로 붙인다. */
  decisionGuide: string;
  /** 초안 Task의 하위 Agent는 이 목록의 id만 고른다. */
  subagentDefs: SubagentDef[];
}

type StripJudged<T> = T extends { op: 'add'; t: infer U } ? Omit<T, 't'> & { t: Omit<U, 'judgedRules'> } : T;
export type ProposalOp = StripJudged<PlanningProposalOp>;
export type SplitProposalOp = StripJudged<PlanningSplitProposalOp>;
export interface ProposalContent { title: string; reason: string; ops: ProposalOp[] }
export interface SplitContent { title: string; reason: string; ops: SplitProposalOp[] }
export interface ProposalRequest { jobId: string; instruction: string; inputPath: string; diff: InputDiff[]; analyses: Record<AgentName, Analysis>; wbs: WbsSnapshot }
export interface SplitRequest { jobId: string; task: { taskKey: string; content: JudgedContent }; policy: Record<string, unknown>; wbs: WbsSnapshot }

type Plan = ApiRequest<'submitTaskPlan'>['body'];
export interface TaskPlanRequest { jobId: string; taskKey: string; content: JudgedContent; roles: string[]; policy: Record<string, unknown> }
/** conflictGroup을 생략하면 지금 묶음을 유지한다. null은 묶음 해제다. */
export interface TaskPlan { grades: Plan['grades']; subagents: Plan['subagents']; conflictGroup?: Plan['conflictGroup'] }

export interface EstimateRequest { jobId: string; tasks: { ref: string; content: unknown }[]; policy?: Record<string, unknown> }
export interface EstimateVerdict { ref: string; estHours: number; loHours: number; hiHours: number; tokensK?: number; confidence: Confidence; basis: string }

export interface RulesRequest { jobId: string; rules: readonly SplitRule[]; subjects: { target: string; content: unknown }[] }
export interface RuleVerdict { target: string; rule: SplitRule; result: 'met' | 'not_met'; basis: string }
export interface SplitRulesRequest { jobId: string; rules: readonly CpRule[]; ops: SplitProposalOp[]; splitTasks: { taskKey: string; content: JudgedContent }[] }
export interface SplitVerdict { rule: CpRule; result: 'met' | 'not_met'; basis: string }

export interface PlanningAgent {
  readonly name: AgentName;
  analyze(request: AnalysisRequest): Promise<Analysis>;
  crossReview(request: CrossReviewRequest): Promise<CrossReview>;
  draft(request: DraftRequest): Promise<DraftContent>;
  proposeChanges(request: ProposalRequest): Promise<ProposalContent>;
  proposeSplit(request: SplitRequest): Promise<SplitContent>;
  planTask(request: TaskPlanRequest): Promise<TaskPlan>;
  estimate(request: EstimateRequest): Promise<EstimateVerdict[]>;
  judgeRules(request: RulesRequest): Promise<RuleVerdict[]>;
  judgeSplit(request: SplitRulesRequest): Promise<SplitVerdict[]>;
}

export type PlanningAgents = Record<AgentName, PlanningAgent>;
