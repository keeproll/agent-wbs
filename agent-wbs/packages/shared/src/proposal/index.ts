// Generic vocabulary (Agent, WorkType, DesignKind, ...) stays module-local: schedule and api own same-named exports.
export type {
  AcceptanceCriterion, ImpactNote, JudgedRule, JudgedRules, Judgement, ModifyField, NewTask, ProposalDiff, ProposalImpact, ProposalIssue,
  ProposalIssueCode, ProposalOp, ProposalSimulation, ProposalSnapshot, ProposalTask, RemovedDependency,
  SplitException, SplitJudgementRule, SplitJudgements, TaskChecklistItem,
} from './types.ts';
export * from './simulate.ts';
