import type {
  JudgedRule, JudgedRules, ProposalSimulation, ProposalSnapshot, ProposalTask, SplitJudgementRule, SplitJudgements, TaskJudgement,
} from '../proposal/index.ts';
import { AGENTS } from '../vocabulary.ts';
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
  if (!item || found.length !== 1 || !currentHash || item.subjectHash !== currentHash || item.sourceRef !== `sha256:${currentHash}`) return missing;
  const { result, agreedBy, basis } = item;
  if (result !== 'met' && result !== 'not_met' || !filled(basis) || !utcIso(item.judgedAt) || !filled(item.sourceRef)) return missing;
  if (!Array.isArray(agreedBy) || agreedBy.length !== AGENTS.length || AGENTS.some(agent => !agreedBy.includes(agent))) {
    return missing;
  }
  return { state: result, detail: `${result === 'met' ? '충족' : '불충족'} — ${basis} (${agreedBy.join(' · ')})` };
}

/** Task 키별 서버 계산값. Runner가 보낸 판단 입력 지문과 대조하며, 계산값이 없으면 판단도 없다. */
export interface SubjectHashes {
  before: Readonly<Record<string, string>>;
  after: Readonly<Record<string, string>>;
}

export interface JudgementHold {
  // VALIDATION_FAILED: the taskJudgements array itself is malformed (no rule).
  code: 'JUDGEMENT_MISSING' | 'JUDGEMENT_NOT_MET' | 'VALIDATION_FAILED';
  taskKey?: string;
  rule?: JudgedRule | SplitJudgementRule;
  message: string;
}

function hold(
  record: JudgedRules | SplitJudgements | null, rule: JudgedRule | SplitJudgementRule, hash: string | null, taskKey?: string,
): JudgementHold[] {
  const { state, detail } = judgementOf(record, rule, hash);
  if (state === 'met') return [];
  return [{ code: state === 'missing' ? 'JUDGEMENT_MISSING' : 'JUDGEMENT_NOT_MET', rule, message: `${rule}: ${detail}`,
    ...(taskKey === undefined ? {} : { taskKey }) }];
}

/** Any CP: added Tasks and Tasks whose judged content changes; other Tasks never hold it. */
export function proposalJudgementHolds(
  base: ProposalSnapshot, { next }: Pick<ProposalSimulation, 'next'>, hashes: SubjectHashes,
  taskJudgements: readonly TaskJudgement[], settings: SplitSettings,
): JudgementHold[] {
  const existing = new Set(base.tasks.map(task => task.id));
  const subjects = next.tasks.filter(task => {
    const after = hashes.after[task.id];
    return task.status !== 'done' && task.status !== 'cancelled' &&
      (!existing.has(task.id) || after === undefined || after !== hashes.before[task.id]);
  });

  // Validated whole, before any Task or rule filter: an entry nobody would judge must not pass silently.
  const allowed = new Set(subjects.filter(task => existing.has(task.id)).map(task => task.id));
  const keys = taskJudgements.map(entry => (entry as TaskJudgement | null)?.taskKey as unknown);
  const invalid = [...new Set(keys)].flatMap((key): JudgementHold[] => {
    if (typeof key !== 'string') return [{ code: 'VALIDATION_FAILED', message: 'taskJudgements 항목에 taskKey가 없습니다' }];
    const reason = keys.filter(other => other === key).length > 1 ? '중복되었습니다' :
      allowed.has(key) ? null : '이 변경이 내용을 바꾸는 기존 Task가 아닙니다';
    return reason ? [{ code: 'VALIDATION_FAILED', taskKey: key, message: `taskJudgements의 ${key}: ${reason}` }] : [];
  });

  // The CP's record replaces the stored one for judging only; a duplicated key is void rather than a fallback.
  const recordOf = (task: ProposalTask): JudgedRules | null => {
    const carried = existing.has(task.id) ? taskJudgements.filter((_entry, index) => keys[index] === task.id) : [];
    if (!carried.length) return task.judgedRules;
    return carried.length === 1 ? carried[0]?.judgedRules ?? null : null;
  };
  return [...invalid, ...subjects.flatMap(task => JUDGED_RULES.filter(rule => settings.enabled[rule])
    .flatMap(rule => hold(recordOf(task), rule, hashes.after[task.id] ?? null, task.id)))];
}

/** Split CP only (D-34): AC meaning, layer order and test inclusion are Planning's recorded judgement. */
export function splitJudgementHolds(record: SplitJudgements | null, currentHash: string | null): JudgementHold[] {
  return SPLIT_JUDGEMENT_RULES.flatMap(rule => hold(record, rule, currentHash));
}
