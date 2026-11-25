import type { Dependency, TaskStatus } from '../../src/domain/index.ts';
import type { NewTask, ProposalOp, ProposalSnapshot, ProposalTask } from '../../src/proposal/index.ts';

export const ac = (then: string) => ({ given: 'g', when: 'w', then, method: '' });

export function task(id: string, status: TaskStatus = 'ready', patch: Partial<ProposalTask> = {}): ProposalTask {
  return {
    id, status, title: id, workType: 'Implementation', primaryDomain: 'BE', relatedDomains: [], priority: 2,
    assignee: 'Claude', verifier: 'Codex', purpose: '', scope: ['s'], doneCond: 'd', ac: [ac(`${id} ok`)], files: [],
    design: [], estimate: { est: 2, lo: 1.5, hi: 3, confidence: '중' }, conflictGroup: null, splitBasis: '', judgements: [],
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
    judgements: ['revert', 'contract', 'refactor'].map(rule => ({ rule, why: '확인', by: '합의' })), ...patch,
  };
}

export const add = (ref: string, patch: Partial<NewTask> = {}, preds: Pick<Dependency, 'pred' | 'type'>[] = []): ProposalOp =>
  ({ op: 'add', ref, workPackageId: 'WP-1', task: newTask(patch), preds });
