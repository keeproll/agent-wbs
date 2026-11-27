import type { JudgedContent } from '../api/generated/client.ts';
import type { ProposalOp, SplitProposalOp } from './agents.ts';
import type { WbsSnapshot } from './payload.ts';

/*
 * 판단 투영(projection) — 두 Agent에게 보여 줄 「판단 대상 내용」을 계약의 JudgedContent 정의(data-model §2.3-1) 그대로 만든다.
 * 서버가 판단 기록을 저장할 때 계산하는 subjectHash와 같은 내용·같은 정규화를 쓴다(5차 리뷰 P1).
 *
 * 왜 계약 정의 그대로인가:
 * - 요청 본문의 원시 값과 서버가 실제로 적용할 내용은 다를 수 있다.
 *   예: 분할 CP의 새 Task가 `conflictGroup`을 생략하면 「원 Task 묶음 상속」이다(data-model §2.4-1). 원시 `t`에는 묶음이 없다.
 * - 그래서 Agent에게는 서버가 적용할 내용을 보여 주고, 그 지문(judgedContentHash)을 판단 기록에 묶는다.
 *   지문이 서버의 변경 후 hash와 같으므로 서버가 대조할 수 있다.
 *
 * 서버 기준(같게 유지해야 하는 곳):
 * - 정규화: packages/shared/src/judgement.ts judgedContent·canonicalJson
 * - CP 새 Task: apps/api/src/planning/content.ts newTaskSource·designsOf·recommendedDesigns
 * - 분할 상속: packages/shared/src/proposal/simulate.ts simulateProposal·replacesOriginal
 * - 기존 Task 수정: simulate.ts applyModify·parseAcceptanceCriterion
 * - 초안: apps/api/src/project/draft.ts draftSource
 * - 분할 판단: content.ts splitSubjectHash, evaluate.ts의 splitTasks 구성
 */

const SPEC_KEYS = ['req', 'work', 'steps', 'inputs', 'outputs', 'files', 'constraints', 'errors', 'docs', 'verify'] as const;
const DESIGN_ORDER = ['DB', 'API', 'FE', 'DevOps'];
const DOMAIN_TO_DESIGN: Record<string, string> = { DB: 'DB', BE: 'API', API: 'API', FE: 'FE', DevOps: 'DevOps' };
type Spec = JudgedContent['spec'];
type Ac = JudgedContent['ac'][number];
type AnyOp = ProposalOp | SplitProposalOp;
type AddT = Extract<AnyOp, { op: 'add' }>['t'];

const specBody = (spec: Partial<Record<string, unknown>> = {}): Spec =>
  Object.fromEntries(SPEC_KEYS.map((key) => [key, Array.isArray(spec[key]) ? (spec[key] as unknown[]).filter((v): v is string => typeof v === 'string') : []])) as Spec;
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** 서버 judgedContent와 같은 정규화: 명세 10칸, 산출물 이름순·4필드, 설계 종류순, AC 4필드 */
export function normalizeJudged(c: JudgedContent): JudgedContent {
  return {
    title: c.title, scope: [...c.scope], out: [...c.out], doneCond: c.doneCond, spec: specBody(c.spec as Partial<Record<string, unknown>>),
    ac: c.ac.map(({ given, when, then, method }) => ({ given, when, then, method })),
    outputs: [...c.outputs].sort(byName).map(({ name, kind, required, verify }) => ({ name, kind, required, verify })),
    designs: [...c.designs].sort((a, b) => DESIGN_ORDER.indexOf(a.kind) - DESIGN_ORDER.indexOf(b.kind)).map(({ kind, content }) => ({ kind, content })),
    conflictGroup: c.conflictGroup,
  };
}

/** CP add의 설계: 명시하면 그대로, 생략하면 주·관련 영역의 권장 구역(빈 내용). 명시한 []는 구역 없음 */
function designsOf(t: AddT): JudgedContent['designs'] {
  if (t.design !== undefined) return t.design.map(({ kind, content }) => ({ kind, content: { ...content } }));
  const kinds = [t.domain, ...(t.rel ?? [])].flatMap((d) => DOMAIN_TO_DESIGN[d] ?? []);
  return [...new Set(kinds)].map((kind) => ({ kind: kind as JudgedContent['designs'][number]['kind'], content: { ents: [], b: {} } }));
}

/** CP가 추가하는 Task의 판단 대상. conflictGroup은 상속을 적용한 실효 값을 받는다. */
export function judgedOfNewTask(t: AddT, conflictGroup: string | null): JudgedContent {
  return normalizeJudged({
    title: t.title, scope: [...(t.scope ?? [])], out: [], doneCond: t.doneCond, spec: specBody({ files: t.files ?? [] }),
    ac: (t.ac ?? []).map(({ given, when, then, method }) => ({ given, when, then, method: method ?? '' })),
    outputs: [], designs: designsOf(t), conflictGroup,
  });
}

