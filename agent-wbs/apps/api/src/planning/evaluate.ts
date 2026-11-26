import type { PoolClient } from '@awbs/db';
import {
  JUDGED_RULES, proposalJudgementHolds, simulateProposal, validateSplitProposal,
  type ProposalSimulation, type SplitJudgements, type TaskJudgement,
} from '@awbs/shared';
import { proposalReasons, simulationOp, type WireHoldReason, type WireProposalOp } from '@awbs/shared/api';
import { validateDesign } from '../tasks/design.ts';
import { TaskError } from '../tasks/errors.ts';
import { judgedContent, subjectHash, type JudgedSource } from '../tasks/hash.ts';
import { newTaskSource, previewHash, splitSubjectHash } from './content.ts';
import { loadSnapshot, type Loaded } from './snapshot.ts';

/** 시뮬레이션에 필요한 CP 행의 내용. 저장 전 CP(Planning 제출)도 같은 모양으로 평가한다. */
export interface ProposalInput {
  projectId: string;
  source: string;
  sourceId: string | null;
  ops: readonly WireProposalOp[];
  taskJudgements: readonly TaskJudgement[];
  splitJudgements: SplitJudgements | null;
}

/** 판단 job에 싣는 대상(contracts §3.2 판단 payload) */
export interface JudgementTarget {
  target: string;
  subjectHash: string;
  before: ReturnType<typeof judgedContent> | null;
  after: ReturnType<typeof judgedContent>;
}

export interface Issue { index: number | null; code: string; taskKey?: string; message: string }

export interface Evaluation {
  loaded: Loaded;
  simulation: ProposalSimulation;
  holdReasons: WireHoldReason[];
  issues: Issue[];
  impact: { removedDependencies: ProposalSimulation['impact']['removedDependencies']; unblockedSuccessors: ProposalSimulation['impact']['unblockedSuccessors'] };
  previewHash: string;
  /** Task 키(새 Task는 예상 키) → 변경 후 판단 대상 내용. 반영 뒤 DB 내용과 다시 대조한다. */
  after: Map<string, JudgedSource>;
  afterHash: Map<string, string>;
  /** 새 Task ref(NEW-n) → 예상 키 */
  refs: Map<string, string>;
  targets: JudgementTarget[];
  splitOf: string | null;
  splitHash: string | null;
  splitTasks: { taskKey: string; content: ReturnType<typeof judgedContent> }[] | null;
  /** 유효한 판단 기록이 없어 Planning에게 판단을 맡겨야 한다 */
  needsJudgement: boolean;
}

/**
 * 미리보기·승인·반영·자동 정책이 모두 쓰는 단일 평가 함수(contracts §2.1 「미리보기와 반영은 같은 함수」).
 * 같은 DB 상태와 같은 CP면 같은 결과·같은 previewHash를 낸다. 보류 사유(D-33~35)와 반영 불가 사유를 여기서 함께 판정하므로
 * 자동 반영(held)과 수동 승인·반영(409)의 판정이 갈라지지 않는다.
 */
