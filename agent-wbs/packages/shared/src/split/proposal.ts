import { dependencyMet } from '../domain/index.ts';
import type { Dependency } from '../domain/index.ts';
import { simulateProposal } from '../proposal/index.ts';
import type {
  AcceptanceCriterion, ProposalIssueCode, ProposalOp, ProposalSimulation, ProposalSnapshot, ProposalTask,
  SplitJudgements,
} from '../proposal/index.ts';
import { checkSplit, DEFAULT_SPLIT_SETTINGS, flaggedRules, hasStarted } from './check.ts';
import type { SplitRule, SplitSettings } from './check.ts';
import { proposalJudgementHolds, splitJudgementHolds } from './judgement.ts';
import type { JudgementHold, SubjectHashes } from './judgement.ts';

export type SplitProblemCode = ProposalIssueCode
  | 'ALREADY_STARTED' | 'NOTHING_TO_SPLIT' | 'OUT_OF_SCOPE' | 'ORIGINAL_NOT_CANCELLED' | 'TOO_FEW_PARTS'
  | 'ANALYSIS_REQUIRED' | 'RULE_VIOLATION' | 'ESTIMATE_MISSING' | 'SPLIT_BASIS_MISSING' | 'AC_MISSING'
  | 'AC_NOT_PARTITIONED' | JudgementHold['code'] | 'ORDER_NOT_PRESERVED';

export interface SplitProblem {
  code: SplitProblemCode;
  taskKey: string;
  rule?: JudgementHold['rule'];
  message: string;
}

export interface SplitProposalResult {
  // Any problem rejects the proposal; warnings are shown to the reviewer.
  problems: SplitProblem[];
  warnings: { taskKey: string; message: string }[];
  simulation: ProposalSimulation;
}

// Rules whose remedy is cutting the Task itself (prototype proposeSplit `needSplit`).
const CUT_RULES: readonly SplitRule[] = ['size', 'domain', 'irrev', 'one'];
const acKey = (ac: AcceptanceCriterion) => JSON.stringify([ac.given.trim(), ac.when.trim(), ac.then.trim()]);

/**
 * Whether a path preserves the original relation's start constraint:
 * FS needs an FS first edge (later edges only push the start further); SS is kept by any path.
 */
function preserves(dependencies: readonly Dependency[], from: string, to: string, type: Dependency['type']): boolean {
  const queue = dependencies.filter(dep => dep.pred === from && (type === 'SS' || dep.type === 'FS')).map(dep => dep.succ);
  const seen = new Set(queue);
  for (const id of queue) {
    if (id === to) return true;
    for (const { succ } of dependencies.filter(dep => dep.pred === id)) {
      if (!seen.has(succ)) {
        seen.add(succ);
        queue.push(succ);
      }
    }
  }
  return false;
}

export interface SplitJudgementInput {
  splitJudgements: SplitJudgements | null;
  // Server-computed hash of the ops and the current content of their Tasks.
  splitSubjectHash: string | null;
  taskHashes: SubjectHashes;
}

