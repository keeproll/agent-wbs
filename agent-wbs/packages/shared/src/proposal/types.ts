import type { Dependency, Phase, Task } from '../domain/index.ts';
import type { Agent, Confidence, DesignKind, TechDomain, WorkType } from '../vocabulary.ts';

// Module-local contracts; M1-02/M2-07 adapters translate API and DB rows at the boundary.
export interface AcceptanceCriterion {
  given: string;
  when: string;
  then: string;
  method: string;
}

export interface TaskChecklistItem {
  id: string;
  text: string;
  required: boolean;
  done: boolean;
  method: string;
}

// data-model §2.3-1 (D-33/D-34), same names and shape.
export interface Judgement<R extends string> {
  rule: R;
  result: 'met' | 'not_met';
  agreedBy: readonly Agent[];
  basis: string;
  subjectHash: string;
  judgedAt: string;
  sourceRef: string;
}
export type JudgedRule = 'revert' | 'contract' | 'refactor';
export interface JudgedRules {
  schemaVersion: 1;
  items: readonly Judgement<JudgedRule>[];
}
// change_proposals.task_judgements element: existing Tasks whose content the CP changes.
export interface TaskJudgement {
  taskKey: string;
  judgedRules: JudgedRules | null;
}
export type SplitJudgementRule = 'ac_meaning' | 'layer_order' | 'test_included';
export interface SplitJudgements {
  schemaVersion: 1;
  items: readonly Judgement<SplitJudgementRule>[];
}

export interface SplitException {
  rule: string;
  why: string;
  by: string;
  at: string;
}

interface TaskContent {
  title: string;
  workType: WorkType;
  primaryDomain: TechDomain;
  relatedDomains: readonly TechDomain[];
  priority: number;
  assignee: Agent;
  verifier: Agent;
  purpose: string;
  scope: readonly string[];
  doneCond: string;
  ac: readonly AcceptanceCriterion[];
  files: readonly string[];
  // `items` are the changed design entities; an empty list is only a placeholder section.
  design: readonly { kind: DesignKind; items: readonly string[] }[];
  // A missing estimate stays null: the prototype's 4h default is mock data.
  estimate: { est: number; lo: number | null; hi: number | null; confidence: Confidence } | null;
  conflictGroup: string | null;
  splitBasis: string;
  judgedRules: JudgedRules | null;
}

export interface ProposalTask extends Task, TaskContent {
  checklist: readonly TaskChecklistItem[];
  exceptions: readonly SplitException[];
  hasExecutionHistory: boolean;
}

type RequiredNewTask = Pick<TaskContent, 'title' | 'workType' | 'primaryDomain' | 'priority' | 'assignee' | 'verifier'>;
export type NewTask = RequiredNewTask & Partial<Omit<TaskContent, keyof RequiredNewTask>>;

export type ModifyField = 'priority' | 'title' | 'doneCond' | 'assignee' | 'verifier' | 'scopeAdd' | 'acAdd';

// The simulator's input. The stored/wire `ProposalOp` (prototype keys) is the API schema; see api/adapters.ts.
export type SimulationOp =
  | { op: 'add'; ref: string; workPackageId: string; task: NewTask; preds?: readonly Pick<Dependency, 'pred' | 'type'>[] }
  | { op: 'modify'; task: string; field: ModifyField; after: string | number | AcceptanceCriterion }
  | { op: 'remove'; task: string }
  | { op: 'dep-add'; pred: string; succ: string; type?: Dependency['type'] }
  | { op: 'dep-remove'; pred: string; succ: string };

// Live (not soft-deleted) rows, read in the same transaction that applies the result.
export interface ProposalSnapshot {
  phases: readonly Phase[];
  tasks: readonly ProposalTask[];
  dependencies: readonly Dependency[];
  taskSequence: number;
}

export type ProposalIssueCode =
  | 'EMPTY_PROPOSAL' | 'VALIDATION_FAILED' | 'TASK_NOT_FOUND' | 'WBS_NODE_NOT_FOUND' | 'COMPLETED_TASK'
  | 'CANCELLED_TASK' | 'EXECUTION_HISTORY' | 'ACTIVE_TASK_BLOCKED' | 'ALREADY_APPLIED' | 'DEPENDENCY_SELF' | 'DEPENDENCY_DUPLICATE'
  | 'DEPENDENCY_CYCLE' | 'DEPENDENCY_NOT_FOUND';

export interface ProposalIssue {
  index: number | null;
  code: ProposalIssueCode;
  taskKey?: string;
  message: string;
}

export interface ProposalDiff {
  index: number;
  op: SimulationOp['op'];
  target: string;
  field: string;
  before: unknown;
  after: unknown;
}

export type ImpactNote =
  | { kind: 'created' }
  | { kind: 'modified'; field: ModifyField }
  | { kind: 'cancelled' }
  | { kind: 'dependency-added' | 'dependency-removed' | 'dependency-removed-by-cancel'; pred: string }
  | { kind: 'unblocked' }
  | { kind: 'newly-blocked' }
  | { kind: 'downstream'; via: string };

export interface RemovedDependency extends Dependency {
  reason: 'pred-cancelled' | 'succ-cancelled' | 'dep-remove';
}

export interface ProposalImpact {
  tasks: { taskKey: string; notes: ImpactNote[] }[];
  removedDependencies: RemovedDependency[];
  // Successors that lost a relation to a cancelled Task; actually released only if remainingBlockers is empty (D-27).
  unblockedSuccessors: { taskKey: string; remainingBlockers: (Dependency & { predStatus: Task['status'] | null })[] }[];
}

export interface ProposalSimulation {
  next: ProposalSnapshot;
  idMap: Record<string, string>;
  issues: ProposalIssue[];
  diff: ProposalDiff[];
  impact: ProposalImpact;
}