export async function evaluate(client: PoolClient, input: ProposalInput): Promise<Evaluation> {
  const loaded = await loadSnapshot(client, input.projectId);
  const base = loaded.snapshot;
  const ops = input.ops.map(simulationOp);
  const splitOf = input.source === 'split' ? input.sourceId : null;
  // 충돌 묶음 상속을 포함한 변경 후 상태. 상속은 저장하지 않고 매번 현재 원래 Task에서 계산한다(data-model §2.4-1).
  const simulated = simulateProposal(base, ops, { splitOf });
  const next = new Map(simulated.next.tasks.map((task) => [task.id, task]));
  const refs = new Map(Object.entries(simulated.idMap));

  const before = new Map<string, string>();
  const after = new Map<string, JudgedSource>();
  for (const [key, source] of loaded.sources) {
    before.set(key, subjectHash(source));
    const task = next.get(key);
    if (!task) continue;
    // CP가 바꿀 수 있는 판단 대상 필드는 제목·완료 조건·범위·AC뿐이다(G§5.6 modify).
    after.set(key, { ...source, title: task.title, overview: { ...source.overview, doneCond: task.doneCond, scope: [...task.scope] }, ac: task.ac.map(({ given, when, then, method }) => ({ given, when, then, method })) });
  }
  for (const op of input.ops) {
    const key = op.op === 'add' ? refs.get(op.ref) : undefined;
    const task = key ? next.get(key) : undefined;
    if (op.op === 'add' && key && task) after.set(key, newTaskSource(op.t, task.conflictGroup));
  }
  const designErrors = input.ops.flatMap((op, i) => {
    if (op.op !== 'add') return [];
    const key = refs.get(op.ref);
    const known = [...after].filter(([taskKey]) => taskKey !== key).flatMap(([, source]) => source.designs.filter(d => d.kind === 'DB').map(d => d.content));
    return (op.t.design ?? []).flatMap((design, j) => validateDesign(design.kind, design.content, known)
      .map(error => ({ ...error, path: `ops.${String(i)}.t.design.${String(j)}.${error.path}` })));
  });
  if (designErrors.length) throw new TaskError('VALIDATION_FAILED', {}, designErrors);
  const afterHash = new Map([...after].map(([key, source]) => [key, subjectHash(source)]));
  const hashes = { before: Object.fromEntries(before), after: Object.fromEntries(afterHash) };

  let splitHash: string | null = null;
  let splitTasks: Evaluation['splitTasks'] = null;
  let simulation = simulated;
  let problems: Parameters<typeof proposalReasons>[0];
  if (splitOf) {
    // 대상 Task = 원래 Task와 ops가 가리키는 기존 Task. 내용은 지금 시점의 값이다(contracts §3.2 splitTasks).
    const named = new Set<string>([splitOf]);
    for (const op of input.ops) {
      if (op.op === 'add') op.preds.forEach(({ pred }) => named.add(pred));
      else if (op.op === 'dep-add' || op.op === 'dep-remove') { named.add(op.pred); named.add(op.succ); }
      else named.add(op.task);
    }
    splitTasks = [...named].filter((key) => loaded.sources.has(key)).sort()
      .map((taskKey) => ({ taskKey, content: judgedContent(loaded.sources.get(taskKey) as JudgedSource) }));
    splitHash = splitSubjectHash(input.ops, splitTasks);
    const result = validateSplitProposal(base, splitOf, ops, {
      splitJudgements: input.splitJudgements, splitSubjectHash: splitHash, taskHashes: hashes, taskJudgements: input.taskJudgements,
    }, loaded.settings);
    simulation = result.simulation;
    problems = result.problems;
  } else {
    problems = [...simulated.issues, ...proposalJudgementHolds(base, simulated, hashes, input.taskJudgements, loaded.settings)];
  }
  const { holdReasons, issues } = proposalReasons(problems);
  const impact = { removedDependencies: simulation.impact.removedDependencies, unblockedSuccessors: simulation.impact.unblockedSuccessors };

  // 판단 대상: 추가된 Task와 판단 대상 내용이 바뀐 Task(종료 상태 제외). 판단 규칙이 모두 꺼져 있고 분할 CP도 아니면 없다.
  const rulesOn = JUDGED_RULES.some((rule) => loaded.settings.enabled[rule]);
  const targets: JudgementTarget[] = [];
  if (rulesOn) {
    for (const [ref, key] of refs) {
      const source = after.get(key);
      if (source) targets.push({ target: ref, subjectHash: afterHash.get(key) ?? '', before: null, after: judgedContent(source) });
    }
    for (const [key, source] of loaded.sources) {
      const status = next.get(key)?.status;
      const changed = afterHash.get(key);
      if (!changed || changed === before.get(key) || status === 'done' || status === 'cancelled') continue;
      targets.push({ target: key, subjectHash: changed, before: judgedContent(source), after: judgedContent(after.get(key) as JudgedSource) });
    }
  }
  return {
    loaded, simulation, holdReasons, issues, impact, after, afterHash, refs, targets, splitOf, splitHash, splitTasks,
    previewHash: previewHash({ idMap: simulation.idMap, issues, diff: simulation.diff, impact }, holdReasons),
    needsJudgement: holdReasons.some((reason) => reason.code === 'JUDGEMENT_MISSING'),
  };
}