export function validateSplitProposal(
  base: ProposalSnapshot, targetId: string, ops: readonly ProposalOp[], judgement: SplitJudgementInput,
  settings: SplitSettings = DEFAULT_SPLIT_SETTINGS,
): SplitProposalResult {
  const simulation = simulateProposal(base, ops);
  const problems: SplitProblem[] = [];
  const warnings: SplitProposalResult['warnings'] = [];
  const fail = (code: SplitProblemCode, message: string, taskKey = targetId) => {
    problems.push({ code, taskKey, message });
  };
  const result = { problems, warnings, simulation };
  simulation.issues.forEach(issue => fail(issue.code, issue.message, issue.taskKey));

  const target = base.tasks.find(task => task.id === targetId);
  if (!target) {
    if (!simulation.issues.length) fail('TASK_NOT_FOUND', `${targetId}이(가) 없습니다`);
    return result;
  }
  if (hasStarted(target)) {
    fail('ALREADY_STARTED', '이미 시작된 Task는 나누지 않습니다 — 예외 사유를 기록하거나 남은 일을 후속 Task로 제안합니다');
    return result;
  }
  const checkIn = (snapshot: ProposalSnapshot, task: ProposalTask, hashes: SubjectHashes['after']) => checkSplit(task, snapshot.dependencies
    .filter(dep => dep.succ === task.id)
    .flatMap(dep => snapshot.tasks.find(candidate => candidate.id === dep.pred) ?? []), hashes[task.id] ?? null, settings);
  const original = checkIn(base, target, judgement.taskHashes.before);
  const flagged = flaggedRules(original);
  const mustCut = flagged.some(rule => CUT_RULES.includes(rule)) ||
    original.items.some(item => item.judgement === 'not_met');
  const mustAnalyse = flagged.includes('unknown');
  if (!mustCut && !mustAnalyse) fail('NOTHING_TO_SPLIT', '나눌 위반 · 의심 항목이 없습니다');

  // Add, reconnect and cancel only: a split must not smuggle in edits to unrelated Tasks.
  const refs = new Set(ops.flatMap(op => op.op === 'add' ? [op.ref] : []));
  const own = (ref: string) => ref === targetId || refs.has(ref);
  ops.forEach((op, index) => {
    const inScope = op.op === 'add' || op.op === 'remove' && op.task === targetId ||
      (op.op === 'dep-add' || op.op === 'dep-remove') && (own(op.pred) || own(op.succ));
    if (!inScope) fail('OUT_OF_SCOPE', `항목 ${index + 1} — 신규 Task · 선행 재연결 · 원래 Task 취소만 허용합니다`);
  });

  const { next } = simulation;
  const created = new Set(Object.values(simulation.idMap));
  const added = next.tasks.filter(task => created.has(task.id));
  const parts = added.filter(task => task.workType !== 'Analysis' || target.workType === 'Analysis');
  const cancelled = ops.some(op => op.op === 'remove' && op.task === targetId);

  if (!cancelled && (mustCut || parts.length)) fail('ORIGINAL_NOT_CANCELLED', '나눈 원래 Task를 취소해야 합니다');
  if (cancelled && parts.length < 2) fail('TOO_FEW_PARTS', '원래 Task를 둘 이상으로 나눠야 합니다');
  if (mustAnalyse) {
    // Research counts only where its completion really gates the work, directly or through earlier parts.
    const research = added.filter(task => task.workType === 'Analysis');
    const precedes = (from: ProposalTask, to: ProposalTask) => preserves(next.dependencies, from.id, to.id, 'FS');
    const ready = (cancelled ? parts : [target]).every(task => research.some(item => precedes(item, task)) ||
      // When the original is itself an Analysis, the leading part is the research.
      task.workType === 'Analysis' && task.id !== targetId && parts.some(part => precedes(task, part)));
    if (!research.length || !ready) fail('ANALYSIS_REQUIRED', '「불확실하면 조사부터」 위반은 분석 Task를 앞에 둬야 합니다');
  }

  // Every resulting Task must itself satisfy the criteria, including a target kept behind an analysis Task.
  for (const task of cancelled ? added : [...added, ...next.tasks.filter(item => item.id === targetId)]) {
    for (const item of checkIn(next, task, judgement.taskHashes.after).items) {
      if (item.status === '위반') fail('RULE_VIOLATION', `${item.label}: ${item.detail}`, task.id);
      else if (item.status === '의심') warnings.push({ taskKey: task.id, message: `${item.label}: ${item.detail}` });
    }
  }
  const holds = [...proposalJudgementHolds(base, simulation, judgement.taskHashes, settings),
    ...splitJudgementHolds(judgement.splitJudgements, judgement.splitSubjectHash)];
  for (const { code, taskKey = targetId, rule, message } of holds) problems.push({ code, taskKey, rule, message });
  for (const task of added) {
    if (!task.estimate) fail('ESTIMATE_MISSING', '나눈 Task의 추정이 없어 크기를 판정할 수 없습니다', task.id);
    if (!task.splitBasis.trim()) fail('SPLIT_BASIS_MISSING', '분할 근거가 없습니다', task.id);
    // Not delegated to rule 4: a planning Task without AC is only a caution there.
    if (!task.ac.length || !task.checklist.length) fail('AC_MISSING', '나눈 Task는 AC와 체크리스트를 가져야 합니다', task.id);
  }
  // The original's execution order must survive for what replaces it; an equivalent indirect path is enough.
  const replacements = cancelled ? parts : [target];
  for (const dep of base.dependencies.filter(item => item.pred === targetId || item.succ === targetId)) {
    const incoming = dep.succ === targetId;
    if (incoming && dependencyMet(base.tasks, dep)) continue;
    const lost = replacements.filter(task => incoming
      ? !preserves(next.dependencies, dep.pred, task.id, dep.type)
      : !preserves(next.dependencies, task.id, dep.succ, dep.type));
    // An SS successor only waited for the original's start, which any one part represents.
    const kept = !incoming && dep.type === 'SS' ? lost.length < replacements.length : !lost.length;
    if (!kept) {
      fail('ORDER_NOT_PRESERVED', `${incoming ? '선행' : '후속'} ${incoming ? dep.pred : dep.succ} (${dep.type}) 실행 순서가 ` +
        `${lost.map(task => task.id).join(', ')}에 보장되지 않습니다`);
    }
  }
  if (!cancelled) return result;

  const count = (list: readonly AcceptanceCriterion[], key: string) => list.filter(ac => acKey(ac) === key).length;
  const partAc = parts.flatMap(task => task.ac);
  for (const key of new Set(target.ac.map(acKey))) {
    if (count(partAc, key) !== count(target.ac, key)) {
      fail('AC_NOT_PARTITIONED', `원래 Acceptance Criteria는 나뉜 Task 중 하나에만 있어야 합니다: ${key}`);
    }
  }
  return result;
}
