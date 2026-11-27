import type { Dependency, TaskStatus } from '../../src/domain/index.ts';
import type { NewTask, SimulationOp, ProposalSnapshot, ProposalTask, JudgedRule, JudgedRules, Judgement } from '../../src/proposal/index.ts';

export const ac = (then: string) => ({ given: 'g', when: 'w', then, method: '' });

// Fixture records of a Planning agreement; real hashes are the server's.
export const HASH = 'a'.repeat(64);
export const JUDGED = ['revert', 'contract', 'refactor'] as const;
export const SPLIT_JUDGED = ['ac_meaning', 'layer_order', 'test_included'] as const;
export const judgement = <R extends string>(rule: R, patch: Partial<Judgement<R>> = {}): Judgement<R> => ({
  rule, result: 'met', agreedBy: ['Claude', 'Codex'], basis: '확인', subjectHash: HASH,
  judgedAt: '2026-11-25T00:00:00Z', ...patch, sourceRef: patch.sourceRef ?? `sha256:${patch.subjectHash ?? HASH}` });
export const judged = (rules: readonly JudgedRule[] = JUDGED, patch: Partial<Judgement<JudgedRule>> = {}): JudgedRules =>
  ({ schemaVersion: 1, items: rules.map(rule => judgement(rule, patch)) });

export function task(id: string, status: TaskStatus = 'ready', patch: Partial<ProposalTask> = {}): ProposalTask {
  return {
    id, status, title: id, workType: 'Implementation', primaryDomain: 'BE', relatedDomains: [], priority: 2,
    assignee: 'Claude', verifier: 'Codex', purpose: '', scope: ['s'], doneCond: 'd', ac: [ac(`${id} ok`)], files: [],
    design: [], estimate: { est: 2, lo: 1.5, hi: 3, confidence: '중' }, conflictGroup: null, splitBasis: '', judgedRules: judged(),
    checklist: [{ id: 'CL', text: 't', required: true, done: false, method: '' }], exceptions: [],
    hasExecutionHistory: !['planning', 'approval', 'ready'].includes(status), ...patch,
  };
}

export const dep = (pred: string, succ: string, type: Dependency['type'] = 'FS'): Dependency => ({ pred, succ, type });

export function snapshot(tasks: ProposalTask[], dependencies: Dependency[] = []): ProposalSnapshot {
  return {
    tasks, dependencies, taskSequence: 20,
    phases: [{ id: 'PH-1', wps: [{ id: 'WP-1', tasks: tasks.map(item => item.id) }] }],
  };
}

export function newTask(patch: Partial<NewTask> = {}): NewTask {
  return {
    title: '신규', workType: 'Implementation', primaryDomain: 'BE', priority: 2, assignee: 'Claude', verifier: 'Codex',
    ac: [ac('new ok')], estimate: { est: 2, lo: 1.5, hi: 3, confidence: '중' }, splitBasis: '근거',
    judgedRules: judged(), ...patch,
  };
}

export const add = (ref: string, patch: Partial<NewTask> = {}, preds: Pick<Dependency, 'pred' | 'type'>[] = []): SimulationOp =>
  ({ op: 'add', ref, workPackageId: 'WP-1', task: newTask(patch), preds });
