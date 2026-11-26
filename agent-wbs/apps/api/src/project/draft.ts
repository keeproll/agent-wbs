import {
  checkSplit, JUDGED_RULES, judgementOf, summarizeSplit,
  type Agent, type Confidence, type DependencyType, type JudgedRule, type ProposalTask, type SplitSettings, type TechDomain, type WorkType,
} from '@awbs/shared';
import type { InputError } from './errors.ts';
import { subjectHash, type Ac, type JudgedSource, type Output, type Overview } from './hash.ts';

/*
 * 초기 WBS 초안(contracts §3.3, shared models `WbsDraft`).
 * 형식은 요청 스키마가 먼저 검사하고, 여기서는 스키마로 쓸 수 없는 「순환·참조·중복」을 검사한다.
 */

interface Judgement { rule: JudgedRule; result: 'met' | 'not_met'; agreedBy: Agent[]; basis: string; judgedAt: string; sourceRef: string }
export interface NewJudgedRules { schemaVersion: 1; items: Judgement[] }
export interface StoredJudgedRules { schemaVersion: 1; items: (Judgement & { subjectHash: string })[] }

export interface DraftTaskInput {
  ref: string;
  wpRef: string;
  title: string;
  workType: WorkType;
  primaryDomain: TechDomain;
  relatedDomains: TechDomain[];
  priority: number;
  assigneeAgent: Agent;
  verifierAgent: Agent;
  estimate: { estHours: number; loHours: number; hiHours: number; tokensK?: number; confidence: Confidence; basis: string; agreedBy: Agent[] };
  overview?: Overview;
  spec?: Partial<Record<string, string[]>>;
  ac?: Ac[];
  outputs: Output[];
  checklist: { content: string; required: boolean; verifyMethod?: string | null }[];
  grades: Record<'dev' | 'qa', { modelId: string; effort: string; reason: string }>;
  subagents: { dev: string[]; qa: string[]; basis: string };
  splitBasis: string;
  judgedRules?: NewJudgedRules | undefined;
  conflictGroup: string | null;
  designItems: { itemKey: string; change: string }[];
}
export interface DraftInput {
  phases: { ref: string; title: string }[];
  wps: { ref: string; phaseRef: string; title: string }[];
  tasks: DraftTaskInput[];
  deps: { predRef: string; succRef: string; depType: DependencyType }[];
}
export type StoredDraftTask = Omit<DraftTaskInput, 'judgedRules'> & { judgedRules?: StoredJudgedRules | undefined; subjectHash: string };
export type StoredDraft = Omit<DraftInput, 'tasks'> & { tasks: StoredDraftTask[] };

const EMPTY_OVERVIEW: Overview = { purpose: '', background: '', scope: [], out: [], precond: '', doneCond: '' };

/** 초안 Task가 WBS가 되었을 때의 판단 대상 내용. 초안에는 기술 설계 본문이 없으므로 설계는 빈 목록이다. */
export function draftSource(task: Pick<DraftTaskInput, 'title' | 'overview' | 'spec' | 'ac' | 'outputs' | 'conflictGroup'>): JudgedSource {
  return { title: task.title, overview: task.overview ?? EMPTY_OVERVIEW, spec: task.spec ?? {}, ac: task.ac ?? [], outputs: task.outputs, designs: [], conflictGroup: task.conflictGroup };
}

function duplicates<T>(items: readonly T[], key: (item: T) => string): number[] {
  const seen = new Set<string>();
  return items.flatMap((item, index) => {
    const value = key(item);
    if (seen.has(value)) return [index];
    seen.add(value);
    return [];
  });
}

/** 초안의 순환·참조·필수 검사(contracts §3.3). 오류를 모두 모아 400 `errors[]`로 돌려준다. */
export function draftErrors(draft: DraftInput): InputError[] {
  const errors: InputError[] = [];
  const add = (path: string, rule: string, message: string) => errors.push({ path, rule, message });
  for (const i of duplicates(draft.phases, (p) => p.ref)) add(`phases.${String(i)}.ref`, 'unique', 'Phase 참조 이름이 겹칩니다.');
  for (const i of duplicates(draft.wps, (w) => w.ref)) add(`wps.${String(i)}.ref`, 'unique', 'Work Package 참조 이름이 겹칩니다.');
  for (const i of duplicates(draft.tasks, (t) => t.ref)) add(`tasks.${String(i)}.ref`, 'unique', 'Task 참조 이름이 겹칩니다.');
  const phases = new Set(draft.phases.map((p) => p.ref));
  const wps = new Set(draft.wps.map((w) => w.ref));
  const tasks = new Set(draft.tasks.map((t) => t.ref));
  draft.wps.forEach((wp, i) => { if (!phases.has(wp.phaseRef)) add(`wps.${String(i)}.phaseRef`, 'reference', `없는 Phase(${wp.phaseRef})를 가리킵니다.`); });
  draft.tasks.forEach((task, i) => {
    const at = `tasks.${String(i)}`;
    if (!wps.has(task.wpRef)) add(`${at}.wpRef`, 'reference', `없는 Work Package(${task.wpRef})를 가리킵니다.`);
    if (task.relatedDomains.includes(task.primaryDomain)) add(`${at}.relatedDomains`, 'primaryDomain', '주 영역은 관련 영역에 넣지 않습니다.');
    const { estHours: est, loHours: lo, hiHours: hi } = task.estimate;
    if (!(lo <= est && est <= hi)) add(`${at}.estimate`, 'range', '낙관 ≤ 예상 ≤ 비관 순서여야 합니다.');
    for (const j of duplicates(task.outputs, (o) => o.name)) add(`${at}.outputs.${String(j)}.name`, 'unique', '산출물 이름이 겹칩니다.');
    for (const j of duplicates(task.designItems, (d) => d.itemKey)) add(`${at}.designItems.${String(j)}.itemKey`, 'unique', '설계 항목 키가 겹칩니다.');
    if (task.judgedRules && duplicates(task.judgedRules.items, (item) => item.rule).length) add(`${at}.judgedRules`, 'uniqueRule', '같은 규칙의 판단은 하나만 적습니다.');
  });
  const edges = new Map<string, Set<string>>();
  const reaches = (from: string, to: string) => {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length) {
      const node = stack.pop() ?? '';
      if (node === to) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      stack.push(...(edges.get(node) ?? []));
    }
    return false;
  };
  draft.deps.forEach((dep, i) => {
    const at = `deps.${String(i)}`;
    const before = errors.length;
    if (!tasks.has(dep.predRef)) add(`${at}.predRef`, 'reference', `없는 Task(${dep.predRef})를 가리킵니다.`);
    if (!tasks.has(dep.succRef)) add(`${at}.succRef`, 'reference', `없는 Task(${dep.succRef})를 가리킵니다.`);
    if (errors.length > before) return;
    if (dep.predRef === dep.succRef) return add(at, 'dependencySelf', '자기 자신을 선행으로 둘 수 없습니다.');
    if (edges.get(dep.predRef)?.has(dep.succRef)) return add(at, 'dependencyDuplicate', '같은 선행 관계가 이미 있습니다.');
    if (reaches(dep.succRef, dep.predRef)) return add(at, 'dependencyCycle', '이 관계를 넣으면 순환이 생깁니다.');
    edges.set(dep.predRef, (edges.get(dep.predRef) ?? new Set()).add(dep.succRef));
  });
  return errors;
}

