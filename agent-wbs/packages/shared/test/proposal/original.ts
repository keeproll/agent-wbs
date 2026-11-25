import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { Dependency, Phase } from '../../src/domain/index.ts';
import type { AcceptanceCriterion, ProposalSnapshot, ProposalTask } from '../../src/proposal/index.ts';

export interface OriginalTask {
  id: string; title: string; type: ProposalTask['workType']; domain: ProposalTask['primaryDomain'];
  rel: ProposalTask['relatedDomains']; status: ProposalTask['status']; priority: number;
  assignee: ProposalTask['assignee']; verifier: ProposalTask['verifier']; purpose: string; scope: string[]; doneCond: string;
  spec: { ac: AcceptanceCriterion[]; files: string[] };
  checklist: { id: string; text: string; required: boolean; done: boolean; method: string }[];
  design: { kind: 'DB' | 'API' | 'FE' | 'DevOps'; ents: unknown[] }[];
  est: number; lo: number; hi: number; conf: '상' | '중' | '하'; cg: string; actStart: string;
  split: { exc: { rule: string; why: string; by: string; at: string }[] };
}
export interface OriginalData {
  tasks: Record<string, OriginalTask>; phases: Phase[]; deps: Dependency[]; attempts: { task: string }[];
  seq: { task: number }; split: { maxH: number; minH: number; maxFiles: number; on: Record<string, boolean> };
}
export interface OriginalSplit { items: { k: string; l: string; st: string }[]; viol: number; sus: number; warn: number; exc: number }
interface Original {
  load(): OriginalData;
  simulate(d: OriginalData, ops: unknown[]): { x: OriginalData; issues: string[]; idMap: Record<string, string> };
  splitCheck(d: OriginalData, t: OriginalTask): OriginalSplit;
  impactRows(d: OriginalData, x: OriginalData, ops: unknown[], idMap: Record<string, string>): { id: string; notes: string }[];
  rules: [string, string, string, string][];
  splitDefaults: OriginalData['split'];
  splitOps(d: OriginalData, id: string): unknown[];
}

// Execute the original data and pure functions; only the UI component is left out.
const source = readFileSync(new URL('../../../../../prototype/uiux/Main.dc.html', import.meta.url), 'utf8');
const script = source.slice(source.indexOf('>', source.lastIndexOf('<script', source.indexOf('const MOCK = {'))) + 1,
  source.indexOf('class Component extends DCLogic'));
const impact = source.slice(source.indexOf('  impactRows(d, x, ops, idMap) {'), source.indexOf('  cpTargets(d, cp) {'));
const propose = source.slice(source.indexOf('  proposeSplit(id) {'), source.indexOf('  addSplitExc(id, rule) {'));
export const original = runInNewContext(`${script}
const Ui = { ${impact.trim()} };
class Splitter { ${propose} setState() {} applyCp() {}
  mutate(fn) { fn(this.state.data); } }
({ load: () => Api.loadProject(), simulate: Sel.simulate, splitCheck: Sel.splitCheck, rules: SPLIT_RULES, splitDefaults: SPLIT_MOCK,
  impactRows: (...args) => Ui.impactRows(...args),
  splitOps: (d, id) => { const s = new Splitter(); s.state = { data: JSON.parse(JSON.stringify(d)) }; s.proposeSplit(id);
    const last = s.state.data.proposals.at(-1); return last && last.source.kind === 'split' ? last.ops : []; } })`,
{ console }) as Original;

export function toTask(t: OriginalTask, data: OriginalData): ProposalTask {
  return {
    id: t.id, status: t.status, title: t.title, workType: t.type, primaryDomain: t.domain, relatedDomains: t.rel,
    priority: t.priority, assignee: t.assignee, verifier: t.verifier, purpose: t.purpose, scope: t.scope, doneCond: t.doneCond,
    ac: t.spec.ac, files: t.spec.files ?? [], design: t.design.map(x => ({ kind: x.kind, items: (x.ents ?? []).map(() => 'entity') })),
    estimate: { est: t.est, lo: t.lo, hi: t.hi, confidence: t.conf }, conflictGroup: t.cg || null, splitBasis: '',
    judgements: [], checklist: t.checklist, exceptions: t.split?.exc ?? [],
    hasExecutionHistory: data.attempts.some(a => a.task === t.id),
  };
}

export function toSnapshot(data: OriginalData): ProposalSnapshot {
  return {
    phases: data.phases, tasks: Object.values(data.tasks).map(t => toTask(t, data)),
    dependencies: data.deps, taskSequence: data.seq.task,
  };
}
