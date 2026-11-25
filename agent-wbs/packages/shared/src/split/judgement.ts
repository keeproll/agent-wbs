import type {
  JudgedRule, JudgedRules, ProposalSimulation, ProposalSnapshot, SplitJudgementRule, SplitJudgements,
} from '../proposal/index.ts';
import { AGENTS } from '../proposal/types.ts';
import type { SplitSettings } from './check.ts';

export type JudgementState = 'met' | 'not_met' | 'missing';

export const JUDGED_RULES: readonly JudgedRule[] = ['revert', 'contract', 'refactor'];
export const SPLIT_JUDGEMENT_RULES: readonly SplitJudgementRule[] = ['ac_meaning', 'layer_order', 'test_included'];

const filled = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
// Date rolls 02-30 over to March, so the calendar part must survive a round trip. `+00:00` is UTC as much as `Z`.
const utcIso = (value: unknown) => {
  const local = typeof value === 'string' && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?(?:Z|\+00:00)$/.exec(value)?.[1];
  if (!local) return false;
  const date = new Date(`${local}Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(local);
};

/** jsonb input: anything not exactly a valid, both-agreed record of the current subject is no record (data-model §2.3-1). */
export function judgementOf(
  record: JudgedRules | SplitJudgements | null, rule: JudgedRule | SplitJudgementRule, currentHash: string | null,
): { state: JudgementState; detail: string } {
  const missing = { state: 'missing', detail: '기록 없음' } as const;
  if (record?.schemaVersion !== 1 || !Array.isArray(record.items)) return missing;
  const found = (record as { items: readonly Partial<JudgedRules['items'][number]>[] }).items.filter(item => item?.rule === rule);
  const [item] = found;
  if (!item || found.length !== 1 || !currentHash || item.subjectHash !== currentHash) return missing;
  const { result, agreedBy, basis } = item;
  if (result !== 'met' && result !== 'not_met' || !filled(basis) || !utcIso(item.judgedAt) || !filled(item.sourceRef)) return missing;
  if (!Array.isArray(agreedBy) || agreedBy.length !== AGENTS.length || AGENTS.some(agent => !agreedBy.includes(agent))) {
    return missing;
  }
  return { state: result, detail: `${result === 'met' ? '충족' : '불충족'} — ${basis} (${agreedBy.join(' · ')})` };
}

/** Subject hashes by Task key. Only the server computes them; a Task without one counts as unjudged. */
export interface SubjectHashes {
  before: Readonly<Record<string, string>>;
  after: Readonly<Record<string, string>>;
}

export interface JudgementHold {
  code: 'JUDGEMENT_MISSING' | 'JUDGEMENT_NOT_MET';
  taskKey?: string;
  rule: JudgedRule | SplitJudgementRule;
  message: string;
}

function hold(
  record: JudgedRules | SplitJudgements | null, rule: JudgementHold['rule'], hash: string | null, taskKey?: string,
): JudgementHold[] {
  const { state, detail } = judgementOf(record, rule, hash);
  if (state === 'met') return [];
  return [{ code: state === 'missing' ? 'JUDGEMENT_MISSING' : 'JUDGEMENT_NOT_MET', rule, message: `${rule}: ${detail}`,
    ...(taskKey === undefined ? {} : { taskKey }) }];
}

/** Any CP: added Tasks and Tasks whose judged content changes; other Tasks never hold it. */
export function proposalJudgementHolds(
  base: ProposalSnapshot, { next }: Pick<ProposalSimulation, 'next'>, hashes: SubjectHashes, settings: SplitSettings,
): JudgementHold[] {
  const existing = new Set(base.tasks.map(task => task.id));
  return next.tasks.filter(task => {
    const after = hashes.after[task.id];
    return task.status !== 'done' && task.status !== 'cancelled' &&
      (!existing.has(task.id) || after === undefined || after !== hashes.before[task.id]);
  }).flatMap(task => JUDGED_RULES.filter(rule => settings.enabled[rule])
    .flatMap(rule => hold(task.judgedRules, rule, hashes.after[task.id] ?? null, task.id)));
}

/** Split CP only (D-34): AC meaning, layer order and test inclusion are Planning's recorded judgement. */
export function splitJudgementHolds(record: SplitJudgements | null, currentHash: string | null): JudgementHold[] {
  return SPLIT_JUDGEMENT_RULES.flatMap(rule => hold(record, rule, currentHash));
}