/** 초안 Task의 판단 대상(서버 draftSource). 초안에는 설계 본문이 없어 설계는 빈 목록이다. */
export function judgedOfDraftTask(task: { title: string; overview?: { scope: string[]; out: string[]; doneCond: string }; spec?: Spec; ac?: Ac[];
  outputs: { name: string; kind: string; required: boolean; verify: string }[]; conflictGroup: string | null }): JudgedContent {
  return normalizeJudged({
    title: task.title, scope: [...(task.overview?.scope ?? [])], out: [...(task.overview?.out ?? [])], doneCond: task.overview?.doneCond ?? '',
    spec: specBody(task.spec as Partial<Record<string, unknown>> | undefined), ac: task.ac ?? [], outputs: task.outputs, designs: [], conflictGroup: task.conflictGroup,
  });
}

/** 분할 CP의 상속 전제. 원 Task를 취소하는 분할에서만 묶음이 넘어간다(simulateProposal). */
export interface SplitContext { originalKey: string; originalGroup: string | null; originalWorkType: string | null; removesOriginal: boolean }

/**
 * 새 Task의 실효 충돌 묶음. 생략은 「원 Task 상속」이고 명시한 값(null 포함)은 그대로다.
 * 상속은 원 Task를 대신하는 Task만 받는다: 조사(Analysis) Task는 원 Task도 조사일 때만(replacesOriginal).
 * 원 Task의 작업 유형을 모르면 조사 Task의 상속 여부를 정할 수 없으므로 추측하지 않고 문제로 돌려준다.
 */
export function effectiveGroup(t: AddT, split: SplitContext | null): { group: string | null } | { problem: string } {
  if (t.conflictGroup !== undefined) return { group: t.conflictGroup };
  if (!split?.removesOriginal) return { group: null };
  if (t.type !== 'Analysis') return { group: split.originalGroup };
  if (split.originalWorkType === null) {
    return { problem: `조사 Task의 충돌 묶음 상속 여부를 정할 수 없습니다(원 Task ${split.originalKey}의 작업 유형이 payload에 없음). conflictGroup을 명시하세요.` };
  }
  return { group: split.originalWorkType === 'Analysis' ? split.originalGroup : null };
}

/** 서버 parseAcceptanceCriterion과 같은 규칙 */
function parseAc(text: string): Ac {
  const match = /^Given\s+(.+?),\s*When\s+(.+?),\s*Then\s+(.+)$/i.exec(text.trim());
  if (!match) return { given: '', when: '', then: text, method: '' };
  const [, given = '', when = '', then = ''] = match;
  return { given, when, then, method: '' };
}

/** 기존 Task의 내용 변경(title·doneCond·scopeAdd·acAdd)을 서버와 같은 규칙으로 적용한 판단 대상 */
export function applyContentChanges(before: JudgedContent, ops: readonly AnyOp[]): JudgedContent {
  let c = normalizeJudged(before);
  for (const op of ops) {
    if (op.op !== 'modify') continue;
    if (op.field === 'title') c = { ...c, title: op.after };
    else if (op.field === 'doneCond') c = { ...c, doneCond: op.after };
    else if (op.field === 'scopeAdd') c = c.scope.includes(op.after) ? c : { ...c, scope: [...c.scope, op.after] };
    else if (op.field === 'acAdd') {
      const ac = parseAc(op.after);
      c = c.ac.some((a) => a.given === ac.given && a.when === ac.when && a.then === ac.then) ? c : { ...c, ac: [...c.ac, ac] };
    }
  }
  return c;
}

/** 분할 판단(D-34)의 대상 Task: 원 Task와 ops가 가리키는 기존 Task, 키 순서, 지금 내용(evaluate.ts와 같음) */
export function splitTasksOf(ops: readonly AnyOp[], originalKey: string, wbs: WbsSnapshot): { taskKey: string; content: JudgedContent }[] {
  const named = new Set<string>([originalKey]);
  for (const op of ops) {
    if (op.op === 'add') op.preds.forEach(({ pred }) => named.add(pred));
    else if (op.op === 'dep-add' || op.op === 'dep-remove') { named.add(op.pred); named.add(op.succ); }
    else named.add(op.task);
  }
  const current = new Map(wbs.tasks.map((t) => [t.taskKey, t.content]));
  return [...named].filter((key) => current.has(key)).sort().map((taskKey) => ({ taskKey, content: normalizeJudged(current.get(taskKey) as JudgedContent) }));
}
