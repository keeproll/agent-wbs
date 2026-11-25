// Generic vocabulary (Agent, WorkType, DesignKind, ...) stays module-local: schedule and api own same-named exports.
export type {
  AcceptanceCriterion, ImpactNote, ModifyField, NewTask, ProposalDiff, ProposalImpact, ProposalIssue,
  ProposalIssueCode, ProposalOp, ProposalSimulation, ProposalSnapshot, ProposalTask, RemovedDependency,
  SplitException, SplitJudgement, TaskChecklistItem,
} from './types.ts';
export * from './simulate.ts';