/**
 * 저장할 초안. 판단 기록에는 서버가 계산한 hash를 붙인다(data-model §2.3-1 「계산은 서버만」).
 * 판단 미기록·불충족 초안도 저장해 화면에 보여 주고, 보류는 승인 때 한다(contracts §3.3).
 */
export function storeDraft(draft: DraftInput): StoredDraft {
  return {
    ...draft,
    tasks: draft.tasks.map(({ judgedRules, ...task }) => {
      const hash = subjectHash(draftSource(task));
      return { ...task, subjectHash: hash, ...(judgedRules && { judgedRules: { schemaVersion: 1, items: judgedRules.items.map((item) => ({ ...item, subjectHash: hash })) } }) };
    }),
  };
}

export interface DraftHold { ref: string; title: string; rule: JudgedRule; code: 'JUDGEMENT_MISSING' | 'JUDGEMENT_NOT_MET'; reason: string }

/**
 * 초기 WBS 승인의 판단 보류(D-33). 켜진 규칙 5·7·9마다 유효한 충족이 있어야 한다.
 * hash는 저장된 값을 믿지 않고 지금 초안 내용으로 다시 계산해 대조한다(반영 때 재대조).
 */
export function draftHolds(draft: StoredDraft, settings: SplitSettings): DraftHold[] {
  return draft.tasks.flatMap((task) => {
    const hash = subjectHash(draftSource(task));
    return JUDGED_RULES.filter((rule) => settings.enabled[rule]).flatMap((rule): DraftHold[] => {
      const { state, detail } = judgementOf(task.judgedRules ?? null, rule, hash);
      if (state === 'met') return [];
      return [{ ref: task.ref, title: task.title, rule, code: state === 'missing' ? 'JUDGEMENT_MISSING' : 'JUDGEMENT_NOT_MET', reason: detail }];
    });
  });
}

/** 분할 점검(G§5.2-1)용 Task 모양. 초기 WBS Task는 승인되면 실행 대기가 된다(Q-05 1행). */
function proposalTask(task: StoredDraftTask): ProposalTask {
  const overview = task.overview ?? EMPTY_OVERVIEW;
  return {
    id: task.ref, status: 'ready', title: task.title, workType: task.workType, primaryDomain: task.primaryDomain, relatedDomains: task.relatedDomains,
    priority: task.priority, assignee: task.assigneeAgent, verifier: task.verifierAgent, purpose: overview.purpose, scope: overview.scope,
    doneCond: overview.doneCond, ac: task.ac ?? [], files: task.spec?.files ?? [], design: [],
    estimate: { est: task.estimate.estHours, lo: task.estimate.loHours, hi: task.estimate.hiHours, confidence: task.estimate.confidence },
    conflictGroup: task.conflictGroup, splitBasis: task.splitBasis, judgedRules: task.judgedRules ?? null,
    checklist: task.checklist.map((item, i) => ({ id: String(i), text: item.content, required: item.required, done: false, method: item.verifyMethod ?? '' })),
    exceptions: [], hasExecutionHistory: false,
  };
}

/** 초안 화면의 분할 점검 요약 `splitCheck{pass,suspect,violation}`. Task 하나는 한 번만 센다(위반 우선). */
export function draftSplitSummary(draft: StoredDraft, settings: SplitSettings) {
  const byRef = new Map(draft.tasks.map((task) => [task.ref, task]));
  const checks = draft.tasks.map((task) => {
    const preds = draft.deps.filter((dep) => dep.succRef === task.ref).flatMap((dep) => {
      const pred = byRef.get(dep.predRef);
      return pred ? [{ workType: pred.workType }] : [];
    });
    return checkSplit(proposalTask(task), preds, subjectHash(draftSource(task)), settings);
  });
  const summary = summarizeSplit(checks);
  return { pass: summary.passed, suspect: summary.suspicions, violation: summary.violations };
}
